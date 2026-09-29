import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCeremonyAdapters } from "../src/auto-mode-adapter.js";
import { controlModules } from "../src/control-adapters.js";
import { approvalPolicy, readPolicyDocument } from "../src/auto-policy.js";
import { OwnerSettingsCommands, type OwnerScopeChoice } from "../src/owner-settings.js";
import { PlanningBridge, type CeremonyAdapters, type PlanningChat, type Post, type Reaction } from "../src/planning-bridge.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import { ceremonyReadiness, recordedRetroInput, RetroPublication, retroRuntimeName, type RetroPublicationRecord } from "../src/retro-publication.js";
import { draftSprintRetro, type RetroEvidenceSnapshot } from "../src/sprint-retro.js";
import { proposalDigest, validateCeremony } from "../src/ceremony.js";
import type { TeamRecord } from "../src/state-domain.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";
import type { Shell } from "../src/command-shell.js";
import type { MergeResult, RetroArchive, RetroPr, RetroReview } from "../src/sprint.js";
import { git, stateCheckout } from "./state-checkout.js";

vi.setConfig({ testTimeout: 30_000 });
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true })));
});
const head = "a".repeat(40);
const releaseSha = "b".repeat(40);
const archiveHead = "c".repeat(40);
const archiveMerge = "d".repeat(40);
const project = "test/project";
type Fault = "before" | "after" | "rejected";
class Chat implements PlanningChat {
  posts: (Post & { delete_at?: number })[] = []; marks: Reaction[] = [];
  hidden = new Set<string>();
  failAfter?: (post: Post) => boolean;
  async ownUserId() { return "chick"; }
  async isBot(id: string) { return ["chick", "developer", "product"].includes(id); }
  async post(channel: string, message: string, root = "", delivery?: string) {
    const post: Post = { id: `post-${this.posts.length + 1}`, user_id: "chick", channel_id: channel, root_id: root,
      message, create_at: Date.now(), props: { indra_delivery_id: delivery } };
    this.posts.push(post);
    if (this.failAfter?.(post)) throw new Error("Delivery response lost");
    return post;
  }
  async since(channel: string, at: number) { return this.posts.filter((post) => post.channel_id === channel && post.create_at >= at && !this.hidden.has(post.id)); }
  async reactions(id: string) { return this.marks.filter((mark) => mark.post_id === id); }
  react(postId: string, user = "human") { this.marks.push({ post_id: postId, user_id: user, emoji_name: "white_check_mark", create_at: Date.now() }); }
}
class Agent implements AgentRuntime {
  proposals = 0; retros = 0;
  async message(prompt: string, schema: string, session?: string): Promise<AgentResult> {
    const at = new Date().toISOString();
    let response: unknown = { reply: "Ready to plan", summary: "Reliable delivery", decisions: [], openQuestions: [] };
    if (schema.endsWith("proposal.json")) {
      this.proposals++;
      response = { summary: "Reliable delivery", outcomes: [{ title: "Retry", description: "Retry delivery in src/example.ts", seatId: "seat-dev" }], risks: [], openQuestions: [] };
    }
    if (schema.endsWith("retro.json")) {
      this.retros++;
      response = (JSON.parse(prompt.split("Recorded snapshot (JSON):\n")[1]) as RetroEvidenceSnapshot).choices;
    }
    return { sessionId: session ?? `session-${this.proposals}-${this.retros}`, startedAt: at, finishedAt: at, response };
  }
}
interface Integration {
  branch: string; url: string; head: string; reviewedHead: string; checks: { name: string; bucket: string }[];
  state: "OPEN" | "CLOSED" | "MERGED"; conflicting: boolean;
}
/** Only external systems are simulated: the bridge, policy store, inspectors and retro publisher are real. */
class Services implements Shell, RetroArchive {
  branches = new Set<string>();
  integrations: Integration[] = [];
  outcomes = new Map<string, string>();
  archives = new Map<string, RetroPr & { markdown: string }>();
  running = new Set<string>();
  commands: string[][] = [];
  integrationFault?: Fault; archiveFault?: Fault;
  archiveMerges = 0; publications = 0; reviewAllowed = true;
  async run(command: string, args: string[]) {
    expect(command).toBe("gh"); this.commands.push(args);
    const result = (stdout = "", code = 0) => ({ code, stdout, stderr: code ? "External operation failed" : "" });
    if (args[0] === "api" && args[1]?.includes("/git/ref/heads/")) {
      const branch = args[1].split("/heads/")[1];
      return result(head, branch === "main" || this.branches.has(branch) ? 0 : 1);
    }
    if (args[0] === "api" && args.includes("POST")) {
      this.branches.add(args.find((arg) => arg.startsWith("ref=refs/heads/"))!.slice("ref=refs/heads/".length));
      return result();
    }
    if (args[0] === "api" && args[1]?.includes("/reviews?")) {
      const pr = this.integrations.find((pr) => args[1].includes(`/pulls/${pr.url.split("/").at(-1)}/`))!;
      return result(JSON.stringify([[{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: pr.reviewedHead }]]));
    }
    if (args[0] === "pr" && args[1] === "list") return result(this.integrations.find((pr) => pr.branch === args[args.indexOf("--head") + 1] && pr.state === "OPEN")?.url);
    if (args[0] === "pr" && args[1] === "create") {
      const pr: Integration = { branch: args[args.indexOf("--head") + 1], url: `https://github.com/${project}/pull/${this.integrations.length + 100}`,
        head, reviewedHead: head, checks: [{ name: "checks", bucket: "pass" }], state: "OPEN", conflicting: false };
      this.integrations.push(pr); return result(pr.url);
    }
    const outcome = this.outcomes.get(args[2]);
    if (args[0] === "pr" && outcome) {
      if (args[1] === "view") return result(JSON.stringify({ state: "MERGED", baseRefName: outcome, mergeCommit: { oid: head }, reviewDecision: "APPROVED" }));
      if (args[1] === "checks") return result();
    }
    const pr = this.integrations.find((pr) => pr.url === args[2]);
    if (args[0] === "pr" && pr) {
      if (args[1] === "view") return result(JSON.stringify({ state: pr.state, mergeCommit: pr.state === "MERGED" ? { oid: releaseSha } : null,
        headRefName: pr.branch, baseRefName: "main", headRefOid: pr.head, isCrossRepository: false, isDraft: false,
        author: { login: "owner" }, mergeable: pr.conflicting ? "CONFLICTING" : "MERGEABLE" }));
      if (args[1] === "checks") return result(JSON.stringify(pr.checks));
      if (args[1] === "merge") {
        expect(args[args.indexOf("--match-head-commit") + 1]).toBe(pr.head);
        const fault = this.integrationFault; this.integrationFault = undefined;
        if (fault === "before") throw new Error("Integration interrupted before merge");
        if (fault === "rejected") return result("", 1);
        pr.state = "MERGED";
        if (fault === "after") throw new Error("Integration merge response lost");
        return result();
      }
    }
    throw new Error(`Unexpected external operation: ${args.slice(0, 2).join(" ")}`);
  }
  async ensureRetroPr(github: string, goalId: string, markdown: string) {
    expect(github).toBe(project);
    if (!this.archives.has(goalId)) {
      this.publications++;
      this.archives.set(goalId, { url: `https://github.com/${project}/pull/${this.archives.size + 200}`, state: "OPEN", headSha: archiveHead, reviewed: false, checksPassed: false, markdown });
    }
    expect(this.archives.get(goalId)!.markdown).toBe(markdown);
    return this.archives.get(goalId)!.url;
  }
  async inspectRetroPr(_github: string, goalId: string) { return structuredClone(this.archives.get(goalId)!); }
  async reviewRetroPr(_github: string, goalId: string, _markdown: string, _url: string, _head: string, review: (cwd: string) => Promise<RetroReview>) {
    const verdict = await review("/managed/review");
    this.archives.get(goalId)!.reviewed = this.reviewAllowed && verdict.findings.length === 0;
  }
  async mergeRetroPr(_github: string, goalId: string, _markdown: string, url: string, expectedHead: string, beforeMerge?: () => Promise<void>): Promise<MergeResult> {
    const pr = this.archives.get(goalId)!;
    expect(pr.url).toBe(url); expect(pr.headSha).toBe(expectedHead);
    expect(pr.reviewed && pr.checksPassed).toBe(true);
    await beforeMerge?.();
    this.archiveMerges++;
    const fault = this.archiveFault; this.archiveFault = undefined;
    if (fault === "before") throw new Error("Archive interrupted before merge");
    if (fault === "rejected") return { merged: false, reason: "Archive merge rejected" };
    pr.state = "MERGED"; pr.mergedSha = archiveMerge;
    if (fault === "after") throw new Error("Archive merge response lost");
    return { merged: true, sha: archiveMerge };
  }
}

async function fixture(nextSprint = false) {
  const checkout = await stateCheckout("indra-autonomy-e2e-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{
    id: "team-one", slug: "yahaha", displayName: "Yahaha", mission: "Make delivery dependable", project: { github: project },
    externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
    ],
  }] }); dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, ceremonyReadiness);
  const chat = new Chat(); const agent = new Agent(); const services = new Services(); const owner = new OwnerSettingsCommands(store);
  if (nextSprint) await store.update((state) => {
    const team = state.teams[0] as TeamRecord;
    const authors = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBySeatId: "seat-lead", updatedBySeatId: "seat-lead" };
    team.backlog = ["one", "two"].map((id) => ({ id: `ticket-${id}`, title: `Delivery ${id}`, description: `Acceptance ${id}`, value: `Reliable delivery ${id}`,
      status: "open", dependsOn: id === "two" ? ["ticket-one"] : [], ...authors }));
    team.sprintCandidates = ["one", "two"].map((id, rank) => ({ id: `candidate-${id}`, title: `Delivery sprint ${id}`, summary: `Implement ticket-${id}`,
      value: `Delivery value ${id}`, rank: rank + 1, ticketIds: [`ticket-${id}`], status: "candidate", ...authors }));
  }, "Groom upcoming delivery sprints");
  const hooks: CeremonyAdapters = {};
  const restart = async () => {
    let bridge: PlanningBridge;
    const next = controlModules["./next-sprint.ts"]?.createCeremonyAdapters;
    if (nextSprint) expect(next, "The next-sprint dependency must be installed before activation").toBeDefined();
    const adapters: CeremonyAdapters = {
    ...await createCeremonyAdapters({ chat }), ...hooks,
    ...(nextSprint ? await next!({ store, chat, runtime: agent, appDir: checkout, start: async (goal, participants) => bridge.start(goal, participants) }) : {}),
    release: { poll: async ({ goal, mergeApproval }) => !services.running.has(goal.id) ? { status: "pending", reason: "Merged release is not verified running" }
      : { status: "complete", evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: releaseSha,
        mergePostId: mergeApproval!.postId, approval: mergeApproval!.approval, checksPassed: true,
        buildSha: releaseSha, runningSha: releaseSha, runningAt: new Date().toISOString() } } },
    retro: new RetroPublication(services, async (context) => await draftSprintRetro(await recordedRetroInput(context), () => agent), {
      thread: async ({ goal }) => ({ ownUserId: await chat.ownUserId(), posts: await chat.since(goal.mattermost.channelId, Date.parse(goal.createdAt) - 5000) }),
      review: async () => ({ summary: "Reviewed", findings: [] }),
    }),
    };
    bridge = new PlanningBridge(store, chat, agent, 20, services, adapters);
    return bridge;
  };
  const poll = async () => (await restart()).poll();
  const current = async (id: string) => (await store.read()).planningGoals!.find((goal) => goal.id === id)!;
  const enable = async (scope: OwnerScopeChoice = { kind: "mission" }) => { await owner.chooseScope("team-one", scope); await owner.enable("team-one"); };
  const propose = async () => {
    const goal = await (await restart()).start("Reliable delivery");
    await PlanningBridge.requestProposal(store, goal.id); await poll();
    return await current(goal.id);
  };
  const implement = async (id: string) => {
    const goal = await current(id); const url = `https://github.com/${project}/pull/${services.outcomes.size + 1}`;
    services.outcomes.set(url, goal.integration!.branch);
    await store.update((state) => { Object.assign(state.planningGoals!.find((item) => item.id === id)!.assignments![0], { status: "merged", prUrl: url }); }, "Seat merges implementation into sprint");
  };
  const atRetro = async () => {
    const goal = await propose(); await enable(); await poll(); await implement(goal.id); await poll();
    services.running.add(goal.id); await poll();
    expect((await current(goal.id)).ceremony?.stage).toBe("retro");
    return goal.id;
  };
  return { checkout, store, chat, agent, services, owner, hooks, restart, poll, current, enable, propose, implement, atRetro };
}

describe("automatic progression through the shared ceremony gates", () => {
  it("completes two consecutive sprint cycles and approves the next backlog proposal without duplicate actions", async () => {
    const f = await fixture(true); const first = await f.propose(); await f.enable(); await f.poll();
    let id = first.id;
    const closed: PlanningGoal[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      expect((await f.current(id)).ceremony?.stage).toBe("implement");
      await f.implement(id); await f.poll(); await f.poll();
      expect((await f.current(id)).ceremony?.stage).toBe("release");
      expect(f.services.archives.has(id)).toBe(false);
      f.services.running.add(id); await f.poll();
      expect((await f.current(id)).ceremony?.closure).toBeUndefined();
      f.services.archives.get(id)!.checksPassed = true; await f.poll(); await f.poll();
      const completed = await f.current(id); validateCeremony(completed); closed.push(completed);
      expect(completed.ceremony?.closure?.evidence).toMatchObject({ kind: "retro-published", authorization: { approval: { source: "automatic" } } });
      expect(completed.automaticApprovals?.map((approval) => approval.target.kind)).toEqual(["proposal", "integration", "retro"]);
      expect(completed.automaticApprovals![0].target).toEqual({ kind: "proposal", goalId: id, proposalId: completed.proposal!.id, proposalDigest: proposalDigest(completed.proposal!) });
      const state = await f.store.read();
      if (cycle === 1) {
        const team = state.teams[0] as TeamRecord;
        expect(team.backlog?.find((ticket) => ticket.id === "ticket-one")?.status).toBe("done");
        expect(team.sprintCandidates?.find((candidate) => candidate.id === "candidate-one")?.status).toBe("completed");
      }
      const next = state.planningGoals!.find((goal) => !goal.ceremony?.closure)!;
      expect(next, "Verified closure must unlock the next eligible backlog sprint").toBeDefined();
      expect(next.source).toEqual({ candidateId: `candidate-${cycle ? "two" : "one"}`, ticketIds: [`ticket-${cycle ? "two" : "one"}`], retrospectiveGoalId: id });
      expect(next.stage).toBe("approved"); expect(next.automaticApprovals).toHaveLength(1);
      expect(f.chat.posts.find((post) => post.props?.indra_delivery_id === `proposal:${next.proposal!.id}`)?.message).toContain(`docs/retros/${id}.md`);
      id = next.id;
    }
    await f.poll(); await f.poll();
    const state = await f.store.read(); const document = await readPolicyDocument(f.store.checkout);
    const team = state.teams[0] as TeamRecord;
    for (const goal of closed) for (const approval of goal.automaticApprovals!) {
      expect(approvalPolicy(document, team, approval.policyRevision)).toMatchObject({ policyId: document.policies[0].id, scope: { kind: "mission", mission: team.mission } });
    }
    expect(state.planningGoals).toHaveLength(3);
    expect(f.services.commands.filter((args) => args[1] === "merge")).toHaveLength(2);
    expect(f.services.branches.size).toBe(3);
    expect(f.services.publications).toBe(2); expect(f.services.archiveMerges).toBe(2);
    expect(f.agent.proposals).toBe(3); expect(f.agent.retros).toBe(2);
    expect(f.chat.posts.filter((post) => post.message.startsWith("# Sprint retrospective"))).toHaveLength(2);
    expect(git(f.checkout, "status", "--porcelain", "--", "state.json", "autonomy.json")).toBe("");
    expect(JSON.stringify(state)).not.toContain("session-");
  });

  it.each(["off", "named problem"])("leaves the next proposed sprint at its human gate when the policy is %s", async (policy) => {
    const f = await fixture(true); const first = await f.propose();
    await f.enable(policy === "named problem" ? { kind: "problem", goalId: first.id } : { kind: "mission" });
    await f.poll(); await f.implement(first.id); await f.poll(); f.services.running.add(first.id); await f.poll();
    if (policy === "off") f.hooks.releaseEvent = async (_context, event) => { if (event.kind === "closed") await f.owner.disable("team-one"); };
    f.services.archives.get(first.id)!.checksPassed = true;
    await f.poll(); await f.poll(); await f.poll();
    const goals = (await f.store.read()).planningGoals!;
    expect(goals).toHaveLength(2); expect(goals[0].ceremony?.closure).toBeDefined();
    const next = goals[1];
    expect(next.stage).toBe("awaiting-review"); expect(next.automaticApprovals).toBeUndefined(); expect(next.assignments).toBeUndefined();
    expect(f.services.branches.size).toBe(1);
    await (await f.restart()).approve(next.id);
    expect((await f.current(next.id)).ceremony?.history[2]).toMatchObject({ evidence: { kind: "approval", approval: { source: "owner-command" } } });
  });

  it("keeps all three gates human-only by default and preserves human provenance", async () => {
    const f = await fixture(); const goal = await f.propose(); await f.poll();
    expect((await f.current(goal.id)).assignments).toBeUndefined();
    await (await f.restart()).approve(goal.id); await f.implement(goal.id); await f.poll();
    expect((await f.current(goal.id)).integration?.status).toBe("pr-open");
    await (await f.restart()).merge(goal.id); f.services.running.add(goal.id); await f.poll();
    const pr = f.services.archives.get(goal.id)!; pr.checksPassed = true;
    await f.poll(); expect(pr.state).toBe("OPEN");
    await (await f.restart()).merge(goal.id); await f.poll();
    const saved = await f.current(goal.id);
    expect(saved.automaticApprovals).toBeUndefined();
    expect(saved.ceremony!.closure?.evidence).toMatchObject({ kind: "retro-published", authorization: { approval: { source: "owner-command" } } });
    expect(saved.ceremony!.history[2]).toMatchObject({ evidence: { kind: "approval", approval: { source: "owner-command" } } });
  });

  it.each(["proposal", "integration", "retro"] as const)("disabling before the %s gate preserves earlier work and waits for a human", async (gate) => {
    const f = await fixture(); const goal = await f.propose(); await f.enable();
    if (gate !== "proposal") { await f.poll(); await f.implement(goal.id); }
    if (gate === "retro") { await f.poll(); f.services.running.add(goal.id); await f.poll(); f.services.archives.get(goal.id)!.checksPassed = true; }
    const before = await f.current(goal.id);
    await f.owner.disable("team-one"); await f.poll(); await f.poll();
    const saved = await f.current(goal.id);
    expect(saved.automaticApprovals).toEqual(before.automaticApprovals);
    if (gate === "proposal") {
      expect(saved.assignments).toBeUndefined(); await (await f.restart()).approve(goal.id);
      expect((await f.current(goal.id)).stage).toBe("approved");
    } else {
      if (gate === "integration") expect(saved.integration?.status).toBe("pr-open");
      else expect(saved.ceremony?.closure).toBeUndefined();
      await (await f.restart()).merge(goal.id); await f.poll();
      if (gate === "integration") expect((await f.current(goal.id)).integration?.status).toBe("merged");
      else expect((await f.current(goal.id)).ceremony?.closure).toBeDefined();
    }
  });

  it.each(["stale review", "red CI", "unknown CI", "conflict", "closed"])("blocks integration with %s and reevaluates its current head on retry", async (problem) => {
    const f = await fixture(); const goal = await f.propose();
    await (await f.restart()).approve(goal.id); await f.implement(goal.id); await f.poll(); await f.enable();
    const pr = f.services.integrations[0];
    if (problem === "stale review") pr.head = "e".repeat(40);
    if (problem === "red CI") pr.checks[0].bucket = "fail";
    if (problem === "unknown CI") pr.checks = [];
    if (problem === "conflict") pr.conflicting = true;
    if (problem === "closed") pr.state = "CLOSED";
    await f.poll(); expect((await f.current(goal.id)).integration?.status).toBe("pr-open");
    expect((await f.current(goal.id)).automaticApprovals).toBeUndefined();
    expect(f.services.commands.filter((args) => args[1] === "merge")).toHaveLength(0);
    pr.reviewedHead = pr.head; pr.checks = [{ name: "checks", bucket: "pass" }]; pr.conflicting = false; pr.state = "OPEN";
    await f.poll();
    expect((await f.current(goal.id)).automaticApprovals?.[0].target).toMatchObject({ kind: "integration", headSha: pr.head, reviewedHeadSha: pr.head });
    expect((await f.current(goal.id)).integration?.status).toBe("merged");
  });

  it("waits for the merged release to run and for archive review, CI and verified delivery", async () => {
    const f = await fixture(); const goal = await f.propose(); await f.enable(); await f.poll(); await f.implement(goal.id); await f.poll();
    await f.poll(); await f.poll();
    expect((await f.current(goal.id)).ceremony?.stage).toBe("release");
    expect(await f.store.readRuntimeFile(goal.id)).toMatchObject({ waiting: { reason: "Merged release is not verified running" } });
    expect(f.agent.retros).toBe(0); expect(f.services.archives.size).toBe(0);
    f.services.running.add(goal.id); f.services.reviewAllowed = false; await f.poll();
    const pr = f.services.archives.get(goal.id)!; pr.checksPassed = true;
    await f.poll(); expect(f.services.archiveMerges).toBe(0);
    f.services.reviewAllowed = true; pr.checksPassed = false; await f.poll();
    expect(pr.reviewed).toBe(true); expect(f.services.archiveMerges).toBe(0);
    pr.checksPassed = true;
    const record = (await f.store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(goal.id)))!;
    f.chat.hidden.add(record.postIds![0]); await f.poll();
    expect((await f.current(goal.id)).ceremony?.closure).toBeUndefined();
    expect((await f.current(goal.id)).automaticApprovals).toHaveLength(2);
    expect(f.services.archiveMerges).toBe(0);
    expect(await f.store.readRuntimeFile(goal.id)).toMatchObject({ waiting: { stage: "retro", reason: expect.stringContaining("verification is pending") } });
    f.chat.hidden.clear(); await f.poll();
    expect((await f.current(goal.id)).ceremony?.closure).toBeDefined();
    expect(f.services.archiveMerges).toBe(1);
  });

  it("keeps a closed-unmerged archive pending across restarts", async () => {
    const f = await fixture(); const id = await f.atRetro();
    const pr = f.services.archives.get(id)!; pr.checksPassed = true; pr.state = "CLOSED";
    await f.poll(); await f.poll();
    expect((await f.current(id)).automaticApprovals).toHaveLength(2);
    expect((await f.current(id)).ceremony?.closure).toBeUndefined();
    expect(await f.store.readRuntimeFile(id)).toMatchObject({ waiting: { reason: expect.stringContaining("closed without merging") } });
    expect(f.services.archiveMerges).toBe(0); expect(f.services.publications).toBe(1);
    await expect((await f.restart()).start("Too early")).rejects.toThrow("open goal");
  });

  it.each(["integration", "retro"] as const)("rechecks revocation immediately before executing the %s merge", async (gate) => {
    const f = await fixture(); const goal = await f.propose(); await f.enable(); await f.poll(); await f.implement(goal.id);
    if (gate === "retro") { await f.poll(); f.services.running.add(goal.id); await f.poll(); f.services.archives.get(goal.id)!.checksPassed = true; }
    f.hooks.releaseEvent = async (_context, event) => { if (event.kind === "merge-requested" && event.gate === gate) await f.owner.disable("team-one"); };
    if (gate === "integration") await expect(f.poll()).rejects.toThrow("current enabled policy");
    else await f.poll();
    const history = (await f.current(goal.id)).automaticApprovals!;
    expect(history.at(-1)?.target.kind).toBe(gate);
    expect(gate === "integration" ? f.services.integrations[0].state : f.services.archives.get(goal.id)!.state).toBe("OPEN");
    delete f.hooks.releaseEvent;
    await f.poll();
    expect((await f.current(goal.id)).automaticApprovals).toEqual(history);
    await f.owner.enable("team-one"); await f.poll();
    expect((await f.current(goal.id)).automaticApprovals!.at(-1)).toMatchObject({ policyRevision: 3, target: { kind: gate } });
    expect(gate === "integration" ? f.services.integrations[0].state : f.services.archives.get(goal.id)!.state).toBe("MERGED");
  });

  it.each(["before", "after", "rejected"] as const)("recovers an integration merge interrupted %s acceptance without duplicate authorization", async (fault) => {
    const f = await fixture(); const goal = await f.propose(); await f.enable(); await f.poll(); await f.implement(goal.id);
    f.services.integrationFault = fault;
    if (fault === "rejected") await f.poll(); else await expect(f.poll()).rejects.toThrow();
    expect((await f.current(goal.id)).integration?.status).toBe("pr-open");
    if (fault === "rejected") expect(f.chat.posts.at(-1)?.message).toContain("Not merged");
    const approvals = (await f.current(goal.id)).automaticApprovals;
    if (fault === "after") await f.owner.disable("team-one");
    await f.poll(); await f.poll();
    expect((await f.current(goal.id)).integration?.status).toBe("merged");
    expect((await f.current(goal.id)).automaticApprovals).toEqual(approvals);
    expect(f.services.commands.filter((args) => args[1] === "merge")).toHaveLength(fault === "after" ? 1 : 2);
    expect(await f.store.readRuntimeFile(goal.id)).not.toHaveProperty("mergeIntent");
  });

  it.each(["integration", "retro"] as const)("requires a fresh review and authorization when a pending %s head changes", async (gate) => {
    const f = await fixture(); const goal = await f.propose(); await f.enable(); await f.poll(); await f.implement(goal.id);
    if (gate === "integration") {
      f.services.integrationFault = "before";
      await expect(f.poll()).rejects.toThrow();
      f.services.integrations[0].head = "e".repeat(40);
    } else {
      await f.poll(); f.services.running.add(goal.id); await f.poll();
      f.services.archives.get(goal.id)!.checksPassed = true;
      f.services.archiveFault = "before"; await f.poll();
      Object.assign(f.services.archives.get(goal.id)!, { headSha: "e".repeat(40), reviewed: false });
      f.services.reviewAllowed = false;
    }
    const approvals = (await f.current(goal.id)).automaticApprovals!;
    await f.poll();
    expect((await f.current(goal.id)).automaticApprovals).toEqual(approvals);
    expect(gate === "integration" ? f.services.integrations[0].state : f.services.archives.get(goal.id)!.state).toBe("OPEN");
    f.services.integrations[0].reviewedHead = "e".repeat(40); f.services.reviewAllowed = true;
    await f.poll();
    const saved = await f.current(goal.id);
    expect(saved.automaticApprovals).toHaveLength(approvals.length + 1);
    expect(saved.automaticApprovals!.at(-1)?.target).toMatchObject({ kind: gate, headSha: "e".repeat(40), reviewedHeadSha: "e".repeat(40) });
    expect(gate === "integration" ? f.services.integrations[0].state : f.services.archives.get(goal.id)!.state).toBe("MERGED");
  });

  it("recovers accepted proposal and retro posts after lost delivery responses without redrafting or approving early", async () => {
    const f = await fixture(); await f.enable();
    const goal = await (await f.restart()).start("Reliable delivery");
    await PlanningBridge.requestProposal(f.store, goal.id);
    f.chat.failAfter = (post) => post.message.startsWith("**Draft proposal");
    await expect(f.poll()).rejects.toThrow("Delivery response lost");
    expect((await f.current(goal.id)).automaticApprovals).toBeUndefined();
    expect(f.services.branches.size).toBe(0);
    f.chat.failAfter = undefined; await f.poll(); await f.poll();
    expect(f.agent.proposals).toBe(1); expect(f.services.branches.size).toBe(1);
    expect(f.chat.posts.filter((post) => post.message.startsWith("**Draft proposal"))).toHaveLength(1);
    await f.implement(goal.id); await f.poll(); f.services.running.add(goal.id);
    f.chat.failAfter = (post) => post.message.startsWith("# Sprint retrospective");
    await f.poll();
    expect(f.services.publications).toBe(0); expect((await f.current(goal.id)).ceremony?.closure).toBeUndefined();
    f.chat.failAfter = undefined; await f.poll(); f.services.archives.get(goal.id)!.checksPassed = true; await f.poll(); await f.poll();
    expect((await f.current(goal.id)).automaticApprovals).toHaveLength(3);
    expect((await f.current(goal.id)).ceremony?.closure).toBeDefined();
    expect(f.chat.posts.filter((post) => post.message.startsWith("# Sprint retrospective"))).toHaveLength(1);
    expect(f.agent.retros).toBe(1); expect(f.services.archiveMerges).toBe(1);
  });

  it.each(["before", "after", "rejected"] as const)("recovers an archive merge interrupted %s acceptance without duplicate authorization or publication", async (fault) => {
    const f = await fixture(); const id = await f.atRetro(); f.services.archives.get(id)!.checksPassed = true; f.services.archiveFault = fault;
    await f.poll();
    const approvals = (await f.current(id)).automaticApprovals;
    expect(approvals).toHaveLength(3); expect((await f.current(id)).ceremony?.closure).toBeUndefined();
    expect(await f.store.readRuntimeFile(id)).toMatchObject({ waiting: { reason: expect.stringContaining("verification is pending") } });
    if (fault === "after") await f.owner.disable("team-one");
    await f.poll(); await f.poll();
    expect((await f.current(id)).ceremony?.closure).toBeDefined();
    expect((await f.current(id)).automaticApprovals).toEqual(approvals);
    expect(f.services.archiveMerges).toBe(fault === "after" ? 1 : 2);
    expect(f.services.publications).toBe(1); expect(f.agent.retros).toBe(1);
  });
});
