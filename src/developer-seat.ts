import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AgentResult, AgentRuntime, WriteAccess } from "./codex-runtime.js";
import { maintainDeveloperSeat, ownsSeatRecord, retainSeatRecord, seatRecordName } from "./developer-maintenance.js";
import { postReviewOnce } from "./developer-review.js";
import { missingTeamMessage, teamProject, type PlanningAssignment as Assignment, type PlanningGoal, type PlanningOutcome as ApprovedOutcome, type PlanningStore } from "./planning.js";
import { ensureProjectCheckout, ProjectCheckoutError, projectCheckoutPath } from "./project-checkout.js";
import { redactSecrets } from "./redact.js";
import { schemaPathOf } from "./reload.js";
import { activityRecordName } from "./supervisor.js";

export interface ShellResult { code: number; stdout: string; stderr: string }
export interface Shell { run(command: string, args: string[], cwd: string): Promise<ShellResult> }
export interface SeatChat { post(channelId: string, message: string, rootId?: string): Promise<unknown> }
/** Creates an agent runtime in `cwd`: read-only without `write`, otherwise workspace-write plus the given extra dirs (the shared Git dir). */
export type RuntimeFactory = (cwd: string, write?: WriteAccess) => AgentRuntime;

export interface SeatIdentity { id: string; displayName: string; username: string; roles: string[] }
type Step = "worktree" | "build" | "review" | "fix" | "ci" | "done";
/** Lives in `<state-checkout>.runtime`, never in state.json. */
export interface SeatTaskRecord {
  goalId: string; outcomeId: string; step: Step; branch: string; worktree: string; gitDir?: string; prUrl?: string; findings?: string[];
  /** A prior attempt's PR remains visible in state until this attempt opens its replacement. */
  retainedPrUrl?: string;
  /** Conflict-resolution rounds used in this attempt; reset on explicit re-queue, preserved on restart. */
  conflictRounds?: number;
  sessions: { role: "developer" | "reviewer" | "fix"; sessionId: string; startedAt: string; finishedAt: string; usage?: unknown }[];
}

const developerSchema = schemaPathOf(import.meta.url, "developer.json");
const reviewSchema = schemaPathOf(import.meta.url, "review.json");
const ACTIVE = new Set<Assignment["status"]>(["running", "in-review"]);
const MAX_CONFLICT_ROUNDS = 2;
/** Clean or conflicting merges of main per CI step, so a fast-moving main cannot keep a seat busy forever. */
const MAX_MAIN_UPDATES = 4;
const conflictNote = (base: string) => `merge conflict with ${base} could not be resolved`;
/** A sprint's PRs target its integration branch; a goal approved before sprints existed targets main. */
export const baseBranch = (goal: PlanningGoal) => goal.integration?.branch ?? "main";
// gh supplies the credential for one command; Git's configuration is never changed.
const GH_CREDENTIAL = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

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
    if (await maintainDeveloperSeat(this.store, this.seat.id, this.shell, this.log)) return "worked";
    const goals = ((await this.store.read()).planningGoals ?? []).filter((goal) => goal.stage === "approved");
    const mine = goals.flatMap((goal) => (goal.assignments ?? []).filter((item) => item.seatId === this.seat.id).map((assignment) => ({ goal, assignment })));
    const active = mine.find((item) => ACTIVE.has(item.assignment.status));
    if (active) { await this.resume(active.goal, active.assignment); return "worked"; }
    // Once a sprint's integration PR is open, its queued outcomes are skipped: nothing more lands in its branch.
    const next = mine.filter((item) => item.assignment.status === "queued" && (item.goal.integration?.status ?? "collecting") === "collecting").sort((a, b) => a.assignment.updatedAt.localeCompare(b.assignment.updatedAt) || a.goal.createdAt.localeCompare(b.goal.createdAt))[0];
    if (!next) return "idle";
    const { goal, assignment } = next;
    await this.store.update((state) => {
      const all = (state.planningGoals ?? []).flatMap((item) => item.assignments ?? []);
      if (all.some((item) => item.seatId === this.seat.id && ACTIVE.has(item.status))) throw new SeatError("Seat already owns an assignment.");
      const target = this.find(state.planningGoals, goal.id, assignment.outcomeId);
      if (target.status !== "queued") throw new SeatError("Assignment is no longer queued.");
      Object.assign(target, { status: "running", updatedAt: new Date().toISOString() });
      delete target.note;
    }, `Seat ${this.seat.id} claims ${goal.id}/${assignment.outcomeId}: running`);
    const saved = await this.store.readRuntimeFile<SeatTaskRecord>(this.recordName(goal.id, assignment.outcomeId));
    if (saved && this.ownsRecord(goal, assignment.outcomeId, saved)) {
      // Claiming a queued retry grants a fresh budget; resuming active work above keeps its spent rounds.
      saved.conflictRounds = 0;
      await this.save(saved);
      await this.resume(goal, assignment, saved);
    } else {
      // Keep unrecognized metadata and retained checkouts intact. A new attempt must not collide with either.
      if (saved) await retainSeatRecord(this.store, this.recordName(goal.id, assignment.outcomeId), saved);
      const record = this.newRecord(goal.id, assignment.outcomeId);
      if (assignment.prUrl) record.retainedPrUrl = assignment.prUrl;
      await this.save(record);
      await this.say(goal, `Claimed **${this.outcome(goal, assignment.outcomeId).title}** (${assignment.outcomeId}). Starting work.`);
      await this.work(goal, record);
    }
    return "worked";
  }

  private async resume(goal: PlanningGoal, assignment: Assignment, saved?: SeatTaskRecord): Promise<void> {
    const record = saved ?? await this.store.readRuntimeFile<SeatTaskRecord>(this.recordName(goal.id, assignment.outcomeId));
    if (!record || !this.ownsRecord(goal, assignment.outcomeId, record)) { await this.fail(goal, assignment.outcomeId, "Interrupted without a usable assignment record; not resumed."); return; }
    const beforePR = ["worktree", "build"].includes(record.step);
    if ((!beforePR && !record.prUrl) || (assignment.prUrl && assignment.prUrl !== record.prUrl && assignment.prUrl !== record.retainedPrUrl)) {
      await this.fail(goal, assignment.outcomeId, "Assignment PR does not match its saved step; not resumed."); return;
    }
    if (record.step === "done") record.step = "ci";
    this.log(`Resuming ${goal.id}/${assignment.outcomeId} at ${record.step}.`);
    await this.work(goal, record, true);
  }

  private newRecord(goalId: string, outcomeId: string, suffix = ""): SeatTaskRecord {
    const name = `${goalId}-${outcomeId}${suffix}`;
    return { goalId, outcomeId, step: "worktree", branch: `${this.seat.id}/${name}`, worktree: join(this.store.runtimeDir, "worktrees", name), sessions: [] };
  }

  private ownsRecord(goal: PlanningGoal, outcomeId: string, record: SeatTaskRecord): boolean {
    return ownsSeatRecord(this.store.runtimeDir, this.seat.id, goal.id, outcomeId, record);
  }

  /** Verify both the assignment identity and Git's actual checkout before any recovery command or session. */
  private async verifyWorktree(goal: PlanningGoal, record: SeatTaskRecord): Promise<void> {
    if (!this.ownsRecord(goal, record.outcomeId, record)) throw new SeatError("Worktree is not owned by this assignment.");
    const project = projectCheckoutPath(this.store.runtimeDir, await this.github(goal));
    const commonDir = async (cwd: string) => realpath((await this.sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).stdout.trim());
    const expected = await commonDir(project);
    const actual = await commonDir(record.worktree);
    const top = await realpath((await this.sh("git", ["rev-parse", "--show-toplevel"], record.worktree)).stdout.trim());
    const branch = (await this.sh("git", ["symbolic-ref", "--quiet", "HEAD"], record.worktree)).stdout.trim();
    if (actual !== expected || top !== await realpath(record.worktree) || branch !== `refs/heads/${record.branch}` || (record.gitDir && await realpath(record.gitDir) !== expected)) {
      throw new SeatError("Worktree is not owned by this assignment.");
    }
    record.gitDir = expected;
  }

  private async recoverMerge(record: SeatTaskRecord): Promise<void> {
    const pending = await this.shell.run("git", ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], record.worktree);
    if (pending.code === 1) return;
    if (pending.code !== 0) throw new SeatError("Could not inspect unfinished merge.");
    // This is recovery, not another conflict-resolution round. A failed abort stops all subsequent work.
    await this.sh("git", ["merge", "--abort"], record.worktree);
  }

  private async work(goal: PlanningGoal, record: SeatTaskRecord, resuming = false): Promise<void> {
    const outcome = this.outcome(goal, record.outcomeId);
    const base = baseBranch(goal);
    let finalized = false;
    try {
      if (resuming && (record.step !== "worktree" || await pathExists(record.worktree))) {
        await this.verifyWorktree(goal, record);
        await this.recoverMerge(record);
        if (record.step === "worktree") await this.advance(record, "build");
        if (record.prUrl) await this.setStatus(goal.id, record.outcomeId, { status: "in-review", prUrl: record.prUrl });
      }
      if (record.step === "worktree") {
        const project = await ensureProjectCheckout(this.shell, this.store.runtimeDir, await this.github(goal), base);
        // A missing runtime file must not cause `worktree add -b` to collide with retained work or refs.
        while (await pathExists(record.worktree) || await this.branchExists(record.branch, project)) {
          Object.assign(record, this.newRecord(goal.id, record.outcomeId, `-attempt-${randomUUID()}`));
        }
        record.gitDir = (await this.sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project)).stdout.trim();
        await this.save(record);
        await this.sh("git", ["worktree", "add", "--no-track", "-b", record.branch, record.worktree, `origin/${base}`], project);
        await this.advance(record, "build");
      }
      if (record.step === "build") {
        const run = await this.codex("developer", record, { extraDirs: [record.gitDir!] }, buildPrompt(this.seat, goal, outcome, record.branch, base), developerSchema);
        const prUrl = prUrlFrom(run.response);
        // The seat's PR merges into its sprint branch whatever base the session chose, never into main.
        if (base !== "main") await this.sh("gh", ["pr", "edit", prUrl, "--base", base], record.worktree);
        record.prUrl = prUrl;
        await this.advance(record, "review");
        await this.setStatus(goal.id, record.outcomeId, { status: "in-review", prUrl });
        await this.say(goal, `Opened ${prUrl} for **${outcome.title}**. Starting a fresh review.`);
      }
      if (record.step === "review") {
        // The reviewer is read-only with no network; the seat posts its findings on the PR.
        record.findings = await postReviewOnce({
          store: this.store, recordName: this.recordName(goal.id, record.outcomeId), prUrl: record.prUrl!, worktree: record.worktree, shell: this.shell,
          review: async () => (await this.codex("reviewer", record, undefined, reviewPrompt(goal, outcome, record.prUrl!), reviewSchema)).response,
        });
        await this.advance(record, record.findings.length ? "fix" : "ci");
        await this.say(goal, `Review of ${record.prUrl} done: ${record.findings.length ? `${record.findings.length} finding(s); fixing.` : "no findings."}`);
      }
      if (record.step === "fix") {
        await this.codex("fix", record, { extraDirs: [record.gitDir!] }, fixPrompt(outcome, record.prUrl!, record.branch, record.findings ?? []), developerSchema);
        await this.advance(record, "ci");
      }
      if (record.step === "ci") {
        const project = projectCheckoutPath(this.store.runtimeDir, await this.github(goal));
        const state = (await this.sh("gh", ["pr", "view", record.prUrl!, "--json", "state", "--jq", ".state"], project)).stdout.trim();
        if (state !== "MERGED") {
          // Another seat's PR may have merged first: bring the base branch in before CI, and again when a merge fails.
          let updates = await this.updateFromMain(goal, outcome, record, project) ? 1 : 0;
          for (;;) {
            const checks = await this.shell.run("gh", ["pr", "checks", record.prUrl!, "--watch"], record.worktree);
            if (checks.code !== 0) throw new SeatError(`CI did not pass on ${record.prUrl}.`);
            try { await this.merge(record.prUrl!, project); break; }
            catch (error) {
              if (updates >= MAX_MAIN_UPDATES || !(await this.updateFromMain(goal, outcome, record, project))) throw error;
              updates++;
            }
          }
        }
        await this.setStatus(goal.id, record.outcomeId, { status: "merged", prUrl: record.prUrl });
        finalized = true;
        await this.advance(record, "done");
        await this.say(goal, `Merged ${record.prUrl} for **${outcome.title}**. Going idle.`);
        // Cleanup is best-effort: none of it can fail a merged assignment.
        const github = await this.github(goal);
        const deleted = await this.shell.run("gh", ["api", "-X", "DELETE", `repos/${github}/git/refs/heads/${record.branch}`], project);
        if (deleted.code !== 0) this.log(`Could not delete remote branch ${record.branch}.`);
        const removed = await this.shell.run("git", ["worktree", "remove", "--force", record.worktree], project);
        if (removed.code !== 0) this.log(`Could not remove worktree ${record.worktree}.`);
        const branchGone = await this.shell.run("git", ["branch", "-D", record.branch], project);
        if (branchGone.code !== 0) this.log(`Could not delete local branch ${record.branch}.`);
      }
    } catch (error) {
      if (finalized) { this.log(`Merged ${goal.id}/${record.outcomeId}; could not finish post-merge housekeeping.`); return; }
      const reason = error instanceof SeatError || error instanceof ProjectCheckoutError ? error.message : "unexpected error";
      this.log(`Assignment ${goal.id}/${record.outcomeId} failed at ${record.step}: ${error instanceof Error ? error.message : String(error)}`);
      await this.fail(goal, record.outcomeId, `${record.step}: ${reason}`.slice(0, 200));
    }
  }

  private async branchExists(branch: string, project: string): Promise<boolean> {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      const found = await this.shell.run("git", ["show-ref", "--verify", "--quiet", ref], project);
      if (found.code === 0) return true;
      if (found.code !== 1) throw new SeatError("Could not inspect retained assignment branches.");
    }
    return false;
  }

  private async fail(goal: PlanningGoal, outcomeId: string, note: string): Promise<void> {
    if (await this.setStatus(goal.id, outcomeId, { status: "failed", note })) {
      await this.say(goal, `Failed **${this.outcome(goal, outcomeId).title}** (${outcomeId}): ${note} Going idle.`);
    }
  }

  private async codex(role: SeatTaskRecord["sessions"][number]["role"], record: SeatTaskRecord, write: WriteAccess | undefined, prompt: string, schema: string): Promise<AgentResult> {
    let run: AgentResult;
    // Every session is new: no session id is ever passed, so the reviewer never shares the builder's context.
    try { run = await this.runtimeFor(record.worktree, write).message(prompt, schema); }
    catch { this.log(`Agent ${role} session error.`); throw new SeatError(`Agent ${role} session failed.`); }
    record.sessions.push({ role, sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.save(record);
    return run;
  }

  /** Wait before retrying a merge GitHub briefly refused (for example while checks re-evaluate after another merge). */
  mergeRetryMs = 15_000;

  /**
   * Merges by URL from the project checkout so gh never touches local branches.
   * The PR's state is the only success signal; gh's exit code is not.
   */
  private async merge(prUrl: string, project: string): Promise<void> {
    let stderr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.mergeRetryMs));
      const result = await this.shell.run("gh", ["pr", "merge", prUrl, "--squash"], project);
      stderr = result.stderr;
      const state = await this.shell.run("gh", ["pr", "view", prUrl, "--json", "state", "--jq", ".state"], project);
      if (state.stdout.trim() === "MERGED") return;
    }
    throw new SeatError(`gh pr merge failed: ${stderrExcerpt(stderr)}`);
  }

  /** Whether GitHub reports the PR behind or conflicting with its base. UNKNOWN (still computing) counts as neither. */
  private async mainStatus(prUrl: string, project: string): Promise<"current" | "behind" | "conflicting"> {
    const view = await this.sh("gh", ["pr", "view", prUrl, "--json", "mergeable,mergeStateStatus"], project);
    let parsed: { mergeable?: unknown; mergeStateStatus?: unknown };
    try { parsed = JSON.parse(view.stdout) as typeof parsed; } catch { throw new SeatError(`gh pr view returned no mergeability for ${prUrl}.`); }
    if (parsed.mergeable === "CONFLICTING" || parsed.mergeStateStatus === "DIRTY") return "conflicting";
    if (parsed.mergeStateStatus === "BEHIND") return "behind";
    return "current";
  }

  /**
   * When the PR is behind or conflicting with its base (the sprint branch, or main for a goal without one), merges
   * the fetched base into the seat's own branch in its own worktree (never a rebase or force-push) and pushes that
   * branch. Conflicts get one Codex fix session per round, at most MAX_CONFLICT_ROUNDS per attempt. Returns true
   * when it pushed, so CI must run again.
   */
  private async updateFromMain(goal: PlanningGoal, outcome: ApprovedOutcome, record: SeatTaskRecord, project: string): Promise<boolean> {
    if (await this.mainStatus(record.prUrl!, project) === "current") return false;
    const base = baseBranch(goal);
    for (;;) {
      await ensureProjectCheckout(this.shell, this.store.runtimeDir, await this.github(goal), base);
      const merged = await this.shell.run("git", ["merge", "--no-edit", `origin/${base}`], record.worktree);
      if (merged.code === 0) break;
      const rounds = record.conflictRounds ?? 0;
      if (rounds >= MAX_CONFLICT_ROUNDS) {
        await this.sh("git", ["merge", "--abort"], record.worktree);
        throw new SeatError(conflictNote(base));
      }
      record.conflictRounds = rounds + 1;
      await this.save(record);
      await this.say(goal, `${record.prUrl} conflicts with ${base}; resolving (round ${record.conflictRounds} of ${MAX_CONFLICT_ROUNDS}).`);
      await this.codex("fix", record, { extraDirs: [record.gitDir!] }, conflictPrompt(outcome, record.prUrl!, record.branch, base), developerSchema);
      // Resolved means the merge is committed: the base is now an ancestor of HEAD.
      const resolved = await this.shell.run("git", ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], record.worktree);
      if (resolved.code === 0) break;
      await this.sh("git", ["merge", "--abort"], record.worktree);
      if (record.conflictRounds >= MAX_CONFLICT_ROUNDS) throw new SeatError(conflictNote(base));
    }
    await this.sh("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${record.branch}`], record.worktree);
    return true;
  }

  private async sh(command: string, args: string[], cwd: string): Promise<ShellResult> {
    const result = await this.shell.run(command, args, cwd);
    if (result.code !== 0) throw new SeatError(`${command} ${args.slice(0, 2).join(" ")} failed (exit ${result.code}).`);
    return result;
  }

  private async setStatus(goalId: string, outcomeId: string, change: Partial<Assignment>): Promise<boolean> {
    let changed = false;
    await this.store.update((state) => {
      const target = this.find(state.planningGoals, goalId, outcomeId);
      // update's lock and commit recovery also protect a merge whose commit succeeded before update threw.
      if (target.status === "merged") return;
      Object.assign(target, change, { updatedAt: new Date().toISOString() });
      if (change.status === "merged") delete target.note;
      changed = true;
    }, `Seat ${this.seat.id} marks ${goalId}/${outcomeId} ${change.status ?? "updated"}`);
    return changed;
  }

  private find(goals: PlanningGoal[] | undefined, goalId: string, outcomeId: string): Assignment {
    const found = goals?.find((goal) => goal.id === goalId)?.assignments?.find((item) => item.outcomeId === outcomeId && item.seatId === this.seat.id);
    if (!found) throw new SeatError(`Assignment ${goalId}/${outcomeId} is missing.`);
    return found;
  }

  private outcome(goal: PlanningGoal, outcomeId: string): ApprovedOutcome {
    return goal.proposal?.outcomes.find((item) => item.id === outcomeId) ?? { id: outcomeId, title: outcomeId, description: "", seatId: this.seat.id };
  }

  /** The goal's project is its team's `project.github` in state; Indra works in its own clone of it. */
  private async github(goal: PlanningGoal): Promise<string> {
    const github = teamProject(await this.store.read(), goal.teamId);
    if (!github) throw new SeatError(missingTeamMessage(goal.teamId, ["project.github"]));
    return github;
  }

  private recordName(goalId: string, outcomeId: string): string { return seatRecordName(this.seat.id, goalId, outcomeId); }
  private async save(record: SeatTaskRecord): Promise<void> { await this.store.saveRuntime(this.recordName(record.goalId, record.outcomeId), record); }
  private async advance(record: SeatTaskRecord, step: Step): Promise<void> { record.step = step; await this.save(record); }

  /** Progress posts are best effort; a Mattermost outage does not fail the work. */
  private async say(goal: PlanningGoal, message: string): Promise<void> {
    try { await this.chat.post(goal.mattermost.channelId, message, goal.mattermost.rootPostId); }
    catch (error) {
      // A refused post names the bot and channel (MattermostAccessError); other failures stay generic.
      this.log(error instanceof Error && error.name === "MattermostAccessError" ? `Could not post progress to the goal thread: ${error.message}` : "Could not post progress to the goal thread.");
      return;
    }
    // The terminal UI shows this as the seat's newest thread activity.
    try { await this.store.saveRuntime(activityRecordName(this.seat.id),{ message, at: new Date().toISOString() }); }
    catch { this.log("Could not record thread activity."); }
  }
}

function prUrlFrom(response: unknown): string {
  const url = (response as { prUrl?: unknown } | undefined)?.prUrl;
  if (typeof url !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url.trim())) throw new SeatError("Developer session did not report a PR URL.");
  return url.trim();
}

const pathExists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });

function buildPrompt(seat: SeatIdentity, goal: PlanningGoal, outcome: ApprovedOutcome, branch: string, base: string): string {
  return `You are ${seat.displayName}, a Developer seat in Indra, working one approved outcome in this git worktree (branch ${branch}, created from origin/${base}).
Follow the repository's AGENTS.md: use its feedback loop, run the targeted tests and checks it lists once each, and keep the change to this outcome only.
When done: commit, push with \`git push -u origin HEAD:refs/heads/${branch}\`, and open a pull request against ${base} with \`gh pr create --base ${base}\`. Do not merge. Never put credentials in commands, files or output.
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

function fixPrompt(outcome: ApprovedOutcome, prUrl: string, branch: string, findings: string[]): string {
  return `You are a Developer seat in Indra. Address these review findings on ${prUrl} in this worktree (branch ${branch}). Run the targeted tests AGENTS.md lists once, commit, and push with \`git push origin HEAD:refs/heads/${branch}\`. Do not merge.
Return only JSON: prUrl (${prUrl}) and summary.
Outcome ${outcome.id}: ${outcome.title}
Findings:
${findings.map((item) => `- ${item}`).join("\n")}`;
}

function conflictPrompt(outcome: ApprovedOutcome, prUrl: string, branch: string, base: string): string {
  return `You are a Developer seat in Indra. Merging origin/${base} into this worktree (branch ${branch}, PR ${prUrl}) stopped with conflicts; the merge is in progress.
Resolve every conflict keeping the intent of both sides: ${base}'s changes and this PR's outcome. Do not rebase, reset, force-push or abort the merge.
Run the same targeted tests and checks from AGENTS.md that cover this PR's change, once each, then commit the merge with \`git commit --no-edit\`. Do not push or merge; Indra pushes the branch.
Return only JSON: prUrl (${prUrl}) and summary.
Outcome ${outcome.id}: ${outcome.title}
${outcome.description}`;
}

/** A short, single-line excerpt of command stderr with anything token-shaped removed. */
export function stderrExcerpt(stderr: string, max = 120): string {
  // Redact before truncating so no partial secret survives the cut.
  const text = redactSecrets(stderr)
    .replace(/\s+/g, " ")
    .trim();
  return (text || "no output").slice(0, max);
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
