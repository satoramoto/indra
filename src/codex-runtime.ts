import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { codexProgress } from "./codex-progress.js";
import { childEnv } from "./op-env.js";

export interface AgentResult { sessionId: string; response: unknown; usage?: unknown; startedAt: string; finishedAt: string }
/** `purpose` labels this run's live progress lines, e.g. "build", "review", "fix", "draft". */
export interface MessageOptions { signal?: AbortSignal; timeoutMs?: number; purpose?: string }
export interface AgentRuntime { message(prompt: string, schemaPath: string, sessionId?: string, options?: MessageOptions): Promise<AgentResult> }

/** Short turns: Chick's clarifying replies. */
export const CLARIFY_TIMEOUT_MS = 5 * 60_000;
/** Chick's proposal drafts explore the repo and can run long. */
export const DRAFT_TIMEOUT_MS = 20 * 60_000;
/** Developer seat build, review and fix sessions. */
export const DEVELOPER_SESSION_TIMEOUT_MS = 60 * 60_000;

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * Write access for a new session: workspace-write sandbox with network (for git push and gh),
 * plus extra writable directories such as a worktree's shared Git directory.
 */
export interface WriteAccess { extraDirs: string[] }

/** Sandbox arguments for a new session: read-only without write access. */
export function sandboxArgs(write?: WriteAccess): string[] {
  return write ? ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", ...write.extraDirs.flatMap((dir) => ["--add-dir", dir])] : ["--sandbox", "read-only"];
}

/** Uses the logged-in Codex CLI and an explicit session id; never uses --last. Read-only unless given write access. */
export class CodexRuntime implements AgentRuntime {
  constructor(private readonly cwd: string, private readonly timeoutMs = CLARIFY_TIMEOUT_MS, private readonly write?: WriteAccess) {}
  async message(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<AgentResult> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs; const signal = options.signal; let timedOut = false;
    const startedAt = new Date().toISOString();
    const sandbox = sandboxArgs(this.write);
    const args = sessionId ? ["exec", "resume", sessionId, "--json", "-c", "sandbox_mode=\"read-only\"", "-"] : ["exec", "--json", ...sandbox, "--output-schema", schemaPath, "-"];
    const controller = new AbortController();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const child = spawn("codex", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], signal: controller.signal, env: childEnv() });
      child.stdin.end(prompt);
      let output = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      const progress = codexProgress({ purpose: options.purpose, cwd: this.cwd });
      child.stdout.on("end", () => progress.end());
      child.stdout.on("data", (part: string) => { output += part; progress.push(part); if (output.length > 10_000_000) controller.abort(); });
      child.stderr.on("data", (part: string) => { stderr += part; if (stderr.length > 100_000) controller.abort(); });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }).catch((error: unknown) => { if (timedOut) throw new Error(`Codex run timed out after ${minutes(timeoutMs)}.`); throw error; });
      if (timedOut) throw new Error(`Codex run timed out after ${minutes(timeoutMs)}.`);
      if (code !== 0) throw new Error(`Codex run failed (${code ?? "cancelled"}). ${stderr.slice(-500)}`);
      let id = sessionId; let response: unknown; let usage: unknown;
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "thread.started" && typeof event.thread_id === "string") id = event.thread_id;
        if (event.type === "turn.completed") usage = event.usage;
        if (event.type === "item.completed" && event.item && typeof event.item === "object") {
          const item = event.item as Record<string, unknown>;
          if (item.type === "agent_message" && typeof item.text === "string") {
            try { response = JSON.parse(item.text); } catch { response = item.text; }
          }
        }
      }
      if (!id || response === undefined) throw new Error("Codex returned no session id or final response.");
      return { sessionId: id, response, usage, startedAt, finishedAt: new Date().toISOString() };
    } finally { clearTimeout(timeout); }
  }
}
export const planningId = () => `goal-${randomUUID().slice(0, 8)}`;
