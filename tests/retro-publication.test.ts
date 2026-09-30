import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CeremonyContext } from "../src/planning-bridge.js";
import { advanceCeremony, startCeremony, type HumanApproval } from "../src/ceremony.js";
import type { PlanningGoal, PlanningStore } from "../src/planning.js";
import { createCeremonyAdapters, recordedRetroInput, RetroPublication, retroRetryDelayMs, retroRuntimeName, type RetroPublicationRecord } from "../src/retro-publication.js";
import { buildRetroSnapshot, renderSprintRetro, RetroGenerationError, type RetroPriorAttempt, type SprintRetroDraft } from "../src/sprint-retro.js";
import { SprintGitHub, type RetroArchive, type RetroPr, type RetroReview } from "../src/sprint.js";
import { SeatRuntime } from "../src/seat-runtime.js";
import { TEAM_LEAD_CODEX_CONFIG, codexConfigForRoles } from "../src/harness-home.js";
import * as mattermost from "../src/planning-mattermost.js";
import { goalRuntimeFilename, type GoalReport, type WorkflowEvent } from "../src/goal-contract.js";
import { releaseAttemptsName } from "../src/sprint.js";
import { developerGoalJournalName } from "../src/developer-goal.js";
import type { GoalAgentSession } from "../src/seat-runtime.js";

afterEach(() => { vi.useRealTimers(); });
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
function goalAtRetro(): PlanningGoal {
  const goal: PlanningGoal = { id: "goal-one", teamId: "team-one", seatId: "seat-lead", participantSeatIds: ["seat-dev"], goal: "Ship", projectRefs: ["test/project"],
    stage: "approved", createdAt: at(0), updatedAt: at(6), mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Ship", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-one", createdAt: at(1), summary: "Ship", outcomes: [{ id: "outcome-one", seatId: "seat-dev", title: "Build", description: "Build" }], risks: [], openQuestions: [] },
    assignments: [{ outcomeId: "outcome-one", seatId: "seat-dev", prUrl: "https://github.com/test/project/pull/1", status: "merged", updatedAt: at(3) }],
    integration: { branch: "sprint/goal-one", baseSha: "a".repeat(40), status: "merged", mergedSha: "b".repeat(40), prUrl: "https://github.com/test/project/pull/2" }, ceremony: startCeremony(at(0)),
  };
  goal.ceremony = advanceCeremony(goal, { to: "proposal", at: at(1) });
  goal.ceremony = advanceCeremony(goal, { to: "implement", at: at(2), evidence: { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: at(2) } } });
  goal.ceremony = advanceCeremony(goal, { to: "release", at: at(3), evidence: { kind: "implementation", outcomes: [{ outcomeId: "outcome-one", seatId: "seat-dev", prUrl: "https://github.com/test/project/pull/1", baseBranch: "sprint/goal-one", mergedSha: "a".repeat(40), checksPassed: true, reviewApproved: true }] } });
  goal.ceremony = advanceCeremony(goal, { to: "retro", at: at(6), evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: "b".repeat(40), mergePostId: "release-post", approval: { source: "owner-command", command: "planning merge", at: at(4) }, checksPassed: true, buildSha: "b".repeat(40), runningSha: "b".repeat(40), runningAt: at(5) } });
  return goal;
}
async function fixture() {
  const goal = goalAtRetro();
  const state = { planningGoals: [goal], teams: [{ id: goal.teamId, project: { github: "test/project" }, seats: [{ id: goal.seatId, roles: ["Team Lead"] }], externalIdentities: { mattermost: { homeChannelId: "home" } } }] };
  const records = new Map<string, object>();
  const deliveries = new Map<string, { id: string; message: string; mergePost?: string }>();
  let lostPost = false;
  const context: CeremonyContext = { goal, runtime: { message: vi.fn() }, store: {
    checkout: "/nonexistent-retro-test-state", runtimeDir: "/nonexistent-retro-test-state.runtime",
    read: async () => structuredClone(state), readRuntimeFile: async (name: string) => structuredClone(records.get(name)),
    saveRuntime: async (name: string, value: object) => { records.set(name, structuredClone(value)); },
  } as unknown as PlanningStore,
    post: vi.fn(async (key, message, mergePost) => {
      const existing = deliveries.get(key); if (existing) return existing.id;
      const delivered = { id: `post-${deliveries.size + 1}`, message, mergePost }; deliveries.set(key, delivered);
      if (lostPost) { lostPost = false; throw new Error("Response lost"); }
      return delivered.id;
    }), recordRun: vi.fn(), recordSession: vi.fn(),
  };
  const draft = vi.fn(async (_context?: CeremonyContext, _prior?: RetroPriorAttempt[]): Promise<SprintRetroDraft> => {
    const snapshot = buildRetroSnapshot({ goal, cutoffAt: at(7), facts: { seats: [], sessions: [], reviews: [], rounds: [], failures: [] } });
    const generation = { sessionId: "retro-session", startedAt: at(8), finishedAt: at(9), status: "succeeded" as const, wallTimeMs: 1000,
      usage: { inputTokens: 12, uncachedInputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: 7, reasoningOutputTokens: null } };
    const narrative = snapshot.choices;
    return { snapshot, generation, narrative, markdown: await renderSprintRetro(snapshot, narrative, generation) };
  });
  const pr: RetroPr = { url: "https://github.com/test/project/pull/3", headSha: "c".repeat(40), state: "OPEN", reviewed: true, checksPassed: true };
  const archive: RetroArchive = {
    ensureRetroPr: vi.fn(async () => pr.url), inspectRetroPr: vi.fn(async () => structuredClone(pr)),
    reviewRetroPr: vi.fn(async (_github, _goalId, _markdown, _url, _head, review) => { await review("/managed/review"); }),
    mergeRetroPr: vi.fn(async () => { pr.state = "MERGED"; pr.mergedSha = "d".repeat(40); return { merged: true as const, sha: pr.mergedSha }; }),
  };
  const services = {
    thread: vi.fn(async () => ({ ownUserId: "chick", posts: [...deliveries.values()].map((post) => ({ ...post, user_id: "chick", channel_id: "home", root_id: "root", create_at: Date.now() })) })),
    review: vi.fn(async (_context: CeremonyContext, _worktree: string, _pr: RetroPr): Promise<RetroReview> => ({ summary: "Reviewed archive", findings: [] })),
  };
  const restart = () => new RetroPublication(archive, draft, services);
  const record = () => records.get(retroRuntimeName(goal.id)) as RetroPublicationRecord;
  const owner = (): HumanApproval => ({ source: "owner-command", command: "planning merge", at: new Date().toISOString() });
  return { context, state, draft, archive, pr, records, deliveries, services, restart, record, owner, losePost: () => { lostPost = true; } };
}

/** A reported goals-v1 goal whose one lane PR source is stubbed; no Developer journal is recorded yet. */
function goalsV1Retro(f: Awaited<ReturnType<typeof fixture>>) {
  const goal = f.context.goal;
  const report: GoalReport = { version: 1, goalId: goal.id, teamId: goal.teamId, seatId: "seat-dev", sprintBranch: "sprint/goal-one", headSha: "a".repeat(40),
    lanePrs: [{ laneId: "lane-one", url: "https://github.com/test/project/pull/1", headSha: "a".repeat(40), mergedSha: "b".repeat(40), reviewer: "satori-miyamoto", ci: "passed" }], checks: [{ command: "typecheck", exitCode: 0 }], decisions: [], followUps: [], neededButUnowned: [] };
  goal.workflowModel = "goals-v1"; goal.ownedFiles = ["src/**"]; goal.goalAssignment = { seatId: "seat-dev", status: "reported", updatedAt: at(3) };
  goal.goalProposal = { version: 1, goalId: goal.id, proposalId: "proposal-one", productSeatId: "seat-product", rank: 1, mission: "docs/mission.md", summary: "Ship", outcomes: [{ number: 1, title: "Deliver", description: "Deliver the goal", reason: "Mission", currentCode: ["src/a.ts"] }], ownedFiles: goal.ownedFiles, risks: [], rationale: "Useful", basedOnRetros: [] };
  delete goal.proposal; delete goal.assignments;
  const approval = goal.ceremony!.history.find((entry) => entry.stage === "implement")!; if (approval.evidence.kind === "approval") approval.evidence.proposalPostId = goal.mattermost.rootPostId;
  const release = goal.ceremony!.history.find((entry) => entry.stage === "release")!; release.evidence = { kind: "implementation", outcomes: [], goalDelivery: report };
  const github = new SprintGitHub({ run: vi.fn() }, "/unused");
  vi.spyOn(github, "prRetrospective").mockResolvedValue({ url: report.lanePrs[0].url, headSha: "a".repeat(40), decisions: "Decision", followUps: "Follow-up" });
  return { goal, github };
}
const codexUsage = { inputTokens: 1000, uncachedInputTokens: 200, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 };
const turn = (key: string, role: GoalAgentSession["role"], start: number, finish: number, sessionId: string): GoalAgentSession => ({ key, role, status: "complete", startedAt: at(start),
  result: { sessionId, response: {}, startedAt: at(start), finishedAt: at(finish), facts: { invocationId: `invocation-${key}`, engine: "codex", sessionId, startedAt: at(start), finishedAt: at(finish), status: "succeeded", usage: codexUsage } } });
const journal = (goalId: string, planning: GoalAgentSession[], lanes: Record<string, GoalAgentSession[]>, seatId = "seat-dev") =>
  ({ version: 1, goalId, seatId, github: "test/project", planning, lanes: Object.fromEntries(Object.entries(lanes).map(([id, sessions]) => [id, { id, sessions }])) });

describe("recoverable retro publication", () => {
  it("reads new-model lane PR sections and shared runtime facts without importing legacy seat records or inventing timings", async () => {
    const f = await fixture(); const goal = f.context.goal;
    const report: GoalReport = { version: 1, goalId: goal.id, teamId: goal.teamId, seatId: "seat-dev", sprintBranch: "sprint/goal-one", headSha: "a".repeat(40),
      lanePrs: [{ laneId: "lane-one", url: "https://github.com/test/project/pull/1", headSha: "a".repeat(40), mergedSha: "b".repeat(40), reviewer: "satori-miyamoto", ci: "passed" }], checks: [{ command: "typecheck", exitCode: 0 }], decisions: ["Unverified report claim"], followUps: [], neededButUnowned: [] };
    goal.workflowModel = "goals-v1"; goal.ownedFiles = ["src/**"]; goal.goalAssignment = { seatId: "seat-dev", status: "reported", updatedAt: at(3) };
    goal.goalProposal = { version: 1, goalId: goal.id, proposalId: "proposal-one", productSeatId: "seat-product", rank: 1, mission: "docs/mission.md", summary: "Ship", outcomes: [{ number: 1, title: "Deliver", description: "Deliver the goal", reason: "Mission", currentCode: ["src/a.ts"] }], ownedFiles: goal.ownedFiles, risks: [], rationale: "Useful", basedOnRetros: [] };
    delete goal.proposal; delete goal.assignments;
    const approval = goal.ceremony!.history.find((entry) => entry.stage === "implement")!; if (approval.evidence.kind === "approval") approval.evidence.proposalPostId = goal.mattermost.rootPostId;
    const release = goal.ceremony!.history.find((entry) => entry.stage === "release")!; release.evidence = { kind: "implementation", outcomes: [], goalDelivery: report };
    f.records.set(goalRuntimeFilename(goal.id), { goalId: goal.id, teamId: goal.teamId, lanes: [{ id: "lane-one", headSha: "a".repeat(40), mergedSha: "b".repeat(40), fixRounds: 2, conflictRounds: 1, findings: [{ path: "src/a.ts", line: 5, reason: "Latest recorded finding" }] }] });
    f.records.set(releaseAttemptsName(goal.id), { version: 1, goalId: goal.id, startedAt: at(3), conflicts: [], merges: [{ prUrl: goal.integration!.prUrl, headSha: "a".repeat(40), at: at(4) }] });
    const github = new SprintGitHub({ run: vi.fn() }, "/unused");
    const source = vi.spyOn(github, "prRetrospective").mockResolvedValue({ url: report.lanePrs[0].url, headSha: "a".repeat(40), decisions: "Actual merged PR decision", followUps: null });
    const read = vi.spyOn(f.context.store, "readRuntimeFile");
    const input = await recordedRetroInput(f.context, [], github);
    expect(source).toHaveBeenCalledExactlyOnceWith("test/project", goal.id, report.lanePrs[0].url, report.lanePrs[0].headSha);
    expect(input.lanePrs).toEqual([{ url: report.lanePrs[0].url, headSha: "a".repeat(40), decisions: "Actual merged PR decision", followUps: null }]);
    expect(input.facts.rounds).toEqual([{ outcomeId: "lane-one", fix: 2, conflict: 1 }]);
    expect(input.facts.seats).toContainEqual({ seatId: "seat-dev", wallTimeMs: null });
    expect(input.missing).toEqual(expect.arrayContaining([expect.stringContaining("token counters"), expect.stringContaining("Follow-ups")]));
    expect(buildRetroSnapshot(input).seats.find((seat) => seat.seatId === "seat-dev")!.wallTimeMs).toBeNull();
    expect(read.mock.calls.every(([name]) => !name.startsWith("seat-") && !name.startsWith("implementation-"))).toBe(true);
    source.mockRejectedValueOnce(new Error("The head no longer matches")); await expect(recordedRetroInput(f.context, [], github)).rejects.toThrow("head no longer matches");
  });

  it("adds every completed Developer journal session and their interval union as the Developer seat's wall time", async () => {
    const f = await fixture(); const { goal, github } = goalsV1Retro(f);
    // Planning 10-20s; lane-one 15-30s overlaps planning and lane-two 25-40s; a disjoint fix at 50-55s. Union: 10-40 plus 50-55 = 35s.
    f.records.set(developerGoalJournalName(goal.id), journal(goal.id, [turn("plan", "planner", 10, 20, "thread-plan")],
      { "lane-two": [turn("two", "lead", 25, 40, "thread-two")], "lane-one": [turn("one", "lead", 15, 30, "thread-one"), turn("fix", "fix", 50, 55, "thread-fix")] }));
    const input = await recordedRetroInput(f.context, [], github);
    expect(input.facts.sessions).toEqual([
      { seatId: "seat-dev", sessionId: "thread-plan", invocationId: "invocation-plan", startedAt: at(10), finishedAt: at(20), usage: codexUsage },
      { seatId: "seat-dev", sessionId: "thread-one", invocationId: "invocation-one", startedAt: at(15), finishedAt: at(30), usage: codexUsage },
      { seatId: "seat-dev", sessionId: "thread-fix", invocationId: "invocation-fix", startedAt: at(50), finishedAt: at(55), usage: codexUsage },
      { seatId: "seat-dev", sessionId: "thread-two", invocationId: "invocation-two", startedAt: at(25), finishedAt: at(40), usage: codexUsage },
    ]);
    expect(input.facts.seats).toContainEqual({ seatId: "seat-dev", wallTimeMs: 35_000 });
    expect(input.missing!.some((line) => line.includes("token counters") || line.includes("seat-dev"))).toBe(false);
    const snapshot = buildRetroSnapshot({ ...input, cutoffAt: at(59) });
    expect(snapshot.seats.find((seat) => seat.seatId === "seat-dev")!.wallTimeMs).toBe(35_000);
    expect(snapshot.sessions.filter((session) => session.seatId === "seat-dev").map((session) => session.usage.inputTokens)).toEqual([1000, 1000, 1000, 1000]);
  });

  it("keeps Developer wall time unknown when a journal turn was interrupted, while recording its completed sessions", async () => {
    const f = await fixture(); const { goal, github } = goalsV1Retro(f);
    f.records.set(developerGoalJournalName(goal.id), journal(goal.id, [turn("plan", "planner", 10, 20, "thread-plan")],
      { "lane-one": [{ key: "build", role: "lead", status: "started", startedAt: at(21) }], "lane-two": [{ key: "retry", role: "fix", status: "failed", startedAt: at(22) }] }));
    const input = await recordedRetroInput(f.context, [], github);
    expect(input.facts.sessions).toEqual([{ seatId: "seat-dev", sessionId: "thread-plan", invocationId: "invocation-plan", startedAt: at(10), finishedAt: at(20), usage: codexUsage }]);
    expect(input.facts.seats).toContainEqual({ seatId: "seat-dev", wallTimeMs: null });
    expect(input.missing).toEqual(expect.arrayContaining([
      "seat-dev: a Developer lead turn in lane lane-one was interrupted or failed without recorded timing or usage; wall time remains unknown.",
      "seat-dev: a Developer fix turn in lane lane-two was interrupted or failed without recorded timing or usage; wall time remains unknown.",
    ]));
    expect(input.missing!.some((line) => line.includes("public goal record"))).toBe(false);
    expect(buildRetroSnapshot({ ...input, cutoffAt: at(59) }).seats.find((seat) => seat.seatId === "seat-dev")!.wallTimeMs).toBeNull();
  });

  it("reports the public-record gap only when the Developer journal is missing, and never reads a foreign journal", async () => {
    const f = await fixture(); const { goal, github } = goalsV1Retro(f);
    const absent = await recordedRetroInput(f.context, [], github);
    expect(absent.facts.sessions).toEqual([]);
    expect(absent.facts.seats).toContainEqual({ seatId: "seat-dev", wallTimeMs: null });
    expect(absent.missing).toContain("The Developer goal journal is unavailable, and the public goal record does not contain Developer invocation timings or token counters; these remain unknown.");
    f.records.set(developerGoalJournalName(goal.id), journal(goal.id, [turn("plan", "planner", 10, 20, "thread-plan")], {}, "seat-other"));
    const foreign = await recordedRetroInput(f.context, [], github);
    expect(foreign.facts.sessions).toEqual([]);
    expect(foreign.facts.seats).toContainEqual({ seatId: "seat-dev", wallTimeMs: null });
    expect(foreign.missing).toContain("seat-dev: the Developer goal journal belongs to another goal or seat or is malformed; Developer invocation timings and token counters remain unknown.");
    expect(foreign.missing!.some((line) => line.includes("public goal record"))).toBe(false);
  });
  it("surfaces the protected merge setup blocker while retaining the open retrospective", async () => {
    const f = await fixture();
    const reason = "Automatic merge blocked: The target must require approving Code Owner reviews and dismiss stale approvals. See docs/remodel-contract.md for the required server-side Code Owner policy.";
    vi.mocked(f.archive.mergeRetroPr).mockResolvedValue({ merged: false, reason });
    expect(await f.restart().poll(f.context)).toEqual({ status: "pending", reason });
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    expect(f.pr.state).toBe("OPEN"); expect(f.state.planningGoals[0]).toEqual(goalAtRetro());
    expect(f.record().verifiedAt).toBeUndefined();
    await expect(f.restart().merge(f.context)).rejects.toThrow(reason);
  });

  it("wires production review to a new read-only runtime at the archive head without resuming Chick", async () => {
    const f = await fixture(); f.pr.checksPassed = false; await f.restart().poll(f.context); f.pr.reviewed = false;
    try {
      vi.spyOn(SprintGitHub.prototype, "ensureRetroPr").mockImplementation(f.archive.ensureRetroPr);
      vi.spyOn(SprintGitHub.prototype, "inspectRetroPr").mockImplementation(f.archive.inspectRetroPr);
      vi.spyOn(SprintGitHub.prototype, "reviewRetroPr").mockImplementation(f.archive.reviewRetroPr);
      vi.spyOn(mattermost, "readChickToken").mockResolvedValue("");
      vi.spyOn(mattermost.MattermostPlanningChat.prototype, "ownUserId").mockResolvedValue("chick");
      vi.spyOn(mattermost.MattermostPlanningChat.prototype, "since").mockImplementation(async () => (await f.services.thread()).posts);
      const reviewer = vi.spyOn(SeatRuntime.prototype, "message").mockImplementation(async function (this: SeatRuntime, prompt, schema, session, options) {
        expect((this as unknown as { cwd: string }).cwd).toBe("/managed/review");
        expect((this as unknown as { write?: unknown }).write).toBeUndefined();
        // The seat's roles from state select the Team Lead's harness config.
        expect(codexConfigForRoles((this as unknown as { roles?: string[] }).roles)).toBe(TEAM_LEAD_CODEX_CONFIG);
        expect(session).toBeUndefined(); expect(options?.purpose).toBe("review");
        expect(schema).toMatch(/schemas\/retro-review.json$/);
        expect(prompt).toContain(f.pr.headSha);
        return { sessionId: "fresh-review", startedAt: at(10), finishedAt: at(11), response: { summary: "Reviewed", findings: [] } };
      });
      const adapters = await createCeremonyAdapters({ store: f.context.store });
      await adapters.retro!.poll(f.context);
      expect(reviewer).toHaveBeenCalledTimes(1);
      expect(f.context.runtime.message).not.toHaveBeenCalled();
      expect(f.context.recordRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "fresh-review" }));
      expect(f.record().review?.headSha).toBe(f.pr.headSha);
    } finally { vi.restoreAllMocks(); }
  });

  it("reviews before CI finishes, saves the result before delivery, and starts fresh for a new head", async () => {
    const f = await fixture(); f.pr.reviewed = false; f.pr.checksPassed = false;
    vi.mocked(f.archive.reviewRetroPr).mockImplementationOnce(async (_github, _goal, _markdown, _url, head, review) => {
      await review("/managed/review");
      expect(f.record().review?.headSha).toBe(head);
      throw new Error("Review delivery interrupted");
    });
    await f.restart().poll(f.context); await f.restart().poll(f.context);
    expect(f.services.review).toHaveBeenCalledTimes(1);
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
    f.pr.headSha = "f".repeat(40);
    await f.restart().poll(f.context);
    expect(f.services.review).toHaveBeenCalledTimes(2);
    expect(f.record().review?.headSha).toBe(f.pr.headSha);
  });

  it("retries an interrupted automatic merge only after bot review and CI are still verified", async () => {
    const f = await fixture();
    vi.mocked(f.archive.mergeRetroPr).mockRejectedValueOnce(new Error("Interrupted before merge"));
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.record().authorization).toBeUndefined();
    f.pr.checksPassed = false;
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    f.pr.checksPassed = true;
    expect((await f.restart().poll(f.context)).status).toBe("complete");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(2);
  });

  it.each(["closed", "review", "ci"])("does not auto-merge when %s proof is missing", async (change) => {
    const f = await fixture();
    if (change === "closed") f.pr.state = "CLOSED";
    if (change === "review") f.pr.reviewed = false;
    if (change === "ci") f.pr.checksPassed = false;
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
  });

  it("reuses the frozen draft and accepted thread post when the delivery response is lost", async () => {
    const f = await fixture(); f.losePost();
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.ensureRetroPr).not.toHaveBeenCalled();
    const frozen = structuredClone(f.record().frozen);
    await f.restart().poll(f.context); await f.restart().poll(f.context);
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(f.record().frozen).toEqual(frozen);
    expect([...f.deliveries.values()].filter((post) => !post.mergePost)).toHaveLength(1);
    expect(f.archive.ensureRetroPr).toHaveBeenCalledWith("test/project", "goal-one", frozen!.markdown);
    expect([...f.deliveries.values()][0].message).toBe(frozen!.markdown);
  });

  it("requires an explicit retry after a failed goals-v1 draft on ordinary delivered events", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f);
    f.draft.mockRejectedValue(new Error("Draft unavailable"));
    const initial = await f.restart().poll(f.context);
    const events: WorkflowEvent[] = [
      { kind: "startup", teamId: f.context.goal.teamId, at: new Date().toISOString() },
      { kind: "build-running", id: "build-one", teamId: f.context.goal.teamId, goalId: f.context.goal.id, buildSha: "b".repeat(40), runningSha: "b".repeat(40), at: new Date().toISOString() },
      { kind: "ci", id: "ci-one", teamId: f.context.goal.teamId, goalId: f.context.goal.id, laneId: null, prUrl: f.pr.url, headSha: f.pr.headSha, state: "passed", at: new Date().toISOString() },
      { kind: "queue-changed", id: "queue-one", teamId: f.context.goal.teamId, at: new Date().toISOString() },
    ];
    vi.setSystemTime("2026-01-01T02:00:00.000Z");
    for (const event of events) {
      const context = { ...f.context, event };
      expect((await f.restart().poll(context)).status).toBe("pending");
    }
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(f.record().attempts).toHaveLength(1);
    expect(initial).toMatchObject({ status: "pending", failure: { at: "2026-01-01T01:00:00.000Z", message: expect.stringContaining("planning retry --goal goal-one"), retryable: true } });
    expect(f.archive.ensureRetroPr).not.toHaveBeenCalled();
  });

  const retryContext = (f: Awaited<ReturnType<typeof fixture>>, id: string, changes: Partial<Extract<WorkflowEvent, { kind: "retry" }>> = {}) => ({
    ...f.context, event: { kind: "retry" as const, id, goalId: f.context.goal.id, teamId: f.context.goal.teamId, at: new Date().toISOString(), reason: "The draft problem was resolved", ...changes },
  });

  it("consumes a fresh matching retry with its attempt before drafting and refuses replay after restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f);
    f.draft.mockRejectedValueOnce(new Error("First attempt failed")); await f.restart().poll(f.context);
    const failedAt = new Date().toISOString();
    vi.setSystemTime("2026-01-01T01:00:01.000Z");
    for (const changes of [{ at: failedAt }, { at: at(59) }, { goalId: "goal-other" }, { teamId: "team-other" }, { id: "" }]) {
      await f.restart().poll(retryContext(f, "invalid-retry", changes));
    }
    expect(f.draft).toHaveBeenCalledTimes(1); expect(f.record().attempts).toHaveLength(1);
    const retry = retryContext(f, "retry-one");
    f.draft.mockImplementationOnce(async () => {
      expect(f.record().attempts.at(-1)).toEqual({ startedAt: new Date().toISOString(), retry: { id: "retry-one", at: retry.event.at } });
      vi.setSystemTime("2026-01-01T01:00:03.000Z");
      throw new Error("Retry also failed");
    });
    await f.restart().poll(retry);
    expect(f.draft).toHaveBeenCalledTimes(2); expect(f.record().attempts).toHaveLength(2);
    vi.setSystemTime("2026-01-01T01:00:04.000Z");
    await f.restart().poll(retry); // Same event delivered again after process restart.
    await f.restart().poll(retryContext(f, "retry-one")); // Changing the time cannot reuse a consumed identity.
    await f.restart().poll(retryContext(f, "queued-during-draft", { at: "2026-01-01T01:00:02.000Z" }));
    expect(f.draft).toHaveBeenCalledTimes(2); expect(f.record().attempts).toHaveLength(2);
    expect((await f.restart().poll(retryContext(f, "retry-two"))).status).toBe("complete");
    expect(f.draft).toHaveBeenCalledTimes(3); expect(f.record().failure).toBeUndefined();
  });

  it("retains a consumed retry when its reservation acknowledgement is lost before model invocation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f);
    f.draft.mockRejectedValueOnce(new Error("First attempt failed")); await f.restart().poll(f.context);
    vi.setSystemTime("2026-01-01T01:00:01.000Z"); const retry = retryContext(f, "reserved-retry");
    const save = f.context.store.saveRuntime.bind(f.context.store);
    const fail = vi.spyOn(f.context.store, "saveRuntime").mockImplementationOnce(async (name, record) => { await save(name, record); throw new Error("Lost reservation acknowledgement"); });
    const interrupted = await f.restart().poll(retry); fail.mockRestore();
    const reservation = structuredClone(f.record().attempts[1]);
    expect(reservation).toEqual({ startedAt: new Date().toISOString(), retry: { id: retry.event.id, at: retry.event.at } });
    expect(interrupted).toMatchObject({ status: "pending", failure: { at: reservation.startedAt, retryable: true } });
    expect(f.draft).toHaveBeenCalledTimes(1);
    vi.setSystemTime("2026-01-01T01:00:02.000Z");
    await f.restart().poll(f.context); await f.restart().poll(retryContext(f, retry.event.id));
    expect(f.draft).toHaveBeenCalledTimes(1); expect(f.record().attempts).toHaveLength(2);
    expect((await f.restart().poll(retryContext(f, "recovery-retry"))).status).toBe("complete");
    expect(f.record().attempts[1]).toEqual(reservation);
    expect(f.draft.mock.calls.at(-1)![1]).toContainEqual({ startedAt: reservation.startedAt, sessionId: null, invocationId: null, errorKind: "unrecorded" });
  });

  it.each(["failed", "unfinished"])("recovers an old %s goals-v1 journal only on a fresh retry while preserving its evidence", async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f);
    const attempts: RetroPublicationRecord["attempts"] = [{ startedAt: at(8), ...(kind === "failed" ? { finishedAt: at(9), errorKind: "draft-error" } : {}) }];
    f.records.set(retroRuntimeName(f.context.goal.id), { version: 1, goalId: f.context.goal.id, github: "test/project", attempts: structuredClone(attempts) });
    const blocked = await f.restart().poll(f.context);
    expect(blocked).toMatchObject({ status: "pending", failure: { retryable: true } });
    expect(f.record().failure).toEqual(blocked.status === "pending" ? blocked.failure : undefined);
    expect(f.draft).not.toHaveBeenCalled(); expect(f.record().attempts).toEqual(attempts);
    expect((await f.restart().poll(retryContext(f, "recover-old-journal"))).status).toBe("complete");
    expect(f.draft).toHaveBeenCalledTimes(1); expect(f.record().attempts[0]).toEqual(attempts[0]);
    expect(f.record().frozen).toBeDefined(); expect(f.record().failure).toBeUndefined();
    expect(f.draft.mock.calls[0][1]).toEqual([{ startedAt: at(8), sessionId: null, invocationId: null, errorKind: kind === "failed" ? "draft-error" : "unrecorded" }]);
  });

  it("automatically reconciles frozen content through delivery, review, CI and merge after a successful retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f);
    f.draft.mockRejectedValueOnce(new Error("First attempt failed")); await f.restart().poll(f.context);
    vi.setSystemTime("2026-01-01T01:00:01.000Z"); f.losePost();
    const delivery = await f.restart().poll(retryContext(f, "retry-to-freeze"));
    expect(delivery).toMatchObject({ status: "pending" }); expect(delivery).not.toHaveProperty("failure");
    const frozen = structuredClone(f.record().frozen); expect(frozen).toBeDefined(); expect(f.record().failure).toBeUndefined();
    expect(f.archive.ensureRetroPr).not.toHaveBeenCalled();
    f.pr.reviewed = false; f.pr.checksPassed = false;
    const ordinary = { ...f.context, event: { kind: "queue-changed" as const, id: "publication-wakeup", teamId: f.context.goal.teamId, at: new Date().toISOString() } };
    expect(await f.restart().poll(ordinary)).toEqual({ status: "pending", reason: "The retrospective archive needs a fresh review on its current head." });
    expect(f.services.review).toHaveBeenCalledTimes(1); expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
    f.pr.reviewed = true;
    expect(await f.restart().poll(ordinary)).toEqual({ status: "pending", reason: "The retrospective archive is waiting for passing CI." });
    f.pr.checksPassed = true;
    expect((await f.restart().poll(ordinary)).status).toBe("complete");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1); expect(f.draft).toHaveBeenCalledTimes(2);
    expect(f.record().frozen).toEqual(frozen); expect(f.record().failure).toBeUndefined();
    expect(f.record().authorization).toBeUndefined();
  });

  it("keeps planning merge as an explicit compatibility retry without a second authorization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f);
    f.draft.mockRejectedValueOnce(new Error("First attempt failed")); await f.restart().poll(f.context);
    vi.setSystemTime("2026-01-01T01:00:01.000Z");
    await expect(f.restart().merge(f.context)).resolves.toContain("merged");
    expect(f.draft).toHaveBeenCalledTimes(2);
    expect(f.record().attempts[1].retry).toEqual({ id: expect.stringMatching(/^retro-merge-retry:/), at: new Date().toISOString() });
    expect(f.record().failure).toBeUndefined(); expect(f.record().authorization).toBeUndefined();
  });

  async function rejectedPublication(priorFailure = false) {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T01:00:00.000Z");
    const f = await fixture(); goalsV1Retro(f); f.pr.reviewed = false; f.pr.checksPassed = false;
    f.services.review.mockResolvedValueOnce({ summary: "Correct the unsupported Product count", findings: [{ path: "docs/retros/goal-one.md", line: 3, reason: "Product history is incomplete." }] });
    vi.mocked(f.archive.reviewRetroPr).mockImplementation(async (_github, _goal, _markdown, _url, head, review) => {
      const result = await review("/managed/review");
      if (result.findings.length) f.pr.rejection = { headSha: head, reviewId: 7, submittedAt: new Date().toISOString() };
      else f.pr.reviewed = true;
    });
    if (priorFailure) { f.draft.mockRejectedValueOnce(new Error("An actual earlier generation failure")); await f.restart().poll(f.context); vi.setSystemTime("2026-01-01T01:00:01.000Z"); }
    const rejected = await f.restart().poll(priorFailure ? retryContext(f, "initial-draft-retry") : f.context);
    expect(rejected).toMatchObject({ status: "pending", failure: { message: expect.stringContaining("rejected by satori-miyamoto"), retryable: true } });
    const original = structuredClone(f.record()); const oldPosts = structuredClone([...f.deliveries]);
    const corrected = structuredClone(original.frozen!.draft); corrected.snapshot.missing.push("Corrected missing Product history."); corrected.generation.sessionId = "corrected-retro-session";
    corrected.markdown = await renderSprintRetro(corrected.snapshot, corrected.narrative, corrected.generation);
    f.draft.mockResolvedValue(corrected);
    const correction = vi.fn<NonNullable<RetroArchive["correctRetroPr"]>>(async (_github, _goal, previous, next, url, rejection) => {
      expect(previous).toBe(original.frozen!.markdown); expect(next).toBe(corrected.markdown); expect(url).toBe(original.prUrl); expect(rejection.headSha).toBe(original.gate!.headSha);
      if (f.pr.headSha !== rejection.headSha && f.pr.headSha !== "e".repeat(40)) throw new Error("Concurrent head moved");
      f.pr.headSha = "e".repeat(40); f.pr.reviewed = false; delete f.pr.rejection; return f.pr.headSha;
    });
    f.archive.correctRetroPr = correction;
    vi.setSystemTime("2026-01-01T01:00:02.000Z");
    return { ...f, original, oldPosts, corrected, correction };
  }

  it("corrects a rejected frozen publication only after an explicit fresh retry, retaining successful and failed generation history", async () => {
    const f = await rejectedPublication(true);
    for (const event of [undefined, retryContext(f, "stale", { at: "2026-01-01T01:00:01.000Z" }).event, retryContext(f, "foreign", { goalId: "goal-other" }).event]) {
      const result = await f.restart().poll({ ...f.context, event });
      expect(result).toMatchObject({ status: "pending", failure: { message: expect.stringContaining("planning retry --goal goal-one") } });
    }
    expect(f.draft).toHaveBeenCalledTimes(2); expect(f.services.review).toHaveBeenCalledTimes(1);
    const retry = retryContext(f, "correct-rejected-retro");
    const correcting = f.draft.getMockImplementation()!;
    f.draft.mockImplementationOnce(async (...args) => {
      expect(f.record().attempts).toEqual([{ startedAt: new Date().toISOString(), retry: { id: retry.event.id, at: retry.event.at } }]);
      expect(f.record().revisions![0]).toMatchObject({ frozen: f.original.frozen, attempts: f.original.attempts, postIds: f.original.postIds, review: f.original.review, headSha: f.original.gate!.headSha });
      return await correcting(...args);
    });
    expect(await f.restart().poll(retry)).toEqual({ status: "pending", reason: "The retrospective archive is waiting for passing CI." });
    expect(f.draft).toHaveBeenCalledTimes(3); expect(f.correction).toHaveBeenCalledTimes(1);
    expect(f.draft.mock.calls.at(-1)![1]).toEqual([{ startedAt: f.original.attempts[0].startedAt, sessionId: null, invocationId: null, errorKind: "draft-error" }]);
    const history = structuredClone(f.record().revisions);
    expect(history![0].attempts.at(-1)!.generation!.status).toBe("succeeded");
    expect(f.record().frozen!.markdown).toBe(f.corrected.markdown); expect(f.record().failure).toBeUndefined();
    expect(f.services.review).toHaveBeenCalledTimes(2); expect(f.services.review.mock.calls[1][2].headSha).toBe("e".repeat(40));
    const notice = f.record().correction!.notice!; expect(notice.message).toContain(`/blob/${f.original.gate!.headSha}/docs/retros/goal-one.md`); expect(notice.message).toContain(f.original.frozen!.sha256);
    for (const [key, post] of f.oldPosts) expect(f.deliveries.get(key)).toEqual(post);
    await f.restart().poll(retry); expect(f.draft).toHaveBeenCalledTimes(3); expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
    f.pr.checksPassed = true;
    expect((await f.restart().poll(f.context)).status).toBe("complete");
    expect(f.record().revisions).toEqual(history); expect(f.record().prUrl).toBe(f.original.prUrl); expect(f.record().authorization).toBeUndefined();
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1); expect(f.archive.ensureRetroPr).toHaveBeenCalledWith("test/project", "goal-one", f.original.frozen!.markdown);
  });

  it.each(["reservation", "draft", "freeze-before-write", "freeze-response", "part-response", "notice-response", "push-response"])("recovers correction at the %s boundary without replaying model work", async (boundary) => {
    const f = await rejectedPublication(); const retry = retryContext(f, "correction-retry");
    const blockedBeforeFreeze = ["reservation", "draft", "freeze-before-write"].includes(boundary);
    let failed = false; const save = f.context.store.saveRuntime.bind(f.context.store);
    const saving = vi.spyOn(f.context.store, "saveRuntime").mockImplementation(async (name, value) => {
      const record = value as RetroPublicationRecord;
      const stop = !failed && record.correction && (boundary === "reservation" ? !record.frozen : ["freeze-before-write", "freeze-response"].includes(boundary) && record.frozen && !record.correction.notice);
      if (stop) { failed = true; if (boundary !== "freeze-before-write") await save(name, value); throw new Error("Lost journal boundary"); }
      await save(name, value);
    });
    if (boundary === "draft") f.draft.mockRejectedValueOnce(new Error("Correction generation failed"));
    if (boundary === "part-response") f.losePost();
    if (boundary === "notice-response") {
      const post = f.context.post;
      f.context.post = async (...args) => { const id = await post(...args); if (!failed && args[0].startsWith("retro-correction:")) { failed = true; throw new Error("Lost notice acknowledgement"); } return id; };
    }
    if (boundary === "push-response") {
      const apply = f.correction.getMockImplementation()!;
      f.correction.mockImplementationOnce(async (...args) => { await apply(...args); throw new Error("Lost correction push acknowledgement"); });
    }
    expect((await f.restart().poll(retry)).status).toBe("pending"); saving.mockRestore();
    const reserved = structuredClone(f.record().attempts); const history = structuredClone(f.record().revisions);
    const invocations = boundary === "reservation" ? 1 : 2;
    expect(f.draft).toHaveBeenCalledTimes(invocations); expect(history).toHaveLength(1);
    vi.setSystemTime("2026-01-01T01:00:03.000Z");
    await f.restart().poll(f.context); await f.restart().poll(retryContext(f, retry.event.id));
    expect(f.draft).toHaveBeenCalledTimes(invocations);
    if (blockedBeforeFreeze) {
      expect(f.record().frozen).toBeUndefined(); expect(f.record().failure?.retryable).toBe(true);
      expect(f.record().attempts).toEqual(reserved);
      await f.restart().poll(retryContext(f, "fresh-correction-recovery")); expect(f.draft).toHaveBeenCalledTimes(invocations + 1);
    }
    expect(f.record().frozen!.markdown).toBe(f.corrected.markdown); expect(f.record().revisions).toEqual(history);
    expect(f.record().correction!.resultHeadSha).toBe("e".repeat(40));
    expect([...f.deliveries.keys()].filter((key) => key.startsWith("retro-correction:"))).toHaveLength(1);
    for (const [key, post] of f.oldPosts) expect(f.deliveries.get(key)).toEqual(post);
    f.pr.checksPassed = true; expect((await f.restart().poll(f.context)).status).toBe("complete");
  });

  it("retains corrected frozen content as a visible blocker when the guarded archive update refuses a moved head", async () => {
    const f = await rejectedPublication(); f.correction.mockRejectedValue(new Error("Concurrent archive head moved"));
    const result = await f.restart().poll(retryContext(f, "correct-before-move"));
    expect(result).toMatchObject({ status: "pending", failure: { message: expect.stringContaining("guarded archive update needs reconciliation") } });
    const frozen = structuredClone(f.record().frozen); const history = structuredClone(f.record().revisions);
    await f.restart().poll(f.context); await f.restart().poll(retryContext(f, "retry-after-move"));
    expect(f.draft).toHaveBeenCalledTimes(2); expect(f.record().frozen).toEqual(frozen); expect(f.record().revisions).toEqual(history);
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
  });

  it("does not reuse a retry identity retained in an earlier publication revision", async () => {
    const f = await rejectedPublication(true); await f.restart().poll(retryContext(f, "first-correction"));
    f.correction.mockResolvedValue(f.pr.headSha);
    vi.setSystemTime("2026-01-01T01:00:03.000Z");
    f.pr.reviewed = false; f.pr.rejection = { reviewId: 8, headSha: f.pr.headSha, submittedAt: new Date().toISOString() };
    await f.restart().poll(f.context);
    vi.setSystemTime("2026-01-01T01:00:04.000Z");
    expect((await f.restart().poll(retryContext(f, "initial-draft-retry"))).status).toBe("pending");
    expect(f.draft).toHaveBeenCalledTimes(3); expect(f.record().revisions).toHaveLength(1);
  });

  it("blocks closure if the corrected head moves after the guarded update returns", async () => {
    const f = await rejectedPublication();
    vi.mocked(f.archive.inspectRetroPr).mockImplementation(async () => {
      if (f.correction.mock.calls.length) { f.pr.headSha = "f".repeat(40); f.pr.reviewed = true; f.pr.checksPassed = true; }
      return structuredClone(f.pr);
    });
    const result = await f.restart().poll(retryContext(f, "correction-race"));
    expect(result).toMatchObject({ status: "pending", failure: { message: expect.stringContaining("changed after its guarded update") } });
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled(); expect(f.record().verifiedAt).toBeUndefined();
  });

  it("records failed draft attempts and never publishes unsupported model content", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-01-01T01:00:00.000Z");
    const poll = async (f: Awaited<ReturnType<typeof fixture>>, offsetMs: number) => { vi.setSystemTime(start + offsetMs); return await f.restart().poll(f.context); };
    const f = await fixture(); f.draft.mockRejectedValueOnce(new Error("Generation unavailable"));
    await poll(f, 0); expect(f.record().attempts).toHaveLength(1);
    expect(f.record().attempts[0]).toMatchObject({ errorKind: "draft-error" });
    expect(f.deliveries.size).toBe(0);
    const valid = await f.draft(); f.draft.mockResolvedValueOnce({ ...valid, markdown: "Unsupported assertion" });
    await poll(f, 15_000); expect(f.record().frozen).toBeUndefined();
    expect(f.record().attempts[1]).toMatchObject({ errorKind: "unverified-content" });
    expect(f.deliveries.size).toBe(0);
    await poll(f, 45_000); expect(f.record().attempts).toHaveLength(3);
    expect(f.record().frozen).toBeDefined();
  });

  it("backs off exponentially between failed drafts instead of retrying every poll", async () => {
    expect([1, 2, 3, 4, 5, 6, 30].map(retroRetryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-01-01T01:00:00.000Z");
    const f = await fixture();
    const poll = async (offsetMs: number) => { vi.setSystemTime(start + offsetMs); return await f.restart().poll(f.context); };
    f.draft.mockRejectedValue(new RetroGenerationError("failed", undefined, "runtime-failed"));
    await poll(0); expect(f.draft).toHaveBeenCalledTimes(1);
    let last = 0;
    for (const [index, delay] of [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
      expect(await poll(last + delay - 1)).toMatchObject({ status: "pending", reason: expect.stringContaining(`${index + 1} time(s)`) });
      expect(f.draft).toHaveBeenCalledTimes(index + 1);
      await poll(last + delay); expect(f.draft).toHaveBeenCalledTimes(index + 2);
      last += delay;
    }
    expect(f.record().attempts.every((attempt) => attempt.errorKind === "runtime-failed" && attempt.finishedAt)).toBe(true);
    // An attempt aborted before it could record its end backs off from its start.
    f.record().attempts.push({ startedAt: new Date(start + last + 1_000).toISOString() });
    expect((await poll(last + 1_000 + 299_999)).status).toBe("pending"); expect(f.draft).toHaveBeenCalledTimes(8);
    await poll(last + 1_000 + 300_000); expect(f.draft).toHaveBeenCalledTimes(9);
  });

  it("gives the next draft every earlier failed or aborted attempt with its error kind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-01-01T01:00:00.000Z");
    const f = await fixture();
    const generation = { sessionId: "failed-retro", invocationId: "failed-invocation", startedAt: at(8), finishedAt: at(9), status: "timed-out" as const, wallTimeMs: 1000, usage: (await f.draft()).generation.usage };
    f.draft.mockClear();
    f.draft.mockRejectedValueOnce(new RetroGenerationError("failed", generation, "timed-out")).mockRejectedValueOnce(new Error("state unavailable"));
    for (const offset of [0, 15_000, 45_000]) { vi.setSystemTime(start + offset); await f.restart().poll(f.context); }
    expect(f.draft.mock.calls.map((call) => call[1])).toEqual([[], [
      { startedAt: new Date(start).toISOString(), sessionId: "failed-retro", invocationId: "failed-invocation", errorKind: "timed-out" },
    ], [
      { startedAt: new Date(start).toISOString(), sessionId: "failed-retro", invocationId: "failed-invocation", errorKind: "timed-out" },
      { startedAt: new Date(start + 15_000).toISOString(), sessionId: null, invocationId: null, errorKind: "draft-error" },
    ]]);
    expect(f.record().frozen).toBeDefined();
  });

  it("recovers after PR creation or runtime acknowledgement fails without redrafting", async () => {
    const f = await fixture(); vi.mocked(f.archive.ensureRetroPr).mockRejectedValueOnce(new Error("Response lost"));
    await f.restart().poll(f.context);
    expect(f.record().postIds).toHaveLength(1);
    const save = vi.spyOn(f.context.store, "saveRuntime"); save.mockRejectedValueOnce(new Error("Disk unavailable"));
    await f.restart().poll(f.context); save.mockRestore();
    await f.restart().poll(f.context);
    expect(f.record().prUrl).toBe(f.pr.url);
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(f.deliveries.size).toBe(2);
  });

  it("archives with bot review and CI without manufacturing a second human approval", async () => {
    const f = await fixture();
    expect((await f.restart().poll(f.context)).status).toBe("complete");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    expect(f.record().authorization).toBeUndefined();
    expect([...f.deliveries.values()].some((post) => post.message.includes("React ✅"))).toBe(false);
  });

  it("announces a changed head and waits for its fresh review", async () => {
    const f = await fixture(); f.pr.checksPassed = false;
    await f.restart().poll(f.context);
    const originalPost = f.record().gate!.postId;
    f.pr.headSha = "e".repeat(40); f.pr.reviewed = false; f.pr.checksPassed = true;
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.record().gate!.postId).not.toBe(originalPost);
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
    f.pr.reviewed = true;
    expect((await f.restart().poll(f.context)).status).toBe("complete");
  });

  it("recovers a lost merge response from verified GitHub state without human authorization", async () => {
    const f = await fixture();
    vi.mocked(f.archive.mergeRetroPr).mockImplementationOnce(async () => {
      expect(f.record().authorization).toBeUndefined();
      f.pr.state = "MERGED"; f.pr.mergedSha = "d".repeat(40); throw new Error("Response lost");
    });
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    const result = await f.restart().poll(f.context);
    expect(result).toMatchObject({ status: "complete", evidence: { path: "docs/retros/goal-one.md", postId: f.record().postIds![0], prUrl: f.pr.url } });
    expect(await f.restart().poll(f.context)).toEqual(result);
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
  });

  const filler = "Bringing the parts together.";
  /** Like the real Chick chat, every post (content and merge gate) carries the persona prefix. */
  async function attributed() {
    const f = await fixture(); const format = async (_context: CeremonyContext, text: string) => `${filler}\n\n${text}`;
    const post = f.context.post;
    f.context.post = (key, message, kind) => post(key, `${filler}\n\n${message}`, kind);
    const draft = await f.draft();
    draft.snapshot.missing = Array.from({ length: 18 }, (_, index) => `${index}: ${"Historical evidence unavailable. ".repeat(35)}`);
    draft.markdown = await renderSprintRetro(draft.snapshot, draft.narrative, draft.generation);
    f.draft.mockResolvedValue(draft);
    return { ...f, format, publication: () => new RetroPublication(f.archive, f.draft, { ...f.services, formatPost: format }) };
  }

  it("keeps persona filler out of the archive while thread posts and archive both match the frozen parts", async () => {
    const f = await attributed(); await f.publication().poll(f.context);
    const frozen = f.record().frozen!;
    expect(frozen.parts.length).toBeGreaterThan(1);
    expect(frozen.markdown).toBe(frozen.parts.join("")); expect(frozen.markdown).toBe(frozen.draft.markdown);
    expect(frozen.markdown).not.toContain(filler);
    const posted = [...f.deliveries.values()].filter((item) => !item.mergePost).map((item) => item.message);
    expect(posted).toEqual(frozen.parts.map((part) => `${filler}\n\n${part}`));
    expect(f.archive.ensureRetroPr).toHaveBeenCalledWith("test/project", "goal-one", frozen.markdown);
    expect(f.state.planningGoals[0]).toEqual(goalAtRetro());
    expect(frozen.markdown).toContain("Proposals require the owner's decision");
    // Thread verification still binds every post to its frozen part.
    const content = [...f.deliveries.values()].find((item) => !item.mergePost)!; const original = content.message;
    content.message = frozen.parts[0];
    await expect(f.publication().merge(f.context, f.owner())).rejects.toThrow("verification is pending");
    content.message = original;
    await expect(f.publication().merge(f.context, f.owner())).resolves.toContain("merged");
  });

  it("still verifies a version 1 record frozen with the attribution inside its archive", async () => {
    const f = await attributed(); await f.publication().poll(f.context);
    const frozen = f.record().frozen!;
    const content = [...f.deliveries.values()].find((item) => !item.mergePost)!;
    const original = { part: frozen.parts[0], draft: frozen.draft.markdown, post: content.message };
    // Rewrite the record as version 1 would have frozen it, with `extra` in its first fragment everywhere it appears.
    const legacyWith = (extra: string, version: number) => {
      frozen.parts[0] = original.part + extra; frozen.draft.markdown = original.draft.replace(original.part, frozen.parts[0]);
      content.message = original.post + extra;
      const legacy = frozen.parts.map((part) => `${filler}\n\n${part}`).join("");
      Object.assign(frozen, { markdown: legacy, sha256: createHash("sha256").update(legacy).digest("hex") });
      (frozen.draft.snapshot as { version: number }).version = version;
    };
    legacyWith("", 2);
    await expect(f.publication().merge(f.context, f.owner())).rejects.toThrow();
    legacyWith("\npassword=private-value\n", 1);
    await expect(f.publication().merge(f.context, f.owner())).rejects.toThrow();
    legacyWith("", 1);
    await expect(f.publication().merge(f.context, f.owner())).resolves.toContain("merged");
  });

  it("recovers every part of a long retrospective before offering its archive", async () => {
    const f = await fixture(); const draft = await f.draft();
    draft.snapshot.missing = Array.from({ length: 18 }, (_, index) => `${index}: ${"Historical evidence unavailable. ".repeat(35)}`);
    draft.markdown = await renderSprintRetro(draft.snapshot, draft.narrative, draft.generation);
    f.draft.mockResolvedValue(draft);
    const post = f.context.post;
    let failed = false;
    f.context.post = async (...args) => { const id = await post(...args); if (args[0].endsWith(":1") && !failed) { failed = true; throw new Error("Lost second part response"); } return id; };
    await f.restart().poll(f.context); expect(f.archive.ensureRetroPr).not.toHaveBeenCalled();
    await f.restart().poll(f.context);
    const posted = [...f.deliveries.values()].filter((item) => !item.mergePost).map((item) => item.message);
    expect(posted.length).toBeGreaterThan(2);
    expect(posted.every((message) => message.length <= 10_001)).toBe(true);
    expect(posted.join("")).toBe(f.record().frozen!.markdown);
    expect(f.record().postIds).toHaveLength(posted.length);
  });

  it("rejects edited post fragments even when the archived document hash is unchanged", async () => {
    const f = await fixture(); await f.restart().poll(f.context);
    f.record().frozen!.parts[0] += "Unexpected edit";
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.ensureRetroPr).toHaveBeenCalledTimes(1);
    expect(f.deliveries.size).toBe(2);
  });

  it("does not redirect a frozen publication when team configuration or runtime content changes", async () => {
    const f = await fixture(); await f.restart().poll(f.context);
    f.state.teams[0].project.github = "other/project";
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    f.state.teams[0].project.github = "test/project";
    f.record().frozen!.markdown += "Changed";
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.ensureRetroPr).toHaveBeenCalledTimes(1);
  });
});
