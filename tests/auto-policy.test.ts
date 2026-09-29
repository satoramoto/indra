import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPolicy, evaluateAutoPolicy, evaluateAutomaticGate, readPolicyDocument } from "../src/auto-policy.js";
import { OwnerSettingsCommands, type OwnerScopeChoice } from "../src/owner-settings.js";
import { PlanningBridge, assertCurrentAutomaticApproval, type AutomaticGateRequest, type CeremonyAdapters, type PlanningChat, type Post } from "../src/planning-bridge.js";
import { proposalDigest } from "../src/ceremony.js";
import { PlanningStore } from "../src/planning.js";
import type { TeamRecord } from "../src/state-domain.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";
import type { Shell } from "../src/command-shell.js";
import { stateCheckout } from "./state-checkout.js";

vi.setConfig({ testTimeout: 30_000 });
const head = "a".repeat(40); const merged = "b".repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).flatMap((dir) => [rm(dir, { recursive: true, force: true }), rm(`${dir}.runtime`, { recursive: true, force: true })]));
});
class Chat implements PlanningChat {
  posts: Post[] = [];
  async ownUserId() { return "chick"; }
  async isBot(id: string) { return id === "chick"; }
  async post(channel: string, message: string, root = "", delivery?: string) {
    const post: Post = { id: `post-${this.posts.length + 1}`, channel_id: channel, user_id: "chick", root_id: root, message, create_at: Date.now(), props: { indra_delivery_id: delivery } };
    this.posts.push(post); return post;
  }
  async since(channel: string, at: number) { return this.posts.filter((post) => post.channel_id === channel && post.create_at >= at); }
  async reactions() { return []; }
}
class Runtime implements AgentRuntime {
  async message(_prompt: string, schema: string, session?: string): Promise<AgentResult> {
    const at = new Date().toISOString();
    return { sessionId: session ?? "session-test", startedAt: at, finishedAt: at, response: schema.endsWith("proposal.json")
      ? { summary: "Proposal", outcomes: [{ title: "Build", description: "Implement delivery retries", seatId: "seat-dev" }], risks: [], openQuestions: [] }
      : { reply: "Ready to plan", summary: "Delivery retries", decisions: [], openQuestions: [] } };
  }
}
class GitHub implements Shell {
  calls: string[] = []; merged = false; open = false; branch = ""; reviewedHead = head; checks = [{ name: "checks", bucket: "pass" }];
  async run(command: string, args: string[]) {
    this.calls.push(`${command} ${args.join(" ")}`); let stdout = "";
    if (args[0] === "api") { stdout = head; this.branch = args[1].split("heads/")[1] ?? this.branch; }
    if (args[0] === "pr" && args[1] === "list") stdout = this.open && !this.merged ? "https://github.com/test/project/pull/1" : "";
    if (args[0] === "pr" && args[1] === "create") { this.open = true; stdout = "https://github.com/test/project/pull/1"; }
    if (args[0] === "pr" && args[1] === "merge") this.merged = true;
    if (args[0] === "pr" && args[1] === "view") stdout = JSON.stringify({ state: this.merged ? "MERGED" : "OPEN", mergeCommit: this.merged ? { oid: merged } : null,
      headRefName: this.branch, baseRefName: "main", headRefOid: head, isCrossRepository: false, isDraft: false, author: { login: "owner" } });
    if (args[0] === "api" && args[1].includes("/reviews?")) stdout = JSON.stringify([[{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: this.reviewedHead }]]);
    if (args[0] === "pr" && args[1] === "checks") stdout = JSON.stringify(this.checks);
    if (args.some((arg) => arg.startsWith("state,baseRefName,mergeCommit,reviewDecision"))) stdout = JSON.stringify({ state: "MERGED", baseRefName: this.branch, mergeCommit: { oid: head }, reviewDecision: "APPROVED" });
    return { code: 0, stdout, stderr: "" };
  }
}
async function fixture(adapters: CeremonyAdapters = {}) {
  const checkout = await stateCheckout("indra-auto-policy-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{
    id: "team-one", slug: "yahaha", displayName: "One", mission: "Make software delivery dependable", project: { github: "test/project" },
    externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
    ],
  }] }); dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } });
  const commands = new OwnerSettingsCommands(store); const github = new GitHub();
  const bridge = new PlanningBridge(store, new Chat(), new Runtime(), 20, github,
    { automaticGate: ({ store, goal }, request) => evaluateAutomaticGate(store, goal.id, request), ...adapters });
  const goal = await bridge.start("Reduce failed deliveries");
  await PlanningBridge.requestProposal(store, goal.id); await bridge.poll();
  const current = async () => (await store.read()).planningGoals![0];
  const request = async (): Promise<AutomaticGateRequest> => {
    const proposal = (await current()).proposal!;
    return { kind: "proposal", proposalId: proposal.id, proposalDigest: proposalDigest(proposal), postId: (await store.runtime(goal.id)).proposalPostIds![0] };
  };
  const enable = async (scope: OwnerScopeChoice = { kind: "mission" }) => { await commands.chooseScope("team-one", scope); await commands.enable("team-one"); };
  const implement = async () => {
    await bridge.approve(goal.id);
    await store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "merged", prUrl: "https://github.com/test/project/pull/11" }); }, "Merge reviewed implementation");
    await bridge.poll();
  };
  return { store, commands, github, bridge, goal, current, request, enable, implement };
}

describe("standing policy evaluation", () => {
  it("keeps approval human by default, including a legacy unscoped enabled setting", async () => {
    const f = await fixture();
    await f.bridge.poll();
    expect((await f.current()).stage).toBe("awaiting-review");
    await f.store.updateOwnerSettings("team-one", { autoMode: true });
    expect(await evaluateAutomaticGate(f.store, f.goal.id, await f.request())).toBeUndefined();
    await f.bridge.poll();
    expect((await f.current()).automaticApprovals).toBeUndefined();
    await f.bridge.approve(f.goal.id);
    expect((await f.current()).ceremony?.history.at(-1)).toMatchObject({ evidence: { kind: "approval", approval: { source: "owner-command" } } });
  });

  it.each(["mission", "problem"] as const)("matches explicit %s scope and rejects changed or cross-team problems", async (kind) => {
    const f = await fixture(); await f.enable(kind === "mission" ? { kind } : { kind, goalId: f.goal.id });
    const state = await f.store.read(); const document = await readPolicyDocument(f.store.checkout); const request = await f.request();
    expect(evaluateAutoPolicy(state, document, f.goal.id, request).allowed).toBe(true);
    const changed = structuredClone(state);
    if (kind === "mission") (changed.teams[0] as TeamRecord).mission = "A different mission";
    else changed.planningGoals![0].id = "goal-other";
    expect(evaluateAutoPolicy(changed, document, changed.planningGoals![0].id, request).allowed).toBe(false);
    const other = structuredClone(state); other.planningGoals![0].teamId = "team-other";
    expect(evaluateAutoPolicy(other, document, f.goal.id, request).allowed).toBe(false);
    if (kind === "problem") {
      const renamed = structuredClone(state); renamed.planningGoals![0].goal = "A clearer label for the same problem";
      expect(evaluateAutoPolicy(renamed, document, f.goal.id, request).allowed).toBe(true);
    }
  });

  it("requires the exact delivered proposal and rejects unanswered questions or unsupported gates", async () => {
    const f = await fixture(); await f.enable();
    const state = await f.store.read(); const document = await readPolicyDocument(f.store.checkout); const request = await f.request();
    expect(evaluateAutoPolicy(state, document, f.goal.id, { ...request, postId: f.goal.mattermost.rootPostId }).allowed).toBe(false);
    expect(evaluateAutoPolicy(state, document, f.goal.id, { ...request, kind: "revert" } as never).allowed).toBe(false);
    state.planningGoals![0].proposal!.summary = "Changed proposal";
    expect(evaluateAutoPolicy(state, document, f.goal.id, request).allowed).toBe(false);
    state.planningGoals![0].proposal!.openQuestions.push("Which result?");
    const changed = { ...request, proposalDigest: proposalDigest(state.planningGoals![0].proposal!) };
    expect(evaluateAutoPolicy(state, document, f.goal.id, changed).allowed).toBe(false);
  });

  it("records attributable automatic provenance through the real bridge and preserves authorized work on disable", async () => {
    const f = await fixture(); await f.enable(); await f.bridge.poll();
    const before = await f.current();
    expect(before.stage).toBe("approved"); expect(before.automaticApprovals).toHaveLength(1);
    const approval = before.automaticApprovals![0];
    expect(approval).toMatchObject({ source: "automatic", policyRevision: 1, target: { kind: "proposal", goalId: f.goal.id, proposalId: before.proposal!.id, proposalDigest: proposalDigest(before.proposal!) } });
    expect(before.ceremony?.history.at(-1)).toMatchObject({ evidence: { kind: "automatic-approval", approval } });
    const document = await readPolicyDocument(f.store.checkout);
    const policy = approvalPolicy(document, (await f.store.read()).teams[0] as TeamRecord, approval.policyRevision);
    expect(policy).toMatchObject({ policyId: document.policies[0].id, scope: document.policies[0].scope, source: "owner-command" });
    await f.commands.disable("team-one");
    const after = await f.current();
    expect(after.assignments).toEqual(before.assignments);
    expect(after.automaticApprovals).toEqual(before.automaticApprovals);
    expect(after.ceremony).toEqual(before.ceremony);
    expect(approvalPolicy(await readPolicyDocument(f.store.checkout), (await f.store.read()).teams[0] as TeamRecord, approval.policyRevision)).toEqual(policy);
  });

  it.each(["disable", "scope"] as const)("rechecks a %s change after evaluation but before approval", async (change) => {
    const f = await fixture({ automaticGate: async ({ store, goal }, request) => {
      const approval = await evaluateAutomaticGate(store, goal.id, request);
      const commands = new OwnerSettingsCommands(store);
      if (change === "disable") await commands.disable(goal.teamId);
      else await commands.chooseScope(goal.teamId, { kind: "problem", goalId: goal.id });
      return approval;
    } });
    await f.enable();
    await expect(f.bridge.poll()).rejects.toThrow("current enabled policy");
    expect((await f.current()).stage).toBe("awaiting-review");
    expect((await f.current()).automaticApprovals).toBeUndefined();
  });

  it("invalidates a cached decision after off/on and issues a new revision", async () => {
    const f = await fixture(); await f.enable();
    const old = (await evaluateAutomaticGate(f.store, f.goal.id, await f.request()))!;
    await f.commands.disable("team-one"); await f.commands.enable("team-one");
    const state = await f.store.read();
    expect(() => assertCurrentAutomaticApproval(state, state.planningGoals![0], old)).toThrow("current enabled policy");
    expect(await evaluateAutomaticGate(f.store, f.goal.id, await f.request())).toMatchObject({ policyRevision: 3, source: "automatic" });
  });

  it("waits for review and CI, refuses partial integration, and merges through the checked gate", async () => {
    const f = await fixture(); await f.implement(); await f.enable();
    f.github.checks = []; await f.bridge.poll(); expect(f.github.merged).toBe(false);
    f.github.checks = [{ name: "checks", bucket: "pass" }]; f.github.reviewedHead = "c".repeat(40);
    await f.bridge.poll(); expect(f.github.merged).toBe(false);
    f.github.reviewedHead = head;
    const state = await f.store.read(); const goal = state.planningGoals![0]; const document = await readPolicyDocument(f.store.checkout);
    const request: AutomaticGateRequest = { kind: "integration", postId: "merge-post", pr: { url: goal.integration!.prUrl!, state: "OPEN", headSha: head, reviewed: true, checksPassed: true } };
    expect(evaluateAutoPolicy(state, document, goal.id, request).allowed).toBe(true);
    const release = goal.ceremony!.history.find((entry) => entry.stage === "release")!;
    if (release.stage !== "release" || release.evidence.kind !== "implementation") throw new Error("Missing implementation proof");
    release.evidence.partialApproval = { source: "owner-command", command: "planning integrate", at: new Date().toISOString() };
    expect(evaluateAutoPolicy(state, document, goal.id, request).allowed).toBe(false);
    await f.bridge.poll();
    expect(f.github.merged).toBe(true);
    expect((await f.current()).automaticApprovals?.[0]).toMatchObject({ source: "automatic", target: { kind: "integration", headSha: head, reviewedHeadSha: head, reviewer: "satori-miyamoto" } });
    expect(f.github.calls.find((line) => line.includes("pr merge"))).toContain(`--match-head-commit ${head}`);
  });

  it("rechecks just before an external merge without erasing the recorded authorization", async () => {
    const f = await fixture({ releaseEvent: async ({ store, goal }, event) => {
      if (event.kind === "merge-requested") await new OwnerSettingsCommands(store).disable(goal.teamId);
    } });
    await f.implement(); await f.enable();
    await expect(f.bridge.poll()).rejects.toThrow("current enabled policy");
    expect(f.github.merged).toBe(false);
    expect((await f.current()).automaticApprovals).toHaveLength(1);
    expect(f.github.calls.some((line) => line.includes("pr merge"))).toBe(false);
  });

  it("requires a verified running release before retro authorization", async () => {
    let running = false;
    const f = await fixture({ release: { poll: async ({ goal, mergeApproval }) => running ? { status: "complete", evidence: {
      kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: merged, mergePostId: mergeApproval!.postId, approval: mergeApproval!.approval,
      checksPassed: true, buildSha: merged, runningSha: merged, runningAt: new Date().toISOString(),
    } } : { status: "pending", reason: "Build has not started" } } });
    await f.implement(); await f.enable(); await f.bridge.poll();
    const request: AutomaticGateRequest = { kind: "retro", postId: "retro-post", pr: { url: "https://github.com/test/project/pull/2", state: "OPEN", headSha: head, reviewed: true, checksPassed: true } };
    expect(await evaluateAutomaticGate(f.store, f.goal.id, request)).toBeUndefined();
    running = true; await f.bridge.poll();
    expect(await evaluateAutomaticGate(f.store, f.goal.id, request)).toMatchObject({ source: "automatic", target: { kind: "retro", prUrl: request.pr.url } });
  });
});
