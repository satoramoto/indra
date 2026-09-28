import { describe, expect, it } from "vitest";
import { homeChannelId, PlanningStore, teamProject, validateOutcomeSeats, validatePlanningGoal } from "../src/planning.js";
import { git, stateCheckout } from "./state-checkout.js";
import { PlanningBridge, type PlanningChat, type Post, type Reaction } from "../src/planning-bridge.js";
import { MattermostPlanningChat } from "../src/planning-mattermost.js";
import { parseOptions } from "../src/cli.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";

const MEMO = "memo";
const CHECK = "white_check_mark";

async function fixture(withField = true, home: { homeChannelId?: string; github?: string } = { homeChannelId: "channel", github: "satoramoto/indra" }) {
  const seat = (id: string, displayName: string, role: string, userId: string) => ({ id, displayName, roles: [role], externalIdentities: { mattermost: { userId, username: userId } } });
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", ...(home.github ? { project: { github: home.github } } : {}), externalIdentities: { mattermost: { teamId: "team", ...(home.homeChannelId ? { homeChannelId: home.homeChannelId } : {}) } }, seats: [{ ...seat("seat-001", "Chick", "Team Lead", "chick"), externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }, seat("seat-003", "Aaron", "Developer", "aaron"), seat("seat-004", "Corey", "Developer", "corey")] }], sprints: [], ...(withField ? { planningGoals: [] } : {}) };
  return new PlanningStore(await stateCheckout("indra-plan-", state));
}

class FakeChat implements PlanningChat {
  posts: Post[] = [];
  reacted: Reaction[] = [];
  next = 0;
  bots = new Set(["chick", "george"]);
  constructor(private readonly own = "chick") {}
  async ownUserId() { return this.own; }
  async post(channelId: string, message: string, rootId = "", deliveryId?: string) {
    const post = { id: `post${++this.next}`, user_id: this.own, channel_id: channelId, root_id: rootId, message, create_at: Date.now() + this.next, props: { indra_delivery_id: deliveryId } };
    this.posts.push(post); return post;
  }
  async since(channelId: string, _timestamp: number) { return this.posts.filter((post) => post.channel_id === channelId); }
  async reactions(postId: string) { return this.reacted.filter((item) => item.post_id === postId); }
  async isBot(userId: string) { return this.bots.has(userId); }
  human(rootId: string, message: string, userId = "ryan") { this.posts.push({ id: `post${++this.next}`, user_id: userId, channel_id: "channel", root_id: rootId, message, create_at: Date.now() + this.next }); }
  react(postId: string, emoji: string, userId = "ryan") { this.reacted.push({ post_id: postId, user_id: userId, emoji_name: emoji, create_at: Date.now() + ++this.next }); }
}
class FakeRuntime implements AgentRuntime {
  sessions: (string | undefined)[] = [];
  prompts: string[] = [];
  outcomes = [{ title: "Learn project", description: "Inspect it and report findings", seatId: "seat-003" }, { title: "Write tests", description: "Cover the planning flow", seatId: "seat-004" }];
  async message(prompt: string, schemaPath: string, sessionId?: string): Promise<AgentResult> {
    this.sessions.push(sessionId);
    this.prompts.push(prompt);
    const response = schemaPath.endsWith("proposal.json") ? { summary: "Roadmap", outcomes: this.outcomes, risks: [], openQuestions: [] } : { reply: "What matters most?", summary: "Explore project", decisions: [], openQuestions: ["Priority?"] };
    return { sessionId: sessionId ?? "session-1", response, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" };
  }
}

describe("planning bridge", () => {
  it("persists a goal from old v1, resumes the exact session, and drafts only on a person's memo reaction", async () => {
    const store = await fixture(false); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    expect(goal.mattermost.rootPostId).toBe("post1");
    expect((await store.runtime(goal.id)).lastSeenAt).toBeLessThanOrEqual(chat.posts[0].create_at);
    expect(runtime.sessions).toEqual([undefined]);
    chat.human("post1", "Start with the README");
    await bridge.poll();
    expect(runtime.sessions).toEqual([undefined, "session-1"]);
    const replies = chat.posts.length;
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts.length).toBe(replies);
    expect((await store.read()).planningGoals?.[0].stage).toBe("clarifying");
    // A typed "/proposal" is only a reply now; the memo reaction requests the draft.
    chat.react("post1", "thumbsup");
    await bridge.poll();
    expect((await store.read()).planningGoals?.[0].stage).toBe("clarifying");
    chat.react("post1", MEMO);
    await bridge.poll();
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("awaiting-review");
    expect(saved.proposal?.outcomes[0].title).toBe("Learn project");
    const announcement = chat.posts.at(-1)!;
    expect(announcement.message).toContain("awaiting review");
    expect(announcement.message).toContain(`:${CHECK}:`);
    const record = await store.runtime(goal.id);
    expect(record.sessionId).toBe("session-1");
    expect(record.proposalPostIds).toEqual([announcement.id]);
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts.at(-1)).toBe(announcement);
    expect(runtime.sessions).toHaveLength(3);
  });

  it("reverts a failed draft to clarifying, posts once without error details, and drafts again only on a new memo", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    chat.react(goal.mattermost.rootPostId, MEMO);
    const failing: AgentRuntime = { message: async () => { throw new Error("runtime down secret-token"); } };
    await new PlanningBridge(store, chat, failing).poll();
    expect((await store.read()).planningGoals?.[0].stage).toBe("clarifying");
    const failures = chat.posts.filter((post) => post.message.includes("Drafting the proposal failed"));
    expect(failures).toHaveLength(1);
    expect(failures[0].message).not.toContain("secret-token");
    expect(failures[0].message).toContain(`:${MEMO}:`);
    const before = runtime.prompts.length;
    await bridge.poll();
    expect(runtime.prompts.length).toBe(before);
    expect(chat.posts.filter((post) => post.message.includes("Drafting the proposal failed"))).toHaveLength(1);
    chat.react(goal.mattermost.rootPostId, MEMO, "george-human");
    await bridge.poll();
    expect((await store.read()).planningGoals?.[0].stage).toBe("awaiting-review");
  });

  it("recovers a goal left in drafting with no run in flight at bridge start, once, without drafting", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const goal = await new PlanningBridge(store, chat, runtime).start("Explore project");
    await store.update((state) => { state.planningGoals![0].stage = "drafting"; }, "Simulate a crash mid-draft");
    const before = runtime.prompts.length;
    const restarted = new PlanningBridge(store, chat, runtime);
    await restarted.poll();
    await restarted.poll();
    expect((await store.read()).planningGoals?.[0].stage).toBe("clarifying");
    expect(runtime.prompts.length).toBe(before);
    expect(chat.posts.filter((post) => post.root_id === goal.mattermost.rootPostId && post.message.includes("Drafting the proposal failed"))).toHaveLength(1);
  });

  it("starts in the team's home channel with the team's project, and the goal post names the memo reaction", async () => {
    const store = await fixture(true, { homeChannelId: "home-channel", github: "satoramoto/indra" }); const chat = new FakeChat();
    expect(homeChannelId(await store.read(), "team-001")).toBe("home-channel");
    expect(teamProject(await store.read(), "team-001")).toBe("satoramoto/indra");
    const goal = await new PlanningBridge(store, chat, new FakeRuntime()).start("Explore project");
    expect(goal.mattermost.channelId).toBe("home-channel");
    expect(goal.projectRefs).toEqual(["satoramoto/indra"]);
    expect(chat.posts[0].channel_id).toBe("home-channel");
    expect(chat.posts[0].message).toContain(`React :${MEMO}: on this post`);
    expect(chat.posts[0].message).not.toContain("/proposal");
  });

  it("refuses to start without a home channel or project, naming the missing state field", async () => {
    for (const [home, field] of [[{ github: "satoramoto/indra" }, "externalIdentities.mattermost.homeChannelId"], [{ homeChannelId: "channel" }, "project.github"]] as const) {
      const store = await fixture(true, home); const chat = new FakeChat();
      await expect(new PlanningBridge(store, chat, new FakeRuntime()).start("Goal")).rejects.toThrow(field);
      expect(chat.posts).toHaveLength(0);
    }
  });

  it("rejects invalid participant before posting", async () => {
    const store = await fixture(); const chat = new FakeChat();
    await expect(new PlanningBridge(store, chat, new FakeRuntime()).start("Goal", ["missing"])).rejects.toThrow("participant");
    expect(chat.posts).toHaveLength(0);
  });

  it("processes a bounded queue across polls and ignores its own and replayed posts", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime, 1);
    const goal = await bridge.start("Explore project");
    chat.human(goal.mattermost.rootPostId, "First");
    chat.human(goal.mattermost.rootPostId, "Second");
    await bridge.poll();
    expect(runtime.sessions).toHaveLength(2);
    await bridge.poll();
    expect(runtime.sessions).toHaveLength(3);
    await new PlanningBridge(store, chat, runtime).poll();
    expect(runtime.sessions).toHaveLength(3);
  });

  it("retries a pending reply without rerunning Codex after a post failure", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    chat.human(goal.mattermost.rootPostId, "Question");
    const original = chat.post.bind(chat);
    let fail = true;
    chat.post = async (...args) => { if (fail) { fail = false; throw new Error("network down"); } return original(...args); };
    await expect(bridge.poll()).rejects.toThrow("network down");
    expect((await store.runtime(goal.id)).pending?.inputPostId).toBe("post3");
    await new PlanningBridge(store, chat, runtime).poll();
    expect(runtime.sessions).toHaveLength(2);
    expect((await store.runtime(goal.id)).pending).toBeUndefined();
  });

  it("reconstructs an unsent proposal announcement from durable state and records it as the post to approve", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    chat.react(goal.mattermost.rootPostId, MEMO);
    const original = chat.post.bind(chat);
    chat.post = async () => { throw new Error("network down"); };
    await expect(bridge.poll()).rejects.toThrow("network down");
    const record = await store.runtime(goal.id);
    delete record.pending;
    await store.saveRuntime(goal.id, record);
    chat.post = original;
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts.at(-1)?.message).toContain("awaiting review");
    expect((await store.runtime(goal.id)).proposalPostIds).toEqual([chat.posts.at(-1)!.id]);
    expect(runtime.sessions).toHaveLength(2);
  });

  it("rejects invalid planning references before writing state", async () => {
    const store = await fixture();
    await expect(store.update((state) => { state.planningGoals = [{ id: "goal-bad", teamId: "missing", seatId: "seat-001", participantSeatIds: [], goal: "Goal", projectRefs: [], stage: "clarifying", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } }]; }, "Add a bad goal")).rejects.toThrow("Unknown planning team");
    expect((await store.read()).planningGoals).toEqual([]);
  });

  it("rejects empty proposal and brief entries before persistence", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const goal = await new PlanningBridge(store, chat, runtime).start("Goal");
    expect(() => validatePlanningGoal({ ...goal, brief: { ...goal.brief, decisions: [""] } })).toThrow("Invalid planning brief");
    expect(() => validatePlanningGoal({ ...goal, stage: "awaiting-review", proposal: { id: "proposal-1", createdAt: new Date().toISOString(), summary: "Roadmap", outcomes: [{ id: "outcome-1", title: "Do", description: "Describe", seatId: "seat-003" }], risks: [""], openQuestions: [] } })).toThrow("Invalid proposal");
  });

  it("parses planning start and approve without any channel or project option", () => {
    expect(parseOptions(["planning", "start", "--goal", "Fix tests", "--state", "/tmp/s"])).toEqual({ mode: "planning", action: "start", checkout: "/tmp/s", goal: "Fix tests", participants: [] });
    expect(parseOptions(["planning", "approve", "--goal", "goal-1", "--state", "/tmp/s"])).toEqual({ mode: "planning", action: "approve", checkout: "/tmp/s", goal: "goal-1", participants: [] });
    for (const args of [["planning", "approve"], ["planning", "start", "--goal", "G", "--channel", "c"], ["planning", "start", "--goal", "G", "--project", "/p"], ["planning", "approve", "--goal", "g", "--participant", "seat-002"], ["planning", "serve", "--goal", "g"]]) {
      expect(() => parseOptions(args)).toThrow("Usage:");
    }
  });

  it("reads reactions from Mattermost with GET only", async () => {
    const requests: { url: string; method?: string }[] = [];
    const chat = new MattermostPlanningChat("token", "chickcorea", async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify([{ user_id: "ryan", post_id: "p1", emoji_name: CHECK, create_at: 5 }, { user_id: 7 }]), { status: 200 });
    });
    expect(await chat.reactions("p1")).toEqual([{ user_id: "ryan", post_id: "p1", emoji_name: CHECK, create_at: 5 }]);
    expect(requests).toEqual([{ url: "https://mattermost.newegypt.io/api/v4/posts/p1/reactions", method: "GET" }]);
  });
});

async function awaitingReview(own = "chick") {
  const store = await fixture(); const chat = new FakeChat(own); const runtime = new FakeRuntime();
  const bridge = new PlanningBridge(store, chat, runtime);
  const goal = await bridge.start("Explore project");
  chat.react(goal.mattermost.rootPostId, MEMO);
  await bridge.poll();
  expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
  const proposalPost = chat.posts.at(-1)!.id;
  return { store, chat, runtime, bridge, goal, proposalPost };
}

const approvalCommits = (store: PlanningStore) => git(store.checkout, "log", "--format=%s").split("\n").filter((line) => line.startsWith("Approve goal"));

describe("plan approval", () => {
  it("assigns every outcome to a Developer seat in the proposal", async () => {
    const { store, chat, runtime } = await awaitingReview();
    expect(runtime.prompts.at(-1)).toContain("seat-003 (Aaron), seat-004 (Corey)");
    expect(runtime.prompts.at(-1)).not.toContain("seat-001");
    expect((await store.read()).planningGoals![0].proposal!.outcomes.map((item) => item.seatId)).toEqual(["seat-003", "seat-004"]);
    expect(chat.posts.at(-1)?.message).toContain("Learn project** → Aaron (seat-003)");
    expect(chat.posts.at(-1)?.message).toContain(`a person reacts :${CHECK}: on this post`);
    expect(chat.posts.at(-1)?.message).not.toContain("/approve");
  });

  it("rejects a proposal that stacks outcomes on one seat or uses a non-Developer seat", async () => {
    expect(() => validateOutcomeSeats([{ id: "outcome-1", title: "A", description: "A", seatId: "seat-003" }, { id: "outcome-2", title: "B", description: "B", seatId: "seat-003" }], ["seat-003", "seat-004"])).toThrow("spread");
    expect(() => validateOutcomeSeats([{ id: "outcome-1", title: "A", description: "A", seatId: "seat-001" }], ["seat-003"])).toThrow("not a Developer seat");
    expect(() => validateOutcomeSeats([1, 2, 3].map((n) => ({ id: `outcome-${n}`, title: "A", description: "A", seatId: n === 3 ? "seat-003" : `seat-00${n + 2}` })), ["seat-003", "seat-004"])).not.toThrow();
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    runtime.outcomes = [{ title: "A", description: "A", seatId: "seat-003" }, { title: "B", description: "B", seatId: "seat-003" }];
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    chat.react(goal.mattermost.rootPostId, MEMO);
    await bridge.poll();
    expect((await store.read()).planningGoals![0].stage).toBe("clarifying");
    expect((await store.read()).planningGoals![0].proposal).toBeUndefined();
  });

  it("approves on a person's check mark on the proposal post, queues one assignment per outcome, and stays idempotent across restarts", async () => {
    const { store, chat, runtime, bridge, goal, proposalPost } = await awaitingReview();
    chat.react(proposalPost, CHECK);
    await bridge.poll();
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("approved");
    expect(saved.assignments).toEqual([
      { outcomeId: "outcome-1", seatId: "seat-003", status: "queued", updatedAt: saved.updatedAt },
      { outcomeId: "outcome-2", seatId: "seat-004", status: "queued", updatedAt: saved.updatedAt },
    ]);
    const confirmation = chat.posts.at(-1)!;
    expect(confirmation.root_id).toBe(goal.mattermost.rootPostId);
    expect(confirmation.message).toContain("approved");
    expect(confirmation.message).toContain("Learn project → Aaron (seat-003)");
    expect(confirmation.message).toContain("Write tests → Corey (seat-004)");
    const count = chat.posts.length;
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts).toHaveLength(count);
    chat.react(proposalPost, CHECK, "sam");
    await bridge.poll();
    expect(chat.posts).toHaveLength(count + 1);
    expect(chat.posts.at(-1)?.message).toContain("Learn project → Aaron (seat-003)");
    expect((await store.read()).planningGoals![0]).toEqual(saved);
    expect(runtime.sessions).toHaveLength(2);
    // Each state change is its own commit; the repeated check mark changed nothing and committed nothing.
    expect(git(store.checkout, "log", "--format=%s").trim().split("\n").reverse()).toEqual([
      "Initial state",
      `Start planning goal ${goal.id}`,
      `Update brief for goal ${goal.id}`,
      `Start drafting a proposal for goal ${goal.id}`,
      `Draft proposal for goal ${goal.id}: 2 outcomes`,
      `Approve goal ${goal.id}: 2 assignments`,
    ]);
    expect(git(store.checkout, "status", "--porcelain")).toBe("");
  });

  it("posts the confirmation after a restart when delivery failed after approval was saved", async () => {
    const { store, chat, runtime, bridge, goal, proposalPost } = await awaitingReview();
    chat.react(proposalPost, CHECK);
    const original = chat.post.bind(chat);
    chat.post = async () => { throw new Error("network down"); };
    await expect(bridge.poll()).rejects.toThrow("network down");
    expect((await store.read()).planningGoals![0].stage).toBe("approved");
    const record = await store.runtime(goal.id);
    delete record.pending;
    await store.saveRuntime(goal.id, record);
    chat.post = original;
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts.at(-1)?.message).toContain("Learn project → Aaron (seat-003)");
    expect((await store.read()).planningGoals![0].assignments).toHaveLength(2);
  });

  it("refuses check marks and memo reactions from a bot or from Chick's seat", async () => {
    const { store, chat, runtime, bridge, goal, proposalPost } = await awaitingReview("bridge");
    chat.bots.delete("chick");
    chat.react(proposalPost, CHECK, "george");
    chat.react(proposalPost, CHECK, "chick");
    await bridge.poll();
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect((await store.read()).planningGoals![0].assignments).toBeUndefined();
    expect(chat.posts.slice(-2).map((post) => post.message)).toEqual(Array(2).fill("Only a person can approve a proposal; reactions from bots and Chick don't count. Nothing changed."));
    // A bot's memo on a fresh goal starts no draft.
    const other = await bridge.start("Another goal");
    const sessions = runtime.sessions.length;
    chat.react(other.mattermost.rootPostId, MEMO, "george");
    await bridge.poll();
    expect(runtime.sessions).toHaveLength(sessions);
    expect((await store.read()).planningGoals!.find((item) => item.id === other.id)!.stage).toBe("clarifying");
    expect(chat.posts.at(-1)?.message).toContain("Only a person can request a proposal");
    expect(goal.id).not.toBe(other.id);
  });

  it("ignores reactions made by its own account", async () => {
    const { store, chat, bridge, proposalPost } = await awaitingReview();
    chat.bots.delete("chick");
    chat.react(proposalPost, CHECK, "chick");
    const count = chat.posts.length;
    await bridge.poll();
    expect(chat.posts).toHaveLength(count);
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
  });

  it("explains why a check mark does nothing before a proposal exists or on the goal post", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    chat.react(goal.mattermost.rootPostId, CHECK);
    await bridge.poll();
    expect(chat.posts.at(-1)?.message).toContain("Nothing to approve");
    expect(chat.posts.at(-1)?.message).toContain("clarifying");
    expect(runtime.sessions).toHaveLength(1);
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("clarifying");
    expect(saved.assignments).toBeUndefined();
    const review = await awaitingReview();
    review.chat.react(review.goal.mattermost.rootPostId, CHECK);
    await review.bridge.poll();
    expect(review.chat.posts.at(-1)?.message).toContain("on Chick's proposal post rather than the goal post");
    expect((await review.store.read()).planningGoals![0].stage).toBe("awaiting-review");
  });

  it("approves from the terminal through the same path, with a thread confirmation, and never twice", async () => {
    const { store, chat, bridge, goal } = await awaitingReview();
    const first = await new PlanningBridge(store, chat, new FakeRuntime()).approve(goal.id);
    expect(first.alreadyApproved).toBe(false);
    expect(first.goal.assignments).toHaveLength(2);
    const confirmation = chat.posts.at(-1)!;
    expect(confirmation.root_id).toBe(goal.mattermost.rootPostId);
    expect(confirmation.message).toContain(`**Proposal ${first.goal.proposal!.id} approved**`);
    expect(confirmation.message).toContain("Learn project → Aaron (seat-003)");
    const saved = (await store.read()).planningGoals![0];
    // Approving again from the terminal posts nothing and changes nothing.
    const again = await new PlanningBridge(store, chat, new FakeRuntime()).approve(goal.id);
    expect(again.alreadyApproved).toBe(true);
    expect(chat.posts.at(-1)).toBe(confirmation);
    // A later check mark only repeats the confirmation.
    const proposalPost = (await store.runtime(goal.id)).proposalPostIds![0];
    chat.react(proposalPost, CHECK);
    await bridge.poll();
    expect((await store.read()).planningGoals![0]).toEqual(saved);
    expect(approvalCommits(store)).toEqual([`Approve goal ${goal.id}: 2 assignments`]);
  });

  it("does not queue assignments again when the terminal approves after a check mark", async () => {
    const { store, chat, bridge, goal, proposalPost } = await awaitingReview();
    chat.react(proposalPost, CHECK);
    await bridge.poll();
    const saved = (await store.read()).planningGoals![0];
    const result = await bridge.approve(goal.id);
    expect(result.alreadyApproved).toBe(true);
    expect((await store.read()).planningGoals![0]).toEqual(saved);
    expect(approvalCommits(store)).toEqual([`Approve goal ${goal.id}: 2 assignments`]);
  });

  it("refuses terminal approval for an unknown goal or one without a proposal", async () => {
    const store = await fixture(); const chat = new FakeChat();
    const bridge = new PlanningBridge(store, chat, new FakeRuntime());
    const goal = await bridge.start("Explore project");
    const posts = chat.posts.length;
    await expect(bridge.approve(goal.id)).rejects.toThrow("at the clarifying stage");
    await expect(bridge.approve("goal-missing")).rejects.toThrow("No planning goal goal-missing");
    expect(chat.posts).toHaveLength(posts);
    expect((await store.read()).planningGoals![0].stage).toBe("clarifying");
  });

  it("validates the approved stage, outcome seats, and assignments", async () => {
    const { store, goal } = await awaitingReview();
    const current = (await store.read()).planningGoals![0];
    const now = new Date().toISOString();
    const assignment = { outcomeId: "outcome-1", seatId: "seat-003", status: "queued" as const, updatedAt: now };
    const approved = { ...current, stage: "approved" as const, assignments: [assignment] };
    expect(() => validatePlanningGoal(approved)).not.toThrow();
    expect(() => validatePlanningGoal({ ...approved, proposal: undefined, assignments: undefined })).toThrow("Proposal must exist");
    expect(() => validatePlanningGoal({ ...current, assignments: [assignment] })).toThrow("only at approved");
    expect(() => validatePlanningGoal({ ...approved, assignments: [{ ...assignment, outcomeId: "outcome-9" }] })).toThrow("unknown outcome");
    expect(() => validatePlanningGoal({ ...approved, assignments: [{ ...assignment, status: "done" as "queued" }] })).toThrow("Invalid assignment");
    expect(() => validatePlanningGoal({ ...approved, assignments: [assignment, assignment] })).toThrow("only one assignment");
    expect(() => validatePlanningGoal({ ...current, proposal: { ...current.proposal!, outcomes: [{ ...current.proposal!.outcomes[0], seatId: undefined as unknown as string }] } })).toThrow("Invalid proposal");
    const replace = (patch: object) => store.update((state) => { Object.assign(state.planningGoals![0], patch); }, "Replace goal fields");
    await expect(replace({ stage: "approved", assignments: [{ ...assignment, seatId: "seat-999" }] })).rejects.toThrow("outside the team");
    await expect(replace({ proposal: { ...current.proposal!, outcomes: [{ ...current.proposal!.outcomes[0], seatId: "seat-001" }] } })).rejects.toThrow("not a Developer seat");
    await replace({ stage: "approved", assignments: [assignment] });
    expect((await store.read()).planningGoals![0].id).toBe(goal.id);
  });
});
