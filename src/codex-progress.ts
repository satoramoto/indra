import { redactSecrets } from "./redact.js";

/**
 * Live, readable progress for a `codex exec --json` run, printed to the running process's stdout (and so to its
 * tmux pane). One short, timestamped, redacted line per meaningful JSONL event; unknown or unparseable events are
 * ignored. Event shapes follow codex-cli 0.156.1 (`thread.started`, `turn.started`, `turn.completed` with `usage`,
 * `turn.failed`, `error`, and `item.started`/`item.updated`/`item.completed` wrapping an `item` with a `type`).
 */

/** Longest printed line, including timestamp and purpose prefix. */
export const MAX_PROGRESS_LINE = 200;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const oneLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line) ?? "";

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

/** Drops the `/bin/zsh -lc '...'` wrapper Codex puts around shell commands. */
function command(value: unknown): string {
  const text = str(value) ?? "";
  const wrapped = /^\S*\/(?:ba|z)?sh -lc (?:'([\s\S]*)'|([\s\S]*))$/.exec(text);
  return oneLine(wrapped ? (wrapped[1] ?? wrapped[2] ?? "") : text);
}

function relative(path: string, cwd?: string): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function usage(value: unknown): string {
  if (!isObject(value)) return "";
  const n = (key: string) => (typeof value[key] === "number" ? value[key] as number : undefined);
  const parts = [["in", n("input_tokens")], ["cached", n("cached_input_tokens")], ["out", n("output_tokens")], ["reasoning", n("reasoning_output_tokens")]]
    .filter((part): part is [string, number] => part[1] !== undefined).map(([label, count]) => `${label} ${count}`);
  return parts.length ? ` (usage: ${parts.join(", ")})` : "";
}

function item(phase: "started" | "updated" | "completed", value: Json, cwd?: string): string | undefined {
  switch (value.type) {
    case "agent_message":
      return phase === "completed" && str(value.text) ? `agent: ${oneLine(value.text as string)}` : undefined;
    case "reasoning": {
      const hint = oneLine(str(value.text) ?? "").replace(/\*\*/g, "");
      return phase === "completed" && hint ? `thinking: ${hint.slice(0, 80)}` : undefined;
    }
    case "command_execution":
      if (phase === "started") return `$ ${command(value.command)}`;
      if (phase === "completed") return `$ ${command(value.command)} -> exit ${typeof value.exit_code === "number" ? value.exit_code : str(value.status) ?? "?"}`;
      return undefined;
    case "file_change": {
      if (phase !== "completed" || !Array.isArray(value.changes)) return undefined;
      const changes = value.changes.filter(isObject).map((change) => `${str(change.kind) ?? "edit"} ${relative(str(change.path) ?? "?", cwd)}`);
      return changes.length ? `files${value.status === "failed" ? " (failed)" : ""}: ${changes.join(", ")}` : undefined;
    }
    case "mcp_tool_call": {
      const name = [str(value.server), str(value.tool)].filter(Boolean).join(".") || "tool";
      if (phase === "started") return `tool: ${name}`;
      if (phase === "completed") return `tool: ${name} ${value.status === "failed" || isObject(value.error) ? "failed" : "done"}`;
      return undefined;
    }
    case "web_search":
      return phase === "completed" && str(value.query) ? `search: ${oneLine(value.query as string)}` : undefined;
    case "todo_list": {
      if (!Array.isArray(value.items)) return undefined;
      const items = value.items.filter(isObject);
      const done = items.filter((entry) => entry.completed === true).length;
      const next = items.find((entry) => entry.completed !== true);
      return `todo ${done}/${items.length}${next && str(next.text) ? `, next: ${oneLine(next.text as string)}` : ""}`;
    }
    case "error":
      return str(value.message) ? `error: ${oneLine(value.message as string)}` : undefined;
    default:
      return undefined;
  }
}

/** The progress text for one parsed Codex event, or undefined when it isn't worth a line. Never throws. */
export function describeCodexEvent(event: unknown, cwd?: string): string | undefined {
  if (!isObject(event)) return undefined;
  switch (event.type) {
    // The session id itself is UUID-shaped and redactSecrets would hide it, so it isn't printed.
    case "thread.started": return "session started";
    case "turn.started": return "turn started";
    case "turn.completed": return `turn finished${usage(event.usage)}`;
    case "turn.failed": return `turn failed${isObject(event.error) && str(event.error.message) ? `: ${oneLine(event.error.message as string)}` : ""}`;
    case "error": return str(event.message) ? `error: ${oneLine(event.message as string)}` : undefined;
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

/** Timestamps, prefixes, redacts and caps one progress line. */
export function formatProgressLine(text: string, time: Date, purpose?: string): string {
  // Trim huge text before redacting (for speed) but well past the cap, so a secret is never cut before redaction sees it.
  const raw = `${time.toISOString().slice(11, 19)}${purpose ? ` [${purpose}]` : ""} ${text.slice(0, MAX_PROGRESS_LINE * 10)}`;
  const line = redactSecrets(raw.replace(/[\r\n\t]+/g, " "));
  return line.length > MAX_PROGRESS_LINE ? `${line.slice(0, MAX_PROGRESS_LINE - 3)}...` : line;
}

export interface CodexProgressOptions { purpose?: string; cwd?: string; write?: (line: string) => void; now?: () => Date }

/** Feeds raw stdout chunks from `codex exec --json` and writes one progress line per meaningful event. */
export function codexProgress(options: CodexProgressOptions = {}): { push(chunk: string): void; end(): void } {
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = options.now ?? (() => new Date());
  const splitter = new LineSplitter();
  const emit = (lines: string[]) => {
    for (const line of lines) {
      try {
        const text = describeCodexLine(line, options.cwd);
        if (text) write(formatProgressLine(text, now(), options.purpose));
      } catch { /* progress output must never break the run */ }
    }
  };
  return { push: (chunk) => emit(splitter.push(chunk)), end: () => emit(splitter.flush()) };
}
