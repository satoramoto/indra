import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudePermissionArgs } from "./claude-permissions.js";
import { claudeProgress } from "./claude-progress.js";
import { CLARIFY_TIMEOUT_MS, checkPromptSize, type RecordedAgentResult, type AgentRuntime, type MessageOptions, type WriteAccess } from "./codex-runtime.js";
import { HARNESS_CONTEXT_TOKEN_LIMIT } from "./harness-home.js";
import { claimHeaded, firstMessage, HeadedStartError, headedAvailable, prepareTaskFiles, readLog, resultValidator, runHeaded, taskDocument } from "./headed-session.js";
import { childEnv } from "./op-env.js";
import { ownedProcesses, TREE_REFRESH_MS } from "./process-tree.js";
import { AgentRunError, RuntimeEventStream, RuntimeFacts, RuntimeStop, usageReporter, recordedError } from "./runtime-facts.js";

export { claudePermissionArgs };

/** Persisted handles are engine-qualified; bare legacy handles still belong to Codex. */
export const CLAUDE_SESSION_PREFIX = "claude:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLAUDE_OUTPUT_LIMIT = 10_000_000;
export const CLAUDE_STDERR_LIMIT = 100_000;

/** The owner's Claude seat allocation: every role runs this model for now. */
export const CLAUDE_MODEL = "claude-opus-5-5";
/** Reasoning effort by role (`claude --effort`), mirroring the Codex allocation: planning reasons hardest, implementation runs at medium. */
export const TEAM_LEAD_CLAUDE_EFFORT = "max";
export const PRODUCT_CLAUDE_EFFORT = "medium";
export const DEVELOPER_CLAUDE_EFFORT = "medium";

/** `--model` and `--effort` for a seat's roles as recorded in state; an unknown or missing role gets the Developer settings. */
export function claudeModelArgs(roles: readonly string[] | undefined): string[] {
  const effort = roles?.includes("Team Lead") ? TEAM_LEAD_CLAUDE_EFFORT : roles?.includes("Product") ? PRODUCT_CLAUDE_EFFORT : DEVELOPER_CLAUDE_EFFORT;
  return ["--model", CLAUDE_MODEL, "--effort", effort];
}

/** Never replay interrupted turns, and auto-compact at the owner's per-session context cap. */
export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0", CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(HARNESS_CONTEXT_TOKEN_LIMIT) };
}

/** Authentication belongs to the logged-in CLI, never an injected API key: no credential-looking variable reaches Claude. */
function claudeChildEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(childEnv()).filter(([key]) => !/token|password|passwd|secret|api_?key/i.test(key)));
}

async function readSchema(schemaPath: string): Promise<object> {
  let schema: unknown;
  try { schema = JSON.parse(await readFile(schemaPath, "utf8")); }
  catch { throw new RuntimeStop("Claude output schema could not be read as JSON."); }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new RuntimeStop("Claude output schema must be a JSON Schema object.");
  return schema;
}

/** A headed session's transcript, `<config dir>/projects/<project>/<session-id>.jsonl`, once Claude has written it. */
export async function claudeTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const dir of dirs) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (await stat(file).then((info) => info.isFile(), () => false)) return file;
  }
  return undefined;
}

export function claudeSessionId(handle: string): string {
  const id = handle.slice(CLAUDE_SESSION_PREFIX.length);
  if (!handle.startsWith(CLAUDE_SESSION_PREFIX) || !uuid.test(id)) throw new RuntimeStop("Invalid Claude session handle; expected claude:<UUID>.");
  return id;
}

/** The authenticated Claude CLI, with schema output on every turn and explicit same-engine continuation. */
export class ClaudeRuntime implements AgentRuntime {
  /**
   * `roles` are the seat's roles from state; they pick the effort (see claudeModelArgs). `headed` defaults to
   * headedAvailable(): a new session in a hosted seat pane runs the interactive CLI there (see headed-session.ts).
   */
  constructor(private readonly cwd: string, private readonly timeoutMs = CLARIFY_TIMEOUT_MS, private readonly write?: WriteAccess, private readonly roles?: readonly string[], private readonly headed = headedAvailable(), private readonly envFor: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = (env) => env) {}

  async message(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<RecordedAgentResult> {
    const release = this.headed && sessionId === undefined ? claimHeaded() : undefined;
    if (release) {
      try { return await this.headedMessage(prompt, schemaPath, options); }
      catch (error) {
        if (!(error instanceof AgentRunError && error.cause instanceof HeadedStartError)) throw error;
        console.log("Claude did not start a headed session; running this task headless.");
      } finally { release(); }
    }
    return await this.headlessMessage(prompt, schemaPath, sessionId, options);
  }

  /** One fresh interactive session in this process's terminal; the task and result are files (see headed-session.ts). */
  private async headedMessage(prompt: string, schemaPath: string, options: MessageOptions): Promise<RecordedAgentResult> {
    const id = randomUUID();
    const evidence = new RuntimeFacts("claude", undefined);
    evidence.sessionId = `${CLAUDE_SESSION_PREFIX}${id}`;
    let started = false;
    try {
      const schema = await readSchema(schemaPath);
      checkPromptSize(prompt);
      const files = await prepareTaskFiles(this.cwd);
      await writeFile(files.task, taskDocument(prompt, schema, files), { mode: 0o600 });
      const args = [...claudeModelArgs(this.roles), "--session-id", id, ...await claudePermissionArgs(this.cwd, this.write, files.result), "--", firstMessage(files)];
      // Indra disables every project setting source, hook and MCP server, so the workspace trust dialog guards nothing
      // here; CLAUDE_CODE_SANDBOXED skips it so the session never waits on it.
      const env = { ...claudeEnv(this.envFor(claudeChildEnv())), CLAUDE_CODE_SANDBOXED: "1" };
      const transcript = () => claudeTranscript(id);
      const response = await runHeaded({
        label: "Claude", cwd: this.cwd, files, validate: resultValidator(schema), launch: { command: "claude", args, env },
        started: async () => { const path = await transcript(); started = !!path; return path; }, facts: evidence, requireFinalUsage: options.requireFinalUsage, onUsage: usageReporter(evidence, options.onUsage), timeoutMs: Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs), signal: options.signal,
      });
      if (!evidence.logObserved) await readLog(await transcript(), evidence);
      const facts = evidence.finish("succeeded");
      return { sessionId: evidence.sessionId, response, usage: facts.usage, startedAt: facts.startedAt, finishedAt: facts.finishedAt, facts };
    } catch (error) {
      if (started && !evidence.logObserved) await readLog(await claudeTranscript(id), evidence);
      else if (!started) evidence.sessionId = undefined;
      const recorded = recordedError(error, evidence);
      if (error instanceof HeadedStartError) recorded.cause = error;
      throw recorded;
    }
  }

  private async headlessMessage(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<RecordedAgentResult> {
    const evidence = new RuntimeFacts("claude", sessionId);
    let result: Record<string, unknown> | undefined;
    const reportUsage = usageReporter(evidence, options.onUsage);
    const stream = new RuntimeEventStream((event) => { evidence.observe(event); reportUsage(); if (event.type === "result") result = event; });
    try {
      if (options.signal?.aborted) throw new RuntimeStop("Claude run cancelled.", "interrupted");
      const resumeId = sessionId === undefined ? undefined : claudeSessionId(sessionId);
      const schema = await readSchema(schemaPath);
      const args = ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...claudeModelArgs(this.roles), "--json-schema", JSON.stringify(schema), ...await claudePermissionArgs(this.cwd, this.write), ...(resumeId ? ["--resume", resumeId] : [])];
      const timeoutMs = Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeStop("Claude timeout must be a positive number of milliseconds.");
      checkPromptSize(prompt);
      await this.run(args, prompt, timeoutMs, stream, options.signal);
      if (stream.malformed) throw new RuntimeStop("Claude returned malformed JSON output.");
      if (!result || result.subtype !== "success" || result.is_error !== false) throw new RuntimeStop("Claude did not complete successfully; diagnostics withheld.");
      if (typeof result.session_id !== "string" || !uuid.test(result.session_id) || (resumeId && result.session_id !== resumeId)) throw new RuntimeStop("Claude returned a missing or mismatched session ID.");
      if (!Object.hasOwn(result, "structured_output")) throw new RuntimeStop("Claude returned no schema-constrained response.");
      const facts = evidence.finish("succeeded");
      return { sessionId: `${CLAUDE_SESSION_PREFIX}${result.session_id}`, response: result.structured_output, usage: facts.usage, startedAt: facts.startedAt, finishedAt: facts.finishedAt, facts };
    } catch (error) {
      try { stream.end(); } catch { /* callback already failed */ }
      throw recordedError(error, evidence);
    }
  }

  private run(args: string[], prompt: string, timeoutMs: number, stream: RuntimeEventStream, signal?: AbortSignal): Promise<void> {
    return new Promise((resolveOutput, reject) => {
      if (signal?.aborted) { reject(new RuntimeStop("Claude run cancelled.", "interrupted")); return; }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("claude", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: claudeEnv(this.envFor(claudeChildEnv())) });
      } catch { reject(new RuntimeStop("Claude could not be started; check the executable and working directory.")); return; }
      // Claude's tools run in process groups of their own: track the whole tree and end it with the run.
      const tree = ownedProcesses.track(child.pid);
      const treeTimer = setInterval(() => { void tree.then((run) => run.refresh()); }, TREE_REFRESH_MS);
      treeTimer.unref?.();
      let settled = false; let stdoutBytes = 0; let stderrBytes = 0; const progress = claudeProgress({ cwd: this.cwd });
      let failure: RuntimeStop | undefined;
      let ending: Promise<unknown> | undefined;
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
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
        try { stream.end(); } catch { error ??= new RuntimeStop("Claude usage callback failed."); }
        if (error) reject(error); else resolveOutput();
      };
      const cancel = (message: string, status: "failed" | "interrupted" | "timed-out" = "failed") => {
        if (settled || failure) return;
        failure = new RuntimeStop(message, status);
        // Refresh before signalling: detached tools must be recorded before their parent can exit.
        ending = tree.then(async (run) => {
          await run.refresh();
          killTimer = setTimeout(() => stop("SIGKILL"), 1000);
          stop("SIGTERM");
          await run.end(1000);
        });
      };
      const abort = () => cancel("Claude run cancelled.", "interrupted");
      const timer = setTimeout(() => cancel(`Claude run timed out after ${Math.round(timeoutMs / 60_000)} min.`, "timed-out"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        if (settled || stdoutBytes > CLAUDE_OUTPUT_LIMIT) return;
        stdoutBytes += Buffer.byteLength(part);
        if (stdoutBytes > CLAUDE_OUTPUT_LIMIT) cancel("Claude stdout exceeded the output limit.");
        else { try { stream.push(part); } catch { cancel("Claude usage callback failed."); } progress.push(part); }
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
        clearInterval(treeTimer);
        const outcome = failure ?? (code === 0 ? undefined : new RuntimeStop(`Claude run failed (${code ?? "cancelled"}); diagnostics withheld.`, code === null ? "interrupted" : "failed"));
        void (ending ?? tree.then((run) => run.end(1000))).catch(() => 0).then(() => finish(outcome));
      });
      child.stdin.on("error", () => cancel("Claude could not read the prompt; diagnostics withheld."));
      child.stdin.end(prompt);
      if (signal?.aborted) abort();
    });
  }
}
