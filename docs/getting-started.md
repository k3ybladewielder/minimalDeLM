# Getting Started & Usage

`minimalDeLM` is designed around **operational simplicity**: a single-command streaming CLI instead of a heavy TUI.

---

## Why Streaming CLI Instead of a TUI?

Following the principle of simplicity, `minimalDeLM` does **not** embed a full-screen terminal UI (`ncurses`/React TUI) in the core harness:
- **Zero UI state bugs** when $N$ workers run concurrently.
- **Scriptable & composable** in local shells, cron jobs, and CI pipelines.
- **Clean inline HITL**: when a worker triggers an external side-effect tool marked `hitl`, only that worker pauses while the terminal serializes a simple `[y/N/reason]` prompt—the remaining workers continue processing the DeLM queue uninterrupted.
- *(Future UIs or read-only dashboards can simply tail the SQLite database or structured stdout events without coupling to the core.)*

---

## Prerequisites

All dependencies (including **Bun** and **Pi**) are installed **locally** inside the repository:

```bash
# Optional: add local Bun to your current shell PATH so you can type `bun` directly
export PATH="$PWD/.bun/bin:$PATH"

# Local Bun runtime
bun --version

# Install JS/TS dependencies (already configured if cloned with bun.lock)
bun install
```

---

## Running a Swarm

Use the `./minimaldelm` wrapper script (no need to type `./.bun/bin/bun run src/index.ts`):

### 1. Embedded Mode (API Keys / Local Models)

Export `LLM_API_KEY` once (or use provider-specific env vars like `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` as fallbacks):

```bash
export LLM_API_KEY="your-key"

./minimaldelm "<goal>" \
  --nagents 3 \
  --provider openai \
  --model gpt-4o-mini
```

### 2. Authenticated CLI Mode (`--backend cli`)

If you prefer using an existing subscription/OAuth login instead of API keys:

```bash
# Authenticate the local Pi CLI (OAuth browser login or --no-browser)
./node_modules/.bin/pi auth login <provider>
./node_modules/.bin/pi auth check --provider <provider>

# Run minimalDeLM with the authenticated local Pi CLI
./minimaldelm "<goal>" --nagents 3 --backend cli --cli pi

# Or with Claude Code / Codex CLI already authenticated on your machine
./minimaldelm "<goal>" --nagents 3 --backend cli --cli claude
./minimaldelm "<goal>" --nagents 3 --backend cli --cli codex
```

`CliBackend` runs each subprocess in an isolated temporary directory (preserving your Pi `auth.json` read-only) so global CLI configs and sessions are never modified.

### CLI Options

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--nagents <N>` | `3` | Number of parallel role-free peer workers to spawn. |
| `--backend <type>` | `embedded` | Worker execution backend: `embedded` (Pi Core + API keys/Ollama) or `cli` (local `pi --mode rpc`, `claude -p`, `codex exec`). |
| `--provider <name>` | `openai` | LLM provider for `embedded` mode (e.g., `openai`, `anthropic`, `google`). |
| `--model <id>` | `gpt-4o-mini` | Model ID for `embedded` or `cli` mode. |
| `--cli <tool>` | `pi` | Target CLI binary when `--backend cli` (`pi`, `claude`, `codex`). |
| `--mcp <path>` | *(none)* | Path to `mcp.config.json` defining MCP servers and `allow`/`hitl` policies. |
| `--db <path>` | `minimaldelm.db` | SQLite database file for the DeLM Board. |
| `--verify-semantic` | `false` | Enable optional LLM-based semantic verification inside the Admission Gate. |

---

## Configuring MCP Tools (*Default-Deny*)

By default, **zero external MCP tools are permitted**. The repository ships with a default [`mcp.config.json`](../mcp.config.json) pre-configured with standard Tucano-inspired integrations (`github`, `gitlab`, `linear`, `jira`, `slack`, `notion`, `figma`, `sentry`, `datadog`), all **denied by default** (`allow: []`, `hitl: []`).

Unused servers are **not** spawned on startup. To enable specific tools, add them explicitly to `policy.allow` (auto-execute) or `policy.hitl` (human approval required):

```json
{
  "servers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"]
    }
  },
  "policy": {
    "allow": [
      "fetch.fetch",
      "slack.list_channels"
    ],
    "hitl": [
      "slack.post_message"
    ]
  }
}
```

* Tools in `allow` run automatically and record their output into `evidence`.
* Tools in `hitl` pause only the calling worker for human `[y/N/reason]` approval.
* Any other tool on the MCP server is **hidden from the LLM** and blocked at runtime.

---

## Running Tests, Typecheck & Formal Verification

```bash
# Unit, property-based (fast-check), and formal verification (ts-model-checker)
./.bun/bin/bun test

# TypeScript static typecheck
./.bun/bin/bun x tsc --noEmit
```
