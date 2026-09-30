import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseState } from "./local-state.js";
import { StateCommitError, StateGit, withFileLock, type StateSyncResult } from "./state-commit.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { assertTeamAvailable, migrateLegacyCeremony, openGoalConflicts, startCeremony, validateCeremony, validateCeremonyMutation, type CeremonyRecord, type LegacyMigration, type TeamGoalConflict } from "./ceremony.js";
import { assertCeremonyReady, type CeremonyWriteReadiness } from "./ceremony-ports.js";
import { validateOwnedFiles, validateProductProposal, ownedFilesOverlap, type ProductProposal, type ProductProposalVetting, type GoalAssignment } from "./goal-contract.js";
import { advanceCeremony, type ApprovalEvidence } from "./ceremony.js";

/** What start-up migration did with one pre-ceremony goal. */
export type LegacyGoalMigration = { goalId: string } & ({ status: "migrated"; summary: string } | { status: "conflict"; reason: string });
/** "closed at release (legacy migration)" or "entered release", for commit subjects and the start-up report. */
export function legacyMigrationSummary(ceremony: CeremonyRecord): string {
  return ceremony.closure ? `closed at ${ceremony.stage} (legacy migration)` : `entered ${ceremony.stage}`;
}
/** Why a goal still has no ceremony: the conflict its recorded evidence shows, or that start-up has not migrated it yet. */
export function legacyMigrationBlocker(goal: PlanningGoal, at = new Date().toISOString()): string | undefined {
  if (goal.ceremony) return undefined;
  try {
    const results = [false, true].map((released) => migrateLegacyCeremony(goal, at, released));
    const integration = goal.integration;
    // A merged sprint also depends on inspecting its merge commit, which only start-up migration does.
    if (results.some((result) => result.status === "ready")) return integration?.status === "merged" && !integration.revertPrUrl
      ? "not migrated yet, or its merge commit could not be inspected in the project checkout; restart Indra to migrate it." : "not migrated yet; restart Indra to migrate it.";
    const conflict = results.find((result) => result.status === "conflict");
    return `evidence conflicts: ${conflict?.status === "conflict" ? conflict.reason : "unknown"} Fix it in indra-state; Indra will not guess.`;
  } catch (error) { return `evidence conflicts: ${error instanceof Error ? error.message : String(error)}`; }
}
/** Whether a legacy sprint's merged integration commit contains the ceremony code; undefined when it cannot be inspected. */
export type CeremonyReleaseCheck = (goal: PlanningGoal, mergedSha: string) => Promise<boolean | undefined>;

export type { GoalAssignment } from "./goal-contract.js";
export interface PlanningGoal {
  /** Explicit readiness boundary; absence always means historical per-outcome workflow. */
  workflowModel?: "goals-v1";
  ownedFiles?: string[];
  goalProposal?: ProductProposal;
  /** Approved goals wait without an assignment until an idle Developer is chosen. */
  goalAssignment?: GoalAssignment;
  id: string; teamId: string; seatId: string; participantSeatIds: string[]; goal: string; projectRefs: string[];
  stage: "clarifying" | "drafting" | "awaiting-review" | "approved"; createdAt: string; updatedAt: string;
  mattermost: { channelId: string; rootPostId: string };
  brief: { summary: string; decisions: string[]; openQuestions: string[] };
  proposal?: { id: string; createdAt: string; summary: string; outcomes: PlanningOutcome[]; risks: string[]; openQuestions: string[] };
  /** Present only once a human approved the proposal; one entry per outcome. */
  assignments?: PlanningAssignment[];
  /** The sprint's integration branch, created on approval; seats' PRs target it, and one PR takes it into main. */
  integration?: SprintIntegration;
  /** Canonical five-stage ceremony. Absent on legacy goals until evidence-based migration. */
  ceremony?: CeremonyRecord;
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
  pending?: { inputPostId: string; message: string; since: number; proposal?: boolean; mergePost?: MergeKind }; /** The owner's `planning propose`, waiting for the bridge's next poll. */ proposalRequest?: { requestedAt: number }; runs: { startedAt: string; finishedAt: string; usage?: unknown }[];
  /** Why the last proposal draft failed, redacted and capped; local only, never posted. */ lastDraftError?: { at: string; message: string } }
export interface PlanningDocument { $schema: string; schemaVersion: number; teams: unknown[];
  /** Retired draft sprints from before planning goals; `retireLegacySprints` empties them, keeping `[]` for older builds. */ sprints?: unknown[];
  planningGoals?: PlanningGoal[] }

export function validatePlanningGoal(goal: PlanningGoal): void {
  const fields = (value: unknown, allowed: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Invalid planning fields; runtime metadata belongs in runtime storage.");
  };
  const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && !Number.isNaN(Date.parse(value));
  fields(goal, ["id", "teamId", "seatId", "participantSeatIds", "goal", "projectRefs", "stage", "createdAt", "updatedAt", "mattermost", "brief", "proposal", "assignments", "integration", "ceremony", "workflowModel", "ownedFiles", "goalProposal", "goalAssignment"]);
  if (goal.workflowModel !== undefined && goal.workflowModel !== "goals-v1") throw new Error("Unsupported goal workflow model.");
  if (goal.workflowModel === "goals-v1") {
    if (goal.proposal !== undefined || goal.assignments !== undefined) throw new Error("Goal workflow cannot contain historical per-outcome proposals or assignments.");
    if (goal.ownedFiles !== undefined) validateOwnedFiles(goal.ownedFiles);
    if (goal.goalProposal !== undefined) {
      const proposal = validateProductProposal(goal.goalProposal);
      if (proposal.goalId !== goal.id) throw new Error("Product proposal must reference this goal.");
    }
    if (goal.stage === "approved" && (!goal.ownedFiles?.length || !goal.goalProposal || JSON.stringify(goal.ownedFiles) !== JSON.stringify(goal.goalProposal.ownedFiles))) throw new Error("Approval requires a nonempty ownedFiles scope matching the Product proposal.");
    if (goal.goalAssignment !== undefined) {
      fields(goal.goalAssignment, ["seatId", "status", "updatedAt"]);
      if (goal.stage !== "approved" || !/^[a-z][a-z0-9-]+$/.test(goal.goalAssignment.seatId) || !["assigned", "running", "reported", "failed"].includes(goal.goalAssignment.status) || !timestamp(goal.goalAssignment.updatedAt) || !goal.integration) throw new Error("Invalid whole-goal assignment or missing sprint integration.");
    }
    if (!goal.ceremony) throw new Error("New-model goals require native ceremony evidence.");
  } else if (goal.ownedFiles !== undefined || goal.goalProposal !== undefined || goal.goalAssignment !== undefined) throw new Error("Remodel fields require workflowModel goals-v1; legacy goals are never implicitly eligible.");
  if (!timestamp(goal.createdAt) || !timestamp(goal.updatedAt)) throw new Error("Invalid planning timestamps.");
  fields(goal.mattermost, ["channelId", "rootPostId"]);
  fields(goal.brief, ["summary", "decisions", "openQuestions"]);
  if (goal.proposal) {
    fields(goal.proposal, ["id", "createdAt", "summary", "outcomes", "risks", "openQuestions"]);
    if (!/^[a-z][a-z0-9-]+$/.test(goal.proposal.id) || !timestamp(goal.proposal.createdAt)) throw new Error("Invalid proposal identity or timestamp.");
    if (Array.isArray(goal.proposal.outcomes)) for (const item of goal.proposal.outcomes) fields(item, ["id", "title", "description", "seatId"]);
  }
  if (!/^[a-z][a-z0-9-]+$/.test(goal.id) || !goal.teamId || !goal.seatId || !goal.goal.trim() || !goal.mattermost.channelId || !goal.mattermost.rootPostId) throw new Error("Invalid planning goal identity or conversation.");
  if (!goal.brief.summary.trim() || !Array.isArray(goal.brief.decisions) || goal.brief.decisions.some((item) => typeof item !== "string" || !item.trim()) || !Array.isArray(goal.brief.openQuestions) || goal.brief.openQuestions.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Invalid planning brief.");
  if (!["clarifying", "drafting", "awaiting-review", "approved"].includes(goal.stage)) throw new Error("Invalid planning stage.");
  if ((goal.stage === "awaiting-review" || goal.stage === "approved") !== Boolean(goal.workflowModel === "goals-v1" ? goal.goalProposal : goal.proposal)) throw new Error("Proposal must exist exactly at awaiting-review and approved stages.");
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
  if (goal.ceremony !== undefined) {
    validateCeremony(goal);
    const stage = goal.ceremony.stage;
    if ((stage === "planning" && goal.stage !== "clarifying") || (stage === "proposal" && goal.stage === "approved") || (["implement", "release", "retro"].includes(stage) && goal.stage !== "approved")) throw new Error("Legacy planning stage must agree with the canonical ceremony.");
  }
}

/** Shared by every reader as well as the writer; legacy open-goal conflicts are reported separately, not repaired. */
export function validatePlanningDocument(state: PlanningDocument): void {
  if (state.planningGoals !== undefined && !Array.isArray(state.planningGoals)) throw new Error("planningGoals must be an array.");
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
    if (goal.workflowModel === "goals-v1") {
      if ((team as TeamRecord & { workflowModel?: string }).workflowModel !== "goals-v1") throw new Error("New-model goals require a ready goals-v1 team.");
      if (!(team.seats as SeatRecord[]).find((seat) => seat.id === goal.seatId && Array.isArray(seat.roles) && seat.roles.includes("Team Lead"))) throw new Error("The Team Lead owns goal scheduling.");
      if (goal.goalProposal && !(team.seats as SeatRecord[]).find((seat) => seat.id === goal.goalProposal!.productSeatId && Array.isArray(seat.roles) && seat.roles.includes("Product"))) throw new Error("Proposal provenance must name the team's Product seat.");
      if (goal.goalAssignment && !developers.has(goal.goalAssignment.seatId)) throw new Error("A whole goal must be assigned to a Developer on its team.");
    }
    // Closed historical outcomes identify the seat that did the work, not its present-day role.
    // Still require that exact seat to exist; closure never grants eligibility for another assignment.
    const closedLegacy = goal.workflowModel !== "goals-v1" && Boolean(goal.ceremony?.closure);
    const outcome = goal.proposal?.outcomes.find((item) => !seats.has(item.seatId) || (!closedLegacy && !developers.has(item.seatId)));
    if (outcome) throw new Error(closedLegacy ? `Historical outcome ${outcome.id} seat ${outcome.seatId} is outside the team.` : `Outcome ${outcome.id} seat ${outcome.seatId} is not a Developer seat on the team.`);
    const assignment = goal.assignments?.find((item) => !seats.has(item.seatId));
    if (assignment) throw new Error(`Assignment seat ${assignment.seatId} is outside the team.`);
    // In a ceremony goal, an assignment leaves its proposed seat only when an idle Developer seat on the team takes it over.
    const moved = !closedLegacy && goal.ceremony && goal.assignments?.find((item) => item.seatId !== goal.proposal?.outcomes.find((outcome) => outcome.id === item.outcomeId)?.seatId && !developers.has(item.seatId));
    if (moved) throw new Error(`Assignment ${moved.outcomeId} is off its proposed seat, and ${moved.seatId} is not a Developer seat on the team.`);
    const ineligible = !closedLegacy && goal.assignments?.find((item) => !developers.has(item.seatId));
    if (ineligible) throw new Error(`Assignment seat ${ineligible.seatId} is not a Developer seat on the team.`);
    if (goal.ceremony) {
      const home = requireTeamHome(state, goal.teamId);
      if (goal.mattermost.channelId !== home.channelId || !goal.projectRefs.includes(home.github)) throw new Error("Ceremony goal home channel and project must come from its team in state.");
      const botIds = new Set((team.seats as SeatRecord[]).map((seat) => seat.externalIdentities?.mattermost?.userId).filter(Boolean));
      for (const entry of goal.ceremony.history) {
        const approval = entry.stage === "retro" ? entry.evidence.approval : entry.stage === "implement" && entry.evidence.kind === "approval" ? entry.evidence.approval : undefined;
        if (!approval) continue;
        if (approval.source === "reaction" && botIds.has(approval.userId)) throw new Error("A team seat's reaction cannot supply human approval.");
      }
      const project = teamProject(state, goal.teamId);
      const prs = goal.ceremony.history.flatMap((entry) => entry.stage === "release" ? [...entry.evidence.outcomes.map((item) => item.prUrl), ...(entry.evidence.kind === "implementation" ? entry.evidence.goalDelivery?.lanePrs.map((item) => item.url) ?? [] : [])] : entry.stage === "retro" ? [entry.evidence.prUrl] : []);
      const closure = goal.ceremony.closure?.evidence;
      if (closure) prs.push(...["prUrl" in closure ? closure.prUrl : undefined, "revertPrUrl" in closure ? closure.revertPrUrl : undefined].filter((url): url is string => !!url));
      if (prs.some((url) => !project || !url.startsWith(`https://github.com/${project}/pull/`))) throw new Error("Ceremony PR evidence must belong to the team's project in state.");
    }
  }
  const published = (state.planningGoals ?? []).filter((goal) => goal.workflowModel === "goals-v1" && goal.goalProposal && goal.stage !== "approved" && !goal.ceremony?.closure);
  if (new Set(published.map((goal) => goal.teamId)).size !== published.length) throw new Error("Only one published Product proposal may await approval per team.");
  const active = (state.planningGoals ?? []).filter((goal) => goal.workflowModel === "goals-v1" && goal.goalAssignment && !goal.ceremony?.closure);
  for (const goal of active) if ((state.planningGoals ?? []).some((other) => other.workflowModel !== "goals-v1" && !other.ceremony?.closure && (other.teamId === goal.teamId || teamProject(state, other.teamId)?.toLowerCase() === teamProject(state, goal.teamId)?.toLowerCase()))) throw new Error("Unclosed legacy goals have unknown scope and block new dispatch.");
  for (let i = 0; i < active.length; i++) for (const other of active.slice(i + 1)) {
    const goal = active[i];
    if (goal.teamId !== other.teamId && teamProject(state, goal.teamId)?.toLowerCase() !== teamProject(state, other.teamId)?.toLowerCase()) continue;
    if (ownedFilesOverlap(goal.ownedFiles!, other.ownedFiles!)) throw new Error(`Active goals ${goal.id} and ${other.id} overlap owned files.`);
    const holding = (item: PlanningGoal) => item.goalAssignment?.status === "assigned" || item.goalAssignment?.status === "running";
    if (holding(goal) && holding(other) && goal.goalAssignment!.seatId === other.goalAssignment!.seatId) throw new Error("A Developer may hold only one goal at a time.");
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
  constructor(readonly checkout: string, readonly runtimeDir = `${checkout}.runtime`, private readonly ceremonyWrites?: CeremonyWriteReadiness) {}
  async read(): Promise<PlanningDocument> {
    const raw = JSON.parse(await readFile(join(this.checkout, "state.json"), "utf8")) as PlanningDocument;
    parseState(raw);
    return raw;
  }
  /** Explicit rollout entry point. Creation and the team lock share the state transaction, across processes. */
  async createGoal(goal: PlanningGoal): Promise<void> {
    assertCeremonyReady(this.ceremonyWrites);
    await this.update((state) => {
      if (goal.ceremony || goal.stage !== "clarifying") throw new Error("New goals must start at planning.");
      state.planningGoals = [...(state.planningGoals ?? []), { ...structuredClone(goal), ceremony: startCeremony(goal.createdAt) }];
    }, `Start planning goal ${goal.id}`);
  }
  /** Unpublished proposals live in Product runtime. Only an actual Product-authored root post creates a durable goal. */
  async publishProductProposal(teamId: string, input: ProductProposal, post: { id: string; userId: string; channelId: string; rootId: string; createdAt: string }, vetting: ProductProposalVetting): Promise<PlanningGoal> {
    const proposal = validateProductProposal(input);
    let published: PlanningGoal | undefined;
    await this.update((state) => {
      const home = requireTeamHome(state, teamId);
      const team = (state.teams as (TeamRecord & { workflowModel?: string })[]).find((item) => item.id === teamId);
      const product = team?.seats.find((seat) => seat.id === proposal.productSeatId && Array.isArray(seat.roles) && seat.roles.includes("Product"));
      const lead = team?.seats.find((seat) => Array.isArray(seat.roles) && seat.roles.includes("Team Lead"));
      if (team?.workflowModel !== "goals-v1" || !lead || !product || product.externalIdentities?.mattermost?.userId !== post.userId || post.channelId !== home.channelId || post.rootId !== "" || !post.id.trim()) throw new Error("Publication requires the team's Product-authored root proposal in its home channel.");
      if (!vetting || vetting.proposalId !== proposal.proposalId || vetting.leadSeatId !== lead.id || JSON.stringify(vetting.ownedFiles) !== JSON.stringify(proposal.ownedFiles) || !Array.isArray(vetting.notes) || vetting.notes.some((note) => typeof note !== "string") || !Number.isFinite(Date.parse(vetting.at))) throw new Error("Publication requires Team Lead vetting of this proposal and corrected owned files.");
      if ((state.planningGoals ?? []).some((goal) => goal.teamId === teamId && goal.workflowModel === "goals-v1" && goal.goalProposal && goal.stage !== "approved" && !goal.ceremony?.closure)) throw new Error("Only one published Product proposal may await approval per team.");
      if ((state.planningGoals ?? []).some((goal) => goal.id === proposal.goalId)) throw new Error("This Product goal is already published.");
      const ceremony = startCeremony(post.createdAt);
      published = { workflowModel: "goals-v1", id: proposal.goalId, teamId, seatId: lead.id, participantSeatIds: [], goal: proposal.summary, projectRefs: [home.github], stage: "awaiting-review", createdAt: post.createdAt, updatedAt: post.createdAt,
        mattermost: { channelId: home.channelId, rootPostId: post.id }, brief: { summary: proposal.summary, decisions: [], openQuestions: [] }, ownedFiles: [...proposal.ownedFiles], goalProposal: proposal,
        ceremony: { ...ceremony, stage: "proposal", history: [...ceremony.history, { stage: "proposal", enteredAt: post.createdAt }] } };
      state.planningGoals = [...(state.planningGoals ?? []), published];
    }, `Publish Product proposal ${proposal.proposalId}`);
    return structuredClone(published!);
  }
  /** One human proposal gate. Callers verify the reaction identity with GET before supplying evidence. */
  async approveGoal(id: string, evidence: ApprovalEvidence, at = new Date().toISOString()): Promise<void> {
    await this.update((state) => {
      const goal = state.planningGoals?.find((item) => item.id === id);
      if (!goal || goal.workflowModel !== "goals-v1" || goal.stage !== "awaiting-review") throw new Error("A remodel proposal must await human approval.");
      goal.stage = "approved";
      goal.ceremony = advanceCeremony(goal, { to: "implement", at, evidence });
      goal.updatedAt = at;
    }, `Approve whole goal ${id}`);
  }
  /** The state lock makes seat capacity and prospective file overlap atomic across schedulers. */
  async assignGoal(id: string, seatId: string, integration: SprintIntegration, at = new Date().toISOString()): Promise<void> {
    await this.update((state) => {
      const goal = state.planningGoals?.find((item) => item.id === id);
      if (!goal || goal.workflowModel !== "goals-v1" || goal.stage !== "approved" || goal.ceremony?.stage !== "implement" || goal.ceremony.closure || goal.goalAssignment) throw new Error("Only an approved, unassigned remodel goal can be dispatched.");
      if ((state.planningGoals ?? []).some((other) => (other.teamId === goal.teamId || teamProject(state, other.teamId)?.toLowerCase() === teamProject(state, goal.teamId)?.toLowerCase()) && other.workflowModel !== "goals-v1" && !other.ceremony?.closure)) throw new Error("Unclosed legacy goals block new dispatch until migration is complete.");
      goal.goalAssignment = { seatId, status: "assigned", updatedAt: at };
      goal.integration = structuredClone(integration);
      goal.updatedAt = at;
    }, `Assign whole goal ${id} to ${seatId}`);
  }
  /**
   * Gives every goal without a ceremony the one its recorded state proves (see `migrateLegacyCeremony`), one state
   * commit per goal through the normal write path. Goals whose evidence conflicts, or whose write fails, are left
   * unchanged and reported. Running it again changes nothing.
   */
  async migrateLegacyGoals(at = new Date().toISOString(), releasedWithCeremony: CeremonyReleaseCheck = async () => undefined): Promise<LegacyGoalMigration[]> {
    const goals = ((await this.read()).planningGoals ?? []).filter((goal) => !goal.ceremony);
    if (!goals.length) return [];
    assertCeremonyReady(this.ceremonyWrites);
    const results: LegacyGoalMigration[] = [];
    for (const legacy of goals) {
      const id = legacy.id;
      let result: LegacyMigration | undefined;
      try {
        // Only a merged integration without a revert PR needs its merge commit inspected; the answer is fixed for this write.
        const integration = legacy.integration;
        const released = integration?.status === "merged" && !integration.revertPrUrl && integration.mergedSha
          ? await releasedWithCeremony(legacy, integration.mergedSha).catch(() => undefined) : undefined;
        this.releaseFacts.set(id, released);
        await this.update((state) => {
          const goal = state.planningGoals?.find((item) => item.id === id);
          if (!goal || goal.ceremony || JSON.stringify(goal.integration) !== JSON.stringify(integration)) return;
          result = migrateLegacyCeremony(goal, at, released);
          if (result.status === "ready") goal.ceremony = result.ceremony;
        }, () => `Migrate legacy goal ${id} into the ceremony: ${result?.status === "ready" ? legacyMigrationSummary(result.ceremony) : "unchanged"}`);
      } catch (error) {
        // Someone's uncommitted edits block every write alike: one start-up error, not a conflict per goal.
        if (await new StateGit(this.checkout).dirty()) throw error;
        result = { status: "conflict", reason: `its migration could not be written: ${error instanceof Error ? error.message : String(error)}` };
      } finally { this.releaseFacts.delete(id); }
      if (result) results.push({ goalId: id, ...(result.status === "ready" ? { status: "migrated", summary: legacyMigrationSummary(result.ceremony) } : { status: "conflict", reason: result.reason }) });
    }
    return results;
  }
  /**
   * Empties the retired top-level `sprints` array (draft sprints from before planning goals) in one state commit
   * through the normal write path. The key stays, as `[]`, because builds before this one require it and rollback
   * must still read the state. Returns whether it removed anything; running it again changes nothing.
   */
  async retireLegacySprints(): Promise<boolean> {
    if (!(await this.read()).sprints?.length) return false;
    let removed = false;
    await this.update((state) => {
      if (!state.sprints?.length) return;
      state.sprints = [];
      removed = true;
    }, "Retire legacy draft sprints");
    return removed;
  }
  /** Start-up migration's merge-commit checks, keyed by goal, for the write guard of that one migration. */
  private readonly releaseFacts = new Map<string, boolean | undefined>();
  async teamConflicts(): Promise<TeamGoalConflict[]> { return openGoalConflicts((await this.read()).planningGoals ?? []); }
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
      const previous = structuredClone(state);
      mutator(state);
      await this.guardCeremonyWrite(previous, state);
      parseState(state);
      if (JSON.stringify(previous) === JSON.stringify(state)) return false;
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
    const written = await readFile(file, "utf8");
    if (await git.dirty() && sha256(written) === intent.sha256) {
      const state = JSON.parse(written) as PlanningDocument;
      parseState(state);
      // Recover only a write this rollout can still validate, never commit malformed state after a restart.
      if (state.planningGoals?.some((goal) => goal.ceremony)) await this.validateCeremonySchema(state);
      await git.commit(intent.message);
    }
    await rm(join(this.runtimeDir, `${COMMIT_INTENT}.json`), { force: true });
  }
  private async guardCeremonyWrite(before: PlanningDocument, after: PlanningDocument): Promise<void> {
    const oldGoals = before.planningGoals ?? []; const nextGoals = after.planningGoals ?? [];
    const active = this.ceremonyWrites || [...oldGoals, ...nextGoals].some((goal) => goal.ceremony);
    let changed = false;
    for (const old of oldGoals) {
      const next = nextGoals.find((goal) => goal.id === old.id);
      if (old.workflowModel !== next?.workflowModel) throw new Error("A goal workflow model is immutable; historical goals cannot be promoted implicitly.");
      if (old.workflowModel === "goals-v1" && old.goalProposal && (!next || JSON.stringify(old.goalProposal) !== JSON.stringify(next.goalProposal) || JSON.stringify(old.ownedFiles) !== JSON.stringify(next.ownedFiles))) throw new Error("A published Product proposal and its scope are immutable; refine unpublished queue entries instead.");
      if (old.workflowModel === "goals-v1" && old.stage === "approved") {
        if (!["ownedFiles", "goalProposal", "goal", "teamId", "seatId", "projectRefs"].every((key) => JSON.stringify(old[key as keyof PlanningGoal]) === JSON.stringify(next?.[key as keyof PlanningGoal]))) throw new Error("Approved goal scope and proposal are immutable.");
        if (old.goalAssignment && next?.goalAssignment?.seatId !== old.goalAssignment.seatId) throw new Error("A dispatched goal's Developer identity is immutable.");
      }
      if (active) validateCeremonyMutation(old, next, this.releaseFacts.get(old.id));
      if ((old.ceremony || next?.ceremony) && JSON.stringify(old) !== JSON.stringify(next)) changed = true;
    }
    const added = nextGoals.filter((goal) => !oldGoals.some((old) => old.id === goal.id));
    for (const goal of added) {
      if (!this.ceremonyWrites && !goal.ceremony && !oldGoals.some((old) => old.ceremony)) continue;
      assertCeremonyReady(this.ceremonyWrites);
      // Existing callers can still create clarifying goals after rollout; the store supplies their first stage.
      if (!goal.ceremony) goal.ceremony = startCeremony(goal.createdAt);
      const publishedProduct = goal.workflowModel === "goals-v1" && goal.stage === "awaiting-review" && goal.goalProposal && goal.ceremony.stage === "proposal" && JSON.stringify(goal.ceremony.history) === JSON.stringify([{ stage: "planning", enteredAt: goal.createdAt }, { stage: "proposal", enteredAt: goal.createdAt }]);
      if ((!publishedProduct && goal.ceremony.stage !== "planning") || goal.ceremony.migratedAt || goal.ceremony.closure) throw new Error("New goals must start at planning or as a published Product proposal.");
      if (goal.workflowModel !== "goals-v1") assertTeamAvailable([...oldGoals, ...added.filter((other) => other !== goal)], goal.teamId);
      changed = true;
    }
    if (changed) await this.validateCeremonySchema(after);
  }
  private async validateCeremonySchema(state: PlanningDocument): Promise<void> {
    assertCeremonyReady(this.ceremonyWrites);
    const schema = JSON.parse(await readFile(join(this.checkout, "schema/v1/state.schema.json"), "utf8")) as object;
    const ajv = new Ajv2020({ strict: false });
    addFormats.default(ajv);
    if (!ajv.compile(schema)(state)) throw new Error("The checkout's v1 schema does not accept this ceremony state; land the compatible schema before activating writes.");
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
