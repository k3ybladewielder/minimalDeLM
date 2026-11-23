# ADR-005: Arbitrated MVP Design Decisions

* **Status:** Accepted
* **Date:** 2026-11-23

This ADR records the five architectural arbitrations resolved to complete the `minimalDeLM` MVP, including the evaluated pros, cons, and rationale for each choice.

---

## 1. Local Board MCP Server Transport: Single HTTP Server vs. Per-Subprocess `stdio` Bridge

* **Options Considered:**
  1. **Single Local HTTP / StreamableHTTP Server (`127.0.0.1:<ephemeral-port>` with Bearer token):**
     * *Pros:* Preserves the singleton `McpGateway` and serialized HITL queue in host memory; zero extra bridge processes per CLI worker; mirrors `eduwxyz/tucano`'s local MCP gateway pattern.
     * *Cons:* Binds a local TCP port (`127.0.0.1:0`) and assumes CLI clients support HTTP MCP transport (`pi` and `claude` do natively; older `codex` versions may require an HTTP-to-stdio shim).
  2. **Per-Subprocess `stdio` Bridge:**
     * *Pros:* Works with any CLI without opening a local TCP port.
     * *Cons:* Spawns $N$ additional bridge processes and loses direct in-memory access to the host `McpGateway` singleton and HITL queue.
* **Decision & Rationale:** **Single Local HTTP / StreamableHTTP Server** (`startBoardMcpServer` in `src/mcp.ts`). It is simpler, spawns fewer processes, and keeps the singleton MCP Gateway + HITL queue intact.

---

## 2. Correction Propagation (`supersedes_gist_id`): Automatic `contested` Downstream vs. Passive Supersede

* **Options Considered:**
  1. **Propagate `contested` Downstream:**
     * *Pros:* Prevents stale downstream conclusions from silently remaining `verified`/`done` when an upstream finding is corrected; forces peers to re-evaluate affected dependent tasks.
     * *Cons:* Can trigger extra re-work if a minor wording correction did not invalidate downstream logic.
  2. **Passive Supersede Only:**
     * *Pros:* Simpler implementation; no automatic task reopening.
     * *Cons:* Downstream tasks that already completed using the flawed gist remain marked `done`.
* **Decision & Rationale:** **Propagate `contested` Downstream** (`insertGist` in `src/store.ts`). Correctness of the *Shared Verified Context* outweighs avoiding occasional re-evaluation.

---

## 3. HITL Approval Mechanism for MVP: Interactive Terminal Prompt vs. SQLite `approvals` Queue

* **Options Considered:**
  1. **Interactive Terminal Prompt (`[y/N/reason]`):**
     * *Pros:* Minimal implementation (~20 lines), zero extra CLI subcommands, immediate feedback during interactive runs.
     * *Cons:* Requires human presence at the terminal; unsuitable for unattended background daemons.
  2. **SQLite `approvals` Table + `approve` / `reject` Subcommands:**
     * *Pros:* Supports headless/daemon runs and persistent approval audit logs.
     * *Cons:* Adds schema, CLI subcommands, and async DB polling/waiting complexity.
* **Decision & Rationale:** **Interactive Terminal Prompt for MVP** (`defaultTerminalApprovalHandler` in `src/mcp.ts`). Keeps the MVP minimal; SQLite `approvals` remains a clean post-MVP extension for daemon mode.

---

## 4. Swarm Backend Homogeneity: Single `--backend` per Run vs. Hybrid Swarm

* **Options Considered:**
  1. **Single `--backend embedded|cli` per Run:**
     * *Pros:* Simple CLI surface, predictable billing/auth behavior, zero mixed-worker configuration overhead.
     * *Cons:* Cannot mix `embedded` and `cli` workers within the same invocation without an explicit config file.
  2. **Hybrid Swarm (`embedded` + `cli` mixed in one run):**
     * *Pros:* Maximum flexibility across API keys and CLI subscriptions.
     * *Cons:* Complicates CLI flags and worker scheduling configuration in the MVP.
* **Decision & Rationale:** **Single `--backend` per Run** (`parseSwarmCliArgs` in `src/index.ts`). Simplest UX for the MVP; the underlying `BoardStore` + `BoardMcpServer` architecture remains compatible with hybrid workers later.

---

## 5. Automated E2E Validation Strategy: Mocked Local MCPs vs. Live External Credentials

* **Options Considered:**
  1. **Mocked Local MCPs in Automated Suite (`tests/e2e.test.ts`):**
     * *Pros:* Deterministic, fast, zero external API keys or network dependencies in CI/local test runs; validates all 3 general-purpose E2E scenarios (`Research Matrix`, `Triage + HITL`, `Doc Audit + Contested Propagation`).
     * *Cons:* Does not exercise real third-party network payloads (which remain covered by manual runs with `mcp.config.json`).
  2. **Live External MCPs in Automated Suite:**
     * *Pros:* Tests real third-party APIs directly.
     * *Cons:* Flaky, slow, and requires live Slack/Linear/Sentry/OpenAI secrets to run `bun test`.
* **Decision & Rationale:** **Mocked Local MCPs for Automated E2E Suite** (`tests/e2e.test.ts`), complemented by manual runs against `mcp.config.json`.
