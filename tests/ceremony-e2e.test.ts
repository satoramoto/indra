import { copyFile, mkdir, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanningBridge, ceremonyRuntimeName, type BridgeCeremonyRecord, type CeremonyAdapters, type CeremonyContext, type PlanningChat, type Post, type Reaction } from "../src/planning-bridge.js";
import { PlanningStore } from "../src/planning.js";
import { RetroPublication, ceremonyReadiness, recordedRetroInput, retroRuntimeName, type RetroPublicationRecord } from "../src/retro-publication.js";
import { draftSprintRetro, type RetroEvidenceSnapshot } from "../src/sprint-retro.js";
import { type RetroArchive, type RetroPr, type RetroReview } from "../src/sprint.js";
import { LocalSessionReader } from "../src/session-snapshot.js";
import { type AgentRuntime, type AgentResult } from "../src/codex-runtime.js";
import { type Shell } from "../src/developer-seat.js";
import { validateCeremony } from "../src/ceremony.js";
import { git, stateCheckout } from "./state-checkout.js";

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });
const integrationUrl = "https://github.com/test/project/pull/2";
const releaseSha = "b".repeat(40);
class Chat implements PlanningChat {
  posts: Post[] = []; marks: Reaction[] = [];
  failAfter?: (post: Post) => boolean;
  hidden = new Set<string>();
  async ownUserId() { return "chick"; }
  async isBot(id: string) { return ["bot", "developer"].includes(id); }
  async post(channel: string, message: string, root = "", delivery?: string) {
    const post: Post = { id: `post-${this.posts.length + 1}`, user_id: "chick", channel_id: channel, root_id: root, message, create_at: Date.now(), props: { indra_delivery_id: delivery } };
    this.posts.push(post); if (this.failAfter?.(post)) throw new Error("Accepted post, lost response");
    return post;
  }
  async since(channel: string, at: number) { return this.posts.filter((post) => post.channel_id === channel && post.create_at >= at && !this.hidden.has(post.id)); }
  async reactions(id: string) { return this.marks.filter((mark) => mark.post_id === id); }
  react(postId: string, user = "human") { this.marks.push({ post_id: postId, user_id: user, emoji_name: "white_check_mark", create_at: Date.now() }); }
}
class Agent implements AgentRuntime {
  calls = 0; retroCalls = 0;
  async message(prompt: string, schema: string, session?: string): Promise<AgentResult> {
    this.calls++; const at = new Date().toISOString();
    let response: unknown = { reply: "What should this achieve?", summary: "Ship", decisions: [], openQuestions: ["Scope?"] };
    if (schema.endsWith("proposal.json")) response = { summary: "Ship", outcomes: [{ title: "Build", description: "Change src/example.ts only", seatId: "seat-dev" }], risks: [], openQuestions: [] };
    if (schema.endsWith("retro.json")) {
      this.retroCalls++;
      expect(session).toBeUndefined();
      const snapshot = JSON.parse(prompt.split("Recorded snapshot (JSON):\n")[1]) as RetroEvidenceSnapshot;
      response = snapshot.choices;
    }
    return { sessionId: session ?? `session-${this.calls}`, startedAt: at, finishedAt: at, usage: { input_tokens: 10, output_tokens: 5 }, response };
  }
}
class Services implements Shell, RetroArchive {
  integrationMerged = false; integrationOpen = false; running = false;
  archive?: RetroPr;
  markdown?: string;
  publications = 0; merges = 0; reviews = 0;
  reviewFindings: RetroReview["findings"] = [];
  loseMerge = false;
  loseCreate = false;
  async run(_command: string, args: string[]) {
    let stdout = "";
    if (args[0] === "api") stdout = "a".repeat(40);
    if (args[1]?.includes("/reviews?")) stdout = JSON.stringify([[{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: "a".repeat(40) }]]);
    if (args[1] === "checks") stdout = JSON.stringify([{ name: "checks", bucket: "pass" }]);
    if (args[0] === "pr" && args[1] === "list") stdout = this.integrationOpen ? integrationUrl : "";
    if (args[0] === "pr" && args[1] === "create") { this.integrationOpen = true; stdout = integrationUrl; }
    if (args[0] === "pr" && args[1] === "merge" && !args.includes("--disable-auto")) this.integrationMerged = true;
    if (args[0] === "pr" && args[1] === "view") stdout = JSON.stringify({ state: this.integrationMerged ? "MERGED" : "OPEN", mergeCommit: this.integrationMerged ? { oid: releaseSha } : null, headRefOid: "a".repeat(40), isDraft: false, author: { login: "owner" }, reviewDecision: "" });
    return { code: 0, stdout, stderr: "" };
  }
  async ensureRetroPr(project: string, goalId: string, markdown: string) {
    expect(project).toBe("test/project"); expect(markdown).toContain(goalId);
    if (this.markdown) expect(markdown).toBe(this.markdown); this.markdown = markdown;
    if (!this.archive) { this.publications++; this.archive = { url: "https://github.com/test/project/pull/3", state: "OPEN", headSha: "c".repeat(40), reviewed: false, checksPassed: false }; }
    if (this.loseCreate) { this.loseCreate = false; throw new Error("PR accepted, lost response"); }
    return this.archive.url;
  }
  async inspectRetroPr() { return structuredClone(this.archive!); }
  async reviewRetroPr(_github: string, _goalId: string, _markdown: string, _url: string, _head: string, review: (cwd: string) => Promise<RetroReview>) {
    this.reviews++;
    const result = await review("/managed/review");
    this.archive!.reviewed = result.findings.length === 0;
  }
  async mergeRetroPr() {
    this.merges++;
    if (this.loseMerge) { this.loseMerge = false; throw new Error("Interrupted before GitHub merge"); }
    this.archive!.state = "MERGED"; this.archive!.mergedSha = "d".repeat(40); return { merged: true as const, sha: "d".repeat(40) };
  }
}
async function fixture() {
  const checkout = await stateCheckout("indra-ceremony-e2e-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{
    id: "team-one", slug: "yahaha", displayName: "Yahaha", project: { github: "test/project" }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
    ],
  }] });
  roots.push(checkout, `${checkout}.runtime`);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile(resolve("schema/v1/state.schema.json"), join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, ceremonyReadiness);
  const chat = new Chat(); const agent = new Agent(); const services = new Services();
  const adapters = (): CeremonyAdapters => ({
    implementation: async ({ goal }) => ({ status: "complete", evidence: { kind: "implementation", outcomes: goal.assignments!.map((assignment) => ({ outcomeId: assignment.outcomeId, seatId: assignment.seatId, prUrl: assignment.prUrl!, baseBranch: goal.integration!.branch, mergedSha: "a".repeat(40), checksPassed: true, reviewApproved: true })) } }),
    release: { poll: async ({ goal, mergeApproval }) => !services.running ? { status: "pending", reason: "Build not running yet" } : { status: "complete", evidence: {
      kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: releaseSha, mergeVerification: { headSha: "a".repeat(40), reviewCommitSha: "a".repeat(40), reviewer: "satori-miyamoto", checksPassed: true },
      checksPassed: true, buildSha: releaseSha, runningSha: releaseSha, runningAt: new Date().toISOString(),
    } } },
    retro: new RetroPublication(services, async (context) => await draftSprintRetro(await recordedRetroInput(context), () => agent), {
      thread: async ({ goal }) => ({ ownUserId: await chat.ownUserId(), posts: await chat.since(goal.mattermost.channelId, Date.parse(goal.createdAt) - 5000) }),
      review: async () => ({ summary: "Reviewed", findings: services.reviewFindings }),
    }),
  });
  const restart = () => new PlanningBridge(store, chat, agent, 20, services, adapters());
  const current = async () => (await store.read()).planningGoals![0];
  return { checkout, store, chat, agent, services, restart, current };
}
async function releasePending() {
  const f = await fixture(); const goal = await f.restart().start("Ship the complete ceremony");
  await PlanningBridge.requestProposal(f.store, goal.id); await f.restart().poll();
  await f.restart().approve(goal.id);
  await f.store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/1" }); }, "Record reviewed implementation merge");
  await f.restart().poll(); await f.restart().merge(goal.id); await f.restart().poll();
  return { ...f, goal };
}

describe("complete persisted sprint ceremony", () => {
  it("loads the pending archival PR after restart before closure", async () => {
    const f = await releasePending(); f.services.running = true; await f.restart().poll();
    const reader = new LocalSessionReader(f.checkout, new PlanningStore(f.checkout), {
      verifiedRecord: async () => undefined, isReady: async () => false, attachTarget: () => "unused",
    }, { read: async () => ({ status: "unavailable" }) });
    const snapshot = await reader.readSessions();
    expect(snapshot.sessions[0].retro).toEqual({ status: "pending", path: `docs/retros/${f.goal.id}.md`, prUrl: f.services.archive!.url });
    expect((await f.current()).ceremony!.closure).toBeUndefined();
  });

  it("retries an automatic merge after restart without a second human approval", async () => {
    const f = await releasePending(); f.services.running = true; await f.restart().poll();
    f.services.archive!.checksPassed = true; f.services.loseMerge = true;
    await expect(f.restart().merge(f.goal.id)).rejects.toThrow("verification is pending");
    const saved = await f.store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(f.goal.id));
    expect(saved!.authorization).toBeUndefined();
    f.services.archive!.checksPassed = false;
    await f.restart().poll(); expect(f.services.merges).toBe(1);
    await expect(f.restart().start("Too early")).rejects.toThrow("open goal");
    f.services.archive!.checksPassed = true;
    await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeDefined();
    expect(f.services.merges).toBe(2);
    await f.restart().start("Next goal");
  });

  it("keeps review findings in retro and prevents a new goal", async () => {
    const f = await releasePending(); f.services.running = true;
    f.services.reviewFindings = [{ path: `docs/retros/${f.goal.id}.md`, line: 1, reason: "Recorded evidence is missing." }];
    await f.restart().poll(); f.services.archive!.checksPassed = true;
    await expect(f.restart().merge(f.goal.id)).rejects.toThrow("fresh review");
    await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeUndefined();
    await expect(f.restart().start("Too early")).rejects.toThrow("open goal");
    expect(f.services.merges).toBe(0);
  });

  it.each(["missing", "edited", "author", "thread", "deleted"])("verifies the first fragment as well as the last when its delivery is %s", async (problem) => {
    const f = await releasePending();
    const runtime = await f.store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(f.goal.id));
    runtime!.facts.failures = Array.from({ length: 40 }, (_, index) => ({ at: new Date().toISOString(), retries: 1, message: `${index}: ${"Historical evidence unavailable. ".repeat(20)}` }));
    await f.store.saveRuntime(ceremonyRuntimeName(f.goal.id), runtime!);
    f.services.running = true; await f.restart().poll();
    const saved = await f.store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(f.goal.id));
    expect(saved!.postIds!.length).toBeGreaterThan(2);
    f.services.archive!.checksPassed = true;
    await f.restart().merge(f.goal.id);
    const first = f.chat.posts.find((post) => post.id === saved!.postIds![0])!;
    const original = structuredClone(first);
    if (problem === "missing") f.chat.hidden.add(first.id);
    if (problem === "edited") first.message += "Changed after publication";
    if (problem === "author") first.user_id = "developer";
    if (problem === "thread") first.root_id = "another-thread";
    if (problem === "deleted") Object.assign(first, { delete_at: Date.now() });
    await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeUndefined();
    await expect(f.restart().start("Too early")).rejects.toThrow("open goal");
    Object.assign(first, original, { delete_at: 0 }); f.chat.hidden.clear();
    await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeDefined();
    const posts = f.chat.posts.filter((post) => saved!.postIds!.includes(post.id));
    expect(posts.map((post) => post.message).join("")).toBe(saved!.frozen!.markdown);
    expect(f.services.publications).toBe(1);
  });

  it("keeps one open sprint through verified release and retro, then closes with bot review and CI", async () => {
    const f = await releasePending();
    expect((await f.current()).ceremony!.stage).toBe("release");
    expect(f.agent.retroCalls).toBe(0);
    await expect(f.restart().start("Next goal")).rejects.toThrow("open goal");
    f.services.running = true; await f.restart().poll();
    expect((await f.current()).ceremony!.stage).toBe("retro");
    await expect(f.restart().start("Next goal")).rejects.toThrow("open goal");
    const record = await f.store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(f.goal.id));
    const post = f.chat.posts.find((post) => post.id === record!.postIds![0])!;
    expect(post.user_id).toBe("chick"); expect(post.channel_id).toBe("home"); expect(post.root_id).toBe(f.goal.mattermost.rootPostId);
    expect(post.message).toBe(f.services.markdown);
    expect(f.services.markdown).toContain("What went well"); expect(f.services.markdown).toContain("unknown");
    f.chat.react(record!.gate!.postId, "bot"); f.chat.react(record!.gate!.postId, "chick");
    await f.restart().poll(); expect(f.services.merges).toBe(0);
    expect(f.services.archive!.reviewed).toBe(true);
    expect(f.services.reviews).toBe(1);
    await expect(f.restart().merge(f.goal.id)).rejects.toThrow("passing CI");
    f.services.archive!.checksPassed = true;
    await f.restart().poll();
    const closed = await f.current(); validateCeremony(closed);
    expect(closed.ceremony!.history.map((entry) => entry.stage)).toEqual(["planning", "proposal", "implement", "release", "retro"]);
    expect(closed.ceremony!.closure?.evidence).toMatchObject({ path: `docs/retros/${f.goal.id}.md`, prUrl: f.services.archive!.url, postId: post.id });
    const timing = await f.store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(f.goal.id));
    expect(timing!.closedAt).toBe(closed.ceremony!.closure!.closedAt);
    expect(timing!.stageEvents).toEqual(closed.ceremony!.history.map((entry) => ({ stage: entry.stage, at: entry.enteredAt })));
    const finalRetroMs = Date.parse(timing!.closedAt!) - Date.parse(timing!.stageEvents!.at(-1)!.at!);
    expect(finalRetroMs).toBeGreaterThanOrEqual(0);
    const completed = await f.store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(f.goal.id));
    expect(completed!.stageTimings!.at(-1)).toMatchObject({ stage: "retro", throughAt: completed!.verifiedAt, elapsedMs: expect.any(Number) });
    await f.restart().poll(); expect(f.services.publications).toBe(1); expect(f.services.merges).toBe(1); expect(f.agent.retroCalls).toBe(1);
    expect(f.chat.posts.filter((item) => item.message === f.services.markdown)).toHaveLength(1);
    const stages = f.chat.posts.flatMap((item) => [...item.message.matchAll(/\*\*Stage: (\w+)\*\*/g)].map((match) => match[1]));
    expect(stages).toEqual(["planning", "proposal", "implement", "release", "retro"]);
    const next = await f.restart().start("Next goal"); expect(next.id).not.toBe(f.goal.id);
    const persisted = JSON.parse(await readFile(join(f.checkout, "state.json"), "utf8"));
    expect(persisted.planningGoals).toHaveLength(2);
    expect(JSON.stringify(persisted)).not.toContain("session-");
    expect(git(f.checkout, "status", "--porcelain", "--", "state.json")).toBe("");
  });

  it("recovers delivery, PR and atomic closure interruptions without duplicate publications or early unlock", async () => {
    const f = await releasePending(); f.services.running = true;
    f.chat.failAfter = (post) => post.message.startsWith("# Sprint retrospective");
    await f.restart().poll();
    expect(f.services.publications).toBe(0);
    await expect(f.restart().start("Too early")).rejects.toThrow("open goal");
    f.chat.failAfter = undefined; f.services.loseCreate = true;
    await f.restart().poll(); expect(f.services.publications).toBe(1);
    await f.restart().poll(); expect(f.services.publications).toBe(1);
    f.services.archive!.reviewed = true; f.services.archive!.checksPassed = true;
    await f.restart().merge(f.goal.id);
    const saved = await f.store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(f.goal.id));
    f.chat.hidden.add(saved!.postIds![0]);
    await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeUndefined();
    f.chat.hidden.clear();
    const update = f.store.update.bind(f.store);
    const failure = vi.spyOn(f.store, "update").mockImplementation(async (change, message) => { if (typeof message === "string" && message.startsWith("Close goal")) throw new Error("State commit interrupted"); return await update(change, message); });
    await expect(f.restart().poll()).rejects.toThrow("State commit interrupted");
    await expect(f.restart().start("Too early")).rejects.toThrow("open goal");
    failure.mockRestore(); await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeDefined();
    expect(f.agent.retroCalls).toBe(1); expect(f.services.publications).toBe(1); expect(f.services.merges).toBe(1);
    expect(f.chat.posts.filter((post) => post.message.startsWith("# Sprint retrospective"))).toHaveLength(1);
    await f.restart().start("Next goal");
  });

  it("keeps a closed-unmerged archival PR in retro across restarts", async () => {
    const f = await releasePending(); f.services.running = true; await f.restart().poll();
    f.services.archive!.state = "CLOSED"; await f.restart().poll(); await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeUndefined();
    await expect(f.restart().merge(f.goal.id)).rejects.toThrow("closed");
    await expect(f.restart().start("Next goal")).rejects.toThrow("open goal");
    expect(f.services.publications).toBe(1); expect(f.agent.retroCalls).toBe(1);
  });

  it("recovers a lost archival announcement and merges on bot review and CI", async () => {
    const f = await releasePending(); f.services.running = true;
    f.chat.failAfter = (post) => post.message.startsWith("**Retrospective archive:");
    await f.restart().poll();
    const gate = f.chat.posts.find((post) => post.message.startsWith("**Retrospective archive:"))!;
    expect(gate).toBeDefined(); f.chat.failAfter = undefined;
    f.services.archive!.reviewed = true; f.services.archive!.checksPassed = true;
    await f.restart().poll();
    expect((await f.current()).ceremony!.closure).toBeDefined();
    expect(f.services.merges).toBe(1);
    expect(f.chat.posts.filter((post) => post.message.startsWith("**Retrospective archive:"))).toHaveLength(1);
  });

  it("uses persisted attempt facts without counting retained snapshots as new sessions or retries", async () => {
    const f = await releasePending();
    const name = `seat-seat-dev-${f.goal.id}-outcome-1`;
    const at = new Date().toISOString();
    const session = { role: "fix", sessionId: "developer-fix", startedAt: at, finishedAt: at, usage: { input_tokens: 9, output_tokens: 4 } };
    const record = { goalId: f.goal.id, outcomeId: "outcome-1", branch: `seat-dev/${f.goal.id}-outcome-1`, worktree: "unused", step: "done", prUrl: "https://github.com/test/project/pull/1", findings: ["src/example.ts:4: missing guard"], conflictRounds: 1, sessions: [session] };
    await f.store.saveRuntime(name, record);
    await f.store.saveRuntime(`${name}-retained-example`, { ...record, conflictRounds: 0 });
    const context = { store: f.store, goal: await f.current() } as CeremonyContext;
    const input = await recordedRetroInput(context);
    expect(input.facts.sessions.filter((item) => item.sessionId === session.sessionId)).toHaveLength(1);
    expect(input.facts.rounds).toContainEqual({ outcomeId: "outcome-1", fix: 1, conflict: 1 });
    expect(input.facts.seats).toContainEqual({ seatId: "seat-dev", wallTimeMs: null });
    expect(input.facts.failures).toHaveLength(0);
    expect(input.missing!.join(" ")).toContain("absence is not zero");
  });
});
