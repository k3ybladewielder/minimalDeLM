import { describe, expect, test } from "bun:test";
import { AdmissionGate } from "../src/admission.ts";
import { McpGateway, startBoardMcpServer } from "../src/mcp.ts";
import { BoardStore } from "../src/store.ts";
import type { SwarmConfig, WorkerBackend } from "../src/types.ts";
import { runWorkerLoop } from "../src/worker.ts";

function makeConfig(workers = 3): SwarmConfig {
  return {
    dbPath: ":memory:",
    workers,
    leaseMs: 15_000,
    taskTimeoutMs: 30_000,
    stallMs: 15_000,
    loopThreshold: 3,
    maxTotalTokens: 100_000,
    verifySemantic: false,
    backend: { type: "embedded" },
  };
}

describe("General-Purpose E2E Scenarios (Mocked MCP + 3 Peer Workers)", () => {
  test("E2E 1: Verifiable Research & Comparative Matrix (3 parallel role-free agents)", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Compare 3 vector DBs on license and latency", "Every cell must cite evidence_id");

    const mockSources: Record<string, string> = {
      qdrant: "Qdrant: Apache-2.0 license, p99 latency 4.2ms",
      milvus: "Milvus: Apache-2.0 license, p99 latency 6.1ms",
      pgvector: "pgvector: PostgreSQL license, p99 latency 11.4ms",
    };

    const backend: WorkerBackend = {
      async runTask({ workerId, task }) {
        const ctx = store.readContext(task.id, 0);
        if (task.id === root.id) {
          store.spawnTasks(root.id, [
            { id: "db-qdrant", goal: "Research qdrant", weight: 2 },
            { id: "db-milvus", goal: "Research milvus", weight: 2 },
            { id: "db-pgvector", goal: "Research pgvector", weight: 2 },
            {
              id: "matrix-synth",
              goal: "Synthesize verified matrix",
              weight: 3,
              depends_on: ["db-qdrant", "db-milvus", "db-pgvector"],
            },
          ]);
          const ev = store.recordEvidence(task.id, workerId, "plan", {}, "Split into 3 DB tasks + 1 synthesis");
          await gate.evaluate({
            taskId: task.id,
            workerId,
            baseSeq: ctx.latestSeq,
            summary: "Decomposed comparison into 3 parallel DB lookups and 1 dependent synthesis.",
            evidenceIds: [ev.id],
            markDone: true,
          });
          return { tokensUsed: 40 };
        }

        if (task.id === "matrix-synth") {
          const allGists = ctx.gists.filter((g) => g.task_id.startsWith("db-"));
          expect(allGists.length).toBe(3);
          const evIds = allGists.flatMap((g) => g.evidence_ids);
          const res = await gate.evaluate({
            taskId: task.id,
            workerId,
            baseSeq: ctx.latestSeq,
            summary: "Matrix complete: Qdrant (4.2ms), Milvus (6.1ms), pgvector (11.4ms).",
            evidenceIds: evIds,
            markDone: true,
          });
          expect(res.admitted).toBe(true);
          return { tokensUsed: 60 };
        }

        const key = task.id.replace("db-", "");
        const ev = store.recordEvidence(task.id, workerId, "mock.fetch", { key }, mockSources[key]!);
        await gate.evaluate({
          taskId: task.id,
          workerId,
          baseSeq: ctx.latestSeq,
          summary: mockSources[key]!,
          evidenceIds: [ev.id],
          markDone: true,
        });
        return { tokensUsed: 30 };
      },
    };

    const cfg = makeConfig(3);
    await Promise.all([
      runWorkerLoop({ workerId: "w-1", store, backend, config: cfg }),
      runWorkerLoop({ workerId: "w-2", store, backend, config: cfg }),
      runWorkerLoop({ workerId: "w-3", store, backend, config: cfg }),
    ]);

    expect(store.getTask("matrix-synth")?.status).toBe("done");
    expect(store.getAllVerifiedGists().length).toBe(5);
    store.close();
  });

  test("E2E 2: Log/Ticket Triage + HITL Rejection & Approval Flow", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Triage critical errors and notify #ops with HITL");

    let hitlCalls = 0;
    const gw = new McpGateway(
      {
        servers: {},
        policy: { allow: ["sentry.list_issues"], hitl: ["slack.post_message"] },
      },
      async (req) => {
        hitlCalls += 1;
        // First attempt rejected with feedback; second attempt approved
        if (hitlCalls === 1) return { approved: false, reason: "Include error count in message" };
        expect(String((req.args as { text: string }).text)).toContain("42 errors");
        return { approved: true };
      },
    );

    // Register in-memory mock MCP tools via internal map for E2E without spawning npx
    (gw as any).clients.set("sentry", {
      callTool: async () => ({ content: [{ type: "text", text: "Issue #99: DB timeout (42 errors)" }], isError: false }),
    });
    (gw as any).clients.set("slack", {
      callTool: async () => ({ content: [{ type: "text", text: "Posted to #ops ts=12345" }], isError: false }),
    });
    (gw as any).tools.set("sentry.list_issues", {
      fullName: "sentry.list_issues",
      serverName: "sentry",
      remoteName: "list_issues",
      description: "List issues",
      inputSchema: { type: "object" },
      tier: "allow",
    });
    (gw as any).tools.set("slack.post_message", {
      fullName: "slack.post_message",
      serverName: "slack",
      remoteName: "post_message",
      description: "Post message",
      inputSchema: { type: "object" },
      tier: "hitl",
    });

    const backend: WorkerBackend = {
      async runTask({ workerId, task }) {
        const readRes = await gw.executeTool(store, workerId, task.id, "sentry.list_issues", {});
        expect(readRes.isError).toBe(false);

        const firstPost = await gw.executeTool(store, workerId, task.id, "slack.post_message", {
          channel: "#ops",
          text: "DB timeout alert",
        });
        expect(firstPost.isError).toBe(true);
        expect(firstPost.text).toContain("Include error count");

        const secondPost = await gw.executeTool(store, workerId, task.id, "slack.post_message", {
          channel: "#ops",
          text: "DB timeout alert: 42 errors on Issue #99",
        });
        expect(secondPost.isError).toBe(false);

        await gate.evaluate({
          taskId: task.id,
          workerId,
          baseSeq: store.getLatestSeq(),
          summary: "Triaged Issue #99 (42 errors) and notified #ops after human approval.",
          evidenceIds: [readRes.evidenceId!, secondPost.evidenceId!],
          markDone: true,
        });
        return { tokensUsed: 50 };
      },
    };

    await runWorkerLoop({ workerId: "w-1", store, backend, config: makeConfig(1) });
    expect(hitlCalls).toBe(2);
    expect(store.getTask(root.id)?.status).toBe("done");
    store.close();
  });

  test("E2E 3: Documentation Audit with unfold pagination & contested propagation", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });

    const root = store.createRootTask("Audit docs");
    store.claimTask("w-1", 10_000);
    store.markTaskStatus(root.id, "done");

    store.spawnTasks(root.id, [
      { id: "doc-a", goal: "Audit doc A" },
      { id: "doc-synth", goal: "Synthesize audit", depends_on: ["doc-a"] },
    ]);

    // 1. Initial audit on doc-a with large evidence (> 8000 chars)
    store.claimTask("w-1", 10_000);
    const largeDoc = "A".repeat(8_000) + "DEPRECATED_V1_FLAG";
    const evA = store.recordEvidence("doc-a", "w-1", "docs.read", { file: "a.md" }, largeDoc);
    const g1 = await gate.evaluate({
      taskId: "doc-a",
      workerId: "w-1",
      baseSeq: store.getLatestSeq(),
      summary: "Doc A looks up to date (missed tail).",
      evidenceIds: [evA.id],
      markDone: true,
    });
    expect(g1.admitted).toBe(true);

    // 2. Dependent doc-synth completes based on g1
    store.claimTask("w-2", 10_000);
    const evS = store.recordEvidence("doc-synth", "w-2", "delm_note", {}, "No issues found in doc A");
    const g2 = await gate.evaluate({
      taskId: "doc-synth",
      workerId: "w-2",
      baseSeq: store.getLatestSeq(),
      summary: "All docs clean.",
      evidenceIds: [evS.id],
      markDone: true,
    });
    expect(g2.admitted).toBe(true);
    expect(store.getTask("doc-synth")?.status).toBe("done");

    // 3. Peer unfolds tail of evA (offset=8000) and publishes correction with supersedes_gist_id
    const tail = store.getEvidence(evA.id)!.content.slice(8_000, 16_000);
    expect(tail).toBe("DEPRECATED_V1_FLAG");

    if (g1.admitted) {
      const gCorr = await gate.evaluate({
        taskId: "doc-a",
        workerId: "w-3",
        baseSeq: store.getLatestSeq(),
        summary: "Correction: Doc A contains DEPRECATED_V1_FLAG at offset 8000.",
        evidenceIds: [evA.id],
        supersedesGistId: g1.gist.id,
        markDone: true,
      });
      expect(gCorr.admitted).toBe(true);
    }

    // Downstream gist g2 must be marked 'contested' and doc-synth reopened to 'pending'
    const gists = store.db.query("SELECT id, status FROM gists").all() as { id: string; status: string }[];
    const g2Row = gists.find((g) => g2.admitted && g.id === g2.gist.id);
    expect(g2Row?.status).toBe("contested");
    expect(store.getTask("doc-synth")?.status).toBe("pending");
    store.close();
  });

  test("Local Board MCP Server enforces Bearer auth and serves DeLM tools over HTTP", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const gw = McpGateway.empty();
    const srv = await startBoardMcpServer(store, gate, gw);

    try {
      const unauth = await fetch(srv.url, { method: "POST" });
      expect(unauth.status).toBe(401);

      const initRes = await fetch(srv.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${srv.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      });
      expect(initRes.status).toBe(200);
    } finally {
      await srv.close();
      store.close();
    }
  });
});
