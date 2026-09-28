import { describe, expect, it } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git, stateCheckout } from "./state-checkout.js";
import { PlanningStore } from "../src/planning.js";
import { DeveloperSeat, loadDeveloperSeat, type SeatChat, type SeatTaskRecord, type Shell, type ShellResult } from "../src/developer-seat.js";
import { sandboxArgs, type AgentResult, type AgentRuntime, type WriteAccess } from "../src/codex-runtime.js";
import type { PlanningAssignment as Assignment } from "../src/planning.js";
import { parseOptions } from "../src/cli.js";

const PR = "https://github.com/satoramoto/indra/pull/9";
const seat = (id: string, name: string, roles: string[]) => ({ id, displayName: name, roles, externalIdentities: { mattermost: { userId: id, username: name.toLowerCase() } } });

async function fixture(assignments: Assignment[], stage = "approved", project: { github: string } | null = { github: "satoramoto/indra" }) {
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
  onFirst?: () => Promise<void>;
  async run(command: string, args: string[], cwd: string): Promise<ShellResult> {
    if (this.onFirst) { const hook = this.onFirst; this.onFirst = undefined; await hook(); }
    const line = `${command} ${args.join(" ")} @${cwd}`;
    this.calls.push(line);
    // `gh repo clone` makes the checkout Indra then moves into place.
    if (line.startsWith("gh repo clone")) await mkdir(join(args[3], ".git"), { recursive: true });
    if (line.startsWith("git rev-parse")) return { code: 0, stdout: "/proj/.git\n", stderr: "" };
    if (line.startsWith("gh pr view")) return { code: 0, stdout: "OPEN\n", stderr: "" };
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

async function setup(assignments: Assignment[]) {
  const store = await fixture(assignments);
  const chat = new FakeChat(); const shell = new FakeShell(); const codex = new FakeCodex();
  const identity = await loadDeveloperSeat(store, "seat-002");
  const make = () => new DeveloperSeat(store, identity, chat, shell, codex.factory);
  const assignment = async (id: string) => (await store.read()).planningGoals![0].assignments!.find((item) => item.outcomeId === id)!;
  return { store, chat, shell, codex, seat: make(), make, assignment };
}

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
      `git rev-parse --path-format=absolute --git-common-dir @${project}`,
      `git worktree add --no-track -b seat-002/goal-abc-outcome-1 ${worktree} origin/main @${project}`,
      `gh pr comment ${PR} --body **Indra review:** Reviewed\n\nFindings:\n- Bug in foo @${worktree}`,
      `gh pr view ${PR} --json state --jq .state @${project}`,
      `gh pr checks ${PR} --watch @${worktree}`,
      `git checkout --detach @${worktree}`,
      `gh pr merge ${PR} --squash --delete-branch @${worktree}`,
      `git worktree remove --force ${worktree} @${project}`,
    ]);
    // Three new sessions: none resumes another. Build and fix write with network; the reviewer is read-only.
    const write = ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", "/proj/.git"];
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
    const worktree = join(store.runtimeDir, "worktrees", "goal-abc-outcome-1");
    const record: SeatTaskRecord = { goalId: "goal-abc", outcomeId: "outcome-1", step: "ci", branch: "b", worktree, gitDir: "/proj/.git", prUrl: PR, sessions: [] };
    await store.saveRuntime("seat-seat-002-goal-abc-outcome-1", record);
    await make().tick();
    expect(codex.runs).toHaveLength(0);
    expect(shell.calls.some((call) => call.startsWith("git worktree add"))).toBe(false);
    expect((await assignment("outcome-1")).status).toBe("merged");
    expect((await assignment("outcome-2")).status).toBe("queued");
  });

  it("on restart fails a running assignment that never opened a PR, then takes the next one on a later tick", async () => {
    const { codex, make, assignment } = await setup([{ outcomeId: "outcome-1", seatId: "seat-002", status: "running", updatedAt: "2026-01-01T00:00:00Z" }, queued("outcome-2", "2025-01-01T00:00:00Z")]);
    const seat = make();
    await seat.tick();
    expect(await assignment("outcome-1")).toMatchObject({ status: "failed", note: "Interrupted before the PR opened; not resumed." });
    expect((await assignment("outcome-2")).status).toBe("queued");
    expect(codex.runs).toHaveLength(0);
    await seat.tick();
    expect((await assignment("outcome-2")).status).toBe("merged");
  });
});
