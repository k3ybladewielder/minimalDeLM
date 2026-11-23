import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardStore } from "../store.ts";
import type { BackendConfig, Task, WorkerBackend, WorkerRunResult } from "../types.ts";

export interface CliCommandSpec {
  command: string;
  args: string[];
  stdinPayload?: string;
}

export interface BoardMcpConnection {
  url: string;
  token: string;
  issueToken?: (workerId: string, taskId: string) => string;
  revokeToken?: (token: string) => void;
}

/**
 * Subprocess CLI backend inspired by jpvmm/orquestra (Vigia process-group isolation + evidence freeze)
 * and eduwxyz/tucano (clean per-run CLI invocation + single local MCP server).
 */
export class CliBackend implements WorkerBackend {
  constructor(
    private readonly config: BackendConfig,
    private readonly boardMcp?: BoardMcpConnection,
    private readonly store?: BoardStore,
  ) {}

  buildCommand(userPrompt: string, systemPrompt: string, generatedMcpConfigPath?: string): CliCommandSpec {
    const cli = this.config.cliTool ?? "pi";
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    if (cli === "claude") {
      const args = [
        "-p",
        fullPrompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--disallowedTools",
        "Bash,Edit,Write,Read,Glob,Grep",
      ];
      if (generatedMcpConfigPath) args.push("--mcp-config", generatedMcpConfigPath);
      if (this.config.model) args.push("--model", this.config.model);
      if (this.config.maxTurnsPerTask) args.push("--max-turns", String(this.config.maxTurnsPerTask));
      return { command: "claude", args };
    }

    if (cli === "codex") {
      const args = ["exec", "--json", fullPrompt];
      if (this.config.model) args.push("-m", this.config.model);
      return { command: "codex", args };
    }

    // Default: local pi CLI in isolated RPC mode (no builtin coding tools, no session, custom system prompt)
    const localPi = join(process.cwd(), "node_modules", ".bin", "pi");
    const piBin = existsSync(localPi) ? localPi : "pi";
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--no-builtin-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      systemPrompt,
    ];
    if (this.config.model) args.push("--model", this.config.model);
    const rpcPrompt = JSON.stringify({ type: "prompt", message: userPrompt }) + "\n";
    return { command: piBin, args, stdinPayload: rpcPrompt };
  }

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
    const runDir = mkdtempSync(join(tmpdir(), "minimaldelm-cli-"));
    let scopedToken: string | undefined;
    const cleanup = () => {
      if (scopedToken && this.boardMcp?.revokeToken) {
        this.boardMcp.revokeToken(scopedToken);
        scopedToken = undefined;
      }
      rmSync(runDir, { recursive: true, force: true });
    };

    try {
      chmodSync(runDir, 0o700);
      const piAgentDir = join(runDir, ".pi", "agent");
      // Preserve user's authenticated pi credentials without mutating ~/.pi
      const realAuth = process.env.HOME ? join(process.env.HOME, ".pi", "agent", "auth.json") : undefined;
      if (realAuth && existsSync(realAuth)) {
        mkdirSync(piAgentDir, { recursive: true, mode: 0o700 });
        const authDst = join(piAgentDir, "auth.json");
        copyFileSync(realAuth, authDst);
        chmodSync(authDst, 0o600);
      }

      let mcpConfigPath: string | undefined;
      if (this.boardMcp) {
        scopedToken = this.boardMcp.issueToken
          ? this.boardMcp.issueToken(params.workerId, params.task.id)
          : this.boardMcp.token;
        mcpConfigPath = join(runDir, "mcp.json");
        const mcpJson = JSON.stringify({
          mcpServers: {
            minimaldelm: {
              type: "http",
              url: this.boardMcp.url,
              headers: { Authorization: `Bearer ${scopedToken}` },
            },
          },
        });
        writeFileSync(mcpConfigPath, mcpJson, { mode: 0o600 });
        // Also place mcp.json in piAgentDir so isolated pi CLI discovers the Board MCP server
        mkdirSync(piAgentDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(piAgentDir, "mcp.json"), mcpJson, { mode: 0o600 });
      }

      const spec = this.buildCommand(params.userPrompt, params.systemPrompt, mcpConfigPath);

      const safeEnv: Record<string, string> = {
        HOME: runDir,
        PI_CODING_AGENT_DIR: piAgentDir,
      };
      for (const k of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM"]) {
        if (process.env[k]) safeEnv[k] = process.env[k]!;
      }

      return await new Promise<WorkerRunResult>((resolve, reject) => {
        const child: ChildProcess = spawn(spec.command, spec.args, {
          cwd: runDir,
          detached: true, // Own process group so we can kill the entire tree cleanly
          stdio: ["pipe", "pipe", "pipe"],
          env: safeEnv,
        });

        let tokensUsed = 0;
        let buffer = "";
        let stdoutTail = "";
        let stderrTail = "";
        const appendTail = (prev: string, chunk: string) => (prev + chunk).slice(-4_000);

        const killGroup = (forceImmediate = false) => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, forceImmediate ? "SIGKILL" : "SIGTERM");
          } catch {
            return;
          }
          if (!forceImmediate) {
            setTimeout(() => {
              if (!child.pid) return;
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                // already dead
              }
            }, 2_000).unref();
          }
        };

        const onAbort = () => killGroup(false);
        params.signal.addEventListener("abort", onAbort, { once: true });
        if (params.signal.aborted) {
          killGroup(true);
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdoutTail = appendTail(stdoutTail, text);
          params.onActivity();
          buffer += text;
          if (buffer.length > 1_048_576) {
            buffer = buffer.slice(-65_536);
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed) as Record<string, unknown>;
              if (typeof evt.tool_name === "string") {
                params.onToolCall(evt.tool_name, evt.args);
              }
              if (evt.is_error === true && typeof evt.error === "string") {
                params.onToolError(String(evt.tool_name ?? "cli"), evt.error);
              }
              if (typeof evt.total_tokens === "number") {
                tokensUsed = Math.max(tokensUsed, evt.total_tokens);
              }
            } catch {
              // Non-JSON line; still counts as activity
            }
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
          params.onActivity();
        });

        child.on("error", (err) => {
          params.signal.removeEventListener("abort", onAbort);
          cleanup();
          reject(err);
        });

        child.on("close", (code) => {
          params.signal.removeEventListener("abort", onAbort);
          killGroup(true); // Immediately clean any stray descendants without post-exit PID reuse timer
          const abortedReason = params.signal.aborted
            ? String(params.signal.reason ?? "aborted")
            : code !== 0
              ? `CLI exited with code ${code}`
              : undefined;

          if (abortedReason && this.store) {
            this.store.recordEvidence(
              params.task.id,
              params.workerId,
              "watchdog_freeze",
              { reason: abortedReason, code },
              `REASON: ${abortedReason}\n--- STDOUT TAIL ---\n${stdoutTail}\n--- STDERR TAIL ---\n${stderrTail}`,
            );
          }

          cleanup();
          resolve({ tokensUsed, abortedReason });
        });

        if (spec.stdinPayload && child.stdin) {
          child.stdin.write(spec.stdinPayload);
          child.stdin.end();
        } else {
          child.stdin?.end();
        }
      });
    } catch (err) {
      cleanup();
      throw err;
    }
  }
}
