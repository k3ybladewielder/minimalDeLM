# minimalDeLM

A minimalist, general-purpose, **role-free AI agent swarm harness** built on **Bun**, **SQLite**, **MCP**, and the **Pi** toolkit, implementing the **DeLM** (*Decentralized Language Models*, [arXiv:2606.10662](https://arxiv.org/abs/2606.10662)) architecture.

---

## Key Principles

* **Decentralized & Role-Free:** No central orchestrator, no `team-lead`, and no fixed agent personas (*Planner*, *Coder*, *Reviewer*). All `--nagents` workers are identical peers pulling from a shared queue.
* **General-Purpose (Not Coding-Only):** Built-in coding tools (`read`, `write`, `edit`, `bash`) are disabled/omitted by default. External capabilities enter strictly via **MCP**.
* **Default-Deny Security + HITL:** Zero MCP tools are permitted unless explicitly listed in `allow` or `hitl` in `mcp.config.json`. Side-effect tools (`hitl`) pause only the requesting worker for human approval.
* **Verified Shared Context:** Claims in shared *compact gists* must cite real `evidence_ids` and pass a parallel Admission Gate with optimistic concurrency (`base_seq` CAS).
* **Dual Execution Backends:** Supports both **direct LLM APIs** (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) and **isolated CLI subprocesses** (`pi --mode rpc`, `claude -p`, `codex exec`).

---

## Quickstart

Everything (including **Bun** and **Pi**) is installed locally inside the repository:

### Option A: Direct LLM API (`--backend embedded`)

Export your provider API key once using the provider-agnostic `LLM_API_KEY` variable (provider-specific variables like `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` are also supported as fallbacks), then run via `./minimaldelm` (or add `.bun/bin` to your `PATH` to use `bun` directly):

```bash
export LLM_API_KEY="your-key"

./minimaldelm \
  "Compare 4 vector databases on price, license, and latency" \
  --nagents 3 \
  --provider openai \
  --model gpt-4o-mini \
  --mcp mcp.config.json
```

### Option B: Authenticated CLI (`--backend cli`)

Authenticate the local **Pi** CLI (or use an already logged-in `claude` / `codex` CLI):

```bash
# 1. Sign in with your provider account (or check status)
./node_modules/.bin/pi auth login openai-codex
./node_modules/.bin/pi auth check --provider openai-codex

# 2. Run minimalDeLM using the authenticated Pi CLI in isolated RPC mode
./minimaldelm \
  "Audit docs for outdated claims" \
  --nagents 3 \
  --backend cli \
  --cli pi

# Or using Claude Code / Codex CLI already logged in on your machine:
./minimaldelm "Audit docs" --nagents 3 --backend cli --cli claude
./minimaldelm "Audit docs" --nagents 3 --backend cli --cli codex
```

See [`docs/getting-started.md`](docs/getting-started.md) for all flags, `mcp.config.json` format, and why `minimalDeLM` uses a streaming CLI instead of a full-screen TUI.

---

## Project Layout

```text
src/
  types.ts             # Shared types & backend interfaces
  store.ts             # bun:sqlite Board (tasks, evidence, gists, LPT, leases)
  admission.ts         # Parallel Admission Gate (structural + base_seq CAS + semantic)
  mcp.ts               # Singleton Default-Deny MCP Gateway + serialized HITL + 5 DeLM tools
  watchdog.ts          # Stall, timeout, loop detection, and lease sweeper
  backends/
    embedded.ts        # Pi Embedded Core (pi-agent-core + pi-ai)
    cli.ts             # Isolated CLI subprocesses (pi --mode rpc, claude, codex)
  worker.ts            # Homogeneous role-free worker loop
  index.ts             # CLI entrypoint (--nagents 3 default)
tests/
  store-admission.test.ts
  mcp-watchdog-worker.test.ts
  properties.test.ts           # Property-based tests (fast-check)
  formal-verification.test.ts  # Full-system model checking (ts-model-checker)
```

---

## Documentation (`docs/`)

* [**Getting Started & Usage**](docs/getting-started.md)
* [**Architecture**](docs/architecture.md)
* [**Verification & Formal Model Checking**](docs/verification.md)

---

## Contributing

Contributions are welcome! Feel free to open issues, propose improvements via pull requests, or add new general-purpose MCP integrations and verification scenarios. When opening a PR, please follow the [Pull Request Template](.github/pull_request_template.md) and ensure `./.bun/bin/bun test` and `./.bun/bin/bun x tsc --noEmit` pass before submitting.
