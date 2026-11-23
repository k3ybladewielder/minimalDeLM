import type { BoardStore } from "./store.ts";
import type { SwarmConfig, Task, WorkerBackend } from "./types.ts";
import { TaskWatchdog } from "./watchdog.ts";

export const DELM_SYSTEM_PROMPT = `You are a peer agent in a decentralized, role-free DeLM swarm.
Rules:
1. You have NO fixed role. Focus strictly on the task you claimed.
2. Start by calling delm_read_context to inspect reachable verified gists. Use delm_unfold_evidence if you need raw details.
3. If the task is broad or independent parts can run in parallel, decompose it using delm_spawn_tasks, then publish a gist explaining the split (mark_done=true) or wait/continue on the remaining work.
4. Every claim in delm_publish_gist MUST cite real evidence_ids from MCP tool outputs or delm_record_evidence.
5. Before calling any [HITL] tool with external side effects, ensure your evidence is recorded.
6. Always finish by calling delm_publish_gist(..., mark_done=true) with a concise 3-5 line summary.`;

export function buildTaskPrompt(task: Task, contextJson: string): string {
  return [
    `TASK ID: ${task.id}`,
    `GOAL: ${task.goal}`,
    task.criteria ? `VERIFIABLE CRITERIA: ${task.criteria}` : null,
    `REACHABLE VERIFIED CONTEXT:\n${contextJson}`,
    `Execute the goal using available tools and finish with delm_publish_gist.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function waitForWakeup(store: BoardStore, timeoutMs = 1_500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve();
    };
    const unsub = store.onWakeup(done);
    const timer = setTimeout(done, timeoutMs);
  });
}

export async function runWorkerLoop(params: {
  workerId: string;
  store: BoardStore;
  backend: WorkerBackend;
  config: SwarmConfig;
}): Promise<void> {
  const { workerId, store, backend, config } = params;

  while (store.hasPendingOrClaimed()) {
    if (store.getTotalTokensUsed() >= config.maxTotalTokens) {
      break;
    }

    const claimed = store.claimTask(workerId, config.leaseMs);
    if (!claimed) {
      if (!store.hasPendingOrClaimed()) break;
      if (!store.hasActiveClaimed() && !store.hasClaimableTasks()) {
        // Deadlocked / unsatisfiable dependencies (cycles or failed deps) -> mark incomplete so swarm terminates
        store.failUnreachablePendingTasks();
        break;
      }
      await waitForWakeup(store, 1_000);
      continue;
    }

    const { task } = claimed;
    const ctx = store.readContext(task.id, 0);
    const userPrompt = buildTaskPrompt(task, JSON.stringify(ctx, null, 2));

    const watchdog = new TaskWatchdog(store, task.id, workerId, {
      leaseMs: config.leaseMs,
      taskTimeoutMs: config.taskTimeoutMs,
      stallMs: config.stallMs,
      loopThreshold: config.loopThreshold,
      maxTotalTokens: config.maxTotalTokens,
    });
    watchdog.start();

    const startedAt = Date.now();
    try {
      const res = await backend.runTask({
        workerId,
        task,
        systemPrompt: DELM_SYSTEM_PROMPT,
        userPrompt,
        signal: watchdog.signal,
        onActivity: () => watchdog.recordActivity(),
        onToolCall: (name, args) => watchdog.recordToolCall(name, args),
        onToolError: (name, err) => watchdog.recordToolError(name, err),
      });

      store.addTaskTokens(task.id, res.tokensUsed);
      const current = store.getTask(task.id);
      if (current && current.status === "claimed" && current.claimed_by === workerId) {
        // Vigia rule: exiting without publishing a verified gist is 'incomplete', never 'done'
        const nextStatus = current.attempts < current.max_attempts ? "pending" : "incomplete";
        store.markTaskStatus(task.id, nextStatus, Date.now() - startedAt, 0, workerId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.recordEvidence(task.id, workerId, "embedded_error", { taskId: task.id }, msg);
      const current = store.getTask(task.id);
      if (current && current.status === "claimed" && current.claimed_by === workerId) {
        const nextStatus = current.attempts < current.max_attempts ? "pending" : "failed";
        store.markTaskStatus(task.id, nextStatus, Date.now() - startedAt, 0, workerId);
      }
    } finally {
      watchdog.stop();
    }
  }
}
