import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../src/codex-runtime.js";
import type { Shell } from "../src/command-shell.js";
import { controlModules, registerCeremonyAdapters } from "../src/control-adapters.js";
import { PlanningBridge, type CeremonyAdapters, type PlanningChat, type Post } from "../src/planning-bridge.js";
import { PlanningStore } from "../src/planning.js";
import { ReleaseRecorder, createCeremonyAdapters, readReleaseFacts, releaseRounds, type ReleaseFact, type ReleaseFacts } from "../src/release-facts.js";
import { recordedRetroInput } from "../src/retro-publication.js";
import { buildRetroSnapshot } from "../src/sprint-retro.js";
import { stateCheckout } from "./state-checkout.js";

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, seconds)).toISOString();
const prUrl = "https://github.com/test/project/pull/1";
const headSha = "a".repeat(40);
const begin = (): ReleaseFact => ({ kind: "tracking-started", key: "tracking", at: at(0), prUrl });
const observe = (seconds: number, conflicting: boolean | null, head = headSha): ReleaseFact => ({ kind: "observation", key: `observation-${seconds}`, at: at(seconds), prUrl, headSha: head, state: "OPEN", conflicting });
const start = (seconds: number, attemptId = "attempt-one"): ReleaseFact => ({ kind: "merge-started", key: `${attemptId}:start`, at: at(seconds), prUrl, headSha, attemptId });
const finish = (seconds: number, result: "failed" | "merged" | "unknown", attemptId = "attempt-one"): ReleaseFact => ({ kind: "merge-finished", key: `${attemptId}:finish`, at: at(seconds), prUrl, headSha, attemptId, result });
const history = (...events: ReleaseFact[]): ReleaseFacts => ({ version: 1, goalId: "goal-one", events });
const rounds = (facts: ReleaseFacts | undefined, seconds = 100) => releaseRounds(facts, "goal-one", prUrl, at(seconds));
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "indra-release-facts-")); dirs.push(dir);
  const store = new PlanningStore(join(dir, "state"));
  return { store, recorder: new ReleaseRecorder(store, "goal-one") };
}

describe("recorded integration rounds", () => {
  it("counts observed conflict episodes across resolutions, never polling, unknown checks or changed heads", () => {
    const facts = history(begin(), observe(1, false), observe(2, true), observe(3, true), observe(4, null),
      observe(5, true, "b".repeat(40)), observe(6, false), observe(7, false), observe(8, true));
    expect(rounds(facts)).toEqual({ conflict: 2, merge: 0, missing: [] });
    expect(rounds(facts, 5).conflict).toBe(1);
    expect(rounds(facts, 1).conflict).toBe(0);
  });

  it("counts failed and successful commands by attempt identity, excluding observations and copied events", () => {
    const facts = history(begin(), observe(1, false), start(2), start(2), finish(3, "failed"), finish(3, "failed"),
      observe(4, false), start(5, "attempt-two"), finish(6, "merged", "attempt-two"));
    expect(rounds(facts)).toEqual({ conflict: 0, merge: 2, missing: [] });
  });

  it("preserves a merge attempt's identity after restart and replays its finish once", async () => {
    const { store, recorder } = await fixture();
    for (const event of [begin(), observe(1, false), start(2)]) await recorder.record(event);
    const restart = new ReleaseRecorder(store, "goal-one");
    expect(rounds(await restart.read()).merge).toBeNull();
    await restart.record({ ...start(2), at: at(3) });
    await restart.record(finish(4, "merged"));
    await restart.record({ ...finish(4, "merged"), at: at(5) });
    const facts = await readReleaseFacts(store, "goal-one");
    expect(facts!.events.filter((event) => event.kind === "merge-started")).toEqual([start(2)]);
    expect(rounds(facts)).toEqual({ conflict: 0, merge: 1, missing: [] });
    expect(rounds(facts, 3)).toMatchObject({ conflict: 0, merge: null });
  });

  it("does not turn interrupted or unmatched attempts into a complete total", () => {
    for (const attempts of [[start(2)], [finish(3, "merged")], [start(2), finish(3, "unknown")],
      [start(2), { ...finish(3, "merged"), headSha: "b".repeat(40) }],
      [start(2), { ...start(3), key: "another-command" }, finish(4, "merged")]]) {
      expect(rounds(history(begin(), observe(1, false), ...attempts))).toEqual({ conflict: 0, merge: null,
        missing: ["Integration PR merge attempts are incomplete; merge rounds are unknown."] });
    }
  });

  it("uses a recovered receipt for the same interrupted attempt only from its recorded recovery time", async () => {
    const { store, recorder } = await fixture();
    for (const event of [begin(), observe(1, false), start(2), finish(3, "unknown")]) await recorder.record(event);
    const restart = new ReleaseRecorder(store, "goal-one");
    await restart.record({ ...finish(5, "merged"), key: "attempt-one:recovered" });
    const facts = await restart.read();
    expect(rounds(facts, 4).merge).toBeNull();
    expect(rounds(facts, 5).merge).toBe(1);
    await restart.record({ ...finish(6, "failed"), key: "contradictory-receipt" });
    expect(rounds(await restart.read()).merge).toBeNull();
  });

  it("excludes later attempts and resolutions at the cutoff, without completing a pending attempt early", () => {
    const facts = history(begin(), observe(1, true), start(2), finish(3, "failed"), observe(4, false), observe(5, true),
      start(6, "attempt-two"), finish(7, "merged", "attempt-two"));
    expect(rounds(facts, 1)).toEqual({ conflict: 1, merge: 0, missing: [] });
    expect(rounds(facts, 2).merge).toBeNull();
    expect(rounds(facts, 3)).toEqual({ conflict: 1, merge: 1, missing: [] });
    expect(rounds(facts, 5)).toEqual({ conflict: 2, merge: 1, missing: [] });
    expect(rounds(facts, 6).merge).toBeNull();
    expect(rounds(facts, 7)).toEqual({ conflict: 2, merge: 2, missing: [] });
  });

  it("distinguishes explicit zero from absent, legacy, post-cutoff and unknown observation history", async () => {
    const { store, recorder } = await fixture();
    expect(await recorder.read()).toBeUndefined();
    for (const facts of [undefined, history(), history(observe(1, false)), history({ ...begin(), at: at(101) })]) {
      expect(rounds(facts)).toMatchObject({ conflict: null, merge: null });
    }
    expect(rounds(history(begin(), observe(1, null)))).toMatchObject({ conflict: null, merge: 0 });
    for (const event of [begin(), observe(1, false)]) await recorder.record(event);
    expect(rounds(await readReleaseFacts(store, "goal-one"))).toEqual({ conflict: 0, merge: 0, missing: [] });
  });

  it("leaves corrupt, crossed and contradictory history unknown", async () => {
    const { store, recorder } = await fixture();
    for (const event of [begin(), observe(1, false)]) await recorder.record(event);
    for (const facts of [history(begin(), observe(2, false), observe(1, true)),
      history(begin(), observe(1, false), { ...observe(1, true) }),
      history(begin(), { ...observe(1, false), prUrl: "https://github.com/test/project/pull/2" }),
      { ...history(begin(), observe(1, false)), goalId: "goal-other" }]) {
      expect(rounds(facts)).toMatchObject({ conflict: null, merge: null });
    }
    await writeFile(join(store.runtimeDir, `${recorder.name}.json`), "{");
    expect(await readReleaseFacts(store, "goal-one")).toBeUndefined();
    await expect(recorder.record(start(2))).rejects.toThrow();
    expect(await readFile(join(store.runtimeDir, `${recorder.name}.json`), "utf8")).toBe("{");
  });

  it("writes only whitelisted evidence under runtime with private permissions and serializes concurrent delivery", async () => {
    const { store, recorder } = await fixture();
    await recorder.record(Object.assign(begin(), { diagnostic: "untrusted diagnostic", arbitrary: { nested: "discard me" } }));
    await Promise.all([recorder.record(observe(1, false)), recorder.record(observe(1, false))]);
    await expect(recorder.record(observe(1, true))).rejects.toThrow("Conflicting release event replay");
    const file = join(store.runtimeDir, `${recorder.name}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).facts.releaseFacts).toEqual(history(begin(), observe(1, false)));
    await expect(stat(store.checkout)).rejects.toThrow();
  });
});

class GitHub implements Shell {
  branch = "";
  head = headSha;
  mergeable = "MERGEABLE";
  open = false;
  merged = false;
  mergeCalls = 0;
  checkCalls = 0;
  mode: "merged" | "failed" | "lost-response" = "merged";
  observationFails = false;
  checksPass: (call: number) => boolean = () => true;
  beforeCommand?: () => Promise<void>;
  async run(command: string, args: string[]) {
    if (command !== "gh") throw new Error("Unexpected command");
    if (args[0] === "api" && args[1].includes("/git/ref/heads/")) {
      this.branch = args[1].split("/heads/")[1];
      return { code: 0, stdout: this.head, stderr: "" };
    }
    if (args[0] === "api" && args[1].includes("/reviews?")) return { code: 0, stdout: JSON.stringify([[{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: this.head }]]), stderr: "" };
    if (args[0] !== "pr") throw new Error("Unexpected GitHub operation");
    if (args[1] === "list") return { code: 0, stdout: this.open ? prUrl : "", stderr: "" };
    if (args[1] === "create") { this.open = true; return { code: 0, stdout: prUrl, stderr: "" }; }
    if (args[1] === "checks") {
      const pass = args[2].endsWith("/11") || this.checksPass(++this.checkCalls);
      return { code: pass ? 0 : 1, stdout: JSON.stringify([{ name: "checks", bucket: pass ? "pass" : "fail" }]), stderr: "" };
    }
    if (args[1] === "view") {
      if (args[2].endsWith("/11")) return { code: 0, stdout: JSON.stringify({ state: "MERGED", baseRefName: this.branch, mergeCommit: { oid: headSha }, reviewDecision: "APPROVED" }), stderr: "" };
      if (this.observationFails && args.at(-1) === "state,headRefName,baseRefName,headRefOid,isCrossRepository,mergeable") return { code: 1, stdout: "unreadable diagnostic", stderr: "discard this diagnostic" };
      return { code: 0, stdout: JSON.stringify({ state: this.merged ? "MERGED" : "OPEN", headRefName: this.branch, baseRefName: "main", headRefOid: this.head,
        isCrossRepository: false, isDraft: false, author: { login: "owner" }, mergeCommit: this.merged ? { oid: "c".repeat(40) } : null, mergeable: this.mergeable }), stderr: "" };
    }
    if (args[1] === "merge") {
      await this.beforeCommand?.();
      this.mergeCalls++;
      this.merged = this.mode !== "failed";
      if (this.mode === "lost-response") throw new Error("Merge accepted, response lost");
      return { code: this.merged ? 0 : 1, stdout: "", stderr: "untrusted merge diagnostic" };
    }
    throw new Error("Unexpected GitHub operation");
  }
}

async function gateFixture(recording = true) {
  const checkout = await stateCheckout("indra-release-gate-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{
    id: "team-one", slug: "yahaha", displayName: "Yahaha", project: { github: "test/project" }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
    ],
  }] });
  dirs.push(checkout, `${checkout}.runtime`);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } });
  const posts: Post[] = [];
  const chat: PlanningChat = {
    ownUserId: async () => "chick", isBot: async () => false, reactions: async () => [],
    since: async (channel, since) => posts.filter((post) => post.channel_id === channel && post.create_at >= since),
    post: async (channel, message, root = "", delivery) => {
      const post = { id: `post-${posts.length + 1}`, user_id: "chick", channel_id: channel, root_id: root, message, create_at: Date.now(), props: { indra_delivery_id: delivery } };
      posts.push(post); return post;
    },
  };
  const runtime: AgentRuntime = { message: async (_prompt, schema, session) => ({ sessionId: session ?? "planning-session", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    response: schema.endsWith("proposal.json") ? { summary: "Ship", outcomes: [{ title: "Change", description: "Ship one change", seatId: "seat-dev" }], risks: [], openQuestions: [] }
      : { reply: "Ready to plan", summary: "Ship", decisions: [], openQuestions: [] } }) };
  const github = new GitHub();
  let running = false;
  const makeBridge = (record = true, wrap?: (adapters: CeremonyAdapters) => CeremonyAdapters) => {
    const recorder = record ? createCeremonyAdapters({ store }, github) : {};
    const adapters: CeremonyAdapters = { release: { poll: async ({ goal, mergeApproval }) => running ? { status: "complete", evidence: {
      kind: "release-running", prUrl, mergedSha: goal.integration!.mergedSha!, buildSha: goal.integration!.mergedSha!, runningSha: goal.integration!.mergedSha!,
      runningAt: new Date().toISOString(), checksPassed: true, approval: mergeApproval!.approval, mergePostId: mergeApproval!.postId,
    } } : { status: "pending", reason: "Build not running yet" } } };
    registerCeremonyAdapters(adapters, wrap ? wrap(recorder) : recorder);
    return new PlanningBridge(store, chat, runtime, 20, github, adapters);
  };
  const bridge = makeBridge(recording);
  const goal = await bridge.start("Ship one change");
  await PlanningBridge.requestProposal(store, goal.id);
  await bridge.poll(); await bridge.approve(goal.id);
  await store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/11" }); }, "Implement");
  await bridge.poll();
  const facts = () => readReleaseFacts(store, goal.id);
  const totals = async () => releaseRounds(await facts(), goal.id, prUrl, new Date().toISOString());
  return { bridge, store, goal, github, makeBridge, facts, totals, runtime, runBuild: () => { running = true; } };
}

describe("shared release gates through the recording adapter", () => {
  it("records resolved conflict episodes on the same or changed head without counting repeated observations", async () => {
    expect(controlModules["./release-facts.ts"]?.createCeremonyAdapters).toBe(createCeremonyAdapters);
    expect(controlModules["./release-facts.ts"]?.controlServices).toEqual(["releaseFacts"]);
    const f = await gateFixture();
    expect(await f.totals()).toEqual({ conflict: 0, merge: 0, missing: [] });
    const firstRead = (await f.facts())!.events.at(-1)!.at;
    for (const mergeable of ["CONFLICTING", "CONFLICTING", "UNKNOWN", "CONFLICTING"]) { f.github.mergeable = mergeable; await f.bridge.poll(); }
    f.github.head = "b".repeat(40); await f.bridge.poll();
    expect((await f.totals()).conflict).toBe(1);
    for (const mergeable of ["MERGEABLE", "MERGEABLE", "CONFLICTING", "CONFLICTING"]) { f.github.mergeable = mergeable; await f.bridge.poll(); }
    expect(await f.totals()).toEqual({ conflict: 2, merge: 0, missing: [] });
    expect(releaseRounds(await f.facts(), f.goal.id, prUrl, firstRead).conflict).toBe(0);
    expect((await f.facts())!.events.filter((event) => event.kind === "observation")).toHaveLength(7);
    expect(f.github.mergeCalls).toBe(0);
  });

  it("counts failed and successful commands, persists their IDs before dispatch and includes them in the normal retro reader", async () => {
    const f = await gateFixture();
    f.github.beforeCommand = async () => {
      expect((await f.facts())!.events.filter((event) => event.kind === "merge-started")).toHaveLength(f.github.mergeCalls + 1);
    };
    f.github.mode = "failed";
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("Not merged");
    expect(await f.totals()).toEqual({ conflict: 0, merge: 1, missing: [] });
    f.github.mode = "merged";
    const restart = f.makeBridge();
    await restart.merge(f.goal.id); f.runBuild(); await restart.poll(); await restart.poll();
    expect(await f.totals()).toEqual({ conflict: 0, merge: 2, missing: [] });
    expect(f.github.mergeCalls).toBe(2);
    const goal = (await f.store.read()).planningGoals![0];
    const input = await recordedRetroInput({ store: f.store, goal, runtime: f.runtime, post: vi.fn(), recordRun: vi.fn(), recordSession: vi.fn() });
    const snapshot = buildRetroSnapshot(input);
    expect(snapshot.phases.find((phase) => phase.phase === "release")!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: "release-merge-rounds", value: 2 }), expect.objectContaining({ evidenceId: "release-integration-conflicts", value: 0 }),
    ]));
    expect(JSON.stringify(await f.facts())).not.toContain("diagnostic");
    expect(await readFile(join(f.store.checkout, "state.json"), "utf8")).not.toContain("releaseFacts");
  });

  it("recovers an accepted merge with the original attempt ID and keeps earlier cutoffs incomplete", async () => {
    const f = await gateFixture();
    f.github.mode = "lost-response";
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("response lost");
    const pending = (await f.facts())!.events.filter((event) => event.kind === "merge-started");
    const cutoff = new Date().toISOString();
    expect((await f.totals()).merge).toBeNull();
    const restarted = f.makeBridge();
    await restarted.poll(); await restarted.poll();
    expect(f.github.mergeCalls).toBe(1);
    const recovered = (await f.facts())!;
    expect(recovered.events.filter((event) => event.kind === "merge-started")).toEqual(pending);
    expect(recovered.events.find((event) => event.kind === "merge-finished")).toMatchObject({ attemptId: pending[0].attemptId, result: "merged" });
    expect(releaseRounds(recovered, f.goal.id, prUrl, cutoff).merge).toBeNull();
    expect((await f.totals()).merge).toBe(1);
  });

  it("leaves a crash before dispatch unknown even after a later command succeeds", async () => {
    const f = await gateFixture();
    const interrupted = f.makeBridge(true, (adapter) => ({ releaseEvent: async (context, event) => {
      await adapter.releaseEvent!(context, event);
      if (event.kind === "merge-requested") throw new Error("Interrupted before command");
    } }));
    await expect(interrupted.merge(f.goal.id)).rejects.toThrow("Interrupted before command");
    const pending = (await f.facts())!.events.find((event) => event.kind === "merge-started")!;
    expect(f.github.mergeCalls).toBe(0);
    expect((await f.totals()).merge).toBeNull();
    await f.makeBridge().poll();
    expect(f.github.mergeCalls).toBe(1);
    expect((await f.facts())!.events.filter((event) => event.kind === "merge-started")).toHaveLength(2);
    expect((await f.facts())!.events).toContainEqual(pending);
    expect((await f.totals()).merge).toBeNull();
  });

  it("does not count CI polling or failed checks at the final merge boundary as commands", async () => {
    const f = await gateFixture();
    f.github.checksPass = () => false;
    await f.bridge.poll(); await f.bridge.poll();
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("CI is not green");
    f.github.checkCalls = 0;
    f.github.checksPass = (call) => call < 3; // Announcement and approval pass; SprintGitHub's final verification fails.
    await expect(f.bridge.merge(f.goal.id)).rejects.toThrow("Not merged");
    expect(f.github.mergeCalls).toBe(0);
    expect(await f.totals()).toEqual({ conflict: 0, merge: 0, missing: [] });
  });

  it("retains missing history when recording begins after opening, and never infers an unrecorded merge as zero", async () => {
    const legacy = await gateFixture(false);
    await legacy.makeBridge().poll();
    expect(await legacy.totals()).toMatchObject({ conflict: null, merge: null });
    const f = await gateFixture();
    f.github.merged = true;
    await f.bridge.merge(f.goal.id); await f.bridge.poll();
    expect(f.github.mergeCalls).toBe(0);
    expect((await f.totals()).merge).toBeNull();
  });

  it("does not resolve a conflict from unreadable observations and ignores other release gates", async () => {
    const f = await gateFixture();
    f.github.mergeable = "CONFLICTING"; await f.bridge.poll();
    f.github.observationFails = true; await f.bridge.poll();
    f.github.observationFails = false; await f.bridge.poll();
    expect((await f.totals()).conflict).toBe(1);
    const before = await f.facts();
    const release = createCeremonyAdapters({ store: f.store }, f.github).releaseEvent!;
    const context = { store: f.store, goal: f.goal, runtime: f.runtime, post: vi.fn(), recordRun: vi.fn(), recordSession: vi.fn() };
    for (const gate of ["retro", "revert"] as const) await release(context, { kind: "merge-requested", gate, key: `merge:${gate}`, at: new Date().toISOString(), prUrl, headSha });
    expect(await f.facts()).toEqual(before);
  });
});
