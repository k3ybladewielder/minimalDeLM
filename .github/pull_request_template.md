## What Changed
<!-- Describe the concrete changes made in this PR (files, modules, behaviors). -->

## Why It Changed
<!-- Explain the motivation, problem solved, or ADR/issue driving this change. -->

## Results
<!-- Summarize observable outcomes, metrics, or before/after behavior. -->

## Tests Performed
<!-- Every PR MUST run the local quality and security skills before merge. -->

### Mandatory Skills Checklist
- [ ] Applied **`/quality-testing`** (`.agents/skills/quality-test/SKILL.md`):
  - [ ] `./.bun/bin/bun x tsc --noEmit` (0 errors)
  - [ ] `./.bun/bin/bun test` (unit, E2E, property-based `fast-check`, and formal verification `@ts-model-checker/core` all passing)
- [ ] Applied **`/security-audit`** (`.agents/skills/security-audit/SKILL.md`):
  - [ ] Verified *default-deny* MCP policy, HITL gating on side-effect tools, CLI process isolation, and no leaked secrets

### Additional Verification Notes
<!-- Paste relevant command outputs or test results here. -->
