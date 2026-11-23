import { describe, expect, test } from "bun:test";
import { AdmissionGate } from "../src/admission.ts";
import { BoardStore } from "../src/store.ts";

describe("BoardStore + AdmissionGate", () => {
  test("claims tasks in LPT order (weight DESC) and respects depends_on", () => {
    const store = new BoardStore(":memory:");
    const root = store.createRootTask("Compare 4 vector DBs");
    const first = store.claimTask("w-1", 10_000);
    expect(first?.task.id).toBe(root.id);

    const [tLight, tHeavy, tSynth] = store.spawnTasks(root.id, [
      { id: "t-light", goal: "Light task", weight: 1 },
      { id: "t-heavy", goal: "Heavy task", weight: 3 },
      { id: "t-synth", goal: "Synthesize", weight: 2, depends_on: ["t-light", "t-heavy"] },
    ]);
    expect(tLight.weight).toBe(1);
    expect(tHeavy.weight).toBe(3);
    expect(tSynth.status).toBe("pending");

    const c1 = store.claimTask("w-2", 10_000);
    expect(c1?.task.id).toBe("t-heavy"); // LPT: heavy comes first

    const c2 = store.claimTask("w-3", 10_000);
    expect(c2?.task.id).toBe("t-light");

    // t-synth is blocked until dependencies are done
    const c3 = store.claimTask("w-4", 10_000);
    expect(c3).toBeNull();

    store.markTaskStatus("t-heavy", "done");
    expect(store.claimTask("w-4", 10_000)).toBeNull();

    store.markTaskStatus("t-light", "done");
    const c4 = store.claimTask("w-4", 10_000);
    expect(c4?.task.id).toBe("t-synth");
    store.close();
  });

  test("AdmissionGate enforces evidence_ids and rejects stale base_seq conflicts", async () => {
    const store = new BoardStore(":memory:");
    const gate = new AdmissionGate(store, { verifySemantic: false });

    const root = store.createRootTask("Audit docs");
    store.claimTask("w-1", 10_000);
    const [sub1, sub2] = store.spawnTasks(root.id, [
      { id: "s1", goal: "Check doc A" },
      { id: "s2", goal: "Check doc B", depends_on: ["s1"] },
    ]);
    store.claimTask("w-1", 10_000);

    // 1. Structural failure: no evidence_ids
    const noEv = await gate.evaluate({
      taskId: sub1.id,
      workerId: "w-1",
      baseSeq: 0,
      summary: "Doc A is outdated",
      evidenceIds: [],
    });
    expect(noEv.admitted).toBe(false);

    // 2. Valid admission on s1
    const ev1 = store.recordEvidence(sub1.id, "w-1", "mcp.read_doc", { doc: "A" }, "v1 deprecated");
    const ok1 = await gate.evaluate({
      taskId: sub1.id,
      workerId: "w-1",
      baseSeq: 0,
      summary: "Doc A references deprecated v1 API.",
      evidenceIds: [ev1.id],
      markDone: true,
    });
    expect(ok1.admitted).toBe(true);

    // 3. Stale baseSeq=0 on dependent task s2 from w-2 triggers conflictDelta
    store.claimTask("w-2", 10_000);
    const ev2 = store.recordEvidence(sub2.id, "w-2", "mcp.read_doc", { doc: "s2" }, "s2 notes");
    const conflict = await gate.evaluate({
      taskId: sub2.id,
      workerId: "w-2",
      baseSeq: 0,
      summary: "s2 audit complete",
      evidenceIds: [ev2.id],
    });
    expect(conflict.admitted).toBe(false);
    if (!conflict.admitted) {
      expect(conflict.conflictDelta?.length).toBe(1);
    }

    // 4. Reconciled with updated baseSeq succeeds
    const latest = store.getLatestSeq();
    const ok2 = await gate.evaluate({
      taskId: sub2.id,
      workerId: "w-2",
      baseSeq: latest,
      summary: "s2 audit reconciled with s1.",
      evidenceIds: [ev2.id],
      markDone: true,
    });
    expect(ok2.admitted).toBe(true);
    expect(store.getTask(sub2.id)?.status).toBe("done");
    store.close();
  });
});
