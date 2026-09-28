import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, stateCheckout } from "./state-checkout.js";
import { PlanningStore } from "../src/planning.js";
import { DeveloperSeat, loadDeveloperSeat, processShell, type SeatChat, type SeatTaskRecord, type Shell, type ShellResult } from "../src/developer-seat.js";
import { sandboxArgs, type AgentResult, type AgentRuntime, type WriteAccess } from "../src/codex-runtime.js";
import type { PlanningAssignment as Assignment } from "../src/planning.js";
import { parseOptions } from "../src/cli.js";

const PR = "https://github.com/satoramoto/indra/pull/9";
const BRANCH = "seat-002/goal-abc-outcome-1";
const RECORD = "seat-seat-002-goal-abc-outcome-1";
const seat = (id: string, name: string, roles: string[]) => ({ id, displayName: name, roles, externalIdentities: { mattermost: { userId: id, username: name.toLowerCase() } } });

const SPRINT = { branch: "sprint/goal-abc", baseSha: "a".repeat(40), status: "collecting" };
async function fixture(assignments: Assignment[], stage = "approved", project: { github: string } | null = { github: "satoramoto/indra" }, integration?: object) {
  const goal = {
    id: "goal-abc", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Build it", projectRefs: ["/proj"], stage,
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
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [goal], teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", ...(project ? { project } : {}), externalIdentities: { mattermost: { teamId: "team" } }, seats: [seat("seat-001", "Chick", ["Team Lead"]), seat("seat-002", "George", ["Developer"]), seat("seat-003", "Herbie", ["Developer"])] }] };
  return new PlanningStore(await stateCheckout("indra-seat-", state));
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
  baseRef = "main";
  /** Each mergeability check takes the next status; by default the PR is current with main. */
  mainStatus: { mergeable: string; mergeStateStatus: string }[] = [];
  /** Each `git merge origin/main` takes the next exit code (1 = conflicts); by default it merges cleanly. */
  mainMerges: number[] = [];
  /** Each "is origin/main merged into HEAD" check takes the next exit code; by default it is. */
  resolved: number[] = [];
  refs = new Set<string>();
  worktrees = new Map<string, { branch: string; gitDir: string }>();
  unfinishedMerge = false;
  inspectCode?: number;
  abortCode = 0;
  comments: { body: string }[] = [];
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
    const line = `${command} ${args.join(" ")} @${cwd}`;
    this.calls.push(line);
    // `gh repo clone` makes the checkout Indra then moves into place.
    if (line.startsWith("gh repo clone")) await mkdir(join(args[3], ".git"), { recursive: true });
    if (line.startsWith("git show-ref")) return { code: this.refs.has(args.at(-1)!) ? 0 : 1, stdout: "", stderr: "" };
    if (line.startsWith("git worktree add")) {
      if (this.worktrees.has(args[5]) || this.refs.has(`refs/heads/${args[4]}`)) return { code: 128, stdout: "", stderr: "already exists" };
      await this.retain(args[5], args[4], join(cwd, ".git"));
    }
    if (line.startsWith("git rev-parse") && args.includes("MERGE_HEAD")) return { code: this.inspectCode ?? (this.unfinishedMerge ? 0 : 1), stdout: this.unfinishedMerge ? "a".repeat(40) : "", stderr: "" };
    if (line.startsWith("git rev-parse") && args.includes("--show-toplevel")) return { code: this.worktrees.has(cwd) ? 0 : 128, stdout: cwd, stderr: "" };
    if (line.startsWith("git rev-parse")) return { code: 0, stdout: this.worktrees.get(cwd)?.gitDir ?? join(cwd, ".git"), stderr: "" };
    if (line.startsWith("git symbolic-ref")) return { code: 0, stdout: `refs/heads/${this.worktrees.get(cwd)?.branch}`, stderr: "" };
    if (line.startsWith("git merge --abort")) {
      if (!this.abortCode) this.unfinishedMerge = false;
      return { code: this.abortCode, stdout: "", stderr: "" };
    }
    if (line.startsWith("gh api") && args.includes("--paginate")) return { code: 0, stdout: JSON.stringify([this.comments]), stderr: "" };
    if (line.startsWith("gh pr comment")) this.comments.push({ body: args.at(-1)! });
    if (line.startsWith("gh pr merge") && this.draft) return { code: 1, stdout: "", stderr: "GraphQL: Pull Request is still a draft (mergePullRequest)" };
    if (line.startsWith("gh pr merge")) {
      // Each merge attempt takes the next outcome; by default gh succeeds and the PR merges.
      const outcome = this.merges.shift() ?? { code: 0, stderr: "", merged: true };
      this.merged = outcome.merged;
      return { code: outcome.code, stdout: "", stderr: outcome.stderr };
    }
    if (line.startsWith("gh pr edit")) this.baseRef = args.at(-1)!;
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
  findings = ["Bug in foo"];
  fail = false;
  factory = (cwd: string, write?: WriteAccess): AgentRuntime => ({
    message: async (prompt: string, schema: string, sessionId?: string): Promise<AgentResult> => {
      // Record the sandbox arguments CodexRuntime would pass for this write access.
      this.runs.push({ cwd, sandbox: sandboxArgs(write), schema, sessionId, prompt });
      if (this.fail) throw new Error("codex down");
      const response = schema.endsWith("review.json") ? { findings: this.findings, summary: "Reviewed" } : { prUrl: PR, summary: "Done" };
      return { sessionId: `session-${this.runs.length}`, response, startedAt: "t0", finishedAt: "t1" };
    },
  });
}

async function setup(assignments: Assignment[], integration?: object) {
  const store = await fixture(assignments, "approved", { github: "satoramoto/indra" }, integration);
  const chat = new FakeChat(); const shell = new FakeShell(); const codex = new FakeCodex();
  shell.baseRef = (integration as { branch?: string } | undefined)?.branch ?? "main";
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
  return record;
}

const reviewing = (): Assignment => ({ outcomeId: "outcome-1", seatId: "seat-002", status: "in-review", updatedAt: "2026-01-01T00:00:00Z", prUrl: PR });

describe("developer seat", () => {
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
    expect(shell.calls.slice(1)).toEqual([
      `git -c credential.helper= -c credential.helper=!gh auth git-credential fetch origin main @${project}`,
      `git show-ref --verify --quiet refs/heads/${BRANCH} @${project}`,
      `git show-ref --verify --quiet refs/remotes/origin/${BRANCH} @${project}`,
      `git rev-parse --path-format=absolute --git-common-dir @${project}`,
      `git worktree add --no-track -b seat-002/goal-abc-outcome-1 ${worktree} origin/main @${project}`,
      `gh api repos/satoramoto/indra/issues/9/comments?per_page=100 --method GET --paginate --slurp @${worktree}`,
      expect.stringContaining(`gh pr comment ${PR} --body **Indra review:** Reviewed\n\nFindings:\n- Bug in foo\n\n<!-- indra-review:`),
      `gh pr view ${PR} --json state --jq .state @${project}`,
      `gh pr view ${PR} --json mergeable,mergeStateStatus @${project}`,
      `gh pr checks ${PR} --watch @${worktree}`,
      `gh pr view ${PR} --json isDraft,headRefName,baseRefName,state @${project}`,
      `gh pr merge ${PR} --squash @${project}`,
      `gh pr view ${PR} --json state --jq .state @${project}`,
      `gh api -X DELETE repos/satoramoto/indra/git/refs/heads/seat-002/goal-abc-outcome-1 @${project}`,
      `git worktree remove --force ${worktree} @${project}`,
      `git branch -D seat-002/goal-abc-outcome-1 @${project}`,
    ]);
    // Three new sessions: none resumes another. Build and fix write with network; the reviewer is read-only.
    const write = ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", join(project, ".git")];
    expect(codex.runs.map((run) => [run.schema.split("/").at(-1), run.sessionId, run.sandbox])).toEqual([["developer.json", undefined, write], ["review.json", undefined, ["--sandbox", "read-only"]], ["developer.json", undefined, write]]);
    expect(codex.runs[2].prompt).toContain("Bug in foo");
    const record = JSON.parse(await readFile(join(store.runtimeDir, "seat-seat-002-goal-abc-outcome-1.json"), "utf8")) as SeatTaskRecord;
    expect(record.sessions.map((item) => [item.role, item.sessionId])).toEqual([["developer", "session-1"], ["reviewer", "session-2"], ["fix", "session-3"]]);
    expect(await readFile(join(store.checkout, "state.json"), "utf8")).not.toContain("session-");
    expect(chat.messages.map((message) => message.split(" ")[0])).toEqual(["Claimed", "Opened", "Review", "Merged"]);
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
    expect(shell.calls[ready + 1]).toBe(`gh pr merge ${PR} --squash @${project}`);
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
    const { shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    shell.merges = [{ code: 1, stderr: "Pull request is not mergeable", merged: false }, { code: 0, stderr: "", merged: true }];
    await seat.tick();
    expect((await assignment("outcome-1")).status).toBe("merged");
    expect(shell.calls.filter((call) => call.startsWith("gh pr merge"))).toHaveLength(2);
  });

  it("fails a merge that never lands with a secret-free stderr excerpt", async () => {
    const { shell, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    const refused = { code: 1, stderr: "GraphQL: Pull request is not mergeable\n(token ghp_abc123SECRET)", merged: false };
    shell.merges = [refused, refused];
    await seat.tick();
    const failed = await assignment("outcome-1");
    expect(failed).toMatchObject({ status: "failed", note: "ci: gh pr merge failed: GraphQL: Pull request is not mergeable (token [redacted])" });
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
    expect(shell.calls.slice(ci, ci + 7)).toEqual([
      `gh pr view ${PR} --json mergeable,mergeStateStatus @${project}`,
      `git -c credential.helper= -c credential.helper=!gh auth git-credential fetch origin main @${project}`,
      `git merge --no-edit origin/main @${worktree}`,
      ownPush(worktree),
      `gh pr checks ${PR} --watch @${worktree}`,
      `gh pr view ${PR} --json isDraft,headRefName,baseRefName,state @${project}`,
      `gh pr merge ${PR} --squash @${project}`,
    ]);
    onlyOwnPushes(shell.calls, worktree);
    expect(codex.runs).toHaveLength(2);
    expect((await assignment("outcome-1")).status).toBe("merged");
  });

  it("resolves a conflict with main in one write-access Codex session, then pushes, waits for CI and merges", async () => {
    const { store, chat, shell, codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.findings = [];
    shell.mainStatus = [conflicting];
    shell.mainMerges = [1];
    await seat.tick();
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    const conflictAt = shell.calls.indexOf(`git merge --no-edit origin/main @${worktree}`);
    expect(shell.calls.slice(conflictAt + 1, conflictAt + 6)).toEqual([
      `git merge-base --is-ancestor origin/main HEAD @${worktree}`,
      ownPush(worktree),
      `gh pr checks ${PR} --watch @${worktree}`,
      `gh pr view ${PR} --json isDraft,headRefName,baseRefName,state @${join(store.runtimeDir, "projects", "satoramoto", "indra")}`,
      `gh pr merge ${PR} --squash @${join(store.runtimeDir, "projects", "satoramoto", "indra")}`,
    ]);
    onlyOwnPushes(shell.calls, worktree);
    const write = ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", join(store.runtimeDir, "projects", "satoramoto", "indra", ".git")];
    expect(codex.runs).toHaveLength(3);
    expect(codex.runs[2]).toMatchObject({ cwd: worktree, sandbox: write, sessionId: undefined });
    expect(codex.runs[2].prompt).toContain("keeping the intent of both sides");
    expect(chat.messages.some((message) => message.includes("conflicts with main; resolving (round 1 of 2)"))).toBe(true);
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
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "ci: merge conflict with main could not be resolved" });
    expect(chat.messages.at(-1)).toContain("merge conflict with main could not be resolved");
    expect(codex.runs.filter((run) => run.prompt.includes("stopped with conflicts"))).toHaveLength(2);
    expect(shell.calls.filter((call) => call.startsWith("gh pr checks"))).toHaveLength(2);
    expect(shell.calls.at(-1)).toBe(`git merge --abort @${worktree}`);
    onlyOwnPushes(shell.calls, worktree);
  });

  it("fails an assignment whose team has no project, naming the state field", async () => {
    const store = await fixture([queued("outcome-1", "2026-01-01T00:00:00Z")], "approved", null);
    const shell = new FakeShell(); const codex = new FakeCodex();
    await new DeveloperSeat(store, await loadDeveloperSeat(store, "seat-002"), new FakeChat(), shell, codex.factory).tick();
    expect((await store.read()).planningGoals![0].assignments![0]).toMatchObject({ status: "failed", note: "worktree: Team team-001 has no project.github in state.json; record it in indra-state first." });
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

  it("fails on a Codex error without recording its output", async () => {
    const { codex, seat, assignment } = await setup([queued("outcome-1", "2026-01-01T00:00:00Z")]);
    codex.fail = true;
    await seat.tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "build: Codex developer session failed." });
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
    const merged = shell.calls.indexOf(`git merge --no-edit origin/${integration?.branch ?? "main"} @${record.worktree}`);
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
    expect(codex.runs).toHaveLength(4);
    for (const run of codex.runs.slice(2)) expect(run.prompt).toContain(`Merging origin/${integration?.branch ?? "main"}`);
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
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "build: Codex developer session failed." });
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
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", prUrl: oldPR, note: "build: Codex developer session failed." });
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
    expect(shell.comments).toHaveLength(1);
    expect(codex.runs.filter((run) => run.schema.endsWith("review.json"))).toHaveLength(1);
    expect(codex.runs.at(-1)?.prompt).toContain("Bug in foo");
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
});
