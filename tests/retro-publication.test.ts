import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CeremonyContext } from "../src/planning-bridge.js";
import { advanceCeremony, startCeremony, type HumanApproval } from "../src/ceremony.js";
import type { PlanningDocument, PlanningGoal, PlanningStore } from "../src/planning.js";
import type { StandingPolicy } from "../src/state-domain.js";
import { createCeremonyAdapters, RetroPublication, retroRetryDelayMs, retroRuntimeName, type RetroPublicationRecord } from "../src/retro-publication.js";
import { buildRetroSnapshot, renderSprintRetro, RetroGenerationError, type RetroPriorAttempt, type SprintRetroDraft } from "../src/sprint-retro.js";
import { SprintGitHub, type RetroArchive, type RetroPr } from "../src/sprint.js";
import { SeatRuntime } from "../src/seat-runtime.js";
import * as mattermost from "../src/planning-mattermost.js";

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
  const state = { planningGoals: [goal], teams: [{ id: goal.teamId, standingPolicy: undefined as StandingPolicy | undefined, project: { github: "test/project" }, seats: [{ id: goal.seatId }], externalIdentities: { mattermost: { homeChannelId: "home" } } }] };
  const records = new Map<string, object>();
  const deliveries = new Map<string, { id: string; message: string; mergePost?: string }>();
  let lostPost = false;
  const context: CeremonyContext = { goal, runtime: { message: vi.fn() }, store: {
    checkout: "/nonexistent-retro-test-state", runtimeDir: "/nonexistent-retro-test-state.runtime",
    read: async () => structuredClone(state), readRuntimeFile: async (name: string) => structuredClone(records.get(name)),
    update: async (change: (state: PlanningDocument) => void) => { change(state as unknown as PlanningDocument); },
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
    review: vi.fn(async () => ({ summary: "Reviewed archive", findings: [] })),
  };
  const restart = () => new RetroPublication(archive, draft, services);
  const record = () => records.get(retroRuntimeName(goal.id)) as RetroPublicationRecord;
  const owner = (): HumanApproval => ({ source: "owner-command", command: "planning merge", at: new Date().toISOString() });
  return { context, state, draft, archive, pr, records, deliveries, services, restart, record, owner, losePost: () => { lostPost = true; } };
}

describe("recoverable retro publication", () => {
  it("requests automatic archival approval only for a reviewed green head and preserves its durable provenance", async () => {
    const f = await fixture();
    f.state.teams[0].standingPolicy = { revisions: [{ revision: 1, source: "owner-command", enabled: true, at: at(0) }] };
    const request = vi.fn<NonNullable<CeremonyContext["automaticGate"]>>(async (gate) => {
      if (gate.kind !== "retro") throw new Error("Wrong gate");
      return { source: "automatic", policyRevision: 1, at: new Date().toISOString(), target: { kind: "retro", goalId: f.context.goal.id, prUrl: gate.pr.url, headSha: gate.pr.headSha, checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto", reviewedHeadSha: gate.pr.headSha } };
    });
    f.context.automaticGate = request;
    f.pr.checksPassed = false;
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(request).not.toHaveBeenCalled();
    f.pr.checksPassed = true;
    const progress = await f.restart().poll(f.context);
    expect(progress).toMatchObject({ status: "complete", evidence: { authorization: { headSha: f.pr.headSha, approval: { source: "automatic", policyRevision: 1 } } } });
    expect(f.state.planningGoals[0].automaticApprovals).toHaveLength(1);
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
  });

  it("does not resume a policy-authorized archive after the owner switches the policy off", async () => {
    const f = await fixture();
    f.state.teams[0].standingPolicy = { revisions: [{ revision: 1, source: "owner-command", enabled: true, at: at(0) }] };
    f.context.automaticGate = async () => undefined;
    await f.restart().poll(f.context);
    vi.mocked(f.archive.mergeRetroPr).mockRejectedValueOnce(new Error("Interrupted"));
    await expect(f.restart().merge(f.context, { source: "automatic", policyRevision: 1, at: new Date().toISOString(), target: { kind: "retro", goalId: f.context.goal.id, prUrl: f.pr.url, headSha: f.pr.headSha, checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto", reviewedHeadSha: f.pr.headSha } })).rejects.toThrow("Interrupted");
    f.context.goal = structuredClone(f.state.planningGoals[0]);
    f.state.teams[0].standingPolicy.revisions.push({ revision: 2, source: "owner-command", enabled: false, at: new Date().toISOString() });
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    expect(f.pr.state).toBe("OPEN");
    await f.restart().merge(f.context, f.owner());
    expect(await f.restart().poll(f.context)).toMatchObject({ status: "complete", evidence: { authorization: { approval: { source: "owner-command" } } } });
  });

  it.each([false, true])("requests new archival authorization after auto mode is toggled, polling while disabled: %s", async (pollWhileDisabled) => {
    const f = await fixture();
    const policy: StandingPolicy = { revisions: [{ revision: 1, source: "owner-command", enabled: true, at: at(0) }] };
    f.state.teams[0].standingPolicy = policy;
    const request = vi.fn<NonNullable<CeremonyContext["automaticGate"]>>(async (gate) => {
      const current = policy.revisions.at(-1)!;
      if (!current.enabled) return;
      if (gate.kind !== "retro") throw new Error("Wrong gate");
      return { source: "automatic", policyRevision: current.revision, at: new Date().toISOString(), target: { kind: "retro", goalId: f.context.goal.id, prUrl: gate.pr.url, headSha: gate.pr.headSha, checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto", reviewedHeadSha: gate.pr.headSha } };
    });
    f.context.automaticGate = request;
    vi.mocked(f.archive.mergeRetroPr).mockRejectedValueOnce(new Error("Interrupted"));
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.record().authorization?.approval).toMatchObject({ source: "automatic", policyRevision: 1 });
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    f.context.goal = structuredClone(f.state.planningGoals[0]);
    policy.revisions.push({ revision: 2, source: "owner-command", enabled: false, at: new Date().toISOString() });
    if (pollWhileDisabled) {
      expect((await f.restart().poll(f.context)).status).toBe("pending");
      expect(f.record().authorization).toBeUndefined();
      expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
      expect(f.pr.state).toBe("OPEN");
    }
    request.mockClear();
    policy.revisions.push({ revision: 3, source: "owner-command", enabled: true, at: new Date().toISOString() });
    expect(await f.restart().poll(f.context)).toMatchObject({ status: "complete", evidence: { authorization: { headSha: f.pr.headSha, approval: { source: "automatic", policyRevision: 3 } } } });
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: "retro", pr: expect.objectContaining({ headSha: f.pr.headSha, state: "OPEN", reviewed: true, checksPassed: true }), postId: f.record().gate!.postId });
    expect(f.state.planningGoals[0].automaticApprovals?.map((approval) => approval.policyRevision)).toEqual([1, 3]);
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(2);
  });

  it("reconciles an automatic archive merge accepted before revocation when its response was lost", async () => {
    const f = await fixture();
    const policy: StandingPolicy = { revisions: [{ revision: 1, source: "owner-command", enabled: true, at: at(0) }] };
    f.state.teams[0].standingPolicy = policy;
    f.context.automaticGate = async () => undefined;
    await f.restart().poll(f.context);
    vi.mocked(f.archive.mergeRetroPr).mockImplementationOnce(async () => {
      f.pr.state = "MERGED"; f.pr.mergedSha = "d".repeat(40);
      throw new Error("Response lost");
    });
    await expect(f.restart().merge(f.context, { source: "automatic", policyRevision: 1, at: new Date().toISOString(), target: { kind: "retro", goalId: f.context.goal.id, prUrl: f.pr.url, headSha: f.pr.headSha, checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto", reviewedHeadSha: f.pr.headSha } })).rejects.toThrow("Response lost");
    f.context.goal = structuredClone(f.state.planningGoals[0]);
    policy.revisions.push({ revision: 2, source: "owner-command", enabled: false, at: new Date().toISOString() });
    delete f.context.automaticGate;
    expect(await f.restart().poll(f.context)).toMatchObject({ status: "complete", evidence: { authorization: { approval: { source: "automatic", policyRevision: 1 } } } });
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    expect(f.state.planningGoals[0].automaticApprovals).toHaveLength(1);
  });

  it("wires production review to a new read-only runtime at the archive head without resuming Chick", async () => {
    const f = await fixture(); await f.restart().poll(f.context); f.pr.reviewed = false;
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

  it("resumes an authorized merge that stopped before GitHub received it", async () => {
    const f = await fixture(); await f.restart().poll(f.context);
    vi.mocked(f.archive.mergeRetroPr).mockRejectedValueOnce(new Error("Interrupted before merge"));
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow("Interrupted");
    const approval = structuredClone(f.record().authorization);
    f.pr.checksPassed = false;
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    f.pr.checksPassed = true;
    expect((await f.restart().poll(f.context)).status).toBe("complete");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(2);
    expect(f.record().authorization).toEqual(approval);
  });

  it.each(["head", "pr", "post", "closed", "review", "ci"])("does not resume saved authorization when %s no longer matches its gates", async (change) => {
    const f = await fixture(); await f.restart().poll(f.context);
    vi.mocked(f.archive.mergeRetroPr).mockRejectedValueOnce(new Error("Interrupted"));
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow("Interrupted");
    if (change === "head") f.pr.headSha = "f".repeat(40);
    if (change === "pr") f.pr.url = "https://github.com/test/project/pull/4";
    if (change === "post") f.record().authorization!.postId = "another-post";
    if (change === "closed") f.pr.state = "CLOSED";
    if (change === "review") f.pr.reviewed = false;
    if (change === "ci") f.pr.checksPassed = false;
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
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

  it.each(["review", "CI", "closed", "unapproved-merge"])("keeps the goal in retro for %s", async (problem) => {
    const f = await fixture(); await f.restart().poll(f.context);
    if (problem === "review") f.pr.reviewed = false;
    if (problem === "CI") f.pr.checksPassed = false;
    if (problem === "closed") f.pr.state = "CLOSED";
    if (problem === "unapproved-merge") { f.pr.state = "MERGED"; f.pr.mergedSha = "d".repeat(40); }
    expect((await f.restart().poll(f.context)).status).toBe("pending");
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow();
    expect(f.record().authorization).toBeUndefined();
    expect(f.context.goal.ceremony!.closure).toBeUndefined();
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
  });

  it.each(["plan", "release", "old-time", "bot"])("refuses %s approval for the separate archival merge", async (kind) => {
    const f = await fixture(); await f.restart().poll(f.context);
    const mark = { source: "reaction", userId: "owner", verifiedHuman: true, emoji: "white_check_mark", postId: f.record().gate!.postId, at: new Date().toISOString() };
    if (kind === "plan") mark.postId = "proposal-post";
    if (kind === "release") mark.postId = "release-post";
    if (kind === "old-time") mark.at = at(4);
    if (kind === "bot") mark.verifiedHuman = false;
    await expect(f.restart().merge(f.context, mark as HumanApproval)).rejects.toThrow("new human");
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
  });

  it("requires a new announcement and authorization when the PR head changes", async () => {
    const f = await fixture(); await f.restart().poll(f.context);
    const originalPost = f.record().gate!.postId; f.pr.headSha = "e".repeat(40);
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow("changed");
    await f.restart().poll(f.context); expect(f.record().gate!.postId).not.toBe(originalPost);
    await expect(f.restart().merge(f.context, { source: "reaction", userId: "human", postId: originalPost, emoji: "white_check_mark", verifiedHuman: true, at: new Date().toISOString() })).rejects.toThrow("new human");
    await f.restart().merge(f.context, f.owner());
    expect((await f.restart().poll(f.context)).status).toBe("complete");
  });

  it("does not revive interrupted authorization when a changed head returns to the original commit", async () => {
    const f = await fixture(); await f.restart().poll(f.context);
    const original = f.pr.headSha;
    vi.mocked(f.archive.mergeRetroPr).mockRejectedValueOnce(new Error("Interrupted"));
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow("Interrupted");
    f.pr.headSha = "e".repeat(40);
    await f.restart().poll(f.context);
    expect(f.record().authorization).toBeUndefined();
    f.pr.headSha = original;
    await f.restart().poll(f.context);
    expect(f.archive.mergeRetroPr).toHaveBeenCalledTimes(1);
    expect(f.pr.state).toBe("OPEN");
  });

  it("persists human authorization before merge and recovers a lost merge response", async () => {
    const f = await fixture(); await f.restart().poll(f.context);
    vi.mocked(f.archive.mergeRetroPr).mockImplementationOnce(async () => {
      expect(f.record().authorization?.headSha).toBe(f.pr.headSha);
      f.pr.state = "MERGED"; f.pr.mergedSha = "d".repeat(40); throw new Error("Response lost");
    });
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow("Response lost");
    const result = await f.restart().poll(f.context);
    expect(result).toMatchObject({ status: "complete", evidence: { path: "docs/retros/goal-one.md", postId: f.record().postIds![0], prUrl: f.pr.url, factsOnly: true, suggestions: "owner-proposals-only" } });
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
    await expect(f.publication().merge(f.context, f.owner())).rejects.toThrow("unverified");
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
    const thread = f.services.thread.getMockImplementation()!;
    f.services.thread.mockImplementation(async () => {
      const evidence = await thread();
      return { ...evidence, posts: evidence.posts.filter((post) => post.id !== f.record().postIds![1]) };
    });
    await expect(f.restart().merge(f.context, f.owner())).rejects.toThrow("unverified");
    expect(f.archive.mergeRetroPr).not.toHaveBeenCalled();
    expect((await f.restart().poll(f.context)).status).toBe("pending");
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
