import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DeveloperGoal, developerGoalJournalName } from "../src/developer-goal.js";
import { LaneError, type DeveloperLaneServices, type LaneJournal, type LaneObservation } from "../src/developer-lanes.js";
import { goalRuntimeFilename, type GoalBrief, type GoalLane, type GoalReport, type GoalRuntimeRecord, type LanePlan, type WorkflowEvent, type WorkflowFailure } from "../src/goal-contract.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import { stateCheckout } from "./state-checkout.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-09-30T00:00:00Z";
const goalId = "goal-isolation";
const teamId = "team-one";
const seatId = "seat-three";
const repo = "fixture/project";
const baseSha = "0".repeat(40);
const rejectedMessage = "Worker needs unowned files or returned invalid content.";
const startup = (): WorkflowEvent => ({ kind: "startup", teamId, at });
const retry = (id: string): WorkflowEvent => ({ kind: "retry", id, teamId, goalId, at, reason: "Retry the retained failed lane" });
const summary = { summary: "Owned work", decisions: ["Preserve drafts"], followUps: [], neededButUnowned: [] };
interface PrivateJournal {
  lanes: Record<string, LaneJournal>;
  failures?: { goal: WorkflowFailure | null; lanes: Record<string, WorkflowFailure> };
  consumedRetryIds?: string[];
}

/** Git/agent services are controlled here; the real orchestrator, durable files and goal lock are exercised. */
class Lanes implements DeveloperLaneServices {
  builds: { lane: string; attempt: number }[] = [];
  observations: string[] = [];
  merges: string[] = [];
  finishCalls = 0;
  rejected = new Set(["a"]);
  remote = new Map<string, LaneObservation>();
  beforeBuild?: (lane: GoalLane, journal: LaneJournal) => Promise<void>;
  mergeConfirmation?: (observation: LaneObservation) => void;
  constructor(readonly lanePlan: LanePlan) {}
  async plan() { return this.lanePlan; }
  create(lane: GoalLane): LaneJournal {
    return { id: lane.id, branch: lane.branch, worktree: `/fixture/${lane.id}`, baseSha, gitDir: "/fixture/.git", prepared: true,
      sessions: [], attempt: 0, built: false, summary: null, checks: [], prUrl: null, headSha: null, mergedSha: null, fixes: [], review: null, reviewWorktrees: {}, cleaned: false };
  }
  async build(lane: GoalLane, _brief: GoalBrief, journal: LaneJournal, persist: () => Promise<void>) {
    this.builds.push({ lane: lane.id, attempt: journal.attempt });
    await this.beforeBuild?.(lane, journal);
    if (this.rejected.has(lane.id)) {
      journal.sessions.push({ key: `worker:${journal.attempt}:src/${lane.id}.ts`, role: "worker", status: "complete", startedAt: at,
        result: { sessionId: `worker-${lane.id}-${journal.attempt}`, startedAt: at, finishedAt: at, response: { ...summary, content: "retained output", neededButUnowned: [`tests/${lane.id}.test.ts`] } } });
      await persist(); throw new LaneError(rejectedMessage);
    }
    journal.built = true; journal.summary = summary; await persist();
  }
  async publish(lane: GoalLane, _brief: GoalBrief, journal: LaneJournal, persist: () => Promise<void>) {
    const number = this.lanePlan.lanes.findIndex((item) => item.id === lane.id) + 1;
    journal.headSha = number.toString().repeat(40); journal.prUrl = `https://github.com/${repo}/pull/${number}`;
    this.remote.set(lane.id, { url: journal.prUrl, headSha: journal.headSha, baseSha, state: "OPEN", mergedSha: null, reviewed: false, ci: "pending", ciFailure: "", conflict: false, files: lane.ownedFiles });
    await persist(); return journal.prUrl;
  }
  async observe(lane: GoalLane, _brief: GoalBrief, journal: LaneJournal) {
    this.observations.push(lane.id);
    const observation = this.remote.get(lane.id)!;
    if (observation.headSha !== journal.headSha) throw new LaneError("Lane PR head changed outside its recorded lead turn.");
    return { ...observation };
  }
  async review(lane: GoalLane, _brief: GoalBrief, journal: LaneJournal, observation: LaneObservation, persist: () => Promise<void>) {
    journal.review = { id: `review-${lane.id}`, headSha: observation.headSha, findings: [], body: "Reviewed exact head", posted: true, verdict: "APPROVE", comments: [] };
    this.remote.get(lane.id)!.reviewed = true; await persist();
  }
  async fix(): Promise<void> { throw new LaneError("A repair needs an explicit retry in this fixture."); }
  async merge(url: string) {
    this.merges.push(url);
    const observed = [...this.remote.values()].find((item) => item.url === url)!;
    expect(observed.reviewed).toBe(true); expect(observed.ci).toBe("passed");
    observed.state = "MERGED"; observed.mergedSha = observed.headSha.slice(0, 39) + "f";
    const sha = observed.mergedSha; this.mergeConfirmation?.(observed); return { merged: true as const, sha };
  }
  async finish(_brief: GoalBrief, lanes: { lane: GoalLane; journal: LaneJournal }[]) {
    this.finishCalls++;
    expect(lanes.every(({ journal }) => !!journal.mergedSha)).toBe(true);
    const checks: GoalReport["checks"] = ["npm run typecheck", "npm test", "npm run build"].map((command) => ({ command, exitCode: 0 }));
    return { headSha: "f".repeat(40), checks, followUps: [] };
  }
}

async function fixture(dependent = false) {
  const ownedFiles = ["src/**", "tests/**"];
  const outcomes = [{ number: 1, title: "Reliable lanes", description: "Deliver independent owned changes", reason: "Mission", currentCode: ["src/a.ts"] }];
  const goal: PlanningGoal = { workflowModel: "goals-v1", id: goalId, teamId, seatId: "seat-one", participantSeatIds: [], goal: "Reliable lanes", projectRefs: [repo], stage: "approved", createdAt: at, updatedAt: at,
    mattermost: { channelId: "home", rootPostId: "proposal-post" }, brief: { summary: "Reliable lanes", decisions: [], openQuestions: [] }, ownedFiles,
    goalProposal: { version: 1, goalId, proposalId: "proposal-one", productSeatId: "seat-two", rank: 1, mission: "docs/mission.md", summary: "Reliable lanes", outcomes, ownedFiles, risks: [], rationale: "Mission", basedOnRetros: [] },
    goalAssignment: { seatId, status: "running", updatedAt: at }, integration: { branch: `sprint/${goalId}`, baseSha, status: "collecting" },
    ceremony: { version: 1, stage: "implement", history: [ { stage: "planning", enteredAt: at }, { stage: "proposal", enteredAt: at },
      { stage: "implement", enteredAt: at, evidence: { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at } } } ] } };
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: teamId, slug: "fixture", displayName: "Fixture", workflowModel: "goals-v1", project: { github: repo },
    externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-one", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "lead", username: "lead" } } },
      { id: "seat-two", displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { userId: "product", username: "product" } } },
      { id: seatId, displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
    ] }], planningGoals: [goal] };
  const root = await stateCheckout("indra-lane-isolation-", state); roots.push(root, `${root}.runtime`);
  await mkdir(join(root, "schema/v1"), { recursive: true }); await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(root, "schema/v1/state.schema.json"));
  const store = new PlanningStore(root, undefined, { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } });
  const brief: GoalBrief = { version: 1, goalId, teamId, seatId, header: { repo, baseBranch: "main", baseSha, branch: `sprint/${goalId}`, prTarget: "main" },
    outcomes, ownedFiles, exclusions: [], swarm: "Independent single-file workers", retros: [], redirects: [], reportFormat: "Verified report and checks" };
  const record: GoalRuntimeRecord = { version: 1, goalId, teamId, assignment: goal.goalAssignment!, brief, plan: null, lanes: [], report: null, events: [], handledEventIds: [], redirects: [], failure: null, updatedAt: at };
  await store.saveRuntime(goalRuntimeFilename(goalId), record);
  const plan: LanePlan = { version: 1, goalId, contractLaneId: null, lanes: (dependent ? ["a", "b", "c"] : ["a", "b"]).map((id) => ({ id, branch: `codex/${goalId}/${id}`, ownedFiles: [`src/${id}.ts`, `tests/${id}.test.ts`], dependsOn: id === "c" ? ["a"] : [] })) };
  const services = new Lanes(plan);
  const runner = () => new DeveloperGoal(store, seatId, { run: async () => { throw new Error("Unexpected shell"); } }, () => ({ message: async () => { throw new Error("Unexpected agent"); } }), () => {}, services);
  const current = async () => (await store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename(goalId)))!;
  const journal = async () => (await store.readRuntimeFile<PrivateJournal>(developerGoalJournalName(goalId)))!;
  const ci = async (laneId = "b", id = "ci-b"): Promise<Extract<WorkflowEvent, { kind: "ci" }>> => {
    const lane = (await current()).lanes.find((item) => item.id === laneId)!;
    return { kind: "ci", id, teamId, goalId, laneId, prUrl: lane.prUrl!, headSha: lane.headSha!, state: "passed", at };
  };
  const legacy = async (message = rejectedMessage) => {
    const saved = await journal(); delete saved.failures; await store.saveRuntime(developerGoalJournalName(goalId), saved);
    const currentRecord = await current(); currentRecord.failure = { at, message, retryable: true }; currentRecord.lanes[0].status = "running";
    await store.saveRuntime(goalRuntimeFilename(goalId), currentRecord);
  };
  return { store, services, runner, current, journal, ci, legacy };
}

describe("independent Developer lane failure isolation", () => {
  it("merges a healthy lane on later CI while keeping the failed lane and its dependent blocked", async () => {
    const f = await fixture(true); await f.runner().turn(startup());
    const failed = (await f.current()).failure;
    expect(failed?.message).toBe(rejectedMessage);
    expect((await f.current()).lanes.map((lane) => lane.status)).toEqual(["failed", "pr-open", "queued"]);
    f.services.remote.get("b")!.ci = "passed";
    const result = await f.runner().turn(await f.ci());
    expect(result.report).toBeNull(); expect(result.events.some((item) => item.kind === "merge" && item.laneId === "b")).toBe(true);
    expect((await f.current()).lanes.map((lane) => lane.status)).toEqual(["failed", "merged", "queued"]);
    expect((await f.current()).failure).toEqual(failed);
    expect(f.services.builds).toEqual([{ lane: "a", attempt: 0 }, { lane: "b", attempt: 0 }]);
    expect(f.services.finishCalls).toBe(0);
  });

  it("attributes the retained legacy rejection and re-observes healthy PRs at startup despite old event receipts", async () => {
    const f = await fixture(); await f.runner().turn(startup()); await f.legacy();
    const record = await f.current(); record.handledEventIds.push("already-receipted-ci"); await f.store.saveRuntime(goalRuntimeFilename(goalId), record);
    f.services.remote.get("b")!.ci = "passed";
    await f.runner().turn(startup());
    expect((await f.current()).lanes.map((lane) => lane.status)).toEqual(["failed", "merged"]);
    expect((await f.journal()).failures).toEqual({ goal: null, lanes: { a: record.failure } });
    expect(f.services.builds.filter((item) => item.lane === "a")).toHaveLength(1);
    expect((await f.journal()).lanes.a.sessions[0].result?.response).toMatchObject({ content: "retained output" });
    expect(f.services.finishCalls).toBe(0);
  });

  it.each(["unknown failure", "missing rejected response", "uncertain unfinished sibling"])("keeps %s globally blocked until an explicit retry", async (reason) => {
    const f = await fixture(); await f.runner().turn(startup()); await f.legacy(reason === "unknown failure" ? "Unattributed runtime error" : rejectedMessage);
    const journal = await f.journal();
    if (reason === "missing rejected response") journal.lanes.a.sessions = [];
    if (reason === "uncertain unfinished sibling") journal.lanes.b.built = false;
    await f.store.saveRuntime(developerGoalJournalName(goalId), journal);
    f.services.remote.get("b")!.ci = "passed"; const observations = f.services.observations.length;
    await f.runner().turn(startup()); await f.runner().turn(await f.ci());
    expect(f.services.observations).toHaveLength(observations); expect(f.services.merges).toEqual([]);
    expect((await f.current()).failure).not.toBeNull();
    expect(f.services.builds).toHaveLength(2);
  });

  it("rejects stale identities and treats passing event payloads as hints requiring observed CI and review", async () => {
    const f = await fixture(); await f.runner().turn(startup()); const valid = await f.ci();
    const observations = f.services.observations.length;
    await f.runner().turn({ ...valid, id: "wrong-head", headSha: "e".repeat(40) });
    await f.runner().turn({ ...valid, id: "wrong-pr", prUrl: `https://github.com/${repo}/pull/999` });
    await f.runner().turn({ kind: "agent-completed", id: "forged", teamId, goalId, laneId: "b", agentId: "stranger", status: "succeeded", headSha: valid.headSha, report: null, at });
    expect(f.services.observations).toHaveLength(observations);
    await f.runner().turn(valid); expect(f.services.merges).toEqual([]);
    const observed = f.services.observations.length; await f.runner().turn(valid); expect(f.services.observations).toHaveLength(observed);
    f.services.remote.get("b")!.ci = "passed"; f.services.remote.get("b")!.reviewed = false;
    await f.runner().turn({ ...valid, id: "unreviewed" }); expect(f.services.merges).toEqual([]);
    f.services.remote.get("b")!.reviewed = true;
    await f.runner().turn({ ...valid, id: "verified" }); expect(f.services.merges).toEqual([valid.prUrl]);
    expect(f.services.builds.filter((item) => item.lane === "a")).toHaveLength(1);
  });

  it("still verifies the actual merge result before declaring a healthy lane merged", async () => {
    const f = await fixture(); await f.runner().turn(startup()); f.services.remote.get("b")!.ci = "passed";
    f.services.mergeConfirmation = (observation) => { observation.reviewed = false; };
    const result = await f.runner().turn(await f.ci());
    expect(result.report).toBeNull(); expect((await f.current()).lanes.map((lane) => lane.status)).toEqual(["failed", "failed"]);
    expect((await f.journal()).failures?.lanes.b.message).toContain("merge was not confirmed");
    expect(f.services.finishCalls).toBe(0);
  });

  it("allows a fresh retry only once, retains successful work, and reports only after every lane merges", async () => {
    const f = await fixture(); await f.runner().turn(startup()); f.services.remote.get("b")!.ci = "passed";
    await f.runner().turn(await f.ci());
    await f.runner().turn(retry("failed-retry"));
    expect((await f.current()).failure).not.toBeNull();
    expect((await f.journal()).lanes.a.attempt).toBe(1); expect((await f.journal()).lanes.b.attempt).toBe(0);
    const builds = f.services.builds.length; await f.runner().turn(retry("failed-retry")); await f.runner().turn(startup());
    expect(f.services.builds).toHaveLength(builds);
    expect((await f.current()).handledEventIds.filter((id) => id === "failed-retry")).toHaveLength(1);
    f.services.rejected.delete("a"); await f.runner().turn(retry("fresh-retry"));
    expect((await f.current()).failure).toBeNull(); expect((await f.journal()).lanes.a.sessions).toHaveLength(2);
    f.services.remote.get("a")!.ci = "passed";
    const completed = await f.runner().turn(await f.ci("a", "ci-a"));
    expect(completed.report?.lanePrs).toHaveLength(2); expect(f.services.finishCalls).toBe(1);
    expect((await f.store.read()).planningGoals![0].goalAssignment?.status).toBe("reported");
    expect(f.services.builds).toEqual([{ lane: "a", attempt: 0 }, { lane: "b", attempt: 0 }, { lane: "a", attempt: 1 }, { lane: "a", attempt: 2 }]);
  });

  it("retains retry consumption if the private write succeeds but the public receipt write is interrupted", async () => {
    const f = await fixture(); await f.runner().turn(startup()); const save = f.store.saveRuntime.bind(f.store);
    const spy = vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      await save(name, value);
      if (name === developerGoalJournalName(goalId) && (value as PrivateJournal).consumedRetryIds?.includes("interrupted-retry")) throw new Error("Lost response after durable private receipt");
    });
    await expect(f.runner().turn(retry("interrupted-retry"))).rejects.toThrow("Lost response"); spy.mockRestore();
    expect((await f.current()).handledEventIds).not.toContain("interrupted-retry");
    expect((await f.journal()).lanes.a.attempt).toBe(1);
    await f.runner().turn(retry("interrupted-retry")); expect(f.services.builds).toHaveLength(2);
    f.services.rejected.delete("a"); await f.runner().turn(startup());
    expect((await f.current()).failure).toBeNull(); expect((await f.journal()).lanes.a.attempt).toBe(1);
    expect(f.services.builds).toEqual([{ lane: "a", attempt: 0 }, { lane: "b", attempt: 0 }, { lane: "a", attempt: 1 }]);
  });

  it("settles every started sibling before failure finalization and release of the goal lock", async () => {
    const f = await fixture(); let release!: () => void; let started!: () => void; let rejected!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const siblingStarted = new Promise<void>((resolve) => { started = resolve; });
    const failureStarted = new Promise<void>((resolve) => { rejected = resolve; });
    f.services.beforeBuild = async (lane) => { if (lane.id === "a") { await siblingStarted; rejected(); throw new LaneError("A failed"); } started(); await gate; };
    let settled = false; const turn = f.runner().turn(startup()).finally(() => { settled = true; });
    await failureStarted; await new Promise<void>((resolve) => setImmediate(resolve));
    let nextLocked = false; const next = f.store.withGoalLock(goalId, async () => { nextLocked = true; });
    try {
      expect(settled).toBe(false); expect((await f.current()).failure).toBeNull();
      expect(nextLocked).toBe(false); expect(f.services.finishCalls).toBe(0);
    } finally { release(); await Promise.all([turn, next]); }
    expect((await f.current()).lanes.map((lane) => lane.status)).toEqual(["failed", "pr-open"]);
    expect(nextLocked).toBe(true);
    const saved = await f.journal(); await new Promise<void>((resolve) => setImmediate(resolve)); expect(await f.journal()).toEqual(saved);
  });
});
