import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveProviderApiKey } from "./backends/embedded.ts";
import type { BoardStore } from "./store.ts";
import type { Gist } from "./types.ts";

export interface PublishGistRequest {
  taskId: string;
  workerId: string;
  baseSeq: number;
  summary: string;
  evidenceIds: string[];
  supersedesGistId?: string;
  markDone?: boolean;
  durationMs?: number;
  tokensUsed?: number;
}

export type AdmissionResult =
  | { admitted: true; gist: Gist }
  | { admitted: false; reason: string; conflictDelta?: Gist[] };

export interface AdmissionOptions {
  verifySemantic: boolean;
  semanticProvider?: string;
  semanticModel?: string;
  requireExternalEvidence?: boolean;
}

export class AdmissionGate {
  private readonly models = builtinModels();

  constructor(
    private readonly store: BoardStore,
    private readonly options: AdmissionOptions,
  ) {}

  async evaluate(req: PublishGistRequest): Promise<AdmissionResult> {
    const [structural, concurrency] = await Promise.all([
      this.checkStructural(req),
      this.checkOptimisticConcurrency(req),
    ]);

    if (!structural.ok) {
      return { admitted: false, reason: structural.reason };
    }
    if (!concurrency.ok) {
      return { admitted: false, reason: concurrency.reason, conflictDelta: concurrency.delta };
    }
    if (this.options.verifySemantic) {
      const semantic = await this.checkSemantic(req);
      if (!semantic.ok) {
        return { admitted: false, reason: semantic.reason };
      }
    }

    try {
      const gist = this.store.insertGist({
        taskId: req.taskId,
        workerId: req.workerId,
        baseSeq: req.baseSeq,
        summary: req.summary.trim().slice(0, 4_000),
        evidenceIds: req.evidenceIds,
        supersedesGistId: req.supersedesGistId,
        markDone: req.markDone,
        durationMs: req.durationMs,
        tokensUsed: req.tokensUsed,
      });
      return { admitted: true, gist };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("CONFLICT:")) {
        const reachable = this.store.collectReachableTaskIds(req.taskId);
        const delta = this.store
          .getAllVerifiedGists()
          .filter((g) => g.seq > req.baseSeq && reachable.has(g.task_id) && g.worker_id !== req.workerId);
        return {
          admitted: false,
          reason: `Optimistic concurrency conflict after base_seq=${req.baseSeq}.`,
          conflictDelta: delta,
        };
      }
      return { admitted: false, reason: msg };
    }
  }

  private async checkStructural(req: PublishGistRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!req.summary || req.summary.trim().length < 5) {
      return { ok: false, reason: "Summary is too short or empty." };
    }
    if (!Array.isArray(req.evidenceIds) || req.evidenceIds.length === 0 || req.evidenceIds.length > 50) {
      return { ok: false, reason: "evidence_ids must be a non-empty array of at most 50 IDs." };
    }

    const task = this.store.getTask(req.taskId);
    if (!task) {
      return { ok: false, reason: `Unknown task_id: ${req.taskId}` };
    }
    const leaseExpired = task.lease_expires_at !== null && task.lease_expires_at < Date.now();
    if (req.supersedesGistId) {
      const prev = this.store.db
        .query("SELECT task_id FROM gists WHERE id = ?")
        .get(req.supersedesGistId) as { task_id: string } | null;
      if (!prev || prev.task_id !== req.taskId) {
        return { ok: false, reason: `supersedes_gist_id must belong to task ${req.taskId}` };
      }
      if (task.status === "claimed" && (task.claimed_by !== req.workerId || leaseExpired)) {
        return { ok: false, reason: `Worker ${req.workerId} does not hold active lease on task ${req.taskId}` };
      }
    } else if (task.status !== "claimed" || task.claimed_by !== req.workerId || leaseExpired) {
      return { ok: false, reason: `Worker ${req.workerId} does not hold active lease on task ${req.taskId}` };
    }

    const reachable = this.store.collectReachableTaskIds(req.taskId);
    let hasExternal = false;
    for (const evId of req.evidenceIds) {
      if (typeof evId !== "string" || !evId) {
        return { ok: false, reason: "All evidence_ids must be non-empty strings." };
      }
      const ev = this.store.getEvidence(evId);
      if (!ev) {
        return { ok: false, reason: `Referenced evidence_id not found: ${evId}` };
      }
      if (ev.tool_name === "embedded_error" || ev.tool_name === "watchdog_freeze") {
        return { ok: false, reason: `Failure evidence (${ev.tool_name}) cannot verify a gist: ${evId}` };
      }
      if (!reachable.has(ev.task_id)) {
        return { ok: false, reason: `Evidence ${evId} belongs to unreachable task ${ev.task_id}` };
      }
      if (ev.tool_name !== "delm_note") {
        hasExternal = true;
      }
    }

    if (this.options.requireExternalEvidence && !hasExternal) {
      return { ok: false, reason: "External MCP evidence is required when external tools are configured." };
    }

    return { ok: true };
  }

  private async checkOptimisticConcurrency(
    req: PublishGistRequest,
  ): Promise<{ ok: true } | { ok: false; reason: string; delta: Gist[] }> {
    const reachable = this.store.collectReachableTaskIds(req.taskId);
    const newerGists = this.store
      .getAllVerifiedGists()
      .filter((g) => g.seq > req.baseSeq && reachable.has(g.task_id) && g.worker_id !== req.workerId);

    if (newerGists.length > 0) {
      return {
        ok: false,
        reason: `Optimistic concurrency conflict: ${newerGists.length} new verified gist(s) were published in reachable context after base_seq=${req.baseSeq}. Inspect conflictDelta and reconcile.`,
        delta: newerGists,
      };
    }

    return { ok: true };
  }

  private async checkSemantic(req: PublishGistRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    const provider = this.options.semanticProvider ?? "openai";
    const modelId = this.options.semanticModel ?? "gpt-4o-mini";
    const model = this.models.getModel(provider, modelId);
    if (!model) {
      return { ok: false, reason: `Semantic verifier model not found: ${provider}/${modelId}` };
    }

    const evidenceSnippets = req.evidenceIds
      .map((id) => {
        const ev = this.store.getEvidence(id);
        return ev ? `[${ev.id} | ${ev.tool_name}]: ${ev.content.slice(0, 1500)}` : "";
      })
      .join("\n\n");

    const response = await this.models.completeSimple(
      model,
      {
        systemPrompt:
          "You are a strict evidence verifier. Reply ONLY with 'PASS' if the summary is directly supported by the evidence snippets, or 'FAIL: <short reason>' if unsupported or contradicted.",
        messages: [
          {
            role: "user",
            content: `SUMMARY:\n${req.summary}\n\nEVIDENCE:\n${evidenceSnippets}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: resolveProviderApiKey(provider) },
    );

    const text = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .trim();

    if (text.toUpperCase().startsWith("PASS")) {
      return { ok: true };
    }
    return { ok: false, reason: `Semantic verification failed: ${text || "unsupported summary"}` };
  }
}
