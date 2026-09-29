/**
 * A read-only view of a seat's engine session, from the engine's own log:
 * - Claude: the session transcript `<id>.jsonl` under a `projects/<encoded cwd>/` directory of the seat's Claude
 *   harness home, `$CLAUDE_CONFIG_DIR` or `~/.claude`;
 * - Codex: the rollout `rollout-<time>-<id>.jsonl` under `sessions/YYYY/MM/DD/` of the seat's Codex harness home.
 *
 * The session is found by the ID Indra records (Chick's planning runtime record, or a Developer seat's task record).
 * While a run is still going its new session is not recorded yet, so the newest log in a place only this seat's runs
 * write (its Codex harness home, or the Claude project directory of its active worktree) counts too; the newest
 * file wins. Files are only ever opened for reading; nothing here writes to or resumes a session. Every text shown
 * goes through `redactSecrets` before it is cut to length.
 */
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { engineHome, seatHarnessDir } from "./harness-home.js";
import { sanitizePaneText } from "./pane-tail.js";
import { PlanningStore } from "./planning.js";

export type TranscriptEngine = "claude" | "codex";
export type TranscriptKind = "user" | "assistant" | "thinking" | "tool" | "result" | "error";
export interface TranscriptEntry { kind: TranscriptKind; label: string; text: string; at?: string }

/** Characters kept per entry, after redaction. */
export const ENTRY_LIMIT: Record<TranscriptKind, number> = { user: 600, assistant: 4000, thinking: 1500, tool: 600, result: 800, error: 1000 };

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Escapes and control characters removed, secrets redacted, then cut to `limit` characters. */
export function safeText(raw: string, limit: number): string {
  const clean = sanitizePaneText(raw, { lines: Number.MAX_SAFE_INTEGER, width: Number.MAX_SAFE_INTEGER }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const chars = Array.from(clean);
  return chars.length <= limit ? clean : chars.slice(0, limit).join("") + ` … (${chars.length - limit} more characters)`;
}

function entry(kind: TranscriptKind, label: string, raw: string | undefined, at?: string): TranscriptEntry[] {
  const text = safeText(raw ?? "", ENTRY_LIMIT[kind]);
  return text || kind === "tool" ? [{ kind, label: safeText(label, 80), text, ...(at ? { at } : {}) }] : [];
}

/** A tool call's input: the command for shell tools, otherwise compact JSON. */
function toolInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (object(input)) {
    const command = input.command ?? input.cmd;
    if (typeof command === "string") return command;
    if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  }
  try { return JSON.stringify(input) ?? ""; } catch { return ""; }
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => object(block) ? string(block.text) ?? "" : "").filter(Boolean).join("\n");
}

/** One line of a Claude session transcript (the same shapes as `--output-format stream-json`). */
export function claudeEntries(line: unknown): TranscriptEntry[] {
  if (!object(line) || line.isMeta === true) return [];
  const at = string(line.timestamp);
  if (line.type === "system") {
    return line.level === "error" || line.subtype === "api_error" ? entry("error", "Error", string(line.content) ?? toolInput(line.error), at) : [];
  }
  const message = object(line.message) ? line.message : undefined;
  if (!message) return [];
  if (line.type === "assistant") {
    if (line.isApiErrorMessage === true || line.error) return entry("error", "Error", blockText(message.content) || toolInput(line.error), at);
    if (!Array.isArray(message.content)) return entry("assistant", "Assistant", string(message.content), at);
    return message.content.flatMap((block): TranscriptEntry[] => {
      if (!object(block)) return [];
      if (block.type === "text") return entry("assistant", "Assistant", string(block.text), at);
      if (block.type === "thinking") return entry("thinking", "Thinking", string(block.thinking), at);
      if (block.type === "tool_use") return entry("tool", "Tool · " + (string(block.name) ?? "unknown"), toolInput(block.input), at);
      return [];
    });
  }
  if (line.type === "user") {
    if (typeof message.content === "string") return entry("user", "Prompt", message.content, at);
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((block): TranscriptEntry[] => {
      if (!object(block)) return [];
      if (block.type === "text") return entry("user", "Prompt", string(block.text), at);
      if (block.type === "tool_result") return block.is_error === true ? entry("error", "Tool error", blockText(block.content), at) : entry("result", "Result", blockText(block.content), at);
      return [];
    });
  }
  return [];
}

/** A Codex tool output: a plain string, or `{"output": …, "metadata": {"exit_code": …}}` as a JSON string. */
function codexOutput(value: unknown, at?: string): TranscriptEntry[] {
  let text = typeof value === "string" ? value : object(value) ? blockText(value.content) || toolInput(value) : "";
  let failed = false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (object(parsed) && typeof parsed.output === "string") {
      text = parsed.output;
      const code = object(parsed.metadata) ? parsed.metadata.exit_code : undefined;
      failed = typeof code === "number" && code !== 0;
    }
  } catch { /* plain text */ }
  return failed ? entry("error", "Tool error", text, at) : entry("result", "Result", text, at);
}

function codexArguments(value: unknown): string {
  if (typeof value !== "string") return toolInput(value);
  try { return toolInput(JSON.parse(value)); } catch { return value; }
}

const CONTEXT_PREFIX = /^\s*<(environment_context|user_instructions|permissions|developer_instructions)\b/;

/** One line of a Codex rollout: `{timestamp, type, payload}`; older rollouts hold the response item itself. */
export function codexEntries(line: unknown): TranscriptEntry[] {
  if (!object(line)) return [];
  const at = string(line.timestamp);
  const payload = object(line.payload) ? line.payload : undefined;
  if (line.type === "event_msg" && payload) {
    if (payload.type === "error" || payload.type === "stream_error") return entry("error", "Error", string(payload.message), at);
    if (payload.type === "turn_aborted") return entry("error", "Error", "Turn aborted: " + (string(payload.reason) ?? "unknown reason"), at);
    return [];
  }
  const item = line.type === "response_item" ? payload : payload ? undefined : line;
  if (!item) return [];
  switch (item.type) {
    case "message": {
      const text = blockText(item.content);
      if (item.role === "assistant") return entry("assistant", "Assistant", text, at);
      if (item.role === "user" && !CONTEXT_PREFIX.test(text)) return entry("user", "Prompt", text, at);
      return [];
    }
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? blockText(item.summary) : "";
      return entry("thinking", "Thinking", summary || blockText(item.content), at);
    }
    case "function_call": return entry("tool", "Tool · " + (string(item.name) ?? "unknown"), codexArguments(item.arguments), at);
    case "custom_tool_call": return entry("tool", "Tool · " + (string(item.name) ?? "unknown"), toolInput(item.input), at);
    case "local_shell_call": return entry("tool", "Tool · shell", toolInput(object(item.action) ? item.action : undefined), at);
    case "web_search_call": return entry("tool", "Tool · web search", object(item.action) ? string(item.action.query) : undefined, at);
    case "function_call_output":
    case "custom_tool_call_output": return codexOutput(item.output, at);
    default: return [];
  }
}

/** Parses JSONL text; malformed lines are skipped. */
export function parseTranscript(engine: TranscriptEngine, text: string): TranscriptEntry[] {
  const parse = engine === "claude" ? claudeEntries : codexEntries;
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return parse(JSON.parse(line)); } catch { return []; }
  });
}

/** How much of a long log is read when the view opens; older lines are skipped. */
export const INITIAL_BYTES = 4 * 1024 * 1024;

/** Reads a JSONL log from where it last stopped; a partial last line waits for the next read. Opens read-only. */
export class TranscriptTail {
  private offset = -1;
  private pending = Buffer.alloc(0);
  constructor(readonly path: string, readonly engine: TranscriptEngine, private readonly initialBytes = INITIAL_BYTES) {}

  async read(): Promise<TranscriptEntry[]> {
    const file = await open(this.path, "r");
    try {
      const { size } = await file.stat();
      let skipFirstLine = false;
      if (this.offset < 0 || size < this.offset) {
        // First read, or the file was replaced: start near the end of a long log.
        this.offset = Math.max(0, size - this.initialBytes);
        skipFirstLine = this.offset > 0;
        this.pending = Buffer.alloc(0);
      }
      if (size === this.offset) return [];
      const chunk = Buffer.alloc(size - this.offset);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
      this.offset += bytesRead;
      let data = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
      if (skipFirstLine) { const newline = data.indexOf(0x0a); data = newline < 0 ? Buffer.alloc(0) : data.subarray(newline + 1); }
      const end = data.lastIndexOf(0x0a);
      this.pending = Buffer.from(end < 0 ? data : data.subarray(end + 1));
      return end < 0 ? [] : parseTranscript(this.engine, data.subarray(0, end).toString("utf8"));
    } finally { await file.close(); }
  }
}

export interface TranscriptLocation { engine: TranscriptEngine; sessionId: string; path: string }
export interface TranscriptSeat { id: string; roles: string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An engine-qualified session handle as Indra records it: `claude:<uuid>`, or a bare Codex ID. */
export function parseSessionHandle(handle: string | undefined): { engine: TranscriptEngine; id: string } | undefined {
  if (!handle) return undefined;
  if (handle.startsWith("claude:")) { const id = handle.slice(7); return UUID.test(id) ? { engine: "claude", id } : undefined; }
  return UUID.test(handle) ? { engine: "codex", id: handle } : undefined;
}

/** Claude names a project directory after its cwd with every other character than a letter or digit as `-`. */
export const claudeProjectDir = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

async function isFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined))?.isFile() ?? false;
}
async function entries(dir: string): Promise<string[]> { return await readdir(dir).catch(() => []); }
async function mtime(path: string): Promise<number> { return (await lstat(path).catch(() => undefined))?.mtimeMs ?? 0; }

/** The newest `.jsonl` directly in `dir`. */
async function newestLog(dir: string, accept: (name: string) => boolean = () => true): Promise<string | undefined> {
  let best: { path: string; at: number } | undefined;
  for (const name of await entries(dir)) {
    if (!name.endsWith(".jsonl") || !accept(name)) continue;
    const path = join(dir, name);
    if (!await isFile(path)) continue;
    const at = await mtime(path);
    if (!best || at > best.at) best = { path, at };
  }
  return best?.path;
}

/** The newest date directories under a Codex `sessions/` tree, newest first. */
async function codexDays(sessions: string, limit: number): Promise<string[]> {
  const days: string[] = [];
  const numeric = (names: string[]) => names.filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
  for (const year of numeric(await entries(sessions))) {
    for (const month of numeric(await entries(join(sessions, year)))) {
      for (const day of numeric(await entries(join(sessions, year, month)))) {
        days.push(join(sessions, year, month, day));
        if (days.length >= limit) return days;
      }
    }
  }
  return days;
}

/** A Developer seat's newest task record: its active worktree and last recorded session. */
async function seatTask(runtimeDir: string, seatId: string): Promise<{ worktree?: string; sessionId?: string } | undefined> {
  const name = new RegExp(`^seat-${seatId}-goal-[a-z0-9]+-.+\\.json$`);
  let newest: { path: string; at: number } | undefined;
  for (const file of await entries(runtimeDir)) {
    if (!name.test(file)) continue;
    const path = join(runtimeDir, file);
    const at = await mtime(path);
    if (!newest || at > newest.at) newest = { path, at };
  }
  if (!newest) return undefined;
  try {
    const record = JSON.parse(await readFile(newest.path, "utf8")) as { worktree?: unknown; sessions?: unknown };
    const worktree = typeof record.worktree === "string" && resolve(record.worktree).startsWith(join(runtimeDir, "worktrees") + "/") ? record.worktree : undefined;
    const sessions = Array.isArray(record.sessions) ? record.sessions : [];
    const last = sessions.at(-1) as { sessionId?: unknown } | undefined;
    return { worktree, sessionId: typeof last?.sessionId === "string" ? last.sessionId : undefined };
  } catch { return undefined; }
}

/** Finds the log of a seat's current engine session in the checkout's runtime directory and the engines' homes. */
export class TranscriptLocator {
  readonly runtimeDir: string;
  private readonly store: PlanningStore;
  private readonly found = new Map<string, string>();
  constructor(checkout: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly home = homedir()) {
    this.runtimeDir = `${resolve(checkout)}.runtime`;
    this.store = new PlanningStore(checkout);
  }

  /** Where Claude keeps `projects/`: the seat's harness home, then the configured and default Claude homes. */
  claudeRoots(seatId: string): string[] {
    const roots = [join(engineHome(seatHarnessDir(this.runtimeDir, seatId), "claude"), "projects")];
    if (this.env.CLAUDE_CONFIG_DIR) roots.push(join(this.env.CLAUDE_CONFIG_DIR, "projects"));
    roots.push(join(this.home, ".claude", "projects"));
    return [...new Set(roots)];
  }

  codexSessions(seatId: string): string { return join(engineHome(seatHarnessDir(this.runtimeDir, seatId), "codex"), "sessions"); }

  /** The log of a recorded session, searched only by its exact file name. */
  async recorded(seatId: string, handle: string | undefined): Promise<TranscriptLocation | undefined> {
    const session = parseSessionHandle(handle);
    if (!session) return undefined;
    const key = `${seatId}:${session.engine}:${session.id}`;
    const cached = this.found.get(key);
    if (cached && await isFile(cached)) return { engine: session.engine, sessionId: session.id, path: cached };
    let path: string | undefined;
    if (session.engine === "claude") {
      for (const root of this.claudeRoots(seatId)) {
        for (const project of await entries(root)) {
          const candidate = join(root, project, `${session.id}.jsonl`);
          if (await isFile(candidate)) { path = candidate; break; }
        }
        if (path) break;
      }
    } else {
      for (const day of await codexDays(this.codexSessions(seatId), 400)) {
        const name = (await entries(day)).find((file) => file.startsWith("rollout-") && file.endsWith(`-${session.id}.jsonl`));
        if (name && await isFile(join(day, name))) { path = join(day, name); break; }
      }
    }
    if (!path) return undefined;
    this.found.set(key, path);
    return { engine: session.engine, sessionId: session.id, path };
  }

  /** The newest log only this seat's runs write: its Codex harness home, or its active worktree's Claude project. */
  async live(seatId: string, worktree: string | undefined, ownProjects = false): Promise<TranscriptLocation[]> {
    const found: TranscriptLocation[] = [];
    for (const day of await codexDays(this.codexSessions(seatId), 2)) {
      const path = await newestLog(day, (name) => name.startsWith("rollout-"));
      const id = path && /-([0-9a-f-]{36})\.jsonl$/i.exec(path)?.[1];
      if (path && id) { found.push({ engine: "codex", sessionId: id, path }); break; }
    }
    if (worktree) {
      const cwds = new Set([worktree, await realpath(worktree).catch(() => worktree)]);
      for (const root of this.claudeRoots(seatId)) {
        for (const cwd of cwds) {
          const path = await newestLog(join(root, claudeProjectDir(cwd)), (name) => UUID.test(name.slice(0, -".jsonl".length)));
          if (path) found.push({ engine: "claude", sessionId: path.slice(-42, -6), path });
        }
      }
    }
    if (ownProjects) {
      // Finite Product/goal runs have no public session handles. Search only this seat's isolated harness.
      const root = this.claudeRoots(seatId)[0];
      for (const project of await entries(root)) {
        const path = await newestLog(join(root, project), (name) => UUID.test(name.slice(0, -".jsonl".length)));
        if (path) found.push({ engine: "claude", sessionId: path.slice(-42, -6), path });
      }
    }
    return found;
  }

  /**
   * The seat's current session log: the newest of the recorded session's log and, for a Developer seat, the newest
   * log of its active work. `recordedHandle` is Chick's recorded planning session for a Team Lead seat.
   */
  async locate(seat: TranscriptSeat, recordedHandle?: string): Promise<TranscriptLocation | undefined> {
    if (!/^[a-z][a-z0-9-]+$/.test(seat.id)) return undefined;
    const candidates: TranscriptLocation[] = [];
    const lead = seat.roles.includes("Team Lead");
    const product = seat.roles.includes("Product");
    const state = await this.store.read().catch(() => undefined);
    const goal = state?.planningGoals?.some((goal) => goal.workflowModel === "goals-v1" && !goal.ceremony?.closure && goal.goalAssignment?.seatId === seat.id && goal.goalAssignment.status !== "reported");
    const task = !lead && !product && !goal ? await seatTask(this.runtimeDir, seat.id) : undefined;
    const recorded = await this.recorded(seat.id, lead ? recordedHandle : task?.sessionId ?? recordedHandle);
    if (recorded) candidates.push(recorded);
    candidates.push(...await this.live(seat.id, task?.worktree, product || goal));
    let best: { location: TranscriptLocation; at: number } | undefined;
    for (const location of candidates) {
      const at = await mtime(location.path);
      if (!best || at > best.at) best = { location, at };
    }
    return best?.location;
  }
}

export type TranscriptPoll =
  | { status: "ok"; location: TranscriptLocation; entries: TranscriptEntry[]; reset: boolean }
  | { status: "none" }
  | { status: "error"; message: string };

/** One open transcript view: follows the seat's current session, re-locating it every few seconds. */
export interface TranscriptFeed { poll(): Promise<TranscriptPoll> }
export interface TranscriptSource { feed(seat: TranscriptSeat, recordedHandle: () => string | undefined): TranscriptFeed }

export class LocalTranscriptSource implements TranscriptSource {
  constructor(private readonly locator: TranscriptLocator, private readonly relocateMs = 5000, private readonly now = () => Date.now()) {}

  feed(seat: TranscriptSeat, recordedHandle: () => string | undefined): TranscriptFeed {
    let tail: TranscriptTail | undefined;
    let location: TranscriptLocation | undefined;
    let locatedAt = -Infinity;
    return {
      poll: async (): Promise<TranscriptPoll> => {
        try {
          if (this.now() - locatedAt >= this.relocateMs) {
            locatedAt = this.now();
            location = await this.locator.locate(seat, recordedHandle());
          }
          if (!location) return { status: "none" };
          const reset = tail?.path !== location.path;
          if (reset) tail = new TranscriptTail(location.path, location.engine);
          return { status: "ok", location, entries: await tail!.read(), reset };
        } catch (error) {
          return { status: "error", message: safeText(error instanceof Error ? error.message : String(error), 200) };
        }
      },
    };
  }
}
