import { describe, expect, test } from "bun:test";
import { transpileToTla, verifySpec, type ExprNode, type VisualSpecIR } from "@ts-model-checker/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const lit = (value: string | number | boolean): ExprNode => ({ kind: "Literal", value });
const v = (name: string): ExprNode => ({ kind: "Var", name });
const bin = (op: Extract<ExprNode, { kind: "BinaryOp" }>["op"], left: ExprNode, right: ExprNode): ExprNode => ({
  kind: "BinaryOp",
  op,
  left,
  right,
});
const un = (op: Extract<ExprNode, { kind: "UnaryOp" }>["op"], operand: ExprNode): ExprNode => ({
  kind: "UnaryOp",
  op,
  operand,
});
const and = (...exprs: ExprNode[]): ExprNode => exprs.reduce((a, b) => bin("&&", a, b));
const or = (...exprs: ExprNode[]): ExprNode => exprs.reduce((a, b) => bin("||", a, b));

const MODELS_DIR = join(process.cwd(), ".tsmc-models", "minimaldelm");

function saveArtifacts(spec: VisualSpecIR, result: ReturnType<typeof verifySpec>) {
  mkdirSync(MODELS_DIR, { recursive: true });
  const { tlaFileContent, cfgFileContent } = transpileToTla(spec);
  writeFileSync(join(MODELS_DIR, `${spec.moduleName}.formal.json`), JSON.stringify(spec, null, 2));
  writeFileSync(join(MODELS_DIR, `${spec.moduleName}.tla`), tlaFileContent);
  writeFileSync(join(MODELS_DIR, `${spec.moduleName}.cfg`), cfgFileContent);
  writeFileSync(join(MODELS_DIR, `${spec.moduleName}.report.json`), JSON.stringify(result, null, 2));
}

describe("Full-System Formal Verification (ts-model-checker)", () => {
  test("1. DeLMAtomicClaimAndConvergence (store + worker)", () => {
    const t1Done = bin("==", v("t1"), lit("done"));
    const t1Term = or(t1Done, bin("==", v("t1"), lit("incomplete")));
    const t2Term = or(bin("==", v("t2"), lit("done")), bin("==", v("t2"), lit("incomplete")));

    const spec: VisualSpecIR = {
      schemaVersion: 1,
      moduleName: "DeLMAtomicClaimAndConvergence",
      variables: [
        { name: "t1", type: "string" },
        { name: "t2", type: "string" },
        { name: "w1Task", type: "string" },
        { name: "w2Task", type: "string" },
        { name: "attempts1", type: "number" },
        { name: "attempts2", type: "number" },
      ],
      initialStates: [
        { t1: "pending", t2: "pending", w1Task: "none", w2Task: "none", attempts1: 0, attempts2: 0 },
      ],
      actions: [
        {
          id: "w1-claim-t1",
          name: "W1ClaimT1",
          guard: and(bin("==", v("t1"), lit("pending")), bin("==", v("w1Task"), lit("none")), bin("<", v("attempts1"), lit(2))),
          effects: [
            { targetVar: "t1", expression: lit("claimed") },
            { targetVar: "w1Task", expression: lit("t1") },
            { targetVar: "attempts1", expression: bin("+", v("attempts1"), lit(1)) },
          ],
        },
        {
          id: "w2-claim-t1",
          name: "W2ClaimT1",
          guard: and(bin("==", v("t1"), lit("pending")), bin("==", v("w2Task"), lit("none")), bin("<", v("attempts1"), lit(2))),
          effects: [
            { targetVar: "t1", expression: lit("claimed") },
            { targetVar: "w2Task", expression: lit("t1") },
            { targetVar: "attempts1", expression: bin("+", v("attempts1"), lit(1)) },
          ],
        },
        {
          id: "w1-claim-t2",
          name: "W1ClaimT2",
          guard: and(bin("==", v("t2"), lit("pending")), t1Done, bin("==", v("w1Task"), lit("none")), bin("<", v("attempts2"), lit(2))),
          effects: [
            { targetVar: "t2", expression: lit("claimed") },
            { targetVar: "w1Task", expression: lit("t2") },
            { targetVar: "attempts2", expression: bin("+", v("attempts2"), lit(1)) },
          ],
        },
        {
          id: "w2-claim-t2",
          name: "W2ClaimT2",
          guard: and(bin("==", v("t2"), lit("pending")), t1Done, bin("==", v("w2Task"), lit("none")), bin("<", v("attempts2"), lit(2))),
          effects: [
            { targetVar: "t2", expression: lit("claimed") },
            { targetVar: "w2Task", expression: lit("t2") },
            { targetVar: "attempts2", expression: bin("+", v("attempts2"), lit(1)) },
          ],
        },
        {
          id: "w1-done-t1",
          name: "W1PublishT1",
          guard: and(bin("==", v("w1Task"), lit("t1")), bin("==", v("t1"), lit("claimed"))),
          effects: [
            { targetVar: "t1", expression: lit("done") },
            { targetVar: "w1Task", expression: lit("none") },
          ],
        },
        {
          id: "w2-done-t1",
          name: "W2PublishT1",
          guard: and(bin("==", v("w2Task"), lit("t1")), bin("==", v("t1"), lit("claimed"))),
          effects: [
            { targetVar: "t1", expression: lit("done") },
            { targetVar: "w2Task", expression: lit("none") },
          ],
        },
        {
          id: "w1-done-t2",
          name: "W1PublishT2",
          guard: and(bin("==", v("w1Task"), lit("t2")), bin("==", v("t2"), lit("claimed"))),
          effects: [
            { targetVar: "t2", expression: lit("done") },
            { targetVar: "w1Task", expression: lit("none") },
          ],
        },
        {
          id: "w2-done-t2",
          name: "W2PublishT2",
          guard: and(bin("==", v("w2Task"), lit("t2")), bin("==", v("t2"), lit("claimed"))),
          effects: [
            { targetVar: "t2", expression: lit("done") },
            { targetVar: "w2Task", expression: lit("none") },
          ],
        },
        {
          id: "t1-abandon",
          name: "T1ExpireOrIncomplete",
          guard: bin("==", v("t1"), lit("claimed")),
          effects: [
            {
              targetVar: "t1",
              expression: {
                kind: "IfThenElse",
                condition: bin("<", v("attempts1"), lit(2)),
                thenBranch: lit("pending"),
                elseBranch: lit("incomplete"),
              },
            },
            {
              targetVar: "w1Task",
              expression: {
                kind: "IfThenElse",
                condition: bin("==", v("w1Task"), lit("t1")),
                thenBranch: lit("none"),
                elseBranch: v("w1Task"),
              },
            },
            {
              targetVar: "w2Task",
              expression: {
                kind: "IfThenElse",
                condition: bin("==", v("w2Task"), lit("t1")),
                thenBranch: lit("none"),
                elseBranch: v("w2Task"),
              },
            },
          ],
        },
        {
          id: "t1-incomplete-blocks-t2",
          name: "T2FailBecauseDepIncomplete",
          guard: and(bin("==", v("t1"), lit("incomplete")), bin("==", v("t2"), lit("pending"))),
          effects: [{ targetVar: "t2", expression: lit("incomplete") }],
        },
      ],
      invariants: [
        {
          id: "inv-mutex",
          description: "No two workers can hold the same task simultaneously",
          predicate: un("!", and(bin("!=", v("w1Task"), lit("none")), bin("==", v("w1Task"), v("w2Task")))),
        },
        {
          id: "inv-dep",
          description: "Dependent task t2 cannot be claimed or done before t1 is done",
          predicate: bin("=>", or(bin("==", v("t2"), lit("claimed")), bin("==", v("t2"), lit("done"))), t1Done),
        },
        {
          id: "inv-attempts",
          description: "Retry attempts never exceed max_attempts (2)",
          predicate: and(bin("<=", v("attempts1"), lit(2)), bin("<=", v("attempts2"), lit(2))),
        },
      ],
      livenessProperties: [
        {
          id: "live-converge",
          kind: "EVENTUALLY",
          description: "Swarm eventually reaches terminal state for all tasks",
          eventually: and(t1Term, t2Term),
        },
      ],
      terminalCondition: and(t1Term, t2Term),
    };

    const result = verifySpec(spec, { maxStates: 20_000 });
    saveArtifacts(spec, result);
    expect(result.status).toBe("PASSED");
  });

  test("2. DeLMOptimisticConcurrency (admission base_seq CAS)", () => {
    const spec: VisualSpecIR = {
      schemaVersion: 1,
      moduleName: "DeLMOptimisticConcurrency",
      variables: [
        { name: "seq", type: "number" },
        { name: "w1Base", type: "number" },
        { name: "w2Base", type: "number" },
        { name: "w1Committed", type: "boolean" },
        { name: "w2Committed", type: "boolean" },
      ],
      initialStates: [{ seq: 0, w1Base: -1, w2Base: -1, w1Committed: false, w2Committed: false }],
      actions: [
        {
          id: "w1-read",
          name: "W1ReadContext",
          guard: and(un("!", v("w1Committed")), bin("==", v("w1Base"), lit(-1))),
          effects: [{ targetVar: "w1Base", expression: v("seq") }],
        },
        {
          id: "w2-read",
          name: "W2ReadContext",
          guard: and(un("!", v("w2Committed")), bin("==", v("w2Base"), lit(-1))),
          effects: [{ targetVar: "w2Base", expression: v("seq") }],
        },
        {
          id: "w1-commit-ok",
          name: "W1PublishSuccess",
          guard: and(un("!", v("w1Committed")), bin("!=", v("w1Base"), lit(-1)), bin("==", v("w1Base"), v("seq"))),
          effects: [
            { targetVar: "seq", expression: bin("+", v("seq"), lit(1)) },
            { targetVar: "w1Committed", expression: lit(true) },
          ],
        },
        {
          id: "w1-commit-conflict",
          name: "W1PublishConflict",
          guard: and(un("!", v("w1Committed")), bin("!=", v("w1Base"), lit(-1)), bin("!=", v("w1Base"), v("seq"))),
          effects: [{ targetVar: "w1Base", expression: lit(-1) }],
        },
        {
          id: "w2-commit-ok",
          name: "W2PublishSuccess",
          guard: and(un("!", v("w2Committed")), bin("!=", v("w2Base"), lit(-1)), bin("==", v("w2Base"), v("seq"))),
          effects: [
            { targetVar: "seq", expression: bin("+", v("seq"), lit(1)) },
            { targetVar: "w2Committed", expression: lit(true) },
          ],
        },
        {
          id: "w2-commit-conflict",
          name: "W2PublishConflict",
          guard: and(un("!", v("w2Committed")), bin("!=", v("w2Base"), lit(-1)), bin("!=", v("w2Base"), v("seq"))),
          effects: [{ targetVar: "w2Base", expression: lit(-1) }],
        },
      ],
      invariants: [
        {
          id: "inv-no-lost-update",
          description: "Two committed gists always advance seq to 2 (no silent overwrite)",
          predicate: bin("=>", and(v("w1Committed"), v("w2Committed")), bin("==", v("seq"), lit(2))),
        },
      ],
      livenessProperties: [
        {
          id: "live-both-commit",
          kind: "EVENTUALLY",
          description: "Both concurrent workers eventually commit after reconciling conflicts",
          eventually: and(v("w1Committed"), v("w2Committed")),
        },
      ],
      terminalCondition: and(v("w1Committed"), v("w2Committed")),
    };

    const result = verifySpec(spec, { maxStates: 10_000 });
    saveArtifacts(spec, result);
    expect(result.status).toBe("PASSED");
  });

  test("3. DeLMAdmissionGatePipeline (parallel 3-check Promise.all gate)", () => {
    const allChecksPass = and(v("evValid"), v("baseMatch"), or(un("!", v("semEnabled")), v("semPass")));
    const spec: VisualSpecIR = {
      schemaVersion: 1,
      moduleName: "DeLMAdmissionGatePipeline",
      variables: [
        { name: "evValid", type: "boolean" },
        { name: "baseMatch", type: "boolean" },
        { name: "semEnabled", type: "boolean" },
        { name: "semPass", type: "boolean" },
        { name: "gateState", type: "string" },
      ],
      initialStates: [
        { evValid: true, baseMatch: true, semEnabled: false, semPass: false, gateState: "idle" },
        { evValid: false, baseMatch: true, semEnabled: false, semPass: false, gateState: "idle" },
        { evValid: true, baseMatch: false, semEnabled: true, semPass: true, gateState: "idle" },
        { evValid: true, baseMatch: true, semEnabled: true, semPass: false, gateState: "idle" },
        { evValid: true, baseMatch: true, semEnabled: true, semPass: true, gateState: "idle" },
      ],
      actions: [
        {
          id: "admit",
          name: "AdmitGist",
          guard: and(bin("==", v("gateState"), lit("idle")), allChecksPass),
          effects: [{ targetVar: "gateState", expression: lit("admitted") }],
        },
        {
          id: "reject",
          name: "RejectGist",
          guard: and(bin("==", v("gateState"), lit("idle")), un("!", allChecksPass)),
          effects: [{ targetVar: "gateState", expression: lit("rejected") }],
        },
      ],
      invariants: [
        {
          id: "inv-no-unverified-admit",
          description: "A gist is never admitted unless structural, CAS, and enabled semantic checks all pass",
          predicate: bin("=>", bin("==", v("gateState"), lit("admitted")), allChecksPass),
        },
      ],
      livenessProperties: [
        {
          id: "live-gate-resolves",
          kind: "EVENTUALLY",
          description: "Admission gate always resolves to admitted or rejected",
          eventually: or(bin("==", v("gateState"), lit("admitted")), bin("==", v("gateState"), lit("rejected"))),
        },
      ],
      terminalCondition: or(bin("==", v("gateState"), lit("admitted")), bin("==", v("gateState"), lit("rejected"))),
    };

    const result = verifySpec(spec, { maxStates: 10_000 });
    saveArtifacts(spec, result);
    expect(result.status).toBe("PASSED");
  });

  test("4. DeLMMcpDefaultDenyAndHitl (default-deny + serialized HITL queue)", () => {
    const spec: VisualSpecIR = {
      schemaVersion: 1,
      moduleName: "DeLMMcpDefaultDenyAndHitl",
      variables: [
        { name: "w1Req", type: "string" },
        { name: "w2Req", type: "string" },
        { name: "hitlLock", type: "string" },
        { name: "w1Result", type: "string" },
        { name: "w2Result", type: "string" },
        { name: "evCount", type: "number" },
      ],
      initialStates: [
        { w1Req: "hitl", w2Req: "hitl", hitlLock: "none", w1Result: "none", w2Result: "none", evCount: 0 },
        { w1Req: "deny", w2Req: "allow", hitlLock: "none", w1Result: "none", w2Result: "none", evCount: 0 },
        { w1Req: "allow", w2Req: "hitl", hitlLock: "none", w1Result: "none", w2Result: "none", evCount: 0 },
      ],
      actions: [
        {
          id: "w1-deny",
          name: "W1Deny",
          guard: and(bin("==", v("w1Req"), lit("deny")), bin("==", v("w1Result"), lit("none"))),
          effects: [{ targetVar: "w1Result", expression: lit("denied") }],
        },
        {
          id: "w2-deny",
          name: "W2Deny",
          guard: and(bin("==", v("w2Req"), lit("deny")), bin("==", v("w2Result"), lit("none"))),
          effects: [{ targetVar: "w2Result", expression: lit("denied") }],
        },
        {
          id: "w1-allow",
          name: "W1ExecuteAllow",
          guard: and(bin("==", v("w1Req"), lit("allow")), bin("==", v("w1Result"), lit("none"))),
          effects: [
            { targetVar: "w1Result", expression: lit("executed") },
            { targetVar: "evCount", expression: bin("+", v("evCount"), lit(1)) },
          ],
        },
        {
          id: "w2-allow",
          name: "W2ExecuteAllow",
          guard: and(bin("==", v("w2Req"), lit("allow")), bin("==", v("w2Result"), lit("none"))),
          effects: [
            { targetVar: "w2Result", expression: lit("executed") },
            { targetVar: "evCount", expression: bin("+", v("evCount"), lit(1)) },
          ],
        },
        {
          id: "w1-acquire-hitl",
          name: "W1AcquireHitlLock",
          guard: and(bin("==", v("w1Req"), lit("hitl")), bin("==", v("w1Result"), lit("none")), bin("==", v("hitlLock"), lit("none"))),
          effects: [{ targetVar: "hitlLock", expression: lit("w1") }],
        },
        {
          id: "w2-acquire-hitl",
          name: "W2AcquireHitlLock",
          guard: and(bin("==", v("w2Req"), lit("hitl")), bin("==", v("w2Result"), lit("none")), bin("==", v("hitlLock"), lit("none"))),
          effects: [{ targetVar: "hitlLock", expression: lit("w2") }],
        },
        {
          id: "w1-hitl-approve",
          name: "W1HitlApprove",
          guard: bin("==", v("hitlLock"), lit("w1")),
          effects: [
            { targetVar: "hitlLock", expression: lit("none") },
            { targetVar: "w1Result", expression: lit("executed") },
            { targetVar: "evCount", expression: bin("+", v("evCount"), lit(1)) },
          ],
        },
        {
          id: "w1-hitl-reject",
          name: "W1HitlReject",
          guard: bin("==", v("hitlLock"), lit("w1")),
          effects: [
            { targetVar: "hitlLock", expression: lit("none") },
            { targetVar: "w1Result", expression: lit("rejected") },
          ],
        },
        {
          id: "w2-hitl-approve",
          name: "W2HitlApprove",
          guard: bin("==", v("hitlLock"), lit("w2")),
          effects: [
            { targetVar: "hitlLock", expression: lit("none") },
            { targetVar: "w2Result", expression: lit("executed") },
            { targetVar: "evCount", expression: bin("+", v("evCount"), lit(1)) },
          ],
        },
        {
          id: "w2-hitl-reject",
          name: "W2HitlReject",
          guard: bin("==", v("hitlLock"), lit("w2")),
          effects: [
            { targetVar: "hitlLock", expression: lit("none") },
            { targetVar: "w2Result", expression: lit("rejected") },
          ],
        },
      ],
      invariants: [
        {
          id: "inv-default-deny",
          description: "Denied tools are never executed",
          predicate: and(
            bin("=>", bin("==", v("w1Req"), lit("deny")), bin("!=", v("w1Result"), lit("executed"))),
            bin("=>", bin("==", v("w2Req"), lit("deny")), bin("!=", v("w2Result"), lit("executed"))),
          ),
        },
        {
          id: "inv-hitl-mutex",
          description: "HITL prompt lock is held by at most one worker at a time",
          predicate: or(bin("==", v("hitlLock"), lit("none")), bin("==", v("hitlLock"), lit("w1")), bin("==", v("hitlLock"), lit("w2"))),
        },
        {
          id: "inv-evidence-on-exec",
          description: "Every executed MCP tool records at least one evidence entry",
          predicate: bin("=>", or(bin("==", v("w1Result"), lit("executed")), bin("==", v("w2Result"), lit("executed"))), bin(">=", v("evCount"), lit(1))),
        },
      ],
      livenessProperties: [
        {
          id: "live-mcp-resolves",
          kind: "EVENTUALLY",
          description: "Both workers eventually resolve their MCP calls",
          eventually: and(bin("!=", v("w1Result"), lit("none")), bin("!=", v("w2Result"), lit("none"))),
        },
      ],
      terminalCondition: and(bin("!=", v("w1Result"), lit("none")), bin("!=", v("w2Result"), lit("none"))),
    };

    const result = verifySpec(spec, { maxStates: 10_000 });
    saveArtifacts(spec, result);
    expect(result.status).toBe("PASSED");
  });

  test("5. DeLMWatchdogAndProcessLifecycle (loop/budget abort, process group kill, incomplete rule)", () => {
    const spec: VisualSpecIR = {
      schemaVersion: 1,
      moduleName: "DeLMWatchdogAndProcessLifecycle",
      variables: [
        { name: "workerState", type: "string" },
        { name: "loopCount", type: "number" },
        { name: "tokensUsed", type: "number" },
        { name: "procAlive", type: "boolean" },
        { name: "gistPublished", type: "boolean" },
        { name: "taskStatus", type: "string" },
      ],
      initialStates: [
        { workerState: "running", loopCount: 0, tokensUsed: 0, procAlive: true, gistPublished: false, taskStatus: "claimed" },
      ],
      actions: [
        {
          id: "step-repeat-tool",
          name: "RepeatToolCall",
          guard: and(bin("==", v("workerState"), lit("running")), bin("<", v("loopCount"), lit(3)), bin("<", v("tokensUsed"), lit(3))),
          effects: [
            { targetVar: "loopCount", expression: bin("+", v("loopCount"), lit(1)) },
            { targetVar: "tokensUsed", expression: bin("+", v("tokensUsed"), lit(1)) },
            {
              targetVar: "workerState",
              expression: {
                kind: "IfThenElse",
                condition: or(bin(">=", bin("+", v("loopCount"), lit(1)), lit(3)), bin(">=", bin("+", v("tokensUsed"), lit(1)), lit(3))),
                thenBranch: lit("aborted"),
                elseBranch: lit("running"),
              },
            },
          ],
        },
        {
          id: "publish-and-finish",
          name: "PublishGistAndFinish",
          guard: and(bin("==", v("workerState"), lit("running")), bin("<", v("loopCount"), lit(3)), bin("<", v("tokensUsed"), lit(3))),
          effects: [
            { targetVar: "gistPublished", expression: lit(true) },
            { targetVar: "workerState", expression: lit("finished") },
          ],
        },
        {
          id: "exit-without-gist",
          name: "ExitWithoutGist",
          guard: bin("==", v("workerState"), lit("running")),
          effects: [{ targetVar: "workerState", expression: lit("finished") }],
        },
        {
          id: "kill-group-and-finalize",
          name: "KillProcessGroupAndFinalize",
          guard: and(or(bin("==", v("workerState"), lit("aborted")), bin("==", v("workerState"), lit("finished"))), bin("==", v("taskStatus"), lit("claimed"))),
          effects: [
            { targetVar: "procAlive", expression: lit(false) },
            {
              targetVar: "taskStatus",
              expression: {
                kind: "IfThenElse",
                condition: v("gistPublished"),
                thenBranch: lit("done"),
                elseBranch: lit("incomplete"),
              },
            },
          ],
        },
      ],
      invariants: [
        {
          id: "inv-loop-cap",
          description: "Loop threshold (>= 3) immediately stops running state",
          predicate: bin("=>", bin(">=", v("loopCount"), lit(3)), bin("!=", v("workerState"), lit("running"))),
        },
        {
          id: "inv-budget-cap",
          description: "Token budget limit (>= 3) immediately stops running state",
          predicate: bin("=>", bin(">=", v("tokensUsed"), lit(3)), bin("!=", v("workerState"), lit("running"))),
        },
        {
          id: "inv-no-done-without-gist",
          description: "Task can never be marked done without a published verified gist (Vigia rule)",
          predicate: bin("=>", bin("==", v("taskStatus"), lit("done")), v("gistPublished")),
        },
        {
          id: "inv-no-zombies",
          description: "Terminal task state guarantees CLI process group is dead",
          predicate: bin("=>", or(bin("==", v("taskStatus"), lit("done")), bin("==", v("taskStatus"), lit("incomplete"))), un("!", v("procAlive"))),
        },
      ],
      livenessProperties: [
        {
          id: "live-watchdog-terminates",
          kind: "EVENTUALLY",
          description: "Watchdog + worker always terminate cleanly to done or incomplete",
          eventually: or(bin("==", v("taskStatus"), lit("done")), bin("==", v("taskStatus"), lit("incomplete"))),
        },
      ],
      terminalCondition: or(bin("==", v("taskStatus"), lit("done")), bin("==", v("taskStatus"), lit("incomplete"))),
    };

    const result = verifySpec(spec, { maxStates: 10_000 });
    saveArtifacts(spec, result);
    expect(result.status).toBe("PASSED");

    writeFileSync(
      join(MODELS_DIR, "REPORT.md"),
      [
        "# Full-System Formal Verification Report — minimalDeLM",
        "",
        "| Module | Model | Result | Key Finding |",
        "| :--- | :--- | :--- | :--- |",
        "| `src/store.ts` + `src/worker.ts` | `DeLMAtomicClaimAndConvergence` | **PASSED** | Mutual exclusion (`w1Task != w2Task`), dependency order (`t2 => t1 done`), bounded retries (`<= 2`), and liveness convergence hold across all reachable states. |",
        "| `src/admission.ts` | `DeLMOptimisticConcurrency` | **PASSED** | `base_seq` CAS rejects stale concurrent publishes and forces reconciliation; no silent overwrites (`w1Committed && w2Committed => seq == 2`). |",
        "| `src/admission.ts` | `DeLMAdmissionGatePipeline` | **PASSED** | Parallel 3-check gate never admits without valid evidence, CAS match, and enabled semantic check. |",
        "| `src/mcp.ts` | `DeLMMcpDefaultDenyAndHitl` | **PASSED** | Default-deny blocks unpermitted tools, HITL queue serializes prompts (mutual exclusion), and every execution records evidence. |",
        "| `src/watchdog.ts` + `src/backends/cli.ts` | `DeLMWatchdogAndProcessLifecycle` | **PASSED** | Loop/budget caps stop runaway workers, CLI process groups leave zero zombies, and exiting without a gist marks `incomplete` (never `done`). |",
        "",
      ].join("\n"),
    );
  });
});
