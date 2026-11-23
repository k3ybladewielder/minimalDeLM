export type TaskStatus = "pending" | "claimed" | "done" | "incomplete" | "failed";

export interface Task {
  id: string;
  parent_id: string | null;
  goal: string;
  criteria: string | null;
  status: TaskStatus;
  weight: 1 | 2 | 3;
  depends_on: string[];
  claimed_by: string | null;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  duration_ms: number | null;
  tokens_used: number;
  created_at: number;
  updated_at: number;
}

export interface Evidence {
  id: string;
  task_id: string;
  worker_id: string;
  tool_name: string;
  args_hash: string;
  content: string;
  created_at: number;
}

export interface Gist {
  seq: number;
  id: string;
  task_id: string;
  worker_id: string;
  summary: string;
  evidence_ids: string[];
  supersedes_gist_id: string | null;
  status: "verified" | "superseded" | "contested";
  created_at: number;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
  policy: {
    allow: string[];
    hitl: string[];
  };
}

export interface BackendConfig {
  type: "embedded" | "cli";
  provider?: string;
  model?: string;
  cliTool?: "pi" | "claude" | "codex";
  maxTurnsPerTask?: number;
}

export interface SwarmConfig {
  dbPath: string;
  workers: number;
  leaseMs: number;
  taskTimeoutMs: number;
  stallMs: number;
  loopThreshold: number;
  maxTotalTokens: number;
  verifySemantic: boolean;
  backend: BackendConfig;
  mcpConfigPath?: string;
}

export interface WorkerRunResult {
  tokensUsed: number;
  abortedReason?: string;
}

export interface WorkerBackend {
  runTask(params: {
    workerId: string;
    task: Task;
    systemPrompt: string;
    userPrompt: string;
    signal: AbortSignal;
    onActivity: () => void;
    onToolCall: (toolName: string, args: unknown) => void;
    onToolError: (toolName: string, errorText: string) => void;
  }): Promise<WorkerRunResult>;
}
