import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, stateCheckout } from "./state-checkout.js";
import { type PlanningGoal, PlanningStore } from "../src/planning.js";
import { DeveloperSeat, loadDeveloperSeat, processShell, type SeatChat, type SeatTaskRecord, type Shell, type ShellResult } from "../src/developer-seat.js";
import { sandboxArgs, type AgentResult, type AgentRuntime, type WriteAccess } from "../src/codex-runtime.js";
import type { PlanningAssignment as Assignment } from "../src/planning.js";
import { postReviewOnce } from "../src/developer-review.js";
import { advanceCeremony } from "../src/ceremony.js";
import { ImplementationRecorder, implementationWallTime } from "../src/implementation-facts.js";
import { AgentRunError } from "../src/runtime-facts.js";
import { parseOptions } from "../src/cli.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const PR = "https://github.com/satoramoto/indra/pull/9";
const BRANCH = "seat-002/goal-abc-outcome-1";
const RECORD = "seat-seat-002-goal-abc-outcome-1";
const seat = (id: string, name: string, roles: string[]) => ({ id, displayName: name, roles, externalIdentities: { mattermost: { userId: id, username: name.toLowerCase() } } });

const READY = { version: 1 as const, consumers: { planning: 1 as const, developer: 1 as const, release: 1 as const, retro: 1 as const, tui: 1 as const } };
const SPRINT = { branch: "sprint/goal-abc", baseSha: "a".repeat(40), status: "collecting" };
async function fixture(assignments: Assignment[], stage = "approved", project: { github: string } | null = { github: "satoramoto/indra" }, integration: object = SPRINT) {
  const goal = {
    id: "goal-abc", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Build it", projectRefs: ["satoramoto/indra"], stage,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mattermost: { channelId: "channel", rootPostId: "root" },
    brief: { summary: "Build it", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-1", createdAt: "2026-01-01T00:00:00Z", summary: "Plan", risks: [], openQuestions: [], outcomes: [
      { id: "outcome-1", title: "First", description: "Do the first thing", seatId: "seat-002" },
      { id: "outcome-2", title: "Second", description: "Do the second thing", seatId: "seat-002" },
      { id: "outcome-3", title: "Third", description: "Someone else's", seatId: "seat-003" },
    ] },
    assignments,
    ...(integration ? { integration } : {}),
  };
  if (stage === "approved" && project && integration && assignments.length) {
    goal.proposal.outcomes = assignments.map((assignment) => ({ ...goal.proposal.outcomes.find((item) => item.id === assignment.outcomeId)!, seatId: assignment.seatId }));
    (goal as PlanningGoal).ceremony = { version: 1, stage: "implement", history: [
      { stage: "planning", enteredAt: goal.createdAt }, { stage: "proposal", enteredAt: goal.createdAt },
      { stage: "implement", enteredAt: goal.createdAt, evidence: { kind: "approval", proposalId: "proposal-1", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: goal.createdAt } } },
    ] };
  }
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [goal], teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", ...(project ? { project } : {}), externalIdentities: { mattermost: { teamId: "team", homeChannelId: "channel" } }, seats: [seat("seat-001", "Chick", ["Team Lead"]), seat("seat-002", "George", ["Developer"]), seat("seat-003", "Herbie", ["Developer"])] }] };
  const checkout = await stateCheckout("indra-seat-", state);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
  return new PlanningStore(checkout, undefined, READY);
}
const queued = (outcomeId: string, updatedAt: string, seatId = "seat-002"): Assignment => ({ outcomeId, seatId, status: "queued", updatedAt });

class FakeChat implements SeatChat {
  messages: string[] = [];
  async post(_channel: string, message: string, rootId?: string) { expect(rootId).toBe("root"); this.messages.push(message); return {}; }
}
class FakeShell implements Shell {
  calls: string[] = [];
  checksCode = 0;
  merges: { code: number; stderr: string; merged: boolean }[] = [];
  merged = false;
  draft = false;
  /** The PR's head: by default the branch of the worktree most recently added or retained. */
  headRef?: string;
  lastBranch = "";
  baseRef = "sprint/goal-abc";
  headSha = "a".repeat(40);
  /** Each mergeability check takes the next status; by default the PR is current with main. */
  mainStatus: { mergeable: string; mergeStateStatus: string }[] = [];
  /** Each `git merge origin/sprint/goal-abc` takes the next exit code (1 = conflicts); by default it merges cleanly. */
  mainMerges: number[] = [];
  /** Each "is origin/sprint/goal-abc merged into HEAD" check takes the next exit code; by default it is. */
  resolved: number[] = [];
  refs = new Set<string>();
  worktrees = new Map<string, { branch: string; gitDir: string }>();
  unfinishedMerge = false;
  inspectCode?: number;
  abortCode = 0;
  comments: { body: string; user: { login: string }; state: string; commit_id: string }[] = [];
  maintenancePR: unknown = { merged: false };
  async retain(worktree: string, branch: string, gitDir: string) {
    await mkdir(worktree, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    this.worktrees.set(worktree, { branch, gitDir });
    this.lastBranch = branch;
    this.refs.add(`refs/heads/${branch}`);
  }
  onFirst?: () => Promise<void>;
  async run(command: string, args: string[], cwd: string): Promise<ShellResult> {
    if (this.onFirst) { const hook = this.onFirst; this.onFirst = undefined; await hook(); }
    if (command === "env") {
      expect(args[0]).toMatch(/GH_CONFIG_DIR=.*\/\.config\/gh-yahaha-bot$/);
      expect(args[1]).toBe("gh");
      command = "gh"; args = args.slice(2);
    }
    const line = `${command} ${args.join(" ")} @${cwd}`;
    this.calls.push(line);
    // `gh repo clone` makes the checkout Indra then moves into place.
    if (line.startsWith("gh repo clone")) await mkdir(join(args[3], ".git"), { recursive: true });
    if (line.startsWith("git show-ref")) return { code: this.refs.has(args.at(-1)!) ? 0 : 1, stdout: "", stderr: "" };
    if (line.startsWith("git worktree add")) {
      if (this.worktrees.has(args[5]) || this.refs.has(`refs/heads/${args[4]}`)) return { code: 128, stdout: "", stderr: "already exists" };
      await this.retain(args[5], args[4], join(cwd, ".git"));
    }
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: this.headSha, stderr: "" };
    if (line.startsWith("git rev-parse") && args.includes("MERGE_HEAD")) return { code: this.inspectCode ?? (this.unfinishedMerge ? 0 : 1), stdout: this.unfinishedMerge ? "a".repeat(40) : "", stderr: "" };
    if (line.startsWith("git rev-parse") && args.includes("--show-toplevel")) return { code: this.worktrees.has(cwd) ? 0 : 128, stdout: cwd, stderr: "" };
    if (line.startsWith("git rev-parse")) return { code: 0, stdout: this.worktrees.get(cwd)?.gitDir ?? join(cwd, ".git"), stderr: "" };
    if (line.startsWith("git symbolic-ref")) return { code: 0, stdout: `refs/heads/${this.worktrees.get(cwd)?.branch}`, stderr: "" };
    if (line.startsWith("git merge --abort")) {
      if (!this.abortCode) this.unfinishedMerge = false;
      return { code: this.abortCode, stdout: "", stderr: "" };
    }
    if (line.startsWith("gh api repos/satoramoto/indra/pulls/9 --method GET")) return { code: 0, stdout: JSON.stringify(this.maintenancePR), stderr: "" };
    if (line.startsWith("gh api") && args.includes("--paginate")) return { code: 0, stdout: JSON.stringify([this.comments]), stderr: "" };
    if (command === "gh" && args.join(" ") === "api user --jq .login") return { code: 0, stdout: "satori-miyamoto", stderr: "" };
    if (line.startsWith("gh api") && args.includes("POST")) {
      const body = JSON.parse(await readFile(args.at(-1)!, "utf8"));
      this.comments.push({ body: body.body, user: { login: "satori-miyamoto" }, commit_id: body.commit_id, state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED" });
    }
    if (line.startsWith("gh pr view") && args.includes("headRefOid")) return { code: 0, stdout: this.headSha, stderr: "" };
    if (line.startsWith("gh pr merge") && this.draft) return { code: 1, stdout: "", stderr: "GraphQL: Pull Request is still a draft (mergePullRequest)" };
    if (line.startsWith("gh pr merge")) {
      // Each merge attempt takes the next outcome; by default gh succeeds and the PR merges.
      const outcome = this.merges.shift() ?? { code: 0, stderr: "", merged: true };
      this.merged = outcome.merged;
      return { code: outcome.code, stdout: "", stderr: outcome.stderr };
    }
    if (line.startsWith("gh pr edit") && this.baseRef !== "release") this.baseRef = args.at(-1)!;
    if (line.startsWith("gh pr view") && args.includes("isDraft,headRefName,baseRefName,state")) return { code: 0, stdout: JSON.stringify({ isDraft: this.draft, headRefName: this.headRef ?? this.lastBranch,baseRefName: this.baseRef, state: this.merged ? "MERGED" : "OPEN" }), stderr: "" };
    if (line.startsWith("gh pr ready")) this.draft = false;
    if (line.startsWith("gh pr view") && args.includes("mergeable,mergeStateStatus")) return { code: 0, stdout: JSON.stringify(this.mainStatus.shift() ?? { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }), stderr: "" };
    if (line.startsWith("git merge --no-edit origin/")) {
      const code = this.unfinishedMerge ? 128 : this.mainMerges.shift() ?? 0;
      this.unfinishedMerge = code !== 0;
      return { code, stdout: "", stderr: "" };
    }
    if (line.startsWith("git merge-base --is-ancestor")) {
      const code = this.resolved.shift() ?? 0;
      if (!code) this.unfinishedMerge = false;
      return { code, stdout: "", stderr: "" };
    }
    if (line.startsWith("gh pr view")) return { code: 0, stdout: this.merged ? "MERGED\n" : "OPEN\n", stderr: "" };
    if (line.startsWith("gh pr checks")) return { code: this.checksCode, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}
class FakeCodex {
  runs: { cwd: string; sandbox: string[]; schema: string; sessionId?: string; prompt: string }[] = [];
  findings = ["src/foo.ts:12: Bug in foo"];
  afterFix?: () => void;
  keepFindings = false;
  fail = false;
  factory = (cwd: string, write?: WriteAccess): AgentRuntime => ({
    message: async (prompt: string, schema: string, sessionId?: string): Promise<AgentResult> => {
      // Record the sandbox arguments CodexRuntime would pass for this write access.
      this.runs.push({ cwd, sandbox: sandboxArgs(write), schema, sessionId, prompt });
      if (this.fail) throw new Error("codex down");
      if (prompt.includes("Outcome: every review finding")) { this.afterFix?.(); if (!this.keepFindings) this.findings = []; }
      const response = schema.endsWith("review.json") ? { findings: this.findings, summary: "Reviewed" } : { prUrl: PR, summary: "Done" };
      return { sessionId: `session-${this.runs.length}`, response, startedAt: "t0", finishedAt: "t1" };
    },
  });
}

async function setup(assignments: Assignment[], integration: object = SPRINT) {
  const store = await fixture(assignments, "approved", { github: "satoramoto/indra" }, integration);
  const chat = new FakeChat(); const shell = new FakeShell(); const codex = new FakeCodex();
  shell.baseRef = (integration as { branch?: string } | undefined)?.branch ?? "sprint/goal-abc";
  codex.afterFix = () => { shell.headSha = "b".repeat(40); };
  const identity = await loadDeveloperSeat(store, "seat-002");
  const make = () => Object.assign(new DeveloperSeat(store, identity, chat, shell, codex.factory), { mergeRetryMs: 0 });
  const assignment = async (id: string) => (await store.read()).planningGoals![0].assignments!.find((item) => item.outcomeId === id)!;
  return { store, chat, shell, codex, seat: make(), make, assignment };
}

async function retainRecord(store: PlanningStore, shell: FakeShell, changes: Partial<SeatTaskRecord> = {}) {
  const record: SeatTaskRecord = {
    goalId: "goal-abc", outcomeId: "outcome-1", step: "ci", branch: BRANCH,
    worktree: join(store.runtimeDir, "worktrees", "goal-abc-outcome-1"), gitDir: join(store.runtimeDir, "projects", "satoramoto", "indra", ".git"), prUrl: PR, sessions: [], ...changes,
  };
  await shell.retain(record.worktree, record.branch, record.gitDir!);
  await store.saveRuntime(RECORD, record);
  if (record.step === "ci") await postReviewOnce({ store, recordName: RECORD, prUrl: PR, worktree: record.worktree, shell, review: async () => ({ findings: [], summary: "Existing approval" }) });
  shell.calls = [];
  return record;
}

const reviewing = (): Assignment => ({ outcomeId: "outcome-1", seatId: "seat-002", status: "in-review", updatedAt: "2026-01-01T00:00:00Z", prUrl: PR });

describe("developer seat", () => {
  it.each([1, 128])("records a checked-command exit %s as a SeatError without command output", async (code) => {
    const { store, shell, codex, seat, chat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    const run = shell.run.bind(shell);
    const calls = vi.spyOn(shell, "run").mockImplementation(async (command, args, cwd) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "edit") return { code, stdout: "private stdout", stderr: "private stderr" };
      return await run(command, args, cwd);
    });
    await seat.tick();
    // The assignment handler preserves only SeatError/ProjectCheckoutError messages.
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: `build: gh pr edit failed (exit ${code}).` });
    const record = await store.readRuntimeFile<SeatTaskRecord>(RECORD);
    expect(calls).toHaveBeenCalledWith("gh", ["pr", "edit", PR, "--base", "sprint/goal-abc"], record!.worktree);
    expect(codex.runs).toHaveLength(1);
    expect(shell.calls.some((call) => call.startsWith("gh pr merge"))).toBe(false);
    expect(chat.messages.join("\n")).not.toMatch(/private stdout|private stderr/);
  });

  it("rechecks implement under the goal lock when release wins the claim race", async () => {
    const { store, shell, codex, seat } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    const lock = store.withGoalLock.bind(store);
    vi.spyOn(store, "withGoalLock").mockImplementationOnce((id, work) => lock(id, async () => {
      await store.update((state) => {
        const goal = state.planningGoals![0];
        Object.assign(goal.assignments![0], { status: "merged", prUrl: PR });
        goal.ceremony = advanceCeremony(goal, { to: "release", at: new Date().toISOString(), evidence: { kind: "implementation", outcomes: [{ outcomeId: "outcome-1", seatId: "seat-002", prUrl: PR, baseBranch: SPRINT.branch, mergedSha: "a".repeat(40), checksPassed: true, reviewApproved: true }] } });
      }, "Enter release before claim");
      return work();
    }));
    expect(await seat.tick()).toBe("idle");
    expect(shell.calls).toEqual([]); expect(codex.runs).toEqual([]);
    expect((await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read()).attempts).toEqual([]);
  });

  it("commits one claim when two runners select the same queued assignment", async () => {
    const { store, seat, make, codex } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    const lock = store.withGoalLock.bind(store);
    let entrants = 0; let release!: () => void;
    const both = new Promise<void>((done) => { release = done; });
    vi.spyOn(store, "withGoalLock").mockImplementation(async (id, work) => {
      if (++entrants <= 2) { if (entrants === 2) release(); await both; }
      return lock(id, work);
    });
    const results = await Promise.all([seat.tick(), make().tick()]);
    expect(results.sort()).toEqual(["idle", "worked"]);
    const facts = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(facts.attempts).toHaveLength(1);
    expect(codex.runs.filter((run) => run.prompt.includes("created from origin/"))).toHaveLength(1);
  });

  it("recovers a committed claim after interruption without a second attempt or lost start time", async () => {
    const { store, seat, make, codex } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementationOnce(async (...args) => { await update(...args); throw new Error("process stopped after claim"); });
    await expect(seat.tick()).rejects.toThrow("process stopped");
    const recorder = new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1");
    expect((await recorder.read()).attempts[0].claimedAt).toBeNull();
    vi.setSystemTime(new Date("2026-09-01T00:00:12Z"));
    await make().tick();
    await make().tick();
    const facts = await recorder.read();
    expect(facts.attempts).toHaveLength(1);
    expect(facts.attempts[0].claimedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(implementationWallTime(facts.attempts)).toEqual({ wallTimeMs: 12000, knownWallTimeMs: 12000, unknownIntervals: 0 });
  });

  it("recovers a recorded failure when the terminal state commit was interrupted", async () => {
    const { store, codex, seat, make, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.fail = true;
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation(async (...args) => {
      if (String(args[1]).endsWith(" failed")) throw new Error("state unavailable");
      await update(...args);
    });
    await expect(seat.tick()).rejects.toThrow("state unavailable");
    expect((await assignment("outcome-1")).status).toBe("running");
    const before = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    vi.restoreAllMocks(); codex.fail = false;
    await make().tick();
    expect(codex.runs).toHaveLength(1);
    expect((await assignment("outcome-1")).status).toBe("failed");
    const after = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].terminal).toEqual(before.attempts[0].terminal);
  });

  it("recovers a spent conflict round persisted before its mutable counter", async () => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()]);
    const record = await retainRecord(store, shell, { conflictRounds: 1 });
    const facts = new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1");
    record.attemptId = await facts.recover(record);
    await facts.event(record.attemptId, { kind: "conflict", result: "started", round: 2 });
    await store.saveRuntime(RECORD, record);
    shell.mainStatus = [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }]; shell.mainMerges = [1];
    await make().tick();
    expect(codex.runs).toEqual([]);
    expect((await assignment("outcome-1")).status).toBe("failed");
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(2);
  });

  it("records CI failure then explicit retry, excluding time queued between the attempts", async () => {
    const { store, shell, seat, make, codex } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    const time = (seconds: number) => vi.setSystemTime(new Date(Date.UTC(2026, 8, 1, 0, 0, seconds)));
    time(0); shell.onFirst = async () => { time(5); }; shell.checksCode = 1;
    await seat.tick();
    time(90);
    await store.update((state) => { Object.assign(state.planningGoals![0].assignments![0], { status: "queued", updatedAt: new Date().toISOString() }); }, "Explicit retry");
    time(100); shell.onFirst = async () => { time(107); }; shell.checksCode = 0;
    await make().tick();
    const facts = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(facts.attempts.map((item) => [item.cause, item.terminal?.status])).toEqual([["claim", "failed"], ["retry", "merged"]]);
    expect(facts.attempts[0].events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ci", result: "failed" })]));
    expect(implementationWallTime(facts.attempts)).toEqual({ wallTimeMs: 12000, knownWallTimeMs: 12000, unknownIntervals: 0 });
  });

  it.each(["checks", "merge"])("records a thrown %s failure before stopping the attempt", async (command) => {
    const { store, seat, shell, codex, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]); codex.findings = [];
    const run = shell.run.bind(shell);
    vi.spyOn(shell, "run").mockImplementation(async (...args) => {
      if (args[0] === "gh" && args[1][0] === "pr" && args[1][1] === command) throw new Error("private command diagnostics");
      return run(...args);
    });
    await seat.tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    const facts = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(facts.attempts[0].events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: command === "checks" ? "ci" : "merge", result: "failed" })]));
    expect(facts.attempts[0].terminal?.status).toBe("failed");
    expect(JSON.stringify(facts)).not.toContain("private command diagnostics");
  });

  it("does not merge while findings remain after fix sessions", async () => {
    const { seat, shell, codex, assignment, store } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.keepFindings = true;
    await seat.tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    expect(shell.calls.some((call) => call.startsWith("gh pr merge") || call.startsWith("gh pr checks"))).toBe(false);
    const facts = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(facts.attempts[0].events.filter((event) => event.kind === "fix" && event.result === "started")).toHaveLength(2);
    expect(facts.attempts[0].events.filter((event) => event.kind === "review").every((event) => event.verdict === "REQUEST_CHANGES")).toBe(true);
  });

  it("parses seat run and refuses a Team Lead or unknown seat", async () => {
    expect(parseOptions(["seat", "run", "--seat", "seat-002", "--state", "/tmp/s"])).toEqual({ mode: "seat", seatId: "seat-002", checkout: "/tmp/s" });
    expect(() => parseOptions(["seat", "run"])).toThrow("Usage:");
    const store = await fixture([]);
    await expect(loadDeveloperSeat(store, "seat-001")).rejects.toThrow("Team Lead");
    await expect(loadDeveloperSeat(store, "seat-999")).rejects.toThrow("not in state");
  });

  it("claims the oldest queued assignment, marks it running first, and runs build, fresh review, fix, CI and merge", async () => {
    const { store, chat, shell, codex, seat, assignment } = await setup([queued("outcome-2", "2026-01-02T00:00:00Z"), queued("outcome-1", "2026-01-01T00:00:00Z"), queued("outcome-3", "2025-12-01T00:00:00Z", "seat-003")]);
    let statusAtFirstCommand: string | undefined;
    shell.onFirst = async () => { statusAtFirstCommand = (await assignment("outcome-1")).status; };
    expect(await seat.tick()).toBe("worked");
    expect(statusAtFirstCommand).toBe("running");
    const done = await assignment("outcome-1");
    expect(done).toMatchObject({ status: "merged", prUrl: PR });
    expect((await assignment("outcome-2")).status).toBe("queued");
    expect((await assignment("outcome-3")).status).toBe("queued");
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    // Indra's own clone of the team's project, never a path from the owner or the goal.
    const project = join(store.runtimeDir, "projects", "satoramoto", "indra");
    expect(shell.calls[0]).toMatch(new RegExp(`^gh repo clone satoramoto/indra ${project}\\.[0-9a-f-]+\\.clone @${join(store.runtimeDir, "projects", "satoramoto")}$`));
    expect(shell.calls).toEqual(expect.arrayContaining([
      `git worktree add --no-track -b ${BRANCH} ${worktree} origin/sprint/goal-abc @${project}`,
      `gh pr edit ${PR} --base sprint/goal-abc @${worktree}`,
      `gh pr checks ${PR} --watch @${worktree}`,
      `gh pr merge ${PR} --squash --match-head-commit ${shell.headSha} @${project}`,
      `git worktree remove --force ${worktree} @${project}`,
    ]));
    expect(shell.comments.map((item) => item.state)).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
    // Three new sessions: none resumes another. Build and fix write with network; the reviewer is read-only.
    const write = ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", join(project, ".git")];
    expect(codex.runs.map((run) => [run.schema.split("/").at(-1), run.sessionId, run.sandbox])).toEqual([["developer.json", undefined, write], ["review.json", undefined, ["--sandbox", "read-only"]], ["developer.json", undefined, write], ["review.json", undefined, ["--sandbox", "read-only"]]]);
    expect(codex.runs[2].prompt).toContain("Bug in foo");
    // Each prompt is a contract: where to deliver, what Indra does next, the hard constraints and the schema; no method.
    const [build, review, fix] = codex.runs.map((run) => run.prompt);
    expect(build).toContain(`git push -u origin HEAD:refs/heads/${BRANCH}`);
    expect(build).toContain("gh pr create --base sprint/goal-abc");
    for (const prompt of [build, fix]) {
      expect(prompt).toMatch(/Do not merge/);
      expect(prompt).toMatch(/do not mark it ready or draft/);
      expect(prompt).toMatch(/Return only JSON: prUrl/);
      expect(prompt).toMatch(/Never put credentials/);
      expect(prompt).toMatch(/AGENTS\.md rules/);
    }
    expect(fix).toContain(`git push origin HEAD:refs/heads/${BRANCH}`);
    expect(review).toContain(PR);
    expect(review).toContain("AGENTS.md review checklist");
    expect(review).toMatch(/read-only without network/);
    expect(review).toMatch(/Return only JSON: findings/);
    for (const prompt of [build, review, fix]) expect(prompt).not.toMatch(/feedback loop|test:watch|once each|run the targeted tests/i);
    const record = JSON.parse(await readFile(join(store.runtimeDir, "seat-seat-002-goal-abc-outcome-1.json"), "utf8")) as SeatTaskRecord;
    expect(record.sessions.map((item) => [item.role, item.sessionId])).toEqual([["developer", "session-1"], ["reviewer", "session-2"], ["fix", "session-3"], ["reviewer", "session-4"]]);
    expect(await readFile(join(store.checkout, "state.json"), "utf8")).not.toContain("session-");
    expect(chat.messages.map((message) => message.split(" ")[0])).toEqual(["Claimed", "Opened", "Review", "Review", "Merged"]);
    expect(git(store.checkout, "log", "--format=%s").trim().split("\n").reverse()).toEqual([
      "Initial state",
      "Seat seat-002 claims goal-abc/outcome-1: running",
      "Seat seat-002 marks goal-abc/outcome-1 in-review",
      "Seat seat-002 marks goal-abc/outcome-1 merged",
    ]);
  });

  it("counts a merge as done when gh exits 1 but the PR is MERGED", async () => {
    const { shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    shell.merges = [{ code: 1, stderr: "failed to delete local branch", merged: true }];
    await seat.tick();
    expect((await assignment("outcome-1")).status).toBe("merged");
    expect(shell.calls.filter((call) => call.startsWith("gh pr merge"))).toHaveLength(1);
  });

  it("marks its own draft assignment PR ready before merging", async () => {
    const { store, shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    shell.draft = true;
    await seat.tick();
    const project = join(store.runtimeDir, "projects", "satoramoto", "indra");
    const ready = shell.calls.indexOf(`gh pr ready ${PR} @${project}`);
    expect(ready).toBeGreaterThan(0);
    expect(shell.calls[ready + 1]).toBe(`gh pr merge ${PR} --squash --match-head-commit ${shell.headSha} @${project}`);
    expect(shell.calls.filter((call) => call.startsWith("gh pr ready"))).toEqual([`gh pr ready ${PR} @${project}`]);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it.each([["headRef", "someone-else/branch"], ["baseRef", "release"]] as const)("neither readies nor merges a PR whose %s does not match the assignment", async (field, value) => {
    const { shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    shell.draft = true;
    shell[field] = value;
    await seat.tick();
    expect(shell.calls.some((call) => call.startsWith("gh pr ready") || call.startsWith("gh pr merge"))).toBe(false);
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: expect.stringContaining("not merging") });
  });

  it("retries a merge GitHub briefly refused", async () => {
    const { shell, seat, assignment, store } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    shell.merges = [{ code: 1, stderr: "Pull request is not mergeable", merged: false }, { code: 0, stderr: "", merged: true }];
    await seat.tick();
    expect((await assignment("outcome-1")).status).toBe("merged");
    expect(shell.calls.filter((call) => call.startsWith("gh pr merge"))).toHaveLength(2);
    const facts = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(facts.attempts[0].events.filter((event) => event.kind === "merge").map((event) => event.result)).toEqual(["started", "failed", "retry", "started", "passed"]);
  });

  it("fails a merge that never lands with a secret-free stderr excerpt", async () => {
    const { shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    const refused = { code: 1, stderr: "GraphQL: Pull request is not mergeable\n(token ghp_abc123SECRET)", merged: false };
    shell.merges = [refused, refused];
    await seat.tick();
    const failed = await assignment("outcome-1");
    expect(failed).toMatchObject({ status: "failed", note: "ci: gh pr merge failed; PR is not merged." });
    expect(shell.calls.some((call) => call.startsWith("git worktree remove"))).toBe(false);
  });

  const conflicting = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  const ownPush = (worktree: string) => `git -c credential.helper= -c credential.helper=!gh auth git-credential push origin HEAD:refs/heads/seat-002/goal-abc-outcome-1 @${worktree}`;
  const onlyOwnPushes = (calls: string[], worktree: string) => {
    const pushes = calls.filter((call) => call.includes(" push "));
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) expect(push).toBe(ownPush(worktree));
    expect(calls.some((call) => call.startsWith("git rebase") || call.includes(" rebase "))).toBe(false);
  };

  it("merges main into a PR that is behind, pushes its own branch, and waits for CI before merging", async () => {
    const { store, shell, codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    shell.mainStatus = [{ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }];
    await seat.tick();
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    const project = join(store.runtimeDir, "projects", "satoramoto", "indra");
    const ci = shell.calls.indexOf(`gh pr view ${PR} --json mergeable,mergeStateStatus @${project}`);
    expect(shell.calls).toEqual(expect.arrayContaining([
      `gh pr view ${PR} --json mergeable,mergeStateStatus @${project}`,
      `git -c credential.helper= -c credential.helper=!gh auth git-credential fetch origin main sprint/goal-abc @${project}`,
      `git merge --no-edit origin/sprint/goal-abc @${worktree}`,
      ownPush(worktree),
      `gh pr checks ${PR} --watch @${worktree}`,
      `gh pr view ${PR} --json isDraft,headRefName,baseRefName,state @${project}`,
      `gh pr merge ${PR} --squash --match-head-commit ${shell.headSha} @${project}`,
    ]));
    onlyOwnPushes(shell.calls, worktree);
    expect(codex.runs).toHaveLength(2);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it("resolves a conflict with sprint/goal-abc in one write-access Codex session, then pushes, waits for CI and merges", async () => {
    const { store, chat, shell, codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1];
    await seat.tick();
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    const conflictAt = shell.calls.indexOf(`git merge --no-edit origin/sprint/goal-abc @${worktree}`);
    expect(shell.calls).toEqual(expect.arrayContaining([
      `git merge-base --is-ancestor origin/sprint/goal-abc HEAD @${worktree}`,
      ownPush(worktree),
      `gh pr checks ${PR} --watch @${worktree}`,
      `gh pr view ${PR} --json isDraft,headRefName,baseRefName,state @${join(store.runtimeDir, "projects", "satoramoto", "indra")}`,
      `gh pr merge ${PR} --squash --match-head-commit ${shell.headSha} @${join(store.runtimeDir, "projects", "satoramoto", "indra")}`,
    ]));
    onlyOwnPushes(shell.calls, worktree);
    const write = ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", join(store.runtimeDir, "projects", "satoramoto", "indra", ".git")];
    expect(codex.runs).toHaveLength(3);
    expect(codex.runs[2]).toMatchObject({ cwd: worktree, sandbox: write, sessionId: undefined });
    expect(codex.runs[2].prompt).toContain("keeping the intent of both sides");
    expect(codex.runs[2].prompt).toContain("origin/sprint/goal-abc is an ancestor of HEAD");
    expect(codex.runs[2].prompt).toMatch(/Do not push or merge/);
    expect(codex.runs[2].prompt).toMatch(/do not rebase, reset, force-push or abort the merge/);
    expect(codex.runs[2].prompt).toMatch(/Return only JSON: prUrl/);
    expect(codex.runs[2].prompt).not.toMatch(/once each|run the same targeted tests/i);
    expect(chat.messages.some((message) => message.includes("conflicts with sprint/goal-abc; resolving (round 1 of 2)"))).toBe(true);
    expect((await assignment("outcome-1")).status).toBe("merged");
    const record = JSON.parse(await readFile(join(store.runtimeDir, "seat-seat-002-goal-abc-outcome-1.json"), "utf8")) as SeatTaskRecord;
    expect(record.conflictRounds).toBe(1);
  });

  it("in a sprint, starts from the sprint branch, targets it with its PR, and merges the sprint branch in when behind or conflicting", async () => {
    const { store, chat, shell, codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")], SPRINT);
    codex.findings = [];
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1];
    await seat.tick();
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    const project = join(store.runtimeDir, "projects", "satoramoto", "indra");
    const fetch = `git -c credential.helper= -c credential.helper=!gh auth git-credential fetch origin main sprint/goal-abc @${project}`;
    expect(shell.calls).toEqual(expect.arrayContaining([fetch, `git rev-parse --path-format=absolute --git-common-dir @${project}`, `git worktree add --no-track -b seat-002/goal-abc-outcome-1 ${worktree} origin/sprint/goal-abc @${project}`]));
    expect(codex.runs[0].prompt).toContain("gh pr create --base sprint/goal-abc");
    expect(shell.calls).toContain(`gh pr edit ${PR} --base sprint/goal-abc @${worktree}`);
    const conflictAt = shell.calls.indexOf(`git merge --no-edit origin/sprint/goal-abc @${worktree}`);
    expect(shell.calls[conflictAt - 1]).toBe(fetch);
    expect(shell.calls.slice(conflictAt + 1, conflictAt + 3)).toEqual([`git merge-base --is-ancestor origin/sprint/goal-abc HEAD @${worktree}`, ownPush(worktree)]);
    expect(codex.runs[2].prompt).toContain("Merging origin/sprint/goal-abc into this worktree");
    expect(chat.messages.some((message) => message.includes("conflicts with sprint/goal-abc; resolving"))).toBe(true);
    expect(shell.calls.some((line) => line.includes("origin/main") || line.includes("refs/heads/main"))).toBe(false);
    onlyOwnPushes(shell.calls, worktree);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it("does not claim a sprint's queued outcome once its integration PR is open", async () => {
    const { seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")], { ...SPRINT, status: "pr-open", prUrl: "https://github.com/satoramoto/indra/pull/50" });
    expect(await seat.tick()).toBe("idle");
    expect((await assignment("outcome-1")).status).toBe("queued");
  });

  it("fails with a clear note when main still conflicts after two resolution rounds", async () => {
    const { store, chat, shell, codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    // Each round resolves, but main moves on and conflicts again when the merge is attempted.
    shell.mainStatus = [conflicting, conflicting, conflicting];
    shell.mainMerges = [1, 1, 1];
    const refused = { code: 1, stderr: "Pull request is not mergeable", merged: false };
    shell.merges = [refused, refused, refused, refused];
    await seat.tick();
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "ci: merge conflict with sprint/goal-abc could not be resolved" });
    expect(chat.messages.at(-1)).toContain("merge conflict with sprint/goal-abc could not be resolved");
    expect(codex.runs.filter((run) => run.prompt.includes("stopped with conflicts"))).toHaveLength(2);
    expect(shell.calls.filter((call) => call.startsWith("gh pr checks"))).toHaveLength(2);
    expect(shell.calls.at(-1)).toBe(`git merge --abort @${worktree}`);
    onlyOwnPushes(shell.calls, worktree);
  });

  it("leaves an unmigrated goal without a team project idle", async () => {
    const store = await fixture([queued("outcome-1", "2026-01-01T00:00:00Z")], "approved", null);
    const shell = new FakeShell(); const codex = new FakeCodex();
    await new DeveloperSeat(store, await loadDeveloperSeat(store, "seat-002"), new FakeChat(), shell, codex.factory).tick();
    expect((await store.read()).planningGoals![0].assignments![0]).toMatchObject({ status: "queued" });
    expect(shell.calls).toEqual([]);
    expect(codex.runs).toHaveLength(0);
  });

  it("clones the project once and fetches it before each new worktree", async () => {
    const { shell, seat } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z"), queued("outcome-2", "2026-01-02T00:00:00Z")]);
    await seat.tick();
    await seat.tick();
    expect(shell.calls.filter((call) => call.startsWith("gh repo clone"))).toHaveLength(1);
    expect(shell.calls.filter((call) => call.includes(" fetch origin main "))).toHaveLength(2);
  });

  it("skips the fix session when the reviewer has no findings", async () => {
    const { codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    await seat.tick();
    expect(codex.runs).toHaveLength(2);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it("marks a CI failure failed with a note, keeps the worktree, and goes idle before taking the next one", async () => {
    const { chat, shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z"), queued("outcome-2", "2026-01-02T00:00:00Z")]);
    shell.checksCode = 1;
    await seat.tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", prUrl: PR, note: `ci: CI did not pass on ${PR}.` });
    expect(shell.calls.some((call) => call.startsWith("gh pr merge") || call.startsWith("git worktree remove"))).toBe(false);
    expect((await assignment("outcome-2")).status).toBe("queued");
    expect(chat.messages.at(-1)).toContain("Failed");
    shell.checksCode = 0;
    await seat.tick();
    expect((await assignment("outcome-2")).status).toBe("merged");
    expect(await seat.tick()).toBe("idle");
  });

  it("keeps reported usage for a failed agent session without storing its diagnostics", async () => {
    const { store, codex, make, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.factory = () => ({ message: async () => { throw new AgentRunError("private diagnostics", { invocationId: "failed-run", engine: "codex", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:05Z", status: "failed", usage: { inputTokens: 42, outputTokens: 7 } }); } });
    await make().tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    const facts = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(facts.attempts[0].events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "session", session: expect.objectContaining({ invocationId: "failed-run", status: "failed", usage: { inputTokens: 42, outputTokens: 7 } }) })]));
    expect(JSON.stringify(facts)).not.toContain("private diagnostics");
    expect(await readFile(join(store.checkout, "state.json"), "utf8")).not.toContain("failed-run");
  });

  it("says a session timed out, and after how long, in the assignment note", async () => {
    const { codex, make, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.factory = () => ({ message: async () => { throw new AgentRunError("Codex run timed out after 60 min.", { invocationId: "slow-run", engine: "codex", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T01:00:02Z", status: "timed-out" }); } });
    await make().tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "build: Agent developer session timed out after 60 min." });
  });

  it("fails on an agent error using runtime-neutral wording without recording its output", async () => {
    const { codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.fail = true;
    await seat.tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "build: Agent developer session failed." });
  });

  it("rejects assignments on unapproved goals and leaves other seats' work alone", async () => {
    const unapproved = await fixture([queued("outcome-1", "2026-01-01T00:00:00Z")], "awaiting-review");
    await expect(unapproved.read()).rejects.toThrow("only at approved stage");
    const { seat, store: approved } = await setup([queued("outcome-3", "2026-01-01T00:00:00Z", "seat-003")]);
    expect(await seat.tick()).toBe("idle");
    expect((await approved.read()).planningGoals![0].assignments![0].status).toBe("queued");
  });

  it("on restart resumes an in-review assignment from its recorded step instead of claiming another", async () => {
    const { store, codex, shell, make, assignment } = await setup([{ outcomeId: "outcome-1", seatId: "seat-002", status: "in-review", updatedAt: "2026-01-01T00:00:00Z", prUrl: PR }, queued("outcome-2", "2025-01-01T00:00:00Z")]);
    await retainRecord(store, shell);
    await make().tick();
    expect(codex.runs).toHaveLength(0);
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect((await assignment("outcome-1")).status).toBe("merged");
    expect((await assignment("outcome-2")).status).toBe("queued");
  });

  it.each([undefined, SPRINT])("aborts a stale merge before retrying its base without using a conflict round (%j)", async (integration) => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()], integration);
    const record = await retainRecord(store, shell, { conflictRounds: 2 });
    shell.unfinishedMerge = true;
    shell.mainStatus = [conflicting];
    await make().tick();
    const aborted = shell.calls.indexOf(`git merge --abort @${record.worktree}`);
    const merged = shell.calls.indexOf(`git merge --no-edit origin/${integration?.branch ?? "sprint/goal-abc"} @${record.worktree}`);
    expect(aborted).toBeGreaterThan(shell.calls.indexOf(`git symbolic-ref --quiet HEAD @${record.worktree}`));
    expect(merged).toBeGreaterThan(aborted);
    expect(shell.calls.filter((call) => call.startsWith("git merge --abort"))).toHaveLength(1);
    expect(codex.runs).toHaveLength(0);
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(2);
    expect((await assignment("outcome-1")).status).toBe("merged");
    if (integration) expect(shell.calls.some((call) => call.includes("origin/main"))).toBe(false);
    onlyOwnPushes(shell.calls, record.worktree);
  });

  it("leaves a clean resumed worktree alone", async () => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()]);
    await retainRecord(store, shell, { conflictRounds: 1 });
    await make().tick();
    expect(shell.calls.some((call) => call.startsWith("git merge --abort"))).toBe(false);
    expect(codex.runs).toHaveLength(0);
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(1);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it.each(["abort", "inspect"])("stops resumed work when merge %s fails", async (failure) => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()], SPRINT);
    await retainRecord(store, shell, { conflictRounds: 1 });
    shell.unfinishedMerge = true;
    shell.abortCode = failure === "abort" ? 1 : 0;
    shell.inspectCode = failure === "inspect" ? 128 : undefined;
    shell.mainStatus = [conflicting];
    await make().tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: failure === "abort" ? "ci: git merge --abort failed (exit 1)." : "ci: Could not inspect unfinished merge." });
    expect(shell.calls.some((call) => call.startsWith("git merge --no-edit") || call.startsWith("gh ") || call.includes(" push "))).toBe(false);
    expect(codex.runs).toHaveLength(0);
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(1);
  });

  it.each(["branch", "project", "path", "assignment"])("does not abort or run sessions when the saved %s is not owned", async (mismatch) => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()]);
    const record = await retainRecord(store, shell);
    shell.unfinishedMerge = true;
    const checkout = shell.worktrees.get(record.worktree)!;
    if (mismatch === "branch") checkout.branch = "someone-elses-branch";
    if (mismatch === "project") { checkout.gitDir = join(store.runtimeDir, "other", ".git"); await mkdir(checkout.gitDir, { recursive: true }); }
    if (mismatch === "path") record.worktree = join(store.runtimeDir, "worktrees", "someone-else");
    if (mismatch === "assignment") record.outcomeId = "outcome-2";
    await store.saveRuntime(RECORD, record);
    await make().tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    expect(shell.calls.some((call) => call.startsWith("git merge") || call.startsWith("gh "))).toBe(false);
    expect(codex.runs).toHaveLength(0);
  });

  it("counts only the genuine conflict after recovering an interrupted merge", async () => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()], SPRINT);
    await retainRecord(store, shell, { conflictRounds: 1 });
    shell.unfinishedMerge = true;
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1];
    await make().tick();
    expect(codex.runs).toHaveLength(1);
    expect(codex.runs[0].prompt).toContain("Merging origin/sprint/goal-abc");
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(2);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it("does not retry a genuine conflict when aborting its unresolved merge fails", async () => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()]);
    await retainRecord(store, shell);
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1];
    shell.resolved = [1];
    shell.abortCode = 1;
    await make().tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "ci: git merge --abort failed (exit 1)." });
    expect(shell.calls.filter((call) => call.startsWith("git merge --no-edit"))).toHaveLength(1);
    expect(shell.calls.some((call) => call.includes(" push ") || call.startsWith("gh pr checks"))).toBe(false);
    expect(codex.runs).toHaveLength(1);
  });

  it("re-queues failed CI using its existing PR, branch, worktree and runtime history", async () => {
    const { store, shell, codex, seat, make, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")], SPRINT);
    shell.checksCode = 1;
    await seat.tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    const saved = (await store.readRuntimeFile<SeatTaskRecord>(RECORD))!;
    await store.update((state) => { state.planningGoals![0].assignments![0].status = "queued"; }, "Re-queue failed assignment");
    shell.checksCode = 0;
    shell.calls = [];
    const sessions = codex.runs.length;
    shell.onFirst = async () => { expect(await assignment("outcome-1")).toMatchObject({ status: "running", prUrl: PR }); };
    await make().tick();
    const resumed = (await store.readRuntimeFile<SeatTaskRecord>(RECORD))!;
    expect(resumed).toMatchObject({ branch: saved.branch, worktree: saved.worktree, prUrl: PR, sessions: saved.sessions });
    expect(codex.runs).toHaveLength(sessions);
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect(await assignment("outcome-1")).toMatchObject({ status: "merged", prUrl: PR });
  });

  it.each([undefined, SPRINT])("grants a fresh conflict budget when a failed assignment is explicitly re-queued (%j)", async (integration) => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()], integration);
    await retainRecord(store, shell);
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1, 1];
    shell.resolved = [1, 1];
    await make().tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    const saved = (await store.readRuntimeFile<SeatTaskRecord>(RECORD))!;
    expect(saved.conflictRounds).toBe(2);
    expect(codex.runs).toHaveLength(2);

    await store.update((state) => { state.planningGoals![0].assignments![0].status = "queued"; }, "Re-queue failed assignment");
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1, 1];
    shell.resolved = [1, 0];
    shell.onFirst = async () => { expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(0); };
    await make().tick();

    const retried = (await store.readRuntimeFile<SeatTaskRecord>(RECORD))!;
    expect(retried).toMatchObject({ branch: saved.branch, worktree: saved.worktree, prUrl: PR, conflictRounds: 2 });
    expect(retried.sessions).toHaveLength(4);
    expect(retried.sessions.slice(0, 2)).toEqual(saved.sessions);
    const history = await new ImplementationRecorder(store, "seat-002", "goal-abc", "outcome-1").read();
    expect(history.attempts).toHaveLength(2);
    expect(history.attempts[0].terminal?.status).toBe("failed");
    expect(history.attempts[0].events.some((event) => event.retained?.conflictRounds === 2)).toBe(true);
    expect(history.attempts[1].events.filter((event) => event.kind === "conflict" && event.result === "started").map((event) => event.round)).toEqual([1, 2]);
    expect(codex.runs).toHaveLength(4);
    for (const run of codex.runs.slice(2)) expect(run.prompt).toContain(`Merging origin/${integration?.branch ?? "sprint/goal-abc"}`);
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect(await assignment("outcome-1")).toMatchObject({ status: "merged", prUrl: PR });
  });

  it.each(["running", "in-review"] as const)("preserves an exhausted conflict budget when a %s assignment restarts", async (status) => {
    const { store, shell, codex, make, assignment } = await setup([{ ...reviewing(), status }], SPRINT);
    await retainRecord(store, shell, { conflictRounds: 2 });
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1];
    await make().tick();
    expect(codex.runs).toHaveLength(0);
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(2);
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "ci: merge conflict with sprint/goal-abc could not be resolved" });
    expect(shell.calls.some((call) => call.includes(" push ") || call.startsWith("gh pr merge"))).toBe(false);
  });

  it.each(["worktree", "build"] as const)("re-queues a saved %s step without colliding with its existing checkout", async (step) => {
    const { store, shell, codex, make, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    const record = await retainRecord(store, shell, { step, prUrl: undefined });
    await writeFile(join(record.worktree, "retained.txt"), "unfinished work");
    codex.fail = true;
    await make().tick();
    expect(codex.runs).toHaveLength(1);
    expect(codex.runs[0].cwd).toBe(record.worktree);
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect(await readFile(join(record.worktree, "retained.txt"), "utf8")).toBe("unfinished work");
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "build: Agent developer session failed." });
  });

  it.each(["worktree", "branch", "remote branch"])("starts a collision-free re-queue when runtime is absent but a retained %s exists", async (retained) => {
    const { store, shell, codex, make, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")], SPRINT);
    const original = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    if (retained === "worktree") { await mkdir(original, { recursive: true }); await writeFile(join(original, "retained.txt"), "unfinished work"); }
    else shell.refs.add(`${retained === "branch" ? "refs/heads" : "refs/remotes/origin"}/${BRANCH}`);
    await make().tick();
    const record = (await store.readRuntimeFile<SeatTaskRecord>(RECORD))!;
    expect(record.branch).toMatch(/^seat-002\/goal-abc-outcome-1-attempt-[0-9a-f-]{36}$/);
    expect(record.worktree).not.toBe(original);
    expect(codex.runs[0].cwd).toBe(record.worktree);
    expect(shell.calls).toContain(`git worktree add --no-track -b ${record.branch} ${record.worktree} origin/sprint/goal-abc @${join(store.runtimeDir, "projects", "satoramoto", "indra")}`);
    expect(shell.calls.some((call) => call.startsWith(`git worktree remove --force ${original} @`) || call.startsWith(`git branch -D ${BRANCH} @`))).toBe(false);
    if (retained === "worktree") expect(await readFile(join(original, "retained.txt"), "utf8")).toBe("unfinished work");
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it.each(["missing", "unusable"])("can re-queue a replacement attempt again when an old PR has %s runtime", async (runtime) => {
    const oldPR = "https://github.com/satoramoto/indra/pull/8";
    const { store, shell, codex, make, assignment } = await setup([{ ...queued("outcome-1", "2026-01-01T00:00:00Z"), prUrl: oldPR }], SPRINT);
    if (runtime === "unusable") await retainRecord(store, shell, { outcomeId: "outcome-2", prUrl: oldPR });
    else shell.refs.add(`refs/heads/${BRANCH}`);
    codex.fail = true;
    await make().tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", prUrl: oldPR, note: "build: Agent developer session failed." });
    const attempt = (await store.readRuntimeFile<SeatTaskRecord>(RECORD))!;
    expect(attempt.branch).not.toBe(BRANCH);
    expect(attempt.retainedPrUrl).toBe(oldPR);
    await store.update((state) => { state.planningGoals![0].assignments![0].status = "queued"; }, "Re-queue replacement attempt");
    codex.fail = false;
    shell.calls = [];
    await make().tick();
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect(codex.runs[1].cwd).toBe(attempt.worktree);
    expect(await assignment("outcome-1")).toMatchObject({ status: "merged", prUrl: PR });
    expect(await store.readRuntimeFile<SeatTaskRecord>(RECORD)).toMatchObject({ branch: attempt.branch, worktree: attempt.worktree, retainedPrUrl: oldPR, prUrl: PR });
  });

  it("resumes a replacement PR saved just before the assignment's PR URL was updated", async () => {
    const oldPR = "https://github.com/satoramoto/indra/pull/8";
    const { store, shell, codex, make, assignment } = await setup([{ ...reviewing(), status: "running", prUrl: oldPR }]);
    await retainRecord(store, shell, { step: "review", retainedPrUrl: oldPR });
    codex.findings = [];
    await make().tick();
    expect(codex.runs).toHaveLength(1);
    expect(codex.runs[0].schema).toMatch(/review.json$/);
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect(await assignment("outcome-1")).toMatchObject({ status: "merged", prUrl: PR });
  });

  it("reuses the review helper after a restart between posting findings and advancing the step", async () => {
    const { store, shell, codex, make, assignment } = await setup([reviewing()]);
    await retainRecord(store, shell, { step: "review" });
    const save = store.saveRuntime.bind(store);
    let interrupt = true;
    vi.spyOn(store, "saveRuntime").mockImplementation(async (name, runtime) => {
      if (name === RECORD && (runtime as SeatTaskRecord).step === "fix" && interrupt) { interrupt = false; throw new Error("interrupted"); }
      await save(name, runtime);
    });
    await make().tick();
    expect((await assignment("outcome-1")).status).toBe("failed");
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.step).toBe("review");
    await store.update((state) => { state.planningGoals![0].assignments![0].status = "queued"; }, "Re-queue interrupted review");
    await make().tick();
    expect(shell.comments.map((item) => item.state)).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
    expect(codex.runs.filter((run) => run.schema.endsWith("review.json"))).toHaveLength(2);
    expect(codex.runs.find((run) => run.prompt.includes("Outcome: every review finding"))?.prompt).toContain("Bug in foo");
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it("aborts a real Git merge only in the verified worktree and preserves retained files", async () => {
    const { store, shell, codex, chat, assignment } = await setup([reviewing()], SPRINT);
    const record = await retainRecord(store, shell, { conflictRounds: 2 });
    const project = join(store.runtimeDir, "projects", "satoramoto", "indra");
    git(project, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(project, "file.txt"), "base\n");
    git(project, "add", "file.txt"); git(project, "commit", "--quiet", "-m", "Base");
    git(project, "worktree", "add", "--quiet", "-b", BRANCH, record.worktree);
    await writeFile(join(record.worktree, "file.txt"), "ours\n");
    git(record.worktree, "commit", "--quiet", "-am", "Seat work");
    await writeFile(join(project, "file.txt"), "theirs\n");
    git(project, "commit", "--quiet", "-am", "Sprint work");
    git(project, "update-ref", "refs/remotes/origin/sprint/goal-abc", "HEAD");
    const conflict = await processShell.run("git", ["merge", "--no-edit", "origin/sprint/goal-abc"], record.worktree);
    expect(conflict.code).toBe(1);
    await writeFile(join(record.worktree, "retained.txt"), "unfinished work");
    shell.checksCode = 1; // Keep the worktree available for inspection after recovery.
    const commands: string[] = [];
    const realGit: Shell = { run: async (command, args, cwd) => {
      commands.push(`${command} ${args.join(" ")} @${cwd}`);
      return command === "git" ? processShell.run(command, args, cwd) : shell.run(command, args, cwd);
    } };
    await new DeveloperSeat(store, await loadDeveloperSeat(store, "seat-002"), chat, realGit, codex.factory).tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: `ci: CI did not pass on ${PR}.` });
    expect(commands.filter((call) => call.startsWith("git merge --abort"))).toEqual([`git merge --abort @${record.worktree}`]);
    expect((await processShell.run("git", ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], record.worktree)).code).toBe(1);
    expect(await readFile(join(record.worktree, "file.txt"), "utf8")).toBe("ours\n");
    expect(await readFile(join(record.worktree, "retained.txt"), "utf8")).toBe("unfinished work");
    expect(await readFile(join(project, "file.txt"), "utf8")).toBe("theirs\n");
    expect((await store.readRuntimeFile<SeatTaskRecord>(RECORD))?.conflictRounds).toBe(2);
  });

  it("on restart fails a running assignment that never opened a PR, then takes the next one on a later tick", async () => {
    const { codex, make, assignment } = await setup([{ outcomeId: "outcome-1", seatId: "seat-002", status: "running", updatedAt: "2026-01-01T00:00:00Z" }, queued("outcome-2", "2025-01-01T00:00:00Z")]);
    const seat = make();
    await seat.tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "Interrupted without a usable assignment record; not resumed." });
    expect((await assignment("outcome-2")).status).toBe("queued");
    expect(codex.runs).toHaveLength(0);
    await seat.tick();
    expect((await assignment("outcome-2")).status).toBe("merged");
  });

  it.each([false, true])("reconciles a failed merged assignment without execution or checkouts (persistence failure: %s)", async (persistenceFailure) => {
    const { store, shell, codex, chat, seat, assignment } = await setup([
      { ...reviewing(), status: "failed", note: "ci: interrupted" }, queued("outcome-2", "2026-01-02T00:00:00Z"),
    ], SPRINT);
    const record = await retainRecord(store, shell);
    await rm(record.worktree, { recursive: true });
    await rm(join(store.runtimeDir, "projects"), { recursive: true });
    shell.maintenancePR = {
      html_url: PR, number: 9, state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z",
      base: { ref: SPRINT.branch, repo: { full_name: "satoramoto/indra" } }, head: { ref: BRANCH, repo: { full_name: "satoramoto/indra" } },
    };
    if (persistenceFailure) vi.spyOn(store, "update").mockRejectedValueOnce(new Error("state unavailable"));
    expect(await seat.tick()).toBe("worked");
    expect(await assignment("outcome-1")).toMatchObject({ status: persistenceFailure ? "failed" : "merged", prUrl: PR });
    expect((await assignment("outcome-1")).note).toBe(persistenceFailure ? "ci: interrupted" : undefined);
    expect((await assignment("outcome-2")).status).toBe("queued");
    expect(shell.calls).toEqual([`gh api repos/satoramoto/indra/pulls/9 --method GET @${store.checkout}`]);
    expect(codex.runs).toHaveLength(0);
    expect(chat.messages).toHaveLength(0);
  });

  it.each(["runtime-save", "post", "activity-save", "cleanup", "post-commit"])("never regresses a durably merged assignment after %s failure", async (failure) => {
    const { store, shell, codex, chat, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    const save = store.saveRuntime.bind(store);
    vi.spyOn(store, "saveRuntime").mockImplementation(async (name, runtime) => {
      if (failure === "runtime-save" && name === RECORD && (runtime as SeatTaskRecord).step === "done") throw new Error("runtime save failed");
      if (failure === "activity-save" && "message" in runtime && String(runtime.message).startsWith("Merged")) throw new Error("activity save failed");
      await save(name, runtime);
    });
    const post = chat.post.bind(chat);
    vi.spyOn(chat, "post").mockImplementation(async (...args) => {
      if (failure === "post" && args[1].startsWith("Merged")) throw new Error("post failed");
      return post(...args);
    });
    const run = shell.run.bind(shell);
    vi.spyOn(shell, "run").mockImplementation(async (...args) => {
      if (failure === "cleanup" && args[0] === "gh" && args[1].includes("DELETE")) throw new Error("cleanup failed");
      return run(...args);
    });
    const update = store.update.bind(store);
    let rejected = false;
    vi.spyOn(store, "update").mockImplementation(async (...args) => {
      await update(...args);
      if (failure === "post-commit" && !rejected && String(args[1]).endsWith(" merged")) { rejected = true; throw new Error("commit cleanup failed"); }
    });
    await seat.tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "merged", prUrl: PR });
    expect((await assignment("outcome-1")).note).toBeUndefined();
    expect(JSON.parse(git(store.checkout, "show", "HEAD:state.json")).planningGoals[0].assignments[0].status).toBe("merged");
    expect(chat.messages.some((message) => message.startsWith("Failed"))).toBe(false);
    const calls = [...shell.calls]; const sessions = codex.runs.length;
    expect(await seat.tick()).toBe("idle");
    expect(shell.calls).toEqual(calls);
    expect(codex.runs).toHaveLength(sessions);
  });
});
