import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore, validatePlanningGoal } from "../src/planning.js";
import { PlanningBridge, type PlanningChat, type Post } from "../src/planning-bridge.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";

async function fixture(withField = true) {
  const dir = await mkdtemp(join(tmpdir(), "indra-plan-"));
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }], sprints: [], ...(withField ? { planningGoals: [] } : {}) };
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  return new PlanningStore(dir);
}

class FakeChat implements PlanningChat {
  posts: Post[] = [];
  next = 0;
  async ownUserId() { return "chick"; }
  async post(channelId: string, message: string, rootId = "", deliveryId?: string) {
    const post = { id: `post${++this.next}`, user_id: "chick", channel_id: channelId, root_id: rootId, message, create_at: Date.now() + this.next, props: { indra_delivery_id: deliveryId } };
    this.posts.push(post); return post;
  }
  async since(channelId: string, _timestamp: number) { return this.posts.filter((post) => post.channel_id === channelId); }
  human(rootId: string, message: string) { this.posts.push({ id: `post${++this.next}`, user_id: "ryan", channel_id: "channel", root_id: rootId, message, create_at: Date.now() + this.next }); }
}
class FakeRuntime implements AgentRuntime {
  sessions: (string | undefined)[] = [];
  async message(_prompt: string, schemaPath: string, sessionId?: string): Promise<AgentResult> {
    this.sessions.push(sessionId);
    const response = schemaPath.endsWith("proposal.json") ? { summary: "Roadmap", outcomes: [{ title: "Learn project", description: "Inspect it and report findings" }], risks: [], openQuestions: [] } : { reply: "What matters most?", summary: "Explore project", decisions: [], openQuestions: ["Priority?"] };
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
    await expect(store.update((state) => { state.planningGoals = [{ id: "goal-bad", teamId: "missing", seatId: "seat-001", participantSeatIds: [], goal: "Goal", projectRefs: [], stage: "clarifying", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } }]; })).rejects.toThrow("Unknown planning team");
    expect((await store.read()).planningGoals).toEqual([]);
  });

  it("rejects empty proposal and brief entries before persistence", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const goal = await new PlanningBridge(store, chat, runtime).start("Goal", "channel", []);
    expect(() => validatePlanningGoal({ ...goal, brief: { ...goal.brief, decisions: [""] } })).toThrow("Invalid planning brief");
    expect(() => validatePlanningGoal({ ...goal, stage: "awaiting-review", proposal: { id: "proposal-1", createdAt: new Date().toISOString(), summary: "Roadmap", outcomes: [{ id: "outcome-1", title: "Do", description: "Describe" }], risks: [""], openQuestions: [] } })).toThrow("Invalid proposal");
  });
});
