import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlanningBridge, type PlanningChat, type Post, type Reaction, type CeremonyAdapters } from "../src/planning-bridge.js";
import { PlanningStore } from "../src/planning.js";
import type { CeremonyWriteReadiness } from "../src/ceremony-ports.js";
import type { AgentRuntime } from "../src/codex-runtime.js";
import type { Shell } from "../src/developer-seat.js";
import { stateCheckout } from "./state-checkout.js";

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
}
class Runtime implements AgentRuntime {
  calls = 0;
  failDraft = false;
  async message(_prompt: string, schema: string, session?: string) {
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
  async run(command: string, args: string[]) {
    const line = `${command} ${args.join(" ")}`; this.calls.push(line);
    let stdout = "";
    if (args[0] === "api") { stdout = mainSha; this.branch = args[1].split("heads/")[1] ?? this.branch; }
    if (args[0] === "pr" && args[1] === "list") stdout = this.open && !this.merged ? "https://github.com/test/project/pull/1" : "";
    if (args[0] === "pr" && args[1] === "create") { this.open = true; stdout = "https://github.com/test/project/pull/1"; }
    if (args[0] === "pr" && args[1] === "merge") this.merged = true;
    if (args[0] === "pr" && args[1] === "view") stdout = JSON.stringify({ state: this.merged ? "MERGED" : "OPEN", mergeCommit: this.merged ? { oid: mergeSha } : null });
    if (args.includes("state,baseRefName,mergeCommit,reviewDecision")) stdout = JSON.stringify({ state: "MERGED", baseRefName: this.branch, mergeCommit: { oid: mainSha }, reviewDecision: "APPROVED" });
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
  await copyFile(resolve("tests/fixtures/ceremony-state.schema.json"), join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, ready);
  const chat = new Chat(); const runtime = new Runtime(); const github = new GitHub();
  const bridge = new PlanningBridge(store, chat, runtime, 20, github, adapters);
  const restart = () => new PlanningBridge(store, chat, runtime, 20, github, adapters);
  return { store, chat, runtime, github, bridge, restart };
}

describe("recoverable ceremony wiring", () => {
  it("serializes concurrent starts before creating either thread", async () => {
    const { store, chat, bridge, restart } = await fixture();
    const results = await Promise.allSettled([bridge.start("First"), restart().start("Second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining("open goal") }) });
    expect(chat.posts.filter((post) => !post.root_id)).toHaveLength(1);
    expect((await store.read()).planningGoals).toHaveLength(1);
  });

  it("recovers a root post accepted before its response was lost, using the reserved goal", async () => {
    const { store, chat, runtime, bridge, restart } = await fixture();
    chat.failAfterPost = (post) => !post.root_id;
    await expect(bridge.start("Goal")).rejects.toThrow("response lost");
    expect((await store.read()).planningGoals).toHaveLength(0);
    chat.failAfterPost = undefined;
    await restart().poll();
    const goal = (await store.read()).planningGoals![0];
    expect(goal.mattermost.rootPostId).toBe(chat.posts[0].id);
    expect(chat.posts.filter((post) => !post.root_id)).toHaveLength(1);
    expect(runtime.calls).toBe(1);
    await expect(restart().start("Another goal")).rejects.toThrow(goal.id);
  });

  it("recovers a root whose state commit failed without posting another thread", async () => {
    const { store, chat, runtime, bridge, restart } = await fixture();
    const update = vi.spyOn(store, "update").mockRejectedValueOnce(new Error("Commit failed"));
    await expect(bridge.start("Goal")).rejects.toThrow("Commit failed");
    update.mockRestore();
    await restart().poll();
    expect((await store.read()).planningGoals).toHaveLength(1);
    expect(chat.posts.filter((post) => !post.root_id)).toHaveLength(1);
    expect(runtime.calls).toBe(1);
  });
});

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
const stages = (chat: Chat) => chat.posts.flatMap((post) => [...post.message.matchAll(/\*\*Stage: (\w+)\*\*/g)].map((match) => match[1]));

describe("ordered gates and evidence", () => {
  it.each(["owner", "reaction"])("enters implement once via %s approval and preserves that approval on replay", async (route) => {
    const { store, chat, bridge, restart, goal, proposalPost } = await proposed();
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("proposal");
    chat.react(proposalPost, "white_check_mark", "bot");
    chat.react(proposalPost, "white_check_mark", "chick");
    await bridge.poll();
    expect((await store.read()).planningGoals![0].assignments).toBeUndefined();
    if (route === "owner") await bridge.approve(goal.id);
    else { chat.react(proposalPost); await bridge.poll(); }
    const saved = (await store.read()).planningGoals![0];
    expect(saved.ceremony?.stage).toBe("implement");
    expect(saved.assignments).toHaveLength(1);
    expect(saved.integration?.branch).toBe(`sprint/${goal.id}`);
    await restart().approve(goal.id);
    await restart().poll();
    expect((await store.read()).planningGoals![0]).toEqual(saved);
    expect(stages(chat)).toEqual(["planning", "proposal", "implement"]);
  });

  it("requests proposal immediately, keeps failed drafts there and retries without another stage entry", async () => {
    const { store, chat, runtime, bridge, restart } = await fixture();
    const goal = await bridge.start("Goal");
    await PlanningBridge.requestProposal(store, goal.id);
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("proposal");
    runtime.failDraft = true;
    await bridge.poll();
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("proposal");
    await expect(bridge.approve(goal.id)).rejects.toThrow("awaiting review");
    const calls = runtime.calls;
    await restart().poll();
    expect(runtime.calls).toBe(calls);
    runtime.failDraft = false;
    await PlanningBridge.requestProposal(store, goal.id);
    await restart().poll();
    expect((await store.read()).planningGoals![0].proposal).toBeDefined();
    expect(stages(chat)).toEqual(["planning", "proposal"]);
  });

  it.each(["accepted-post", "before-intent-save"])("recovers the implement announcement after %s without a duplicate", async (failure) => {
    const { store, chat, bridge, restart, goal } = await proposed();
    let fired = false;
    const save = store.saveRuntime.bind(store);
    if (failure === "accepted-post") chat.failAfterPost = (post) => post.message.includes("Stage: implement") && !fired && (fired = true);
    else vi.spyOn(store, "saveRuntime").mockImplementation(async (id, record) => {
      if (!fired && JSON.stringify(record).includes(`stage:${goal.id}:implement`)) { fired = true; throw new Error("Before intent save"); }
      await save(id, record);
    });
    await expect(bridge.approve(goal.id)).rejects.toThrow();
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("implement");
    await restart().poll();
    await restart().poll();
    expect(stages(chat)).toEqual(["planning", "proposal", "implement"]);
    expect((await store.read()).planningGoals![0].assignments).toHaveLength(1);
  });

  it("keeps merge approval in release until a running-build adapter verifies it", async () => {
    const { store, bridge, restart, goal, chat } = await implemented();
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("release");
    await bridge.merge(goal.id);
    await restart().poll();
    const saved = (await store.read()).planningGoals![0];
    expect(saved.integration?.status).toBe("merged");
    expect(saved.ceremony?.stage).toBe("release");
    expect(saved.ceremony?.closure).toBeUndefined();
    expect(stages(chat)).toEqual(["planning", "proposal", "implement", "release"]);
    await expect(bridge.start("Next")).rejects.toThrow(goal.id);
  });

  it("requires verified running evidence before retro, and publication plus archival before closure", async () => {
    let running = false; let archived = false;
    const release = vi.fn(async (context: Parameters<NonNullable<CeremonyAdapters["release"]>["poll"]>[0]) => {
      if (!running) return { status: "pending" as const, reason: "Waiting for reload" };
      return { status: "complete" as const, evidence: { kind: "release-running" as const, prUrl: context.goal.integration!.prUrl!, mergedSha: mergeSha,
        mergePostId: context.mergeApproval!.postId, approval: context.mergeApproval!.approval, checksPassed: true as const, buildSha: mergeSha, runningSha: mergeSha, runningAt: new Date().toISOString() } };
    });
    const retro = vi.fn(async (context: Parameters<NonNullable<CeremonyAdapters["retro"]>["poll"]>[0]) => {
      const postId = await context.post("retro-document", "Recorded sprint retrospective");
      if (!archived) return { status: "pending" as const, reason: "Archival PR awaits review and human approval" };
      return { status: "complete" as const, evidence: { kind: "retro-published" as const, path: `docs/retros/${context.goal.id}.md`, prUrl: "https://github.com/test/project/pull/12", baseBranch: "main" as const,
        mergedSha: "c".repeat(40), postId, publishedAt: new Date().toISOString(), factsOnly: true as const, suggestions: "owner-proposals-only" as const } };
    });
    const { store, bridge, restart, goal, chat } = await implemented({ release: { poll: release }, retro: { poll: retro } });
    expect(release).not.toHaveBeenCalled();
    await bridge.merge(goal.id);
    await bridge.poll();
    expect(retro).not.toHaveBeenCalled();
    running = true;
    await restart().poll();
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("retro");
    expect((await store.read()).planningGoals![0].ceremony?.closure).toBeUndefined();
    await expect(bridge.start("Next")).rejects.toThrow(goal.id);
    archived = true;
    await restart().poll();
    expect((await store.read()).planningGoals![0].ceremony?.closure?.evidence.path).toBe(`docs/retros/${goal.id}.md`);
    expect(stages(chat)).toEqual(["planning", "proposal", "implement", "release", "retro"]);
    expect(chat.posts.filter((post) => post.message === "Recorded sprint retrospective")).toHaveLength(1);
    await restart().start("Next");
    expect((await store.read()).planningGoals).toHaveLength(2);
  });
});
