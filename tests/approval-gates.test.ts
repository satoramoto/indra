import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlanningBridge, type PlanningChat, type Post, type Reaction, type CeremonyAdapters, type ReleaseEvent } from "../src/planning-bridge.js";
import { proposalDigest, type AutomaticApproval } from "../src/ceremony.js";
import { PlanningStore } from "../src/planning.js";
import type { CeremonyWriteReadiness } from "../src/ceremony-ports.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";
import type { Shell } from "../src/developer-seat.js";
import { stateCheckout } from "./state-checkout.js";

vi.setConfig({ testTimeout: 30_000 });
const ready: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
const mainSha = "a".repeat(40);
const mergeSha = "b".repeat(40);
class Chat implements PlanningChat {
  posts: Post[] = [];
  marks: Reaction[] = [];
  failAfterPost?: (post: Post) => boolean;
  async ownUserId() { return "chick"; }
  async isBot(id: string) { return id === "bot"; }
  async post(channel: string, message: string, root = "", delivery?: string) {
    const post: Post = { id: `post-${this.posts.length + 1}`, channel_id: channel, user_id: "chick", root_id: root, message, create_at: Date.now(), props: { indra_delivery_id: delivery } };
    this.posts.push(post);
    if (this.failAfterPost?.(post)) throw new Error("Post accepted, response lost");
    return post;
  }
  async since(channel: string, at: number) { return this.posts.filter((post) => post.channel_id === channel && post.create_at >= at); }
  async reactions(id: string) { return this.marks.filter((mark) => mark.post_id === id); }
  react(id: string, emoji = "white_check_mark", user = "human") { this.marks.push({ user_id: user, post_id: id, emoji_name: emoji, create_at: Date.now() + this.marks.length }); }
  reply(root: string, message: string, at = Date.now()) {
    const post: Post = { id: `post-${this.posts.length + 1}`, channel_id: "home", user_id: "human", root_id: root, message, create_at: at };
    this.posts.push(post);
    return post;
  }
}
class Runtime implements AgentRuntime {
  calls = 0;
  failDraft = false;
  async message(_prompt: string, schema: string, session?: string): Promise<AgentResult> {
    this.calls++;
    if (schema.endsWith("proposal.json") && this.failDraft) throw new Error("Draft failed");
    const now = new Date().toISOString();
    return { sessionId: session ?? "session-1", startedAt: now, finishedAt: now, usage: { input_tokens: 7, output_tokens: 3 }, response: schema.endsWith("proposal.json")
      ? { summary: "Proposal", outcomes: [{ title: "Build", description: "Implement src/example.ts and test it", seatId: "seat-dev" }], risks: [], openQuestions: [] }
      : { reply: "What is the desired result?", summary: "Goal", decisions: [], openQuestions: ["Desired result?"] } };
  }
}
class GitHub implements Shell {
  calls: string[] = [];
  merged = false;
  open = false;
  branch = "";
  reviewDecision = "";
  reviews = [{ author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z" }];
  headSha = mainSha;
  reviewedHead = mainSha;
  checks = [{ name: "checks", bucket: "pass" }];
  beforeProof?: () => Promise<void>;
  async run(command: string, args: string[]) {
    const line = `${command} ${args.join(" ")}`; this.calls.push(line);
    let stdout = "";
    if (args[0] === "api") { stdout = mainSha; this.branch = args[1].split("heads/")[1] ?? this.branch; }
    if (args[0] === "pr" && args[1] === "list") stdout = this.open && !this.merged ? "https://github.com/test/project/pull/1" : "";
    if (args[0] === "pr" && args[1] === "create") { this.open = true; stdout = "https://github.com/test/project/pull/1"; }
    if (args[0] === "pr" && args[1] === "merge") this.merged = true;
    if (args[0] === "pr" && args[1] === "view") stdout = JSON.stringify({ state: this.merged ? "MERGED" : "OPEN", mergeCommit: this.merged ? { oid: mergeSha } : null,
      headRefName: args[2].endsWith("/13") ? this.branch.replace("sprint/", "revert/") : this.branch, baseRefName: "main", headRefOid: this.headSha, isCrossRepository: false, isDraft: false, author: { login: "owner" } });
    if (args[0] === "api" && args[1].includes("/reviews?")) stdout = JSON.stringify([[{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: this.reviewedHead }]]);
    if (args[0] === "pr" && args[1] === "checks" && args.includes("--json")) stdout = JSON.stringify(this.checks);
    if (args.some((arg) => arg.startsWith("state,baseRefName,mergeCommit,reviewDecision"))) { await this.beforeProof?.(); stdout = JSON.stringify({ state: "MERGED", baseRefName: this.branch, mergeCommit: { oid: mainSha }, reviewDecision: this.reviewDecision, ...(args.some((arg) => arg.split(",").includes("reviews")) ? { reviews: this.reviews } : {}) }); }
    return { code: 0, stdout, stderr: "" };
  }
}
async function fixture(adapters: CeremonyAdapters = {}) {
  const checkout = await stateCheckout("indra-ceremony-flow-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{
    id: "team-1", slug: "yahaha", displayName: "Yahaha", project: { github: "test/project" }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
    ],
  }] });
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile(resolve("schema/v1/state.schema.json"), join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, ready);
  const chat = new Chat(); const runtime = new Runtime(); const github = new GitHub();
  const bridge = new PlanningBridge(store, chat, runtime, 20, github, adapters);
  const restart = () => new PlanningBridge(store, chat, runtime, 20, github, adapters);
  return { store, chat, runtime, github, bridge, restart };
}

async function proposed(adapters: CeremonyAdapters = {}) {
  const f = await fixture(adapters);
  const goal = await f.bridge.start("Ship one outcome");
  await PlanningBridge.requestProposal(f.store, goal.id);
  await f.bridge.poll();
  const proposalPost = (await f.store.runtime(goal.id)).proposalPostIds![0];
  return { ...f, goal, proposalPost };
}
async function implemented(adapters: CeremonyAdapters = {}) {
  const f = await proposed(adapters);
  await f.bridge.approve(f.goal.id);
  await f.store.update((state) => {
    Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/11" });
  }, "Seat merges its reviewed outcome");
  await f.bridge.poll();
  return f;
}
const automaticGate: NonNullable<CeremonyAdapters["automaticGate"]> = async ({ goal, store }, request) => {
  const team = (await store.read()).teams[0] as { standingPolicy: { revisions: { revision: number }[] } };
  const approval: AutomaticApproval = { source: "automatic", policyRevision: team.standingPolicy.revisions.at(-1)!.revision, at: new Date().toISOString(),
    target: request.kind === "proposal" ? { kind: "proposal", goalId: goal.id, proposalId: request.proposalId, proposalDigest: request.proposalDigest }
      : { kind: request.kind, goalId: goal.id, prUrl: request.pr.url, headSha: request.pr.headSha, checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto", reviewedHeadSha: request.pr.headSha } };
  return goal.automaticApprovals?.find((item) => item.policyRevision === approval.policyRevision && JSON.stringify(item.target) === JSON.stringify(approval.target)) ?? approval;
};

describe("shared authorization path", () => {
  it.each(["before", "after"])("recovers a human merge interrupted %s GitHub accepted it", async (when) => {
    const f = await implemented();
    const run = f.github.run.bind(f.github);
    let interrupted = false;
    vi.spyOn(f.github, "run").mockImplementation(async (command, args) => {
      if (args[1] === "merge" && !interrupted) {
        interrupted = true;
        if (when === "after") await run(command, args);
        throw new Error("Interrupted merge");
      }
      return run(command, args);
    });
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("Interrupted merge");
    expect(await f.store.readRuntimeFile(f.goal.id)).toMatchObject({ mergeIntent: { headSha: mainSha, prUrl: "https://github.com/test/project/pull/1" } });
    await f.restart().poll();
    expect((await f.store.read()).planningGoals![0].integration?.status).toBe("merged");
    expect(f.github.calls.filter((line) => line.includes("pr merge"))).toHaveLength(1);
    expect(await f.store.readRuntimeFile(f.goal.id)).not.toHaveProperty("mergeIntent");
  });

  it("invalidates interrupted authorization when the head changes, including a return to the original head", async () => {
    const f = await implemented();
    const run = f.github.run.bind(f.github);
    const stub = vi.spyOn(f.github, "run").mockImplementation(async (command, args) => {
      if (args[1] === "merge") throw new Error("Interrupted");
      return run(command, args);
    });
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("Interrupted");
    const first = (await f.store.runtime(f.goal.id)).mergePosts![0].id;
    stub.mockRestore();
    f.github.headSha = f.github.reviewedHead = "c".repeat(40);
    await f.restart().poll();
    expect(await f.store.readRuntimeFile(f.goal.id)).not.toHaveProperty("mergeIntent");
    f.github.headSha = f.github.reviewedHead = mainSha;
    f.chat.react(first);
    await f.restart().poll();
    expect(f.github.merged).toBe(false);
    await f.restart().merge(f.goal.id);
    expect(f.github.merged).toBe(true);
  });

  it("keeps interrupted authorization pending while CI is unknown, then recovers the same head", async () => {
    const f = await implemented();
    const run = f.github.run.bind(f.github);
    const stub = vi.spyOn(f.github, "run").mockImplementation(async (command, args) => {
      if (args[1] === "merge") throw new Error("Interrupted");
      return run(command, args);
    });
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("Interrupted");
    stub.mockRestore();
    f.github.checks = [];
    await f.restart().poll();
    expect(f.github.merged).toBe(false);
    expect(await f.store.readRuntimeFile(f.goal.id)).toHaveProperty("mergeIntent.headSha", mainSha);
    f.github.checks = [{ name: "checks", bucket: "pass" }];
    await f.restart().poll();
    expect((await f.store.read()).planningGoals![0].integration?.status).toBe("merged");
    expect(await f.store.readRuntimeFile(f.goal.id)).not.toHaveProperty("mergeIntent");
    expect(f.chat.posts.at(-1)?.message).toContain("merged into main");
  });

  it("does not interpret an old unpinned intent as approval for the current head", async () => {
    const f = await implemented();
    await f.store.saveRuntime(f.goal.id, { ...await f.store.runtime(f.goal.id), mergeIntent: { kind: "integration", approval: { source: "owner-command", command: "planning merge", at: new Date().toISOString() } } });
    await expect(f.restart().poll()).rejects.toThrow("authorization is unverified");
    expect(f.github.merged).toBe(false);
    expect(await f.store.readRuntimeFile(f.goal.id)).not.toHaveProperty("mergeIntent");
  });

  it("does not automate without an adapter even with an enabled standing policy", async () => {
    const f = await proposed();
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    await f.bridge.poll();
    expect((await f.store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect((await f.store.read()).planningGoals![0].automaticApprovals).toBeUndefined();
    await f.bridge.approve(f.goal.id);
    expect((await f.store.read()).planningGoals![0].stage).toBe("approved");
  });

  it("records exact policy targets and requests integration authorization only after review and CI", async () => {
    const gates = vi.fn(automaticGate);
    let running = false;
    const f = await proposed({ automaticGate: gates, release: { poll: async ({ goal, mergeApproval }) => running
      ? { status: "complete", evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: mergeSha, mergePostId: mergeApproval!.postId, approval: mergeApproval!.approval, checksPassed: true, buildSha: mergeSha, runningSha: mergeSha, runningAt: new Date().toISOString() } }
      : { status: "pending", reason: "Not running" } } });
    expect(gates).not.toHaveBeenCalled();
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    await f.bridge.poll();
    let saved = (await f.store.read()).planningGoals![0];
    expect(saved.automaticApprovals).toHaveLength(1);
    expect(saved.automaticApprovals![0].target).toEqual({ kind: "proposal", goalId: saved.id, proposalId: saved.proposal!.id, proposalDigest: proposalDigest(saved.proposal!) });
    expect(saved.ceremony!.stage).toBe("implement");
    await f.store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/11" }); }, "Implement");
    f.github.checks = [];
    await f.bridge.poll();
    expect(gates).toHaveBeenCalledTimes(1);
    f.github.checks = [{ name: "checks", bucket: "pass" }];
    f.github.reviewedHead = "c".repeat(40);
    await f.bridge.poll();
    expect(gates).toHaveBeenCalledTimes(1);
    f.github.reviewedHead = mainSha;
    await f.bridge.poll();
    saved = (await f.store.read()).planningGoals![0];
    expect(saved.integration).toMatchObject({ status: "merged", headSha: mainSha });
    expect(saved.automaticApprovals).toHaveLength(2);
    expect(saved.ceremony!.stage).toBe("release");
    await f.bridge.poll();
    expect((await f.store.read()).planningGoals![0].ceremony!.stage).toBe("release");
    running = true;
    await f.bridge.poll();
    expect((await f.store.read()).planningGoals![0].ceremony!.history.at(-1)).toMatchObject({ stage: "retro", evidence: { headSha: mainSha, approval: { source: "automatic", policyRevision: 1 } } });
  });

  it("stops a pending automatic merge when the owner switches the policy off", async () => {
    const f = await implemented({ automaticGate });
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    const run = f.github.run.bind(f.github);
    const stub = vi.spyOn(f.github, "run").mockImplementation(async (command, args) => {
      if (args[1] === "merge") throw new Error("Interrupted");
      return run(command, args);
    });
    await expect(f.bridge.poll()).rejects.toThrow("Interrupted");
    await f.store.updateOwnerSettings("team-1", { autoMode: false });
    stub.mockRestore();
    await f.restart().poll();
    expect(f.github.merged).toBe(false);
    expect(await f.store.readRuntimeFile(f.goal.id)).not.toHaveProperty("mergeIntent");
    await f.bridge.merge(f.goal.id);
    expect(f.github.merged).toBe(true);
  });

  it("rechecks the policy after the authorization adapter returns", async () => {
    const gates: NonNullable<CeremonyAdapters["automaticGate"]> = async (context, request) => {
      const approval = await automaticGate(context, request);
      await context.store.updateOwnerSettings("team-1", { autoMode: false });
      return approval;
    };
    const f = await proposed({ automaticGate: gates });
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    await expect(f.bridge.poll()).rejects.toThrow("current enabled policy");
    expect((await f.store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect((await f.store.read()).planningGoals![0].automaticApprovals).toBeUndefined();
  });

  it("requires a new policy authorization after the owner turns auto mode off and back on", async () => {
    const f = await implemented({ automaticGate });
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    const run = f.github.run.bind(f.github);
    const stub = vi.spyOn(f.github, "run").mockImplementation(async (command, args) => {
      if (args[1] === "merge") throw new Error("Interrupted");
      return run(command, args);
    });
    await expect(f.bridge.poll()).rejects.toThrow("Interrupted");
    await f.store.updateOwnerSettings("team-1", { autoMode: false });
    stub.mockRestore();
    await f.restart().poll();
    expect(f.github.merged).toBe(false);
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    await f.restart().poll();
    expect(f.github.merged).toBe(true);
    expect((await f.store.read()).planningGoals![0].automaticApprovals?.map((approval) => approval.policyRevision)).toEqual([1, 3]);
  });

  it("rechecks policy immediately before a merge and still reconciles a merge accepted before revocation", async () => {
    const f = await implemented({ automaticGate, releaseEvent: async (_context, event) => {
      if (event.kind === "merge-requested") await f.store.updateOwnerSettings("team-1", { autoMode: false });
    } });
    await f.store.updateOwnerSettings("team-1", { autoMode: true });
    await expect(f.bridge.poll()).rejects.toThrow("current enabled policy");
    expect(f.github.merged).toBe(false);

    const g = await implemented({ automaticGate });
    await g.store.updateOwnerSettings("team-1", { autoMode: true });
    const run = g.github.run.bind(g.github);
    vi.spyOn(g.github, "run").mockImplementation(async (command, args) => {
      const result = await run(command, args);
      if (args[1] === "merge") throw new Error("Response lost");
      return result;
    });
    await expect(g.bridge.poll()).rejects.toThrow("Response lost");
    await g.store.updateOwnerSettings("team-1", { autoMode: false });
    await g.restart().poll();
    expect((await g.store.read()).planningGoals![0].integration?.status).toBe("merged");
    expect(g.github.calls.filter((line) => line.includes("pr merge"))).toHaveLength(1);
  });
});

describe("workflow recording adapters", () => {
  it("starts the independent integration reviewer while CI is pending and keeps the human merge gate", async () => {
    const events: ReleaseEvent[] = [];
    const review = vi.fn<NonNullable<CeremonyAdapters["integrationReview"]>>(async () => {});
    const f = await proposed({ integrationReview: review, releaseEvent: async (_context, event) => { events.push(event); } });
    await f.bridge.approve(f.goal.id);
    f.github.checks = [];
    f.github.reviewedHead = "d".repeat(40);
    await f.store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/11" }); }, "Implement");
    await f.bridge.poll();
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0][1]).toMatchObject({ headSha: mainSha, reviewed: false, checksPassed: false });
    expect(events.map((event) => event.kind)).toEqual(["head-observed", "review-started", "review-finished"]);
    expect(f.github.merged).toBe(false);
    f.github.reviewedHead = mainSha;
    f.github.checks = [{ name: "checks", bucket: "pass" }];
    await f.bridge.poll();
    expect(f.github.merged).toBe(false);
    await f.bridge.merge(f.goal.id);
    expect(f.github.merged).toBe(true);
  });

  it("grooms in the background and invokes closed-sprint handling only after verified closure, retrying with the same key", async () => {
    const events: ReleaseEvent[] = [];
    const grooming = vi.fn(async () => {});
    const closedSprint = vi.fn<NonNullable<CeremonyAdapters["closedSprint"]>>(async () => {});
    let running = false; let archived = false;
    const adapters: CeremonyAdapters = { grooming, closedSprint, releaseEvent: async (_context, event) => { events.push(event); },
      release: { poll: async ({ goal, mergeApproval }) => running ? { status: "complete", evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: mergeSha, mergePostId: mergeApproval!.postId, approval: mergeApproval!.approval, checksPassed: true, buildSha: mergeSha, runningSha: mergeSha, runningAt: new Date().toISOString() } } : { status: "pending", reason: "Not running" } },
      retro: { poll: async (context) => {
        if (!archived) return { status: "pending", reason: "Not archived" };
        const postId = await context.post("retro", "Verified retrospective");
        return { status: "complete", evidence: { kind: "retro-published", path: `docs/retros/${context.goal.id}.md`, prUrl: "https://github.com/test/project/pull/2", baseBranch: "main", mergedSha: "c".repeat(40), postId, publishedAt: new Date().toISOString(), factsOnly: true, suggestions: "owner-proposals-only" } };
      } } };
    const f = await implemented(adapters);
    await f.bridge.merge(f.goal.id);
    await f.bridge.poll();
    expect(grooming).toHaveBeenCalled(); expect(closedSprint).not.toHaveBeenCalled();
    expect((await f.store.read()).planningGoals![0].ceremony!.stage).toBe("release");
    running = true;
    await f.bridge.poll();
    expect(closedSprint).not.toHaveBeenCalled();
    archived = true;
    closedSprint.mockRejectedValueOnce(new Error("Interrupted"));
    await f.bridge.poll();
    expect((await f.store.read()).planningGoals![0].ceremony!.closure).toBeDefined();
    await f.restart().poll();
    await f.restart().poll();
    expect(closedSprint).toHaveBeenCalledTimes(2);
    expect(closedSprint.mock.calls[0][1]).toEqual(closedSprint.mock.calls[1][1]);
    expect(closedSprint.mock.calls[1][0].goal.id).toBe(f.goal.id);
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set(["head-observed", "merge-requested", "merged", "running", "closed"]));
  });
});
