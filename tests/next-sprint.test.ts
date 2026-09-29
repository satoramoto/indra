import { createHash } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceCeremony, closeCeremony, startCeremony } from "../src/ceremony.js";
import type { CeremonyWriteReadiness } from "../src/ceremony-ports.js";
import type { AgentRuntime } from "../src/codex-runtime.js";
import { createCeremonyAdapters, latestFrozenRetro, NextSprint, nextSprintRuntimeName, selectNextCandidate, type NextSprintRecord } from "../src/next-sprint.js";
import { PlanningBridge, type CeremonyContext, type PlanningChat, type Post } from "../src/planning-bridge.js";
import { PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import type { BacklogTicket, SprintCandidate, TeamRecord } from "../src/state-domain.js";
import { stateCheckout } from "./state-checkout.js";

vi.setConfig({ testTimeout: 30_000 });
const ready: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
const at = (second: number, day = "01") => `2026-09-${day}T00:00:${String(second).padStart(2, "0")}Z`;
const sha = "a".repeat(40);
const authors = { createdAt: at(0), updatedAt: at(0), createdBySeatId: "seat-lead", updatedBySeatId: "seat-lead" };
const ticket = (id: string, patch: Partial<BacklogTicket> = {}): BacklogTicket => ({ id, title: `Title ${id}`, description: `Acceptance for ${id}`, value: `Value for ${id}`, status: "open", ...authors, ...patch });
const candidate = (id: string, rank: number, ticketIds: string[], patch: Partial<SprintCandidate> = {}): SprintCandidate => ({ id, title: `Title ${id}`, summary: `Plan ${id}`, value: `Sprint value ${id}`, rank, ticketIds, status: "candidate", ...authors, ...patch });
const teamOf = (state: PlanningDocument) => state.teams[0] as TeamRecord;
function team(): TeamRecord {
  return { id: "team-one", slug: "yahaha", displayName: "Yahaha", mission: "Help the owner steer by value", project: { github: "test/project" },
    externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } }, seats: [
      { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "dev", username: "developer" } } },
    ], backlog: [ticket("ticket-one"), ticket("ticket-two")],
    sprintCandidates: [candidate("candidate-two", 2, ["ticket-two"]), candidate("candidate-one", 1, ["ticket-one"])] };
}

function closedGoal(id = "goal-previous", day = "01"): PlanningGoal {
  const time = (second: number) => at(second, day);
  const goal: PlanningGoal = { id, teamId: "team-one", seatId: "seat-lead", participantSeatIds: [], goal: "Previous sprint", projectRefs: ["test/project"],
    stage: "clarifying", createdAt: time(0), updatedAt: time(8), mattermost: { channelId: "home", rootPostId: `root-${id}` }, brief: { summary: "Previous", decisions: [], openQuestions: [] }, ceremony: startCeremony(time(0)) };
  goal.ceremony = advanceCeremony(goal, { to: "proposal", at: time(1) });
  goal.proposal = { id: `proposal-${id}`, createdAt: time(1), summary: "Previous proposal", outcomes: [{ id: "outcome-one", title: "One", description: "Accept one", seatId: "seat-dev" }], risks: [], openQuestions: [] };
  goal.stage = "approved";
  goal.assignments = [{ outcomeId: "outcome-one", seatId: "seat-dev", status: "queued", updatedAt: time(2) }];
  goal.integration = { branch: `sprint/${id}`, baseSha: sha, status: "collecting" };
  goal.ceremony = advanceCeremony(goal, { to: "implement", at: time(2), evidence: { kind: "approval", proposalId: goal.proposal.id, proposalPostId: "old-proposal", approval: { source: "owner-command", command: "planning approve", at: time(2) } } });
  Object.assign(goal.assignments[0], { status: "merged", prUrl: "https://github.com/test/project/pull/1" });
  goal.ceremony = advanceCeremony(goal, { to: "release", at: time(3), evidence: { kind: "implementation", outcomes: [{ outcomeId: "outcome-one", seatId: "seat-dev", prUrl: "https://github.com/test/project/pull/1", baseBranch: `sprint/${id}`, mergedSha: sha, checksPassed: true, reviewApproved: true }] } });
  Object.assign(goal.integration, { status: "merged", prUrl: "https://github.com/test/project/pull/2", mergedSha: sha });
  goal.ceremony = advanceCeremony(goal, { to: "retro", at: time(6), evidence: { kind: "release-running", prUrl: goal.integration.prUrl!, mergedSha: sha, mergePostId: "old-merge", approval: { source: "owner-command", command: "planning merge", at: time(4) }, checksPassed: true, buildSha: sha, runningSha: sha, runningAt: time(5) } });
  goal.ceremony = closeCeremony(goal, time(8), { kind: "retro-published", path: `docs/retros/${id}.md`, prUrl: "https://github.com/test/project/pull/3", baseBranch: "main", mergedSha: sha, postId: `retro-${id}`, publishedAt: time(7), factsOnly: true, suggestions: "owner-proposals-only" });
  return goal;
}

class Chat implements PlanningChat {
  posts: Post[] = [];
  afterPost?: (post: Post) => Promise<void>;
  async ownUserId() { return "chick"; }
  async isBot() { return false; }
  async reactions() { return []; }
  async since(channel: string, at: number) { return this.posts.filter((post) => post.channel_id === channel && post.create_at >= at); }
  async post(channel: string, message: string, root = "", delivery?: string) {
    if (Array.from(message).length > 16_383) throw new Error("Mattermost post exceeds the message limit");
    const post: Post = { id: `post-${this.posts.length + 1}`, channel_id: channel, root_id: root, user_id: "chick", message, create_at: Date.now(), props: { indra_delivery_id: delivery } };
    this.posts.push(post); await this.afterPost?.(post); return post;
  }
}
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(goals = [closedGoal()], value = team()) {
  const checkout = await stateCheckout("indra-next-sprint-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: goals, teams: [value] });
  dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile(resolve("schema/v1/state.schema.json"), join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, ready); const chat = new Chat();
  for (const goal of goals) await store.saveRuntime(goal.id, { lastSeenAt: Date.now(), processedPostIds: [], runs: [], ...(goal.proposal ? { proposalPostIds: ["old-proposal"] } : {}) });
  const message = vi.fn<AgentRuntime["message"]>(async (_prompt, schema) => {
    if (!schema.endsWith("proposal.json")) throw new Error("Next sprint should request a draft directly");
    return { sessionId: "session-next", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), response: {
      summary: "A useful sprint", outcomes: [{ title: "Implement ticket", description: "Files: src/example.ts, tests/example.test.ts. Verify acceptance.", seatId: "seat-dev" }], risks: [], openQuestions: [],
    } };
  });
  const runtime: AgentRuntime = { message };
  const shell = { run: vi.fn(async () => { throw new Error("A draft must not start implementation or merge"); }) };
  const adapters = createCeremonyAdapters({ store, chat, runtime, appDir: checkout, start: async () => { throw new Error("Use the atomic candidate reservation"); } });
  const bridge = () => new PlanningBridge(store, chat, runtime, 20, shell, adapters);
  const context = (goal = goals[0]): CeremonyContext => ({ store, goal, runtime, recordRun: async () => {}, recordSession: async () => {},
    post: async (key, content) => {
      const old = chat.posts.find((post) => post.props?.indra_delivery_id === key && post.root_id === goal.mattermost.rootPostId);
      return old?.id ?? (await chat.post(goal.mattermost.channelId, content, goal.mattermost.rootPostId, key)).id;
    } });
  const key = (goal = goals[0]) => `closed-sprint:${goal.id}:${goal.ceremony?.closure?.closedAt}`;
  const handle = (goal = goals[0]) => new NextSprint(store, chat).closedSprint(context(goal), key(goal));
  const nextGoals = async () => (await store.read()).planningGoals!.filter((goal) => goal.source);
  return { store, chat, message, shell, bridge, context, key, handle, nextGoals };
}
async function freeze(store: PlanningStore, goal: PlanningGoal) {
  const evidence = goal.ceremony!.closure!.evidence;
  if (evidence.kind !== "retro-published") throw new Error("Fixture needs a published retrospective");
  const text = "Balance outcome sizes and give each shared file one owner.";
  const markdown = `# Frozen retrospective\n${text}\n[release-rounds]`;
  await store.saveRuntime(`retro-publication-${goal.id}`, { version: 1, goalId: goal.id, github: "test/project", prUrl: evidence.prUrl,
    postIds: [`retro-${goal.id}`], verifiedAt: evidence.publishedAt,
    frozen: { markdown, sha256: createHash("sha256").update(markdown).digest("hex"), draft: { narrative: { ownerProposals: [{ text, evidenceId: "release-rounds" }, { text: "Invented recommendation", evidenceId: "unknown" }] } } } });
}
const proposals = (chat: Chat) => chat.posts.filter((post) => post.message.startsWith("**Draft proposal"));
const roots = (chat: Chat) => chat.posts.filter((post) => !post.root_id);

describe("candidate selection", () => {
  it("selects the highest ranked eligible candidate and skips blocked higher ranks", () => {
    const value = team();
    value.backlog!.push(ticket("ticket-blocker"));
    value.backlog![0].dependsOn = ["ticket-blocker"];
    expect(selectNextCandidate(value)).toMatchObject({ status: "eligible", candidate: { id: "candidate-two" } });
    value.backlog!.at(-1)!.status = "done";
    expect(selectNextCandidate(value)).toMatchObject({ status: "eligible", candidate: { id: "candidate-one" } });
  });
  it("allows internal dependencies and rejects cycles, missing tickets and overlapping reservations", () => {
    const value = team(); value.sprintCandidates = [candidate("candidate-one", 1, ["ticket-one", "ticket-two"])];
    value.backlog![0].dependsOn = ["ticket-two"];
    expect(selectNextCandidate(value).status).toBe("eligible");
    value.backlog![1].dependsOn = ["ticket-one"];
    expect(selectNextCandidate(value).status).toBe("waiting");
    value.backlog![1].dependsOn = ["ticket-missing"];
    expect(selectNextCandidate(value).status).toBe("waiting");
    value.backlog![1].dependsOn = [];
    value.sprintCandidates.push(candidate("candidate-reserved", 2, ["ticket-one"], { status: "proposed" }));
    expect(selectNextCandidate(value).status).toBe("waiting");
  });
  it.each(["planned", "done", "discarded"] as const)("does not select a %s ticket", (status) => {
    const value = team(); value.backlog![0].status = status;
    expect(selectNextCandidate(value)).toMatchObject({ status: "eligible", candidate: { id: "candidate-two" } });
  });
});

describe("next sprint closure adapter", () => {
  it("posts one cited proposal via the real bridge and leaves the human approval gate intact", async () => {
    const f = await fixture(); await freeze(f.store, closedGoal());
    await f.bridge().poll(); await f.bridge().poll(); await f.bridge().poll();
    const [next] = await f.nextGoals();
    expect(next).toMatchObject({ stage: "awaiting-review", ceremony: { stage: "proposal" }, source: { candidateId: "candidate-one", ticketIds: ["ticket-one"], retrospectiveGoalId: "goal-previous" } });
    expect(next.assignments).toBeUndefined(); expect(next.integration).toBeUndefined(); expect(next.automaticApprovals).toBeUndefined();
    expect(f.shell.run).not.toHaveBeenCalled(); expect(f.message).toHaveBeenCalledTimes(1);
    expect(f.message.mock.calls[0][0]).toContain("Keep outcomes roughly equal in size");
    expect(f.message.mock.calls[0][0]).toContain("Name each dependency by outcome title and owning seat ID");
    expect(proposals(f.chat)).toHaveLength(1); expect(roots(f.chat)).toHaveLength(1);
    const post = proposals(f.chat)[0].message;
    for (const citation of ["ticket-one", "Value for ticket-one", "Sprint value candidate-one", "docs/retros/goal-previous.md", "https://github.com/test/project/pull/3", "release-rounds", "With auto mode off"]) expect(post).toContain(citation);
    expect(post).not.toContain("Invented recommendation");
    const current = teamOf(await f.store.read());
    expect(current.sprintCandidates!.find((item) => item.id === "candidate-one")).toMatchObject({ status: "proposed", goalId: next.id });
    expect(current.backlog![0].status).toBe("planned");
    expect(await f.store.readRuntimeFile(nextSprintRuntimeName("goal-previous"))).toMatchObject({ status: "proposed", goalId: next.id });
    expect(JSON.stringify(await f.store.read())).not.toContain("next-sprint-waiting");
  });

  it("delivers large backlog citations and recovers a lost response without duplicating the approval post", async () => {
    const value = team();
    value.sprintCandidates = [candidate("candidate-one", 1, ["ticket-one", "ticket-two"])];
    for (const item of value.backlog!) {
      item.description = "Acceptance detail ".repeat(2_000);
      item.research = [{ url: `https://example.test/${item.id}`, finding: "Recorded finding ".repeat(2_000) + `Final fact for ${item.id}` }];
    }
    const f = await fixture(undefined, value); await freeze(f.store, closedGoal());
    await expect(f.handle()).rejects.toThrow("waiting for Chick");
    let responseLost = false;
    f.chat.afterPost = async (post) => {
      if (post.message.startsWith("**Draft proposal") && !responseLost) { responseLost = true; throw new Error("Accepted, response lost"); }
    };
    await expect(f.bridge().poll()).rejects.toThrow("Accepted, response lost");
    await f.bridge().poll(); await f.bridge().poll();
    expect(responseLost).toBe(true);
    expect(proposals(f.chat)).toHaveLength(1);
    const post = proposals(f.chat)[0];
    expect(post.message.length).toBeLessThanOrEqual(15_000);
    for (const citation of ["ticket-one", "ticket-two", "Sprint value candidate-one", "docs/retros/goal-previous.md", "With auto mode off"]) expect(post.message).toContain(citation);
    expect(post.message).toContain("Basis excerpt");
    expect(f.message).toHaveBeenCalledTimes(1);
    expect(f.message.mock.calls[0][0]).toContain("Final fact for ticket-two");
    const [next] = await f.nextGoals();
    expect(next.stage).toBe("awaiting-review"); expect(next.assignments).toBeUndefined();
    expect(next.goal).toContain("Final fact for ticket-two");
    const metadata = await f.store.runtime(next.id);
    expect(metadata.proposalPostIds).toEqual([post.id]); expect(metadata.pending).toBeUndefined();
    expect(await f.store.readRuntimeFile(nextSprintRuntimeName("goal-previous"))).toMatchObject({ status: "proposed", goalId: next.id });
  });

  it("uses the latest available frozen retro, skipping missing or corrupt newer publications", async () => {
    const older = closedGoal("goal-older", "01"); const newer = closedGoal("goal-newer", "02");
    const f = await fixture([older, newer]); await freeze(f.store, older);
    expect(await latestFrozenRetro(f.store, await f.store.read(), "team-one")).toMatchObject({ goalId: older.id });
    await freeze(f.store, newer);
    expect(await latestFrozenRetro(f.store, await f.store.read(), "team-one")).toMatchObject({ goalId: newer.id });
    const record = await f.store.readRuntimeFile<{ frozen: { sha256: string } }>(`retro-publication-${newer.id}`);
    record!.frozen.sha256 = "0".repeat(64); await f.store.saveRuntime(`retro-publication-${newer.id}`, record!);
    await expect(f.handle(newer)).rejects.toThrow("waiting for Chick");
    expect((await f.nextGoals())[0].source!.retrospectiveGoalId).toBe(older.id);
  });

  it("states that unavailable retrospective evidence is unknown", async () => {
    const f = await fixture(); await f.bridge().poll(); await f.bridge().poll();
    const [next] = await f.nextGoals(); expect(next.source!.retrospectiveGoalId).toBeUndefined();
    expect(proposals(f.chat)[0].message).toContain("No verified frozen retrospective is available");
    expect(proposals(f.chat)[0].message).not.toContain("docs/retros/");
  });

  it("waits for verified closure and an existing open goal, including a legacy goal", async () => {
    const prior = closedGoal(); delete prior.ceremony!.closure;
    const unclosed = await fixture([prior]); await expect(unclosed.handle()).rejects.toThrow("closure has not been verified");
    expect(await unclosed.nextGoals()).toEqual([]); expect(roots(unclosed.chat)).toHaveLength(0);
    const legacy: PlanningGoal = { id: "goal-open", teamId: "team-one", seatId: "seat-lead", participantSeatIds: [], goal: "Existing", projectRefs: ["test/project"], stage: "clarifying", createdAt: at(10), updatedAt: at(10), mattermost: { channelId: "home", rootPostId: "existing" }, brief: { summary: "Existing", decisions: [], openQuestions: [] } };
    const f = await fixture([closedGoal(), legacy]); await expect(f.handle()).rejects.toThrow("open goal goal-open");
    expect(await f.nextGoals()).toEqual([]); expect(roots(f.chat)).toHaveLength(0);
  });

  it.each(["empty", "blocked"])("keeps %s candidates waiting and retries after grooming", async (kind) => {
    const value = team();
    if (kind === "empty") { value.backlog = []; value.sprintCandidates = []; }
    else { value.backlog!.push(ticket("ticket-blocker")); for (const item of value.backlog!.slice(0, 2)) item.dependsOn = ["ticket-blocker"]; }
    const f = await fixture(undefined, value);
    await expect(f.handle()).rejects.toThrow(kind === "empty" ? "no open tickets" : "blocked");
    await expect(f.handle()).rejects.toThrow();
    expect(f.chat.posts.filter((post) => post.message.startsWith("**Next sprint: waiting**"))).toHaveLength(1);
    expect(roots(f.chat)).toHaveLength(0);
    expect(await f.store.readRuntimeFile<NextSprintRecord>(nextSprintRuntimeName("goal-previous"))).toMatchObject({ status: "waiting" });
    await f.store.update((state) => { teamOf(state).backlog = team().backlog; teamOf(state).sprintCandidates = team().sprintCandidates; }, "Groom eligible backlog");
    await f.bridge().poll(); await f.bridge().poll(); expect(proposals(f.chat)).toHaveLength(1);
  });

  it("reselects a changed candidate revision before committing and reuses the root", async () => {
    const f = await fixture();
    f.chat.afterPost = async (post) => {
      if (post.root_id) return; f.chat.afterPost = undefined;
      await f.store.update((state) => { teamOf(state).sprintCandidates![1].summary = "Revised candidate scope"; }, "Revise candidate during delivery");
    };
    await expect(f.handle()).rejects.toThrow("changed before reservation");
    expect(await f.nextGoals()).toEqual([]); expect(teamOf(await f.store.read()).backlog![0].status).toBe("open");
    await expect(f.handle()).rejects.toThrow("waiting for Chick");
    await f.bridge().poll();
    expect(roots(f.chat)).toHaveLength(1); expect(proposals(f.chat)).toHaveLength(1);
    expect(proposals(f.chat)[0].message).toContain("Revised candidate scope");
  });

  it("serializes concurrent closure handlers and ignores superseded closures", async () => {
    const older = closedGoal("goal-older", "01"); const newer = closedGoal("goal-newer", "02");
    const f = await fixture([older, newer]);
    const results = await Promise.allSettled([f.handle(older), f.handle(newer), f.handle(newer)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results.slice(1).every((result) => result.status === "rejected" && String(result.reason).includes("waiting for Chick"))).toBe(true);
    expect(await f.nextGoals()).toHaveLength(1); expect(roots(f.chat)).toHaveLength(1);
    await f.bridge().poll(); await f.bridge().poll(); expect(proposals(f.chat)).toHaveLength(1);
  });

  it.each(["root", "commit", "request", "proposal"])("recovers a crash after %s without duplicate proposals", async (point) => {
    const f = await fixture(); let crashed = false;
    if (point === "root" || point === "proposal") f.chat.afterPost = async (post) => {
      if (!crashed && (point === "root" ? !post.root_id : post.message.startsWith("**Draft proposal"))) { crashed = true; throw new Error("Accepted, response lost"); }
    };
    if (point === "commit") {
      const update = f.store.update.bind(f.store);
      vi.spyOn(f.store, "update").mockImplementation(async (mutator, subject) => {
        await update(mutator, subject);
        if (!crashed && typeof subject === "string" && subject.startsWith("Reserve candidate")) { crashed = true; throw new Error("Committed, response lost"); }
      });
    }
    if (point === "request") {
      const request = PlanningBridge.requestProposal;
      vi.spyOn(PlanningBridge, "requestProposal").mockImplementation(async (...args) => {
        const result = await request(...args);
        if (!crashed) { crashed = true; throw new Error("Request saved, response lost"); }
        return result;
      });
    }
    if (point === "proposal") { await expect(f.handle()).rejects.toThrow("waiting for Chick"); await expect(f.bridge().poll()).rejects.toThrow("Accepted"); }
    else await expect(f.handle()).rejects.toThrow("response lost");
    expect(crashed).toBe(true);
    await f.bridge().poll(); await f.bridge().poll(); await f.bridge().poll();
    expect(await f.nextGoals()).toHaveLength(1); expect(roots(f.chat)).toHaveLength(1); expect(proposals(f.chat)).toHaveLength(1);
    expect(f.message).toHaveBeenCalledTimes(1); expect((await f.nextGoals())[0].assignments).toBeUndefined();
  });
});
