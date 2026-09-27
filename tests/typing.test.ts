import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore } from "../src/planning.js";
import { PlanningBridge, type PlanningChat, type Post } from "../src/planning-bridge.js";
import { MattermostPlanningChat } from "../src/planning-mattermost.js";
import type { AgentResult, AgentRuntime } from "../src/codex-runtime.js";

async function fixture(): Promise<PlanningStore> {
  const dir = await mkdtemp(join(tmpdir(), "indra-typing-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: [], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }], sprints: [], planningGoals: [] }));
  return new PlanningStore(dir);
}
const result = (): AgentResult => ({ sessionId: "session-1", response: { reply: "Ready", summary: "Goal", decisions: [], openQuestions: [] }, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" });
class HoldingRuntime implements AgentRuntime {
  calls = 0;
  release?: (value: AgentResult) => void;
  reject?: (error: Error) => void;
  async message(): Promise<AgentResult> {
    this.calls++;
    if (this.calls === 1) return result();
    return new Promise((resolve, reject) => { this.release = resolve; this.reject = reject; });
  }
}
class Chat implements PlanningChat {
  posts: Post[] = [];
  typing = vi.fn(async (_channel: string, _root: string, _signal: AbortSignal) => {});
  stopTyping = vi.fn();
  async ownUserId() { return "chick"; }
  async post(channelId: string, message: string, rootId = "", deliveryId?: string): Promise<Post> {
    const post: Post = { id: `post${this.posts.length + 1}`, user_id: "chick", channel_id: channelId, root_id: rootId, message, create_at: Date.now(), props: { indra_delivery_id: deliveryId } };
    this.posts.push(post); return post;
  }
  async since() { return this.posts; }
  human(rootId: string) { this.posts.push({ id: `post${this.posts.length + 1}`, user_id: "ryan", channel_id: "channel", root_id: rootId, message: "Clarify", create_at: Date.now() }); }
}

afterEach(() => vi.useRealTimers());
describe("planning typing lifecycle", () => {
  it("signals only while a routed input is active, refreshes, then stops", async () => {
    const store = await fixture(); const chat = new Chat(); const runtime = new HoldingRuntime(); const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Goal", "channel", []);
    expect(chat.typing).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    chat.human(goal.mattermost.rootPostId);
    const polling = bridge.poll();
    await vi.waitFor(() => expect(chat.typing).toHaveBeenCalledTimes(1));
    expect(chat.typing).toHaveBeenCalledWith("channel", goal.mattermost.rootPostId, expect.any(AbortSignal));
    expect(chat.typing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(chat.typing).toHaveBeenCalledTimes(2);
    runtime.release!(result());
    await polling;
    expect(chat.stopTyping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(chat.typing).toHaveBeenCalledTimes(2);
  });

  it("stops signaling on runtime failure without changing the failure", async () => {
    const store = await fixture(); const chat = new Chat(); const runtime = new HoldingRuntime(); const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Goal", "channel", []);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); chat.human(goal.mattermost.rootPostId);
    const polling = bridge.poll();
    await vi.waitFor(() => expect(runtime.reject).toBeTypeOf("function"));
    runtime.reject!(new Error("runtime down"));
    await expect(polling).rejects.toThrow("runtime down");
    expect(chat.stopTyping).toHaveBeenCalledTimes(1);
  });

  it("ignores typing transport failure and still posts the reply", async () => {
    const store = await fixture(); const chat = new Chat(); const runtime: AgentRuntime = { message: async () => result() };
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Goal", "channel", []);
    chat.typing.mockRejectedValue(new Error("socket failed"));
    chat.human(goal.mattermost.rootPostId);
    await bridge.poll();
    expect(chat.posts.at(-1)?.message).toBe("Ready");
  });

  it("does not signal a queued post until that post starts processing", async () => {
    const store = await fixture(); const chat = new Chat(); const runtime = new HoldingRuntime(); const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Goal", "channel", []);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    chat.human(goal.mattermost.rootPostId);
    chat.human(goal.mattermost.rootPostId);
    const polling = bridge.poll();
    await vi.waitFor(() => expect(chat.typing).toHaveBeenCalledTimes(1));
    expect(runtime.calls).toBe(2);
    runtime.release!(result());
    await vi.waitFor(() => expect(chat.typing).toHaveBeenCalledTimes(2));
    runtime.release!(result());
    await polling;
    expect(chat.stopTyping).toHaveBeenCalledTimes(2);
  });
});

class FakeSocket extends EventTarget {
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.frames.push(frame);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ seq_reply: frame.seq, status: "OK" }) })));
  }
  close() { this.readyState = 3; }
}

describe("Mattermost typing protocol", () => {
  it("authenticates the WebSocket and sends thread-scoped user_typing frames", async () => {
    const socket = new FakeSocket();
    const chat = new MattermostPlanningChat("fixture-token", fetch, (url) => { expect(url).toBe("wss://mattermost.newegypt.io/api/v4/websocket"); return socket as unknown as WebSocket; });
    await chat.typing("channel", "root", new AbortController().signal);
    expect(socket.frames).toEqual([{ seq: 1, action: "authentication_challenge", data: { token: "fixture-token" } }, { seq: 2, action: "user_typing", data: { channel_id: "channel", parent_id: "root" } }]);
    chat.stopTyping();
    expect(socket.readyState).toBe(3);
  });
});
