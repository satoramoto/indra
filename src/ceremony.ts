import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { PlanningGoal } from "./planning.js";

/** Closure is deliberately not a sixth stage. The legacy goal.stage is only a compatibility projection. */
export const CEREMONY_STAGES = ["planning", "proposal", "implement", "release", "retro"] as const;
export type CeremonyStage = typeof CEREMONY_STAGES[number];
export type HumanApproval =
  | { source: "owner-command"; command: "planning approve" | "planning merge"; at: string }
  | { source: "reaction"; userId: string; postId: string; emoji: "white_check_mark"; verifiedHuman: true; at: string };
export interface ApprovalEvidence {
  kind: "approval"; proposalId: string; proposalPostId: string; approval: HumanApproval;
}
export interface ImplementationEvidence {
  kind: "implementation";
  outcomes: { outcomeId: string; seatId: string; prUrl: string; baseBranch: string; mergedSha: string; checksPassed: true; reviewApproved: true }[];
}
export interface RunningReleaseEvidence {
  kind: "release-running"; prUrl: string; mergedSha: string; mergePostId: string; approval: HumanApproval;
  checksPassed: true; buildSha: string; runningSha: string; runningAt: string;
}
export interface PublishedRetroEvidence {
  kind: "retro-published"; path: string; prUrl: string; baseBranch: "main"; mergedSha: string; postId: string;
  publishedAt: string; factsOnly: true; suggestions: "owner-proposals-only";
}
export type CeremonyEntry =
  | { stage: "planning" | "proposal"; enteredAt: string | null }
  | { stage: "implement"; enteredAt: string | null; evidence: ApprovalEvidence }
  | { stage: "release"; enteredAt: string | null; evidence: ImplementationEvidence }
  | { stage: "retro"; enteredAt: string | null; evidence: RunningReleaseEvidence };
export interface CeremonyRecord {
  version: 1; stage: CeremonyStage; history: CeremonyEntry[];
  /** Only migration may record unknown entry times. Never substitute updatedAt for missing history. */
  migratedAt?: string;
  closure?: { closedAt: string; evidence: PublishedRetroEvidence };
}
export type CeremonyTransition =
  | { to: "proposal"; at: string }
  | { to: "implement"; at: string; evidence: ApprovalEvidence }
  | { to: "release"; at: string; evidence: ImplementationEvidence }
  | { to: "retro"; at: string; evidence: RunningReleaseEvidence };

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const text = ref("ceremonyText");
const time = ref("ceremonyTime");
const sha = ref("ceremonySha");
const id = ref("ceremonyId");
const approval = ref("ceremonyHumanApproval");
const entryTime = { anyOf: [time, { type: "null" }] };

/** Additive v1 schema contract. The fixture is the exact companion schema to land in indra-state before activation. */
export const CEREMONY_SCHEMA_DEFS = {
  ceremonyText: { type: "string", pattern: "\\S" },
  ceremonyTime: { type: "string", format: "date-time" },
  ceremonySha: { type: "string", pattern: "^[0-9a-f]{40}$" },
  ceremonyId: { type: "string", pattern: "^[a-z][a-z0-9-]+$" },
  ceremonyPr: { type: "string", pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$" },
  ceremonyHumanApproval: { oneOf: [
    object({ source: { const: "owner-command" }, command: { enum: ["planning approve", "planning merge"] }, at: time }),
    object({ source: { const: "reaction" }, userId: text, postId: text, emoji: { const: "white_check_mark" }, verifiedHuman: { const: true }, at: time }),
  ] },
  ceremonyApproval: object({ kind: { const: "approval" }, proposalId: id, proposalPostId: text, approval }),
  ceremonyImplementation: object({ kind: { const: "implementation" }, outcomes: {
    type: "array", minItems: 1, items: object({ outcomeId: id, seatId: id, prUrl: ref("ceremonyPr"), baseBranch: text, mergedSha: sha, checksPassed: { const: true }, reviewApproved: { const: true } }),
  } }),
  ceremonyRelease: object({ kind: { const: "release-running" }, prUrl: ref("ceremonyPr"), mergedSha: sha, mergePostId: text,
    approval, checksPassed: { const: true }, buildSha: sha, runningSha: sha, runningAt: time }),
  ceremonyRetro: object({ kind: { const: "retro-published" }, path: { type: "string", pattern: "^docs/retros/[a-z][a-z0-9-]+\\.md$" },
    prUrl: ref("ceremonyPr"), baseBranch: { const: "main" }, mergedSha: sha, postId: text, publishedAt: time,
    factsOnly: { const: true }, suggestions: { const: "owner-proposals-only" } }),
  ceremonyEntry: { oneOf: [
    object({ stage: { enum: ["planning", "proposal"] }, enteredAt: entryTime }),
    object({ stage: { const: "implement" }, enteredAt: entryTime, evidence: ref("ceremonyApproval") }),
    object({ stage: { const: "release" }, enteredAt: entryTime, evidence: ref("ceremonyImplementation") }),
    object({ stage: { const: "retro" }, enteredAt: entryTime, evidence: ref("ceremonyRelease") }),
  ] },
  ceremony: { ...object({ version: { const: 1 }, stage: { enum: [...CEREMONY_STAGES] },
    history: { type: "array", minItems: 1, maxItems: 5, items: ref("ceremonyEntry") }, migratedAt: time,
    closure: object({ closedAt: time, evidence: ref("ceremonyRetro") }),
  }, ["version", "stage", "history"]), allOf: [
    ...CEREMONY_STAGES.map((stage, index) => ({
      if: { properties: { stage: { const: stage } } },
      then: { properties: { history: { minItems: index + 1, maxItems: index + 1,
        prefixItems: CEREMONY_STAGES.slice(0, index + 1).map((name) => ({ properties: { stage: { const: name } } })),
      } } },
    })),
    { if: { required: ["closure"] }, then: { properties: { stage: { const: "retro" } } } },
    { if: { not: { required: ["migratedAt"] } }, then: { properties: { history: { items: { properties: { enteredAt: time } } } } } },
  ] },
};

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const shape = ajv.compile({ $defs: CEREMONY_SCHEMA_DEFS, $ref: "#/$defs/ceremony" });
export class CeremonyError extends Error {
  constructor(message: string) { super(message); this.name = "CeremonyError"; }
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CeremonyError(message);
}
function notBefore(at: string, previous: string | null | undefined): void {
  requireThat(!previous || Date.parse(at) >= Date.parse(previous), "Ceremony timestamps must be chronological.");
}
function validateHuman(value: HumanApproval, command: "planning approve" | "planning merge", postId: string, goal: PlanningGoal): void {
  if (value.source === "owner-command") requireThat(value.command === command, `Approval requires the owner's ${command} command.`);
  else requireThat(value.postId === postId && postId !== goal.mattermost.rootPostId, "Approval must be a human checkmark on the corresponding proposal or merge post.");
}
function validateApproval(goal: PlanningGoal, evidence: ApprovalEvidence): void {
  requireThat(goal.proposal?.id === evidence.proposalId, "Approval evidence must reference this goal's proposal.");
  validateHuman(evidence.approval, "planning approve", evidence.proposalPostId, goal);
  notBefore(evidence.approval.at, goal.proposal.createdAt);
  const outcomes = goal.proposal.outcomes;
  requireThat(goal.assignments?.length === outcomes.length && outcomes.every((outcome) => goal.assignments?.some((assignment) => assignment.outcomeId === outcome.id && assignment.seatId === outcome.seatId)), "Approval requires one assignment per proposed outcome, on its proposed seat.");
  requireThat(goal.integration?.branch === `sprint/${goal.id}`, "Approval requires this goal's sprint branch.");
}
function validateImplementation(goal: PlanningGoal, evidence: ImplementationEvidence): void {
  const outcomes = goal.proposal?.outcomes ?? [];
  requireThat(outcomes.length > 0 && evidence.outcomes.length === outcomes.length && new Set(evidence.outcomes.map((item) => item.outcomeId)).size === outcomes.length, "Implementation evidence must cover every outcome exactly once.");
  for (const item of evidence.outcomes) {
    const outcome = outcomes.find((outcome) => outcome.id === item.outcomeId);
    const assignment = goal.assignments?.find((assignment) => assignment.outcomeId === item.outcomeId);
    requireThat(outcome?.seatId === item.seatId && assignment?.seatId === item.seatId && assignment.status === "merged" && assignment.prUrl === item.prUrl && item.baseBranch === `sprint/${goal.id}`, "Implementation requires every assigned PR merged into this goal's sprint branch.");
  }
}
function validateRelease(goal: PlanningGoal, evidence: RunningReleaseEvidence): void {
  // A later owner-approved rollback does not erase the fact that this release ran.
  requireThat((goal.integration?.status === "merged" || goal.integration?.status === "reverted") && goal.integration.prUrl === evidence.prUrl && goal.integration.mergedSha === evidence.mergedSha, "Release evidence must reference the merged integration PR.");
  requireThat(evidence.buildSha === evidence.mergedSha && evidence.runningSha === evidence.mergedSha, "Release is complete only when the merged build is running.");
  validateHuman(evidence.approval, "planning merge", evidence.mergePostId, goal);
  notBefore(evidence.runningAt, evidence.approval.at);
}

/** Validate both the strict schema and goal-local references. Team and human identity checks live in planning.ts. */
export function validateCeremony(goal: PlanningGoal, ceremony: CeremonyRecord = goal.ceremony!): void {
  requireThat(shape(ceremony), "Invalid ceremony record or evidence.");
  const index = CEREMONY_STAGES.indexOf(ceremony.stage);
  requireThat(ceremony.history.length === index + 1 && ceremony.history.every((entry, i) => entry.stage === CEREMONY_STAGES[i]), "Ceremony history must contain the ordered stage prefix without skips or repeats.");
  let previous: string | null = goal.createdAt;
  for (const entry of ceremony.history) {
    const prior = previous;
    requireThat(entry.enteredAt !== null || ceremony.migratedAt !== undefined, "Only legacy migration may leave stage history unknown.");
    if (entry.enteredAt !== null) { notBefore(entry.enteredAt, previous); previous = entry.enteredAt; }
    if (entry.stage === "implement") {
      validateApproval(goal, entry.evidence);
      notBefore(entry.evidence.approval.at, prior);
      if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.approval.at);
      else if (ceremony.migratedAt) { notBefore(ceremony.migratedAt, entry.evidence.approval.at); previous = entry.evidence.approval.at; }
    }
    if (entry.stage === "release") validateImplementation(goal, entry.evidence);
    if (entry.stage === "retro") {
      validateRelease(goal, entry.evidence);
      notBefore(entry.evidence.approval.at, prior);
      if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.runningAt);
      else if (ceremony.migratedAt) { notBefore(ceremony.migratedAt, entry.evidence.runningAt); previous = entry.evidence.runningAt; }
    }
  }
  if (ceremony.migratedAt) notBefore(ceremony.migratedAt, goal.createdAt);
  if (ceremony.closure) {
    requireThat(ceremony.stage === "retro", "A goal can close only after retro.");
    requireThat(ceremony.closure.evidence.path === `docs/retros/${goal.id}.md`, "Published retro must reference this goal's document.");
    notBefore(ceremony.closure.evidence.publishedAt, previous);
    const release = ceremony.history.find((entry) => entry.stage === "retro");
    if (release?.stage === "retro") notBefore(ceremony.closure.evidence.publishedAt, release.evidence.runningAt);
    notBefore(ceremony.closure.closedAt, ceremony.closure.evidence.publishedAt);
  }
}

export function startCeremony(at: string): CeremonyRecord {
  const result: CeremonyRecord = { version: 1, stage: "planning", history: [{ stage: "planning", enteredAt: at }] };
  requireThat(shape(result), "Invalid ceremony start timestamp.");
  return result;
}

/** Use inside PlanningStore.update, together with the approval/assignment/integration changes it proves. */
export function advanceCeremony(goal: PlanningGoal, transition: CeremonyTransition): CeremonyRecord {
  const current = goal.ceremony;
  requireThat(current, "Legacy goals require evidence-based migration before transitions.");
  requireThat(!current.closure, "A closed goal cannot advance.");
  notBefore(transition.at, current.migratedAt);
  requireThat(CEREMONY_STAGES.indexOf(transition.to) === CEREMONY_STAGES.indexOf(current.stage) + 1, "Ceremony transitions must advance exactly one stage.");
  if (transition.to === "retro") requireThat(goal.integration?.status === "merged", "A running release requires a merged integration PR that has not been reverted.");
  const entry = { stage: transition.to, enteredAt: transition.at, ...("evidence" in transition ? { evidence: structuredClone(transition.evidence) } : {}) } as CeremonyEntry;
  const next = { ...structuredClone(current), stage: transition.to, history: [...structuredClone(current.history), entry] };
  validateCeremony(goal, next);
  return next;
}

export function closeCeremony(goal: PlanningGoal, at: string, evidence: PublishedRetroEvidence): CeremonyRecord {
  requireThat(goal.ceremony && !goal.ceremony.closure, "Closing requires an open ceremony.");
  notBefore(at, goal.ceremony.migratedAt);
  const next = { ...structuredClone(goal.ceremony), closure: { closedAt: at, evidence: structuredClone(evidence) } };
  validateCeremony(goal, next);
  return next;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Store-level guard: a generic mutator cannot erase, rewrite, skip or reopen the durable ceremony. */
export function validateCeremonyMutation(before: PlanningGoal, after: PlanningGoal | undefined): void {
  requireThat(after && after.teamId === before.teamId && after.createdAt === before.createdAt, "A ceremony goal cannot be removed or moved to another team.");
  if (!before.ceremony) {
    requireThat(after.ceremony?.migratedAt, "Existing goals require explicit evidence-based migration.");
    return;
  }
  const old = before.ceremony; const next = after.ceremony;
  requireThat(next, "A ceremony cannot be removed.");
  requireThat(next.migratedAt === old.migratedAt, "Migration provenance is immutable.");
  if (CEREMONY_STAGES.indexOf(old.stage) >= 2) requireThat(same(before.proposal, after.proposal), "An approved proposal is immutable.");
  requireThat(next.history.length >= old.history.length && next.history.length <= old.history.length + 1 && old.history.every((entry, i) => same(entry, next.history[i])), "Ceremony history is append-only, one stage at a time.");
  if (old.closure) requireThat(same(old, next), "A closed ceremony is immutable.");
  if (old.stage === "release" && next.stage === "retro") requireThat(after.integration?.status === "merged", "A running release requires a merged integration PR that has not been reverted.");
  if (next.closure && !old.closure) requireThat(old.stage === "retro" && next.stage === "retro", "Entering retro and closing it are separate steps.");
}

export interface LegacyEvidence { approval?: ApprovalEvidence; implementation?: ImplementationEvidence; release?: RunningReleaseEvidence; retro?: PublishedRetroEvidence }
export type LegacyMigration = { status: "ready"; ceremony: CeremonyRecord } | { status: "unknown"; missing: string[] };
/** Legacy flags never establish human approval, a running build, or publication of a retro. */
export function migrateLegacyCeremony(goal: PlanningGoal, evidence: LegacyEvidence, at: string): LegacyMigration {
  requireThat(!goal.ceremony, "Goal already has a ceremony.");
  const missing: string[] = [];
  if ((goal.stage === "approved" || evidence.implementation || evidence.release || evidence.retro) && !evidence.approval) missing.push("approval");
  if ((evidence.release || evidence.retro) && !evidence.implementation) missing.push("implementation");
  if (evidence.retro && !evidence.release) missing.push("running release");
  if (missing.length) return { status: "unknown", missing };
  const history: CeremonyEntry[] = [{ stage: "planning", enteredAt: goal.createdAt }];
  if (goal.stage !== "clarifying" || evidence.approval) history.push({ stage: "proposal", enteredAt: null });
  if (evidence.approval) history.push({ stage: "implement", enteredAt: null, evidence: structuredClone(evidence.approval) });
  if (evidence.implementation) history.push({ stage: "release", enteredAt: null, evidence: structuredClone(evidence.implementation) });
  if (evidence.release) history.push({ stage: "retro", enteredAt: null, evidence: structuredClone(evidence.release) });
  const ceremony: CeremonyRecord = { version: 1, stage: history.at(-1)!.stage, history, migratedAt: at,
    ...(evidence.retro ? { closure: { closedAt: at, evidence: structuredClone(evidence.retro) } } : {}),
  };
  validateCeremony(goal, ceremony);
  return { status: "ready", ceremony };
}

export interface TeamGoalConflict { teamId: string; goalIds: string[] }
/** Legacy goals are unclosed, even when their integration PR merged or was reverted. No record is silently closed. */
export function openGoalConflicts(goals: PlanningGoal[]): TeamGoalConflict[] {
  const byTeam = new Map<string, string[]>();
  for (const goal of goals) if (!goal.ceremony?.closure) byTeam.set(goal.teamId, [...(byTeam.get(goal.teamId) ?? []), goal.id]);
  return [...byTeam].filter(([, ids]) => ids.length > 1).map(([teamId, goalIds]) => ({ teamId, goalIds }));
}

export function assertTeamAvailable(goals: PlanningGoal[], teamId: string): void {
  const open = goals.filter((goal) => goal.teamId === teamId && !goal.ceremony?.closure);
  requireThat(!open.length, `Team ${teamId} has unclosed goals: ${open.map((goal) => goal.id).join(", ")}.`);
}
