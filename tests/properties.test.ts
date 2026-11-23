import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AdmissionGate } from "../src/admission.ts";
import { McpGateway } from "../src/mcp.ts";
import { BoardStore } from "../src/store.ts";

describe("Property-Based Tests (fast-check)", () => {
  test("BoardStore preserves task conservation, LPT weight order, and single active claim", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            weight: fc.constantFrom(1 as const, 2 as const, 3 as const),
            hasDepOnPrev: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (specs) => {
          const store = new BoardStore(":memory:");
          const root = store.createRootTask("Root");
          store.claimTask("w-init", 10_000);
          store.markTaskStatus(root.id, "done");

          const ids: string[] = [];
          const subtasks = specs.map((s, idx) => {
            const id = `sub-${idx}`;
            const deps = s.hasDepOnPrev && idx > 0 ? [ids[idx - 1]!] : [];
            ids.push(id);
            return { id, goal: `Goal ${idx}`, weight: s.weight, depends_on: deps };
          });
          store.spawnTasks(root.id, subtasks);

          const claimedSet = new Set<string>();
          let safetyLimit = 50;
          while (store.hasPendingOrClaimed() && safetyLimit-- > 0) {
            // Check LPT invariant: next claimed task must have max weight among all currently claimable pending tasks
            const pendingRows = store.db
              .query("SELECT id, weight, depends_on FROM tasks WHERE status = 'pending'")
              .all() as { id: string; weight: number; depends_on: string }[];

            const claimableWeights = pendingRows
              .filter((r) => {
                const deps = JSON.parse(r.depends_on) as string[];
                return deps.every((d) => store.getTask(d)?.status === "done");
              })
              .map((r) => r.weight);

            const claimed = store.claimTask("w-1", 10_000);
            if (!claimed) break;

            expect(claimedSet.has(claimed.task.id)).toBe(false);
            claimedSet.add(claimed.task.id);

            if (claimableWeights.length > 0) {
              expect<number>(claimed.task.weight).toBe(Math.max(...claimableWeights));
            }

            // All dependencies must already be done
            for (const dep of claimed.task.depends_on) {
              expect(store.getTask(dep)?.status).toBe("done");
            }

            store.markTaskStatus(claimed.task.id, "done");
          }

          expect(claimedSet.size).toBe(specs.length);
          store.close();
        },
      ),
      { numRuns: 50 },
    );
  });

  test("McpGateway strictly enforces default-deny for arbitrary tool names", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 5 }),
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 5 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        async (allow, hitl, queryTool) => {
          const store = new BoardStore(":memory:");
          const root = store.createRootTask("Policy test");
          const gw = new McpGateway(
            { servers: {}, policy: { allow, hitl } },
            async () => ({ approved: true }),
          );

          const tier = gw.getTier(queryTool);
          if (allow.includes(queryTool)) {
            expect(tier).toBe("allow");
          } else if (hitl.includes(queryTool)) {
            expect(tier).toBe("hitl");
          } else {
            expect(tier).toBe("deny");
            const res = await gw.executeTool(store, "w-1", root.id, queryTool, {});
            expect(res.isError).toBe(true);
          }
          store.close();
        },
      ),
      { numRuns: 50 },
    );
  });

  test("AdmissionGate maintains strictly monotonic seq and rejects stale peer baseSeq", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (steps) => {
        const store = new BoardStore(":memory:");
        const gate = new AdmissionGate(store, { verifySemantic: false });
        const root = store.createRootTask("Monotonic seq");
        store.claimTask("w-1", 10_000);

        let prevSeq = 0;
        for (let i = 0; i < steps; i++) {
          const ev = store.recordEvidence(root.id, "w-1", "tool", { i }, `obs-${i}`);
          const res = await gate.evaluate({
            taskId: root.id,
            workerId: "w-1",
            baseSeq: prevSeq,
            summary: `Summary step ${i}`,
            evidenceIds: [ev.id],
          });
          expect(res.admitted).toBe(true);
          if (res.admitted) {
            expect(res.gist.seq).toBeGreaterThan(prevSeq);
            prevSeq = res.gist.seq;
          }
        }
        store.markTaskStatus(root.id, "done");

        // Another peer on a dependent task with stale baseSeq=0 must be rejected
        const [depTask] = store.spawnTasks(root.id, [{ goal: "Dependent", depends_on: [root.id] }]);
        store.claimTask("w-2", 10_000);
        const evPeer = store.recordEvidence(depTask.id, "w-2", "tool", {}, "peer-obs");
        const stale = await gate.evaluate({
          taskId: depTask.id,
          workerId: "w-2",
          baseSeq: 0,
          summary: "Stale summary from peer",
          evidenceIds: [evPeer.id],
        });
        expect(stale.admitted).toBe(false);
        if (!stale.admitted) {
          expect(stale.conflictDelta?.length).toBe(steps);
        }
        store.close();
      }),
      { numRuns: 25 },
    );
  });
});
