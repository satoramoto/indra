import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseState } from "./local-state.js";

export interface PlanningGoal {
  id: string; teamId: string; seatId: string; participantSeatIds: string[]; goal: string; projectRefs: string[];
  stage: "clarifying" | "drafting" | "awaiting-review" | "approved"; createdAt: string; updatedAt: string;
  mattermost: { channelId: string; rootPostId: string };
  brief: { summary: string; decisions: string[]; openQuestions: string[] };
  proposal?: { id: string; createdAt: string; summary: string; outcomes: PlanningOutcome[]; risks: string[]; openQuestions: string[] };
  /** Present only once a human approved the proposal; one entry per outcome. */
  assignments?: PlanningAssignment[];
}
export interface PlanningOutcome { id: string; title: string; description: string; seatId: string }
export const ASSIGNMENT_STATUSES = ["queued", "running", "in-review", "merged", "failed"] as const;
export interface PlanningAssignment { outcomeId: string; seatId: string; status: typeof ASSIGNMENT_STATUSES[number]; updatedAt: string; prUrl?: string; note?: string }
interface SeatRecord { id: string; displayName?: string; roles?: unknown; externalIdentities?: { mattermost?: { userId?: string; username?: string } } }
interface TeamRecord { id: string; slug: string; seats: SeatRecord[] }

/** Developer seats on a team, in state order. */
export function developerSeats(state: PlanningDocument, teamId: string): SeatRecord[] {
  const team = (state.teams as TeamRecord[]).find((item) => item.id === teamId);
  return (team?.seats ?? []).filter((seat) => Array.isArray(seat.roles) && seat.roles.includes("Developer"));
}

/** Every outcome needs a distinct Developer seat until the seats run out; then no seat takes more than its fair share. */
export function validateOutcomeSeats(outcomes: PlanningOutcome[], developerSeatIds: string[]): void {
  if (!developerSeatIds.length) throw new Error("The team has no Developer seat to assign outcomes to.");
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (!developerSeatIds.includes(outcome.seatId)) throw new Error(`Outcome ${outcome.id} is assigned to ${outcome.seatId}, which is not a Developer seat on the team.`);
    counts.set(outcome.seatId, (counts.get(outcome.seatId) ?? 0) + 1);
  }
  const limit = Math.ceil(outcomes.length / developerSeatIds.length);
  if ([...counts.values()].some((count) => count > limit)) throw new Error(`Outcomes must be spread across Developer seats (at most ${limit} per seat).`);
}
export interface RuntimeRecord { sessionId?: string; lastSeenAt: number; processedPostIds: string[]; pending?: { inputPostId: string; message: string; since: number }; runs: { startedAt: string; finishedAt: string; usage?: unknown }[] }
export interface PlanningDocument { $schema: string; schemaVersion: number; teams: unknown[]; sprints: unknown[]; planningGoals?: PlanningGoal[] }

export function validatePlanningGoal(goal: PlanningGoal): void {
  if (!/^[a-z][a-z0-9-]+$/.test(goal.id) || !goal.teamId || !goal.seatId || !goal.goal.trim() || !goal.mattermost.channelId || !goal.mattermost.rootPostId) throw new Error("Invalid planning goal identity or conversation.");
  if (!goal.brief.summary.trim() || !Array.isArray(goal.brief.decisions) || goal.brief.decisions.some((item) => typeof item !== "string" || !item.trim()) || !Array.isArray(goal.brief.openQuestions) || goal.brief.openQuestions.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Invalid planning brief.");
  if (!["clarifying", "drafting", "awaiting-review", "approved"].includes(goal.stage)) throw new Error("Invalid planning stage.");
  if ((goal.stage === "awaiting-review" || goal.stage === "approved") !== Boolean(goal.proposal)) throw new Error("Proposal must exist exactly at awaiting-review and approved stages.");
  if (goal.assignments !== undefined && goal.stage !== "approved") throw new Error("Assignments are allowed only at approved stage.");
  if (goal.proposal && (!goal.proposal.summary.trim() || !Array.isArray(goal.proposal.outcomes) || !goal.proposal.outcomes.length || goal.proposal.outcomes.some((item) => !/^[a-z][a-z0-9-]+$/.test(item.id) || typeof item.title !== "string" || !item.title.trim() || typeof item.description !== "string" || !item.description.trim() || typeof item.seatId !== "string" || !/^[a-z][a-z0-9-]+$/.test(item.seatId)) || new Set(goal.proposal.outcomes.map((item) => item.id)).size !== goal.proposal.outcomes.length || !Array.isArray(goal.proposal.risks) || goal.proposal.risks.some((item) => typeof item !== "string" || !item.trim()) || !Array.isArray(goal.proposal.openQuestions) || goal.proposal.openQuestions.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("Invalid proposal.");
  if (!Array.isArray(goal.projectRefs) || goal.projectRefs.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Invalid project references.");
  if (!Array.isArray(goal.participantSeatIds) || new Set(goal.participantSeatIds).size !== goal.participantSeatIds.length) throw new Error("Invalid participants.");
  if (goal.assignments !== undefined) {
    const outcomeIds = new Set(goal.proposal!.outcomes.map((item) => item.id));
    const text = (value: unknown) => value === undefined || (typeof value === "string" && !!value.trim());
    if (!Array.isArray(goal.assignments) || goal.assignments.some((item) => !item || typeof item !== "object" || Object.keys(item).some((key) => !["outcomeId", "seatId", "status", "updatedAt", "prUrl", "note"].includes(key)) || typeof item.seatId !== "string" || !/^[a-z][a-z0-9-]+$/.test(item.seatId) || !ASSIGNMENT_STATUSES.includes(item.status) || typeof item.updatedAt !== "string" || Number.isNaN(Date.parse(item.updatedAt)) || !text(item.prUrl) || !text(item.note))) throw new Error("Invalid assignment.");
    const unknown = goal.assignments.find((item) => !outcomeIds.has(item.outcomeId));
    if (unknown) throw new Error(`Assignment references unknown outcome ${String(unknown.outcomeId)}.`);
    if (new Set(goal.assignments.map((item) => item.outcomeId)).size !== goal.assignments.length) throw new Error("Each outcome may have only one assignment.");
  }
}

function validateDocument(state: PlanningDocument): void {
  const ids = new Set<string>();
  for (const goal of state.planningGoals ?? []) {
    validatePlanningGoal(goal);
    if (ids.has(goal.id)) throw new Error(`Duplicate planning goal ${goal.id}.`);
    ids.add(goal.id);
    const team = (state.teams as { id: string; seats: { id: string }[] }[]).find((item) => item.id === goal.teamId);
    if (!team) throw new Error(`Unknown planning team ${goal.teamId}.`);
    const seats = new Set(team.seats.map((item) => item.id));
    if (!seats.has(goal.seatId) || goal.participantSeatIds.some((id) => !seats.has(id))) throw new Error("Planning seat reference is outside the team.");
    const developers = new Set(developerSeats(state, goal.teamId).map((seat) => seat.id));
    const outcome = goal.proposal?.outcomes.find((item) => !developers.has(item.seatId));
    if (outcome) throw new Error(`Outcome ${outcome.id} seat ${outcome.seatId} is not a Developer seat on the team.`);
    const assignment = goal.assignments?.find((item) => !seats.has(item.seatId));
    if (assignment) throw new Error(`Assignment seat ${assignment.seatId} is outside the team.`);
  }
}

export class PlanningStore {
  constructor(readonly checkout: string, readonly runtimeDir = `${checkout}.runtime`) {}
  async read(): Promise<PlanningDocument> {
    const raw = JSON.parse(await readFile(join(this.checkout, "state.json"), "utf8")) as PlanningDocument;
    parseState(raw);
    validateDocument(raw);
    return raw;
  }
  async update(mutator: (state: PlanningDocument) => void): Promise<void> {
    const state = await this.read();
    mutator(state);
    validateDocument(state);
    parseState(state);
    const file = join(this.checkout, "state.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  }
  async runtime(id: string): Promise<RuntimeRecord> {
    try { return JSON.parse(await readFile(join(this.runtimeDir, `${id}.json`), "utf8")) as RuntimeRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { lastSeenAt: Date.now(), processedPostIds: [], runs: [] }; }
  }
  /** Reads a runtime file other than a planning goal's record; undefined when absent. */
  async readRuntimeFile<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.runtimeDir, `${name}.json`), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
  }
  async saveRuntime(id: string, runtime: object): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const file = join(this.runtimeDir, `${id}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(runtime), { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  }
}
