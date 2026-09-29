import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SeatTaskRecord } from "./developer-seat.js";
import type { PlanningGoal, PlanningStore } from "./planning.js";
import { redactSecrets } from "./redact.js";
import type { RuntimeSessionFacts } from "./runtime-facts.js";
import { withFileLock } from "./state-commit.js";

/** Legacy approval alone is not permission to execute, retry, or target main. */
export const implementationEligible = (goal: PlanningGoal) => goal.workflowModel !== "goals-v1" && goal.stage === "approved"
  && goal.ceremony?.stage === "implement" && !goal.ceremony.closure
  && goal.integration?.branch === `sprint/${goal.id}` && goal.integration.status === "collecting";

export interface ImplementationEvent {
  id: string; at: string;
  kind: "resume" | "review" | "fix" | "conflict" | "ci" | "merge" | "failure" | "retry" | "retained" | "session";
  result?: "started" | "passed" | "failed" | "retry" | "recovered";
  round?: number; message?: string; prUrl?: string; headSha?: string;
  verdict?: "APPROVE" | "REQUEST_CHANGES"; findings?: string[];
  role?: "developer" | "reviewer" | "fix"; session?: RuntimeSessionFacts;
  /** Snapshot before replacing a record or resetting its counters. Never deleted by maintenance. */
  retained?: Pick<SeatTaskRecord, "branch" | "worktree" | "prUrl" | "findings" | "conflictRounds" | "reviewFixRounds" | "sessions">;
}
export interface ImplementationAttempt {
  id: string; cause: "claim" | "retry" | "recovered";
  /** A persisted claim intent is confirmed only after the running state is committed. */
  claim?: { queuedAt: string; at: string };
  claimedAt: string | null;
  terminal?: { status: "merged" | "failed" | "unknown"; at: string | null };
  events: ImplementationEvent[];
}
export interface ImplementationFacts {
  version: 1; goalId: string; outcomeId: string; seatId: string; attempts: ImplementationAttempt[];
}
export const implementationFactsName = (seatId: string, goalId: string, outcomeId: string) => `implementation-${goalId}-${seatId}-${outcomeId}`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One durable ledger per assignment, independent of worktrees, primary records and retained archives. */
export class ImplementationRecorder {
  readonly name: string;
  constructor(private readonly store: PlanningStore, readonly seatId: string, readonly goalId: string, readonly outcomeId: string) {
    this.name = implementationFactsName(seatId, goalId, outcomeId);
  }
  async read(): Promise<ImplementationFacts> {
    return await this.store.readRuntimeFile<ImplementationFacts>(this.name)
      ?? { version: 1, seatId: this.seatId, goalId: this.goalId, outcomeId: this.outcomeId, attempts: [] };
  }
  private async update<T>(mutate: (facts: ImplementationFacts) => T): Promise<T> {
    return withFileLock(join(this.store.runtimeDir, `${this.name}.lock`), async () => {
      const facts = await this.read();
      const result = mutate(facts);
      await this.store.saveRuntime(this.name, facts);
      return result;
    });
  }
  async prepareClaim(queuedAt: string, at: string): Promise<ImplementationAttempt> {
    return this.update((facts) => {
      const last = facts.attempts.at(-1);
      if (last?.claim?.queuedAt === queuedAt && !last.claimedAt && !last.terminal) {
        // State is still queued: a failed claim transaction did not start the interval.
        last.claim.at = at;
        return last;
      }
      // An explicit re-queue with missing terminal evidence cannot invent a finish time.
      if (last && !last.terminal) last.terminal = { status: "unknown", at: null };
      const attempt: ImplementationAttempt = { id: randomUUID(), cause: last ? "retry" : "claim", claim: { queuedAt, at }, claimedAt: null, events: [] };
      facts.attempts.push(attempt);
      return attempt;
    });
  }
  async confirmClaim(id: string): Promise<void> {
    await this.update((facts) => {
      const attempt = facts.attempts.find((item) => item.id === id)!;
      if (!attempt.claim) throw new Error("Implementation claim intent is missing.");
      attempt.claimedAt ??= attempt.claim.at;
    });
  }
  /** Old records have no trustworthy claim boundary. Recovery never fabricates one from session timestamps. */
  async recover(record?: SeatTaskRecord): Promise<string> {
    return this.update((facts) => {
      let attempt = record?.attemptId ? facts.attempts.find((item) => item.id === record.attemptId)
        : record ? [...facts.attempts].reverse().find((item) => item.events.some((event) => event.retained?.branch === record.branch && event.retained.worktree === record.worktree))
          : facts.attempts.at(-1);
      if (!attempt) {
        attempt = { id: record?.attemptId ?? randomUUID(), cause: "recovered", claimedAt: null, events: [] };
        facts.attempts.push(attempt);
      }
      return attempt.id;
    });
  }
  async event(id: string, event: Omit<ImplementationEvent, "id" | "at">, key: string = randomUUID(), at = new Date().toISOString()): Promise<void> {
    await this.update((facts) => {
      const attempt = facts.attempts.find((item) => item.id === id);
      if (!attempt) throw new Error("Implementation attempt is missing.");
      if (!attempt.events.some((item) => item.id === key)) attempt.events.push({ ...event, id: key, at });
    });
  }
  async finish(id: string, status: "merged" | "failed", at = new Date().toISOString()): Promise<void> {
    await this.update((facts) => {
      const attempt = facts.attempts.find((item) => item.id === id)!;
      // Reconciliation can discover a merged PR after failure. Preserve the original interval and failure.
      attempt.terminal ??= { status, at };
    });
  }
  async retain(record: SeatTaskRecord): Promise<string> {
    const id = await this.recover(record);
    const retained: ImplementationEvent["retained"] = {
      branch: record.branch, worktree: record.worktree, prUrl: record.prUrl, findings: record.findings?.map(redactSecrets),
      conflictRounds: record.conflictRounds, reviewFixRounds: record.reviewFixRounds, sessions: record.sessions.map((session) => ({ ...session, usage: numericUsage(session.usage) })),
    };
    await this.event(id, { kind: "retained", retained }, `retained:${digest(retained)}`);
    return id;
  }
}

/** Sum recorded claim-to-terminal intervals once. A partial total is never presented as a complete duration. */
export function implementationWallTime(attempts: ImplementationAttempt[]): { wallTimeMs: number | null; knownWallTimeMs: number; unknownIntervals: number } {
  let knownWallTimeMs = 0; let unknownIntervals = 0;
  for (const attempt of new Map(attempts.map((item) => [item.id, item])).values()) {
    const start = Date.parse(attempt.claimedAt ?? ""); const end = Date.parse(attempt.terminal?.at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) unknownIntervals++;
    else knownWallTimeMs += end - start;
  }
  return { wallTimeMs: unknownIntervals ? null : knownWallTimeMs, knownWallTimeMs, unknownIntervals };
}

/** A seat can own several outcomes; queued gaps never enter its summed duration. */
export function implementationSeatWallTimes(records: ImplementationFacts[]) {
  const seats = new Map<string, ImplementationAttempt[]>();
  for (const record of records) seats.set(record.seatId, [...(seats.get(record.seatId) ?? []), ...record.attempts]);
  return [...seats].sort(([a], [b]) => a.localeCompare(b)).map(([seatId, attempts]) => ({ seatId, ...implementationWallTime(attempts) }));
}

/** Stable input for the retro reader, including attempts whose worktree or seat record was retired. */
export async function readImplementationFacts(store: PlanningStore, goalId: string): Promise<ImplementationFacts[]> {
  const files = await readdir(store.runtimeDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const result: ImplementationFacts[] = [];
  for (const file of files.filter((file) => file.startsWith(`implementation-${goalId}-`) && file.endsWith(".json")).sort()) {
    const facts = await store.readRuntimeFile<ImplementationFacts>(file.slice(0, -5));
    if (facts?.version === 1 && facts.goalId === goalId) result.push(facts);
  }
  return result;
}

/** Legacy provider usage can contain arbitrary diagnostics. Preserve counters, never arbitrary strings. */
function numericUsage(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const counter = numericUsage(item);
    return counter === undefined ? [] : [[key, counter]];
  }));
}
