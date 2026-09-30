import { randomUUID } from "node:crypto";

/** Only reported counters belong here. Missing counters are unknown, including on failed runs. */
export interface TokenUsage {
  /** Total input, including cache reads/writes. */
  inputTokens?: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}
export type RuntimeEngine = "codex" | "claude";
export type RunStatus = "succeeded" | "failed" | "interrupted" | "timed-out";
export interface RuntimeSessionFacts {
  invocationId: string;
  engine: RuntimeEngine;
  sessionId?: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  /** Counters attributable to this invocation; never a resumed session's lifetime total. */
  usage?: TokenUsage;
  /** True only after a provider terminal receipt proves the invocation's final counters. */
  usageComplete?: boolean;
  /** Codex reports lifetime totals. Persist this as the baseline for a later resume. */
  cumulativeUsage?: TokenUsage;
}

const keys = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
export const jsonObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const compact = (usage: TokenUsage): TokenUsage | undefined => {
  const result = Object.fromEntries(keys.flatMap((key) => counter(usage[key]) === undefined ? [] : [[key, usage[key]]]));
  return Object.keys(result).length ? result : undefined;
};

/** Provider metadata, diagnostics and arbitrary keys are deliberately not copied. */
export function normalizeUsage(engine: RuntimeEngine, value: unknown): TokenUsage | undefined {
  if (!jsonObject(value)) return undefined;
  const input = counter(value.input_tokens);
  const cached = counter(engine === "codex" ? value.cached_input_tokens : value.cache_read_input_tokens);
  const written = counter(engine === "codex" ? value.cache_write_input_tokens : value.cache_creation_input_tokens);
  const outputDetails = jsonObject(value.output_tokens_details) ? value.output_tokens_details : undefined;
  return compact({
    inputTokens: engine === "codex" ? input : input !== undefined && cached !== undefined && written !== undefined ? input + cached + written : undefined,
    // Codex input_tokens includes cached reads; uncached is derivable only when both are reported.
    uncachedInputTokens: engine === "claude" ? input : input !== undefined && cached !== undefined && input >= cached ? input - cached : undefined,
    cachedInputTokens: cached, cacheWriteInputTokens: written,
    outputTokens: counter(value.output_tokens),
    reasoningOutputTokens: counter(engine === "codex" ? value.reasoning_output_tokens : outputDetails?.thinking_tokens),
  });
}

/** A missing baseline or a reset counter cannot establish an invocation's consumption. */
export function usageDelta(current: TokenUsage | undefined, previous: TokenUsage | undefined): TokenUsage | undefined {
  const result: TokenUsage = {};
  for (const key of keys) {
    const after = counter(current?.[key]); const before = counter(previous?.[key]);
    if (after !== undefined && before !== undefined && after >= before) result[key] = after - before;
  }
  return compact(result);
}

function mergeClaudeUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): TokenUsage | undefined {
  const result: TokenUsage = {};
  for (const key of keys) {
    const values = [left?.[key], right?.[key]].filter((value): value is number => value !== undefined);
    if (values.length) result[key] = Math.max(...values);
  }
  // Partial reports can update one component without reporting a new inclusive total.
  const { uncachedInputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: written } = result;
  result.inputTokens = input !== undefined && cached !== undefined && written !== undefined ? input + cached + written : undefined;
  return compact(result);
}

// Derived uncached input comes from the latest report only, so an earlier derivation cannot go stale.
const mergeCodexUsage = (previous: TokenUsage | undefined, report: TokenUsage | undefined): TokenUsage | undefined =>
  report ? compact({ ...previous, uncachedInputTokens: undefined, ...report }) : previous;

const sessionHandle = (engine: RuntimeEngine, value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (engine === "claude") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? `claude:${value}` : undefined;
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : undefined;
};

/** One collector per invocation, with no transcripts, prompts, diagnostics or cross-run mutable cache. */
export class RuntimeFacts {
  readonly invocationId = randomUUID();
  readonly startedAt = new Date().toISOString();
  sessionId?: string;
  private readonly resumed: boolean;
  private cumulative?: TokenUsage;
  private resultUsage?: TokenUsage;
  private readonly messages = new Map<string, TokenUsage>();
  private activeMessage?: string;
  private terminalUsage = false;
  private streamTerminal = false;
  private endedClaudeMessage = false;
  private invalidUsage = false;
  logObserved = false;
  get usageRegressed(): boolean { return this.invalidUsage; }
  invalidateUsage(): void { this.invalidUsage = true; }
  private codexUsage(report: TokenUsage | undefined): void {
    if (report && ["inputTokens", "outputTokens"].some((key) => {
      const field = key as "inputTokens" | "outputTokens";
      return report[field] !== undefined && this.cumulative?.[field] !== undefined && report[field]! < this.cumulative[field]!;
    })) this.invalidUsage = true;
    this.cumulative = mergeCodexUsage(this.cumulative, report);
  }

  constructor(readonly engine: RuntimeEngine, sessionId?: string, private readonly baseline?: TokenUsage) {
    this.resumed = sessionId !== undefined;
    this.sessionId = sessionHandle(engine, engine === "claude" && sessionId?.startsWith("claude:") ? sessionId.slice(7) : sessionId);
  }

  observe(event: unknown): void {
    if (!jsonObject(event)) return;
    if (this.engine === "codex") {
      if (event.type === "thread.started") this.sessionId ??= sessionHandle("codex", event.thread_id);
      if (event.type === "turn.started") { this.terminalUsage = false; this.streamTerminal = false; }
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        const report = normalizeUsage("codex", event.usage);
        this.codexUsage(report);
        this.streamTerminal = true;
        this.terminalUsage = report?.inputTokens !== undefined && report.outputTokens !== undefined;
      }
      return;
    }
    // Keep top-level invocation accounting consistent with Claude's result.usage.
    if (event.parent_tool_use_id != null) { this.invalidUsage = true; return; }
    if ((event.type === "system" && event.subtype === "init") || event.type === "result" || event.type === "assistant" || event.type === "stream_event") {
      this.sessionId ??= sessionHandle("claude", event.session_id);
    }
    if (event.type === "result") {
      const report = normalizeUsage("claude", event.usage);
      this.resultUsage = mergeClaudeUsage(this.resultUsage, report);
      this.terminalUsage = report?.inputTokens !== undefined && report.outputTokens !== undefined;
    }
    if (event.type === "assistant" && jsonObject(event.message)) {
      // Assistant output_tokens is a message-start placeholder, not completed output.
      this.observeClaudeDelegation(event.message);
      this.message(event.message.id, event.message.usage, false);
    }
    if (event.type === "stream_event" && jsonObject(event.event)) {
      const stream = event.event;
      if (stream.type === "message_start" && jsonObject(stream.message)) {
        this.observeClaudeDelegation(stream.message);
        this.activeMessage = typeof stream.message.id === "string" ? stream.message.id : undefined;
        this.message(this.activeMessage, stream.message.usage, false);
      } else if (stream.type === "content_block_start" && jsonObject(stream.content_block) && stream.content_block.type === "tool_use" && ["Agent", "Task"].includes(String(stream.content_block.name))) this.invalidUsage = true;
      else if (stream.type === "message_delta") this.message(this.activeMessage, stream.usage, true);
      else if (stream.type === "message_stop") this.activeMessage = undefined;
    }
  }

  /**
   * One entry of a headed session's log: a Claude transcript line (`<config>/projects/<dir>/<session>.jsonl`) or a Codex
   * rollout line (`$CODEX_HOME/sessions/…/rollout-*.jsonl`). Transcript assistant usage is final, output included;
   * subagent (sidechain) entries are skipped as in the stream. Rollout token counts are session totals.
   */
  observeLog(entry: unknown): void {
    if (!jsonObject(entry)) return;
    this.logObserved = true;
    if (this.engine === "codex") {
      // The stdout terminal snapshot is newer than any concurrently finishing rollout-tail read.
      if (this.streamTerminal) return;
      if (entry.type === "event_msg" && jsonObject(entry.payload) && entry.payload.type === "task_started") this.terminalUsage = false;
      if (entry.type === "event_msg" && jsonObject(entry.payload) && entry.payload.type === "task_complete") this.terminalUsage = true;
      if (entry.type === "session_meta" && jsonObject(entry.payload)) this.sessionId ??= sessionHandle("codex", entry.payload.id);
      if (entry.type === "event_msg" && jsonObject(entry.payload) && entry.payload.type === "token_count" && jsonObject(entry.payload.info)) {
        this.codexUsage(normalizeUsage("codex", entry.payload.info.total_token_usage));
      }
      return;
    }
    if (entry.isSidechain === true) { this.invalidUsage = true; return; }
    this.sessionId ??= sessionHandle("claude", entry.sessionId);
    if (entry.type === "user") { this.terminalUsage = false; this.endedClaudeMessage = false; }
    if (entry.type === "assistant" && jsonObject(entry.message)) {
      this.terminalUsage = false;
      this.observeClaudeDelegation(entry.message);
      const report = normalizeUsage("claude", entry.message.usage);
      this.endedClaudeMessage = entry.message.stop_reason === "end_turn" && report?.inputTokens !== undefined && report.outputTokens !== undefined;
      this.message(entry.message.id, entry.message.usage, true);
    }
    if (entry.type === "system" && entry.subtype === "turn_duration") this.terminalUsage = this.endedClaudeMessage;
  }

  private observeClaudeDelegation(message: Record<string, unknown>): void {
    if (Array.isArray(message.content) && message.content.some((block) => jsonObject(block) && block.type === "tool_use" && ["Agent", "Task"].includes(String(block.name)))) this.invalidUsage = true;
  }

  private message(id: unknown, value: unknown, output: boolean): void {
    if (typeof id !== "string" || !id || id.length > 200) return;
    const usage = normalizeUsage("claude", value);
    if (!usage) return;
    if (!output) delete usage.outputTokens;
    const merged = mergeClaudeUsage(this.messages.get(id), usage);
    if (merged) this.messages.set(id, merged);
  }

  finish(status: RunStatus): RuntimeSessionFacts {
    let usage: TokenUsage | undefined;
    if (this.engine === "codex") usage = this.resumed ? usageDelta(this.cumulative, this.baseline) : this.cumulative;
    else {
      const sums: TokenUsage = {};
      for (const report of this.messages.values()) for (const key of keys) {
        if (report[key] !== undefined) sums[key] = (sums[key] ?? 0) + report[key];
      }
      // Result counters supersede step reports; crash results can be zeroed or incomplete.
      usage = mergeClaudeUsage(compact(sums), this.resultUsage);
    }
    return {
      invocationId: this.invocationId, engine: this.engine, ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      startedAt: this.startedAt, finishedAt: new Date().toISOString(), status,
      ...(usage ? { usage } : {}), ...(this.terminalUsage && !this.invalidUsage && usage?.inputTokens !== undefined && usage.outputTokens !== undefined ? { usageComplete: true } : {}), ...(this.cumulative ? { cumulativeUsage: this.cumulative } : {}),
    };
  }
}

/** Publishes monotonic invocation snapshots; callers must terminate the run if the callback throws. */
export function usageReporter(facts: RuntimeFacts, callback?: (usage: TokenUsage) => void): () => void {
  let previous: TokenUsage = {};
  return () => {
    if (!callback) return;
    if (facts.usageRegressed) throw new RuntimeStop("Provider token accounting became unknown; final usage cannot be verified.");
    const current = facts.finish("succeeded").usage;
    if (!current) return;
    const next = { ...previous };
    for (const key of keys) if (current[key] !== undefined) next[key] = Math.max(previous[key] ?? 0, current[key]);
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    previous = next;
    callback({ ...next });
  };
}

/** Internal, controlled messages only; never wrap a provider's Error.message or raw output. */
export class RuntimeStop extends Error {
  constructor(message: string, readonly status: Exclude<RunStatus, "succeeded"> = "failed") { super(message); }
}

/** Catch this at the persistence boundary even when no response was returned. */
export class AgentRunError extends Error {
  override name = "AgentRunError";
  constructor(message: string, readonly facts: RuntimeSessionFacts) { super(message); }
}

export function recordedError(error: unknown, facts: RuntimeFacts): AgentRunError {
  return new AgentRunError(error instanceof RuntimeStop ? error.message : `${facts.engine === "codex" ? "Codex" : "Claude"} run failed; diagnostics withheld.`, facts.finish(error instanceof RuntimeStop ? error.status : "failed"));
}

/** JSONL is parsed as it arrives so a later process failure cannot discard earlier evidence. */
export class RuntimeEventStream {
  private rest = "";
  malformed = false;
  constructor(private readonly observe: (event: Record<string, unknown>) => void) {}
  push(part: string): void {
    const lines = (this.rest + part).split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }
  end(): void { this.line(this.rest); this.rest = ""; }
  private line(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { this.malformed = true; return; }
    if (!jsonObject(event)) { this.malformed = true; return; }
    this.observe(event);
  }
}
