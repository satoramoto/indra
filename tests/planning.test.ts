import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homeChannelId, PlanningStore, teamProject, validateOutcomeSeats, validatePlanningGoal, type PlanningGoal } from "../src/planning.js";
import { git, stateCheckout } from "./state-checkout.js";
import { PlanningBridge as Bridge, type CeremonyAdapters, type PlanningChat, type Post, type Reaction } from "../src/planning-bridge.js";
import type { Shell, ShellResult } from "../src/developer-seat.js";
import { MattermostPlanningChat } from "../src/planning-mattermost.js";
import { parseOptions } from "../src/cli.js";
import type { AgentRuntime, AgentResult } from "../src/codex-runtime.js";
import { CLARIFY_TIMEOUT_MS, DEVELOPER_SESSION_TIMEOUT_MS, DRAFT_TIMEOUT_MS } from "../src/codex-runtime.js";

import { advanceCeremony } from "../src/ceremony.js";
import { goalRuntimeFilename, productRuntimeFilename, teamRuntimeFilename, validateProductProposal, type GoalReport, type GoalRuntimeRecord, type ProductRuntimeRecord, type SchedulerRuntimeRecord } from "../src/goal-contract.js";
import { runWorkflowHost, WorkflowInbox, workflowDigest } from "../src/remodel-events.js";
import { SprintGitHub } from "../src/sprint.js";

afterEach(() => vi.restoreAllMocks());

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
const MAIN_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
/** A fake gh and git: one GitHub repository with branches and PRs, keyed by head branch. */
class FakeGh implements Shell {
  calls: string[] = [];
  branches = new Set<string>();
  prs = new Map<string, { url: string; state: string; sha?: string }>();
  checksCode = 0;
  reviewed = false;
  failBranch = false;
  private next = 100;
  async run(command: string, args: string[], _cwd: string): Promise<ShellResult> {
    const line = `${command} ${args.join(" ")}`;
    const repositoryLine = line.replace(/repos\/satoramoto\/indra\//i, "repos/satoramoto/indra/");
    this.calls.push(line);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const byUrl = () => [...this.prs.values()].find((pr) => pr.url === args[2]);
    if (line.startsWith("gh repo clone")) { await mkdir(join(args[3], ".git"), { recursive: true }); return ok(); }
    if (repositoryLine === "gh api repos/satoramoto/indra/git/ref/heads/main --jq .object.sha") return this.failBranch ? { code: 1, stdout: "", stderr: "HTTP 502" } : ok(`${MAIN_SHA}\n`);
    if (repositoryLine.startsWith("gh api repos/satoramoto/indra/git/ref/heads/")) { const branch = args[1].split("/heads/")[1]; return this.branches.has(branch) ? ok(`${MAIN_SHA}\n`) : { code: 1, stdout: "", stderr: "HTTP 404" }; }
    if (repositoryLine.startsWith("gh api -X POST repos/satoramoto/indra/git/refs")) { this.branches.add(flag("-f").replace("ref=refs/heads/", "")); return ok(); }
    if (args[0] === "api" && args.includes("--method") && !args.includes("--paginate")) {
      const endpoint = args[1]; const owners = "* @satori-miyamoto\n";
      if (/\/pulls\/\d+$/.test(endpoint)) return ok(JSON.stringify({ state: "open", draft: false, auto_merge: null, head: { sha: MAIN_SHA }, base: { ref: "main", sha: MAIN_SHA, repo: { full_name: "satoramoto/indra" } } }));
      if (endpoint.endsWith("/protection")) return ok(JSON.stringify({ enforce_admins: { enabled: true }, required_status_checks: { contexts: ["checks"] }, required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true, dismiss_stale_reviews: true } }));
      if (endpoint.endsWith("/permission")) return ok(JSON.stringify({ permission: "write", user: { login: "satori-miyamoto", permissions: { push: true } } }));
      if (endpoint.includes("/git/trees/")) return ok(JSON.stringify({ truncated: false, tree: [{ path: ".github/CODEOWNERS", type: "blob", mode: "100644", sha: MAIN_SHA }] }));
      if (endpoint.includes("/git/blobs/")) return ok(JSON.stringify({ sha: MAIN_SHA, encoding: "base64", content: Buffer.from(owners).toString("base64"), size: Buffer.byteLength(owners) }));
      if (endpoint.includes("/codeowners/errors?")) return ok(JSON.stringify({ errors: [] }));
    }
    if (line.startsWith("gh pr list")) { const pr = this.prs.get(flag("--head")); return ok(pr?.state === "OPEN" ? `${pr.url}\n` : "\n"); }
    if (line.startsWith("gh pr create")) { const url = `https://github.com/satoramoto/indra/pull/${++this.next}`; this.prs.set(flag("--head"), { url, state: "OPEN" }); return ok(`${url}\n`); }
    if (line.startsWith("gh pr view")) { const pr = byUrl(); return ok(JSON.stringify({ state: pr?.state ?? "UNKNOWN", mergeCommit: pr?.sha ? { oid: pr.sha } : null, headRefOid: MAIN_SHA, isDraft: false, author: { login: "owner" }, reviewDecision: "" })); }
    if (line.includes("/reviews?")) return ok(JSON.stringify([this.reviewed ? [{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: MAIN_SHA }] : []]));
    if (line.startsWith("gh pr checks")) return { code: this.checksCode, stdout: JSON.stringify([{ name: "checks", bucket: this.checksCode ? "fail" : "pass" }]), stderr: "" };
    if (args.includes("--disable-auto")) return ok();
    if (line.startsWith("gh pr merge")) { const pr = byUrl()!; pr.state = "MERGED"; pr.sha = MERGE_SHA; return ok(); }
    return ok();
  }
}
let gh = new FakeGh();
beforeEach(() => { gh = new FakeGh(); });
/** The bridge under test, with the fake gh unless a test passes its own. */
class PlanningBridge extends Bridge {
  constructor(store: PlanningStore, chat: PlanningChat, runtime: AgentRuntime, maxQueue = 20, shell: Shell = gh) { super(store, chat, runtime, maxQueue, shell); }
}

class FakeRuntime implements AgentRuntime {
  sessions: (string | undefined)[] = [];
  prompts: string[] = [];
  outcomes = [{ title: "Learn project", description: "Inspect it and report findings", seatId: "seat-003" }, { title: "Write tests", description: "Cover the planning flow", seatId: "seat-004" }];
  timeouts: { schema: string; timeoutMs?: number }[] = [];
  async message(prompt: string, schemaPath: string, sessionId?: string, options?: { timeoutMs?: number }): Promise<AgentResult> {
    this.timeouts.push({ schema: schemaPath, timeoutMs: options?.timeoutMs });
    this.sessions.push(sessionId);
    this.prompts.push(prompt);
    const response = schemaPath.endsWith("proposal.json") ? { summary: "Roadmap", outcomes: this.outcomes, risks: [], openQuestions: [] } : { reply: "What matters most?", summary: "Explore project", decisions: [], openQuestions: ["Priority?"] };
    return { sessionId: sessionId ?? "session-1", response, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" };
  }
}

describe("planning bridge", () => {
  it("persists a goal from old v1, runs every turn in a fresh session, and drafts only on a person's memo reaction", async () => {
    const store = await fixture(false); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    expect(goal.mattermost.rootPostId).toBe("post1");
    expect((await store.runtime(goal.id)).lastSeenAt).toBeLessThanOrEqual(chat.posts[0].create_at);
    expect(runtime.sessions).toEqual([undefined]);
    chat.human("post1", "Start with the README");
    await bridge.poll();
    // A new clarify turn never gets the previous turn's handle; the prompt carries the brief instead.
    expect(runtime.sessions).toEqual([undefined, undefined]);
    expect(runtime.prompts[1]).toContain("Current brief:");
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
    expect(runtime.timeouts.filter((call) => call.schema.endsWith("proposal.json")).map((call) => call.timeoutMs)).toEqual([DRAFT_TIMEOUT_MS]);
    const clarifying = runtime.timeouts.filter((call) => !call.schema.endsWith("proposal.json"));
    expect(clarifying.length).toBeGreaterThan(0);
    expect(clarifying.every((call) => call.timeoutMs === CLARIFY_TIMEOUT_MS)).toBe(true);
    expect(DRAFT_TIMEOUT_MS).toBeGreaterThan(CLARIFY_TIMEOUT_MS);
    const announcement = chat.posts.at(-1)!;
    expect(announcement.message).toContain("awaiting review");
    expect(announcement.message).toContain(`:${CHECK}:`);
    const record = await store.runtime(goal.id);
    expect(record.sessionId).toBe("session-1");
    expect(record.proposalPostIds).toEqual([announcement.id]);
    await new PlanningBridge(store, chat, runtime).poll();
    expect(chat.posts.at(-1)).toBe(announcement);
    // The proposal draft is its own task too: no clarify session is resumed.
    expect(runtime.sessions).toEqual([undefined, undefined, undefined]);
  });

  it("re-runs a clarify turn interrupted by a crash, once, in a fresh session", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    chat.human(goal.mattermost.rootPostId, "Question");
    const question = chat.posts.at(-1)!;
    // A crash mid-turn leaves the turn journaled with no result, and the last session's handle behind.
    const record = await store.runtime(goal.id);
    await store.saveRuntime(goal.id, { ...record, sessionId: "session-old", turn: { inputKey: question.id, since: question.create_at, drafting: false, startedAt: new Date().toISOString() } } as typeof record);
    await new PlanningBridge(store, chat, runtime).poll();
    expect(runtime.sessions).toEqual([undefined, undefined]);
    expect(chat.posts.filter((post) => post.message === "What matters most?")).toHaveLength(2);
    await new PlanningBridge(store, chat, runtime).poll();
    expect(runtime.sessions).toHaveLength(2);
  });

  it("clears a failed draft substate, posts once without error details, and drafts again only on a new memo", async () => {
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
    expect(parseOptions(["planning", "propose", "--goal", "goal-1", "--state", "/tmp/s"])).toEqual({ mode: "planning", action: "propose", checkout: "/tmp/s", goal: "goal-1", participants: [] });
    for (const args of [["planning", "approve"], ["planning", "propose"], ["planning", "propose", "--goal", "g", "--participant", "seat-002"],["planning", "start", "--goal", "G", "--channel", "c"], ["planning", "start", "--goal", "G", "--project", "/p"], ["planning", "approve", "--goal", "g", "--participant", "seat-002"], ["planning", "serve", "--goal", "g"]]) {
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
  it.each(["memo reaction", "terminal request"] as const)("gives %s drafts small outcomes with separate file owners and human review", async (trigger) => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    if (trigger === "memo reaction") chat.react(goal.mattermost.rootPostId, MEMO);
    else await PlanningBridge.requestProposal(store, goal.id);
    await bridge.poll();
    expect(runtime.prompts).toHaveLength(2);
    const prompt = runtime.prompts.at(-1);
    // The draft prompt is a contract: acceptance for each outcome, the seats to assign, human review next, the schema.
    expect(prompt).toMatch(/small, focused on one concern, and independently verifiable/);
    expect(prompt).toMatch(/acceptance criteria and targeted tests/);
    expect(prompt).toMatch(/list every file it will touch, including test files/);
    expect(prompt).toMatch(/different seats must not touch the same file/);
    expect(prompt).toMatch(/Name each dependency by outcome title and owning seat ID/);
    expect(prompt).toMatch(/shared-file wiring, name one owning outcome and seat/);
    expect(prompt).toContain("seat-003 (Aaron), seat-004 (Corey)");
    expect(prompt).not.toContain("seat-001");
    expect(prompt).toMatch(/Give each seat at most one outcome/);
    expect(prompt).toMatch(/draft for human review/);
    expect(prompt).toMatch(/Nothing starts until a person approves it/);
    expect(prompt).toMatch(/Return only JSON with keys summary, outcomes \(title, description and seatId\), risks, openQuestions/);
    expect(prompt).toMatch(/do not edit files, run implementation, deploy, or claim approval/);
    expect(prompt).toMatch(/Never put credentials/);
    expect(runtime.prompts[0]).toMatch(/Return only JSON with keys reply, summary, decisions \(agreed facts only\), openQuestions/);
    expect(prompt).toContain("This is planning only");
    expect(prompt).toContain("do not edit files, run implementation, deploy, or claim approval");
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("awaiting-review");
    expect(saved.assignments).toBeUndefined();
    expect(saved.proposal!.outcomes.map((item) => item.seatId)).toEqual(["seat-003", "seat-004"]);
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
    const otherStore = await fixture();
    const otherBridge = new PlanningBridge(otherStore, chat, runtime);
    const other = await otherBridge.start("Another goal");
    const sessions = runtime.sessions.length;
    chat.react(other.mattermost.rootPostId, MEMO, "george");
    await otherBridge.poll();
    expect(runtime.sessions).toHaveLength(sessions);
    expect((await otherStore.read()).planningGoals!.find((item) => item.id === other.id)!.stage).toBe("clarifying");
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
    expect(chat.posts.at(-1)?.message).toContain("planning");
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

  it("requests a proposal from the terminal while clarifying; the bridge drafts it through the memo path once", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    const posts = chat.posts.length;
    // The CLI only records the request under the goal lock; nothing is posted or drafted yet.
    expect(await PlanningBridge.requestProposal(store, goal.id)).toMatchObject({ alreadyRequested: false });
    expect(await PlanningBridge.requestProposal(store, goal.id)).toMatchObject({ alreadyRequested: true });
    expect(chat.posts).toHaveLength(posts);
    expect((await store.read()).planningGoals![0].stage).toBe("clarifying");
    await bridge.poll();
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("awaiting-review");
    expect(runtime.prompts.at(-1)).toContain("Draft the proposal now from the brief so far.");
    const announcement = chat.posts.at(-1)!;
    expect(chat.posts).toHaveLength(posts + 1);
    expect(announcement.root_id).toBe(goal.mattermost.rootPostId);
    expect(announcement.message).toContain("awaiting review");
    const record = await store.runtime(goal.id);
    expect(record.proposalPostIds).toEqual([announcement.id]);
    expect(record.proposalRequest).toBeUndefined();
    // Later polls and a repeated request change nothing.
    await bridge.poll();
    expect(chat.posts.at(-1)).toBe(announcement);
    await expect(PlanningBridge.requestProposal(store, goal.id)).rejects.toThrow("at the awaiting-review stage");
    expect(git(store.checkout, "log", "--format=%s").split("\n").filter((line) => line.startsWith("Draft proposal"))).toHaveLength(1);
  });

  it("drafts once when a memo reaction and a terminal request arrive together", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const bridge = new PlanningBridge(store, chat, runtime);
    const goal = await bridge.start("Explore project");
    const posts = chat.posts.length;
    chat.react(goal.mattermost.rootPostId, MEMO);
    await PlanningBridge.requestProposal(store, goal.id);
    await bridge.poll();
    await bridge.poll();
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect(runtime.prompts.filter((prompt) => prompt.includes("Draft the proposal now"))).toHaveLength(1);
    expect(chat.posts).toHaveLength(posts + 1);
    expect((await store.runtime(goal.id)).proposalRequest).toBeUndefined();
    expect(git(store.checkout, "log", "--format=%s").split("\n").filter((line) => line.startsWith("Draft proposal"))).toHaveLength(1);
  });

  it("consumes a terminal request whose draft fails, keeps proposal with one reply, and accepts a new request", async () => {
    const store = await fixture(); const chat = new FakeChat(); const runtime = new FakeRuntime();
    const goal = await new PlanningBridge(store, chat, runtime).start("Explore project");
    await PlanningBridge.requestProposal(store, goal.id);
    let attempts = 0;
    const failing: AgentRuntime = { message: async () => { attempts += 1; throw new Error("invalid proposal: outcome-3 assigned to a non-Developer seat, push https://bot:ghp_secret123@github.com/x failed"); } };
    const broken = new PlanningBridge(store, chat, failing);
    await broken.poll();
    await broken.poll();
    expect(attempts).toBe(1);
    const recorded = (await store.runtime(goal.id)).lastDraftError!;
    expect(recorded.message).toContain("proposal draft failed");
    expect(recorded.message).not.toContain("ghp_secret123");
    expect(chat.posts.some((post) => post.message.includes("outcome-3"))).toBe(false);
    expect((await store.read()).planningGoals![0].stage).toBe("clarifying");
    expect((await store.runtime(goal.id)).proposalRequest).toBeUndefined();
    expect(chat.posts.filter((post) => post.root_id === goal.mattermost.rootPostId && post.message.includes("Drafting the proposal failed"))).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await PlanningBridge.requestProposal(store, goal.id)).toMatchObject({ alreadyRequested: false });
    await new PlanningBridge(store, chat, runtime).poll();
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
  });

  it("refuses a terminal proposal request for an unknown goal or one past clarifying", async () => {
    const { store, chat, goal } = await awaitingReview();
    const posts = chat.posts.length;
    const before = await store.runtime(goal.id);
    await expect(PlanningBridge.requestProposal(store, goal.id)).rejects.toThrow(`Goal ${goal.id} is at the awaiting-review stage`);
    await expect(PlanningBridge.requestProposal(store, "goal-missing")).rejects.toThrow("No planning goal goal-missing");
    expect(await store.runtime(goal.id)).toEqual(before);
    expect(chat.posts).toHaveLength(posts);
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
    const integration = { branch: `sprint/${goal.id}`, baseSha: MAIN_SHA, status: "collecting" as const };
    expect(() => validatePlanningGoal({ ...approved, integration })).not.toThrow();
    expect(() => validatePlanningGoal({ ...current, integration })).toThrow("only at approved");
    expect(() => validatePlanningGoal({ ...approved, integration: { ...integration, branch: "main" } })).toThrow("Invalid sprint integration");
    expect(() => validatePlanningGoal({ ...approved, integration: { ...integration, status: "merged" as const, prUrl: "https://github.com/o/r/pull/1" } })).toThrow("missing its PR or merge commit");
  });
});

/** Sets assignment statuses as the seats would; a merged one gets its PR, a failed one a note. */
async function setStatuses(store: PlanningStore, statuses: Record<string, "queued" | "running" | "in-review" | "merged" | "failed">): Promise<void> {
  await store.update((state) => {
    for (const item of state.planningGoals![0].assignments!) {
      const status = statuses[item.outcomeId];
      if (status) Object.assign(item, { status, ...(status === "merged" ? { prUrl: `https://github.com/satoramoto/indra/pull/${item.outcomeId.slice(-1)}` } : status === "failed" ? { note: "build: tests broke" } : {}) });
    }
  }, "Seats update assignments");
}

async function approvedSprint() {
  const review = await awaitingReview();
  review.chat.react(review.proposalPost, CHECK);
  await review.bridge.poll();
  return review;
}
const sprintOf = async (store: PlanningStore) => (await store.read()).planningGoals![0].integration;

describe("sprint integration", () => {
  it("creates sprint/<goal-id> from main on a check mark approval and records it with the assignments", async () => {
    const { store, chat, goal } = await approvedSprint();
    const saved = (await store.read()).planningGoals![0];
    expect(saved.stage).toBe("approved");
    expect(saved.integration).toEqual({ branch: `sprint/${goal.id}`, baseSha: MAIN_SHA, status: "collecting" });
    expect(gh.calls.filter((line) => line.startsWith("gh api -X POST"))).toEqual([`gh api -X POST repos/satoramoto/indra/git/refs -f ref=refs/heads/sprint/${goal.id} -f sha=${MAIN_SHA}`]);
    expect(chat.posts.at(-1)?.message).toContain(`target \`sprint/${goal.id}\``);
    // Nothing merged yet: polling opens no PR.
    await new PlanningBridge(store, chat, new FakeRuntime()).poll();
    expect(gh.calls.some((line) => line.startsWith("gh pr create"))).toBe(false);
  });

  it("creates the branch on the terminal approval too, reusing one that exists, and approves nothing when GitHub fails", async () => {
    const { store, bridge, goal } = await awaitingReview();
    gh.branches.add(`sprint/${goal.id}`);
    await bridge.approve(goal.id);
    expect(await sprintOf(store)).toMatchObject({ branch: `sprint/${goal.id}`, status: "collecting" });
    expect(gh.calls.some((line) => line.startsWith("gh api -X POST"))).toBe(false);
    const failing = await awaitingReview();
    gh.failBranch = true;
    failing.chat.react(failing.proposalPost, CHECK);
    await failing.bridge.poll();
    expect((await failing.store.read()).planningGoals![0].stage).toBe("awaiting-review");
    expect(failing.chat.posts.at(-1)?.message).toContain("nothing was approved");
    await expect(failing.bridge.approve(failing.goal.id)).rejects.toThrow("gh api");
    expect((await failing.store.read()).planningGoals![0].integration).toBeUndefined();
  });

  it("opens one integration PR and merges on exact-head bot approval plus green CI without another reaction", async () => {
    const { store, chat, bridge, goal } = await approvedSprint();
    await setStatuses(store, { "outcome-1": "merged", "outcome-2": "in-review" });
    await bridge.poll();
    expect(gh.calls.some((line) => line.startsWith("gh pr create"))).toBe(false);
    await setStatuses(store, { "outcome-2": "merged" });
    await bridge.poll();
    expect((await sprintOf(store))?.status).toBe("pr-open");
    expect(gh.calls.some((line) => line.startsWith("gh pr merge"))).toBe(false);
    gh.reviewed = true; gh.checksCode = 1;
    await bridge.poll();
    expect((await sprintOf(store))?.status).toBe("pr-open");
    gh.checksCode = 0;
    await bridge.poll();
    expect(await sprintOf(store)).toMatchObject({ status: "merged", mergedSha: MERGE_SHA });
    expect(gh.calls.filter((line) => line.startsWith("gh pr create"))).toHaveLength(1);
    expect(gh.calls.filter((line) => line.startsWith("gh pr merge"))).toEqual([`gh pr merge https://github.com/satoramoto/indra/pull/101 --squash --match-head-commit ${MAIN_SHA}`]);
    expect((await store.runtime(goal.id)) as object).not.toHaveProperty("mergeApproval");
    await bridge.poll();
    expect(gh.calls.filter((line) => line.startsWith("gh pr merge"))).toHaveLength(1);
    expect(chat.posts.some((post) => post.message.includes("merged into main"))).toBe(true);
  });

  it("posts once when outcomes failed, and the owner's integrate opens the PR for what merged", async () => {
    const { store, chat, bridge, goal } = await approvedSprint();
    await setStatuses(store, { "outcome-1": "merged", "outcome-2": "running" });
    await expect(bridge.integrate(goal.id)).rejects.toThrow("still working");
    await setStatuses(store, { "outcome-2": "failed" });
    await bridge.poll();
    await bridge.poll();
    const notices = chat.posts.filter((post) => post.message.includes(`Sprint ${goal.id} is not complete`));
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("press I");
    expect(notices[0].message).toContain("Write tests** → Corey (seat-004): failed (build: tests broke)");
    expect(gh.calls.some((line) => line.startsWith("gh pr create"))).toBe(false);
    expect(await bridge.integrate(goal.id)).toContain("https://github.com/satoramoto/indra/pull/101");
    const create = gh.calls.find((line) => line.startsWith("gh pr create"))!;
    expect(create).toContain("**Failed or skipped**");
    expect(create).toContain("Learn project** → Aaron (seat-003): https://github.com/satoramoto/indra/pull/1");
    expect(await bridge.integrate(goal.id)).toContain("is pr-open");
    expect(gh.calls.filter((line) => line.startsWith("gh pr create"))).toHaveLength(1);
    gh.reviewed = true;
    expect(await bridge.merge(goal.id)).toContain(`Sprint ${goal.id} merged into main`);
    expect((await sprintOf(store))?.status).toBe("merged");
  });

  it("refuses integrate when nothing merged", async () => {
    const { store, bridge, goal } = await approvedSprint();
    await setStatuses(store, { "outcome-1": "failed", "outcome-2": "failed" });
    await expect(bridge.integrate(goal.id)).rejects.toThrow("Nothing merged");
  });

  it("rolls a merged sprint back with one revert PR on main, merged through the same bot and CI gate", async () => {
    const { store, chat, bridge, goal } = await approvedSprint();
    await setStatuses(store, { "outcome-1": "merged", "outcome-2": "merged" });
    await bridge.poll();
    gh.reviewed = true;
    await bridge.merge(goal.id);
    gh.reviewed = false;
    const result = await bridge.rollback(goal.id);
    expect(result).toContain("https://github.com/satoramoto/indra/pull/102");
    const worktree = join(store.runtimeDir, "worktrees", `revert-${goal.id}`);
    expect(gh.calls).toContain(`git worktree add --no-track -b revert/${goal.id} ${worktree} origin/main`);
    expect(gh.calls).toContain(`git revert --no-edit ${MERGE_SHA}`);
    expect(gh.calls).toContain(`git -c credential.helper= -c credential.helper=!gh auth git-credential push origin HEAD:refs/heads/revert/${goal.id}`);
    expect(gh.calls.find((line) => line.includes(`--head revert/${goal.id}`) && line.startsWith("gh pr create"))).toContain("--base main");
    expect(await sprintOf(store)).toMatchObject({ status: "merged", revertPrUrl: "https://github.com/satoramoto/indra/pull/102" });
    const post = chat.posts.at(-1)!;
    expect(post.message).toContain("Rollback of sprint");
    expect(await bridge.rollback(goal.id)).toContain("already open");
    expect(gh.calls.filter((line) => line.startsWith("gh pr create"))).toHaveLength(2);
    chat.react(post.id, CHECK, "george");
    await bridge.poll();
    expect((await sprintOf(store))?.status).toBe("merged");
    gh.reviewed = true;
    await bridge.poll();
    expect((await sprintOf(store))?.status).toBe("reverted");
    expect(chat.posts.at(-1)?.message).toContain(`Sprint ${goal.id} rolled back`);
    expect(await bridge.rollback(goal.id)).toContain("already rolled back");
  });

  it("parses the sprint actions", () => {
    for (const action of ["integrate", "merge", "rollback"]) expect(parseOptions(["planning", action, "--goal", "goal-1", "--state", "/tmp/s"])).toMatchObject({ mode: "planning", action, goal: "goal-1" });
    expect(() => parseOptions(["planning", "rollback"])).toThrow("Usage:");
  });
});


describe("whole-goal queue contract", () => {
  const at = "2026-09-01T00:00:00Z";
  async function remodelStore() {
    const base = await fixture();
    await base.update((state) => {
      const team = state.teams[0] as { workflowModel?: string; seats: object[] };
      team.workflowModel = "goals-v1";
      team.seats.push({ id: "seat-002", displayName: "George Duke", roles: ["Product"], externalIdentities: { mattermost: { userId: "george", username: "georgeduke" } } });
    }, "Enable fixture three-role model");
    await mkdir(join(base.checkout, "schema/v1"), { recursive: true });
    await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(base.checkout, "schema/v1/state.schema.json"));
    return new PlanningStore(base.checkout, undefined, { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } });
  }
  async function propose(store: PlanningStore, id: string, ownedFiles = ["src/**"], otherTeam = false, rank = 1) {
    const teamId = otherTeam ? "team-other" : "team-001";
    const goal: PlanningGoal = { workflowModel: "goals-v1", id, teamId, seatId: otherTeam ? "seat-other-lead" : "seat-001", participantSeatIds: [], goal: "Implement goal", projectRefs: [otherTeam ? "Satoramoto/Indra" : "satoramoto/indra"], stage: "clarifying", createdAt: at, updatedAt: at, mattermost: { channelId: "channel", rootPostId: `root-${id}` }, brief: { summary: "Goal", decisions: [], openQuestions: [] }, ownedFiles };
    await store.createGoal(goal);
    await store.update((state) => {
      const next = state.planningGoals!.find((item) => item.id === id)!;
      next.stage = "awaiting-review";
      next.goalProposal = { version: 1, goalId: id, proposalId: `proposal-${id}`, productSeatId: otherTeam ? "seat-other-product" : "seat-002", rank, mission: "docs/mission.md", summary: "Implement goal", outcomes: [{ number: 1, title: "Outcome", description: "Deliver it", reason: "Mission progress", currentCode: ["src/planning.ts"] }], ownedFiles, risks: [], rationale: "Useful", basedOnRetros: [] };
      next.ceremony = advanceCeremony(next, { to: "proposal", at });
    }, "Propose fixture goal");
  }
  const proof = (id: string) => ({ kind: "approval" as const, proposalId: `proposal-${id}`, proposalPostId: `root-${id}`, approval: { source: "owner-command" as const, command: "planning approve" as const, at } });
  const sprint = (id: string) => ({ branch: `sprint/${id}`, baseSha: MAIN_SHA, status: "collecting" as const });
  const context = { cwd: "/fixture/managed-project", mission: "Deliver approved goals", retros: [
    { goalId: "goal-older", path: "docs/retros/goal-older.md", summary: "An actual earlier retro" },
    { goalId: "goal-recent", path: "docs/retros/goal-recent.md", summary: "An actual recent retro" },
  ] };
  const scheduler = (store: PlanningStore, chat = new FakeChat(), runtime: AgentRuntime = new FakeRuntime(), adapters: CeremonyAdapters = {}) => new Bridge(store, chat, runtime, 20, gh, adapters, { projectContext: async () => structuredClone(context), runtimeFor: () => runtime });
  const startup = { kind: "startup" as const, teamId: "team-001", at };
  const reportFor = (goalId: string): GoalReport => ({ version: 1, goalId, teamId: "team-001", seatId: "seat-003", sprintBranch: `sprint/${goalId}`, headSha: MAIN_SHA,
    lanePrs: [{ laneId: "lane-one", url: "https://github.com/satoramoto/indra/pull/90", headSha: MAIN_SHA, mergedSha: MERGE_SHA, reviewer: "satori-miyamoto", ci: "passed" }],
    checks: [{ command: "npm run typecheck", exitCode: 0 }], decisions: ["Kept the approved boundary"], followUps: ["Inspect the next goal"], neededButUnowned: [] });

  it("schedules highest rank, reserves future-file overlaps and preserves Developer-owned records across concurrent restart turns", async () => {
    const store = await remodelStore();
    for (const [id, scope, rank] of [["goal-low", "src/new.ts", 9], ["goal-high", "src/**", 1], ["goal-tests", "tests/**", 2]] as const) { await propose(store, id, [scope], false, rank); await store.approveGoal(id, proof(id), at); }
    const first = await scheduler(store).turn(startup);
    expect(first.record.failure).toBeNull();
    expect(first.record.approvedQueue).toEqual([{ goalId: "goal-low", rank: 9, ownedFiles: ["src/new.ts"], blockedByGoalIds: ["goal-high"] }]);
    const state = await store.read(); expect(state.planningGoals!.map((goal) => [goal.id, goal.goalAssignment?.seatId])).toEqual([["goal-low", undefined], ["goal-high", "seat-003"], ["goal-tests", "seat-004"]]);
    const runtime = (await store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename("goal-high")))!;
    expect(runtime.brief).toMatchObject({ header: { repo: "satoramoto/indra", baseSha: MAIN_SHA }, retros: context.retros, outcomes: [{ number: 1, reason: "Mission progress", currentCode: ["src/planning.ts"] }] });
    runtime.failure = { at, message: "Developer-owned evidence", retryable: true }; await store.saveRuntime(goalRuntimeFilename("goal-high"), runtime);
    const calls = gh.calls.length;
    await Promise.all([scheduler(store).turn(startup), scheduler(store).turn(startup)]);
    expect(await store.readRuntimeFile(goalRuntimeFilename("goal-high"))).toEqual(runtime);
    expect(gh.calls.slice(calls).some((call) => call.includes("-X POST"))).toBe(false);
    expect((await store.read()).planningGoals!.filter((goal) => goal.goalAssignment)).toHaveLength(2);
  });

  it.each(["review", "developer-lock", "other-team"] as const)("dispatches a later disjoint approval through the production host while A is deferred by %s", async (mode) => {
    const store = await remodelStore(); const chat = new FakeChat();
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
    const held = deferred(); const started = deferred(); const dispatched = deferred(); const ready = deferred();
    const controller = new AbortController(); const inbox = new WorkflowInbox(store.runtimeDir);
    await propose(store, "goal-a"); await store.approveGoal("goal-a", proof("goal-a"), at); await scheduler(store, chat).dispatch(startup);
    if (mode === "other-team") await store.update((state) => {
      state.teams.push({ id: "team-other", slug: "other", displayName: "Other", workflowModel: "goals-v1", project: { github: "Satoramoto/Indra" }, externalIdentities: { mattermost: { teamId: "other-external", homeChannelId: "channel" } }, seats: [
        { id: "seat-other-lead", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "other-lead", username: "otherlead" } } },
        { id: "seat-other-product", displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { userId: "other-product", username: "otherproduct" } } },
        { id: "seat-other-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "other-dev", username: "otherdev" } } },
      ] });
    }, "Add independent fixture team");
    const other = mode === "other-team"; const teamId = other ? "team-other" : "team-001";
    let locked: Promise<void> | undefined;
    if (mode !== "review") {
      const acquired = deferred(); locked = store.withGoalLock("goal-a", async () => { acquired.resolve(); await held.promise; }); await acquired.promise;
    }
    const message = vi.fn(async (): Promise<AgentResult> => { started.resolve(); await held.promise; return { sessionId: "review-a", startedAt: at, finishedAt: at, response: { summary: "Approved", findings: [] } }; });
    vi.spyOn(SprintGitHub.prototype, "verifyGoalReport").mockResolvedValue(undefined);
    vi.spyOn(SprintGitHub.prototype, "integrationScope").mockResolvedValue({ headSha: MAIN_SHA, baseSha: MAIN_SHA, conflicting: false });
    vi.spyOn(SprintGitHub.prototype, "reviewIntegration").mockImplementation(async (_repo, _goal, _url, _sha, review) => { await review("/fixture/reviewer"); gh.reviewed = true; });
    vi.spyOn(SprintGitHub.prototype, "merge").mockResolvedValue({ merged: false, reason: "CI pending" });
    const factory = () => scheduler(store, chat, { message });
    let activity = 0; let maxActivity = 0; let stopped = false;
    const hostFor = (id: string) => runWorkflowHost({ store, teamId: id, consumer: `test-scheduler-${id}`, signal: controller.signal,
      activity: async (run) => { activity++; maxActivity = Math.max(maxActivity, activity); try { await run(); } finally { activity--; } },
      consumers: async () => (await factory().consumers(id)).map((consumer) => ({ ...consumer, turn: async (event) => {
        if (mode !== "review" && consumer.consumer === "scheduler-release-goal-a") started.resolve();
        return await consumer.turn(event);
      } })),
      onReady: async () => { if (id === "team-001") ready.resolve(); },
      turn: async (event) => { const result = await factory().dispatch(event); for (const next of result.events) await inbox.publish(next); if (result.record.activeDispatches.some((item) => item.goalId === "goal-b")) dispatched.resolve(); },
    });
    const hosts = [hostFor("team-001")];
    const finished = () => Promise.all(hosts).then(() => { stopped = true; });
    try {
      await ready.promise;
      if (mode === "review") await inbox.publish({ kind: "developer-report", id: "deferred-report-a", goalId: "goal-a", teamId: "team-001", seatId: "seat-003", report: reportFor("goal-a"), at });
      await started.promise; // B does not exist until the real release consumer is inside the held work.
      if (other) hosts.push(hostFor("team-other"));
      await propose(store, "goal-overlap", ["src/future.ts"], other, 1); await store.approveGoal("goal-overlap", proof("goal-overlap"), at);
      await propose(store, "goal-b", ["tests/**"], other, 2); await store.approveGoal("goal-b", proof("goal-b"), at);
      const approved = { kind: "approval" as const, id: "late-approval-b", goalId: "goal-b", teamId, at };
      await Promise.all([inbox.publish(approved), inbox.publish(approved)]);
      await dispatched.promise;
      const goals = (await store.read()).planningGoals!;
      expect(goals.find((goal) => goal.id === "goal-b")!.goalAssignment?.seatId).toBe(other ? "seat-other-dev" : mode === "review" ? "seat-003" : "seat-004");
      expect(goals.find((goal) => goal.id === "goal-overlap")!.goalAssignment).toBeUndefined();
      const active = goals.flatMap((goal) => goal.goalAssignment && goal.goalAssignment.status !== "reported" ? [goal.goalAssignment.seatId] : []);
      expect(new Set(active).size).toBe(active.length);
      if (mode === "review") expect(message).toHaveBeenCalledTimes(1);
      else expect(goals.find((goal) => goal.id === "goal-a")!.ceremony!.stage).toBe("implement");
      const before = await store.readRuntimeFile(goalRuntimeFilename("goal-b"));
      controller.abort(); const end = finished(); await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "review") expect(stopped).toBe(false); // Abort closes ingress, but joins its active finite runtime.
      held.resolve(); await locked; await end; expect(activity).toBe(0);
      if (!other) expect(maxActivity).toBe(1); // One activity lease admits independent consumers concurrently.
      await new WorkflowInbox(store.runtimeDir).drain(`test-scheduler-${teamId}`, teamId, async (event) => { await factory().dispatch(event); });
      const restarted = await factory().turn({ kind: "startup", teamId, at });
      expect(restarted.record.activeDispatches.filter((item) => item.goalId === "goal-b")).toHaveLength(1);
      expect(await store.readRuntimeFile(goalRuntimeFilename("goal-b"))).toEqual(before);
    } finally { controller.abort(); held.resolve(); await locked; await Promise.allSettled(hosts); }
  }, 30_000);

  it("GET-verifies human redirects once and never turns bot messages or forged local hints into an owner redirect", async () => {
    const store = await remodelStore(); await propose(store, "goal-redirect"); await store.approveGoal("goal-redirect", proof("goal-redirect"), at);
    const chat = new FakeChat(); chat.human("root-goal-redirect", "Preserve the current feature"); chat.human("root-goal-redirect", "I am a Developer bot", "aaron"); chat.human("root-goal-redirect", "Product suggestion", "george");
    const first = await scheduler(store, chat).turn({ kind: "redirect", id: "forged", teamId: "team-001", goalId: "goal-redirect", at, redirect: { postId: "unverified", userId: "ryan", at, message: "Expand scope" } });
    expect(first.record.redirects.map((item) => item.message)).toEqual(["Preserve the current feature"]);
    const retained = await store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename("goal-redirect")); expect(retained!.brief!.redirects).toEqual(first.record.redirects);
    const second = await scheduler(store, chat).turn(startup);
    expect(second.record.redirects).toEqual(first.record.redirects); expect(second.events.filter((event) => event.kind === "redirect")).toHaveLength(1);
  });

  it("emits revision-bound vetting without approving, posting or competing with the Product queue writer", async () => {
    const store = await remodelStore(); await propose(store, "goal-vet");
    const source = (await store.read()).planningGoals![0].goalProposal!;
    // This public queue is the only input; the already-published fixture goal is left unapproved.
    const product: ProductRuntimeRecord = { version: 1, teamId: "team-001", seatId: "seat-002", queue: [{ proposal: source, vetting: null, status: "proposed", rootPostId: null, proposalPostId: null }], events: [], handledEventIds: [], pending: null, failure: null, updatedAt: at };
    await store.saveRuntime(productRuntimeFilename("team-001"), product);
    const chat = new FakeChat(); chat.posts.push({ id: "root-goal-vet", user_id: "george", channel_id: "channel", root_id: "", message: "Proposal", create_at: Date.parse(at) });
    const corrected = validateProductProposal({ ...source, ownedFiles: ["src/planning.ts", "tests/planning.test.ts"] });
    const message = vi.fn(async (): Promise<AgentResult> => ({ sessionId: "fresh", startedAt: at, finishedAt: at, response: corrected }));
    const result = await scheduler(store, chat, { message }).turn(startup);
    expect(result.record.failure).toBeNull();
    expect(result.events.find((event) => event.kind === "proposal-vetted")).toMatchObject({ id: `proposal-vetted:${source.proposalId}:${workflowDigest(validateProductProposal(source))}:${workflowDigest(corrected)}`, vetting: { ownedFiles: corrected.ownedFiles, leadSeatId: "seat-001" } });
    expect(await store.readRuntimeFile(productRuntimeFilename("team-001"))).toEqual(product);
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review"); expect(chat.posts).toHaveLength(1);
    await scheduler(store, chat, { message }).turn(startup); expect(message).toHaveBeenCalledTimes(1);
  });

  it("refuses unsupported reports and keeps disjoint scheduling available, then opens and reviews a verified report before CI", async () => {
    const store = await remodelStore(); await propose(store, "goal-report"); await store.approveGoal("goal-report", proof("goal-report"), at);
    await scheduler(store).turn(startup);
    await propose(store, "goal-independent", ["tests/**"]); await store.approveGoal("goal-independent", proof("goal-independent"), at);
    const verification = vi.spyOn(SprintGitHub.prototype, "verifyGoalReport").mockRejectedValueOnce(new Error("GitHub proof is missing")).mockResolvedValue(undefined);
    const report = reportFor("goal-report"); const event = { kind: "developer-report" as const, id: "report-one", goalId: "goal-report", teamId: "team-001", seatId: "seat-003", report, at };
    const bad = await scheduler(store).turn(event);
    expect(bad.record.failure!.message).toContain("proof is missing"); expect((await store.read()).planningGoals![0].ceremony!.stage).toBe("implement"); expect((await store.read()).planningGoals![1].goalAssignment).toBeDefined();
    const scope = vi.spyOn(SprintGitHub.prototype, "integrationScope").mockResolvedValue({ headSha: MAIN_SHA, baseSha: MAIN_SHA, conflicting: false });
    const review = vi.spyOn(SprintGitHub.prototype, "reviewIntegration").mockResolvedValue(undefined);
    const merge = vi.spyOn(SprintGitHub.prototype, "merge").mockResolvedValue({ merged: false, reason: "CI pending" });
    const next = await scheduler(store).turn(startup);
    expect(verification).toHaveBeenCalledTimes(2); expect(scope).toHaveBeenCalled(); expect(review).toHaveBeenCalledTimes(1); expect(merge).toHaveBeenCalledTimes(1);
    expect((await store.read()).planningGoals![0]).toMatchObject({ ceremony: { stage: "release" }, goalAssignment: { status: "reported" }, integration: { status: "pr-open" } });
    expect(next.record.failure!.message).toContain("CI pending");
    expect(gh.calls.find((call) => call.startsWith("gh pr create"))).toContain("## Decisions");
  });
  it("gives scheduled integration reviews the finite Developer session budget", async () => {
    const store = await remodelStore(); const goalId = "goal-review-timeout";
    await propose(store, goalId); await store.approveGoal(goalId, proof(goalId), at); await scheduler(store).turn(startup);
    vi.spyOn(SprintGitHub.prototype, "verifyGoalReport").mockResolvedValue(undefined);
    vi.spyOn(SprintGitHub.prototype, "integrationScope").mockResolvedValue({ headSha: MAIN_SHA, baseSha: MAIN_SHA, conflicting: false });
    vi.spyOn(SprintGitHub.prototype, "reviewIntegration").mockImplementation(async (_repo, _goal, _url, _sha, review) => { await review("/fixture/reviewer"); gh.reviewed = true; });
    vi.spyOn(SprintGitHub.prototype, "merge").mockResolvedValue({ merged: false, reason: "CI pending" });
    const message = vi.fn<AgentRuntime["message"]>().mockResolvedValue({ sessionId: "fresh-review", startedAt: at, finishedAt: at, response: { summary: "Approved", findings: [] } });
    const runtimeFor = vi.fn(() => ({ message }));
    const bridge = new Bridge(store, new FakeChat(), new FakeRuntime(), 20, gh, {}, { projectContext: async () => structuredClone(context), runtimeFor });
    const result = await bridge.turn({ kind: "developer-report", id: "review-timeout-report", goalId, teamId: "team-001", seatId: "seat-003", report: reportFor(goalId), at });
    expect(message).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`at ${MAIN_SHA}`), expect.stringContaining("retro-review.json"), undefined, { purpose: "review", timeoutMs: DEVELOPER_SESSION_TIMEOUT_MS });
    expect(runtimeFor).toHaveBeenCalledExactlyOnceWith("/fixture/reviewer");
    expect(DEVELOPER_SESSION_TIMEOUT_MS).toBe(60 * 60_000);
    expect(result.record.failure!.message).toContain("CI pending");
    expect((await store.read()).planningGoals![0].integration?.status).toBe("pr-open");
  });

  it("recovers a committed merge notification, waits for the actual running build and archived retro, then releases scope for the next goal", async () => {
    const store = await remodelStore(); const chat = new FakeChat();
    for (const id of ["goal-finish", "goal-wait"]) { await propose(store, id); await store.approveGoal(id, proof(id), at); }
    await scheduler(store, chat).turn(startup);
    vi.spyOn(SprintGitHub.prototype, "verifyGoalReport").mockResolvedValue(undefined);
    vi.spyOn(SprintGitHub.prototype, "integrationScope").mockResolvedValue({ headSha: MAIN_SHA, baseSha: MAIN_SHA, conflicting: false });
    vi.spyOn(SprintGitHub.prototype, "reviewIntegration").mockImplementation(async () => { gh.reviewed = true; });
    const report = reportFor("goal-finish");
    const released = await scheduler(store, chat).turn({ kind: "developer-report", id: "final-report", goalId: "goal-finish", teamId: "team-001", seatId: "seat-003", report, at });
    expect((await store.read()).planningGoals![0]).toMatchObject({ integration: { status: "merged" }, ceremony: { stage: "release" } });
    expect((await store.read()).planningGoals![1].goalAssignment).toBeUndefined();
    expect(released.events.some((event) => event.kind === "merge")).toBe(true);
    const record = (await store.readRuntimeFile<SchedulerRuntimeRecord>(teamRuntimeFilename("team-001")))!; record.events = record.events.filter((event) => event.kind !== "merge"); await store.saveRuntime(teamRuntimeFilename("team-001"), record);
    const recovered = await scheduler(store, chat).turn(startup); expect(recovered.events.some((event) => event.kind === "merge")).toBe(true);
    const adapters: CeremonyAdapters = {
      release: { poll: async ({ goal }) => ({ status: "complete", evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: MERGE_SHA, mergeVerification: { headSha: MAIN_SHA, reviewCommitSha: MAIN_SHA, reviewer: "satori-miyamoto", checksPassed: true }, checksPassed: true, buildSha: MERGE_SHA, runningSha: MERGE_SHA, runningAt: new Date().toISOString() } }) },
      retro: { poll: async ({ goal, post }) => ({ status: "complete", evidence: { kind: "retro-published", path: `docs/retros/${goal.id}.md`, prUrl: "https://github.com/satoramoto/indra/pull/900", baseBranch: "main", mergedSha: "c".repeat(40), postId: await post("frozen-retro", "Verified frozen retro"), publishedAt: new Date().toISOString(), factsOnly: true, suggestions: "owner-proposals-only" } }) },
    };
    const closed = await scheduler(store, chat, new FakeRuntime(), adapters).turn(startup);
    expect(closed.record.failure).toBeNull(); expect((await store.read()).planningGoals![0].ceremony!.closure?.evidence.kind).toBe("retro-published");
    expect((await store.read()).planningGoals![1].goalAssignment?.seatId).toBe("seat-003");
    expect(chat.reacted).toEqual([]); expect(chat.posts.some((post) => post.message.includes("a person reacts"))).toBe(false);
    expect(closed.events.some((event) => event.kind === "goal-closed")).toBe(true);
  });
  it("keeps multiple approved goals unassigned and dispatches only disjoint scopes to idle Developers", async () => {
    const store = await remodelStore();
    for (const [id, scope] of [["goal-first", "src/**"], ["goal-overlap", "src/future.ts"], ["goal-tests", "tests/**"]]) { await propose(store, id, [scope]); await store.approveGoal(id, proof(id), at); }
    expect((await store.read()).planningGoals!.every((goal) => !goal.goalAssignment && !goal.assignments && !goal.integration)).toBe(true);
    expect(await store.teamConflicts()).toEqual([]);
    await store.assignGoal("goal-first", "seat-003", sprint("goal-first"), at);
    await expect(store.assignGoal("goal-overlap", "seat-004", sprint("goal-overlap"), at)).rejects.toThrow("overlap");
    await expect(store.assignGoal("goal-tests", "seat-003", sprint("goal-tests"), at)).rejects.toThrow("one goal");
    await store.assignGoal("goal-tests", "seat-004", sprint("goal-tests"), at);
    expect((await store.read()).planningGoals!.filter((goal) => goal.goalAssignment)).toHaveLength(2);
  });
  it("blocks unclosed legacy work whose file scope is unknown", async () => {
    const store = await remodelStore();
    await store.createGoal({ id: "goal-legacy", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Historical work", projectRefs: ["satoramoto/indra"], stage: "clarifying", createdAt: at, updatedAt: at, mattermost: { channelId: "channel", rootPostId: "legacy-root" }, brief: { summary: "Historical work", decisions: [], openQuestions: [] } });
    await propose(store, "goal-new"); await store.approveGoal("goal-new", proof("goal-new"), at);
    await expect(store.assignGoal("goal-new", "seat-003", sprint("goal-new"), at)).rejects.toThrow("Unclosed legacy");
    await expect(store.update((state) => { Object.assign(state.planningGoals![1], { goalAssignment: { seatId: "seat-003", status: "assigned", updatedAt: at }, integration: sprint("goal-new") }); }, "Bypass assignment guard")).rejects.toThrow("unknown scope");
  });
  it("reserves overlapping future files across teams on the same repository, ignoring repository letter case", async () => {
    const store = await remodelStore();
    await store.update((state) => {
      state.teams.push({ id: "team-other", slug: "other", displayName: "Other", workflowModel: "goals-v1", project: { github: "Satoramoto/Indra" }, externalIdentities: { mattermost: { teamId: "other-external", homeChannelId: "channel" } }, seats: [
        { id: "seat-other-lead", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "other-lead", username: "otherlead" } } },
        { id: "seat-other-product", displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { userId: "other-product", username: "otherproduct" } } },
        { id: "seat-other-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "other-dev", username: "otherdev" } } },
      ] });
    }, "Add another fixture team on the same project");
    await propose(store, "goal-local"); await store.approveGoal("goal-local", proof("goal-local"), at);
    await propose(store, "goal-other", ["src/future.ts"], true); await store.approveGoal("goal-other", proof("goal-other"), at);
    await store.assignGoal("goal-local", "seat-003", sprint("goal-local"), at);
    await expect(store.assignGoal("goal-other", "seat-other-dev", sprint("goal-other"), at)).rejects.toThrow("overlap");
  });
  it("rejects bot approval, incorrect Product/Developer identities and edits to approved scope", async () => {
    const store = await remodelStore(); await propose(store, "goal-proof");
    await expect(store.approveGoal("goal-proof", { ...proof("goal-proof"), approval: { source: "reaction", userId: "george", postId: "root-goal-proof", emoji: "white_check_mark", verifiedHuman: true, at } }, at)).rejects.toThrow("cannot supply human");
    await expect(store.update((state) => { state.planningGoals![0].goalProposal!.productSeatId = "seat-003"; }, "Wrong provenance")).rejects.toThrow("immutable");
    await store.approveGoal("goal-proof", proof("goal-proof"), at);
    await expect(store.update((state) => { state.planningGoals![0].ownedFiles = ["**"]; }, "Expand scope")).rejects.toThrow("immutable");
    await expect(store.update((state) => { state.planningGoals![0].goalProposal!.rank = 2; }, "Rewrite proposal")).rejects.toThrow("immutable");
    await expect(store.assignGoal("goal-proof", "seat-002", sprint("goal-proof"), at)).rejects.toThrow("Developer");
  });
  it.each(["reaction", "owner"])("approves a real Product-authored root through %s without publishing the whole queue", async (route) => {
    const store = await remodelStore(); const chat = new FakeChat(); const bridge = new PlanningBridge(store, chat, new FakeRuntime());
    const proposal = { version: 1 as const, goalId: "goal-product", proposalId: "proposal-product", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "Product goal", outcomes: [{ number: 1, title: "Outcome", description: "Deliver it", reason: "Mission", currentCode: ["src/planning.ts"] }], ownedFiles: ["src/**"], risks: [], rationale: "Useful", basedOnRetros: [] };
    const post = { id: "product-root", userId: "george", channelId: "channel", rootId: "", createdAt: at };
    const vetting = { proposalId: proposal.proposalId, leadSeatId: "seat-001", ownedFiles: proposal.ownedFiles, notes: [], at };
    await expect(store.publishProductProposal("team-001", proposal, { ...post, userId: "chick" }, vetting)).rejects.toThrow("Product-authored");
    await expect(store.publishProductProposal("team-001", proposal, post, { ...vetting, ownedFiles: ["**"] })).rejects.toThrow("vetting");
    const goal = await store.publishProductProposal("team-001", proposal, post, vetting);
    expect(goal.mattermost.rootPostId).toBe(post.id);
    await expect(store.publishProductProposal("team-001", { ...proposal, goalId: "goal-other" }, { ...post, id: "other-root" }, vetting)).rejects.toThrow("Only one published");
    await expect(bridge.approve(goal.id)).rejects.toThrow("not been verified");
    chat.posts.push({ id: post.id, user_id: post.userId, channel_id: post.channelId, root_id: "", message: proposal.summary, create_at: Date.parse(at) });
    chat.react(post.id, CHECK, "george"); await bridge.poll();
    expect((await store.read()).planningGoals![0].stage).toBe("awaiting-review");
    if (route === "owner") await bridge.approve(goal.id);
    else { chat.react(post.id, CHECK, "ryan"); await bridge.poll(); }
    expect((await store.read()).planningGoals![0]).toMatchObject({ stage: "approved", ceremony: { stage: "implement" } });
    expect((await store.read()).planningGoals![0].goalAssignment).toBeUndefined();
    expect(chat.posts).toHaveLength(1);
  });

});
