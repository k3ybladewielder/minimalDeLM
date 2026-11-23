import { describe, expect, test } from "bun:test";
import { AdmissionGate } from "../src/admission.ts";
import { CliBackend } from "../src/backends/cli.ts";
import { parseSwarmCliArgs } from "../src/index.ts";
import { createDelmTools, McpGateway, startBoardMcpServer } from "../src/mcp.ts";
import { BoardStore } from "../src/store.ts";
import type { SwarmConfig, WorkerBackend } from "../src/types.ts";
import { runWorkerLoop } from "../src/worker.ts";

describe("Security Audit Regression Tests", () => {
  test("AdmissionGate rejects failure evidence (embedded_error / watchdog_freeze)", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Task");
    store.claimTask("w-1", 10_000);

    const errEv = store.recordEvidence(root.id, "w-1", "embedded_error", {}, "Provider not configured");
    const freezeEv = store.recordEvidence(root.id, "w-1", "watchdog_freeze", {}, "Loop detected");

    const r1 = await gate.evaluate({
      taskId: root.id,
      workerId: "w-1",
      baseSeq: 0,
      summary: "Fake completion from error",
      evidenceIds: [errEv.id],
      markDone: true,
    });
    expect(r1.admitted).toBe(false);

    const r2 = await gate.evaluate({
      taskId: root.id,
      workerId: "w-1",
      baseSeq: 0,
      summary: "Fake completion from freeze",
      evidenceIds: [freezeEv.id],
      markDone: true,
    });
    expect(r2.admitted).toBe(false);
    store.close();
  });

  test("AdmissionGate rejects evidence belonging to an unreachable sibling task", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Root");
    store.claimTask("w-1", 10_000);
    store.spawnTasks(root.id, [
      { id: "branch-a", goal: "A" },
      { id: "branch-b", goal: "B" },
    ]);
    store.claimTask("w-1", 10_000);
    store.claimTask("w-2", 10_000);

    const evA = store.recordEvidence("branch-a", "w-1", "fetch", {}, "Data A");
    const crossBranch = await gate.evaluate({
      taskId: "branch-b",
      workerId: "w-2",
      baseSeq: 0,
      summary: "Borrowing evidence from unreachable branch-a",
      evidenceIds: [evA.id],
      markDone: true,
    });
    expect(crossBranch.admitted).toBe(false);
    if (!crossBranch.admitted) {
      expect(crossBranch.reason).toContain("unreachable");
    }
    store.close();
  });

  test("BoardMcpServer rejects wrong Bearer token with 401", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const srv = await startBoardMcpServer(store, gate, McpGateway.empty());
    try {
      const bad = await fetch(srv.url, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-value" },
      });
      expect(bad.status).toBe(401);

      const scoped = srv.issueToken("w-1", "t-1");
      srv.revokeToken(scoped);
      const revoked = await fetch(srv.url, {
        method: "POST",
        headers: { authorization: `Bearer ${scoped}` },
      });
      expect(revoked.status).toBe(401);
    } finally {
      await srv.close();
      store.close();
    }
  });

  test("AdmissionGate rejects publish from non-owner / expired lease worker", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Owned task");
    store.claimTask("w-1", 10_000);
    const ev = store.recordEvidence(root.id, "w-2", "fetch", {}, "data");

    const res = await gate.evaluate({
      taskId: root.id,
      workerId: "w-2",
      baseSeq: 0,
      summary: "Hijacking w-1 task",
      evidenceIds: [ev.id],
      markDone: true,
    });
    expect(res.admitted).toBe(false);
    if (!res.admitted) expect(res.reason).toContain("active lease");
    store.close();
  });

  test("readContext and delm_unfold_evidence isolate unrelated sibling branches", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Root");
    store.claimTask("w-1", 10_000);
    store.spawnTasks(root.id, [
      { id: "sib-a", goal: "A" },
      { id: "sib-b", goal: "B" },
    ]);
    store.claimTask("w-1", 10_000);
    store.claimTask("w-2", 10_000);

    const evA = store.recordEvidence("sib-a", "w-1", "fetch", {}, "Secret A");
    await gate.evaluate({
      taskId: "sib-a",
      workerId: "w-1",
      baseSeq: 0,
      summary: "Sibling A finding",
      evidenceIds: [evA.id],
      markDone: true,
    });

    const ctxB = store.readContext("sib-b", 0);
    expect(ctxB.gists.some((g) => g.task_id === "sib-a")).toBe(false);

    const toolsB = createDelmTools(store, gate, "w-2", "sib-b", () => 0, () => {}, Date.now());
    const unfold = toolsB.find((t) => t.name === "delm_unfold_evidence")!;
    const out = await unfold.execute("call-1", { evidence_id: evA.id });
    expect(out.isError).toBe(true);
    store.close();
  });

  test("AdmissionGate rejects delm_note-only self-attestation when requireExternalEvidence is true", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false, requireExternalEvidence: true });
    const root = store.createRootTask("Self attestation check");
    store.claimTask("w-1", 10_000);

    const noteEv = store.recordEvidence(root.id, "w-1", "delm_note", {}, "Trust me");
    const res = await gate.evaluate({
      taskId: root.id,
      workerId: "w-1",
      baseSeq: 0,
      summary: "Everything verified",
      evidenceIds: [noteEv.id],
      markDone: true,
    });
    expect(res.admitted).toBe(false);
    store.close();
  });

  test("CliBackend disables claude built-in tools and parseSwarmCliArgs caps --nagents at 32", () => {
    const claudeSpec = new CliBackend({ type: "cli", cliTool: "claude" }).buildCommand("goal", "sys");
    expect(claudeSpec.args).toContain("--disallowedTools");
    const parsed = parseSwarmCliArgs(["--nagents", "999", "Goal"]);
    expect(parsed.config.workers).toBe(32);
  });

  test("AdmissionGate blocks cross-task supersedesGistId and expired leases", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Root");
    store.claimTask("w-1", 10_000);
    store.spawnTasks(root.id, [
      { id: "task-a", goal: "A" },
      { id: "task-b", goal: "B" },
    ]);
    store.claimTask("w-1", 10_000);
    const evA = store.recordEvidence("task-a", "w-1", "fetch", {}, "A");
    const gA = await gate.evaluate({
      taskId: "task-a",
      workerId: "w-1",
      baseSeq: 0,
      summary: "Gist A",
      evidenceIds: [evA.id],
      markDone: true,
    });
    expect(gA.admitted).toBe(true);

    store.claimTask("w-2", 10_000);
    const evB = store.recordEvidence("task-b", "w-2", "fetch", {}, "B");
    if (gA.admitted) {
      const cross = await gate.evaluate({
        taskId: "task-b",
        workerId: "w-2",
        baseSeq: store.getLatestSeq(),
        summary: "Cross-task supersede attempt",
        evidenceIds: [evB.id],
        supersedesGistId: gA.gist.id,
      });
      expect(cross.admitted).toBe(false);
    }

    // Expired lease must be rejected even before sweeper runs
    store.db.query("UPDATE tasks SET lease_expires_at = ? WHERE id = 'task-b'").run(Date.now() - 1_000);
    const expired = await gate.evaluate({
      taskId: "task-b",
      workerId: "w-2",
      baseSeq: store.getLatestSeq(),
      summary: "Expired lease publish",
      evidenceIds: [evB.id],
      markDone: true,
    });
    expect(expired.admitted).toBe(false);
    store.close();
  });

  test("BoardStore rejects self-dependency and runWorkerLoop terminates on cyclic dependencies", async () => {
    const store = new BoardStore(":memory:");
    const root = store.createRootTask("Root");
    store.claimTask("w-1", 10_000);
    expect(() => store.spawnTasks(root.id, [{ id: "self", goal: "Self", depends_on: ["self"] }])).toThrow();

    store.spawnTasks(root.id, [
      { id: "cyc-1", goal: "C1", depends_on: ["cyc-2"] },
      { id: "cyc-2", goal: "C2", depends_on: ["cyc-1"] },
    ]);
    store.markTaskStatus(root.id, "done");

    const noop: WorkerBackend = {
      async runTask() {
        return { tokensUsed: 0 };
      },
    };
    const cfg: SwarmConfig = {
      dbPath: ":memory:",
      workers: 1,
      leaseMs: 5_000,
      taskTimeoutMs: 5_000,
      stallMs: 5_000,
      loopThreshold: 3,
      maxTotalTokens: 10_000,
      verifySemantic: false,
      backend: { type: "embedded" },
    };

    await runWorkerLoop({ workerId: "w-1", store, backend: noop, config: cfg });
    expect(store.getTask("cyc-1")?.status).toBe("incomplete");
    expect(store.getTask("cyc-2")?.status).toBe("incomplete");
    store.close();
  });

  test("BoardMcpServer prevents cross-token MCP session hijacking (403)", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const srv = await startBoardMcpServer(store, gate, McpGateway.empty());
    try {
      const tokA = srv.issueToken("w-1", "t-1");
      const tokB = srv.issueToken("w-2", "t-2");

      const initRes = await fetch(srv.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id");
      if (sessionId) {
        const hijack = await fetch(srv.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${tokB}`,
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        });
        expect(hijack.status).toBe(403);
      }
    } finally {
      await srv.close();
      store.close();
    }
  });
});
