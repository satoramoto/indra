import { join } from "node:path";
import type { PlanningStore } from "./planning.js";
import { ceremonyRuntimeName, type BridgeCeremonyRecord } from "./planning-bridge.js";
import { redactSecrets } from "./redact.js";
import { withFileLock } from "./state-commit.js";

interface ReleaseFactBase { key: string; at: string; prUrl: string }
export type ReleaseFact = ReleaseFactBase & (
  | { kind: "tracking-started" }
  | { kind: "observation"; headSha: string; state: "OPEN" | "CLOSED" | "MERGED"; conflicting: boolean | null }
  | { kind: "merge-started"; headSha: string; attemptId: string }
  | { kind: "merge-finished"; headSha: string; attemptId: string; result: "failed" | "merged" | "unknown" }
);
/** Append-only integration evidence. Neither command output nor credentials belong in this runtime ledger. */
export interface ReleaseFacts { version: 1; goalId: string; events: ReleaseFact[] }
export interface ReleaseRounds { conflict: number | null; merge: number | null; missing: string[] }
type ReleaseRuntimeRecord = Omit<BridgeCeremonyRecord, "facts"> & { facts: BridgeCeremonyRecord["facts"] & { releaseFacts?: ReleaseFacts } };

const MAX_EVENTS = 20_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,239}$/.test(value) && redactSecrets(value) === value;
const validSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid release fact timestamp.");
  return new Date(value).toISOString();
}
export function releaseFactsName(goalId: string): string {
  if (!/^[a-z][a-z0-9-]{0,159}$/.test(goalId)) throw new Error("Invalid release fact goal.");
  return ceremonyRuntimeName(goalId);
}

/** Copy only bounded, typed evidence. Never persist arbitrary diagnostics supplied alongside an event. */
function fact(value: unknown): ReleaseFact {
  if (!object(value) || !validId(value.key) || typeof value.prUrl !== "string"
    || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value.prUrl) || value.prUrl.length > 300
    || redactSecrets(value.prUrl) !== value.prUrl) throw new Error("Invalid release fact identity.");
  const base = { key: value.key, at: timestamp(value.at), prUrl: value.prUrl };
  if (value.kind === "tracking-started") return { ...base, kind: value.kind };
  if (!validSha(value.headSha)) throw new Error("Invalid release fact head.");
  const headSha = value.headSha;
  if (value.kind === "observation" && ["OPEN", "CLOSED", "MERGED"].includes(String(value.state))
    && (typeof value.conflicting === "boolean" || value.conflicting === null)) {
    return { ...base, kind: value.kind, headSha, state: value.state as "OPEN" | "CLOSED" | "MERGED", conflicting: value.conflicting };
  }
  if (!validId(value.attemptId)) throw new Error("Invalid release merge attempt.");
  if (value.kind === "merge-started") return { ...base, kind: value.kind, headSha, attemptId: value.attemptId };
  if (value.kind === "merge-finished" && ["failed", "merged", "unknown"].includes(String(value.result))) {
    return { ...base, kind: value.kind, headSha, attemptId: value.attemptId, result: value.result as "failed" | "merged" | "unknown" };
  }
  throw new Error("Invalid release fact kind.");
}

function ledger(value: unknown, goalId: string): ReleaseFacts {
  if (!object(value) || value.version !== 1 || value.goalId !== goalId || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) throw new Error("Invalid release history.");
  return { version: 1, goalId, events: value.events.map(fact) };
}

/** Share the ceremony recorder's lock; its existing retro reader carries this ledger into new drafts. */
export class ReleaseRecorder {
  readonly name: string;
  constructor(private readonly store: PlanningStore, readonly goalId: string) { this.name = releaseFactsName(goalId); }
  async read(): Promise<ReleaseFacts | undefined> {
    const value = (await this.store.readRuntimeFile<ReleaseRuntimeRecord>(this.name))?.facts.releaseFacts;
    return value === undefined ? undefined : ledger(value, this.goalId);
  }
  async record(event: ReleaseFact): Promise<void> {
    const next = fact(event);
    await withFileLock(join(this.store.runtimeDir, `${this.name}.lock`), async () => {
      const record = await this.store.readRuntimeFile<ReleaseRuntimeRecord>(this.name) ?? {
        facts: { seats: [], sessions: [], reviews: [], rounds: [], failures: [] }, deliveredStages: [],
      };
      const history = record.facts.releaseFacts ? ledger(record.facts.releaseFacts, this.goalId) : { version: 1 as const, goalId: this.goalId, events: [] };
      const prior = history.events.find((item) => item.key === next.key);
      if (prior) {
        // A replay may be delivered later; its first recorded timestamp remains the cutoff boundary.
        if (JSON.stringify({ ...prior, at: next.at }) !== JSON.stringify(next)) throw new Error("Conflicting release event replay.");
        return;
      }
      if (history.events.length >= MAX_EVENTS) throw new Error("Release history exceeds its record bound.");
      history.events.push(next);
      record.facts.releaseFacts = history;
      await this.store.saveRuntime(this.name, record);
    });
  }
}

/** Missing files, unreadable history and legacy events cannot establish a recorded zero. */
export async function readReleaseFacts(store: PlanningStore, goalId: string): Promise<ReleaseFacts | undefined> {
  try { return await new ReleaseRecorder(store, goalId).read(); }
  catch { return undefined; }
}

/** Count conflict episodes by observed resolution boundaries, and commands by durable attempt identity. */
export function releaseRounds(value: ReleaseFacts | undefined, goalId: string, prUrl: string, cutoffAt: string): ReleaseRounds {
  const unavailable = (): ReleaseRounds => ({ conflict: null, merge: null, missing: ["Integration PR round history is unavailable; absence does not establish zero."] });
  if (!value) return unavailable();
  let history: ReleaseFacts;
  const cutoff = timestamp(cutoffAt);
  try { history = ledger(value, goalId); } catch { return unavailable(); }
  const events: ReleaseFact[] = [];
  const keys = new Map<string, ReleaseFact>();
  let lastAt = "";
  for (const event of history.events) {
    if (event.at > cutoff) continue;
    if (event.prUrl !== prUrl) return unavailable();
    const prior = keys.get(event.key);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(event)) return unavailable();
      continue;
    }
    if (event.at < lastAt) return unavailable();
    lastAt = event.at; keys.set(event.key, event); events.push(event);
  }
  if (events[0]?.kind !== "tracking-started") return unavailable();
  const missing: string[] = [];
  let conflicts = 0; let active = false; let observed = false;
  const attempts = new Map<string, { start?: Extract<ReleaseFact, { kind: "merge-started" }>; finish?: Extract<ReleaseFact, { kind: "merge-finished" }> }>();
  let ambiguous = false;
  for (const event of events) {
    if (event.kind === "observation") {
      // UNKNOWN and changed heads do not resolve a conflict. Only a recorded false closes the episode.
      if (event.conflicting !== null) {
        observed = true;
        if (event.conflicting && !active) conflicts++;
        active = event.conflicting;
      }
    } else if (event.kind === "merge-started" || event.kind === "merge-finished") {
      const attempt = attempts.get(event.attemptId) ?? {};
      if (event.kind === "merge-started") {
        if (attempt.start && (attempt.start.headSha !== event.headSha || attempt.start.at !== event.at)) ambiguous = true;
        attempt.start ??= event;
      } else {
        if (attempt.finish && (attempt.finish.headSha !== event.headSha
          || (attempt.finish.result !== "unknown" && event.result !== "unknown" && attempt.finish.result !== event.result))) ambiguous = true;
        // A later receipt may resolve an interrupted attempt. Its earlier unknown remains visible at earlier cutoffs.
        if (!attempt.finish || attempt.finish.result === "unknown") attempt.finish = event;
      }
      attempts.set(event.attemptId, attempt);
    }
  }
  const conflict = observed ? conflicts : null;
  if (conflict === null) missing.push("Integration PR conflict observations are incomplete; conflict rounds are unknown.");
  const complete = !ambiguous && [...attempts.values()].every(({ start, finish }) => start && finish && finish.at >= start.at
    && finish.headSha === start.headSha && finish.result !== "unknown");
  const merge = complete ? attempts.size : null;
  if (merge === null) missing.push("Integration PR merge attempts are incomplete; merge rounds are unknown.");
  return { conflict, merge, missing };
}
