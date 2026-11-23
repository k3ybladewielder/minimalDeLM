# ADR-003: Default-Deny MCP Policy and Serialized HITL

* **Status:** Accepted
* **Date:** 2026-11-23

## Context
In a general-purpose swarm, agents interact with external systems (Slack, Linear, databases, email, web). Exposing all MCP tools by default risks unintended real-world side effects, and allowing parallel workers to prompt `stdin` simultaneously would corrupt interactive approvals.

## Decision
1. **Default-Deny (`src/mcp.ts`):** Zero MCP tools are permitted by default. Users must explicitly list tools in `mcp.config.json` under `policy.allow` (auto-execute) or `policy.hitl` (human approval required). Unlisted tools are hidden from the LLM and blocked at runtime.
2. **Singleton Gateway:** MCP servers connect once per host process and are shared across all workers.
3. **Serialized HITL Queue:** Calls to `hitl` tools enter a single promise chain (`enqueueApproval`) pausing **only** the requesting worker while other workers continue processing the DeLM queue.
4. **Streaming CLI UX:** Instead of a full-screen TUI, `minimalDeLM` uses a simple streaming CLI with inline `[y/N/reason]` HITL prompts.

## Consequences
* **Positive:** Safe by default, zero `stdin` race conditions, and minimal UI complexity.
* **Negative:** Users must explicitly curate `mcp.config.json` before external tools become available to the swarm.
