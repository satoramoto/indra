import { describe, expect, it, vi } from "vitest";
import type { CeremonyContext } from "../src/planning-bridge.js";
import { advanceCeremony, startCeremony, type HumanApproval } from "../src/ceremony.js";
import type { PlanningGoal, PlanningStore } from "../src/planning.js";
import { RetroPublication, retroRuntimeName, type RetroPublicationRecord } from "../src/retro-publication.js";
import { buildRetroSnapshot, renderSprintRetro, type SprintRetroDraft } from "../src/sprint-retro.js";
import type { RetroArchive, RetroPr } from "../src/sprint.js";

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
  const state = { planningGoals: [goal], teams: [{ id: goal.teamId, project: { github: "test/project" }, externalIdentities: { mattermost: { homeChannelId: "home" } } }] };
  const records = new Map<string, object>();
  const deliveries = new Map<string, { id: string; message: string; mergePost?: string }>();
  let lostPost = false;
  const context: CeremonyContext = { goal, runtime: { message: vi.fn() }, store: {
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
  const draft = vi.fn(async (): Promise<SprintRetroDraft> => {
    const snapshot = buildRetroSnapshot({ goal, cutoffAt: at(7), facts: { seats: [], sessions: [], reviews: [], rounds: [], failures: [] } });
    const generation = { sessionId: "retro-session", startedAt: at(8), finishedAt: at(9), status: "succeeded" as const, wallTimeMs: 1000,
      usage: { inputTokens: 12, uncachedInputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: 7, reasoningOutputTokens: null } };
    const narrative = snapshot.choices;
    return { snapshot, generation, narrative, markdown: await renderSprintRetro(snapshot, narrative, generation) };
  });
  const pr: RetroPr = { url: "https://github.com/test/project/pull/3", headSha: "c".repeat(40), state: "OPEN", reviewed: true, checksPassed: true };
  const archive: RetroArchive = {
    ensureRetroPr: vi.fn(async () => pr.url), inspectRetroPr: vi.fn(async () => structuredClone(pr)),
    mergeRetroPr: vi.fn(async () => { pr.state = "MERGED"; pr.mergedSha = "d".repeat(40); return { merged: true as const, sha: pr.mergedSha }; }),
  };
  const restart = () => new RetroPublication(archive, draft);
  const record = () => records.get(retroRuntimeName(goal.id)) as RetroPublicationRecord;
  const owner = (): HumanApproval => ({ source: "owner-command", command: "planning merge", at: new Date().toISOString() });
  return { context, state, draft, archive, pr, records, deliveries, restart, record, owner, losePost: () => { lostPost = true; } };
}

describe("recoverable retro publication", () => {
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
    const f = await fixture(); f.draft.mockRejectedValueOnce(new Error("Generation unavailable"));
    await f.restart().poll(f.context); expect(f.record().attempts).toHaveLength(1);
    expect(f.deliveries.size).toBe(0);
    const valid = await f.draft(); f.draft.mockResolvedValueOnce({ ...valid, markdown: "Unsupported assertion" });
    await f.restart().poll(f.context); expect(f.record().frozen).toBeUndefined();
    expect(f.deliveries.size).toBe(0);
    await f.restart().poll(f.context); expect(f.record().attempts).toHaveLength(3);
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

  it("freezes Chick's attribution along with the document and leaves proposals inert", async () => {
    const f = await fixture(); const format = async (_context: CeremonyContext, text: string) => `Chick\n\n${text}`;
    await new RetroPublication(f.archive, f.draft, format).poll(f.context);
    expect(f.record().frozen!.markdown).toBe(`Chick\n\n${f.record().frozen!.draft.markdown}`);
    expect(f.context.store.readRuntimeFile).toBeDefined();
    expect(f.state.planningGoals[0]).toEqual(goalAtRetro());
    expect(f.record().frozen!.markdown).toContain("Proposals require the owner's decision");
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
