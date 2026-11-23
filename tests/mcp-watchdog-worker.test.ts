import { describe, expect, test } from "bun:test";
import { AdmissionGate } from "../src/admission.ts";
import { CliBackend } from "../src/backends/cli.ts";
import { resolveProviderApiKey } from "../src/backends/embedded.ts";
import { parseSwarmCliArgs } from "../src/index.ts";
import { McpGateway } from "../src/mcp.ts";
import { BoardStore } from "../src/store.ts";
import type { SwarmConfig, WorkerBackend } from "../src/types.ts";
import { TaskWatchdog } from "../src/watchdog.ts";
import { runWorkerLoop } from "../src/worker.ts";

describe("McpGateway + Watchdog + WorkerLoop", () => {
  test("McpGateway enforces default-deny policy", async () => {
    const store = new BoardStore(":memory:");
    const root = store.createRootTask("Triage tickets");
    const gw = new McpGateway(
      {
        servers: {},
        policy: { allow: ["tickets.list"], hitl: ["slack.post_message"] },
      },
      async () => ({ approved: false, reason: "Not now" }),
    );

    expect(gw.getTier("tickets.list")).toBe("allow");
    expect(gw.getTier("slack.post_message")).toBe("hitl");
    expect(gw.getTier("bash.exec")).toBe("deny");

    const denied = await gw.executeTool(store, "w-1", root.id, "bash.exec", { cmd: "rm -rf /" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("default-deny");
    store.close();
  });

  test("TaskWatchdog aborts on repeated identical tool calls", () => {
    const store = new BoardStore(":memory:");
    const root = store.createRootTask("Loop test");
    store.claimTask("w-1", 10_000);

    const wd = new TaskWatchdog(store, root.id, "w-1", {
      leaseMs: 10_000,
      taskTimeoutMs: 60_000,
      stallMs: 60_000,
      loopThreshold: 3,
      maxTotalTokens: 100_000,
    });

    wd.recordToolCall("search", { q: "same" });
    expect(wd.signal.aborted).toBe(false);
    wd.recordToolCall("search", { q: "same" });
    expect(wd.signal.aborted).toBe(false);
    wd.recordToolCall("search", { q: "same" });
    expect(wd.signal.aborted).toBe(true);
    expect(wd.reason).toContain("Loop detected");
    wd.stop();
    store.close();
  });

  test("runWorkerLoop marks task incomplete if backend exits without publishing gist", async () => {
    const store = new BoardStore(":memory:");
    const root = store.createRootTask("Incomplete check");
    // Force max_attempts = 1 so exiting without gist transitions directly to 'incomplete'
    store.db.query("UPDATE tasks SET max_attempts = 1 WHERE id = ?").run(root.id);

    const noOpBackend: WorkerBackend = {
      async runTask() {
        return { tokensUsed: 42 };
      },
    };

    const config: SwarmConfig = {
      dbPath: ":memory:",
      workers: 1,
      leaseMs: 5_000,
      taskTimeoutMs: 10_000,
      stallMs: 10_000,
      loopThreshold: 3,
      maxTotalTokens: 10_000,
      verifySemantic: false,
      backend: { type: "embedded" },
    };

    await runWorkerLoop({ workerId: "w-1", store, backend: noOpBackend, config });
    expect(store.getTask(root.id)?.status).toBe("incomplete");
    expect(store.getTask(root.id)?.tokens_used).toBe(42);
    store.close();
  });

  test("runWorkerLoop runs parallel role-free workers through decomposition and admission", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });
    const root = store.createRootTask("Research 2 options");

    const mockBackend: WorkerBackend = {
      async runTask({ workerId, task }) {
        const baseSeq = store.getLatestSeq();
        if (task.id === root.id) {
          store.spawnTasks(root.id, [
            { id: "opt-a", goal: "Check option A", weight: 2 },
            { id: "opt-b", goal: "Check option B", weight: 2 },
          ]);
          const ev = store.recordEvidence(task.id, workerId, "decompose", {}, "Split into opt-a and opt-b");
          await gate.evaluate({
            taskId: task.id,
            workerId,
            baseSeq,
            summary: "Decomposed root task into opt-a and opt-b.",
            evidenceIds: [ev.id],
            markDone: true,
          });
          return { tokensUsed: 50 };
        }

        const ev = store.recordEvidence(task.id, workerId, "fetch", { id: task.id }, `Data for ${task.id}`);
        await gate.evaluate({
          taskId: task.id,
          workerId,
          baseSeq,
          summary: `Verified findings for ${task.id}.`,
          evidenceIds: [ev.id],
          markDone: true,
        });
        return { tokensUsed: 30 };
      },
    };

    const config: SwarmConfig = {
      dbPath: ":memory:",
      workers: 2,
      leaseMs: 5_000,
      taskTimeoutMs: 10_000,
      stallMs: 10_000,
      loopThreshold: 3,
      maxTotalTokens: 10_000,
      verifySemantic: false,
      backend: { type: "embedded" },
    };

    await Promise.all([
      runWorkerLoop({ workerId: "w-1", store, backend: mockBackend, config }),
      runWorkerLoop({ workerId: "w-2", store, backend: mockBackend, config }),
    ]);

    expect(store.getTask(root.id)?.status).toBe("done");
    expect(store.getTask("opt-a")?.status).toBe("done");
    expect(store.getTask("opt-b")?.status).toBe("done");
    expect(store.getAllVerifiedGists().length).toBe(3);
    store.close();
  });

  test("CliBackend builds isolated commands for pi, claude, and codex", () => {
    const piSpec = new CliBackend({ type: "cli", cliTool: "pi" }).buildCommand("goal", "sys");
    expect(piSpec.command.endsWith("pi")).toBe(true);
    expect(piSpec.args).toContain("--mode");
    expect(piSpec.args).toContain("rpc");
    expect(piSpec.args).toContain("--no-builtin-tools");
    expect(piSpec.args).toContain("--no-session");
    expect(piSpec.args).toContain("--system-prompt");

    const claudeSpec = new CliBackend({ type: "cli", cliTool: "claude" }).buildCommand("goal", "sys", "/tmp/mcp.json");
    expect(claudeSpec.command).toBe("claude");
    expect(claudeSpec.args).toContain("--strict-mcp-config");
    expect(claudeSpec.args).toContain("--mcp-config");

    const codexSpec = new CliBackend({ type: "cli", cliTool: "codex" }).buildCommand("goal", "sys");
    expect(codexSpec.command).toBe("codex");
    expect(codexSpec.args).toEqual(["exec", "--json", "sys\n\n---\n\ngoal"]);
  });

  test("parseSwarmCliArgs defaults --nagents to 3 and allows override", () => {
    const def = parseSwarmCliArgs(["Compare 4 databases"]);
    expect(def.goal).toBe("Compare 4 databases");
    expect(def.config.workers).toBe(3);

    const custom = parseSwarmCliArgs(["--nagents", "5", "Audit docs"]);
    expect(custom.goal).toBe("Audit docs");
    expect(custom.config.workers).toBe(5);
    expect(custom.config.mcpConfigPath?.endsWith("mcp.config.json")).toBe(true);
  });

  test("default mcp.config.json loads Tucano servers as default-deny with zero spawned servers", async () => {
    const gw = McpGateway.fromFile("mcp.config.json");
    await gw.connectAll(); // Should not spawn any npx server when allow/hitl are empty
    expect(gw.listAllowedTools().length).toBe(0);
    expect(gw.getTier("github.create_issue")).toBe("deny");
    expect(gw.getTier("slack.post_message")).toBe("deny");
    expect(gw.getTier("linear.search_issues")).toBe("deny");
    await gw.closeAll();
  });

  test("resolveProviderApiKey prioritizes generic LLM_API_KEY and falls back to provider key", () => {
    const prevGeneric = process.env.LLM_API_KEY;
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.LLM_API_KEY = "generic-secret";
      process.env.ANTHROPIC_API_KEY = "anthropic-secret";
      expect(resolveProviderApiKey("anthropic")).toBe("generic-secret");
      expect(resolveProviderApiKey("openai")).toBe("generic-secret");

      delete process.env.LLM_API_KEY;
      expect(resolveProviderApiKey("anthropic")).toBe("anthropic-secret");
    } finally {
      if (prevGeneric === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prevGeneric;
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });
});
