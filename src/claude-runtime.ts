import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CLARIFY_TIMEOUT_MS, type AgentResult, type AgentRuntime, type MessageOptions, type WriteAccess } from "./codex-runtime.js";

/** Persisted handles are engine-qualified; bare legacy handles still belong to Codex. */
export const CLAUDE_SESSION_PREFIX = "claude:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLAUDE_OUTPUT_LIMIT = 10_000_000;
export const CLAUDE_STDERR_LIMIT = 100_000;

export function claudeSessionId(handle: string): string {
  const id = handle.slice(CLAUDE_SESSION_PREFIX.length);
  if (!handle.startsWith(CLAUDE_SESSION_PREFIX) || !uuid.test(id)) throw new Error("Invalid Claude session handle; expected claude:<UUID>.");
  return id;
}

/** No inherited tool grants, hooks or MCP servers. Managed policy still applies. */
export function claudePermissionArgs(write?: WriteAccess): string[] {
  const settings = {
    disableAllHooks: true,
    permissions: { disableBypassPermissionsMode: "disable", disableAutoMode: "disable" },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: !!write, excludedCommands: [],
      filesystem: { ...(write ? { allowWrite: write.extraDirs.map((dir) => resolve(dir)) } : { denyWrite: ["/"] }) },
      network: { allowedDomains: write ? ["*"] : [], strictAllowlist: true, allowLocalBinding: false },
    },
  };
  return [
    "--setting-sources", "", "--settings", JSON.stringify(settings),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome",
    "--permission-mode", write ? "acceptEdits" : "plan", "--permission-prompts", "none",
    "--tools", write ? "Bash,Read,Glob,Grep,Edit,Write,NotebookEdit" : "Bash,Read,Glob,Grep",
    ...(write ? write.extraDirs.flatMap((dir) => ["--add-dir", resolve(dir)]) : ["--disallowedTools", "Edit,Write,NotebookEdit,Agent,WebFetch,WebSearch"]),
  ];
}

/** The authenticated Claude CLI, with schema output on every turn and explicit same-engine continuation. */
export class ClaudeRuntime implements AgentRuntime {
  constructor(private readonly cwd: string, private readonly timeoutMs = CLARIFY_TIMEOUT_MS, private readonly write?: WriteAccess) {}

  async message(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    if (options.signal?.aborted) throw new Error("Claude run cancelled.");
    const resumeId = sessionId === undefined ? undefined : claudeSessionId(sessionId);
    let schema: unknown;
    try { schema = JSON.parse(await readFile(schemaPath, "utf8")); }
    catch { throw new Error("Claude output schema could not be read as JSON."); }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Claude output schema must be a JSON Schema object.");
    const args = ["--print", "--output-format", "json", "--json-schema", JSON.stringify(schema), ...claudePermissionArgs(this.write), ...(resumeId ? ["--resume", resumeId] : [])];
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Claude timeout must be a positive number of milliseconds.");
    const output = await this.run(args, prompt, timeoutMs, options.signal);
    let result: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(output);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      result = value as Record<string, unknown>;
    } catch { throw new Error("Claude returned malformed JSON output."); }
    if (result.type !== "result" || result.subtype !== "success" || result.is_error !== false) throw new Error("Claude did not complete successfully; diagnostics withheld.");
    if (typeof result.session_id !== "string" || !uuid.test(result.session_id) || (resumeId && result.session_id !== resumeId)) throw new Error("Claude returned a missing or mismatched session ID.");
    if (!Object.hasOwn(result, "structured_output")) throw new Error("Claude returned no schema-constrained response.");
    return { sessionId: `${CLAUDE_SESSION_PREFIX}${result.session_id}`, response: result.structured_output, usage: result.usage, startedAt, finishedAt: new Date().toISOString() };
  }

  private run(args: string[], prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      if (signal?.aborted) { reject(new Error("Claude run cancelled.")); return; }
      let child: ChildProcessWithoutNullStreams;
      try {
        // Authentication belongs to the logged-in CLI, never an injected API key. Never replay interrupted turns.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|password|passwd|secret|api_?key/i.test(key)));
        child = spawn("claude", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0" } });
      } catch { reject(new Error("Claude could not be started; check the executable and working directory.")); return; }
      let settled = false; let output = ""; let stdoutBytes = 0; let stderrBytes = 0;
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
        if (error) reject(error); else resolveOutput(output);
      };
      const cancel = (message: string) => {
        if (settled) return;
        stop("SIGTERM");
        killTimer = setTimeout(() => stop("SIGKILL"), 1000); killTimer.unref();
        finish(new Error(message));
      };
      const abort = () => cancel("Claude run cancelled.");
      const timer = setTimeout(() => cancel(`Claude run timed out after ${Math.round(timeoutMs / 60_000)} min.`), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(part);
        if (stdoutBytes > CLAUDE_OUTPUT_LIMIT) cancel("Claude stdout exceeded the output limit.");
        else output += part;
      });
      // Never echo provider diagnostics: they can contain prompt text, credentials or tool output.
      child.stderr.on("data", (part: string) => {
        if (settled) return;
        stderrBytes += Buffer.byteLength(part);
        if (stderrBytes > CLAUDE_STDERR_LIMIT) cancel("Claude stderr exceeded the output limit.");
      });
      child.on("error", (error: NodeJS.ErrnoException) => finish(new Error(error.code === "ENOENT" ? "Claude executable not found; install Claude Code and sign in before selecting it for a seat." : "Claude process failed; diagnostics withheld.")));
      child.on("close", (code) => {
        clearTimeout(killTimer);
        finish(code === 0 ? undefined : new Error(`Claude run failed (${code ?? "cancelled"}); diagnostics withheld.`));
      });
      child.stdin.on("error", () => cancel("Claude could not read the prompt; diagnostics withheld."));
      child.stdin.end(prompt);
      if (signal?.aborted) abort();
    });
  }
}
