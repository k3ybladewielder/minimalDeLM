# ADR-004: Local Bun Runtime, `bun:sqlite`, and Formal Verification

* **Status:** Accepted
* **Date:** 2026-11-23

## Context
A concurrent multi-agent harness needs fast startup, atomic transactions for task claiming, zero native build friction, and high confidence that concurrent workers cannot double-claim tasks, lose updates, or leave zombie processes.

## Decision
1. **Local Bun + `bun:sqlite`:** Install Bun locally in `.bun/` (git-ignored) and store Board state (`tasks`, `evidence`, `gists`) in SQLite WAL mode with `BEGIN IMMEDIATE` transactions and LPT (`weight DESC`) scheduling.
2. **Vigia-Inspired Watchdog (`src/watchdog.ts`):** Enforce per-task timeouts, stall detection, loop detection (`loopThreshold = 3`), token caps, and the `incomplete` rule (exiting without `delm_publish_gist(..., mark_done=true)` never marks `done`).
3. **Property-Based & Formal Verification:** Validate invariants with `fast-check` (`tests/properties.test.ts`) and model-check all 5 concurrent subsystems with `@ts-model-checker/core` (`tests/formal-verification.test.ts`).

## Consequences
* **Positive:** Self-contained repository with sub-second test/typecheck feedback and mechanically verified concurrency safety and liveness properties.
* **Negative:** Requires Bun (provided locally in `.bun/`).
