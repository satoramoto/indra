import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImplementationRecorder, implementationEligible, implementationWallTime, readImplementationFacts, type ImplementationAttempt } from "../src/implementation-facts.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import type { SeatTaskRecord } from "../src/developer-seat.js";

const dirs: string[] = [];
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "indra-attempts-")); dirs.push(dir);
  const store = new PlanningStore(join(dir, "state"));
  const facts = new ImplementationRecorder(store, "seat-004", "goal-one", "outcome-one");
  return { store, facts };
}

describe("implementation facts", () => {
  it("sums claim-to-terminal intervals including waits but excluding queued time, without counting replay twice", async () => {
    const { facts } = await fixture();
    const first = await facts.prepareClaim(at(0), at(10)); await facts.confirmClaim(first.id);
    await facts.event(first.id, { kind: "ci", result: "failed" }, "ci-result", at(40));
    await facts.finish(first.id, "failed", at(40));
    const second = await facts.prepareClaim(at(90), at(100)); await facts.confirmClaim(second.id);
    await facts.finish(second.id, "merged", at(150));
    const attempts = (await facts.read()).attempts;
    expect(attempts.map((item) => item.cause)).toEqual(["claim", "retry"]);
    expect(implementationWallTime([...attempts, ...attempts])).toEqual({ wallTimeMs: 80_000, knownWallTimeMs: 80_000, unknownIntervals: 0 });
    await facts.finish(second.id, "merged", at(200));
    expect(implementationWallTime((await facts.read()).attempts).wallTimeMs).toBe(80_000);
  });

  it("labels missing, open, and invalid intervals unknown instead of estimating from sessions", () => {
    const attempt = (id: string, claimedAt: string | null, end?: string): ImplementationAttempt => ({ id, cause: "recovered", claimedAt, ...(end ? { terminal: { status: "failed", at: end } as const } : {}), events: [] });
    expect(implementationWallTime([attempt("a", null, at(30)), attempt("b", at(10)), attempt("c", at(20), at(15)), attempt("d", at(5), at(10))]))
      .toEqual({ wallTimeMs: null, knownWallTimeMs: 5000, unknownIntervals: 3 });
  });

  it("reuses an unconfirmed claim after restart, and retains independent sessions and reviews exactly once", async () => {
    const { store, facts } = await fixture();
    const initial = await facts.prepareClaim(at(0), at(10));
    const restart = new ImplementationRecorder(store, "seat-004", "goal-one", "outcome-one");
    expect((await restart.prepareClaim(at(0), at(20))).id).toBe(initial.id);
    await restart.confirmClaim(initial.id);
    await Promise.all([
      restart.event(initial.id, { kind: "review", verdict: "REQUEST_CHANGES", findings: ["file.ts:2: Bug"] }, "review-1"),
      restart.event(initial.id, { kind: "session", session: { invocationId: "one", engine: "codex", startedAt: at(10), finishedAt: at(20), status: "failed", usage: { inputTokens: 15 } } }, "session-1"),
    ]);
    await restart.event(initial.id, { kind: "review", verdict: "REQUEST_CHANGES", findings: ["file.ts:2: Bug"] }, "review-1");
    const result = await readImplementationFacts(store, "goal-one");
    expect(result).toHaveLength(1);
    expect(result[0].attempts).toHaveLength(1);
    expect(result[0].attempts[0].claimedAt).toBe(at(20));
    expect(result[0].attempts[0].events.map((item) => item.id).sort()).toEqual(["review-1", "session-1"]);
  });

  it("retains legacy round counts, findings and numeric usage independently of mutable records", async () => {
    const { facts } = await fixture();
    const record: SeatTaskRecord = { goalId: "goal-one", outcomeId: "outcome-one", branch: "seat-004/goal-one-outcome-one", worktree: "/retained", step: "ci", conflictRounds: 2, reviewFixRounds: 1, findings: ["file.ts:2: Bug"], sessions: [{ role: "fix", sessionId: "one", startedAt: at(10), finishedAt: at(20), usage: { input_tokens: 15, diagnostic: "private provider output" } }] };
    const id = await facts.retain(record);
    await facts.retain(record);
    record.conflictRounds = 0; record.findings = []; record.sessions = [];
    const attempt = (await facts.read()).attempts[0];
    expect(attempt.id).toBe(id);
    expect(attempt.claimedAt).toBeNull();
    expect(attempt.events).toHaveLength(1);
    expect(attempt.events[0].retained).toMatchObject({ conflictRounds: 2, reviewFixRounds: 1, findings: ["file.ts:2: Bug"], sessions: [{ usage: { input_tokens: 15 } }] });
    expect(JSON.stringify(attempt)).not.toContain("private provider output");
  });
});


it("keeps whole goals and closed historical goals out of the per-outcome claimant", () => {
  const legacy = { id: "goal-one", stage: "approved", integration: { branch: "sprint/goal-one", status: "collecting" }, ceremony: { stage: "implement" } } as PlanningGoal;
  expect(implementationEligible(legacy)).toBe(true);
  expect(implementationEligible({ ...legacy, workflowModel: "goals-v1" })).toBe(false);
  expect(implementationEligible({ ...legacy, ceremony: { ...legacy.ceremony!, closure: {} as NonNullable<PlanningGoal["ceremony"]>["closure"] } })).toBe(false);
});
