import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseState } from "./local-state.js";
import { StateCommitError, StateGit, withFileLock, type StateSyncResult } from "./state-commit.js";

export interface PlanningGoal {
  id: string; teamId: string; seatId: string; participantSeatIds: string[]; goal: string; projectRefs: string[];
  stage: "clarifying" | "drafting" | "awaiting-review" | "approved"; createdAt: string; updatedAt: string;
  mattermost: { channelId: string; rootPostId: string };
  brief: { summary: string; decisions: string[]; openQuestions: string[] };
  proposal?: { id: string; createdAt: string; summary: string; outcomes: PlanningOutcome[]; risks: string[]; openQuestions: string[] };
  /** Present only once a human approved the proposal; one entry per outcome. */
  assignments?: PlanningAssignment[];
  /** The sprint's integration branch, created on approval; seats' PRs target it, and one PR takes it into main. */
  integration?: SprintIntegration;
}
export const INTEGRATION_STATUSES = ["collecting", "pr-open", "merged", "reverted"] as const;
/** `revertPrUrl` is the open or merged PR on main that reverts `mergedSha` (`planning rollback`). */
export interface SprintIntegration { branch: string; baseSha: string; status: typeof INTEGRATION_STATUSES[number]; prUrl?: string; mergedSha?: string; revertPrUrl?: string }
/** Which PR a merge post gates: the sprint's integration PR into main, or the PR on main that reverts it. */
export type MergeKind = "integration" | "revert";
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
/**
 * A goal's bridge metadata in `<state-checkout>.runtime`. `processedPostIds` holds every handled input: thread post IDs
 * and reaction keys. `pending.proposal` marks a reply that announces the proposal; once delivered, its post ID joins
 * `proposalPostIds`, the posts a ✅ reaction approves.
 */
export interface RuntimeRecord { sessionId?: string; lastSeenAt: number; processedPostIds: string[]; proposalPostIds?: string[];
  /** Posts announcing the sprint's integration PR or its revert PR; a person's ✅ on one merges that PR. */
  mergePosts?: { id: string; kind: MergeKind }[];
  pending?: { inputPostId: string; message: string; since: number; proposal?: boolean; mergePost?: MergeKind }; /** The owner's `planning propose`, waiting for the bridge's next poll. */ proposalRequest?: { requestedAt: number }; runs: { startedAt: string; finishedAt: string; usage?: unknown }[] }
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
  const text = (value: unknown) => value === undefined || (typeof value === "string" && !!value.trim());
  if (goal.integration !== undefined) {
    const item = goal.integration as unknown as Record<string, unknown>;
    const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    if (goal.stage !== "approved") throw new Error("A sprint integration is allowed only at approved stage.");
    if (!item || typeof item !== "object" || Object.keys(item).some((key) => !["branch", "baseSha", "status", "prUrl", "mergedSha", "revertPrUrl"].includes(key)) || item.branch !== `sprint/${goal.id}` || !sha(item.baseSha) || !INTEGRATION_STATUSES.includes(item.status as SprintIntegration["status"]) || !text(item.prUrl) || (item.mergedSha !== undefined && !sha(item.mergedSha)) || !text(item.revertPrUrl)) throw new Error("Invalid sprint integration.");
    if ((item.status !== "collecting" && !item.prUrl) || ((item.status === "merged" || item.status === "reverted") && !item.mergedSha) || (item.status === "reverted" && !item.revertPrUrl)) throw new Error(`Sprint integration at ${String(item.status)} is missing its PR or merge commit.`);
  }
  if (goal.assignments !== undefined) {
    const outcomeIds = new Set(goal.proposal!.outcomes.map((item) => item.id));
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

type TeamHomeRecord = { id: string; project?: { github?: string }; externalIdentities?: { mattermost?: { homeChannelId?: string } } };

/** The team's home channel, where Chick opens planning threads, when state records one. */
export function homeChannelId(state: PlanningDocument, teamId: string): string | undefined {
  return (state.teams as TeamHomeRecord[]).find((item) => item.id === teamId)?.externalIdentities?.mattermost?.homeChannelId;
}

/**
 * The Mattermost team and home channel of the team whose seat posts as `username`, when state records both.
 * Each bot joins only these, and only for itself.
 */
export function botTeamHome(state: PlanningDocument, username: string): { teamId: string; channelId: string } | undefined {
  const teams = state.teams as (TeamHomeRecord & { externalIdentities?: { mattermost?: { teamId?: string } }; seats?: { externalIdentities?: { mattermost?: { username?: string } } }[] })[];
  const team = teams.find((item) => (item.seats ?? []).some((seat) => seat.externalIdentities?.mattermost?.username === username));
  const teamId = team?.externalIdentities?.mattermost?.teamId; const channelId = team?.externalIdentities?.mattermost?.homeChannelId;
  return teamId && channelId ? { teamId, channelId } : undefined;
}

/** The team's GitHub project as `owner/repo`, when state records one. */
export function teamProject(state: PlanningDocument, teamId: string): string | undefined {
  return (state.teams as TeamHomeRecord[]).find((item) => item.id === teamId)?.project?.github;
}

/** The state fields a team still needs before planning can start; empty when it has both. */
export function missingTeamHome(team: { homeChannelId?: string; project?: { github?: string } } | undefined): string[] {
  return [
    ...(team?.homeChannelId ? [] : ["externalIdentities.mattermost.homeChannelId"]),
    ...(team?.project?.github ? [] : ["project.github"]),
  ];
}

/** The team's home channel and project, or an error naming each state field that is missing. */
export function requireTeamHome(state: PlanningDocument, teamId: string): { channelId: string; github: string } {
  const channelId = homeChannelId(state, teamId); const github = teamProject(state, teamId);
  if (!channelId || !github) throw new Error(missingTeamMessage(teamId, missingTeamHome({ homeChannelId: channelId, project: { github } })));
  return { channelId, github };
}

export function missingTeamMessage(team: string, missing: string[]): string {
  return `Team ${team} has no ${missing.join(" or ")} in state.json; record ${missing.length === 1 ? "it" : "them"} in indra-state first.`;
}

/** Written to the runtime directory just before state.json, removed once the change is committed. */
interface CommitIntent { sha256: string; message: string }
const COMMIT_INTENT = "state-commit";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}

export class PlanningStore {
  constructor(readonly checkout: string, readonly runtimeDir = `${checkout}.runtime`) {}
  async read(): Promise<PlanningDocument> {
    const raw = JSON.parse(await readFile(join(this.checkout, "state.json"), "utf8")) as PlanningDocument;
    parseState(raw);
    validateDocument(raw);
    return raw;
  }
  /**
   * Applies one change to state.json and commits it in the checkout with `message`, under a lock
   * shared by every Indra process. The commit contains only state.json. A change that cannot be
   * committed is rolled back and throws; uncommitted edits someone else made to state.json make the
   * write fail instead of being committed. Pushing runs afterwards in the background, best effort.
   */
  async update(mutator: (state: PlanningDocument) => void, message: string | ((state: PlanningDocument) => string)): Promise<void> {
    const git = new StateGit(this.checkout);
    const file = join(this.checkout, "state.json");
    const changed = await withFileLock(join(this.runtimeDir, "state.lock"), async () => {
      await this.recoverCommit(git, file);
      await git.assertClean();
      const before = await readFile(file, "utf8");
      const state = JSON.parse(before) as PlanningDocument;
      parseState(state);
      validateDocument(state);
      mutator(state);
      validateDocument(state);
      parseState(state);
      const after = `${JSON.stringify(state, null, 2)}\n`;
      if (after === before) return false;
      const subject = typeof message === "function" ? message(state) : message;
      await this.saveRuntime(COMMIT_INTENT, { sha256: sha256(after), message: subject } satisfies CommitIntent);
      await atomicWrite(file, after);
      try { await git.commit(subject); }
      catch (error) {
        await atomicWrite(file, before);
        await git.unstage();
        await rm(join(this.runtimeDir, `${COMMIT_INTENT}.json`), { force: true });
        throw new StateCommitError(`Could not commit the state change "${subject}"; state.json was rolled back.`, { cause: error });
      }
      await rm(join(this.runtimeDir, `${COMMIT_INTENT}.json`), { force: true });
      return true;
    });
    if (changed) git.pushInBackground();
  }
  /**
   * Syncs the checkout with its upstream under the same lock as writes, so it never interleaves with
   * a write or its commit. An unfinished commit is completed first. Never throws; see `StateGit.sync`.
   */
  async sync(): Promise<StateSyncResult> {
    const git = new StateGit(this.checkout);
    try {
      return await withFileLock(join(this.runtimeDir, "state.lock"), async () => {
        await this.recoverCommit(git, join(this.checkout, "state.json"));
        return await git.sync();
      });
    } catch (error) {
      return { outcome: "error", message: `State sync failed: ${error instanceof Error ? error.message : String(error)}`, changed: false, at: new Date().toISOString() };
    }
  }
  /** Finishes the commit of a write whose process stopped between writing state.json and committing it. */
  private async recoverCommit(git: StateGit, file: string): Promise<void> {
    const intent = await this.readRuntimeFile<CommitIntent>(COMMIT_INTENT);
    if (!intent) return;
    if (await git.dirty() && sha256(await readFile(file, "utf8")) === intent.sha256) await git.commit(intent.message);
    await rm(join(this.runtimeDir, `${COMMIT_INTENT}.json`), { force: true });
  }
  /** Serializes work on one goal's runtime metadata across Indra processes (the bridge and `planning approve`). */
  async withGoalLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    return await withFileLock(join(this.runtimeDir, `${id}.lock`), work);
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
