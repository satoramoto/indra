import { describe, expect, it } from "vitest";
import { PlanningStore, planningChannelId, validateOutcomeSeats, validatePlanningGoal } from "../src/planning.js";
import { git, stateCheckout } from "./state-checkout.js";
import { PlanningBridge, type PlanningChat, type Post } from "../src/planning-bridge.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";

async function fixture(withField = true, planningChannel?: string) {
  const seat = (id: string, displayName: string, role: string, userId: string) => ({ id, displayName, roles: [role], externalIdentities: { mattermost: { userId, username: userId } } });
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team", ...(planningChannel ? { planningChannelId: planningChannel } : {}) } }, seats: [{ ...seat("seat-001", "Chick", "Team Lead", "chick"), externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }, seat("seat-003", "Aaron", "Developer", "aaron"), seat("seat-004", "Corey", "Developer", "corey")] }], sprints: [], ...(withField ? { planningGoals: [] } : {}) };
  return new PlanningStore(await stateCheckout("indra-plan-", state));
}

class FakeChat implements PlanningChat {
  posts: Post[] = [];
  next = 0;
  bots = new Set(["chick", "george"]);
  constructor(private readonly own = "chick") {}
  async ownUserId() { return this.own; }
  async post(channelId: string, message: string, rootId = "", deliveryId?: string) {
    const post = { id: `post${++this.next}`, user_id: this.own, channel_id: channelId, root_id: rootId, message, create_at: Date.now() + this.next, props: { indra_delivery_id: deliveryId } };
    this.posts.push(post); return post;
  }
  async since(channelId: string, _timestamp: number) { return this.posts.filter((post) => post.channel_id === channelId); }
  async isBot(userId: string) { return this.bots.has(userId); }
  human(rootId: string, message: string, userId = "ryan") { this.posts.push({ id: `post${++this.next}`, user_id: userId, channel_id: "channel", root_id: rootId, message, create_at: Date.now() + this.next }); }
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
  it("persists a goal from old v1, resumes the exact session, and drafts only on /proposal", async () => {
    const store = await fixture(false); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project", "channel", ["/project"]);
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
    chat.human("post1", "/proposal");
    await bridge.poll();
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("awaiting-review");
    expect(saved.proposal?.outcomes[0].title).toBe("Learn project");
    expect(chat.posts.at(-1)?.message).toContain("awaiting review");
    expect((await store.runtime(goal.id)).sessionId).toBe("session-1");
  });

  it("does not consume failed input and leaves drafting recoverable", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project", "channel", []);
    chat.human(goal.mattermost.rootPostId, "/proposal");
    const failing: AgentRuntime = { message: async () => { throw new Error("runtime down"); } };
    await expect(new PlanningBridge(store, chat, failing).poll()).rejects.toThrow("runtime down");
    expect((await store.read()).planningGoals?.[0].stage).toBe("drafting");
    expect((await store.runtime(goal.id)).processedPostIds).not.toContain("post3");
    await bridge.poll();
    expect((await store.read()).planningGoals?.[0].stage).toBe("awaiting-review");
  });

  it("starts in the team's recorded planning channel when no channel is passed", async () => {
    const store = await fixture(true, "planning-channel"); const chat = new FakeChat();
    expect(planningChannelId(await store.read(), "team-001")).toBe("planning-channel");
    const goal = await new PlanningBridge(store, chat, new FakeRuntime()).start("Explore project", undefined, []);
    expect(goal.mattermost.channelId).toBe("planning-channel");
    expect(chat.posts[0].channel_id).toBe("planning-channel");
    const explicit = await new PlanningBridge(store, chat, new FakeRuntime()).start("Explore project", "other", []);
    expect(explicit.mattermost.channelId).toBe("other");
  });

  it("refuses to start without a passed or recorded planning channel", async () => {
    const store = await fixture(); const chat = new FakeChat();
    expect(planningChannelId(await store.read(), "team-001")).toBeUndefined();
    await expect(new PlanningBridge(store, chat, new FakeRuntime()).start("Goal", undefined, [])).rejects.toThrow("planningChannelId");
    expect(chat.posts).toHaveLength(0);
  });

  it("rejects invalid participant before posting", async () => {
    const store = await fixture(); const chat = new FakeChat();
    await expect(new PlanningBridge(store, chat, new FakeRuntime()).start("Goal", "channel", [], ["missing"])).rejects.toThrow("participant");
    expect(chat.posts).toHaveLength(0);
  });

  it("processes a bounded queue across polls and ignores its own and replayed posts", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime, 1);
    const goal = await bridge.start("Explore project", "channel", []);
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
    const goal = await bridge.start("Explore project", "channel", []);
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

  it("reconstructs an unsent proposal announcement from durable state", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project", "channel", []);
    chat.human(goal.mattermost.rootPostId, "/proposal");
    const original = chat.post.bind(chat);
    chat.post = async () => { throw new Error("network down"); };
    await expect(bridge.poll()).rejects.toThrow("network down");
    const record = await store.runtime(goal.id);
    delete record.pending;
    await store.saveRuntime(goal.id, record);
    chat.post = original;
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts.at(-1)?.message).toContain("awaiting review");
    expect(runtime.sessions).toHaveLength(2);
  });

  it("rejects invalid planning references before writing state", async () => {
    const store = await fixture();
    await expect(store.update((state) => { state.planningGoals = [{ id: "goal-bad", teamId: "missing", seatId: "seat-001", participantSeatIds: [], goal: "Goal", projectRefs: [], stage: "clarifying", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } }]; }, "Add a bad goal")).rejects.toThrow("Unknown planning team");
    expect((await store.read()).planningGoals).toEqual([]);
  });

  it("rejects empty proposal and brief entries before persistence", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const goal = await new PlanningBridge(store, chat, runtime).start("Goal", "channel", []);
    expect(() => validatePlanningGoal({ ...goal, brief: { ...goal.brief, decisions: [""] } })).toThrow("Invalid planning brief");
    expect(() => validatePlanningGoal({ ...goal, stage: "awaiting-review", proposal: { id: "proposal-1", createdAt: new Date().toISOString(), summary: "Roadmap", outcomes: [{ id: "outcome-1", title: "Do", description: "Describe", seatId: "seat-003" }], risks: [""], openQuestions: [] } })).toThrow("Invalid proposal");
  });
});

async function awaitingReview(own = "chick") {
  const store = await fixture(); const chat = new FakeChat(own); const runtime = new FakeRuntime();
  const bridge = new PlanningBridge(store, chat, runtime);
  const goal = await bridge.start("Explore project", "channel", []);
  chat.human(goal.mattermost.rootPostId, "/proposal");
  await bridge.poll();
  expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
  return { store, chat, runtime, bridge, goal };
}

describe("plan approval", () => {
  it("assigns every outcome to a Developer seat in the proposal", async () => {
    const { store, chat, runtime } = await awaitingReview();
    expect(runtime.prompts.at(-1)).toContain("seat-003 (Aaron), seat-004 (Corey)");
    expect(runtime.prompts.at(-1)).not.toContain("seat-001");
    expect((await store.read()).planningGoals![0].proposal!.outcomes.map((item) => item.seatId)).toEqual(["seat-003", "seat-004"]);
    expect(chat.posts.at(-1)?.message).toContain("Learn project** → Aaron (seat-003)");
    expect(chat.posts.at(-1)?.message).toContain("/approve");
  });

  it("rejects a proposal that stacks outcomes on one seat or uses a non-Developer seat", async () => {
    expect(() => validateOutcomeSeats([{ id: "outcome-1", title: "A", description: "A", seatId: "seat-003" }, { id: "outcome-2", title: "B", description: "B", seatId: "seat-003" }], ["seat-003", "seat-004"])).toThrow("spread");
    expect(() => validateOutcomeSeats([{ id: "outcome-1", title: "A", description: "A", seatId: "seat-001" }], ["seat-003"])).toThrow("not a Developer seat");
    expect(() => validateOutcomeSeats([1, 2, 3].map((n) => ({ id: `outcome-${n}`, title: "A", description: "A", seatId: n === 3 ? "seat-003" : `seat-00${n + 2}` })), ["seat-003", "seat-004"])).not.toThrow();
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    runtime.outcomes = [{ title: "A", description: "A", seatId: "seat-003" }, { title: "B", description: "B", seatId: "seat-003" }];
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project", "channel", []);
    chat.human(goal.mattermost.rootPostId, "/proposal");
    await expect(bridge.poll()).rejects.toThrow("invalid proposal");
    expect((await store.read()).planningGoals![0].stage).toBe("drafting");
  });

  it("approves on a human /approve, queues one assignment per outcome, and stays idempotent across restarts", async () => {
    const { store, chat, runtime, bridge, goal } = await awaitingReview();
    chat.human(goal.mattermost.rootPostId, "/approve");
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
    chat.human(goal.mattermost.rootPostId, "/approve");
    await bridge.poll();
    expect(chat.posts.at(-1)?.message).toContain("Learn project → Aaron (seat-003)");
    expect((await store.read()).planningGoals![0]).toEqual(saved);
    expect(runtime.sessions).toHaveLength(2);
    // Each state change is its own commit; the repeated /approve changed nothing and committed nothing.
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
    const { store, chat, runtime, bridge, goal } = await awaitingReview();
    chat.human(goal.mattermost.rootPostId, "/approve");
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

  it("refuses approval from a bot or from Chick's seat", async () => {
    const { store, chat, bridge, goal } = await awaitingReview("bridge");
    chat.bots.delete("chick");
    chat.human(goal.mattermost.rootPostId, "/approve", "george");
    chat.human(goal.mattermost.rootPostId, "/approve", "chick");
    await bridge.poll();
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect((await store.read()).planningGoals![0].assignments).toBeUndefined();
    expect(chat.posts.slice(-2).map((post) => post.message)).toEqual(["Only a human can approve a proposal. Nothing changed.", "Only a human can approve a proposal. Nothing changed."]);
  });

  it("ignores /approve posted by its own account", async () => {
    const { store, chat, bridge, goal } = await awaitingReview();
    chat.bots.delete("chick");
    chat.human(goal.mattermost.rootPostId, "/approve", "chick");
    const count = chat.posts.length;
    await bridge.poll();
    expect(chat.posts).toHaveLength(count);
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
  });

  it("explains why /approve does nothing before a proposal exists", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project", "channel", []);
    chat.human(goal.mattermost.rootPostId, "/approve");
    await bridge.poll();
    expect(chat.posts.at(-1)?.message).toContain("Nothing to approve");
    expect(chat.posts.at(-1)?.message).toContain("clarifying");
    expect(runtime.sessions).toHaveLength(1);
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("clarifying");
    expect(saved.assignments).toBeUndefined();
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
