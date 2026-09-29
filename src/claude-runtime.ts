import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CLARIFY_TIMEOUT_MS, type RecordedAgentResult, type AgentRuntime, type MessageOptions, type WriteAccess } from "./codex-runtime.js";
import { childEnv } from "./op-env.js";
import { RuntimeEventStream, RuntimeFacts, RuntimeStop, recordedError } from "./runtime-facts.js";

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

async function gitWritePaths(cwd: string): Promise<string[]> {
  let gitDir: string | undefined;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      if ((await stat(dotGit)).isDirectory()) gitDir = dotGit;
      else {
        const pointer = /^gitdir: (.+)$/.exec((await readFile(dotGit, "utf8")).trim());
        if (!pointer) throw new Error();
        gitDir = resolve(dir, pointer[1]);
      }
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(dir) === dir) break;
  }
  if (!gitDir) return [];
  // Claude grants this common directory from the worktree layout itself.
  const paths = [gitDir, ...(basename(dirname(gitDir)) === "worktrees" ? [dirname(dirname(gitDir))] : [])];
  try { return [...paths, resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim())]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return paths;
}

async function readOnlyWritePaths(cwd: string): Promise<string[]> {
  try {
    const workingDir = await realpath(cwd);
    const tempName = `claude-${process.getuid?.() ?? 0}`;
    // Claude 2.1.283/SRT skip Linux denies outside an allowed write root. Deny
    // each implicit root, including linked-worktree metadata and both temp paths.
    // Keep / for macOS; allowing / just to deny it can undo managed read denies.
    const paths = ["/", resolve(cwd), workingDir, ...await gitWritePaths(workingDir),
      "/tmp/claude", "/private/tmp/claude", join(homedir(), ".npm", "_logs"), join(homedir(), ".claude", "debug"),
      resolve(workingDir, process.env.CLAUDE_CODE_TMPDIR || "/tmp", tempName), join("/tmp", tempName)];
    const resolved = await Promise.all(paths.map(async (path) => {
      try { return await realpath(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return path; }
    }));
    return [...new Set([...paths, ...resolved])];
  } catch { throw new RuntimeStop("Could not determine Claude read-only filesystem boundaries."); }
}

/**
 * No inherited tool grants, hooks, MCP servers, settings, slash commands (skills) or auto-memory. Managed policy
 * still applies. Claude keeps the owner's config directory, where its login lives: see the README's engine section.
 */
export async function claudePermissionArgs(cwd: string, write?: WriteAccess): Promise<string[]> {
  const settings = {
    disableAllHooks: true, autoMemoryEnabled: false,
    permissions: { disableBypassPermissionsMode: "disable", disableAutoMode: "disable" },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: !!write, excludedCommands: [],
      filesystem: write ? { allowWrite: write.extraDirs.map((dir) => resolve(dir)) } : { denyWrite: await readOnlyWritePaths(cwd) },
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
        if (settled) return;
        // Keep escalation alive even if the parent exits first; its owned descendants can outlive it.
        killTimer = setTimeout(() => stop("SIGKILL"), 1000);
        finish(new RuntimeStop(message, status));
        stop("SIGTERM");
      };
      const abort = () => cancel("Claude run cancelled.", "interrupted");
      const timer = setTimeout(() => cancel(`Claude run timed out after ${Math.round(timeoutMs / 60_000)} min.`, "timed-out"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(part);
        if (stdoutBytes > CLAUDE_OUTPUT_LIMIT) cancel("Claude stdout exceeded the output limit.");
        else stream.push(part);
      });
      // Never echo provider diagnostics: they can contain prompt text, credentials or tool output.
      child.stderr.on("data", (part: string) => {
        if (settled) return;
        stderrBytes += Buffer.byteLength(part);
        if (stderrBytes > CLAUDE_STDERR_LIMIT) cancel("Claude stderr exceeded the output limit.");
      });
      child.on("error", (error: NodeJS.ErrnoException) => finish(new RuntimeStop(error.code === "ENOENT" ? "Claude executable not found; install Claude Code and sign in before selecting it for a seat." : "Claude process failed; diagnostics withheld.")));
      child.on("close", (code) => {
        if (process.platform === "win32" || !child.pid) clearTimeout(killTimer);
        finish(code === 0 ? undefined : new RuntimeStop(`Claude run failed (${code ?? "cancelled"}); diagnostics withheld.`, code === null ? "interrupted" : "failed"));
      });
      child.stdin.on("error", () => cancel("Claude could not read the prompt; diagnostics withheld."));
      child.stdin.end(prompt);
      if (signal?.aborted) abort();
    });
  }
}
