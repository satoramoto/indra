import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { codexProgress } from "./codex-progress.js";
import { DEVELOPER_CODEX_CONFIG, ensureCodexHome } from "./harness-home.js";
import { childEnv } from "./op-env.js";
import { RuntimeEventStream, RuntimeFacts, RuntimeStop, jsonObject, recordedError, type RuntimeSessionFacts, type TokenUsage } from "./runtime-facts.js";

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
 * Uses the logged-in Codex CLI and an explicit session id; never uses --last. Read-only unless given write access.
 * With `home`, Codex runs with `CODEX_HOME` set to that Indra-owned seat home (see harness-home.ts), so it loads
 * none of the owner's personal configuration and keeps its sessions there.
 */
export class CodexRuntime implements AgentRuntime {
  constructor(private readonly cwd: string, private readonly timeoutMs = CLARIFY_TIMEOUT_MS, private readonly write?: WriteAccess, private readonly home?: string, private readonly config: string = DEVELOPER_CODEX_CONFIG) {}
  async message(prompt: string, schemaPath: string, sessionId?: string, options: MessageOptions = {}): Promise<RecordedAgentResult> {
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
    const abort = () => { stop ??= new RuntimeStop("Codex run cancelled.", "interrupted"); controller.abort(); };
    let progress: ReturnType<typeof codexProgress> | undefined;
    try {
      if (signal?.aborted) throw new RuntimeStop("Codex run cancelled.", "interrupted");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeStop("Codex timeout must be a positive number of milliseconds.");
      checkPromptSize(prompt);
      const env = this.home ? { ...childEnv(), CODEX_HOME: await ensureCodexHome(this.home, this.config) } : childEnv();
      const sandbox = sandboxArgs(this.write);
      const args = sessionId ? ["exec", "resume", sessionId, "--json", "-c", "sandbox_mode=\"read-only\"", "-"] : ["exec", "--json", ...sandbox, "--output-schema", schemaPath, "-"];
      if (signal?.aborted) throw new RuntimeStop("Codex run cancelled.", "interrupted");
      timeout = setTimeout(() => { stop ??= new RuntimeStop(`Codex run timed out after ${minutes(timeoutMs)}.`, "timed-out"); controller.abort(); }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const child = spawn("codex", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", signal: controller.signal, env });
      ownsProcessGroup = process.platform !== "win32" && child.pid !== undefined;
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
      progress?.end();
      if (this.home) await ensureCodexHome(this.home, this.config).catch(() => undefined);
    }
  }
}
export const planningId = () => `goal-${randomUUID().slice(0, 8)}`;
