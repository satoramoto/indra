import { isCircuitOpen } from "./circuit-budget.js";
import { circuitRuntime, circuitShell, withCircuitScope } from "./circuit-scope.js";
import { SprintGitHub } from "./sprint.js";
import { DeveloperGoal } from "./developer-goal.js";
import type { WorkflowEvent, GoalReport } from "./goal-contract.js";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AgentResult, AgentRuntime, WriteAccess } from "./codex-runtime.js";
import { runChecked, type Shell, type ShellResult } from "./command-shell.js";
import { maintainDeveloperSeat, ownsSeatRecord, retainSeatRecord, seatRecordName } from "./developer-maintenance.js";
import { postReviewOnce, requireApprovedReview } from "./developer-review.js";
import { developerSeats, missingTeamMessage, teamProject, type PlanningAssignment as Assignment, type PlanningDocument, type PlanningGoal, type PlanningOutcome as ApprovedOutcome, type PlanningStore } from "./planning.js";
import { ensureProjectCheckout, ProjectCheckoutError, projectCheckoutPath } from "./project-checkout.js";
import { schemaPathOf } from "./reload.js";
import { ImplementationRecorder, implementationEligible, implementationFactsName, type ImplementationEvent } from "./implementation-facts.js";
import { AgentRunError } from "./runtime-facts.js";
import { activityRecordName } from "./supervisor.js";

export { processShell, stderrExcerpt, type Shell, type ShellResult } from "./command-shell.js";
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
  reviewFixRounds?: number;
  /** Stable across process restarts; changes only on an explicit queued claim. */
  attemptId?: string;
  sessions: { role: "developer" | "reviewer" | "fix"; sessionId: string; startedAt: string; finishedAt: string; usage?: unknown }[];
}

const developerSchema = schemaPathOf(import.meta.url, "developer.json");
const reviewSchema = schemaPathOf(import.meta.url, "review.json");
const ACTIVE = new Set<Assignment["status"]>(["running", "in-review"]);
const MAX_CONFLICT_ROUNDS = 2;
const MAX_REVIEW_FIX_ROUNDS = 2;
/** Bound base updates per CI step, so a fast-moving sprint cannot keep a seat busy forever. */
const MAX_MAIN_UPDATES = 4;
const conflictNote = (base: string) => `merge conflict with ${base} could not be resolved`;
/** Developer work always targets this goal's sprint. Legacy goals must migrate first. */
export const baseBranch = (goal: PlanningGoal) => {
  if (goal.integration?.branch !== `sprint/${goal.id}`) throw new SeatError("Goal has no matching sprint branch.");
  return goal.integration.branch;
};
// gh supplies the credential for one command; Git's configuration is never changed.
const GH_CREDENTIAL = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

type Queued = { goal: PlanningGoal; assignment: Assignment };
/** A seat's own queue order: oldest assignment first, then the older goal. */
const byQueue = (a: Queued, b: Queued) => a.assignment.updatedAt.localeCompare(b.assignment.updatedAt) || a.goal.createdAt.localeCompare(b.goal.createdAt);
const assignmentOf = (goals: PlanningGoal[] | undefined, goalId: string, outcomeId: string, seatId: string) =>
  goals?.find((goal) => goal.id === goalId)?.assignments?.find((item) => item.outcomeId === outcomeId && item.seatId === seatId);
export const takeoverNote = (from: string) => `taken over from ${from} (idle)`;

/**
 * Another seat's queued assignment is free to take when its seat is busy with other work, or has more queued and
 * would reach this one only later. Its own next pick stays with an idle seat. Running, in-review and failed work is never free.
 */
export function takeable(goals: PlanningGoal[], goal: PlanningGoal, assignment: Assignment): boolean {
  if (assignment.status !== "queued" || !implementationEligible(goal)) return false;
  const owner = assignment.seatId;
  const held = goals.flatMap((item) => (item.assignments ?? []).filter((entry) => entry.seatId === owner).map((entry) => ({ goal: item, assignment: entry })));
  if (held.some((item) => ACTIVE.has(item.assignment.status))) return true;
  const ownerNext = held.filter((item) => item.assignment.status === "queued" && implementationEligible(item.goal)).sort(byQueue)[0];
  return !!ownerNext && !(ownerNext.goal.id === goal.id && ownerNext.assignment.outcomeId === assignment.outcomeId);
}

/** A failure whose message is ours and safe to record in state and the thread. */
export class SeatError extends Error { override name = "SeatError"; }

/** The assignment note for a failed session: a timeout says so and after how long, from the recorded wall time. */
export function sessionFailureNote(role: string, error: unknown): string {
  if (error instanceof AgentRunError && error.facts.status === "timed-out") {
    const ms = Date.parse(error.facts.finishedAt) - Date.parse(error.facts.startedAt);
    return `Agent ${role} session timed out after ${Number.isFinite(ms) ? Math.round(ms / 60_000) : "?"} min.`;
  }
  return `Agent ${role} session failed.`;
}

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
  ) { this.shell = circuitShell(shell); }

  /** Finite goals-v1 entry point. No assignment means no model, Git, chat or legacy work. */
  async turn(event: WorkflowEvent): Promise<{ events: WorkflowEvent[]; report: GoalReport | null }> {
    return new DeveloperGoal(this.store, this.seat.id, this.shell, this.runtimeFor, this.log).turn(event);
  }

  /** Resumes the seat's in-flight assignment, or claims the oldest queued one. Returns "idle" when there was nothing to do. */
  async tick(): Promise<"idle" | "worked"> {
    if (await maintainDeveloperSeat(this.store, this.seat.id, this.shell, this.log)) return "worked";
    const goals = ((await this.store.read()).planningGoals ?? []).filter(implementationEligible);
    const mine = goals.flatMap((goal) => (goal.assignments ?? []).filter((item) => item.seatId === this.seat.id).map((assignment) => ({ goal, assignment })));
    const active = mine.find((item) => ACTIVE.has(item.assignment.status));
    if (active) { await this.resume(active.goal, active.assignment); return "worked"; }
    const own = mine.filter((item) => item.assignment.status === "queued").sort(byQueue)[0];
    const next: { goal: PlanningGoal; assignment: Assignment; from?: string } | undefined = own ?? await this.takeoverCandidate(await this.store.read());
    if (!next) return "idle";
    const owner = next.from ?? this.seat.id;
    // Release and retry use the same lock. Recheck eligibility after acquiring it, and again in the state transaction.
    const claimed = await this.store.withGoalLock(next.goal.id, async () => {
      const state = await this.store.read();
      const goal = state.planningGoals?.find((item) => item.id === next.goal.id);
      if (!goal || !implementationEligible(goal)) return;
      const assignment = assignmentOf(state.planningGoals, goal.id, next.assignment.outcomeId, owner);
      if (assignment?.status !== "queued") return;
      if ((state.planningGoals ?? []).some((item) => item.assignments?.some((item) => item.seatId === this.seat.id && ACTIVE.has(item.status)))) return;
      // A takeover is re-proven under the lock: the owner is still busy and left nothing of an attempt behind.
      if (next.from && !(takeable(state.planningGoals ?? [], goal, assignment) && await this.unattempted(goal.id, assignment))) return;
      const name = this.recordName(goal.id, assignment.outcomeId);
      const saved = await this.store.readRuntimeFile<SeatTaskRecord>(name);
      const reusable = saved && this.ownsRecord(goal, assignment.outcomeId, saved);
      const facts = this.factsFor(goal.id, assignment.outcomeId);
      if (reusable) await facts.retain(saved);
      else if (saved) await retainSeatRecord(this.store, name, saved);
      const attempt = await facts.prepareClaim(assignment.updatedAt, new Date().toISOString());
      const record = reusable ? saved : this.newRecord(goal.id, assignment.outcomeId);
      if (!reusable && assignment.prUrl) record.retainedPrUrl = assignment.prUrl;
      record.attemptId = attempt.id;
      await this.save(record);
      await this.store.update((current) => {
        const currentGoal = current.planningGoals?.find((item) => item.id === goal.id);
        if (!currentGoal || !implementationEligible(currentGoal)) throw new SeatError("Goal no longer accepts implementation claims.");
        const all = (current.planningGoals ?? []).flatMap((item) => item.assignments ?? []);
        if (all.some((item) => item.seatId === this.seat.id && ACTIVE.has(item.status))) throw new SeatError("Seat already owns an assignment.");
        const target = assignmentOf(current.planningGoals, goal.id, assignment.outcomeId, owner);
        if (target?.status !== "queued" || target.updatedAt !== assignment.updatedAt) throw new SeatError("Assignment is no longer queued.");
        if (next.from && !takeable(current.planningGoals ?? [], currentGoal, target)) throw new SeatError("Assignment is no longer free to take over.");
        // Reassign and claim in one write; file ownership stays with the outcome in the approved proposal.
        Object.assign(target, { seatId: this.seat.id, status: "running", updatedAt: attempt.claim!.at });
        if (next.from) target.note = takeoverNote(next.from);
        else delete target.note;
      }, next.from
        ? `Seat ${this.seat.id} takes over ${goal.id}/${assignment.outcomeId} from ${next.from}: running`
        : `Seat ${this.seat.id} claims ${goal.id}/${assignment.outcomeId}: running`);
      // The preceding attempt's evidence is durable before resetting either budget.
      record.conflictRounds = 0;
      record.reviewFixRounds = 0;
      await this.save(record);
      await facts.confirmClaim(attempt.id);
      return { goal, record, reusable };
    });
    if (!claimed) return "idle";
    const { goal, record, reusable } = claimed;
    if (reusable) await this.resume(goal, this.find((await this.store.read()).planningGoals, goal.id, record.outcomeId), record);
    else {
      await this.say(goal, `Claimed **${this.outcome(goal, record.outcomeId).title}** (${record.outcomeId})${next.from ? `, taken over from ${next.from}, which is busy` : ""}. Starting work.`);
      await this.work(goal, record);
    }
    return "worked";
  }

  /** The oldest queued outcome (proposal order) in this seat's teams' open sprints that another, busy seat holds. */
  private async takeoverCandidate(state: PlanningDocument): Promise<(Queued & { from: string }) | undefined> {
    const goals = state.planningGoals ?? [];
    const open = goals.filter((goal) => implementationEligible(goal) && developerSeats(state, goal.teamId).some((seat) => seat.id === this.seat.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const goal of open) {
      for (const outcome of goal.proposal?.outcomes ?? []) {
        const assignment = goal.assignments?.find((item) => item.outcomeId === outcome.id);
        if (!assignment || assignment.seatId === this.seat.id || !takeable(goals, goal, assignment)) continue;
        if (await this.unattempted(goal.id, assignment)) return { goal, assignment, from: assignment.seatId };
      }
    }
    return undefined;
  }

  /** Nothing of an earlier attempt remains: no seat record, ledger attempt or worktree for the owning seat's work. */
  private async unattempted(goalId: string, assignment: Assignment): Promise<boolean> {
    if (await this.store.readRuntimeFile(seatRecordName(assignment.seatId, goalId, assignment.outcomeId))) return false;
    const facts = await this.store.readRuntimeFile<{ attempts?: unknown[] }>(implementationFactsName(assignment.seatId, goalId, assignment.outcomeId));
    if (facts?.attempts?.length) return false;
    const worktree = join(this.store.runtimeDir, "worktrees", `${goalId}-${assignment.outcomeId}`);
    return await lstat(worktree).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  }

  private async resume(goal: PlanningGoal, assignment: Assignment, saved?: SeatTaskRecord): Promise<void> {
    const current = (await this.store.read()).planningGoals?.find((item) => item.id === goal.id);
    if (!current || !implementationEligible(current)) return;
    const record = saved ?? await this.store.readRuntimeFile<SeatTaskRecord>(this.recordName(goal.id, assignment.outcomeId));
    if (!record || !this.ownsRecord(goal, assignment.outcomeId, record)) { await this.fail(goal, assignment.outcomeId, "Interrupted without a usable assignment record; not resumed."); return; }
    const facts = this.factsFor(goal.id, assignment.outcomeId);
    record.attemptId = await facts.recover(record);
    const attempt = (await facts.read()).attempts.find((item) => item.id === record.attemptId)!;
    // Recover the narrow crash window between the committed claim and its runtime confirmation.
    if (!attempt.claimedAt && attempt.claim?.at === assignment.updatedAt && assignment.status === "running") {
      record.conflictRounds = 0;
      record.reviewFixRounds = 0;
      await this.save(record);
      await facts.confirmClaim(attempt.id);
    }
    // A crash after writing a terminal fact must finish that state transition, not resume failed work.
    if (attempt.terminal?.status === "failed" || attempt.terminal?.status === "merged") {
      const note = attempt.events.filter((event) => event.kind === "failure").at(-1)?.message ?? "Interrupted after a recorded failure.";
      await this.setStatus(goal.id, assignment.outcomeId, { status: attempt.terminal.status, ...(attempt.terminal.status === "failed" ? { note } : { prUrl: record.prUrl }) });
      return;
    }
    // Round starts are written before their counters. Recover a crash in that persistence gap.
    record.conflictRounds = Math.max(record.conflictRounds ?? 0, ...attempt.events.filter((event) => event.kind === "conflict" && event.result === "started").map((event) => event.round ?? 0));
    record.reviewFixRounds = Math.max(record.reviewFixRounds ?? 0, ...attempt.events.filter((event) => event.kind === "fix" && event.result === "started").map((event) => event.round ?? 0));
    await this.save(record);
    await this.event(record, { kind: "resume" });
    const beforePR = ["worktree", "build"].includes(record.step);
    if ((!beforePR && !record.prUrl) || (assignment.prUrl && assignment.prUrl !== record.prUrl && assignment.prUrl !== record.retainedPrUrl)) {
      await this.fail(goal, assignment.outcomeId, "Assignment PR does not match its saved step; not resumed.", record); return;
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
    await this.event(record, { kind: "conflict", result: "recovered", message: "Aborting an interrupted merge without spending a new round." });
    await this.sh("git", ["merge", "--abort"], record.worktree);
  }

  private async work(goal: PlanningGoal, record: SeatTaskRecord, resuming = false): Promise<void> {
    return withCircuitScope(this.store.runtimeDir, goal.id, "implement", () => this.workInScope(goal, record, resuming));
  }
  private async workInScope(goal: PlanningGoal, record: SeatTaskRecord, resuming: boolean): Promise<void> {
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
          const replacement = this.newRecord(goal.id, record.outcomeId, `-attempt-${randomUUID()}`);
          record.branch = replacement.branch;
          record.worktree = replacement.worktree;
        }
        record.gitDir = (await this.sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project)).stdout.trim();
        await this.save(record);
        await this.sh("git", ["worktree", "add", "--no-track", "-b", record.branch, record.worktree, `origin/${base}`], project);
        await this.advance(record, "build");
      }
      if (record.step === "build") {
        const run = await this.codex("developer", record, { extraDirs: [record.gitDir!] }, buildPrompt(this.seat, goal, outcome, record.branch, base), developerSchema);
        const prUrl = prUrlFrom(run.response);
        if (!prUrl.startsWith(`https://github.com/${await this.github(goal)}/pull/`)) throw new SeatError("Assignment PR is outside the team project.");
        // The seat's PR merges into its sprint branch whatever base the session chose, never into main.
        await this.sh("gh", ["pr", "edit", prUrl, "--base", base], record.worktree);
        record.prUrl = prUrl;
        await this.advance(record, "review");
        await this.setStatus(goal.id, record.outcomeId, { status: "in-review", prUrl });
        await this.say(goal, `Opened ${prUrl} for **${outcome.title}**. Starting a fresh review.`);
      }
      if (record.step === "review" || record.step === "fix") await this.reviewAndFix(goal, outcome, record);
      if (record.step === "ci") {
        const project = projectCheckoutPath(this.store.runtimeDir, await this.github(goal));
        const state = (await this.sh("gh", ["pr", "view", record.prUrl!, "--json", "state", "--jq", ".state"], project)).stdout.trim();
        if (state !== "MERGED") {
          // Another seat's PR may have merged first: bring the base branch in before CI, and again when a merge fails.
          let updates = await this.updateFromMain(goal, outcome, record, project) ? 1 : 0;
          for (;;) {
            // A fix or base merge changes the head. Reuse evidence only for the exact reviewed commit.
            await this.reviewAndFix(goal, outcome, record);
            const checkedHead = await requireApprovedReview(this.shell, record.prUrl!, record.worktree, this.store.runtimeDir);
            await this.event(record, { kind: "ci", result: "started", headSha: checkedHead });
            let checks: ShellResult;
            try { checks = await this.shell.run("gh", ["pr", "checks", record.prUrl!, "--watch"], record.worktree); }
            catch (error) {
              if (isCircuitOpen(error)) throw error;
              await this.event(record, { kind: "ci", result: "failed", headSha: checkedHead });
              throw new SeatError("CI observation failed.");
            }
            await this.event(record, { kind: "ci", result: checks.code === 0 ? "passed" : "failed", headSha: checkedHead });
            if (checks.code !== 0) throw new SeatError(`CI did not pass on ${record.prUrl}.`);
            try { await this.merge(goal, record, project, checkedHead); break; }
            catch (error) {
              if (updates >= MAX_MAIN_UPDATES || !(await this.updateFromMain(goal, outcome, record, project))) throw error;
              await this.event(record, { kind: "merge", result: "retry", message: "Updated sprint base before retrying CI and merge." });
              updates++;
            }
          }
        }
        if (!await new SprintGitHub(this.shell, this.store.runtimeDir).mergeVerification(record.prUrl!)) throw new SeatError("Merged assignment lacks verified current-head review and passing CI.");
        await this.factsFor(goal.id, record.outcomeId).retain(record);
        await this.factsFor(goal.id, record.outcomeId).finish(record.attemptId!, "merged");
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
      const reason = isCircuitOpen(error) || error instanceof SeatError || error instanceof ProjectCheckoutError ? error.message : "unexpected error";
      this.log(`Assignment ${goal.id}/${record.outcomeId} failed at ${record.step}: ${reason}`);
      await this.fail(goal, record.outcomeId, `${record.step}: ${reason}`.slice(0, 200), record);
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

  private async fail(goal: PlanningGoal, outcomeId: string, note: string, record?: SeatTaskRecord): Promise<void> {
    if (this.find((await this.store.read()).planningGoals, goal.id, outcomeId).status === "merged") return;
    const facts = this.factsFor(goal.id, outcomeId);
    const id = record?.attemptId ?? await facts.recover(record);
    if (record) await facts.retain(record);
    await facts.event(id, { kind: "failure", message: note });
    await facts.finish(id, "failed");
    if (await this.setStatus(goal.id, outcomeId, { status: "failed", note })) {
      await this.say(goal, `Failed **${this.outcome(goal, outcomeId).title}** (${outcomeId}): ${note} Going idle.`);
    }
  }

  private async reviewAndFix(goal: PlanningGoal, outcome: ApprovedOutcome, record: SeatTaskRecord): Promise<void> {
    for (;;) {
      if (record.step !== "fix") {
        record.findings = await postReviewOnce({
          store: this.store, recordName: this.recordName(goal.id, record.outcomeId), prUrl: record.prUrl!, worktree: record.worktree, shell: this.shell,
          review: async () => (await this.codex("reviewer", record, undefined, reviewPrompt(goal, outcome, record.prUrl!, record.findings ?? []), reviewSchema)).response,
          onReview: async (review) => this.event(record, { kind: "review", prUrl: record.prUrl, headSha: review.headSha, verdict: review.verdict, findings: review.findings }, `review:${review.id}`),
        });
        const announce = record.step === "review";
        await this.advance(record, record.findings.length ? "fix" : "ci");
        if (announce) await this.say(goal, `Review of ${record.prUrl} done: ${record.findings.length ? `${record.findings.length} finding(s); fixing.` : "no findings."}`);
      }
      if (record.step === "ci") return;
      if ((record.reviewFixRounds ?? 0) >= MAX_REVIEW_FIX_ROUNDS) throw new SeatError("Review findings remain after the fix budget was exhausted.");
      record.reviewFixRounds = (record.reviewFixRounds ?? 0) + 1;
      await this.event(record, { kind: "fix", result: "started", round: record.reviewFixRounds });
      await this.save(record);
      await this.codex("fix", record, { extraDirs: [record.gitDir!] }, fixPrompt(outcome, record.prUrl!, record.branch, record.findings ?? []), developerSchema);
      await this.event(record, { kind: "fix", result: "passed", round: record.reviewFixRounds });
      await this.advance(record, "review");
    }
  }

  private async codex(role: SeatTaskRecord["sessions"][number]["role"], record: SeatTaskRecord, write: WriteAccess | undefined, prompt: string, schema: string): Promise<AgentResult> {
    let run: AgentResult;
    const reviewHead = role === "reviewer" ? (await this.sh("git", ["rev-parse", "HEAD"], record.worktree)).stdout.trim() : "";
    // Every session is new: no session id is ever passed, so the reviewer never shares the builder's context.
    try { run = await circuitRuntime(this.runtimeFor(record.worktree, write), this.store.runtimeDir, record.goalId, "implement", `legacy:${record.outcomeId}:${role}:${reviewHead}`, role !== "developer" && role !== "reviewer").message(prompt, schema, undefined, { purpose: role === "developer" ? "build" : role === "reviewer" ? "review" : "fix" }); }
    catch (error) {
      if (error instanceof AgentRunError) await this.event(record, { kind: "session", role, session: error.facts }, `session:${error.facts.invocationId}`);
      if (isCircuitOpen(error)) throw error;
      this.log(`Agent ${role} session error.`); throw new SeatError(sessionFailureNote(role, error));
    }
    if (run.facts) await this.event(record, { kind: "session", role, session: run.facts }, `session:${run.facts.invocationId}`);
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
  private async merge(goal: PlanningGoal, record: SeatTaskRecord, project: string, checkedHead: string): Promise<void> {
    const { prUrl, branch } = record;
    const base = baseBranch(goal);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await this.event(record, { kind: "merge", result: "retry", headSha: checkedHead });
        await new Promise((resolve) => setTimeout(resolve, this.mergeRetryMs));
      }
      const merged = await this.store.withGoalLock(goal.id, async () => {
        const current = (await this.store.read()).planningGoals?.find((item) => item.id === goal.id);
        if (!current || !implementationEligible(current)) throw new SeatError("Goal no longer accepts implementation merges.");
        const view = await this.sh("gh", ["pr", "view", prUrl!, "--json", "isDraft,headRefName,baseRefName,state"], project);
        let pr: { isDraft?: boolean; headRefName?: string; baseRefName?: string };
        try { pr = JSON.parse(view.stdout) as typeof pr; } catch { throw new SeatError("Could not inspect assignment PR."); }
        if (pr.headRefName !== branch || pr.baseRefName !== base) throw new SeatError("PR head or base does not match this sprint assignment; not merging.");
        if (await requireApprovedReview(this.shell, prUrl!, project, this.store.runtimeDir) !== checkedHead) throw new SeatError("PR head changed after CI; not merging.");
        if (pr.isDraft === true) await this.sh("gh", ["pr", "ready", prUrl!], project);
        const result = await new SprintGitHub(this.shell, this.store.runtimeDir).merge(prUrl!, async (head) => {
          if (head !== checkedHead) throw new SeatError("PR head changed after CI; not merging.");
          await this.event(record, { kind: "merge", result: "started", headSha: checkedHead });
        });
        const landed = result.merged;
        await this.event(record, { kind: "merge", result: landed ? "passed" : "failed", headSha: checkedHead });
        return landed;
      });
      if (merged) return;
    }
    throw new SeatError("gh pr merge failed; PR is not merged.");
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
   * When the PR is behind or conflicting with its sprint branch, merges
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
      await this.event(record, { kind: "conflict", result: "failed", round: rounds, message: "Sprint base merge failed." });
      if (rounds >= MAX_CONFLICT_ROUNDS) {
        await this.sh("git", ["merge", "--abort"], record.worktree);
        throw new SeatError(conflictNote(base));
      }
      record.conflictRounds = rounds + 1;
      await this.event(record, { kind: "conflict", result: "started", round: record.conflictRounds });
      await this.save(record);
      await this.say(goal, `${record.prUrl} conflicts with ${base}; resolving (round ${record.conflictRounds} of ${MAX_CONFLICT_ROUNDS}).`);
      await this.codex("fix", record, { extraDirs: [record.gitDir!] }, conflictPrompt(outcome, record.prUrl!, record.branch, base), developerSchema);
      // Resolved means the merge is committed: the base is now an ancestor of HEAD.
      const resolved = await this.shell.run("git", ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], record.worktree);
      await this.event(record, { kind: "conflict", result: resolved.code === 0 ? "passed" : "failed", round: record.conflictRounds });
      if (resolved.code === 0) break;
      await this.sh("git", ["merge", "--abort"], record.worktree);
      if (record.conflictRounds >= MAX_CONFLICT_ROUNDS) throw new SeatError(conflictNote(base));
    }
    await this.sh("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${record.branch}`], record.worktree);
    return true;
  }

  private async sh(command: string, args: string[], cwd: string): Promise<ShellResult> {
    return await runChecked(this.shell, command, args, cwd, (result) => new SeatError(`${command} ${args.slice(0, 2).join(" ")} failed (exit ${result.code}).`));
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

  private factsFor(goalId: string, outcomeId: string): ImplementationRecorder { return new ImplementationRecorder(this.store, this.seat.id, goalId, outcomeId); }
  private async event(record: SeatTaskRecord, event: Omit<ImplementationEvent, "id" | "at">, key?: string): Promise<void> {
    await this.factsFor(record.goalId, record.outcomeId).event(record.attemptId!, event, key);
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

/*
 * Seat prompts are contracts, not procedures: the outcome and its acceptance, what to deliver where Indra can find
 * it, what Indra does afterwards, the hard constraints and the output schema. How to do the work is the agent's call.
 */
const CREDENTIALS = "Never put credentials (tokens, passwords, API keys) in commands, files, commits, PR text or output.";
const outcomeText = (outcome: ApprovedOutcome) => `Outcome ${outcome.id}: ${outcome.title}\n${outcome.description}`;

function buildPrompt(seat: SeatIdentity, goal: PlanningGoal, outcome: ApprovedOutcome, branch: string, base: string): string {
  return `You are ${seat.displayName}, a Developer seat in Indra. This git worktree is on branch ${branch}, created from origin/${base}.
Outcome: the approved outcome below is done, and nothing else. Acceptance: the outcome's description holds, and the change meets the repository's AGENTS.md rules, including the checks it says must pass.
Deliver: your commits pushed to branch ${branch} (\`git push -u origin HEAD:refs/heads/${branch}\`), and one pull request from ${branch} into ${base} (\`gh pr create --base ${base}\`).
Afterwards Indra runs a fresh review of the PR and a fix round, waits for CI and merges it into ${base}. Do not merge the PR, and do not mark it ready or draft.
Constraints: ${CREDENTIALS}
Return only JSON: prUrl (the PR's https://github.com/... URL) and summary (one or two sentences).
Goal: ${goal.goal}
${outcomeText(outcome)}`;
}

function reviewPrompt(goal: PlanningGoal, outcome: ApprovedOutcome, prUrl: string, previousFindings: string[]): string {
  return `You are a fresh reviewer in Indra. You did not write this change. Pull request ${prUrl} is checked out in this worktree.
Outcome: a review of it against the repository's AGENTS.md review checklist. Acceptance: it flags only real bugs and project-rule violations, never style or naming.
Verify every prior finding below; retain each finding that remains unresolved.
${previousFindings.map((item) => `- ${item}`).join("\n")}
Afterwards Indra posts your line findings and verdict on the PR, fixes findings and verifies them in a fresh review before CI and merge.
Constraints: you run read-only without network. Do not edit files, commit, push, merge or post anything. ${CREDENTIALS}
Return only JSON: findings (each exactly "path:line: reason", using a changed line in the PR; empty when there are none) and summary.
Goal: ${goal.goal}
${outcomeText(outcome)}`;
}

function fixPrompt(outcome: ApprovedOutcome, prUrl: string, branch: string, findings: string[]): string {
  return `You are a Developer seat in Indra. This git worktree is on branch ${branch}, the head of pull request ${prUrl}.
Outcome: every review finding below is addressed. Acceptance: the change still meets its outcome and the repository's AGENTS.md rules, including the checks it says must pass.
Deliver: your commits pushed to branch ${branch} (\`git push origin HEAD:refs/heads/${branch}\`), on the same PR.
Afterwards a fresh reviewer verifies the fixes; Indra waits for CI and merges only an approved head. Do not merge it, and do not mark it ready or draft.
Constraints: ${CREDENTIALS}
Return only JSON: prUrl (${prUrl}) and summary.
${outcomeText(outcome)}
Findings:
${findings.map((item) => `- ${item}`).join("\n")}`;
}

function conflictPrompt(outcome: ApprovedOutcome, prUrl: string, branch: string, base: string): string {
  return `You are a Developer seat in Indra. Merging origin/${base} into this worktree (branch ${branch}, PR ${prUrl}) stopped with conflicts; the merge is in progress.
Outcome: every conflict is resolved keeping the intent of both sides: ${base}'s changes and this PR's outcome. Acceptance: the change meets the repository's AGENTS.md rules, including the checks it says must pass.
Deliver: the merge committed on ${branch} in this worktree, so origin/${base} is an ancestor of HEAD.
Afterwards Indra pushes the branch, waits for CI and merges the PR. Do not push or merge, and do not mark the PR ready or draft.
Constraints: do not rebase, reset, force-push or abort the merge. ${CREDENTIALS}
Return only JSON: prUrl (${prUrl}) and summary.
${outcomeText(outcome)}`;
}
