import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { claudePermissionArgs } from "./claude-permissions.js";
import { CLARIFY_TIMEOUT_MS, type RecordedAgentResult, type AgentRuntime, type MessageOptions, type WriteAccess } from "./codex-runtime.js";
import { childEnv } from "./op-env.js";
import { RuntimeEventStream, RuntimeFacts, RuntimeStop, recordedError } from "./runtime-facts.js";

export { claudePermissionArgs };

/** Persisted handles are engine-qualified; bare legacy handles still belong to Codex. */
export const CLAUDE_SESSION_PREFIX = "claude:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLAUDE_OUTPUT_LIMIT = 10_000_000;
export const CLAUDE_STDERR_LIMIT = 100_000;

export function claudeSessionId(handle: string): string {
  const id = handle.slice(CLAUDE_SESSION_PREFIX.length);
  if (!handle.startsWith(CLAUDE_SESSION_PREFIX) || !uuid.test(id)) throw new RuntimeStop("Invalid Claude session handle; expected claude:<UUID>.");
  return id;
}

/** The authenticated Claude CLI, with schema output on every turn and explicit same-engine continuation. */
export class ClaudeRuntime implements AgentRuntime {
  constructor(private readonly cwd: string, private readonly timeoutMs = CLARIFY_TIMEOUT_MS, private readonly write?: WriteAccess) {}

  async message(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<RecordedAgentResult> {
    const evidence = new RuntimeFacts("claude", sessionId);
    let result: Record<string, unknown> | undefined;
    const stream = new RuntimeEventStream((event) => { evidence.observe(event); if (event.type === "result") result = event; });
    try {
      if (options.signal?.aborted) throw new RuntimeStop("Claude run cancelled.", "interrupted");
      const resumeId = sessionId === undefined ? undefined : claudeSessionId(sessionId);
      let schema: unknown;
      try { schema = JSON.parse(await readFile(schemaPath, "utf8")); }
      catch { throw new RuntimeStop("Claude output schema could not be read as JSON."); }
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new RuntimeStop("Claude output schema must be a JSON Schema object.");
      const args = ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(schema), ...await claudePermissionArgs(this.cwd, this.write), ...(resumeId ? ["--resume", resumeId] : [])];
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeStop("Claude timeout must be a positive number of milliseconds.");
      await this.run(args, prompt, timeoutMs, stream, options.signal);
      if (stream.malformed) throw new RuntimeStop("Claude returned malformed JSON output.");
      if (!result || result.subtype !== "success" || result.is_error !== false) throw new RuntimeStop("Claude did not complete successfully; diagnostics withheld.");
      if (typeof result.session_id !== "string" || !uuid.test(result.session_id) || (resumeId && result.session_id !== resumeId)) throw new RuntimeStop("Claude returned a missing or mismatched session ID.");
      if (!Object.hasOwn(result, "structured_output")) throw new RuntimeStop("Claude returned no schema-constrained response.");
      const facts = evidence.finish("succeeded");
      return { sessionId: `${CLAUDE_SESSION_PREFIX}${result.session_id}`, response: result.structured_output, usage: facts.usage, startedAt: facts.startedAt, finishedAt: facts.finishedAt, facts };
    } catch (error) {
      stream.end();
      throw recordedError(error, evidence);
    }
  }

  private run(args: string[], prompt: string, timeoutMs: number, stream: RuntimeEventStream, signal?: AbortSignal): Promise<void> {
    return new Promise((resolveOutput, reject) => {
      if (signal?.aborted) { reject(new RuntimeStop("Claude run cancelled.", "interrupted")); return; }
      let child: ChildProcessWithoutNullStreams;
      try {
        // Authentication belongs to the logged-in CLI, never an injected API key. Never replay interrupted turns.
        const env = Object.fromEntries(Object.entries(childEnv()).filter(([key]) => !/token|password|passwd|secret|api_?key/i.test(key)));
        child = spawn("claude", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0" } });
      } catch { reject(new RuntimeStop("Claude could not be started; check the executable and working directory.")); return; }
      let settled = false; let stdoutBytes = 0; let stderrBytes = 0;
      let failure: RuntimeStop | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (kind: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
          else child.kill(kind);
        } catch { /* already exited */ }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        stream.end();
        if (error) reject(error); else resolveOutput();
      };
      const cancel = (message: string, status: "failed" | "interrupted" | "timed-out" = "failed") => {
        if (settled || failure) return;
        failure = new RuntimeStop(message, status);
        // Keep escalation alive even if the parent exits first; its owned descendants can outlive it.
        killTimer = setTimeout(() => stop("SIGKILL"), 1000);
        // Continue bounded collection through shutdown; close fires after the stdout pipe has drained.
        stop("SIGTERM");
      };
      const abort = () => cancel("Claude run cancelled.", "interrupted");
      const timer = setTimeout(() => cancel(`Claude run timed out after ${Math.round(timeoutMs / 60_000)} min.`, "timed-out"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        if (settled || stdoutBytes > CLAUDE_OUTPUT_LIMIT) return;
        stdoutBytes += Buffer.byteLength(part);
        if (stdoutBytes > CLAUDE_OUTPUT_LIMIT) cancel("Claude stdout exceeded the output limit.");
        else stream.push(part);
      });
      // Never echo provider diagnostics: they can contain prompt text, credentials or tool output.
      child.stderr.on("data", (part: string) => {
        if (settled || stderrBytes > CLAUDE_STDERR_LIMIT) return;
        stderrBytes += Buffer.byteLength(part);
        if (stderrBytes > CLAUDE_STDERR_LIMIT) cancel("Claude stderr exceeded the output limit.");
      });
      child.on("error", (error: NodeJS.ErrnoException) => cancel(error.code === "ENOENT" ? "Claude executable not found; install Claude Code and sign in before selecting it for a seat." : "Claude process failed; diagnostics withheld."));
      child.on("close", (code) => {
        if (process.platform === "win32" || !child.pid) clearTimeout(killTimer);
        finish(failure ?? (code === 0 ? undefined : new RuntimeStop(`Claude run failed (${code ?? "cancelled"}); diagnostics withheld.`, code === null ? "interrupted" : "failed")));
      });
      child.stdin.on("error", () => cancel("Claude could not read the prompt; diagnostics withheld."));
      child.stdin.end(prompt);
      if (signal?.aborted) abort();
    });
  }
}
