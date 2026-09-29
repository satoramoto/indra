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
import { RuntimeFacts, type RuntimeEngine, type TokenUsage } from "./runtime-facts.js";
import { TmuxHost, type HostedProcess } from "./tmux-host.js";

/** Bytes read per chunk when a log has grown. */
const CHUNK = 1024 * 1024;

/** Reads one session log from where it last stopped and keeps its running totals; a partial last line waits. */
export class LiveUsageTail {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private facts: RuntimeFacts;
  constructor(readonly path: string, readonly engine: RuntimeEngine) { this.facts = new RuntimeFacts(engine); }

  /** The session handle the log names (`claude:<id>`, or a bare Codex ID), once a line has named it. */
  get sessionId(): string | undefined { return this.facts.sessionId; }

  async read(): Promise<TokenUsage | undefined> {
    const file = await open(this.path, "r");
    try {
      const { size } = await file.stat();
      if (size < this.offset) {
        // The log was replaced: count it again from the start.
        this.offset = 0; this.pending = Buffer.alloc(0); this.facts = new RuntimeFacts(this.engine);
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
          try { this.facts.observeLog(JSON.parse(line)); } catch { /* a malformed line */ }
        }
      }
    } finally { await file.close(); }
    return this.facts.finish("succeeded").usage;
  }
}

export interface LiveUsage { engine: RuntimeEngine; sessionId?: string; usage: TokenUsage }

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
      const tail = cached?.tail?.path === marker.log && cached.tail.engine === marker.engine ? cached.tail : new LiveUsageTail(marker.log, marker.engine);
      entry.tail = tail;
      const usage = await tail.read();
      if (usage) entry.value = { engine: marker.engine, ...(tail.sessionId ? { sessionId: tail.sessionId } : {}), usage };
      return entry.value;
    } catch { return undefined; }
  }
}
