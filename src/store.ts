import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Evidence, Gist, Task, TaskStatus } from "./types.ts";

export interface SpawnSubtaskInput {
  id?: string;
  goal: string;
  criteria?: string;
  weight?: 1 | 2 | 3;
  depends_on?: string[];
}

export class BoardStore {
  readonly db: Database;
  private readonly listeners = new Set<() => void>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES tasks(id),
        goal TEXT NOT NULL,
        criteria TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        weight INTEGER NOT NULL DEFAULT 2,
        depends_on TEXT NOT NULL DEFAULT '[]',
        claimed_by TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        duration_ms INTEGER,
        tokens_used INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        worker_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gists (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        worker_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_ids TEXT NOT NULL,
        supersedes_gist_id TEXT REFERENCES gists(id),
        status TEXT NOT NULL DEFAULT 'verified',
        created_at INTEGER NOT NULL
      );
    `);
  }

  onWakeup(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notifyWakeup(): void {
    for (const fn of this.listeners) fn();
  }

  close(): void {
    this.db.close();
  }

  createRootTask(goal: string, criteria?: string): Task {
    const now = Date.now();
    const id = `t-${randomUUID().slice(0, 8)}`;
    this.db
      .query(
        `INSERT INTO tasks (id, parent_id, goal, criteria, status, weight, depends_on, created_at, updated_at)
         VALUES (?, NULL, ?, ?, 'pending', 3, '[]', ?, ?)`,
      )
      .run(id, goal, criteria ?? null, now, now);
    this.notifyWakeup();
    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? this.mapTask(row) : null;
  }

  /** Atomic claim with LPT ordering (weight DESC) and dependency resolution. */
  claimTask(workerId: string, leaseMs: number): { task: Task; currentSeq: number } | null {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      const pendingRows = this.db
        .query(
          `SELECT * FROM tasks
           WHERE status = 'pending' AND attempts < max_attempts
           ORDER BY weight DESC, created_at ASC`,
        )
        .all() as Record<string, unknown>[];

      for (const row of pendingRows) {
        const task = this.mapTask(row);
        if (this.areDependenciesDone(task.depends_on)) {
          const leaseUntil = now + leaseMs;
          this.db
            .query(
              `UPDATE tasks
               SET status = 'claimed', claimed_by = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
               WHERE id = ? AND status = 'pending'`,
            )
            .run(workerId, leaseUntil, now, task.id);

          const claimed = this.getTask(task.id)!;
          return { task: claimed, currentSeq: this.getLatestSeq() };
        }
      }
      return null;
    });

    return tx.immediate();
  }

  private areDependenciesDone(dependsOn: string[]): boolean {
    if (dependsOn.length === 0) return true;
    for (const depId of dependsOn) {
      const dep = this.db.query("SELECT status FROM tasks WHERE id = ?").get(depId) as { status: TaskStatus } | null;
      if (!dep || dep.status !== "done") return false;
    }
    return true;
  }

  spawnTasks(parentId: string, subtasks: SpawnSubtaskInput[]): Task[] {
    if (!Array.isArray(subtasks) || subtasks.length === 0 || subtasks.length > 50) {
      throw new Error("subtasks must be a non-empty array of at most 50 items");
    }
    const countRow = this.db.query("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number };
    if (countRow.cnt + subtasks.length > 500) {
      throw new Error("Board task limit (500) exceeded");
    }
    const now = Date.now();
    const created: Task[] = [];
    const insert = this.db.query(
      `INSERT INTO tasks (id, parent_id, goal, criteria, status, weight, depends_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      for (const sub of subtasks) {
        const id = sub.id ?? `t-${randomUUID().slice(0, 8)}`;
        const rawWeight = Number(sub.weight ?? 2);
        const weight = rawWeight === 1 || rawWeight === 3 ? rawWeight : 2;
        const depsArr = Array.isArray(sub.depends_on) ? sub.depends_on.map(String) : [];
        if (depsArr.includes(id)) {
          throw new Error(`Task ${id} cannot depend on itself`);
        }
        const deps = JSON.stringify(depsArr);
        const goal = String(sub.goal ?? "").slice(0, 4_000);
        const criteria = sub.criteria ? String(sub.criteria).slice(0, 2_000) : null;
        insert.run(id, parentId, goal, criteria, weight, deps, now, now);
        created.push(this.getTask(id)!);
      }
    });

    tx.immediate();
    this.notifyWakeup();
    return created;
  }

  recordEvidence(taskId: string, workerId: string, toolName: string, args: unknown, content: string): Evidence {
    const id = `ev-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const boundedContent = content.slice(0, 100_000);
    const argsHash = createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex").slice(0, 16);
    this.db
      .query(
        `INSERT INTO evidence (id, task_id, worker_id, tool_name, args_hash, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, workerId, toolName, argsHash, boundedContent, now);
    return {
      id,
      task_id: taskId,
      worker_id: workerId,
      tool_name: toolName,
      args_hash: argsHash,
      content: boundedContent,
      created_at: now,
    };
  }

  getEvidence(id: string): Evidence | null {
    return (this.db.query("SELECT * FROM evidence WHERE id = ?").get(id) as Evidence | null) ?? null;
  }

  getLatestSeq(): number {
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM gists").get() as { max_seq: number };
    return row.max_seq;
  }

  /** Returns reachable gists (ancestors + dependencies) plus recent deltas since `sinceSeq`. */
  readContext(taskId: string, sinceSeq = 0): { latestSeq: number; rootGoal: string | null; gists: Gist[] } {
    const reachableTaskIds = this.collectReachableTaskIds(taskId);
    const allVerified = this.db
      .query("SELECT * FROM gists WHERE status = 'verified' ORDER BY seq ASC")
      .all() as Record<string, unknown>[];

    const gists = allVerified
      .map((r) => this.mapGist(r))
      .filter((g) => reachableTaskIds.has(g.task_id) && g.seq > sinceSeq);

    const root = this.db.query("SELECT goal FROM tasks WHERE parent_id IS NULL ORDER BY created_at ASC LIMIT 1").get() as {
      goal: string;
    } | null;

    return {
      latestSeq: this.getLatestSeq(),
      rootGoal: root?.goal ?? null,
      gists,
    };
  }

  collectReachableTaskIds(taskId: string): Set<string> {
    const visited = new Set<string>();
    const ancestorsQueue = [taskId];
    const descendantsQueue = [taskId];

    // Walk up (ancestors + dependencies) without expanding unrelated siblings
    while (ancestorsQueue.length > 0) {
      const current = ancestorsQueue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const task = this.getTask(current);
      if (!task) continue;
      if (task.parent_id) ancestorsQueue.push(task.parent_id);
      for (const dep of task.depends_on) {
        ancestorsQueue.push(dep);
        descendantsQueue.push(dep);
      }
    }

    // Walk down from taskId and its dependencies (direct/transitive subtasks)
    const seenDesc = new Set<string>();
    while (descendantsQueue.length > 0) {
      const current = descendantsQueue.shift()!;
      if (seenDesc.has(current)) continue;
      seenDesc.add(current);
      visited.add(current);

      const children = this.db.query("SELECT id FROM tasks WHERE parent_id = ?").all(current) as { id: string }[];
      for (const c of children) descendantsQueue.push(c.id);
    }

    return visited;
  }

  insertGist(params: {
    taskId: string;
    workerId: string;
    baseSeq?: number;
    summary: string;
    evidenceIds: string[];
    supersedesGistId?: string;
    markDone?: boolean;
    durationMs?: number;
    tokensUsed?: number;
  }): Gist {
    const now = Date.now();
    const id = `g-${randomUUID().slice(0, 8)}`;

    const tx = this.db.transaction(() => {
      const task = this.getTask(params.taskId);
      if (!task) {
        throw new Error(`Unknown task_id: ${params.taskId}`);
      }
      const leaseExpired = task.lease_expires_at !== null && task.lease_expires_at < now;

      if (params.supersedesGistId) {
        const prev = this.db
          .query("SELECT task_id, status FROM gists WHERE id = ?")
          .get(params.supersedesGistId) as { task_id: string; status: string } | null;
        if (!prev) {
          throw new Error(`Unknown supersedes_gist_id: ${params.supersedesGistId}`);
        }
        if (prev.task_id !== params.taskId) {
          throw new Error(`supersedes_gist_id ${params.supersedesGistId} does not belong to task ${params.taskId}`);
        }
        if (task.status === "claimed" && (task.claimed_by !== params.workerId || leaseExpired)) {
          throw new Error(`Worker ${params.workerId} does not hold active lease on task ${params.taskId}`);
        }
      } else {
        if (task.status !== "claimed" || task.claimed_by !== params.workerId || leaseExpired) {
          throw new Error(`Worker ${params.workerId} does not hold active lease on task ${params.taskId}`);
        }
      }

      if (params.baseSeq !== undefined) {
        const reachable = this.collectReachableTaskIds(params.taskId);
        const conflict = this.getAllVerifiedGists().find(
          (g) => g.seq > params.baseSeq! && reachable.has(g.task_id) && g.worker_id !== params.workerId,
        );
        if (conflict) {
          throw new Error(`CONFLICT:${conflict.seq}`);
        }
      }

      if (params.supersedesGistId) {
        const prev = this.db
          .query("SELECT task_id FROM gists WHERE id = ?")
          .get(params.supersedesGistId) as { task_id: string } | null;
        if (prev) {
          this.db.query("UPDATE gists SET status = 'superseded' WHERE id = ?").run(params.supersedesGistId);
          // Propagate 'contested' to downstream gists/tasks that depended on the superseded task
          const allTasks = this.db.query("SELECT id, depends_on, status, attempts, max_attempts FROM tasks").all() as {
            id: string;
            depends_on: string;
            status: TaskStatus;
            attempts: number;
            max_attempts: number;
          }[];
          for (const t of allTasks) {
            const deps = JSON.parse(t.depends_on || "[]") as string[];
            if (deps.includes(prev.task_id)) {
              this.db
                .query("UPDATE gists SET status = 'contested' WHERE task_id = ? AND status = 'verified'")
                .run(t.id);
              if (t.status === "done" && t.attempts < t.max_attempts) {
                this.db
                  .query("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?")
                  .run(now, t.id);
              }
            }
          }
        }
      }

      this.db
        .query(
          `INSERT INTO gists (id, task_id, worker_id, summary, evidence_ids, supersedes_gist_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'verified', ?)`,
        )
        .run(
          id,
          params.taskId,
          params.workerId,
          params.summary,
          JSON.stringify(params.evidenceIds),
          params.supersedesGistId ?? null,
          now,
        );

      if (params.markDone) {
        this.db
          .query(
            `UPDATE tasks
             SET status = 'done', claimed_by = NULL, lease_expires_at = NULL,
                 duration_ms = COALESCE(?, duration_ms),
                 tokens_used = COALESCE(?, tokens_used),
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(params.durationMs ?? null, params.tokensUsed ?? null, now, params.taskId);
      }
    });

    tx.immediate();
    this.notifyWakeup();
    return this.mapGist(this.db.query("SELECT * FROM gists WHERE id = ?").get(id) as Record<string, unknown>);
  }

  markTaskStatus(
    taskId: string,
    status: TaskStatus,
    durationMs?: number,
    tokensUsed?: number,
    expectedWorkerId?: string,
  ): void {
    const now = Date.now();
    if (expectedWorkerId) {
      this.db
        .query(
          `UPDATE tasks
           SET status = ?, claimed_by = NULL, lease_expires_at = NULL,
               duration_ms = COALESCE(?, duration_ms),
               tokens_used = tokens_used + COALESCE(?, 0),
               updated_at = ?
           WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
        )
        .run(status, durationMs ?? null, tokensUsed ?? 0, now, taskId, expectedWorkerId);
    } else {
      this.db
        .query(
          `UPDATE tasks
           SET status = ?, claimed_by = NULL, lease_expires_at = NULL,
               duration_ms = COALESCE(?, duration_ms),
               tokens_used = tokens_used + COALESCE(?, 0),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(status, durationMs ?? null, tokensUsed ?? 0, now, taskId);
    }
    this.notifyWakeup();
  }

  addTaskTokens(taskId: string, tokensUsed: number): void {
    if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return;
    this.db.query("UPDATE tasks SET tokens_used = tokens_used + ? WHERE id = ?").run(Math.floor(tokensUsed), taskId);
  }

  renewLease(taskId: string, workerId: string, leaseMs: number): void {
    const now = Date.now();
    this.db
      .query("UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND claimed_by = ?")
      .run(now + leaseMs, now, taskId, workerId);
  }

  expireStaleLeases(): number {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      const expired = this.db
        .query("SELECT id, attempts, max_attempts FROM tasks WHERE status = 'claimed' AND lease_expires_at < ?")
        .all(now) as { id: string; attempts: number; max_attempts: number }[];

      for (const row of expired) {
        const nextStatus: TaskStatus = row.attempts < row.max_attempts ? "pending" : "incomplete";
        this.db
          .query(
            `UPDATE tasks
             SET status = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'claimed' AND lease_expires_at < ?`,
          )
          .run(nextStatus, now, row.id, now);
      }
      return expired.length;
    });
    const count = tx.immediate();
    if (count > 0) this.notifyWakeup();
    return count;
  }

  hasActiveClaimed(): boolean {
    const row = this.db.query("SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'claimed'").get() as { cnt: number };
    return row.cnt > 0;
  }

  failUnreachablePendingTasks(): number {
    const pending = this.db
      .query("SELECT id FROM tasks WHERE status = 'pending'")
      .all() as { id: string }[];
    if (pending.length === 0) return 0;
    const now = Date.now();
    for (const p of pending) {
      this.db
        .query("UPDATE tasks SET status = 'incomplete', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, p.id);
    }
    this.notifyWakeup();
    return pending.length;
  }

  getTotalTokensUsed(): number {
    const row = this.db.query("SELECT COALESCE(SUM(tokens_used), 0) AS total FROM tasks").get() as { total: number };
    return row.total;
  }

  hasPendingOrClaimed(): boolean {
    const row = this.db
      .query("SELECT COUNT(*) AS cnt FROM tasks WHERE status IN ('pending', 'claimed')")
      .get() as { cnt: number };
    return row.cnt > 0;
  }

  hasClaimableTasks(): boolean {
    const pendingRows = this.db
      .query("SELECT depends_on FROM tasks WHERE status = 'pending' AND attempts < max_attempts")
      .all() as { depends_on: string }[];

    for (const r of pendingRows) {
      const deps = JSON.parse(r.depends_on) as string[];
      if (this.areDependenciesDone(deps)) return true;
    }
    return false;
  }

  getAllVerifiedGists(): Gist[] {
    const rows = this.db.query("SELECT * FROM gists WHERE status = 'verified' ORDER BY seq ASC").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.mapGist(r));
  }

  getAllTasks(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((r) => this.mapTask(r));
  }

  getFailureEvidence(limit = 5): Evidence[] {
    return this.db
      .query(
        "SELECT * FROM evidence WHERE tool_name IN ('embedded_error', 'watchdog_freeze') ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Evidence[];
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      parent_id: (row.parent_id as string | null) ?? null,
      goal: row.goal as string,
      criteria: (row.criteria as string | null) ?? null,
      status: row.status as TaskStatus,
      weight: row.weight as 1 | 2 | 3,
      depends_on: JSON.parse((row.depends_on as string) || "[]") as string[],
      claimed_by: (row.claimed_by as string | null) ?? null,
      lease_expires_at: (row.lease_expires_at as number | null) ?? null,
      attempts: row.attempts as number,
      max_attempts: row.max_attempts as number,
      duration_ms: (row.duration_ms as number | null) ?? null,
      tokens_used: (row.tokens_used as number) ?? 0,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  private mapGist(row: Record<string, unknown>): Gist {
    return {
      seq: row.seq as number,
      id: row.id as string,
      task_id: row.task_id as string,
      worker_id: row.worker_id as string,
      summary: row.summary as string,
      evidence_ids: JSON.parse((row.evidence_ids as string) || "[]") as string[],
      supersedes_gist_id: (row.supersedes_gist_id as string | null) ?? null,
      status: row.status as Gist["status"],
      created_at: row.created_at as number,
    };
  }
}
