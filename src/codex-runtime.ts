import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { codexProgress } from "./codex-progress.js";
import { DEVELOPER_CODEX_CONFIG, ensureCodexHome } from "./harness-home.js";
import { claimHeaded, firstMessage, HeadedStartError, headedAvailable, prepareTaskFiles, readLog, resultValidator, runHeaded, taskDocument } from "./headed-session.js";
import { childEnv } from "./op-env.js";
import { ownedProcesses, TREE_REFRESH_MS, type TrackedRun } from "./process-tree.js";
import { AgentRunError, RuntimeEventStream, RuntimeFacts, RuntimeStop, jsonObject, recordedError, type RuntimeSessionFacts, type TokenUsage } from "./runtime-facts.js";

export interface AgentResult { sessionId: string; response: unknown; usage?: unknown; startedAt: string; finishedAt: string; facts?: RuntimeSessionFacts }
/** Both concrete providers always return evidence; legacy injected runtimes may omit it. */
export interface RecordedAgentResult extends AgentResult { facts: RuntimeSessionFacts }
/** `purpose` labels this run's live progress lines, e.g. "build", "review", "fix", "draft". */
export interface MessageOptions { signal?: AbortSignal; timeoutMs?: number; purpose?: string; /** Last persisted cumulativeUsage, for this same session only. */ previousSessionUsage?: TokenUsage }
export interface AgentRuntime { message(prompt: string, schemaPath: string, sessionId?: string, options?: MessageOptions): Promise<AgentResult> }

/** Short turns: Chick's clarifying replies. */
export const CLARIFY_TIMEOUT_MS = 5 * 60_000;
/** Chick's proposal drafts explore the repo and can run long. */
export const DRAFT_TIMEOUT_MS = 20 * 60_000;
/** Developer seat build, review and fix sessions. */
export const DEVELOPER_SESSION_TIMEOUT_MS = 60 * 60_000;

/**
 * The largest prompt Indra sends one session: about 64k tokens, well under HARNESS_CONTEXT_TOKEN_LIMIT, and above the
 * retro's bounded evidence snapshot (128 KB). Prompts carry references (PR URLs, paths), never whole files; a bigger one fails.
 */
export const AGENT_PROMPT_LIMIT_BYTES = 256_000;

/** Refuses an oversized prompt before any process starts. */
export function checkPromptSize(prompt: string): void {
  if (Buffer.byteLength(prompt, "utf8") > AGENT_PROMPT_LIMIT_BYTES) throw new RuntimeStop(`Agent prompt exceeds the ${AGENT_PROMPT_LIMIT_BYTES}-byte limit; not sent.`);
}

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

/**
 * The interactive CLI for a headed write session: the same sandbox as `exec`, never an approval prompt (`exec`'s own
 * default), this working directory trusted for this invocation only (so no trust screen waits for an answer), and no
 * update check. The model, effort and context cap come from the seat home's config.toml, as for `exec`.
 */
export function codexHeadedArgs(cwd: string, write: WriteAccess, message: string): string[] {
  return [...sandboxArgs(write), "--ask-for-approval", "never", "-c", `projects={${JSON.stringify(resolve(cwd))}={trust_level="trusted"}}`, "-c", "check_for_update_on_startup=false", "--", message];
}

/** The newest rollout in a seat home written since `since` for this working directory: `sessions/YYYY/MM/DD/rollout-*.jsonl`. */
export async function codexRollout(home: string, cwds: readonly string[], since: number): Promise<string | undefined> {
  const root = join(home, "sessions");
  const files = (await readdir(root, { recursive: true }).catch(() => [] as string[]))
    .filter((file) => /(^|\/)rollout-[^/]*\.jsonl$/.test(file)).map((file) => join(root, file));
  const recent = (await Promise.all(files.map(async (file) => ({ file, mtime: await stat(file).then((info) => info.mtimeMs, () => 0) }))))
    .filter(({ mtime }) => mtime >= since - 5000).sort((a, b) => b.mtime - a.mtime);
  for (const { file } of recent) {
    const first = (await readFile(file, "utf8").catch(() => "")).split("\n", 1)[0];
    try {
      const meta = JSON.parse(first) as { type?: unknown; payload?: { cwd?: unknown } };
      if (meta.type === "session_meta" && typeof meta.payload?.cwd === "string" && cwds.includes(meta.payload.cwd)) return file;
    } catch { /* not written yet */ }
  }
  return undefined;
}

/**
 * Uses the logged-in Codex CLI and an explicit session id; never uses --last. Read-only unless given write access.
 * With `home`, Codex runs with `CODEX_HOME` set to that Indra-owned seat home (see harness-home.ts), so it loads
 * none of the owner's personal configuration and keeps its sessions there.
 */
export class CodexRuntime implements AgentRuntime {
  /**
   * `headed` defaults to headedAvailable(): a new session with write access and a seat home, in a hosted seat pane, runs
   * the interactive CLI there (see headed-session.ts). Read-only sessions stay headless: Codex's read-only sandbox
   * cannot write the result file.
   */
  constructor(private readonly cwd: string, private readonly timeoutMs = CLARIFY_TIMEOUT_MS, private readonly write?: WriteAccess, private readonly home?: string, private readonly config: string = DEVELOPER_CODEX_CONFIG, private readonly headed = headedAvailable(), private readonly envFor: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = (env) => env) {}
  async message(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<RecordedAgentResult> {
    const release = this.headed && sessionId === undefined && this.write && this.home ? claimHeaded() : undefined;
    if (release) {
      try { return await this.headedMessage(prompt, schemaPath, this.write!, this.home!, options); }
      catch (error) {
        if (!(error instanceof AgentRunError && error.cause instanceof HeadedStartError)) throw error;
        console.log("Codex did not start a headed session; running this task headless.");
      } finally { release(); }
    }
    return await this.headlessMessage(prompt, schemaPath, sessionId, options);
  }

  /** One fresh interactive session in this process's terminal; the task and result are files (see headed-session.ts). */
  private async headedMessage(prompt: string, schemaPath: string, write: WriteAccess, home: string, options: MessageOptions): Promise<RecordedAgentResult> {
    const evidence = new RuntimeFacts("codex", undefined);
    const since = Date.now();
    let rollout: string | undefined;
    try {
      let schema: unknown;
      try { schema = JSON.parse(await readFile(schemaPath, "utf8")); }
      catch { throw new RuntimeStop("Codex output schema could not be read as JSON."); }
      if (!jsonObject(schema)) throw new RuntimeStop("Codex output schema must be a JSON Schema object.");
      checkPromptSize(prompt);
      const env = { ...this.envFor(childEnv()), CODEX_HOME: await ensureCodexHome(home, this.config) };
      const files = await prepareTaskFiles(this.cwd);
      await writeFile(files.task, taskDocument(prompt, schema, files), { mode: 0o600 });
      const cwds = [resolve(this.cwd), await realpath(this.cwd).catch(() => resolve(this.cwd))];
      const response = await runHeaded({
        label: "Codex", cwd: this.cwd, files, validate: resultValidator(schema), launch: { command: "codex", args: codexHeadedArgs(this.cwd, write, firstMessage(files)), env },
        started: async () => (rollout ??= await codexRollout(home, cwds, since)), timeoutMs: options.timeoutMs ?? this.timeoutMs, signal: options.signal,
      });
      rollout ??= await codexRollout(home, cwds, since);
      await readLog(rollout, evidence);
      if (!evidence.sessionId) throw new RuntimeStop("Codex returned no session id or final response.");
      const facts = evidence.finish("succeeded");
      return { sessionId: evidence.sessionId, response, usage: facts.usage, startedAt: facts.startedAt, finishedAt: facts.finishedAt, facts };
    } catch (error) {
      await readLog(rollout, evidence);
      const recorded = recordedError(error, evidence);
      if (error instanceof HeadedStartError) recorded.cause = error;
      throw recorded;
    } finally {
      await ensureCodexHome(home, this.config).catch(() => undefined);
    }
  }

  private async headlessMessage(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<RecordedAgentResult> {
    const evidence = new RuntimeFacts("codex", sessionId, options.previousSessionUsage);
    let response: unknown; let failed = false;
    const stream = new RuntimeEventStream((event) => {
      evidence.observe(event);
      if (event.type === "turn.failed") failed = true;
      if (event.type === "item.completed" && jsonObject(event.item) && event.item.type === "agent_message" && typeof event.item.text === "string") {
        try { response = JSON.parse(event.item.text); } catch { response = event.item.text; }
      }
    });
    const timeoutMs = options.timeoutMs ?? this.timeoutMs; const signal = options.signal;
    let stop: RuntimeStop | undefined;
    const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let ownsProcessGroup = false;
    let tree: Promise<TrackedRun> | undefined; let treeTimer: ReturnType<typeof setInterval> | undefined;
    const abort = () => { stop ??= new RuntimeStop("Codex run cancelled.", "interrupted"); controller.abort(); };
    let progress: ReturnType<typeof codexProgress> | undefined;
    try {
      if (signal?.aborted) throw new RuntimeStop("Codex run cancelled.", "interrupted");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeStop("Codex timeout must be a positive number of milliseconds.");
      checkPromptSize(prompt);
      const base = this.envFor(childEnv());
      const env = this.home ? { ...base, CODEX_HOME: await ensureCodexHome(this.home, this.config) } : base;
      const sandbox = sandboxArgs(this.write);
      const args = sessionId ? ["exec", "resume", sessionId, "--json", "-c", "sandbox_mode=\"read-only\"", "-"] : ["exec", "--json", ...sandbox, "--output-schema", schemaPath, "-"];
      if (signal?.aborted) throw new RuntimeStop("Codex run cancelled.", "interrupted");
      timeout = setTimeout(() => { stop ??= new RuntimeStop(`Codex run timed out after ${minutes(timeoutMs)}.`, "timed-out"); controller.abort(); }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const child = spawn("codex", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", signal: controller.signal, env });
      ownsProcessGroup = process.platform !== "win32" && child.pid !== undefined;
      // Codex runs its commands in process groups of their own: track the whole tree and end it with the run.
      tree = ownedProcesses.track(child.pid);
      const tracked = tree;
      treeTimer = setInterval(() => { void tracked.then((run) => run.refresh()); }, TREE_REFRESH_MS);
      treeTimer.unref?.();
      controller.signal.addEventListener("abort", () => {
        killTimer = setTimeout(() => {
          // Codex's launcher gives its native child these pipes; killing only the launcher cannot drain them.
          try {
            if (ownsProcessGroup && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* already exited */ }
        }, 1000);
      }, { once: true });
      let stdoutBytes = 0; let stderrBytes = 0; let stderrTail = ""; let missingRollout = false;
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      progress = codexProgress({ purpose: options.purpose, cwd: this.cwd });
      const limit = (name: string) => { stop ??= new RuntimeStop(`Codex ${name} exceeded the output limit.`); controller.abort(); };
      child.stdout.on("data", (part: string) => {
        if (stdoutBytes > 10_000_000) return;
        stdoutBytes += Buffer.byteLength(part);
        if (stdoutBytes > 10_000_000) { limit("stdout"); return; }
        stream.push(part); if (!stop) progress?.push(part);
      });
      child.stderr.on("data", (part: string) => {
        if (stderrBytes > 100_000) return;
        stderrBytes += Buffer.byteLength(part);
        missingRollout ||= /no rollout found/i.test(stderrTail + part);
        stderrTail = part.slice(-32);
        if (stderrBytes > 100_000) limit("stderr");
      });
      const code = await new Promise<number | null>((resolve) => {
        // AbortError can precede the final stdout frames. Only close establishes that the pipes drained.
        child.on("error", (error: NodeJS.ErrnoException) => { stop ??= new RuntimeStop(error.code === "ENOENT" ? "Codex executable not found; install Codex and sign in before selecting it for a seat." : "Codex process failed; diagnostics withheld."); });
        child.on("close", resolve);
        child.stdin.on("error", () => { stop ??= new RuntimeStop("Codex could not read the prompt; diagnostics withheld."); controller.abort(); });
        child.stdin.end(prompt);
      });
      stream.end();
      if (stop) throw stop;
      if (code !== 0 && sessionId && this.home && missingRollout) throw new RuntimeStop(`Codex session ${evidence.sessionId ?? "(unknown)"} is not in this seat's harness home (it was started before seat harness isolation, or the home was removed); it cannot be resumed. Start a new goal.`);
      if (code !== 0) throw new RuntimeStop(`Codex run failed (${code ?? "cancelled"}); diagnostics withheld.`, code === null ? "interrupted" : "failed");
      if (failed) throw new RuntimeStop("Codex did not complete successfully; diagnostics withheld.");
      if (stream.malformed) throw new RuntimeStop("Codex returned malformed JSON output.");
      if (!evidence.sessionId || response === undefined) throw new RuntimeStop("Codex returned no session id or final response.");
      const facts = evidence.finish("succeeded");
      return { sessionId: evidence.sessionId, response, usage: facts.usage, startedAt: facts.startedAt, finishedAt: facts.finishedAt, facts };
    } catch (error) {
      stream.end();
      throw recordedError(stop ?? error, evidence);
    } finally {
      clearTimeout(timeout);
      // Owned descendants may outlive the launcher even after its pipes close.
      if (!ownsProcessGroup) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      clearInterval(treeTimer);
      if (tree) await tree.then((run) => run.end(1000)).catch(() => 0);
      progress?.end();
      if (this.home) await ensureCodexHome(this.home, this.config).catch(() => undefined);
    }
  }
}
export const planningId = () => `goal-${randomUUID().slice(0, 8)}`;
