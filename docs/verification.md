# Verification & Formal Model Checking

`minimalDeLM` combines static typechecking, unit/integration tests, E2E scenarios, property-based testing, and formal model checking.

---

## Automated Checks

```bash
# TypeScript static typecheck
./.bun/bin/bun x tsc --noEmit

# Full test suite (unit, E2E, property-based, formal verification)
./.bun/bin/bun test
```

* **TypeScript (`tsc --noEmit`):** 0 errors
* **Test Suite (`bun test`):** 21/21 passing (1,210 assertions across 5 files)

---

## Test & Verification Layers

1. **Unit & Integration (`tests/store-admission.test.ts`, `tests/mcp-watchdog-worker.test.ts`):**
   * Atomic `claimTask()` with LPT (`weight DESC`) and `depends_on` ordering.
   * `AdmissionGate` structural checks and `base_seq` optimistic concurrency conflicts.
   * `McpGateway` default-deny policy and lazy server connection against `mcp.config.json`.
   * `TaskWatchdog` loop detection and `incomplete` state enforcement.
   * `CliBackend` isolated command generation (`pi`, `claude`, `codex`) and `--nagents 3` CLI parsing.

2. **General-Purpose E2E Scenarios (`tests/e2e.test.ts`):**
   * **E2E 1:** Verifiable Research & Comparative Matrix with 3 parallel role-free agents.
   * **E2E 2:** Log/Ticket Triage + HITL rejection, adjustment, and approval flow.
   * **E2E 3:** Documentation Audit with paginated `unfold_evidence` and `contested` downstream propagation.
   * **Local Board MCP Server:** Bearer auth enforcement and HTTP/StreamableHTTP MCP initialization.

3. **Property-Based Testing (`tests/properties.test.ts` with `fast-check`):**
   * Task conservation, LPT weight ordering, and single active claim across random DAGs.
   * Strict default-deny enforcement across arbitrary tool names and policies.
   * Monotonic `seq` and stale `base_seq` conflict rejection.

4. **Formal Verification (`tests/formal-verification.test.ts` with `@ts-model-checker/core`):**
   Five TLA+-style state-space models verified (`PASSED`) for Safety (`□P`) and Liveness (`◇P`):
   * `DeLMAtomicClaimAndConvergence`
   * `DeLMOptimisticConcurrency`
   * `DeLMAdmissionGatePipeline`
   * `DeLMMcpDefaultDenyAndHitl`
   * `DeLMWatchdogAndProcessLifecycle`
