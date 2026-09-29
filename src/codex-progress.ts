import { redactSecrets } from "./redact.js";

/**
 * Live, readable progress for a `codex exec --json` run, printed to the running process's stdout (and so to its
 * tmux pane). One short, timestamped, redacted line per meaningful JSONL event; unknown or unparseable events are
 * ignored. Event shapes follow codex-cli 0.156.1 (`thread.started`, `turn.started`, `turn.completed` with `usage`,
 * `turn.failed`, `error`, and `item.started`/`item.updated`/`item.completed` wrapping an `item` with a `type`).
 *
 * Every line reads `HH:MM <mark> <text>`. The mark is one character that says what kind of line it is, so the
 * terminal UI can colour the line after `pane-tail` strips escapes, while the pane itself stays plain text.
 * Commands, tool calls and failed file changes put their status right after the mark (`✓`, `✗` or `✗<exit code>`)
 * so a cut at the end of a narrow column never hides it.
 */

/** Longest printed line, including the time and mark. */
export const MAX_PROGRESS_LINE = 200;

/** A command still running after this long gets a start line; others print once, when they finish. */
export const SLOW_COMMAND_MS = 5000;

/** The leading mark of each kind of progress line. The live pane panel colours lines by these. */
export const PROGRESS_MARK = {
  purpose: "#",
  thinking: "~",
  agent: "›",
  command: "$",
  tool: "»",
  files: "±",
  info: "·",
  error: "!",
} as const;
export type ProgressKind = keyof typeof PROGRESS_MARK;

/** Status tokens that follow the mark on command, tool and file lines. */
export const STATUS = { ok: "✓", failed: "✗", running: "…" } as const;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const oneLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line) ?? "";
/** A progress line's mark and text, before the time is added. */
export const line = (kind: ProgressKind, text: string) => `${PROGRESS_MARK[kind]} ${text}`;

/** Splits a stream of text chunks into complete lines, holding back a trailing partial line until it completes. */
export class LineSplitter {
  private rest = "";
  push(chunk: string): string[] {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/, ""));
  }
  /** Returns the final unterminated line, if any. */
  flush(): string[] {
    const rest = this.rest; this.rest = "";
    return rest.trim() ? [rest] : [];
  }
}

const SHELL = String.raw`(?:\S*\/)?(?:ba|z)?sh`;

/** Drops the `/bin/zsh -lc '...'` (or `"..."`) wrapper Codex puts around shell commands, and its quoting. */
export function shellCommand(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string");
    const wrapped = parts.length === 3 && new RegExp(`^${SHELL}$`).test(parts[0]) && /^-l?c$/.test(parts[1]);
    return oneLine(wrapped ? parts[2] : parts.join(" "));
  }
  const text = str(value) ?? "";
  const wrapped = new RegExp(String.raw`^${SHELL} -l?c (?:'([\s\S]*)'|"([\s\S]*)"|([\s\S]*))$`).exec(text);
  if (!wrapped) return oneLine(text);
  if (wrapped[1] !== undefined) return oneLine(wrapped[1].replace(/'\\''/g, "'"));
  if (wrapped[2] !== undefined) return oneLine(wrapped[2].replace(/\\(["\\$`])/g, "$1"));
  return oneLine(wrapped[3] ?? "");
}

export function relative(path: string, cwd?: string): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function usage(value: unknown): string {
  if (!isObject(value)) return "";
  const n = (key: string) => (typeof value[key] === "number" ? value[key] as number : undefined);
  const parts = [["in", n("input_tokens")], ["cached", n("cached_input_tokens")], ["out", n("output_tokens")], ["reasoning", n("reasoning_output_tokens")]]
    .filter((part): part is [string, number] => part[1] !== undefined).map(([label, count]) => `${label} ${count}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** `✓` for exit 0, `✗<code>` for any other exit, else from the item's status. */
function commandStatus(value: Json): string {
  if (typeof value.exit_code === "number") return value.exit_code === 0 ? STATUS.ok : `${STATUS.failed}${value.exit_code}`;
  return value.status === "completed" ? STATUS.ok : STATUS.failed;
}

function item(phase: "started" | "updated" | "completed", value: Json, cwd?: string): string | undefined {
  switch (value.type) {
    case "agent_message":
      return phase === "completed" && str(value.text) ? line("agent", oneLine(value.text as string)) : undefined;
    case "reasoning": {
      const hint = oneLine(str(value.text) ?? "").replace(/\*\*/g, "");
      return phase === "completed" && hint ? line("thinking", hint.slice(0, 80)) : undefined;
    }
    case "command_execution":
      // Printed once, on completion; a slow command's start line comes from codexProgress's timer.
      return phase === "completed" ? line("command", `${commandStatus(value)} ${shellCommand(value.command)}`) : undefined;
    case "file_change": {
      if (phase !== "completed" || !Array.isArray(value.changes)) return undefined;
      const changes = value.changes.filter(isObject).map((change) => `${str(change.kind) ?? "edit"} ${relative(str(change.path) ?? "?", cwd)}`);
      return changes.length ? line("files", `${value.status === "failed" ? `${STATUS.failed} ` : ""}${changes.join(", ")}`) : undefined;
    }
    case "mcp_tool_call": {
      if (phase !== "completed") return undefined;
      const name = [str(value.server), str(value.tool)].filter(Boolean).join(".") || "tool";
      return line("tool", `${value.status === "failed" || isObject(value.error) ? STATUS.failed : STATUS.ok} ${name}`);
    }
    case "web_search":
      return phase === "completed" && str(value.query) ? line("tool", `search ${oneLine(value.query as string)}`) : undefined;
    case "todo_list": {
      if (!Array.isArray(value.items)) return undefined;
      const items = value.items.filter(isObject);
      const done = items.filter((entry) => entry.completed === true).length;
      const next = items.find((entry) => entry.completed !== true);
      return line("info", `todo ${done}/${items.length}${next && str(next.text) ? `, next: ${oneLine(next.text as string)}` : ""}`);
    }
    case "error":
      return str(value.message) ? line("error", oneLine(value.message as string)) : undefined;
    default:
      return undefined;
  }
}

/** The progress text (mark and text, no time) for one parsed Codex event, or undefined when it isn't worth a line. Never throws. */
export function describeCodexEvent(event: unknown, cwd?: string): string | undefined {
  if (!isObject(event)) return undefined;
  switch (event.type) {
    // The session id itself is UUID-shaped and redactSecrets would hide it, so it isn't printed.
    case "thread.started": return line("info", "session started");
    case "turn.started": return line("info", "turn started");
    case "turn.completed": return line("info", `turn done${usage(event.usage)}`);
    case "turn.failed": return line("error", `turn failed${isObject(event.error) && str(event.error.message) ? `: ${oneLine(event.error.message as string)}` : ""}`);
    case "error": return str(event.message) ? line("error", oneLine(event.message as string)) : undefined;
    case "item.started": case "item.updated": case "item.completed":
      return isObject(event.item) ? item(event.type.slice(5) as "started" | "updated" | "completed", event.item, cwd) : undefined;
    default: return undefined;
  }
}

/** The progress text for one raw JSONL line; unparseable lines give undefined. */
export function describeCodexLine(line: string, cwd?: string): string | undefined {
  if (!line.trim()) return undefined;
  try { return describeCodexEvent(JSON.parse(line), cwd); } catch { return undefined; }
}

/** Local `HH:MM`. */
export function shortTime(time: Date): string {
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** Timestamps, redacts and then caps one progress line. */
export function formatProgressLine(text: string, time: Date): string {
  // Trim huge text before redacting (for speed) but well past the cap, so a secret is never cut before redaction sees it.
  const raw = `${shortTime(time)} ${text.slice(0, MAX_PROGRESS_LINE * 10)}`;
  const line = redactSecrets(raw.replace(/[\r\n\t]+/g, " "));
  return line.length > MAX_PROGRESS_LINE ? `${line.slice(0, MAX_PROGRESS_LINE - 3)}...` : line;
}

export interface ProgressTimers { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
const systemTimers: ProgressTimers = {
  setTimeout: (run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CodexProgressOptions {
  /** What the run is for (e.g. `build`, `review`); printed once as a `#` line before the run's first line. */
  purpose?: string;
  cwd?: string;
  write?: (line: string) => void;
  now?: () => Date;
  timers?: ProgressTimers;
  slowCommandMs?: number;
}

let stdoutGuarded = false;
/** An async EPIPE on a closed pane would otherwise be an unhandled `error` event and crash the process. */
export function guardStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  process.stdout.on("error", () => { /* progress output is best effort */ });
}

/** Feeds raw stdout chunks from `codex exec --json` and writes one progress line per meaningful event. */
export function codexProgress(options: CodexProgressOptions = {}): { push(chunk: string): void; end(): void } {
  if (!options.write) guardStdout();
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? systemTimers;
  const slowMs = options.slowCommandMs ?? SLOW_COMMAND_MS;
  const splitter = new LineSplitter();
  const running = new Map<string, unknown>();
  let headed = !options.purpose;
  const print = (text: string) => {
    try {
      if (!headed) { headed = true; write(formatProgressLine(line("purpose", options.purpose!), now())); }
      write(formatProgressLine(text, now()));
    } catch { /* progress output must never break the run */ }
  };
  const track = (raw: string) => {
    let event: unknown;
    try { event = JSON.parse(raw); } catch { return; }
    if (!isObject(event) || !isObject(event.item) || event.item.type !== "command_execution" || typeof event.item.id !== "string") return;
    const id = event.item.id;
    if (event.type === "item.started" && !running.has(id)) {
      const text = line("command", `${STATUS.running} ${shellCommand(event.item.command)}`);
      running.set(id, timers.setTimeout(() => { running.delete(id); print(text); }, slowMs));
    } else if (event.type === "item.completed" && running.has(id)) {
      timers.clearTimeout(running.get(id));
      running.delete(id);
    }
  };
  const emit = (lines: string[]) => {
    for (const raw of lines) {
      try {
        if (raw.includes("command_execution")) track(raw);
        const text = describeCodexLine(raw, options.cwd);
        if (text) print(text);
      } catch { /* progress output must never break the run */ }
    }
  };
  return {
    push: (chunk) => emit(splitter.push(chunk)),
    end: () => {
      emit(splitter.flush());
      for (const handle of running.values()) timers.clearTimeout(handle);
      running.clear();
    },
  };
}
