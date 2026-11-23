import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { AdmissionGate } from "./admission.ts";
import type { BoardStore } from "./store.ts";
import type { McpConfig } from "./types.ts";

export interface ApprovalRequest {
  workerId: string;
  taskId: string;
  toolName: string;
  args: unknown;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export interface DiscoveredMcpTool {
  fullName: string; // e.g. "slack.post_message"
  serverName: string;
  remoteName: string;
  description: string;
  inputSchema: object;
  tier: "allow" | "hitl";
}

export async function defaultTerminalApprovalHandler(req: ApprovalRequest): Promise<ApprovalDecision> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n[HITL] Worker ${req.workerId} | Task ${req.taskId}`);
    console.log(`Tool:  ${req.toolName}`);
    console.log(`Args:  ${JSON.stringify(req.args, null, 2)}`);
    const answer = (await rl.question("Approve execution? [y/N or rejection reason]: ")).trim();
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
      return { approved: true };
    }
    return { approved: false, reason: answer && answer.toLowerCase() !== "n" ? answer : "Rejected by human." };
  } finally {
    rl.close();
  }
}

export class McpGateway {
  private readonly clients = new Map<string, Client>();
  private readonly tools = new Map<string, DiscoveredMcpTool>();
  private approvalChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: McpConfig,
    private readonly approvalHandler: ApprovalHandler = defaultTerminalApprovalHandler,
  ) {}

  static fromFile(configPath: string, approvalHandler?: ApprovalHandler): McpGateway {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as McpConfig;
    return new McpGateway(
      {
        servers: parsed.servers ?? {},
        policy: {
          allow: parsed.policy?.allow ?? [],
          hitl: parsed.policy?.hitl ?? [],
        },
      },
      approvalHandler,
    );
  }

  static empty(approvalHandler?: ApprovalHandler): McpGateway {
    return new McpGateway({ servers: {}, policy: { allow: [], hitl: [] } }, approvalHandler);
  }

  getTier(fullName: string): "allow" | "hitl" | "deny" {
    if (this.config.policy.allow.includes(fullName)) return "allow";
    if (this.config.policy.hitl.includes(fullName)) return "hitl";
    return "deny";
  }

  private hasPermittedToolsForServer(serverName: string): boolean {
    const prefix = `${serverName}.`;
    return (
      this.config.policy.allow.some((t) => t.startsWith(prefix)) ||
      this.config.policy.hitl.some((t) => t.startsWith(prefix))
    );
  }

  async connectAll(): Promise<void> {
    // Only spawn MCP servers that actually have at least one tool in allow or hitl (default-deny lazy connect)
    const entries = Object.entries(this.config.servers).filter(([serverName]) =>
      this.hasPermittedToolsForServer(serverName),
    );
    await Promise.all(
      entries.map(async ([serverName, srv]) => {
        const safeBaseEnv: Record<string, string> = {};
        for (const k of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM"]) {
          if (process.env[k]) safeBaseEnv[k] = process.env[k]!;
        }
        const transport = new StdioClientTransport({
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ? { ...safeBaseEnv, ...srv.env } : safeBaseEnv,
        });
        const client = new Client({ name: "minimaldelm-gateway", version: "0.1.0" });
        await client.connect(transport);
        this.clients.set(serverName, client);

        const listed = await client.listTools();
        for (const t of listed.tools) {
          const fullName = `${serverName}.${t.name}`;
          const tier = this.getTier(fullName);
          if (tier === "deny") continue; // Default-deny: never expose unpermitted tools
          this.tools.set(fullName, {
            fullName,
            serverName,
            remoteName: t.name,
            description: t.description ?? "",
            inputSchema: (t.inputSchema as object) ?? { type: "object", properties: {} },
            tier,
          });
        }
      }),
    );
  }

  listAllowedTools(): DiscoveredMcpTool[] {
    return Array.from(this.tools.values());
  }

  /** Serializes HITL prompts so parallel workers never fight over stdin. */
  private enqueueApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const next = this.approvalChain.then(() => this.approvalHandler(req));
    this.approvalChain = next.catch(() => undefined);
    return next;
  }

  async executeTool(
    store: BoardStore,
    workerId: string,
    taskId: string,
    fullName: string,
    args: unknown,
  ): Promise<{ text: string; evidenceId?: string; isError: boolean }> {
    const tier = this.getTier(fullName);
    if (tier === "deny") {
      return { text: `Access denied by default-deny policy: tool "${fullName}" is not permitted.`, isError: true };
    }

    const tool = this.tools.get(fullName);
    if (!tool) {
      return { text: `MCP tool not registered: ${fullName}`, isError: true };
    }

    if (tier === "hitl") {
      const decision = await this.enqueueApproval({ workerId, taskId, toolName: fullName, args });
      if (!decision.approved) {
        return {
          text: `Action rejected by human (${decision.reason ?? "no reason"}). Adjust your plan or mark incomplete.`,
          isError: true,
        };
      }
    }

    const client = this.clients.get(tool.serverName);
    if (!client) {
      return { text: `MCP server "${tool.serverName}" is not connected.`, isError: true };
    }

    const res = await client.callTool({
      name: tool.remoteName,
      arguments: (args as Record<string, unknown>) ?? {},
    });

    const contentArr = Array.isArray(res.content) ? res.content : [];
    const text = contentArr
      .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
      .join("\n")
      .trim();

    const ev = store.recordEvidence(taskId, workerId, fullName, args, text || "(empty)");
    return {
      text: `${text || "(empty)"}\n\n[evidence_id: ${ev.id}]`,
      evidenceId: ev.id,
      isError: Boolean(res.isError),
    };
  }

  toAgentTools(store: BoardStore, workerId: string, taskId: string): AgentTool<any>[] {
    return this.listAllowedTools().map((t) => ({
      name: t.fullName.replace(/[^a-zA-Z0-9_-]/g, "_"),
      label: `${t.fullName}${t.tier === "hitl" ? " [HITL]" : ""}`,
      description: `${t.description}${t.tier === "hitl" ? " (Requires human approval before execution.)" : ""}`,
      parameters: t.inputSchema,
      execute: async (_toolCallId, params) => {
        const out = await this.executeTool(store, workerId, taskId, t.fullName, params);
        return {
          content: [{ type: "text", text: out.text }],
          details: { evidenceId: out.evidenceId, fullName: t.fullName },
          isError: out.isError,
        };
      },
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
    this.tools.clear();
  }
}

/** Builds the 5 DeLM coordination primitives for an embedded Pi worker. */
export function createDelmTools(
  store: BoardStore,
  admission: AdmissionGate,
  workerId: string,
  taskId: string,
  getBaseSeq: () => number,
  setBaseSeq: (seq: number) => void,
  startedAt: number,
): AgentTool<any>[] {
  return [
    {
      name: "delm_spawn_tasks",
      label: "Spawn Subtasks",
      description: "Decompose the current task into independent subtasks on the global DeLM queue for parallel workers.",
      parameters: {
        type: "object",
        properties: {
          subtasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                goal: { type: "string" },
                criteria: { type: "string" },
                weight: { type: "number", enum: [1, 2, 3] },
                depends_on: { type: "array", items: { type: "string" } },
              },
              required: ["goal"],
            },
          },
        },
        required: ["subtasks"],
      },
      execute: async (_id, params: { subtasks: Array<{ id?: string; goal: string; criteria?: string; weight?: 1 | 2 | 3; depends_on?: string[] }> }) => {
        const created = store.spawnTasks(taskId, params.subtasks);
        return {
          content: [{ type: "text", text: `Spawned ${created.length} subtask(s): ${created.map((t) => t.id).join(", ")}` }],
          details: { created },
        };
      },
    },
    {
      name: "delm_read_context",
      label: "Read Shared Context",
      description: "Read reachable verified compact gists and recent deltas from the Shared Verified Context.",
      parameters: {
        type: "object",
        properties: {
          since_seq: { type: "number" },
        },
      },
      execute: async (_id, params: { since_seq?: number }) => {
        const ctx = store.readContext(taskId, params?.since_seq ?? 0);
        setBaseSeq(ctx.latestSeq);
        return {
          content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }],
          details: ctx,
        };
      },
    },
    {
      name: "delm_unfold_evidence",
      label: "Unfold Evidence",
      description: "Inspect the raw evidence content behind a gist's evidence_id, with optional offset/limit pagination.",
      parameters: {
        type: "object",
        properties: {
          evidence_id: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["evidence_id"],
      },
      execute: async (_id, params: { evidence_id: string; offset?: number; limit?: number }) => {
        const ev = store.getEvidence(params.evidence_id);
        if (!ev) {
          return { content: [{ type: "text", text: `Evidence not found: ${params.evidence_id}` }], details: null, isError: true };
        }
        if (!store.collectReachableTaskIds(taskId).has(ev.task_id)) {
          return {
            content: [{ type: "text", text: `Access denied: evidence ${ev.id} belongs to unreachable task ${ev.task_id}` }],
            details: null,
            isError: true,
          };
        }
        const rawOffset = typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 0;
        const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 8_000;
        const offset = Math.max(0, Math.floor(rawOffset));
        const limit = Math.min(32_000, Math.max(1, Math.floor(rawLimit)));
        const slice = ev.content.slice(offset, offset + limit);
        const hasMore = offset + slice.length < ev.content.length;
        return {
          content: [
            {
              type: "text",
              text: `[${ev.id} | ${ev.tool_name} | offset=${offset}..${offset + slice.length}/${ev.content.length}${hasMore ? " (hasMore=true)" : ""}]\n${slice}`,
            },
          ],
          details: { id: ev.id, tool: ev.tool_name, offset, length: slice.length, totalLength: ev.content.length, hasMore },
        };
      },
    },
    {
      name: "delm_record_evidence",
      label: "Record Local Evidence",
      description: "Record a verified synthesis or observation when no external MCP tool produced an evidence_id.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        required: ["note"],
      },
      execute: async (_id, params: { note: string }) => {
        const ev = store.recordEvidence(taskId, workerId, "delm_note", { taskId }, params.note);
        return {
          content: [{ type: "text", text: `Recorded evidence_id: ${ev.id}` }],
          details: { evidenceId: ev.id },
        };
      },
    },
    {
      name: "delm_publish_gist",
      label: "Publish Verified Gist",
      description: "Publish a compact gist (3-5 lines) backed by evidence_ids to the Shared Verified Context. Set mark_done=true when the task is complete.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
          supersedes_gist_id: { type: "string" },
          mark_done: { type: "boolean" },
        },
        required: ["summary", "evidence_ids"],
      },
      execute: async (_id, params: { summary: string; evidence_ids: string[]; supersedes_gist_id?: string; mark_done?: boolean }) => {
        const res = await admission.evaluate({
          taskId,
          workerId,
          baseSeq: getBaseSeq(),
          summary: params.summary,
          evidenceIds: params.evidence_ids,
          supersedesGistId: params.supersedes_gist_id,
          markDone: params.mark_done ?? true,
          durationMs: Date.now() - startedAt,
        });

        if (!res.admitted) {
          return {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            details: res,
            isError: true,
          };
        }

        setBaseSeq(res.gist.seq);
        return {
          content: [{ type: "text", text: `Admitted gist ${res.gist.id} (seq=${res.gist.seq}).` }],
          details: res.gist,
          terminate: Boolean(params.mark_done ?? true),
        };
      },
    },
  ];
}

export interface BoardMcpServerHandle {
  url: string;
  token: string;
  issueToken: (workerId: string, taskId: string) => string;
  revokeToken: (token: string) => void;
  close: () => Promise<void>;
}

/**
 * Single local HTTP/StreamableHTTP MCP server shared by all CLI subprocess workers.
 * Exposes the 5 DeLM coordination primitives + allowed/hitl tools from McpGateway.
 */
export async function startBoardMcpServer(
  store: BoardStore,
  admission: AdmissionGate,
  mcp: McpGateway,
): Promise<BoardMcpServerHandle> {
  const token = randomUUID();
  const scopedTokens = new Map<string, { workerId: string; taskId: string }>();
  const transports = new Map<
    string,
    { transport: WebStandardStreamableHTTPServerTransport; authToken: string }
  >();

  const buildMcpServer = (boundScope?: { workerId: string; taskId: string }) => {
    const server = new Server({ name: "minimaldelm-board", version: "0.1.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const delmDefs = [
        {
          name: "delm_spawn_tasks",
          description: "Decompose a task into independent subtasks on the global DeLM queue.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
              subtasks: { type: "array", items: { type: "object" } },
            },
            required: ["task_id", "subtasks"],
          },
        },
        {
          name: "delm_read_context",
          description: "Read reachable verified gists and recent deltas from the Board.",
          inputSchema: {
            type: "object",
            properties: { task_id: { type: "string" }, since_seq: { type: "number" } },
            required: ["task_id"],
          },
        },
        {
          name: "delm_unfold_evidence",
          description: "Read raw evidence content by evidence_id with optional offset/limit.",
          inputSchema: {
            type: "object",
            properties: { evidence_id: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
            required: ["evidence_id"],
          },
        },
        {
          name: "delm_record_evidence",
          description: "Record local evidence note for a task.",
          inputSchema: {
            type: "object",
            properties: { task_id: { type: "string" }, worker_id: { type: "string" }, note: { type: "string" } },
            required: ["task_id", "note"],
          },
        },
        {
          name: "delm_publish_gist",
          description: "Publish a verified compact gist to the Board Admission Gate.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
              worker_id: { type: "string" },
              base_seq: { type: "number" },
              summary: { type: "string" },
              evidence_ids: { type: "array", items: { type: "string" } },
              supersedes_gist_id: { type: "string" },
              mark_done: { type: "boolean" },
            },
            required: ["task_id", "summary", "evidence_ids"],
          },
        },
      ];

      const extDefs = mcp.listAllowedTools().map((t) => ({
        name: t.fullName,
        description: `${t.description}${t.tier === "hitl" ? " [HITL]" : ""}`,
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            worker_id: { type: "string" },
            args: { type: "object" },
          },
          required: ["task_id"],
        },
      }));

      return { tools: [...delmDefs, ...extDefs] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const a = (req.params.arguments ?? {}) as Record<string, unknown>;
      const taskId = boundScope ? boundScope.taskId : String(a.task_id ?? "");
      const workerId = boundScope ? boundScope.workerId : String(a.worker_id ?? "cli-worker");

      const task = taskId ? store.getTask(taskId) : null;
      if (!task) {
        return { isError: true, content: [{ type: "text", text: `Invalid or unknown task_id: ${taskId}` }] };
      }
      if (task.status !== "claimed" || task.claimed_by !== workerId) {
        return {
          isError: true,
          content: [{ type: "text", text: `Access denied: worker ${workerId} does not hold active lease on ${taskId}` }],
        };
      }

      if (name === "delm_unfold_evidence") {
        const ev = store.getEvidence(String(a.evidence_id ?? ""));
        if (!ev) return { isError: true, content: [{ type: "text", text: "Evidence not found" }] };
        if (!store.collectReachableTaskIds(taskId).has(ev.task_id)) {
          return { isError: true, content: [{ type: "text", text: `Access denied: unreachable evidence ${ev.id}` }] };
        }
        const nOffset = Number(a.offset ?? 0);
        const nLimit = Number(a.limit ?? 8_000);
        const offset = Math.max(0, Number.isFinite(nOffset) ? Math.floor(nOffset) : 0);
        const limit = Math.min(32_000, Math.max(1, Number.isFinite(nLimit) ? Math.floor(nLimit) : 8_000));
        return { content: [{ type: "text", text: ev.content.slice(offset, offset + limit) }] };
      }

      if (name === "delm_spawn_tasks") {
        const created = store.spawnTasks(taskId, (a.subtasks as any[]) ?? []);
        return { content: [{ type: "text", text: JSON.stringify(created.map((t) => t.id)) }] };
      }
      if (name === "delm_read_context") {
        const sinceSeq = Number(a.since_seq ?? 0);
        if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
          return { isError: true, content: [{ type: "text", text: "since_seq must be a non-negative finite number" }] };
        }
        const ctx = store.readContext(taskId, Math.floor(sinceSeq));
        return { content: [{ type: "text", text: JSON.stringify(ctx) }] };
      }
      if (name === "delm_record_evidence") {
        const ev = store.recordEvidence(taskId, workerId, "delm_note", { taskId }, String(a.note ?? ""));
        return { content: [{ type: "text", text: JSON.stringify({ evidence_id: ev.id }) }] };
      }
      if (name === "delm_publish_gist") {
        if (a.base_seq === undefined || a.base_seq === null) {
          return { isError: true, content: [{ type: "text", text: "base_seq is required" }] };
        }
        const baseSeq = Number(a.base_seq);
        if (!Number.isFinite(baseSeq) || baseSeq < 0) {
          return { isError: true, content: [{ type: "text", text: "base_seq must be a non-negative finite number" }] };
        }
        const res = await admission.evaluate({
          taskId,
          workerId,
          baseSeq: Math.floor(baseSeq),
          summary: String(a.summary ?? ""),
          evidenceIds: Array.isArray(a.evidence_ids) ? a.evidence_ids.map(String) : [],
          supersedesGistId: a.supersedes_gist_id ? String(a.supersedes_gist_id) : undefined,
          markDone: a.mark_done === undefined ? true : Boolean(a.mark_done),
        });
        return { isError: !res.admitted, content: [{ type: "text", text: JSON.stringify(res) }] };
      }

      const { task_id: _t, worker_id: _w, ...rest } = a;
      const cleanArgs = (a.args && typeof a.args === "object" ? a.args : rest) as Record<string, unknown>;
      const out = await mcp.executeTool(store, workerId, taskId, name, cleanArgs);
      return { isError: out.isError, content: [{ type: "text", text: out.text }] };
    });

    return server;
  };

  const safeEq = (a: string, b: string): boolean => {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  const resolveScope = (
    header: string | null,
  ): { ok: true; presented: string; scope?: { workerId: string; taskId: string } } | { ok: false } => {
    if (!header || !header.startsWith("Bearer ")) return { ok: false };
    const presented = header.slice("Bearer ".length);
    if (safeEq(presented, token)) return { ok: true, presented };
    for (const [scopedTok, scope] of scopedTokens.entries()) {
      if (safeEq(presented, scopedTok)) return { ok: true, presented, scope };
    }
    return { ok: false };
  };

  const httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1_048_576,
    fetch: async (req) => {
      const auth = resolveScope(req.headers.get("authorization"));
      if (!auth.ok) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId && transports.has(sessionId)) {
        const entry = transports.get(sessionId)!;
        if (!safeEq(auth.presented, entry.authToken)) {
          return new Response("Forbidden: session does not belong to presented token", { status: 403 });
        }
        return entry.transport.handleRequest(req);
      }
      if (transports.size >= 128) {
        return new Response("Too many active MCP sessions", { status: 429 });
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, { transport, authToken: auth.presented });
        },
        onsessionclosed: (sid) => {
          transports.delete(sid);
        },
      });
      const srv = buildMcpServer(auth.scope);
      await srv.connect(transport);
      return transport.handleRequest(req);
    },
  });

  return {
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    token,
    issueToken: (workerId: string, taskId: string) => {
      const t = randomUUID();
      scopedTokens.set(t, { workerId, taskId });
      return t;
    },
    revokeToken: (t: string) => {
      scopedTokens.delete(t);
      for (const [sid, entry] of transports.entries()) {
        if (safeEq(entry.authToken, t)) {
          transports.delete(sid);
          void entry.transport.close().catch(() => undefined);
        }
      }
    },
    close: async () => {
      scopedTokens.clear();
      for (const entry of transports.values()) await entry.transport.close().catch(() => undefined);
      transports.clear();
      httpServer.stop(true);
    },
  };
}
