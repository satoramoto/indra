import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { processShell, type Shell } from "./command-shell.js";
import { runGh } from "./git-gh.js";
import { requireTeamHome, type PlanningStore } from "./planning.js";
import { ceremonyRuntimeName, type BridgeCeremonyRecord, type CeremonyAdapters, type CeremonyContext, type ReleaseEvent } from "./planning-bridge.js";
import { redactSecrets } from "./redact.js";
import { withFileLock } from "./state-commit.js";

interface ReleaseFactBase { key: string; at: string; prUrl: string }
export type ReleaseFact = ReleaseFactBase & (
  | { kind: "tracking-started" }
  | { kind: "observation"; headSha: string; state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN"; conflicting: boolean | null }
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
  if (value.kind === "observation" && ["OPEN", "CLOSED", "MERGED", "UNKNOWN"].includes(String(value.state))
    && (typeof value.conflicting === "boolean" || value.conflicting === null)) {
    return { ...base, kind: value.kind, headSha, state: value.state as Extract<ReleaseFact, { kind: "observation" }>["state"], conflicting: value.conflicting };
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
    await this.update(() => [next]);
  }
  /** A poll records a new observation only when the observed state changes, at its actual read time. */
  async observe(event: Extract<ReleaseFact, { kind: "observation" }>, fromOpening: boolean): Promise<void> {
    const next = fact(event);
    await this.update((history) => {
      const prior = [...history.events].reverse().find((item) => item.kind === "observation");
      if (prior && JSON.stringify({ ...prior, key: next.key, at: next.at }) === JSON.stringify(next)) return [];
      return [...(!history.events.length && fromOpening ? [{ kind: "tracking-started" as const, key: "tracking", at: next.at, prUrl: next.prUrl }] : []), next];
    });
  }
  private async update(events: (history: ReleaseFacts) => ReleaseFact[]): Promise<void> {
    await withFileLock(join(this.store.runtimeDir, `${this.name}.lock`), async () => {
      const record = await this.store.readRuntimeFile<ReleaseRuntimeRecord>(this.name) ?? {
        facts: { seats: [], sessions: [], reviews: [], rounds: [], failures: [] }, deliveredStages: [],
      };
      const history = record.facts.releaseFacts ? ledger(record.facts.releaseFacts, this.goalId) : { version: 1 as const, goalId: this.goalId, events: [] };
      let changed = false;
      for (const next of events(history).map(fact)) {
        const prior = history.events.find((item) => item.key === next.key);
        if (prior) {
          // A replay may be delivered later; its first recorded timestamp remains the cutoff boundary.
          if (JSON.stringify({ ...prior, at: next.at }) !== JSON.stringify(next)) throw new Error("Conflicting release event replay.");
          continue;
        }
        if (history.events.length >= MAX_EVENTS) throw new Error("Release history exceeds its record bound.");
        history.events.push(next); changed = true;
      }
      if (!changed) return;
      record.facts.releaseFacts = history;
      await this.store.saveRuntime(this.name, record);
    });
  }
}

export const controlServices = ["releaseFacts"] as const;
// Hash hook identities into bounded segments: neither arbitrary hook text nor token-shaped UUIDs enter the ledger.
const hookId = (prefix: string, key: string) => `${prefix}:${createHash("sha256").update(key).digest("hex").match(/.{8}/g)!.join(".")}`;

/** The shared head hook identifies a verified PR, but omits its mergeability. Read it without changing the gate. */
async function observation(context: CeremonyContext, event: ReleaseEvent, shell: Shell): Promise<Extract<ReleaseFact, { kind: "observation" }>> {
  const { github } = requireTeamHome(await context.store.read(), context.goal.teamId);
  if (!event.prUrl?.startsWith(`https://github.com/${github}/pull/`) || !validSha(event.headSha)) throw new Error("Invalid integration observation target.");
  let state: Extract<ReleaseFact, { kind: "observation" }>["state"] = "UNKNOWN";
  let conflicting: boolean | null = null;
  try {
    const result = await runGh(shell, ["pr", "view", event.prUrl, "--json", "state,headRefName,baseRefName,headRefOid,isCrossRepository,mergeable"], dirname(context.store.runtimeDir));
    const pr: unknown = JSON.parse(result.stdout);
    if (result.code === 0 && object(pr) && pr.headRefOid === event.headSha && pr.headRefName === context.goal.integration?.branch
      && pr.baseRefName === "main" && pr.isCrossRepository === false && ["OPEN", "CLOSED", "MERGED"].includes(String(pr.state))) {
      state = pr.state as typeof state;
      conflicting = pr.mergeable === "CONFLICTING" ? true : pr.mergeable === "MERGEABLE" ? false : null;
    }
  } catch { /* A failed or moving read cannot resolve a conflict. Never retain its diagnostics. */ }
  return { kind: "observation", key: hookId("observation", randomUUID()), at: new Date().toISOString(), prUrl: event.prUrl, headSha: event.headSha, state, conflicting };
}

/** Discovered by the owner-control composition. Gate requests are not counted until a matching result exists. */
export function createCeremonyAdapters(_services: { store: PlanningStore }, shell: Shell = processShell): CeremonyAdapters {
  // Only an uninterrupted request can be paired with merge-blocked: that hook can also mean a pre-command check failed.
  const active = new Map<string, Extract<ReleaseFact, { kind: "merge-started" }>>();
  return { releaseEvent: async (context, event) => {
    if (event.gate !== "integration" || !event.prUrl) return;
    const recorder = new ReleaseRecorder(context.store, context.goal.id);
    const identity = join(context.store.runtimeDir, context.goal.id);
    if (event.kind === "head-observed") {
      active.delete(identity);
      await recorder.observe(await observation(context, event, shell), context.goal.integration?.status === "collecting");
    } else if (event.kind === "merge-requested") {
      const attemptId = hookId("merge", event.key);
      const started = fact({ kind: "merge-started", key: attemptId, attemptId, at: event.at, prUrl: event.prUrl, headSha: event.headSha }) as Extract<ReleaseFact, { kind: "merge-started" }>;
      await recorder.record(started);
      active.set(identity, started);
    } else if (event.kind === "merge-blocked") {
      const started = active.get(identity);
      if (started?.prUrl === event.prUrl && started.headSha === event.headSha) {
        await recorder.record({ kind: "merge-finished", key: `${started.attemptId}:failed`, at: new Date().toISOString(), prUrl: started.prUrl, headSha: started.headSha, attemptId: started.attemptId, result: "failed" });
      }
      active.delete(identity);
    } else if (event.kind === "merged" && validSha(event.headSha) && validSha(event.mergedSha)) {
      const integration = context.goal.integration;
      if (integration?.status !== "merged" || integration.prUrl !== event.prUrl || integration.headSha !== event.headSha || integration.mergedSha !== event.mergedSha) return;
      const events = (await recorder.read())?.events ?? [];
      const matching = events.filter((item) => item.prUrl === event.prUrl && "headSha" in item && item.headSha === event.headSha).reverse();
      // A receipt confirms the latest request, including one whose command response was lost. Earlier unresolved requests stay unknown.
      const started = matching.find((item) => item.kind === "merge-started");
      const unrecorded = hookId("unrecorded", event.mergedSha);
      const finished = matching.find((item) => item.kind === "merge-finished" && item.attemptId === (started?.kind === "merge-started" ? started.attemptId : unrecorded));
      if (finished?.kind === "merge-finished" && finished.result === "merged") return;
      const attemptId = started?.kind === "merge-started" && (!finished || (finished.kind === "merge-finished" && finished.result === "unknown"))
        ? started.attemptId : unrecorded;
      await recorder.record({ kind: "merge-finished", key: `${attemptId}:merged`, at: new Date().toISOString(), prUrl: event.prUrl, headSha: event.headSha, attemptId, result: "merged" });
      active.delete(identity);
    }
  } };
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
