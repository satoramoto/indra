import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlanningBridge, type PlanningChat, type Post, type Reaction, type CeremonyAdapters, type BridgeCeremonyRecord, ceremonyRuntimeName } from "../src/planning-bridge.js";
import { validateCeremony } from "../src/ceremony.js";
import { PlanningStore } from "../src/planning.js";
import type { CeremonyWriteReadiness } from "../src/ceremony-ports.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";
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
  beforeProof?: () => Promise<void>;
  async run(command: string, args: string[]) {
    const line = `${command} ${args.join(" ")}`; this.calls.push(line);
    let stdout = "";
    if (args[0] === "api") { stdout = mainSha; this.branch = args[1].split("heads/")[1] ?? this.branch; }
    if (args[0] === "pr" && args[1] === "list") stdout = this.open && !this.merged ? "https://github.com/test/project/pull/1" : "";
    if (args[0] === "pr" && args[1] === "create") { this.open = true; stdout = "https://github.com/test/project/pull/1"; }
    if (args[0] === "pr" && args[1] === "merge") this.merged = true;
    if (args[0] === "pr" && args[1] === "view") stdout = JSON.stringify({ state: this.merged ? "MERGED" : "OPEN", mergeCommit: this.merged ? { oid: mergeSha } : null });
    if (args.includes("state,baseRefName,mergeCommit,reviewDecision")) { await this.beforeProof?.(); stdout = JSON.stringify({ state: "MERGED", baseRefName: this.branch, mergeCommit: { oid: mainSha }, reviewDecision: "APPROVED" }); }
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
  it.each([1, 20])("drains replies preceding owner P before drafting with a queue limit of %s", async (maxQueue) => {
    const { store, chat, runtime, github, bridge } = await fixture();
    const goal = await bridge.start("Goal");
    const first = chat.reply(goal.mattermost.rootPostId, "Include the migration");
    const second = chat.reply(goal.mattermost.rootPostId, "Preserve existing data");
    await PlanningBridge.requestProposal(store, goal.id);
    const requestedAt = (await store.runtime(goal.id)).proposalRequest!.requestedAt;
    const later = chat.reply(goal.mattermost.rootPostId, "A later follow-up", requestedAt + 1);
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("proposal");
    const message = runtime.message.bind(runtime);
    const prompts: string[] = [];
    vi.spyOn(runtime, "message").mockImplementation(async (prompt, schema, session) => {
      prompts.push(prompt);
      const run = await message(prompt, schema, session);
      return schema.endsWith("proposal.json") ? run : { ...run, response: {
        reply: "Recorded", summary: "Updated goal", decisions: prompt.includes(`Human message: ${first.message}`) ? [first.message] : [first.message, second.message], openQuestions: [],
      } };
    });
    const poll = () => new PlanningBridge(store, chat, runtime, maxQueue, github).poll();
    if (maxQueue === 1) {
      await poll();
      expect((await store.read()).planningGoals![0].proposal).toBeUndefined();
      await poll();
      expect((await store.read()).planningGoals![0].proposal).toBeUndefined();
    }
    await poll();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain(`Human message: ${first.message}`);
    expect(prompts[1]).toContain(`Human message: ${second.message}`);
    expect(prompts[1]).toContain(`"decisions":["${first.message}"]`);
    expect(prompts[2]).toContain(`"decisions":["${first.message}","${second.message}"]`);
    expect(prompts[2]).toContain("Draft the proposal now");
    expect(prompts.join("\n")).not.toContain(later.message);
    const record = await store.runtime(goal.id);
    expect(record.processedPostIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(record.processedPostIds).not.toContain(later.id);
    expect(record.proposalRequest).toBeUndefined();
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
    await poll();
    expect(prompts).toHaveLength(3);
    expect(stages(chat)).toEqual(["planning", "proposal"]);
  });

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

  it.each(["accepted-post", "before-intent-save", "reaction-post"])("recovers the implement announcement after %s without a duplicate", async (failure) => {
    const { store, chat, bridge, restart, goal, proposalPost } = await proposed();
    let fired = false;
    const save = store.saveRuntime.bind(store);
    if (failure !== "before-intent-save") chat.failAfterPost = (post) => post.message.includes("Stage: implement") && !fired && (fired = true);
    else vi.spyOn(store, "saveRuntime").mockImplementation(async (id, record) => {
      if (!fired && JSON.stringify(record).includes(`stage:${goal.id}:implement`)) { fired = true; throw new Error("Before intent save"); }
      await save(id, record);
    });
    if (failure === "reaction-post") { chat.react(proposalPost); await expect(bridge.poll()).rejects.toThrow(); }
    else await expect(bridge.approve(goal.id)).rejects.toThrow();
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("implement");
    await restart().poll();
    await restart().poll();
    expect(stages(chat)).toEqual(["planning", "proposal", "implement"]);
    expect(chat.posts.filter((post) => /\*\*Proposal .* approved\*\*/.test(post.message))).toHaveLength(1);
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
    // Closure must not disable the existing human gate for a later sprint revert.
    await store.update((state) => { state.planningGoals![0].integration!.revertPrUrl = "https://github.com/test/project/pull/13"; }, "Owner opens a later revert");
    await restart().poll();
    const revert = (await store.runtime(goal.id)).mergePosts!.find((item) => item.kind === "revert")!;
    chat.react(revert.id);
    await restart().poll();
    expect((await store.read()).planningGoals![0].integration!.status).toBe("reverted");
    expect((await store.read()).planningGoals![0].ceremony?.closure).toBeDefined();
    await restart().start("Next");
    expect((await store.read()).planningGoals).toHaveLength(2);
  });
});


describe("failure boundaries", () => {
  it("retries a malformed clarification after restart without replaying its failed response", async () => {
    const { store, runtime, chat, bridge, restart } = await fixture();
    const goal = await bridge.start("Goal");
    const reply = chat.reply(goal.mattermost.rootPostId, "Preserve existing data");
    const message = runtime.message.bind(runtime);
    const invoke = vi.spyOn(runtime, "message").mockImplementationOnce(async (prompt, schema, session) => ({
      ...await message(prompt, schema, session), response: { reply: "Incomplete response" },
    }));
    await expect(bridge.poll()).rejects.toThrow("invalid brief response");
    expect((await store.runtime(goal.id)).processedPostIds).not.toContain(reply.id);
    expect(await store.readRuntimeFile(goal.id)).toMatchObject({ turn: { inputKey: reply.id, failure: expect.any(Object), run: { response: null } } });
    await restart().poll();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0]).toContain(`Human message: ${reply.message}`);
    expect((await store.runtime(goal.id)).processedPostIds).toContain(reply.id);
    expect(await store.readRuntimeFile(goal.id)).not.toHaveProperty("turn");
    expect(chat.posts.filter((post) => post.props?.indra_delivery_id === reply.id)).toHaveLength(1);
    const record = await store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(goal.id));
    expect(record?.facts.failures).toHaveLength(1);
    expect(record?.facts.sessions).toHaveLength(3);
    await restart().poll();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("preserves owner approval when a committed draft's delivery journal is recovered", async () => {
    const { store, runtime, chat, bridge, restart } = await fixture();
    const goal = await bridge.start("Goal");
    await PlanningBridge.requestProposal(store, goal.id);
    const save = store.saveRuntime.bind(store);
    let interrupted = false;
    vi.spyOn(store, "saveRuntime").mockImplementation(async (id, record) => {
      if (!interrupted && id === goal.id && "pending" in record && (record.pending as { proposal?: boolean })?.proposal) {
        interrupted = true;
        throw new Error("Delivery journal interrupted");
      }
      await save(id, record);
    });
    await expect(bridge.poll()).rejects.toThrow("Delivery journal interrupted");
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect(await store.readRuntimeFile(goal.id)).toHaveProperty("turn.draft");
    const { goal: approved } = await restart().approve(goal.id);
    expect(approved.ceremony?.stage).toBe("implement");
    expect(approved.assignments).toHaveLength(1);
    const calls = runtime.calls;
    await restart().poll();
    await restart().poll();
    expect((await store.read()).planningGoals![0]).toEqual(approved);
    expect(runtime.calls).toBe(calls);
    expect(await store.readRuntimeFile(goal.id)).not.toHaveProperty("turn");
    expect(chat.posts.filter((post) => post.message.includes("Draft proposal"))).toHaveLength(1);
    expect(stages(chat)).toEqual(["planning", "proposal", "implement"]);
  });

  it("journals a completed draft before its state commit, then recovers without another model call", async () => {
    const { store, runtime, chat, bridge, restart } = await fixture();
    const goal = await bridge.start("Goal");
    await PlanningBridge.requestProposal(store, goal.id);
    const update = store.update.bind(store);
    let failed = false;
    vi.spyOn(store, "update").mockImplementation(async (mutate, message) => {
      if (!failed && typeof message === "string" && message.startsWith("Draft proposal")) { failed = true; throw new Error("Commit unavailable"); }
      await update(mutate, message);
    });
    await expect(bridge.poll()).rejects.toThrow("Commit unavailable");
    const calls = runtime.calls;
    await restart().poll();
    expect(runtime.calls).toBe(calls);
    expect((await store.read()).planningGoals![0].proposal).toBeDefined();
    expect(chat.posts.filter((post) => post.message.includes("Draft proposal"))).toHaveLength(1);
  });

  it("records session facts and forwards a persisted cumulative baseline on resume", async () => {
    const { store, runtime, chat } = await fixture();
    const message = runtime.message.bind(runtime);
    let options: unknown;
    let invocation = 0;
    const completed: AgentRuntime = { message: async (prompt, schema, session, supplied) => {
      options = supplied;
      const run = await message(prompt, schema, session);
      const facts = { invocationId: `call-${++invocation}`, engine: "codex" as const, sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt,
        status: "succeeded" as const, usage: { inputTokens: 7, outputTokens: 3 }, cumulativeUsage: { inputTokens: invocation * 7, outputTokens: invocation * 3 } };
      return { ...run, facts };
    } };
    const active = new PlanningBridge(store, chat, completed, 20, new GitHub());
    const goal = await active.start("Goal");
    await PlanningBridge.requestProposal(store, goal.id);
    await active.poll();
    expect(options).toMatchObject({ previousSessionUsage: { inputTokens: 7, outputTokens: 3 } });
    const record = await store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(goal.id));
    expect(record?.invocations).toHaveLength(2);
    expect(record?.facts.sessions).toHaveLength(2);
    expect(record?.stageEvents?.map((event) => event.stage)).toEqual(["planning", "proposal"]);
  });

  it("rejects running-build evidence that changes the recorded human approval", async () => {
    const { store, bridge, goal } = await implemented({ release: { poll: async (context) => ({ status: "complete", evidence: {
      kind: "release-running", prUrl: context.goal.integration!.prUrl!, mergedSha: mergeSha,
      mergePostId: "unrelated-post", approval: { source: "owner-command", command: "planning merge", at: new Date().toISOString() },
      checksPassed: true, buildSha: mergeSha, runningSha: mergeSha, runningAt: new Date().toISOString(),
    } }) } });
    await bridge.merge(goal.id);
    await expect(bridge.poll()).rejects.toThrow("recorded human merge approval");
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("release");
  });

  it("rejects a stale integration action before opening a PR when a seat claims work during evidence collection", async () => {
    const { store, bridge, github, goal } = await proposed();
    await bridge.approve(goal.id);
    await expect(bridge.integrate(goal.id)).rejects.toThrow("Nothing merged");
    await store.update((state) => { state.planningGoals![0].assignments![0].status = "running"; }, "Seat claims outcome");
    await expect(bridge.integrate(goal.id)).rejects.toThrow("still working");
    expect(github.calls.some((line) => line.includes("pr create"))).toBe(false);
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("implement");
  });
});


describe("owner-authorized partial release", () => {
  it("records every omission, freezes queued claims and refuses a seat that raced the evidence read", async () => {
    const { store, runtime, github, bridge } = await fixture();
    const message = runtime.message.bind(runtime);
    vi.spyOn(runtime, "message").mockImplementation(async (...args) => {
      const run = await message(...args);
      if (args[1].endsWith("proposal.json")) run.response = { summary: "Two outcomes", outcomes: [
        { title: "First", description: "First outcome", seatId: "seat-dev" },
        { title: "Second", description: "Second outcome", seatId: "seat-dev" },
      ], risks: [], openQuestions: [] };
      return run;
    });
    const goal = await bridge.start("Goal");
    await PlanningBridge.requestProposal(store, goal.id);
    await bridge.poll();
    await bridge.approve(goal.id);
    await store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/11" }); }, "First outcome merges");
    github.beforeProof = async () => {
      github.beforeProof = undefined;
      await store.update((state) => { state.planningGoals![0].assignments![1].status = "running"; }, "Second outcome claims concurrently");
    };
    await expect(bridge.integrate(goal.id)).rejects.toThrow("still working");
    expect(github.calls.some((line) => line.includes("pr create"))).toBe(false);
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("implement");
    await store.update((state) => { state.planningGoals![0].assignments![1].status = "queued"; }, "Seat stops before retry");
    await bridge.integrate(goal.id);
    const saved = (await store.read()).planningGoals![0];
    expect(saved.ceremony?.stage).toBe("release");
    expect(saved.assignments![1]).toMatchObject({ status: "failed", note: expect.stringContaining("omitted") });
    const release = saved.ceremony!.history.find((entry) => entry.stage === "release")!;
    expect(release.evidence).toMatchObject({ omissions: [{ outcomeId: "outcome-2", seatId: "seat-dev", reason: expect.any(String) }], partialApproval: { source: "owner-command", command: "planning integrate" } });
    expect(github.calls.filter((line) => line.includes("pr create"))).toHaveLength(1);
    await expect(store.update((state) => { state.planningGoals![0].assignments![1].status = "running"; }, "Stale seat attempts claim")).rejects.toThrow();
    const unapproved = structuredClone(saved);
    delete unapproved.ceremony!.history.find((entry) => entry.stage === "release")!.evidence.partialApproval;
    expect(() => validateCeremony(unapproved)).toThrow("Invalid ceremony");
  });

  it("retains reported usage from a failed Chick invocation without replaying or saving diagnostics", async () => {
    const { store, chat, runtime, bridge } = await fixture();
    const goal = await bridge.start("Goal");
    await PlanningBridge.requestProposal(store, goal.id);
    const at = new Date().toISOString();
    const facts = { invocationId: "failed-invocation", engine: "codex" as const, sessionId: "session-1", startedAt: at, finishedAt: at, status: "timed-out" as const,
      usage: { inputTokens: 5 }, cumulativeUsage: { inputTokens: 12 } };
    const failure = Object.assign(new Error("Unrestricted provider diagnostic"), { facts });
    const failing = { message: vi.fn(async () => { throw failure; }) };
    await new PlanningBridge(store, chat, failing, 20, new GitHub()).poll();
    await new PlanningBridge(store, chat, runtime, 20, new GitHub()).poll();
    expect(failing.message).toHaveBeenCalledOnce();
    const record = await store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(goal.id));
    expect(record?.invocations).toEqual([{ ...facts, seatId: "seat-lead" }]);
    expect(record?.facts.sessions.filter((item) => item.startedAt === at)).toHaveLength(1);
    expect(record?.facts.failures).toHaveLength(1);
    expect(JSON.stringify(record)).not.toContain("Unrestricted provider diagnostic");
    expect((await store.read()).planningGoals![0].ceremony?.stage).toBe("proposal");
  });
});
