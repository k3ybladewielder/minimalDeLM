# Architecture

`minimalDeLM` implements a **decentralized, role-free multi-agent harness** inspired by **DeLM** (*Decentralized Language Models*, [arXiv:2606.10662](https://arxiv.org/abs/2606.10662)) and built on the **Pi** toolkit (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`).

---

## System Overview

```text
+-----------------------------------------------------------------------------+
|                        minimalDeLM HOST (Bun Runtime)                       |
|                                                                             |
|  +-----------------------+  +--------------------+  +--------------------+  |
|  |   BOARD (bun:sqlite)  |  |   ADMISSION GATE   |  |  WATCHDOG (Vigia)  |  |
|  | - tasks (LPT + lease) |  |  Promise.all:      |  | - stall / timeout  |  |
|  | - gists (seq + delta) |  |  1. evidence_ids   |  | - loop detection   |  |
|  | - evidence (raw log)  |  |  2. base_seq (CAS) |  | - group kill (CLI) |  |
|  +-----------+-----------+  |  3. semantic (opt) |  | - incomplete state |  |
|              |              +--------------------+  +--------------------+  |
|              |                                                              |
|  +-----------v-----------------------------------------------------------+  |
|  |               MCP GATEWAY SINGLETON (Default-Deny + HITL)             |  |
|  +-----------+-----------------------------------------------+-----------+  |
|              |                                               |              |
|  +-----------v-------------------+           +---------------v-----------+  |
|  |   BACKEND: "embedded"         |           |   BACKEND: "cli"          |  |
|  |  pi-agent-core + pi-ai        |           |  pi --mode rpc            |  |
|  |  (API keys / Ollama local)    |           |  claude -p / codex exec   |  |
|  +-------------------------------+           +---------------------------+  |
+-----------------------------------------------------------------------------+
```

---

## Core Components

### 1. Shared Board & Global Task Queue (`src/store.ts`)
Backed by `bun:sqlite` in `WAL` mode:
- **`tasks`:** Asynchronous queue with `depends_on` dependency resolution, `weight` (`1..3`) for **Longest Processing Time first (LPT)** scheduling, and `lease_expires_at` for automatic crash/stall recovery. Claims execute inside `BEGIN IMMEDIATE` transactions.
- **`evidence`:** Append-only log of raw MCP tool outputs and local observations.
- **`gists`:** *Shared Verified Context* storing compact 3–5 line summaries linked to mandatory `evidence_ids`, ordered by a monotonic global `seq`, with `supersedes_gist_id` for incremental corrections.
- **Event-driven wakeups:** Idle workers sleep on `store.onWakeup(...)` instead of polling.

### 2. The 5 DeLM Coordination Primitives (`src/mcp.ts`)
Every peer worker receives the same minimal system prompt and 5 coordination tools:
1. `delm_spawn_tasks` — decompose a task into parallel subtasks on the global queue.
2. `delm_read_context` — read only **reachable** verified gists (ancestors, dependencies, children) plus recent deltas (`seq > since_seq`).
3. `delm_unfold_evidence` — inspect raw `evidence.content` on demand.
4. `delm_record_evidence` — record a verified synthesis note when no external MCP tool produced an `evidence_id`.
5. `delm_publish_gist` — submit a compact gist to the Admission Gate (optionally marking the task `done`).

### 3. Parallel Admission Gate (`src/admission.ts`)
Runs all enabled checks concurrently via `Promise.all`:
- **Structural:** validates non-empty summary and existence of every referenced `evidence_id`.
- **Optimistic Concurrency (`base_seq` CAS):** rejects stale publishes when a peer advanced reachable context after `base_seq`, returning `conflictDelta` for explicit reconciliation (no silent auto-merge).
- **Semantic (optional `--verify-semantic`):** off by default; uses `pi-ai` to check summary adherence against referenced evidence.

### 4. Default-Deny MCP Gateway & HITL (`src/mcp.ts`)
- Connects **once per process** (singleton) to configured `stdio` MCP servers.
- Exposes **only** tools listed in `policy.allow` or `policy.hitl`.
- Serializes `hitl` approval prompts through a single promise chain so parallel workers never race over `stdin`.

### 5. Watchdog & Dual Backends (`src/watchdog.ts`, `src/backends/`)
- **`TaskWatchdog`:** enforces per-task wall-clock timeouts, stall detection, global token budget caps, lease renewals, and **loop detection** (aborting after $K$ consecutive identical tool calls or normalized errors).
- **Incomplete Rule:** if a worker exits without calling `delm_publish_gist(..., mark_done=true)`, the task transitions to `pending` (for retry) or `incomplete`—never `done`.
- **`EmbeddedBackend` (`src/backends/embedded.ts`):** runs `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` in-process.
- **`CliBackend` (`src/backends/cli.ts`):** spawns isolated CLI subprocesses (`pi --mode rpc --no-builtin-tools`, `claude -p --strict-mcp-config`, `codex exec --json`) in detached process groups and terminates the entire process tree on abort/exit.
