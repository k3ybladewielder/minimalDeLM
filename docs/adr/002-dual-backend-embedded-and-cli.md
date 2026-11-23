# ADR-002: Dual Worker Backend (Embedded Core vs. Isolated CLI)

* **Status:** Accepted
* **Date:** 2026-11-23

## Context
Users may authenticate LLMs either via **API keys / local models** (low-latency SDK calls) or via **existing logged-in CLI subscriptions** (`pi`, `claude`, `codex`, as in `jpvmm/orquestra` and `eduwxyz/tucano`).

## Decision
Define a single `WorkerBackend` interface (`src/types.ts`) shared by the DeLM worker loop (`src/worker.ts`):
1. **`EmbeddedBackend` (`src/backends/embedded.ts`):** Uses `@earendil-works/pi-agent-core` (`Agent`) + `@earendil-works/pi-ai` (`createModels`) directly in-process over Bun, with zero coding-tool coupling.
2. **`CliBackend` (`src/backends/cli.ts`):** Spawns isolated CLI subprocesses (`./node_modules/.bin/pi --mode rpc --no-builtin-tools --no-session`, `claude -p --strict-mcp-config`, `codex exec --json`) in detached process groups, never modifying global user configs (`~/.pi`, `~/.claude`, `~/.codex`), and killing the full process tree on abort/exit.

## Consequences
* **Positive:** Users choose their preferred auth/billing model via `--backend embedded|cli` without duplicating Board, Admission, or Watchdog logic.
* **Negative:** `CliBackend` requires exposing the DeLM Board over a local MCP server bridge so external processes can invoke `delm_*` tools.
