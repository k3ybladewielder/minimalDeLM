import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AdmissionGate } from "./admission.ts";
import { CliBackend } from "./backends/cli.ts";
import { EmbeddedBackend } from "./backends/embedded.ts";
import { McpGateway, startBoardMcpServer, type BoardMcpServerHandle } from "./mcp.ts";
import { BoardStore } from "./store.ts";
import type { SwarmConfig, WorkerBackend } from "./types.ts";
import { startLeaseSweeper } from "./watchdog.ts";
import { runWorkerLoop } from "./worker.ts";

export async function runSwarm(goal: string, config: SwarmConfig) {
  const store = new BoardStore(config.dbPath);
  const mcp = config.mcpConfigPath ? McpGateway.fromFile(config.mcpConfigPath) : McpGateway.empty();
  let boardServer: BoardMcpServerHandle | undefined;
  let stopSweeper: (() => void) | undefined;

  try {
    await mcp.connectAll();

    const admission = new AdmissionGate(store, {
      verifySemantic: config.verifySemantic,
      semanticProvider: config.backend.provider,
      semanticModel: config.backend.model,
      requireExternalEvidence: mcp.listAllowedTools().length > 0,
    });

    let backend: WorkerBackend;
    if (config.backend.type === "cli") {
      boardServer = await startBoardMcpServer(store, admission, mcp);
      backend = new CliBackend(
        config.backend,
        {
          url: boardServer.url,
          token: boardServer.token,
          issueToken: boardServer.issueToken,
          revokeToken: boardServer.revokeToken,
        },
        store,
      );
    } else {
      backend = new EmbeddedBackend(store, admission, mcp, config.backend);
    }

    const root = store.createRootTask(goal);
    stopSweeper = startLeaseSweeper(store, 5_000);
    const workerCount = Math.min(32, Math.max(1, config.workers));

    const workers = Array.from({ length: workerCount }, (_, i) =>
      runWorkerLoop({
        workerId: `w-${i + 1}`,
        store,
        backend,
        config,
      }),
    );
    await Promise.all(workers);

    return {
      rootTaskId: root.id,
      tasks: store.getAllTasks(),
      gists: store.getAllVerifiedGists(),
      errors: store.getFailureEvidence(),
      totalTokens: store.getTotalTokensUsed(),
    };
  } finally {
    if (stopSweeper) stopSweeper();
    if (boardServer) await boardServer.close();
    await mcp.closeAll();
    store.close();
  }
}

export function parseSwarmCliArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      nagents: { type: "string", default: "3" },
      backend: { type: "string", default: "embedded" },
      provider: { type: "string", default: "openai" },
      model: { type: "string", default: "gpt-4o-mini" },
      cli: { type: "string", default: "pi" },
      mcp: { type: "string" },
      db: { type: "string", default: "minimaldelm.db" },
      "verify-semantic": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const nagents = Math.min(32, Math.max(1, Number.parseInt(values.nagents ?? "3", 10) || 3));
  const defaultMcpPath = join(process.cwd(), "mcp.config.json");
  const mcpConfigPath = values.mcp ?? (existsSync(defaultMcpPath) ? defaultMcpPath : undefined);
  return {
    goal: positionals.join(" ").trim(),
    config: {
      dbPath: values.db!,
      workers: nagents,
      leaseMs: 60_000,
      taskTimeoutMs: 180_000,
      stallMs: 45_000,
      loopThreshold: 3,
      maxTotalTokens: 200_000,
      verifySemantic: Boolean(values["verify-semantic"]),
      mcpConfigPath,
      backend: {
        type: values.backend === "cli" ? "cli" : "embedded",
        provider: values.provider,
        model: values.model,
        cliTool: (values.cli as "pi" | "claude" | "codex") ?? "pi",
      },
    } satisfies SwarmConfig,
  };
}

if (import.meta.main) {
  const { goal, config } = parseSwarmCliArgs(Bun.argv.slice(2));
  if (!goal) {
    console.error(
      'Usage: bun run src/index.ts "<goal>" [--nagents 3] [--backend embedded|cli] [--provider openai] [--model gpt-4o-mini] [--mcp mcp.config.json] [--verify-semantic]',
    );
    process.exit(1);
  }

  const result = await runSwarm(goal, config);

  console.log("\n=== Verified Gists ===");
  if (result.gists.length === 0) {
    console.log("(none)");
  } else {
    for (const g of result.gists) {
      console.log(`[seq=${g.seq}] (${g.task_id}) ${g.summary} [evidence: ${g.evidence_ids.join(", ")}]`);
    }
  }

  const unfinished = result.tasks.filter((t) => t.status !== "done");
  console.log(`\n=== Swarm Status (${result.tasks.length - unfinished.length}/${result.tasks.length} done) ===`);
  if (unfinished.length > 0) {
    for (const t of unfinished) {
      console.error(`- [${t.status}] (${t.id}) ${t.goal} (attempts=${t.attempts}/${t.max_attempts})`);
    }
    for (const ev of result.errors) {
      console.error(`  [${ev.tool_name}] (${ev.task_id}): ${ev.content.slice(0, 300)}`);
    }
    process.exit(1);
  }
}
