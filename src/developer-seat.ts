import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentResult, AgentRuntime, WriteAccess } from "./codex-runtime.js";
import type { PlanningAssignment as Assignment, PlanningGoal, PlanningOutcome as ApprovedOutcome, PlanningStore } from "./planning.js";

export interface ShellResult { code: number; stdout: string; stderr: string }
export interface Shell { run(command: string, args: string[], cwd: string): Promise<ShellResult> }
export interface SeatChat { post(channelId: string, message: string, rootId?: string): Promise<unknown> }
/** Creates a Codex runtime in `cwd`: read-only without `write`, otherwise workspace-write plus the given extra dirs (the shared Git dir). */
export type RuntimeFactory = (cwd: string, write?: WriteAccess) => AgentRuntime;

export interface SeatIdentity { id: string; displayName: string; username: string; roles: string[] }
type Step = "worktree" | "build" | "review" | "fix" | "ci" | "done";
/** Lives in `<state-checkout>.runtime`, never in state.json. */
export interface SeatTaskRecord {
  goalId: string; outcomeId: string; step: Step; branch: string; worktree: string; gitDir?: string; prUrl?: string; findings?: string[];
  sessions: { role: "developer" | "reviewer" | "fix"; sessionId: string; startedAt: string; finishedAt: string; usage?: unknown }[];
}

const schemas = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const developerSchema = join(schemas, "developer.json");
const reviewSchema = join(schemas, "review.json");
const ACTIVE = new Set<Assignment["status"]>(["running", "in-review"]);

/** A failure whose message is ours and safe to record in state and the thread. */
export class SeatError extends Error { override name = "SeatError"; }

/** Reads a seat from state and refuses unknown or Team Lead seats. */
export async function loadDeveloperSeat(store: PlanningStore, seatId: string): Promise<SeatIdentity> {
  const state = await store.read();
  const teams = state.teams as { seats: { id: string; displayName: string; roles: string[]; externalIdentities: { mattermost: { username: string } } }[] }[];
  const seat = teams.flatMap((team) => team.seats).find((item) => item.id === seatId);
  if (!seat) throw new SeatError(`Seat '${seatId}' is not in state.`);
  if (seat.roles[0] !== "Developer") throw new SeatError(`Seat '${seatId}' is a ${seat.roles[0] ?? "roleless seat"}; seat run only runs Developer seats.`);
  return { id: seat.id, displayName: seat.displayName, username: seat.externalIdentities.mattermost.username, roles: seat.roles };
}

/** One Developer seat: owns at most one running or in-review assignment and drives it to merged or failed. */
export class DeveloperSeat {
  constructor(
    private readonly store: PlanningStore,
    private readonly seat: SeatIdentity,
    private readonly chat: SeatChat,
    private readonly shell: Shell,
    private readonly runtimeFor: RuntimeFactory,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Resumes the seat's in-flight assignment, or claims the oldest queued one. Returns "idle" when there was nothing to do. */
  async tick(): Promise<"idle" | "worked"> {
    const goals = ((await this.store.read()).planningGoals ?? []).filter((goal) => goal.stage === "approved");
    const mine = goals.flatMap((goal) => (goal.assignments ?? []).filter((item) => item.seatId === this.seat.id).map((assignment) => ({ goal, assignment })));
    const active = mine.find((item) => ACTIVE.has(item.assignment.status));
    if (active) { await this.resume(active.goal, active.assignment); return "worked"; }
    const next = mine.filter((item) => item.assignment.status === "queued").sort((a, b) => a.assignment.updatedAt.localeCompare(b.assignment.updatedAt) || a.goal.createdAt.localeCompare(b.goal.createdAt))[0];
    if (!next) return "idle";
    const { goal, assignment } = next;
    await this.store.update((state) => {
      const all = (state.planningGoals ?? []).flatMap((item) => item.assignments ?? []);
      if (all.some((item) => item.seatId === this.seat.id && ACTIVE.has(item.status))) throw new SeatError("Seat already owns an assignment.");
      const target = this.find(state.planningGoals, goal.id, assignment.outcomeId);
      if (target.status !== "queued") throw new SeatError("Assignment is no longer queued.");
      Object.assign(target, { status: "running", updatedAt: new Date().toISOString() });
      delete target.note; delete target.prUrl;
    }, `Seat ${this.seat.id} claims ${goal.id}/${assignment.outcomeId}: running`);
    const branch = `${this.seat.id}/${goal.id}-${assignment.outcomeId}`;
    const record: SeatTaskRecord = { goalId: goal.id, outcomeId: assignment.outcomeId, step: "worktree", branch, worktree: join(this.store.runtimeDir, "worktrees", `${goal.id}-${assignment.outcomeId}`), sessions: [] };
    await this.save(record);
    await this.say(goal, `Claimed **${this.outcome(goal, assignment.outcomeId).title}** (${assignment.outcomeId}). Starting work on branch \`${branch}\`.`);
    await this.work(goal, record);
    return "worked";
  }

  private async resume(goal: PlanningGoal, assignment: Assignment): Promise<void> {
    const record = await this.store.readRuntimeFile<SeatTaskRecord>(this.recordName(goal.id, assignment.outcomeId));
    const resumable = assignment.status === "in-review" && assignment.prUrl && record?.prUrl === assignment.prUrl && ["review", "fix", "ci"].includes(record.step);
    if (!resumable) { await this.fail(goal, assignment.outcomeId, "Interrupted before the PR opened; not resumed."); return; }
    this.log(`Resuming ${goal.id}/${assignment.outcomeId} at ${record.step}.`);
    await this.work(goal, record);
  }

  private async work(goal: PlanningGoal, record: SeatTaskRecord): Promise<void> {
    const outcome = this.outcome(goal, record.outcomeId);
    try {
      if (record.step === "worktree") {
        const project = goal.projectRefs[0];
        if (!project) throw new SeatError("Goal has no target project.");
        await this.sh("git", ["fetch", "origin", "main"], project);
        record.gitDir = (await this.sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project)).stdout.trim();
        await this.sh("git", ["worktree", "add", "--no-track", "-b", record.branch, record.worktree, "origin/main"], project);
        await this.advance(record, "build");
      }
      if (record.step === "build") {
        const run = await this.codex("developer", record, { extraDirs: [record.gitDir!] }, buildPrompt(this.seat, goal, outcome, record.branch), developerSchema);
        const prUrl = prUrlFrom(run.response);
        record.prUrl = prUrl;
        await this.advance(record, "review");
        await this.setStatus(goal.id, record.outcomeId, { status: "in-review", prUrl });
        await this.say(goal, `Opened ${prUrl} for **${outcome.title}**. Starting a fresh review.`);
      }
      if (record.step === "review") {
        // The reviewer is read-only with no network; the seat posts its findings on the PR.
        const run = await this.codex("reviewer", record, undefined, reviewPrompt(goal, outcome, record.prUrl!), reviewSchema);
        record.findings = findingsFrom(run.response);
        await this.sh("gh", ["pr", "comment", record.prUrl!, "--body", reviewComment(record.findings, run.response)], record.worktree);
        await this.advance(record, record.findings.length ? "fix" : "ci");
        await this.say(goal, `Review of ${record.prUrl} done: ${record.findings.length ? `${record.findings.length} finding(s); fixing.` : "no findings."}`);
      }
      if (record.step === "fix") {
        await this.codex("fix", record, { extraDirs: [record.gitDir!] }, fixPrompt(outcome, record.prUrl!, record.branch, record.findings ?? []), developerSchema);
        await this.advance(record, "ci");
      }
      if (record.step === "ci") {
        const project = goal.projectRefs[0];
        const state = (await this.sh("gh", ["pr", "view", record.prUrl!, "--json", "state", "--jq", ".state"], project)).stdout.trim();
        if (state !== "MERGED") {
          const checks = await this.shell.run("gh", ["pr", "checks", record.prUrl!, "--watch"], record.worktree);
          if (checks.code !== 0) throw new SeatError(`CI did not pass on ${record.prUrl}.`);
          await this.sh("git", ["checkout", "--detach"], record.worktree);
          await this.sh("gh", ["pr", "merge", record.prUrl!, "--squash", "--delete-branch"], record.worktree);
        }
        await this.setStatus(goal.id, record.outcomeId, { status: "merged", prUrl: record.prUrl });
        await this.advance(record, "done");
        await this.say(goal, `Merged ${record.prUrl} for **${outcome.title}**. Going idle.`);
        const removed = await this.shell.run("git", ["worktree", "remove", "--force", record.worktree], project);
        if (removed.code !== 0) this.log(`Could not remove worktree ${record.worktree}.`);
      }
    } catch (error) {
      const reason = error instanceof SeatError ? error.message : "unexpected error";
      this.log(`Assignment ${goal.id}/${record.outcomeId} failed at ${record.step}: ${error instanceof Error ? error.message : String(error)}`);
      await this.fail(goal, record.outcomeId, `${record.step}: ${reason}`.slice(0, 200));
    }
  }

  private async fail(goal: PlanningGoal, outcomeId: string, note: string): Promise<void> {
    await this.setStatus(goal.id, outcomeId, { status: "failed", note });
    await this.say(goal, `Failed **${this.outcome(goal, outcomeId).title}** (${outcomeId}): ${note} Going idle.`);
  }

  private async codex(role: SeatTaskRecord["sessions"][number]["role"], record: SeatTaskRecord, write: WriteAccess | undefined, prompt: string, schema: string): Promise<AgentResult> {
    let run: AgentResult;
    // Every session is new: no session id is ever passed, so the reviewer never shares the builder's context.
    try { run = await this.runtimeFor(record.worktree, write).message(prompt, schema); }
    catch (error) { this.log(`Codex ${role} session error: ${error instanceof Error ? error.message : String(error)}`); throw new SeatError(`Codex ${role} session failed.`); }
    record.sessions.push({ role, sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.save(record);
    return run;
  }

  private async sh(command: string, args: string[], cwd: string): Promise<ShellResult> {
    const result = await this.shell.run(command, args, cwd);
    if (result.code !== 0) throw new SeatError(`${command} ${args.slice(0, 2).join(" ")} failed (exit ${result.code}).`);
    return result;
  }

  private async setStatus(goalId: string, outcomeId: string, change: Partial<Assignment>): Promise<void> {
    await this.store.update((state) => { Object.assign(this.find(state.planningGoals, goalId, outcomeId), change, { updatedAt: new Date().toISOString() }); }, `Seat ${this.seat.id} marks ${goalId}/${outcomeId} ${change.status ?? "updated"}`);
  }

  private find(goals: PlanningGoal[] | undefined, goalId: string, outcomeId: string): Assignment {
    const found = goals?.find((goal) => goal.id === goalId)?.assignments?.find((item) => item.outcomeId === outcomeId && item.seatId === this.seat.id);
    if (!found) throw new SeatError(`Assignment ${goalId}/${outcomeId} is missing.`);
    return found;
  }

  private outcome(goal: PlanningGoal, outcomeId: string): ApprovedOutcome {
    return goal.proposal?.outcomes.find((item) => item.id === outcomeId) ?? { id: outcomeId, title: outcomeId, description: "", seatId: this.seat.id };
  }

  private recordName(goalId: string, outcomeId: string): string { return `seat-${this.seat.id}-${goalId}-${outcomeId}`; }
  private async save(record: SeatTaskRecord): Promise<void> { await this.store.saveRuntime(this.recordName(record.goalId, record.outcomeId), record); }
  private async advance(record: SeatTaskRecord, step: Step): Promise<void> { record.step = step; await this.save(record); }

  /** Progress posts are best effort; a Mattermost outage does not fail the work. */
  private async say(goal: PlanningGoal, message: string): Promise<void> {
    try { await this.chat.post(goal.mattermost.channelId, message, goal.mattermost.rootPostId); }
    catch { this.log("Could not post progress to the goal thread."); }
  }
}

function prUrlFrom(response: unknown): string {
  const url = (response as { prUrl?: unknown } | undefined)?.prUrl;
  if (typeof url !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url.trim())) throw new SeatError("Developer session did not report a PR URL.");
  return url.trim();
}

function findingsFrom(response: unknown): string[] {
  const findings = (response as { findings?: unknown } | undefined)?.findings;
  if (!Array.isArray(findings) || findings.some((item) => typeof item !== "string")) throw new SeatError("Reviewer session returned invalid findings.");
  return (findings as string[]).filter((item) => item.trim());
}

function buildPrompt(seat: SeatIdentity, goal: PlanningGoal, outcome: ApprovedOutcome, branch: string): string {
  return `You are ${seat.displayName}, a Developer seat in Indra, working one approved outcome in this git worktree (branch ${branch}, created from origin/main).
Follow the repository's AGENTS.md: use its feedback loop, run the targeted tests and checks it lists once each, and keep the change to this outcome only.
When done: commit, push with \`git push -u origin HEAD:refs/heads/${branch}\`, and open a pull request against main with \`gh pr create\`. Do not merge. Never put credentials in commands, files or output.
Return only JSON: prUrl (the PR's https://github.com/... URL) and summary (one or two sentences).
Goal: ${goal.goal}
Outcome ${outcome.id}: ${outcome.title}
${outcome.description}`;
}

function reviewPrompt(goal: PlanningGoal, outcome: ApprovedOutcome, prUrl: string): string {
  return `You are a fresh reviewer in Indra. You did not write this change. Review pull request ${prUrl} (checked out in this worktree) against the repository's AGENTS.md review checklist.
Flag only real bugs and project-rule violations, never style or naming. You run read-only without network: do not edit files, commit, push, merge or post anything; Indra posts your findings on the PR.
Return only JSON: findings (one line per finding, with file and line where possible; empty when there are none) and summary.
Goal: ${goal.goal}
Outcome ${outcome.id}: ${outcome.title}
${outcome.description}`;
}

function reviewComment(findings: string[], response: unknown): string {
  const summary = (response as { summary?: unknown } | undefined)?.summary;
  const head = `**Indra review:** ${typeof summary === "string" && summary.trim() ? summary.trim() : "done"}`;
  return findings.length ? `${head}\n\nFindings:\n${findings.map((item) => `- ${item}`).join("\n")}` : `${head}\n\nNo findings.`;
}

function fixPrompt(outcome: ApprovedOutcome, prUrl: string, branch: string, findings: string[]): string {
  return `You are a Developer seat in Indra. Address these review findings on ${prUrl} in this worktree (branch ${branch}). Run the targeted tests AGENTS.md lists once, commit, and push with \`git push origin HEAD:refs/heads/${branch}\`. Do not merge.
Return only JSON: prUrl (${prUrl}) and summary.
Outcome ${outcome.id}: ${outcome.title}
Findings:
${findings.map((item) => `- ${item}`).join("\n")}`;
}

/** Runs commands without a shell; output is kept in memory only. */
export const processShell: Shell = {
  run: (command, args, cwd) => new Promise((done) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 20_000_000, timeout: 2 * 60 * 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout, stderr });
    });
  }),
};
