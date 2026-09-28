import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseState } from "./local-state.js";
import { ASSIGNMENT_STATUSES, type ApprovedOutcome, type Assignment } from "./assignment.js";

export interface PlanningGoal {
  id: string; teamId: string; seatId: string; participantSeatIds: string[]; goal: string; projectRefs: string[];
  stage: "clarifying" | "drafting" | "awaiting-review" | "approved"; createdAt: string; updatedAt: string;
  mattermost: { channelId: string; rootPostId: string };
  brief: { summary: string; decisions: string[]; openQuestions: string[] };
  proposal?: { id: string; createdAt: string; summary: string; outcomes: ApprovedOutcome[]; risks: string[]; openQuestions: string[] };
  assignments?: Assignment[];
}
export interface RuntimeRecord { sessionId?: string; lastSeenAt: number; processedPostIds: string[]; pending?: { inputPostId: string; message: string; since: number }; runs: { startedAt: string; finishedAt: string; usage?: unknown }[] }
export interface PlanningDocument { $schema: string; schemaVersion: number; teams: unknown[]; sprints: unknown[]; planningGoals?: PlanningGoal[] }

export function validatePlanningGoal(goal: PlanningGoal): void {
  if (!/^[a-z][a-z0-9-]+$/.test(goal.id) || !goal.teamId || !goal.seatId || !goal.goal.trim() || !goal.mattermost.channelId || !goal.mattermost.rootPostId) throw new Error("Invalid planning goal identity or conversation.");
  if (!goal.brief.summary.trim() || !Array.isArray(goal.brief.decisions) || goal.brief.decisions.some((item) => typeof item !== "string" || !item.trim()) || !Array.isArray(goal.brief.openQuestions) || goal.brief.openQuestions.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Invalid planning brief.");
  if ((goal.stage === "awaiting-review" || goal.stage === "approved") !== Boolean(goal.proposal)) throw new Error("Proposal must exist exactly at awaiting-review or approved stage.");
  if (goal.assignments !== undefined) {
    if (goal.stage !== "approved" || !Array.isArray(goal.assignments)) throw new Error("Assignments exist only on an approved goal.");
    const outcomes = new Set(goal.proposal!.outcomes.map((item) => item.id));
    if (goal.assignments.some((item) => !outcomes.has(item.outcomeId) || !item.seatId || !ASSIGNMENT_STATUSES.includes(item.status) || !item.updatedAt)) throw new Error("Invalid assignment.");
    if (new Set(goal.assignments.map((item) => item.outcomeId)).size !== goal.assignments.length) throw new Error("Duplicate assignment outcome.");
  }
  if (goal.proposal && (!goal.proposal.summary.trim() || !Array.isArray(goal.proposal.outcomes) || !goal.proposal.outcomes.length || goal.proposal.outcomes.some((item) => !item.title.trim() || !item.description.trim()) || !Array.isArray(goal.proposal.risks) || goal.proposal.risks.some((item) => typeof item !== "string" || !item.trim()) || !Array.isArray(goal.proposal.openQuestions) || goal.proposal.openQuestions.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("Invalid proposal.");
  if (!Array.isArray(goal.projectRefs) || goal.projectRefs.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Invalid project references.");
  if (!Array.isArray(goal.participantSeatIds) || new Set(goal.participantSeatIds).size !== goal.participantSeatIds.length) throw new Error("Invalid participants.");
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
    if (!seats.has(goal.seatId) || goal.participantSeatIds.some((id) => !seats.has(id)) || (goal.assignments ?? []).some((item) => !seats.has(item.seatId))) throw new Error("Planning seat reference is outside the team.");
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
