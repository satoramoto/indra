import { formatProgressLine, guardStdout, isObject, line, LineSplitter, oneLine, relative, STATUS, str, type Json } from "./codex-progress.js";

/**
 * Live, readable progress for a `claude --print --output-format stream-json --verbose` run, printed to the running
 * process's stdout (and so to its tmux pane). Same line format and marks as Codex progress, so the pane panel colours
 * it unchanged. Event shapes follow Claude Code 2.1.283: `system` (`init`, ...), `assistant` and `user` wrapping a
 * `message` whose `content` holds `text`, `thinking`, `tool_use` and `tool_result` blocks, and a final `result`.
 * `stream_event` partials and unknown events are ignored.
 *
 * A tool use prints once, when its result arrives, so the status can sit right after the mark.
 */

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

interface ToolUse { name: string; input: Json }

function toolDetail(input: Json, cwd?: string): string {
  const value = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(input.pattern) ?? str(input.url) ?? str(input.query) ?? str(input.description);
  return value ? ` ${relative(oneLine(value), cwd)}` : "";
}

function toolLine(use: ToolUse, failed: boolean, cwd?: string): string {
  const status = failed ? STATUS.failed : STATUS.ok;
  if (use.name === "Bash") return line("command", `${status} ${oneLine(str(use.input.command) ?? "")}`);
  if (FILE_TOOLS.has(use.name)) {
    const path = str(use.input.file_path) ?? str(use.input.notebook_path) ?? "?";
    return line("files", `${failed ? `${STATUS.failed} ` : ""}${use.name.toLowerCase()} ${relative(path, cwd)}`);
  }
  return line("tool", `${status} ${use.name}${toolDetail(use.input, cwd)}`);
}

function usage(value: unknown): string {
  if (!isObject(value)) return "";
  const n = (key: string) => (typeof value[key] === "number" ? value[key] as number : undefined);
  const parts = [["in", n("input_tokens")], ["cached", n("cache_read_input_tokens")], ["cache write", n("cache_creation_input_tokens")], ["out", n("output_tokens")]]
    .filter((part): part is [string, number] => part[1] !== undefined).map(([label, count]) => `${label} ${count}`);
  return parts.length ? parts.join(", ") : "";
}

/** Turns parsed Claude stream-json events into progress text (mark and text, no time). Keeps pending tool uses. */
export class ClaudeProgressFormatter {
  private tools = new Map<string, ToolUse>();
  constructor(private cwd?: string) {}

  /** Zero or more progress lines for one event. Never throws. */
  describe(event: unknown): string[] {
    if (!isObject(event)) return [];
    switch (event.type) {
      // The session id is UUID-shaped and redaction would hide it, so it isn't printed.
      case "system": return event.subtype === "init" ? [line("info", "session started")] : [];
      case "assistant": return this.assistant(event);
      case "user": return this.user(event);
      case "result": return [this.result(event)];
      default: return [];
    }
  }

  private assistant(event: Json): string[] {
    const out: string[] = [];
    if (str(event.error)) out.push(line("error", oneLine(event.error as string)));
    const content = isObject(event.message) && Array.isArray(event.message.content) ? event.message.content.filter(isObject) : [];
    for (const block of content) {
      if (block.type === "text" && oneLine(str(block.text) ?? "")) out.push(line("agent", oneLine(block.text as string)));
      else if (block.type === "thinking") {
        const hint = oneLine(str(block.thinking) ?? "").replace(/\*\*/g, "");
        if (hint) out.push(line("thinking", hint.slice(0, 80)));
      } else if (block.type === "tool_use" && str(block.id) && str(block.name)) {
        this.tools.set(block.id as string, { name: block.name as string, input: isObject(block.input) ? block.input : {} });
      }
    }
    return out;
  }

  private user(event: Json): string[] {
    const content = isObject(event.message) && Array.isArray(event.message.content) ? event.message.content.filter(isObject) : [];
    const out: string[] = [];
    for (const block of content) {
      if (block.type !== "tool_result" || !str(block.tool_use_id)) continue;
      const use = this.tools.get(block.tool_use_id as string);
      if (!use) continue;
      this.tools.delete(block.tool_use_id as string);
      out.push(toolLine(use, block.is_error === true, this.cwd));
    }
    return out;
  }

  private result(event: Json): string {
    const turns = typeof event.num_turns === "number" ? `${event.num_turns} turns` : "";
    const detail = [turns, usage(event.usage)].filter(Boolean).join(", ");
    if (event.is_error === true || (str(event.subtype) && event.subtype !== "success")) {
      const why = str(event.subtype) && event.subtype !== "success" ? event.subtype as string : "error";
      return line("error", `run failed: ${why}${detail ? ` (${detail})` : ""}`);
    }
    return line("info", `run done${detail ? ` (${detail})` : ""}`);
  }
}

/** The progress lines for one raw JSONL line; unparseable lines give none. */
export function describeClaudeLine(formatter: ClaudeProgressFormatter, raw: string): string[] {
  if (!raw.trim() || raw.includes(`"type":"stream_event"`)) return [];
  try { return formatter.describe(JSON.parse(raw)); } catch { return []; }
}

export interface ClaudeProgressOptions {
  cwd?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

/** Feeds raw stdout chunks from Claude stream-json and writes one progress line per meaningful event. */
export function claudeProgress(options: ClaudeProgressOptions = {}): { push(chunk: string): void; end(): void } {
  if (!options.write) guardStdout();
  const write = options.write ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const now = options.now ?? (() => new Date());
  const splitter = new LineSplitter();
  const formatter = new ClaudeProgressFormatter(options.cwd);
  const emit = (lines: string[]) => {
    for (const raw of lines) {
      try {
        for (const text of describeClaudeLine(formatter, raw)) write(formatProgressLine(text, now()));
      } catch { /* progress output must never break the run */ }
    }
  };
  return { push: (chunk) => emit(splitter.push(chunk)), end: () => emit(splitter.flush()) };
}
