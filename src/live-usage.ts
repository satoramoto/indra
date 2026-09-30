/**
 * Live token totals for a headed run that is still going, read from the engine's own session log (the Claude
 * transcript or the Codex rollout) that the run's headed-run marker names (headed-session.ts).
 *
 * Cheap by design: each seat is read at most once every `intervalMs`, and each read opens the log read-only and reads
 * only the bytes added since the last read. The totals are counted the same way a finished headed run counts them
 * (RuntimeFacts.observeLog), so the live number and the recorded one agree. Nothing here writes a file or runs tmux.
 */
import { open } from "node:fs/promises";
import { headedMarkerFile, readHeadedMarker } from "./headed-session.js";
import { jsonObject, RuntimeFacts, type RuntimeEngine, type TokenUsage } from "./runtime-facts.js";
import { TmuxHost, type HostedProcess } from "./tmux-host.js";

/** Bytes read per chunk when a log has grown. */
const CHUNK = 1024 * 1024;

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * The context window of the session's newest model call, from one log entry, or undefined when the entry does not
 * report one. It is the size of that one call, never the session's cumulative total.
 * - Codex: a rollout `token_count` event's `last_token_usage` (its `total_tokens`, else input plus output).
 * - Claude: a main-thread transcript assistant message's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 */
export function contextTokens(engine: RuntimeEngine, entry: unknown): number | undefined {
  if (!jsonObject(entry)) return undefined;
  if (engine === "codex") {
    if (entry.type !== "event_msg" || !jsonObject(entry.payload) || entry.payload.type !== "token_count" || !jsonObject(entry.payload.info)) return undefined;
    const last = entry.payload.info.last_token_usage;
    if (!jsonObject(last)) return undefined;
    const input = count(last.input_tokens);
    return count(last.total_tokens) ?? (input === undefined ? undefined : input + (count(last.output_tokens) ?? 0));
  }
  if (entry.isSidechain === true || entry.type !== "assistant" || !jsonObject(entry.message) || !jsonObject(entry.message.usage)) return undefined;
  const usage = entry.message.usage;
  const input = count(usage.input_tokens);
  return input === undefined ? undefined : input + (count(usage.cache_read_input_tokens) ?? 0) + (count(usage.cache_creation_input_tokens) ?? 0);
}

/** True for the entry an engine writes when it compacts the session's context. */
export function isCompaction(engine: RuntimeEngine, entry: unknown): boolean {
  if (!jsonObject(entry)) return false;
  return engine === "codex" ? entry.type === "compacted" : entry.type === "system" && entry.subtype === "compact_boundary" && entry.isSidechain !== true;
}

/** Reads one session log from where it last stopped and keeps its running totals; a partial last line waits. */
export class LiveUsageTail {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private facts: RuntimeFacts;
  /** The newest model call's context window, in tokens. */
  context?: number;
  /** When the engine last compacted the context: the entry's own time, or the time it was read. */
  compactedAt?: string;
  /** A compaction marker came after the last window, so the next, smaller window is not a second compaction. */
  private marked = false;
  constructor(readonly path: string, readonly engine: RuntimeEngine, private readonly now = () => Date.now(), facts?: RuntimeFacts) { this.facts = facts ?? new RuntimeFacts(engine); }

  /** The session handle the log names (`claude:<id>`, or a bare Codex ID), once a line has named it. */
  get sessionId(): string | undefined { return this.facts.sessionId; }

  private observe(entry: unknown): void {
    this.facts.observeLog(entry);
    const at = () => {
      const stamp = jsonObject(entry) && typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : undefined;
      return stamp ?? new Date(this.now()).toISOString();
    };
    if (isCompaction(this.engine, entry)) { this.compactedAt = at(); this.marked = true; return; }
    const context = contextTokens(this.engine, entry);
    if (context === undefined) return;
    // A window that falls to under half its size was compacted, even where the log has no marker for it.
    if (!this.marked && this.context !== undefined && context < this.context / 2) this.compactedAt = at();
    this.marked = false;
    this.context = context;
  }

  /** Resume accounting starts after the existing log prefix, which belongs to earlier invocations. */
  async seekEnd(): Promise<void> {
    const file = await open(this.path, "r");
    try { this.offset = (await file.stat()).size; this.pending = Buffer.alloc(0); } finally { await file.close(); }
  }

  async read(): Promise<TokenUsage | undefined> {
    const file = await open(this.path, "r");
    try {
      const { size } = await file.stat();
      if (size < this.offset) {
        // The log was replaced: count it again from the start.
        this.offset = 0; this.pending = Buffer.alloc(0); this.facts = new RuntimeFacts(this.engine);
        this.context = undefined; this.compactedAt = undefined; this.marked = false;
      }
      while (this.offset < size) {
        const chunk = Buffer.alloc(Math.min(CHUNK, size - this.offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        const data = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(0x0a);
        this.pending = Buffer.from(end < 0 ? data : data.subarray(end + 1));
        if (end < 0) continue;
        for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          let entry: unknown;
          try { entry = JSON.parse(line); } catch { continue; /* a malformed line */ }
          this.observe(entry);
        }
      }
    } finally { await file.close(); }
    return this.facts.finish("succeeded").usage;
  }
}

export interface LiveUsage {
  engine: RuntimeEngine; sessionId?: string; usage: TokenUsage;
  /** The newest model call's context window, in tokens, against HARNESS_CONTEXT_TOKEN_LIMIT. */
  context?: number;
  /** When the engine last compacted this session's context. */
  compactedAt?: string;
}

/** The running totals of a hosted process's headed run, or undefined when none is going. */
export interface LiveUsagePort { read(hosted: HostedProcess): Promise<LiveUsage | undefined> }

/** Reads each hosted process's headed-run marker through its ownership record, and tails the log it names. */
export class LiveUsageReader implements LiveUsagePort {
  private readonly cache = new Map<string, { at: number; value?: LiveUsage; tail?: LiveUsageTail }>();
  constructor(private readonly checkout: string, readonly intervalMs = 5000, private readonly now = () => Date.now(), private readonly alive?: (pid: number) => boolean) {}

  async read(hosted: HostedProcess): Promise<LiveUsage | undefined> {
    const key = hosted.kind === "bridge" ? "bridge" : `seat:${hosted.seatId}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.intervalMs) return cached.value;
    const entry: { at: number; value?: LiveUsage; tail?: LiveUsageTail } = { at: this.now() };
    this.cache.set(key, entry);
    try {
      const record = await new TmuxHost(this.checkout, undefined, undefined, undefined, hosted).readRecord();
      const marker = record ? await readHeadedMarker(headedMarkerFile(this.checkout, record.readyNonce), this.alive) : undefined;
      if (!marker?.log) return undefined;
      const tail = cached?.tail?.path === marker.log && cached.tail.engine === marker.engine ? cached.tail : new LiveUsageTail(marker.log, marker.engine, this.now);
      entry.tail = tail;
      const usage = await tail.read();
      if (usage) entry.value = { engine: marker.engine, ...(tail.sessionId ? { sessionId: tail.sessionId } : {}), usage,
        ...(tail.context !== undefined ? { context: tail.context } : {}), ...(tail.compactedAt ? { compactedAt: tail.compactedAt } : {}) };
      return entry.value;
    } catch { return undefined; }
  }
}
