/**
 * Headed seat sessions: each task runs the engine's normal interactive CLI in the seat's own Indra-owned tmux pane,
 * so the owner who attaches sees exactly what they would see running Claude Code or Codex themselves, and can type
 * into the real session.
 *
 * The hosted seat process (`seat run` or `planning serve`) owns its pane's terminal. A headed run spawns the CLI as its
 * child with the pane's terminal as stdin, stdout and stderr, in the same (foreground) process group, so the owner's
 * keystrokes reach the CLI. Nothing here runs tmux commands, so no other tmux session or pane is ever touched. The
 * CLI's tools run in process groups of their own, so the CLI's whole process tree is tracked while it runs and ended
 * with it (process-tree.ts), however the run ends.
 *
 * The task is a file: Indra writes the prompt, plus the result schema and where to write the result, to
 * `.indra/task-<id>.md` in the task's working directory (git-ignored by `.indra/.gitignore`, never committed) and starts
 * the CLI with the short first message "Read .indra/task-<id>.md and do it.". The result is a file: Indra waits for
 * `.indra/result-<id>.json`, validates it against the step's output schema, then ends that CLI session, so the next task
 * starts fresh. The owner interrupting the agent is not a failure; only the CLI exiting without a valid result, an
 * invalid result or the timeout is.
 *
 * Headed runs happen only in a hosted seat pane (`INDRA_SEAT_PANE=1`, set by TmuxHost) with a terminal on stdin and
 * stdout, only one at a time per process, and never when `INDRA_HEADLESS` is set. If the CLI never starts a session
 * (no session log within `headedTiming.startupMs`, e.g. a first-run dialog), Indra ends it and the runtime falls back
 * to its headless mode for that task.
 *
 * While the CLI owns the pane, this process's own console lines are held and printed once the run ends, so they never
 * draw over the CLI's screen, and a headed-run marker (headedMarkerFile) tells the UI that the owner may drive the
 * session (`D`) and where its session log is, for live token totals.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { LiveUsageTail } from "./live-usage.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RuntimeStop, type RuntimeFacts } from "./runtime-facts.js";
import { ownedProcesses, TREE_REFRESH_MS, type OwnedProcesses } from "./process-tree.js";

/** Set to `1` by TmuxHost in the command of every hosted seat pane. */
export const SEAT_PANE_VARIABLE = "INDRA_SEAT_PANE";
/** Any non-empty value other than `0` or `false` keeps every task headless, as before headed sessions. */
export const HEADLESS_VARIABLE = "INDRA_HEADLESS";
/** The task and result files live here, relative to the task's working directory. */
export const TASK_DIR = ".indra";

/**
 * Poll interval for the result and session log, how long a CLI may take to start a session, the SIGTERM-to-SIGKILL
 * grace, and how often the CLI's process tree is snapshotted.
 */
export const headedTiming = { pollMs: 1000, startupMs: 120_000, killGraceMs: 3000, treeMs: TREE_REFRESH_MS };

const truthy = (value: string | undefined) => !!value && !/^(0|false|no|off)$/i.test(value.trim());

/** Whether this process may run a headed session: a hosted seat pane with a terminal, and headless not requested. */
export function headedAvailable(env: NodeJS.ProcessEnv = process.env, stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return env[SEAT_PANE_VARIABLE] === "1" && !truthy(env[HEADLESS_VARIABLE]) && !!stdin.isTTY && !!stdout.isTTY;
}

let busy = false;
/** The pane has one terminal: a second concurrent run in the same process gets undefined and runs headless. */
export function claimHeaded(): (() => void) | undefined {
  if (busy) return undefined;
  busy = true;
  let released = false;
  return () => { if (!released) { released = true; busy = false; } };
}

/**
 * The headed-run marker of one hosted process: `<state-checkout>.runtime/headed-<ready nonce>.json`. The nonce is the
 * one in the process's verified tmux ownership record, so the UI finds the marker only through that record. It holds
 * the process ID, the engine and, once the CLI started, its session log path; it exists only while a headed run owns
 * the pane. Runtime metadata, never in Git, never a credential.
 */
export function headedMarkerFile(stateCheckout: string, readyNonce: string): string {
  if (!/^[a-f0-9-]{36}$/.test(readyNonce)) throw new Error("Invalid ready nonce for a headed-run marker.");
  return join(`${resolve(stateCheckout)}.runtime`, `headed-${readyNonce}.json`);
}

export interface HeadedMarker { pid: number; engine: "claude" | "codex"; startedAt: string; log?: string }

let markerFile: string | undefined;
/** Set once by a hosted process (`seat run` or `planning serve` with `--ready-nonce`); every headed run then keeps the marker. */
export function useHeadedMarker(file: string | undefined): void { markerFile = file; }

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** The marker of a headed run that is still going: its process is alive. A marker a crashed process left counts as none. */
export async function readHeadedMarker(file: string, alive: (pid: number) => boolean = pidAlive): Promise<HeadedMarker | undefined> {
  try {
    const marker = JSON.parse(await readFile(file, "utf8")) as Partial<HeadedMarker>;
    if (typeof marker.pid !== "number" || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !alive(marker.pid)) return undefined;
    if (marker.engine !== "claude" && marker.engine !== "codex") return undefined;
    return { pid: marker.pid, engine: marker.engine, startedAt: typeof marker.startedAt === "string" ? marker.startedAt : "", ...(typeof marker.log === "string" && marker.log.endsWith(".jsonl") ? { log: marker.log } : {}) };
  } catch { return undefined; }
}

async function writeMarker(file: string, marker: HeadedMarker): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(marker), { mode: 0o600 });
  await rename(temp, file);
}

/** Console lines kept while a headed run owns the pane; later ones are counted and dropped. */
export const HELD_LINES = 500;
const CONSOLE_METHODS = ["log", "info", "warn", "error"] as const;
type HeldConsole = Pick<Console, typeof CONSOLE_METHODS[number]>;

/**
 * While a headed CLI owns the pane, this process's own log lines would be drawn over the CLI's screen. Holds every
 * console line instead, and returns the release: it restores the console and prints the held lines, in order.
 */
export function holdConsole(target: HeldConsole = console): () => void {
  const original = { log: target.log, info: target.info, warn: target.warn, error: target.error };
  const held: { method: typeof CONSOLE_METHODS[number]; args: unknown[] }[] = [];
  let dropped = 0;
  for (const method of CONSOLE_METHODS) {
    target[method] = (...args: unknown[]) => { if (held.length < HELD_LINES) held.push({ method, args }); else dropped++; };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    Object.assign(target, original);
    for (const { method, args } of held) original[method].apply(target, args);
    if (dropped) original.log.call(target, `(${dropped} more log lines from the headed run were dropped.)`);
  };
}

export interface TaskFiles { id: string; task: string; result: string; taskRel: string; resultRel: string }

/** Creates `.indra/` with a `.gitignore` that ignores everything in it, and names this task's files. */
export async function prepareTaskFiles(cwd: string): Promise<TaskFiles> {
  const dir = join(cwd, TASK_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, ".gitignore");
  if (await readFile(ignore, "utf8").catch(() => undefined) !== "*\n") await writeFile(ignore, "*\n", { mode: 0o600 });
  const id = randomUUID().slice(0, 8);
  const taskRel = `${TASK_DIR}/task-${id}.md`; const resultRel = `${TASK_DIR}/result-${id}.json`;
  return { id, task: join(cwd, taskRel), result: join(cwd, resultRel), taskRel, resultRel };
}

/** The task file: the step's prompt, then where and in what shape to write the result. */
export function taskDocument(prompt: string, schema: object, files: TaskFiles): string {
  return `${prompt.trimEnd()}\n\n---\n\n## When you are done\n\nWrite your final result as one JSON document to \`${files.resultRel}\` (absolute path: \`${files.result}\`). It must match this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n\nWrite that file once, as your very last action, after all other work is finished. Indra reads and validates it, then ends this session. Do not stage, commit or delete anything under \`${TASK_DIR}/\`; it is git-ignored and Indra removes it.\n`;
}

/** The first message typed into the interactive CLI. */
export const firstMessage = (files: TaskFiles) => `Read ${files.taskRel} and do it.`;

/** Compiles the step's output schema the same way for both engines. */
export function resultValidator(schema: object): (value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  return (value) => validate(value) === true;
}

export interface HeadedLaunch { command: string; args: string[]; env: NodeJS.ProcessEnv }
export interface HeadedSpec {
  /** "Claude" or "Codex", for messages. */
  label: string;
  cwd: string;
  files: TaskFiles;
  validate(value: unknown): boolean;
  launch: HeadedLaunch;
  /** The CLI's session log once it has started its session; undefined before. */
  started(): Promise<string | undefined>;
  /** Incremental log accounting, using the same collector as final evidence. */
  facts?: RuntimeFacts;
  onUsage?: () => void;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The headed-run marker; defaults to the one set by useHeadedMarker. */
  marker?: string;
  /** The console held while the CLI owns the pane; defaults to the global console. */
  console?: HeldConsole;
  /** Tracks and ends the CLI's process tree; defaults to this process's ownedProcesses. */
  owned?: Pick<OwnedProcesses, "track">;
}

/** The CLI never started a session; the caller may run the task headless instead. Nothing was sent to a model. */
export class HeadedStartError extends RuntimeStop {}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Leaves the alternate screen, shows the cursor and turns off modes a killed TUI may leave on, then restores line discipline. */
function resetTerminal(): void {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[<u\x1b[0m\r\n");
    spawnSync("stty", ["sane"], { stdio: "inherit" });
  } catch { /* best effort */ }
}

/**
 * Runs one headed task and resolves with its validated result. Rejects with a RuntimeStop: `timed-out` after
 * `timeoutMs`, `interrupted` when `signal` aborts, HeadedStartError when no session started, `failed` otherwise.
 * Always ends the CLI and removes the task and result files.
 */
export async function runHeaded(spec: HeadedSpec): Promise<unknown> {
  const { label, files } = spec;
  if (spec.signal?.aborted) throw new RuntimeStop(`${label} run cancelled.`, "interrupted");
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new RuntimeStop(`${label} timeout must be a positive number of milliseconds.`);
  let child: ChildProcess;
  try {
    // Same process group as this hosted process, which is the pane's foreground group: the CLI can read the terminal.
    // Its tools run in groups of their own, so the whole tree is tracked and ended with the run (process-tree.ts).
    child = spawn(spec.launch.command, spec.launch.args, { cwd: spec.cwd, stdio: "inherit", env: spec.launch.env });
  } catch { await cleanup(files); throw new RuntimeStop(`${label} could not be started; check the executable and working directory.`); }
  const owned = spec.owned ?? ownedProcesses;
  const tree = await owned.track(child.pid);
  let treeAt = Date.now();
  // From here the CLI owns the pane: this process's log lines wait until it ends, and the marker says a headed run is on.
  const releaseConsole = holdConsole(spec.console);
  const marker = spec.marker ?? markerFile;
  const markerState: HeadedMarker = { pid: process.pid, engine: label.toLowerCase() === "codex" ? "codex" : "claude", startedAt: new Date().toISOString() };
  if (marker) await writeMarker(marker, markerState).catch(() => undefined);
  // In raw mode Ctrl-C reaches the CLI as a key; before and after, it must not stop the seat process that waits for it.
  const ignoreInterrupt = () => undefined;
  process.on("SIGINT", ignoreInterrupt);
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  let running = true; void exited.then(() => { running = false; });
  let spawnError: NodeJS.ErrnoException | undefined;
  child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
  const startedAt = Date.now();
  let seenStart = false; let previous: string | undefined; let tail: LiveUsageTail | undefined;
  try {
    for (;;) {
      if (spec.signal?.aborted) throw new RuntimeStop(`${label} run cancelled.`, "interrupted");
      if (tail) { await tail.read().catch(() => undefined); spec.onUsage?.(); }
      const text = await readFile(files.result, "utf8").catch(() => undefined);
      // A file that stopped changing between two polls is complete; one that fails then is a real answer, not a partial write.
      if (text !== undefined && (text === previous || !running)) return parsed(text, spec);
      previous = text;
      if (!running) {
        if (spawnError) throw new RuntimeStop(spawnError.code === "ENOENT" ? `${label} executable not found; install it and sign in before selecting it for a seat.` : `${label} process failed; diagnostics withheld.`);
        throw new RuntimeStop(`${label} session ended without writing its result file.`);
      }
      if (Date.now() - startedAt >= spec.timeoutMs) throw new RuntimeStop(`${label} run timed out after ${minutes(spec.timeoutMs)}.`, "timed-out");
      if (!seenStart) {
        const log = await spec.started().catch(() => undefined);
        seenStart = !!log;
        if (log && spec.facts) { tail = new LiveUsageTail(log, spec.facts.engine, undefined, spec.facts); await tail.read().catch(() => undefined); spec.onUsage?.(); }
        if (log && marker) await writeMarker(marker, { ...markerState, log }).catch(() => undefined);
        if (!seenStart && Date.now() - startedAt >= headedTiming.startupMs) throw new HeadedStartError(`${label} did not start a headed session within ${Math.round(headedTiming.startupMs / 1000)} s.`);
      }
      if (Date.now() - treeAt >= headedTiming.treeMs) { treeAt = Date.now(); await tree.refresh(); }
      await waitFor(headedTiming.pollMs, exited, spec.signal);
    }
  } finally {
    // The CLI and everything it started end together: its own tools, background jobs and their process groups.
    if (running) await tree.refresh();
    await tree.end(headedTiming.killGraceMs);
    if (running) {
      // Not found by `ps` (or `ps` failed): end the CLI itself, as before.
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      const escalate = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, headedTiming.killGraceMs);
      await exited; clearTimeout(escalate);
    }
    process.removeListener("SIGINT", ignoreInterrupt);
    if (marker) await rm(marker, { force: true }).catch(() => undefined);
    resetTerminal();
    releaseConsole();
    await cleanup(files);
  }
}

function parsed(text: string, spec: HeadedSpec): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RuntimeStop(`${spec.label} wrote a result file that is not valid JSON.`); }
  if (!spec.validate(value)) throw new RuntimeStop(`${spec.label} wrote a result that does not match the output schema.`);
  return value;
}

function waitFor(ms: number, exited: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
    void exited.then(done);
  });
}

/** Feeds a session log's usage and session ID into the run's facts. The log's contents go no further. */
export async function readLog(file: string | undefined, evidence: RuntimeFacts): Promise<void> {
  if (!file) return;
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { evidence.observeLog(JSON.parse(line)); } catch { /* a partial last line */ }
  }
}

async function cleanup(files: TaskFiles): Promise<void> {
  await Promise.all([rm(files.task, { force: true }), rm(files.result, { force: true })]).catch(() => undefined);
}
