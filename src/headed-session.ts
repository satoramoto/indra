/**
 * Headed seat sessions: each task runs the engine's normal interactive CLI in the seat's own Indra-owned tmux pane,
 * so the owner who attaches sees exactly what they would see running Claude Code or Codex themselves, and can type
 * into the real session.
 *
 * The hosted seat process (`seat run` or `planning serve`) owns its pane's terminal. A headed run spawns the CLI as its
 * child with the pane's terminal as stdin, stdout and stderr, in the same (foreground) process group, so the owner's
 * keystrokes reach the CLI. Nothing here runs tmux commands, so no other tmux session or pane is ever touched.
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
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RuntimeStop, type RuntimeFacts } from "./runtime-facts.js";

/** Set to `1` by TmuxHost in the command of every hosted seat pane. */
export const SEAT_PANE_VARIABLE = "INDRA_SEAT_PANE";
/** Any non-empty value other than `0` or `false` keeps every task headless, as before headed sessions. */
export const HEADLESS_VARIABLE = "INDRA_HEADLESS";
/** The task and result files live here, relative to the task's working directory. */
export const TASK_DIR = ".indra";

/** Poll interval for the result and session log, how long a CLI may take to start a session, and the SIGTERM-to-SIGKILL grace. */
export const headedTiming = { pollMs: 1000, startupMs: 120_000, killGraceMs: 3000 };

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
  /** Whether the CLI has started its session (its session log exists). */
  started(): Promise<boolean>;
  timeoutMs: number;
  signal?: AbortSignal;
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
    child = spawn(spec.launch.command, spec.launch.args, { cwd: spec.cwd, stdio: "inherit", env: spec.launch.env });
  } catch { await cleanup(files); throw new RuntimeStop(`${label} could not be started; check the executable and working directory.`); }
  // In raw mode Ctrl-C reaches the CLI as a key; before and after, it must not stop the seat process that waits for it.
  const ignoreInterrupt = () => undefined;
  process.on("SIGINT", ignoreInterrupt);
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  let running = true; void exited.then(() => { running = false; });
  let spawnError: NodeJS.ErrnoException | undefined;
  child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
  const startedAt = Date.now();
  let seenStart = false; let previous: string | undefined;
  try {
    for (;;) {
      if (spec.signal?.aborted) throw new RuntimeStop(`${label} run cancelled.`, "interrupted");
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
        seenStart = await spec.started().catch(() => false);
        if (!seenStart && Date.now() - startedAt >= headedTiming.startupMs) throw new HeadedStartError(`${label} did not start a headed session within ${Math.round(headedTiming.startupMs / 1000)} s.`);
      }
      await waitFor(headedTiming.pollMs, exited, spec.signal);
    }
  } finally {
    if (running) {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      const escalate = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, headedTiming.killGraceMs);
      await exited; clearTimeout(escalate);
    }
    process.removeListener("SIGINT", ignoreInterrupt);
    resetTerminal();
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
