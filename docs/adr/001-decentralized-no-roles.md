# ADR-001: Decentralized DeLM Swarm with Zero Roles

* **Status:** Accepted
* **Date:** 2026-11-23

## Context
Conventional multi-agent systems rely on a central orchestrator ("master agent" or `team-lead`) and specialized agent personas (*Planner*, *Coder*, *Reviewer*, *Security*). This introduces coordination bottlenecks, idle waiting rounds ("bubbles"), and domain coupling.

## Decision
We adopt the **DeLM** (*Decentralized Language Models*, arXiv:2606.10662) model:
1. **Zero central orchestrator:** All `--nagents` workers (default `3`) are homogeneous peers sharing the same minimal system prompt.
2. **Zero roles:** Specialization emerges dynamically from the task claimed from the SQLite queue (`tasks`) and the reachable *Shared Verified Context* (`gists`).
3. **Optimistic concurrency without auto-merge:** Inspired by `yuzhenmao/DeLM`'s `board/`, conflicting `publish_gist` calls with a stale `base_seq` are explicitly rejected with `conflictDelta` so the peer reconciles directly.

## Consequences
* **Positive:** Eliminates central bottlenecks, keeps prompts minimal, and generalizes beyond coding to any domain.
* **Negative:** Requires strict admission-time verification (`evidence_ids` + `base_seq`) and lease/watchdog safeguards so peer autonomy does not drift or loop.
