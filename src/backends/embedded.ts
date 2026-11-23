import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AdmissionGate } from "../admission.ts";
import { createDelmTools, type McpGateway } from "../mcp.ts";
import type { BoardStore } from "../store.ts";
import type { BackendConfig, Task, WorkerBackend, WorkerRunResult } from "../types.ts";

export function resolveProviderApiKey(provider: string): string | undefined {
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  const normalized = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[normalized] ?? (provider === "google" ? process.env.GEMINI_API_KEY : undefined);
}

export class EmbeddedBackend implements WorkerBackend {
  private readonly models = builtinModels();

  constructor(
    private readonly store: BoardStore,
    private readonly admission: AdmissionGate,
    private readonly mcp: McpGateway,
    private readonly config: BackendConfig,
  ) {}

  async runTask(params: {
    workerId: string;
    task: Task;
    systemPrompt: string;
    userPrompt: string;
    signal: AbortSignal;
    onActivity: () => void;
    onToolCall: (toolName: string, args: unknown) => void;
    onToolError: (toolName: string, errorText: string) => void;
  }): Promise<WorkerRunResult> {
    const provider = this.config.provider ?? "openai";
    const modelId = this.config.model ?? "gpt-4o-mini";
    const model = this.models.getModel(provider, modelId);
    if (!model) {
      throw new Error(`EmbeddedBackend: unknown model ${provider}/${modelId}`);
    }

    let baseSeq = this.store.getLatestSeq();
    const startedAt = Date.now();
    const delmTools = createDelmTools(
      this.store,
      this.admission,
      params.workerId,
      params.task.id,
      () => baseSeq,
      (seq) => {
        baseSeq = seq;
      },
      startedAt,
    );
    const mcpTools = this.mcp.toAgentTools(this.store, params.workerId, params.task.id);

    let tokensUsed = 0;
    let turns = 0;
    const maxTurns = this.config.maxTurnsPerTask ?? 20;

    const agent = new Agent({
      streamFn: (m, ctx, opts) => this.models.streamSimple(m, ctx, opts),
      getApiKey: (prov) => resolveProviderApiKey(prov),
      initialState: {
        systemPrompt: params.systemPrompt,
        model,
        tools: [...delmTools, ...mcpTools],
      },
      beforeToolCall: async (ctx) => {
        params.onToolCall(ctx.toolCall.name, ctx.args);
        return undefined;
      },
      afterToolCall: async (ctx) => {
        params.onActivity();
        if (ctx.isError) {
          const text = ctx.result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
          params.onToolError(ctx.toolCall.name, text);
        }
        return undefined;
      },
      finishTurn: async (turnCtx) => {
        turns += 1;
        tokensUsed += turnCtx.message.usage?.totalTokens ?? 0;
        params.onActivity();
        if (turns >= maxTurns) {
          return { action: "stop" } as unknown as undefined;
        }
        return undefined;
      },
    });

    const onAbort = () => agent.abort();
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) {
      agent.abort();
    }

    try {
      await agent.prompt(params.userPrompt);
    } finally {
      params.signal.removeEventListener("abort", onAbort);
    }

    const errMsg = agent.state.errorMessage;
    if (errMsg) {
      this.store.recordEvidence(params.task.id, params.workerId, "embedded_error", { provider, modelId }, errMsg);
    }

    return {
      tokensUsed,
      abortedReason: params.signal.aborted ? String(params.signal.reason ?? "aborted") : errMsg,
    };
  }
}
