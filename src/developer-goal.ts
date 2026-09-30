import { CircuitBudget, isCircuitOpen } from "./circuit-budget.js";
import { withCircuitScope } from "./circuit-scope.js";
import { createHash } from "node:crypto";
import type { AgentRuntime, WriteAccess } from "./codex-runtime.js";
import type { Shell } from "./command-shell.js";
import { GitDeveloperLanes, LaneError, LaneValidationError, laneBrief, type DeveloperLaneServices, type LaneJournal } from "./developer-lanes.js";
import { GOAL_REVIEWER, goalRuntimeFilename, validateGoalBrief, validateGoalReport, validateLanePlan, type GoalBrief, type GoalLane, type GoalLaneProgress, type GoalReport, type GoalRuntimeRecord, type WorkflowEvent, type WorkflowFailure } from "./goal-contract.js";
import { teamProject, type PlanningGoal, type PlanningStore } from "./planning.js";
import { laneAgentSummary, type GoalAgentSession } from "./seat-runtime.js";
import { redactSecrets } from "./redact.js";

interface GoalFailures { goal: WorkflowFailure | null; lanes: Record<string, WorkflowFailure> }
interface GoalJournal {
  version: 1; goalId: string; seatId: string; github: string;
  planning: GoalAgentSession[]; lanes: Record<string, LaneJournal>;
  failures?: GoalFailures; consumedRetryIds?: string[];
}
const id = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const failureFor = (error: unknown): WorkflowFailure => ({ at: now(), retryable: !isCircuitOpen(error),
  message: isCircuitOpen(error) ? error.message : error instanceof LaneError ? redactSecrets(error.message) : "Developer goal turn failed; preserved journals and worktrees require an explicit retry." });
const aggregateFailure = (failures: GoalFailures) => failures.goal ?? Object.values(failures.lanes)[0] ?? null;
const validFailure = (value: WorkflowFailure | null) => !!value && Number.isFinite(Date.parse(value.at)) && typeof value.message === "string" && typeof value.retryable === "boolean";
function rejectedLegacyWorker(lane: LaneJournal): boolean {
  return !lane.built && lane.sessions.some((session) => {
    if (session.role !== "worker" || session.status !== "complete") return false;
    try {
      const response = session.result?.response;
      const summary = laneAgentSummary(response);
      const content = (response as { content?: unknown }).content;
      return summary.neededButUnowned.length > 0 || !(content === null || typeof content === "string");
    } catch { return false; }
  });
}
function retainedFailures(record: GoalRuntimeRecord, journal: GoalJournal): GoalFailures {
  const failures: GoalFailures = { goal: record.failure, lanes: {} };
  // The old runner saved only the first rejection. Attribute this known failure only from retained
  // rejected outputs; an unbuilt sibling without that evidence still requires a goal-wide retry.
  if (record.failure?.message !== "Worker needs unowned files or returned invalid content." || !record.plan) return failures;
  const rejected = record.plan.lanes.filter((lane) => journal.lanes[lane.id] && rejectedLegacyWorker(journal.lanes[lane.id]));
  if (!rejected.length || Object.values(journal.lanes).some((lane) => !lane.built && !rejected.some((item) => item.id === lane.id))) return failures;
  failures.goal = null;
  for (const lane of rejected) { failures.lanes[lane.id] = record.failure; record.lanes.find((item) => item.id === lane.id)!.status = "failed"; }
  return failures;
}
export const developerGoalJournalName = (goalId: string) => `developer-${goalRuntimeFilename(goalId)}`;
export function wholeGoalEligible(goal: PlanningGoal, seatId: string): boolean {
  return goal.workflowModel === "goals-v1" && goal.stage === "approved" && goal.ceremony?.stage === "implement" && !goal.ceremony.closure
    && goal.integration?.branch === `sprint/${goal.id}` && goal.integration.status === "collecting" && goal.goalAssignment?.seatId === seatId
    && ["assigned", "running", "reported"].includes(goal.goalAssignment.status);
}
const developerPlan = (value: unknown, goal: PlanningGoal) => {
  const plan = validateLanePlan(value, goal.ownedFiles);
  if (plan.goalId !== goal.id || plan.lanes.some((lane) => lane.id === "integration" || lane.branch !== `codex/${goal.id}/${lane.id}`)) throw new LaneError("Every lane must use its reserved goal branch namespace; integration belongs to the Scheduler.");
  return plan;
};
const progress = (lane: GoalLane): GoalLaneProgress => ({ ...lane, status: "queued", prUrl: null, headSha: null, mergedSha: null, reviewer: null, review: "pending", ci: "pending", findings: [], fixRounds: 0, conflictRounds: 0, decisions: [], followUps: [], updatedAt: now() });

/** One serialized finite turn. The Scheduler initializes the public record; only this Developer writes it after assignment. */
export class DeveloperGoal {
  private readonly services: DeveloperLaneServices;
  constructor(private readonly store: PlanningStore, private readonly seatId: string, shell: Shell, runtimeFor: (cwd: string, write?: WriteAccess) => AgentRuntime, private readonly log: (message: string) => void = () => {}, services?: DeveloperLaneServices) {
    this.services = services ?? new GitDeveloperLanes(store, shell, runtimeFor);
  }
  async turn(event: WorkflowEvent): Promise<{ events: WorkflowEvent[]; report: GoalReport | null }> {
    const idle = { events: [], report: null };
    if (!event || typeof event.teamId !== "string" || !Number.isFinite(Date.parse(event.at)) || (event.kind !== "startup" && (typeof event.id !== "string" || !event.id.trim()))) throw new LaneError("Invalid workflow event identity.");
    if (!["startup", "approval", "ci", "review", "merge", "redirect", "conflict", "agent-completed", "retry"].includes(event.kind)) return idle;
    const laneEvent = ["ci", "review", "merge", "conflict", "agent-completed"].includes(event.kind);
    if (laneEvent && "laneId" in event && event.laneId === "integration") return idle;
    const state = await this.store.read();
    const eligible = (state.planningGoals ?? []).filter((goal) => wholeGoalEligible(goal, this.seatId) && goal.teamId === event.teamId);
    const mine = "goalId" in event && event.goalId ? eligible.filter((goal) => goal.id === event.goalId) : eligible.filter((goal) => goal.goalAssignment!.status !== "reported");
    if (!mine.length) return idle;
    if (mine.length !== 1) throw new LaneError("Developer event does not identify exactly one whole-goal assignment.");
    return withCircuitScope(this.store.runtimeDir, mine[0].id, "implement", () => this.store.withGoalLock(mine[0].id, async () => {
      const current = await this.store.read();
      const goal = current.planningGoals?.find((item) => item.id === mine[0].id);
      if (!goal || !wholeGoalEligible(goal, this.seatId) || (goal.goalAssignment!.status === "reported" && laneEvent)) return idle;
      const name = goalRuntimeFilename(goal.id);
      const record = await this.store.readRuntimeFile<GoalRuntimeRecord>(name);
      if (!record || record.version !== 1 || record.goalId !== goal.id || record.teamId !== goal.teamId || record.assignment?.seatId !== this.seatId || !record.brief || !Array.isArray(record.handledEventIds) || !Array.isArray(record.events) || !Array.isArray(record.redirects) || !Array.isArray(record.lanes)) throw new LaneError("The assigned goal has no usable public runtime record and brief.");
      const brief = validateGoalBrief(record.brief);
      if (brief.goalId !== goal.id || brief.teamId !== goal.teamId || brief.seatId !== this.seatId || brief.header.repo !== teamProject(current, goal.teamId) || brief.header.branch !== goal.integration!.branch || brief.header.baseSha !== goal.integration!.baseSha || brief.header.prTarget !== "main" || JSON.stringify(brief.ownedFiles) !== JSON.stringify(goal.ownedFiles) || JSON.stringify(brief.outcomes) !== JSON.stringify(goal.goalProposal!.outcomes)) throw new LaneError("The brief differs from the approved goal, team repository or assignment.");
      const journalName = developerGoalJournalName(goal.id);
      const journal = await this.store.readRuntimeFile<GoalJournal>(journalName) ?? { version: 1, goalId: goal.id, seatId: this.seatId, github: brief.header.repo, planning: [], lanes: {} };
      if (journal.version !== 1 || journal.goalId !== goal.id || journal.seatId !== this.seatId || journal.github !== brief.header.repo || !Array.isArray(journal.planning) || !journal.lanes || typeof journal.lanes !== "object") throw new LaneError("The Developer journal belongs to another goal or seat.");
      let pendingWrite = Promise.resolve();
      const persist = () => {
        pendingWrite = pendingWrite.then(async () => { record.updatedAt = now(); await this.store.saveRuntime(journalName, journal); await this.store.saveRuntime(name, record); });
        return pendingWrite;
      };
      const emitted: WorkflowEvent[] = [];
      const emit = (output: WorkflowEvent) => {
        if (output.kind === "startup") return;
        if (!record.events.some((item) => item.kind !== "startup" && item.id === output.id)) { record.events.push(output); emitted.push(output); }
      };
      const reportEvent = (report: GoalReport): WorkflowEvent => ({ kind: "developer-report", id: `developer-report:${goal.id}:${report.headSha}`, teamId: goal.teamId, goalId: goal.id, seatId: this.seatId, at: record.updatedAt, report });
      if (record.report) {
        const report = validateGoalReport(record.report);
        if (report.goalId !== goal.id || report.seatId !== this.seatId || report.teamId !== goal.teamId) throw new LaneError("Saved report identity differs from its assignment.");
        const plan = developerPlan(record.plan, goal);
        if (plan.goalId !== goal.id || report.checks.some((check) => check.exitCode !== 0) || report.lanePrs.length !== plan.lanes.length
          || plan.lanes.some((lane) => {
            const saved = journal.lanes[lane.id]; const proof = report.lanePrs.find((item) => item.laneId === lane.id);
            return !saved || !proof || proof.url !== saved.prUrl || proof.headSha !== saved.headSha || proof.mergedSha !== saved.mergedSha;
          })) throw new LaneError("Saved report does not match the observed lane journal.");
        const verified = await this.services.finish(brief, plan.lanes.map((lane) => ({ lane, journal: journal.lanes[lane.id] })));
        if (verified.headSha !== report.headSha || JSON.stringify(verified.checks) !== JSON.stringify(report.checks)) throw new LaneError("Saved report no longer matches the verified sprint head and check evidence.");
        await this.status(goal.id, "reported");
        // Idempotent outbox replay closes a crash gap between saved report and host delivery.
        return { events: [record.events.find((item) => item.kind === "developer-report" && item.report.headSha === report.headSha) ?? reportEvent(report)], report };
      }
      if (event.kind !== "startup" && record.handledEventIds.includes(event.id)) return idle;
      if (journal.consumedRetryIds && (!Array.isArray(journal.consumedRetryIds) || journal.consumedRetryIds.some((item) => typeof item !== "string" || !item.trim()))) throw new LaneError("Invalid saved retry identities.");
      if (event.kind === "retry" && journal.consumedRetryIds?.includes(event.id)) return idle;
      if (event.kind === "retry") await new CircuitBudget({ runtimeDir: this.store.runtimeDir, scopeId: goal.id }).assertAvailable();
      if (record.plan) {
        developerPlan(record.plan, goal);
        if (record.plan.goalId !== goal.id || record.lanes.length !== record.plan.lanes.length || record.plan.lanes.some((lane) => !record.lanes.some((item) => item.id === lane.id && item.branch === lane.branch && JSON.stringify(item.ownedFiles) === JSON.stringify(lane.ownedFiles)))) throw new LaneError("Persisted lane progress differs from its approved plan.");
      }
      if (journal.failures && ((journal.failures.goal !== null && !validFailure(journal.failures.goal)) || !journal.failures.lanes || typeof journal.failures.lanes !== "object" || Array.isArray(journal.failures.lanes)
        || Object.entries(journal.failures.lanes).some(([laneId, failure]) => !record.plan?.lanes.some((lane) => lane.id === laneId) || !validFailure(failure)))) throw new LaneError("Invalid saved failure attribution.");
      if (!this.acceptEvent(event, goal, record, journal)) return idle;
      if (event.kind === "redirect") {
        if (!record.redirects.some((item) => item.postId === event.redirect.postId)) record.redirects.push(event.redirect);
      }
      const failures = journal.failures ??= retainedFailures(record, journal);
      record.failure = aggregateFailure(failures);
      if (failures.goal && event.kind !== "retry") return idle;
      if (event.kind === "retry") {
        const blocked = Object.keys(failures.lanes);
        const retryAll = !!failures.goal || !blocked.length;
        for (const lane of Object.values(journal.lanes)) {
          const laneProgress = record.lanes.find((item) => item.id === lane.id);
          if (laneProgress?.status === "merged" || (!retryAll && !blocked.includes(lane.id))) continue;
          lane.attempt++;
          if (laneProgress?.status === "failed") laneProgress.status = lane.prUrl ? "pr-open" : "queued";
        }
        failures.goal = null; failures.lanes = {};
        record.failure = null;
        // Unknown/failed session history stays retained. A retry gets fresh contexts that preserve existing draft work.
        for (const run of journal.planning) if (run.status === "started") run.status = "failed";
        // Save consumption with the attempt counters, before any work. The private receipt also closes
        // a crash between the journal write and the public event receipt.
        (journal.consumedRetryIds ??= []).push(event.id); record.handledEventIds.push(event.id); await persist();
      }
      const workingBrief = validateGoalBrief({ ...brief, redirects: [...brief.redirects, ...record.redirects.filter((item) => !brief.redirects.some((old) => old.postId === item.postId))] });
      try {
        if (goal.goalAssignment!.status === "assigned") await this.status(goal.id, "running");
        record.assignment = { seatId: this.seatId, status: "running", updatedAt: now() }; await persist();
        if (!record.plan) {
          record.plan = developerPlan(await this.services.plan(workingBrief, journal.planning, persist), goal);
          record.lanes = record.plan.lanes.map(progress); await persist();
        }
        const plan = record.plan;
        const ready = plan.lanes.filter((lane) => !failures.lanes[lane.id] && lane.dependsOn.every((dependency) => record.lanes.find((item) => item.id === dependency)?.status === "merged") && record.lanes.find((item) => item.id === lane.id)!.status !== "merged");
        // Every ready sibling has disjoint files, its own context and checkout. No lane waits for another lane's CI.
        const results = await Promise.allSettled(ready.map(async (lane) => {
          const laneProgress = record.lanes.find((item) => item.id === lane.id)!;
          journal.lanes[lane.id] ??= this.services.create(lane, workingBrief); const saved = journal.lanes[lane.id];
          if (saved.id !== lane.id || saved.branch !== lane.branch) throw new LaneError("Lane journal does not match the reserved branch.");
          await persist();
          const scoped = laneBrief(workingBrief, lane, plan.lanes, saved.baseSha || workingBrief.header.baseSha);
          if (!saved.built) { laneProgress.status = "running"; await persist(); await this.services.build(lane, scoped, saved, persist); }
          if (!saved.prUrl) {
            const failedCheck = [...saved.checks].reverse().find((check) => check.exitCode !== 0);
            if (event.kind === "retry" && failedCheck) {
              const key = id([failedCheck.headSha, failedCheck.command, failedCheck.diagnostic]);
              await this.services.fix(lane, scoped, saved, `${failedCheck.command} exited ${failedCheck.exitCode}:\n${failedCheck.diagnostic}`, key, null, persist, true);
            }
            try {
              laneProgress.prUrl = saved.prUrl ?? await this.services.publish(lane, scoped, saved, persist);
            } catch (error) {
              // Before the first PR, any durable fix reservation consumes this lane's one automatic validation repair.
              // A restart may replay a cached failure, but must not launch a second fix for its changed head.
              if (!(error instanceof LaneValidationError) || saved.fixes.length) throw error;
              const check = error.check; const key = id([check.headSha, check.command, check.diagnostic]);
              laneProgress.fixRounds++; await persist();
              await this.services.fix(lane, scoped, saved, `${check.command} exited ${check.exitCode}:\n${check.diagnostic}`, key, null, persist);
              laneProgress.prUrl = saved.prUrl;
            }
            laneProgress.status = "pr-open"; laneProgress.headSha = saved.headSha;
            emit({ kind: "agent-completed", id: `lead:${goal.id}:${lane.id}:${saved.headSha}`, goalId: goal.id, teamId: goal.teamId, laneId: lane.id, agentId: `lead:${lane.id}:${saved.attempt}`, status: "succeeded", headSha: saved.headSha, report: null, at: now() }); await persist();
          }
          laneProgress.prUrl = saved.prUrl; // Recover a crash after publication persisted its URL.
          let observation = await this.services.observe(lane, scoped, saved);
          if (observation.state === "CLOSED") throw new LaneError(`Lane ${lane.id} PR closed without merging; its checkout is retained.`);
          if (observation.state === "OPEN" && (saved.review?.headSha !== observation.headSha || !saved.review.posted)) {
            laneProgress.status = "reviewing"; await persist();
            // Review starts on opening, independent of CI state.
            await this.services.review(lane, scoped, saved, observation, persist);
            emit({ kind: "review", id: `review:${goal.id}:${lane.id}:${saved.review!.id}`, goalId: goal.id, teamId: goal.teamId, laneId: lane.id, prUrl: saved.prUrl!, headSha: observation.headSha, reviewer: GOAL_REVIEWER, state: saved.review!.findings.length ? "changes-requested" : "approved", findings: saved.review!.comments.map((item) => ({ path: item.path, line: item.line, reason: item.body })), at: now() });
            observation = await this.services.observe(lane, scoped, saved);
          }
          laneProgress.headSha = observation.headSha; laneProgress.ci = observation.ci; laneProgress.review = observation.reviewed ? "approved" : saved.review?.findings.length ? "changes-requested" : "pending"; laneProgress.reviewer = observation.reviewer ?? null;
          laneProgress.findings = saved.review?.comments.map((item) => ({ path: item.path, line: item.line, reason: item.body })) ?? [];
          const findings = saved.review?.headSha === observation.headSha ? saved.review.findings : [];
          const problem = findings.length ? findings.join("\n") : observation.ci === "failed" ? observation.ciFailure : observation.conflict ? `PR ${observation.url} conflicts with sprint commit ${observation.baseSha}.` : null;
          if (problem && observation.state === "OPEN") {
            const key = id([observation.headSha, problem]);
            if (saved.fixes.includes(key) && (event.kind !== "retry" || saved.fixAttempts?.some((attempt) => attempt.key === key && attempt.status === "complete"))) throw new LaneError(`Lane ${lane.id} retains an unresolved already-attempted problem.`);
            if (observation.conflict && !findings.length && observation.ci !== "failed") laneProgress.conflictRounds++; else laneProgress.fixRounds++;
            await persist();
            await this.services.fix(lane, scoped, saved, problem, key, observation.conflict && !findings.length && observation.ci !== "failed" ? observation.baseSha : null, persist, event.kind === "retry");
            observation = await this.services.observe(lane, scoped, saved);
            await this.services.review(lane, scoped, saved, observation, persist);
            laneProgress.headSha = saved.headSha; laneProgress.status = "pr-open";
            emit({ kind: "agent-completed", id: `fix:${goal.id}:${lane.id}:${key}`, goalId: goal.id, teamId: goal.teamId, laneId: lane.id, agentId: `fix:${lane.id}:${saved.attempt}`, status: "succeeded", headSha: saved.headSha, report: null, at: now() }); await persist();
            return; // Exactly one fix per problem/event turn; never an unbounded fix or check loop.
          }
          if (observation.state === "MERGED") {
            if (!observation.reviewed || observation.ci !== "passed" || !observation.mergedSha) throw new LaneError("External merge lacks verified current-head review or CI.");
            saved.mergedSha = observation.mergedSha;
          } else if (observation.reviewed && observation.ci === "passed") {
            laneProgress.status = "merging"; await persist();
            const merged = await this.services.merge(observation.url);
            if (!merged.merged) {
              laneProgress.status = "pr-open"; await persist();
              if (merged.reason.startsWith("Automatic merge blocked:")) throw new LaneError(merged.reason);
              return;
            }
            const confirmed = await this.services.observe(lane, scoped, saved);
            if (confirmed.state !== "MERGED" || confirmed.mergedSha !== merged.sha || confirmed.headSha !== observation.headSha || !confirmed.reviewed || confirmed.ci !== "passed") throw new LaneError("Lane merge was not confirmed at its reviewed head.");
            saved.mergedSha = merged.sha;
          }
          laneProgress.decisions = saved.summary?.decisions ?? []; laneProgress.followUps = saved.summary?.followUps ?? []; laneProgress.updatedAt = now();
          if (saved.mergedSha) {
            laneProgress.status = "merged"; laneProgress.mergedSha = saved.mergedSha;
            emit({ kind: "merge", id: `merge:${goal.id}:${lane.id}:${saved.mergedSha}`, goalId: goal.id, teamId: goal.teamId, laneId: lane.id, prUrl: saved.prUrl!, headSha: saved.headSha!, mergedSha: saved.mergedSha, at: now() });
          } else laneProgress.status = "pr-open";
          await persist();
        }));
        // Drain every started sibling before recording failures or releasing the goal lock. A failed
        // lane retains its own drafts while independent published lanes remain eligible for events.
        results.forEach((result, index) => {
          if (result.status !== "rejected") return;
          const lane = record.lanes.find((item) => item.id === ready[index].id)!;
          const failure = failureFor(result.reason); failures.lanes[lane.id] = failure;
          lane.status = "failed"; lane.updatedAt = failure.at; this.log(`Lane ${lane.id}: ${failure.message}`);
        });
        record.failure = aggregateFailure(failures);
        if (!record.failure && record.lanes.every((lane) => lane.status === "merged")) {
          const complete = await this.services.finish(workingBrief, plan.lanes.map((lane) => ({ lane, journal: journal.lanes[lane.id] })));
          const report = validateGoalReport({ version: 1, goalId: goal.id, teamId: goal.teamId, seatId: this.seatId, sprintBranch: goal.integration!.branch, headSha: complete.headSha,
            lanePrs: record.lanes.map((lane) => ({ laneId: lane.id, url: lane.prUrl, headSha: lane.headSha, mergedSha: lane.mergedSha, reviewer: lane.reviewer, ci: "passed" })), checks: complete.checks,
            decisions: record.lanes.flatMap((lane) => lane.decisions), followUps: [...record.lanes.flatMap((lane) => lane.followUps), ...complete.followUps], neededButUnowned: [] });
          if (report.checks.some((check) => check.exitCode !== 0)) throw new LaneError("The final sprint report cannot hide failed checks.");
          record.report = report; record.assignment = { seatId: this.seatId, status: "reported", updatedAt: now() }; emit(reportEvent(report)); await persist();
          await this.status(goal.id, "reported");
        }
        if (event.kind !== "startup" && !record.handledEventIds.includes(event.id)) record.handledEventIds.push(event.id);
        await persist(); return { events: emitted, report: record.report };
      } catch (error) {
        failures.goal = failureFor(error); record.failure = aggregateFailure(failures); await persist();
        this.log(failures.goal.message); return { events: emitted, report: null };
      }
    }));
  }
  private acceptEvent(event: WorkflowEvent, goal: PlanningGoal, record: GoalRuntimeRecord, journal: GoalJournal): boolean {
    if (["ci", "review", "merge", "conflict"].includes(event.kind)) {
      const eventWithPr = event as Extract<WorkflowEvent, { kind: "ci" | "review" | "merge" | "conflict" }>;
      if (!eventWithPr.laneId) return false;
      const lane = record.lanes.find((item) => item.id === eventWithPr.laneId);
      return !!lane && lane.prUrl === eventWithPr.prUrl && lane.headSha === eventWithPr.headSha;
    }
    if (event.kind === "agent-completed") {
      const lane = journal.lanes[event.laneId];
      return !!lane && event.headSha === lane.headSha && record.events.some((item) => item.kind === "agent-completed" && item.id === event.id && item.agentId === event.agentId);
    }
    if (event.kind === "redirect") return (event.goalId === null || event.goalId === goal.id) && typeof event.redirect?.postId === "string" && typeof event.redirect.message === "string";
    return true;
  }
  private async status(goalId: string, status: "running" | "reported"): Promise<void> {
    await this.store.update((state) => {
      const goal = state.planningGoals?.find((item) => item.id === goalId);
      if (!goal || !wholeGoalEligible(goal, this.seatId)) throw new LaneError("Whole-goal assignment changed during execution.");
      if (goal.goalAssignment!.status === "reported" || goal.goalAssignment!.status === status) return;
      goal.goalAssignment = { seatId: this.seatId, status, updatedAt: now() }; goal.updatedAt = now();
    }, `Developer ${this.seatId} marks goal ${goalId} ${status}`);
  }
}
