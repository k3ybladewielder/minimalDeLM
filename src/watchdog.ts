import type { BoardStore } from "./store.ts";

export interface WatchdogConfig {
  leaseMs: number;
  taskTimeoutMs: number;
  stallMs: number;
  loopThreshold: number;
  maxTotalTokens: number;
}

export class TaskWatchdog {
  private lastActivityAt = Date.now();
  private lastSignature = "";
  private repeatCount = 0;
  private readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private abortedReason: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: BoardStore,
    private readonly taskId: string,
    private readonly workerId: string,
    private readonly config: WatchdogConfig,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get reason(): string | undefined {
    return this.abortedReason;
  }

  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.startedAt > this.config.taskTimeoutMs) {
        this.abort(`Task timeout exceeded (${this.config.taskTimeoutMs}ms)`);
        return;
      }
      if (now - this.lastActivityAt > this.config.stallMs) {
        this.abort(`Worker stalled (no activity for ${this.config.stallMs}ms)`);
        return;
      }
      if (this.store.getTotalTokensUsed() > this.config.maxTotalTokens) {
        this.abort(`Global token budget exceeded (${this.config.maxTotalTokens})`);
        return;
      }
      this.store.renewLease(this.taskId, this.workerId, this.config.leaseMs);
    }, Math.min(2_000, Math.max(250, Math.floor(this.config.stallMs / 3))));
  }

  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  recordToolCall(toolName: string, args: unknown): void {
    this.recordActivity();
    const sig = `call:${toolName}:${JSON.stringify(args ?? null)}`;
    this.trackSignature(sig, `Loop detected: repeated identical tool call (${toolName}) ${this.config.loopThreshold}x`);
  }

  recordToolError(toolName: string, errorText: string): void {
    this.recordActivity();
    const normalized = errorText.replace(/\d+/g, "#").slice(0, 120);
    const sig = `err:${toolName}:${normalized}`;
    this.trackSignature(sig, `Loop detected: repeated identical error on ${toolName} ${this.config.loopThreshold}x`);
  }

  private trackSignature(sig: string, abortMsg: string): void {
    if (sig === this.lastSignature) {
      this.repeatCount += 1;
      if (this.repeatCount >= this.config.loopThreshold) {
        this.abort(abortMsg);
      }
    } else {
      this.lastSignature = sig;
      this.repeatCount = 1;
    }
  }

  abort(reason: string): void {
    if (this.controller.signal.aborted) return;
    this.abortedReason = reason;
    this.controller.abort(new Error(reason));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export function startLeaseSweeper(store: BoardStore, intervalMs = 5_000): () => void {
  const timer = setInterval(() => {
    store.expireStaleLeases();
  }, intervalMs);
  return () => clearInterval(timer);
}
