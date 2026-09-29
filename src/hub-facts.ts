import type { SeatTaskRecord } from "./developer-seat.js";
import { seatRecordName } from "./developer-maintenance.js";
import { implementationFactsName, type ImplementationFacts } from "./implementation-facts.js";
import { CLAUDE_MODEL, DEVELOPER_CLAUDE_EFFORT, PRODUCT_CLAUDE_EFFORT, TEAM_LEAD_CLAUDE_EFFORT } from "./claude-runtime.js";
import { DEVELOPER_CODEX_MODEL, DEVELOPER_CODEX_REASONING_EFFORT, PRODUCT_CODEX_MODEL, PRODUCT_CODEX_REASONING_EFFORT, TEAM_LEAD_CODEX_MODEL, TEAM_LEAD_CODEX_REASONING_EFFORT } from "./harness-home.js";
import { parseUsage, sumUsage, type CiState, type SeatStep } from "./hub-format.js";
import type { RuntimeEngine, TokenUsage } from "./runtime-facts.js";
import type { PlanningGoal } from "./planning.js";
import { goalRuntimeFilename, productRuntimeFilename, projectGoalRuntime, teamRuntimeFilename, type GoalRuntimeProjection, type GoalRuntimeRecord, type ProductRuntimeRecord, type SchedulerRuntimeRecord } from "./goal-contract.js";

export interface GoalSeatFacts { goalId: string; title: string; status: string; ownedFiles: string[]; progress?: GoalRuntimeProjection }

/** Only public runtime records with matching durable ownership are usable by the hub. */
export async function readGoalFacts(store: RuntimeFileReader, goal: PlanningGoal): Promise<GoalSeatFacts> {
  const facts: GoalSeatFacts = { goalId: goal.id, title: goal.goal, status: goal.goalAssignment?.status ?? "unassigned", ownedFiles: [...(goal.ownedFiles ?? [])] };
  try {
    const record = await store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename(goal.id));
    if (record?.version === 1 && record.goalId === goal.id && record.teamId === goal.teamId && record.assignment?.seatId === goal.goalAssignment?.seatId) {
      facts.progress = projectGoalRuntime(record);
    }
  } catch { /* Missing or malformed runtime facts are unknown, never invented progress. */ }
  return facts;
}

export async function readSchedulerFacts(store: RuntimeFileReader, teamId: string): Promise<SchedulerRuntimeRecord | undefined> {
  try {
    const record = await store.readRuntimeFile<SchedulerRuntimeRecord>(teamRuntimeFilename(teamId));
    if (record?.version !== 1 || record.teamId !== teamId || !Array.isArray(record.approvedQueue) || !Array.isArray(record.activeDispatches)) return;
    if (record.approvedQueue.some((item) => typeof item.goalId !== "string" || !Array.isArray(item.blockedByGoalIds) || !Array.isArray(item.ownedFiles))) return;
    return structuredClone(record);
  } catch { return; }
}

export async function readProductFacts(store: RuntimeFileReader, teamId: string, seatId: string): Promise<ProductRuntimeRecord | undefined> {
  try {
    const record = await store.readRuntimeFile<ProductRuntimeRecord>(productRuntimeFilename(teamId));
    if (record?.version !== 1 || record.teamId !== teamId || record.seatId !== seatId || !Array.isArray(record.queue)) return;
    if (record.queue.some((item) => typeof item.proposal?.summary !== "string" || typeof item.proposal.rank !== "number")) return;
    return structuredClone(record);
  } catch { return; }
}

/** Which harness a seat runs, with the model and effort its roles get (see codexConfigForRoles and claudeModelArgs). */
export interface SeatHarness { engine: RuntimeEngine; model: string; effort: string }

export function seatHarness(engine: RuntimeEngine, roles: readonly string[] | undefined): SeatHarness {
  const role = roles?.includes("Team Lead") ? "lead" : roles?.includes("Product") ? "product" : "developer";
  if (engine === "claude") return { engine, model: CLAUDE_MODEL, effort: { lead: TEAM_LEAD_CLAUDE_EFFORT, product: PRODUCT_CLAUDE_EFFORT, developer: DEVELOPER_CLAUDE_EFFORT }[role] };
  return {
    engine,
    model: { lead: TEAM_LEAD_CODEX_MODEL, product: PRODUCT_CODEX_MODEL, developer: DEVELOPER_CODEX_MODEL }[role],
    effort: { lead: TEAM_LEAD_CODEX_REASONING_EFFORT, product: PRODUCT_CODEX_REASONING_EFFORT, developer: DEVELOPER_CODEX_REASONING_EFFORT }[role],
  };
}

/** What the hub shows for one assignment, from the seat's task record and its implementation ledger. */
export interface AssignmentFacts {
  /** The seat's recorded step; absent before the seat picked the assignment up. */
  step?: SeatStep;
  fixRounds?: number;
  ci?: CiState;
  /** Summed over every recorded session of every attempt: the assignment's running cost. */
  usage?: TokenUsage;
  sessions: number;
  /** The recorded session handles, so a live total is never added on top of the same session's recorded one. */
  sessionIds?: string[];
  /** The engine of the newest recorded session. */
  engine?: RuntimeEngine;
  /** When the newest attempt was claimed, and when it ended if it has. */
  claimedAt?: string;
  endedAt?: string;
}

export interface RuntimeFileReader { readRuntimeFile<T>(name: string): Promise<T | undefined> }

const STEPS: SeatStep[] = ["worktree", "build", "review", "fix", "ci", "done"];

/** Two small runtime files per assignment; either may be missing. Never throws. */
export async function readAssignmentFacts(store: RuntimeFileReader, seatId: string, goalId: string, outcomeId: string): Promise<AssignmentFacts | undefined> {
  const [record, ledger] = await Promise.all([
    store.readRuntimeFile<SeatTaskRecord>(seatRecordName(seatId, goalId, outcomeId)).catch(() => undefined),
    store.readRuntimeFile<ImplementationFacts>(implementationFactsName(seatId, goalId, outcomeId)).catch(() => undefined),
  ]);
  return assignmentFacts(record, ledger);
}

/** Pure projection of the two records, so it is testable without files. */
export function assignmentFacts(record: SeatTaskRecord | undefined, ledger: ImplementationFacts | undefined): AssignmentFacts | undefined {
  const attempts = ledger?.version === 1 && Array.isArray(ledger.attempts) ? ledger.attempts : [];
  if (!record && !attempts.length) return undefined;
  const events = attempts.flatMap((attempt) => Array.isArray(attempt.events) ? attempt.events : []);
  const sessions = events.filter((event) => event.kind === "session" && event.session);
  // The ledger keeps every attempt's sessions; older records only have the task record's own list.
  const usage = sessions.length ? sumUsage(sessions.map((event) => parseUsage(event.session?.usage)))
    : sumUsage((record?.sessions ?? []).map((session) => parseUsage(session.usage)));
  const latest = attempts.at(-1);
  const latestEvents = latest && Array.isArray(latest.events) ? latest.events : [];
  const ci = [...latestEvents].reverse().find((event) => event.kind === "ci" || (event.kind === "merge" && event.result === "passed"));
  const step = record && STEPS.includes(record.step) ? record.step : undefined;
  const sessionIds = [...new Set([...sessions.map((event) => event.session?.sessionId), ...(record?.sessions ?? []).map((session) => session.sessionId)]
    .filter((id): id is string => typeof id === "string" && !!id))];
  return {
    ...(step ? { step } : {}),
    ...(typeof record?.reviewFixRounds === "number" ? { fixRounds: record.reviewFixRounds } : {}),
    ...(ci ? { ci: ci.result === "passed" ? "passed" : ci.result === "failed" ? "failed" : "pending" } : {}),
    ...(usage ? { usage } : {}),
    sessions: sessions.length || record?.sessions?.length || 0,
    ...(sessionIds.length ? { sessionIds } : {}),
    ...(sessions.at(-1)?.session?.engine ? { engine: sessions.at(-1)!.session!.engine } : {}),
    ...(latest?.claimedAt ? { claimedAt: latest.claimedAt } : {}),
    ...(latest?.terminal?.at ? { endedAt: latest.terminal.at } : {}),
  };
}
