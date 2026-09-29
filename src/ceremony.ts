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
  omissions?: { outcomeId: string; seatId: string; reason: string }[];
  partialApproval?: { source: "owner-command"; command: "planning integrate"; at: string };
}
export interface RunningReleaseEvidence {
  kind: "release-running"; prUrl: string; mergedSha: string; mergePostId: string; approval: HumanApproval;
  checksPassed: true; buildSha: string; runningSha: string; runningAt: string;
  /** Required for a descendant build; the adapter verifies this exact commit pair in the team's project. */
  ancestry?: { ancestorSha: string; descendantSha: string; verified: true };
}
export interface PublishedRetroEvidence {
  kind: "retro-published"; path: string; prUrl: string; baseBranch: "main"; mergedSha: string; postId: string;
  publishedAt: string; factsOnly: true; suggestions: "owner-proposals-only";
}
/**
 * Migration-only proof, taken from what a pre-ceremony goal recorded in state: it reached `approved` (only the human
 * approval code set that stage) with one assignment per proposed outcome. Who approved, and when, stays unknown.
 */
export interface LegacyApprovalEvidence { kind: "legacy-approval"; proposalId: string }
/** Migration-only proof: the recorded merged PR of each outcome; `unmerged` lists outcomes that failed. Merge SHAs, reviews and CI stay unknown. */
export interface LegacyImplementationEvidence {
  kind: "legacy-implementation";
  outcomes: { outcomeId: string; seatId: string; prUrl: string }[];
  unmerged?: { outcomeId: string; seatId: string }[];
}
/** Closes a goal whose integration PR was reverted on main before its release was verified running: there is no release to retro. */
export interface RevertedReleaseEvidence { kind: "release-reverted"; prUrl: string; mergedSha: string; revertPrUrl: string }
/**
 * Closes a pre-ceremony goal that had already finished: its integration merged or was reverted, or it had none and
 * every assignment merged. Recorded only by migration, at the migration time; no retro or timings are implied.
 */
export interface LegacyClosureEvidence {
  kind: "legacy-migration"; integration: "none" | "merged" | "reverted";
  prUrl?: string; mergedSha?: string; revertPrUrl?: string;
}
export type ClosureEvidence = PublishedRetroEvidence | RevertedReleaseEvidence | LegacyClosureEvidence;
export type CeremonyEntry =
  | { stage: "planning" | "proposal"; enteredAt: string | null }
  | { stage: "implement"; enteredAt: string | null; evidence: ApprovalEvidence | LegacyApprovalEvidence }
  | { stage: "release"; enteredAt: string | null; evidence: ImplementationEvidence | LegacyImplementationEvidence }
  | { stage: "retro"; enteredAt: string | null; evidence: RunningReleaseEvidence };
export interface CeremonyRecord {
  version: 1; stage: CeremonyStage; history: CeremonyEntry[];
  /** Only migration may record unknown entry times. Never substitute updatedAt for missing history. */
  migratedAt?: string;
  closure?: { closedAt: string; evidence: ClosureEvidence };
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
const closedBy = (kinds: string[]) => ({ required: ["closure"], properties: { closure: { properties: { evidence: { properties: { kind: { enum: kinds } } } } } } });

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
  ceremonyImplementation: { ...object({ kind: { const: "implementation" }, outcomes: {
    type: "array", minItems: 1, items: object({ outcomeId: id, seatId: id, prUrl: ref("ceremonyPr"), baseBranch: text, mergedSha: sha, checksPassed: { const: true }, reviewApproved: { const: true } }),
  }, omissions: { type: "array", minItems: 1, items: object({ outcomeId: id, seatId: id, reason: text }) },
  partialApproval: object({ source: { const: "owner-command" }, command: { const: "planning integrate" }, at: time }),
  }, ["kind", "outcomes"]), allOf: [
    { if: { required: ["omissions"] }, then: { required: ["partialApproval"] } },
    { if: { required: ["partialApproval"] }, then: { required: ["omissions"] } },
  ] },
  ceremonyRelease: object({ kind: { const: "release-running" }, prUrl: ref("ceremonyPr"), mergedSha: sha, mergePostId: text,
    approval, checksPassed: { const: true }, buildSha: sha, runningSha: sha, runningAt: time,
    ancestry: object({ ancestorSha: sha, descendantSha: sha, verified: { const: true } }),
  }, ["kind", "prUrl", "mergedSha", "mergePostId", "approval", "checksPassed", "buildSha", "runningSha", "runningAt"]),
  ceremonyRetro: object({ kind: { const: "retro-published" }, path: { type: "string", pattern: "^docs/retros/[a-z][a-z0-9-]+\\.md$" },
    prUrl: ref("ceremonyPr"), baseBranch: { const: "main" }, mergedSha: sha, postId: text, publishedAt: time,
    factsOnly: { const: true }, suggestions: { const: "owner-proposals-only" } }),
  ceremonyLegacyApproval: object({ kind: { const: "legacy-approval" }, proposalId: id }),
  ceremonyLegacyImplementation: object({ kind: { const: "legacy-implementation" },
    outcomes: { type: "array", minItems: 1, items: object({ outcomeId: id, seatId: id, prUrl: ref("ceremonyPr") }) },
    unmerged: { type: "array", minItems: 1, items: object({ outcomeId: id, seatId: id }) },
  }, ["kind", "outcomes"]),
  ceremonyRevertedRelease: object({ kind: { const: "release-reverted" }, prUrl: ref("ceremonyPr"), mergedSha: sha, revertPrUrl: ref("ceremonyPr") }),
  ceremonyLegacyClosure: object({ kind: { const: "legacy-migration" }, integration: { enum: ["none", "merged", "reverted"] },
    prUrl: ref("ceremonyPr"), mergedSha: sha, revertPrUrl: ref("ceremonyPr") }, ["kind", "integration"]),
  ceremonyEntry: { oneOf: [
    object({ stage: { enum: ["planning", "proposal"] }, enteredAt: entryTime }),
    object({ stage: { const: "implement" }, enteredAt: entryTime, evidence: ref("ceremonyApproval") }),
    object({ stage: { const: "implement" }, enteredAt: { type: "null" }, evidence: ref("ceremonyLegacyApproval") }),
    object({ stage: { const: "release" }, enteredAt: entryTime, evidence: ref("ceremonyImplementation") }),
    object({ stage: { const: "release" }, enteredAt: { type: "null" }, evidence: ref("ceremonyLegacyImplementation") }),
    object({ stage: { const: "retro" }, enteredAt: entryTime, evidence: ref("ceremonyRelease") }),
  ] },
  ceremony: { ...object({ version: { const: 1 }, stage: { enum: [...CEREMONY_STAGES] },
    history: { type: "array", minItems: 1, maxItems: 5, items: ref("ceremonyEntry") }, migratedAt: time,
    closure: object({ closedAt: time, evidence: { oneOf: [ref("ceremonyRetro"), ref("ceremonyRevertedRelease"), ref("ceremonyLegacyClosure")] } }),
  }, ["version", "stage", "history"]), allOf: [
    ...CEREMONY_STAGES.map((stage, index) => ({
      if: { properties: { stage: { const: stage } } },
      then: { properties: { history: { minItems: index + 1, maxItems: index + 1,
        prefixItems: CEREMONY_STAGES.slice(0, index + 1).map((name) => ({ properties: { stage: { const: name } } })),
      } } },
    })),
    { if: closedBy(["retro-published"]), then: { properties: { stage: { const: "retro" } } } },
    { if: closedBy(["release-reverted", "legacy-migration"]), then: { properties: { stage: { const: "release" } } } },
    { if: closedBy(["legacy-migration"]), then: { required: ["migratedAt"] } },
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
  // Seats match the proposal when approval is recorded (see advanceCeremony and validateCeremonyMutation); an idle seat may take over a queued outcome later.
  requireThat(oneAssignmentPerOutcome(goal), "Approval requires one assignment per proposed outcome.");
  requireThat(goal.integration?.branch === `sprint/${goal.id}`, "Approval requires this goal's sprint branch.");
}
function oneAssignmentPerOutcome(goal: PlanningGoal): boolean {
  const outcomes = goal.proposal?.outcomes ?? [];
  return outcomes.length > 0 && goal.assignments?.length === outcomes.length && outcomes.every((outcome) => goal.assignments?.some((assignment) => assignment.outcomeId === outcome.id));
}
const PROPOSED_SEATS = "Approval requires one assignment per proposed outcome, on its proposed seat.";
function validateImplementation(goal: PlanningGoal, evidence: ImplementationEvidence): void {
  const outcomes = goal.proposal?.outcomes ?? [];
  const accounted = [...evidence.outcomes, ...(evidence.omissions ?? [])];
  requireThat(outcomes.length > 0 && accounted.length === outcomes.length && new Set(accounted.map((item) => item.outcomeId)).size === outcomes.length, "Implementation evidence must cover every outcome exactly once.");
  for (const item of evidence.outcomes) {
    const outcome = outcomes.find((outcome) => outcome.id === item.outcomeId);
    const assignment = goal.assignments?.find((assignment) => assignment.outcomeId === item.outcomeId);
    requireThat(!!outcome && assignment?.seatId === item.seatId && assignment.status === "merged" && assignment.prUrl === item.prUrl && item.baseBranch === `sprint/${goal.id}`, "Implementation requires every assigned PR merged into this goal's sprint branch.");
  }
  for (const item of evidence.omissions ?? []) {
    const outcome = outcomes.find((outcome) => outcome.id === item.outcomeId);
    const assignment = goal.assignments?.find((assignment) => assignment.outcomeId === item.outcomeId);
    requireThat(!!outcome && assignment?.seatId === item.seatId && assignment.status === "failed", "Only terminal, unmerged outcomes may be explicitly omitted by the owner.");
  }
}
function assignmentsMatchOutcomes(goal: PlanningGoal): boolean {
  const outcomes = goal.proposal?.outcomes ?? [];
  return outcomes.length > 0 && goal.assignments?.length === outcomes.length && outcomes.every((outcome) => goal.assignments?.some((assignment) => assignment.outcomeId === outcome.id && assignment.seatId === outcome.seatId));
}
function validateLegacyApproval(goal: PlanningGoal, evidence: LegacyApprovalEvidence): void {
  // Migration itself requires proposed seats (migrateLegacyCeremony); later takeovers keep the evidence valid.
  requireThat(goal.stage === "approved" && goal.proposal?.id === evidence.proposalId && oneAssignmentPerOutcome(goal), "Legacy approval requires the approved proposal with one assignment per outcome, on its proposed seat.");
}
function validateLegacyImplementation(goal: PlanningGoal, evidence: LegacyImplementationEvidence): void {
  const outcomes = goal.proposal?.outcomes ?? [];
  const accounted = [...evidence.outcomes, ...(evidence.unmerged ?? [])];
  requireThat(outcomes.length > 0 && accounted.length === outcomes.length && new Set(accounted.map((item) => item.outcomeId)).size === outcomes.length, "Legacy implementation evidence must cover every outcome exactly once.");
  for (const item of accounted) {
    const assignment = goal.assignments?.find((assignment) => assignment.outcomeId === item.outcomeId);
    const merged = "prUrl" in item;
    requireThat(assignment?.seatId === item.seatId && (merged ? assignment.status === "merged" && assignment.prUrl === item.prUrl : assignment.status === "failed"), "Legacy implementation evidence must match each recorded merged or failed assignment.");
  }
}
/** Legacy closure stays valid if the integration is rolled back later: a merged record may since have been reverted. */
function validateLegacyClosure(goal: PlanningGoal, evidence: LegacyClosureEvidence): void {
  const integration = goal.integration;
  if (evidence.integration === "none") {
    requireThat(!integration && !evidence.prUrl && !evidence.mergedSha && !evidence.revertPrUrl && goal.assignments?.every((item) => item.status === "merged"), "A legacy goal without an integration closes only when every assignment merged.");
    return;
  }
  requireThat(integration && evidence.prUrl && evidence.mergedSha && integration.prUrl === evidence.prUrl && integration.mergedSha === evidence.mergedSha, "Legacy closure must reference the goal's recorded integration PR and merge commit.");
  if (evidence.integration === "merged") requireThat(!evidence.revertPrUrl && (integration.status === "merged" || integration.status === "reverted"), "Legacy closure requires a merged integration.");
  else requireThat(integration.status === "reverted" && integration.revertPrUrl === evidence.revertPrUrl, "Legacy closure requires the recorded reverted integration.");
}
function validateRelease(goal: PlanningGoal, evidence: RunningReleaseEvidence): void {
  // A later owner-approved rollback does not erase the fact that this release ran.
  requireThat((goal.integration?.status === "merged" || goal.integration?.status === "reverted") && goal.integration.prUrl === evidence.prUrl && goal.integration.mergedSha === evidence.mergedSha, "Release evidence must reference the merged integration PR.");
  requireThat(evidence.buildSha === evidence.runningSha, "Release is complete only when the verified build is running.");
  if (evidence.ancestry) requireThat(evidence.ancestry.verified === true && evidence.ancestry.ancestorSha === evidence.mergedSha && evidence.ancestry.descendantSha === evidence.buildSha, "Release ancestry must verify the merged commit in this build.");
  requireThat(evidence.buildSha === evidence.mergedSha || evidence.ancestry, "A descendant release build requires verified ancestry from the merged commit.");
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
    if (entry.stage === "implement" && entry.evidence.kind === "legacy-approval") {
      requireThat(entry.enteredAt === null && ceremony.migratedAt, "Legacy approval evidence is recorded only by migration.");
      validateLegacyApproval(goal, entry.evidence);
    } else if (entry.stage === "implement" && entry.evidence.kind === "approval") {
      validateApproval(goal, entry.evidence);
      notBefore(entry.evidence.approval.at, prior);
      if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.approval.at);
      else if (ceremony.migratedAt) { notBefore(ceremony.migratedAt, entry.evidence.approval.at); previous = entry.evidence.approval.at; }
    }
    if (entry.stage === "release" && entry.evidence.kind === "legacy-implementation") {
      requireThat(entry.enteredAt === null && ceremony.migratedAt, "Legacy implementation evidence is recorded only by migration.");
      validateLegacyImplementation(goal, entry.evidence);
    } else if (entry.stage === "release" && entry.evidence.kind === "implementation") {
      validateImplementation(goal, entry.evidence);
      if (entry.evidence.partialApproval) {
        const implementation = ceremony.history.find((item) => item.stage === "implement");
        notBefore(entry.evidence.partialApproval.at, implementation?.enteredAt);
        if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.partialApproval.at);
      }
    }
    if (entry.stage === "retro") {
      validateRelease(goal, entry.evidence);
      notBefore(entry.evidence.approval.at, prior);
      if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.runningAt);
      else if (ceremony.migratedAt) { notBefore(ceremony.migratedAt, entry.evidence.runningAt); previous = entry.evidence.runningAt; }
    }
  }
  if (ceremony.migratedAt) notBefore(ceremony.migratedAt, goal.createdAt);
  const closure = ceremony.closure;
  if (closure?.evidence.kind === "retro-published") {
    requireThat(ceremony.stage === "retro", "A goal can close only after retro.");
    requireThat(closure.evidence.path === `docs/retros/${goal.id}.md`, "Published retro must reference this goal's document.");
    notBefore(closure.evidence.publishedAt, previous);
    const release = ceremony.history.find((entry) => entry.stage === "retro");
    if (release?.stage === "retro") notBefore(closure.evidence.publishedAt, release.evidence.runningAt);
    notBefore(closure.closedAt, closure.evidence.publishedAt);
  } else if (closure?.evidence.kind === "release-reverted") {
    requireThat(ceremony.stage === "release", "A reverted release closes from release, before any running release.");
    const integration = goal.integration;
    requireThat(integration?.status === "reverted" && integration.prUrl === closure.evidence.prUrl && integration.mergedSha === closure.evidence.mergedSha && integration.revertPrUrl === closure.evidence.revertPrUrl, "A reverted release closure must reference the recorded reverted integration.");
    notBefore(closure.closedAt, previous);
    notBefore(closure.closedAt, ceremony.migratedAt);
  } else if (closure?.evidence.kind === "legacy-migration") {
    requireThat(ceremony.stage === "release" && ceremony.migratedAt && closure.closedAt === ceremony.migratedAt, "Legacy closure is recorded only by migration, at release.");
    validateLegacyClosure(goal, closure.evidence);
  } else requireThat(!closure, "Unknown closure evidence.");
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
  if (transition.to === "implement") requireThat(assignmentsMatchOutcomes(goal), PROPOSED_SEATS);
  const entry ={ stage: transition.to, enteredAt: transition.at, ...("evidence" in transition ? { evidence: structuredClone(transition.evidence) } : {}) } as CeremonyEntry;
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

/**
 * Closes a goal still in release whose integration PR was reverted on main (through the human merge gate for the
 * revert PR) before a running release was verified. Nothing ran to retro on, so the goal closes as reverted.
 */
export function closeRevertedRelease(goal: PlanningGoal, at: string): CeremonyRecord {
  requireThat(goal.ceremony && !goal.ceremony.closure && goal.ceremony.stage === "release", "Only an open goal in release closes as a reverted release.");
  const integration = goal.integration;
  requireThat(integration?.status === "reverted" && integration.prUrl && integration.mergedSha && integration.revertPrUrl, "A reverted release requires the recorded reverted integration.");
  const evidence: RevertedReleaseEvidence = { kind: "release-reverted", prUrl: integration.prUrl, mergedSha: integration.mergedSha, revertPrUrl: integration.revertPrUrl };
  const next = { ...structuredClone(goal.ceremony), closure: { closedAt: at, evidence } };
  validateCeremony(goal, next);
  return next;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Store-level guard: legacy workflow changes need migration; durable history cannot be erased or rewritten. */
/**
 * `releasedWithCeremony` is the store's check of a legacy goal's merged integration commit (see `migrateLegacyCeremony`);
 * without it, a merged legacy sprint cannot be migrated.
 */
export function validateCeremonyMutation(before: PlanningGoal, after: PlanningGoal | undefined, releasedWithCeremony?: boolean): void {
  requireThat(after && after.teamId === before.teamId && after.createdAt === before.createdAt, "A ceremony goal cannot be removed or moved to another team.");
  if (!before.ceremony) {
    requireThat((["stage", "proposal", "assignments", "integration"] as const).every((key) => same(before[key], after[key])), "Legacy goals require evidence-based migration before workflow changes; migration must preserve the original workflow.");
    const next = after.ceremony;
    if (!next) return;
    requireThat(next.migratedAt, "Existing goals require explicit evidence-based migration.");
    const migration = migrateLegacyCeremony(before, next.migratedAt, releasedWithCeremony);
    requireThat(migration.status === "ready" && same(migration.ceremony, next), "Migration must preserve known history and leave unproven history unknown.");
    return;
  }
  const old = before.ceremony; const next = after.ceremony;
  requireThat(next, "A ceremony cannot be removed.");
  requireThat(next.migratedAt === old.migratedAt, "Migration provenance is immutable.");
  if (CEREMONY_STAGES.indexOf(old.stage) >= 2) requireThat(same(before.proposal, after.proposal), "An approved proposal is immutable.");
  if (CEREMONY_STAGES.indexOf(old.stage) >= 3) requireThat(same(before.assignments, after.assignments), "Implementation assignments are frozen once release starts.");
  requireThat(next.history.length >= old.history.length && next.history.length <= old.history.length + 1 && old.history.every((entry, i) => same(entry, next.history[i])), "Ceremony history is append-only, one stage at a time.");
  // Legacy evidence exists only in a whole-ceremony migration; a live transition must bring native proof.
  const appended = next.history[old.history.length];
  if (appended && "evidence" in appended) requireThat(appended.evidence.kind !== "legacy-approval" && appended.evidence.kind !== "legacy-implementation", "Only legacy migration records legacy evidence.");
  if (appended?.stage === "implement") requireThat(assignmentsMatchOutcomes(after), PROPOSED_SEATS);
  if (old.closure) requireThat(same(old, next), "A closed ceremony is immutable.");
  if (old.stage === "release" && next.stage === "retro") requireThat(after.integration?.status === "merged", "A running release requires a merged integration PR that has not been reverted.");
  if (next.closure && !old.closure) {
    const kind = next.closure.evidence.kind;
    if (kind === "retro-published") requireThat(old.stage === "retro" && next.stage === "retro", "Entering retro and closing it are separate steps.");
    else requireThat(kind === "release-reverted" && old.stage === "release" && next.stage === "release", "Only migration records a legacy closure.");
  }
}

export type LegacyMigration = { status: "ready"; ceremony: CeremonyRecord } | { status: "conflict"; reason: string };
/**
 * Derives a pre-ceremony goal's ceremony from what state recorded, and nothing else. Each stage it enters is proven by
 * the goal's own facts; every entry time after planning stays unknown, and no retro is implied:
 * - clarifying → planning; drafting or awaiting-review → proposal;
 * - approved with one assignment per outcome → implement, while the sprint is collecting or has no integration yet;
 * - every assignment merged or failed (one merged at least) with an integration PR → release;
 * - finished goals close at release, marked as a legacy migration: a merged integration with no revert PR open whose
 *   merge commit lacks the ceremony code (`releasedWithCeremony` false), a reverted integration, or no integration at
 *   all with every assignment merged. A merge commit that contains the ceremony leaves the goal open in release, and
 *   one that could not be inspected (`releasedWithCeremony` undefined) is a conflict.
 * Evidence that does not fit these shapes is reported as a conflict and the goal is left untouched.
 */
export function migrateLegacyCeremony(goal: PlanningGoal, at: string, releasedWithCeremony?: boolean): LegacyMigration {
  requireThat(!goal.ceremony, "Goal already has a ceremony.");
  const conflict = (reason: string): LegacyMigration => ({ status: "conflict", reason });
  const history: CeremonyEntry[] = [{ stage: "planning", enteredAt: goal.createdAt }];
  const done = (closure?: LegacyClosureEvidence): LegacyMigration => {
    const ceremony: CeremonyRecord = { version: 1, stage: history.at(-1)!.stage, history, migratedAt: at, ...(closure ? { closure: { closedAt: at, evidence: closure } } : {}) };
    try { validateCeremony(goal, ceremony); }
    catch (error) { if (error instanceof CeremonyError) return conflict(error.message); throw error; }
    return { status: "ready", ceremony };
  };
  if (goal.stage === "clarifying") return done();
  history.push({ stage: "proposal", enteredAt: null });
  if (goal.stage !== "approved") return done();
  if (!goal.proposal || !assignmentsMatchOutcomes(goal)) return conflict("it is approved, but its assignments do not match its proposed outcomes one to one.");
  history.push({ stage: "implement", enteredAt: null, evidence: { kind: "legacy-approval", proposalId: goal.proposal.id } });
  const assignments = goal.assignments!;
  const merged = assignments.filter((item) => item.status === "merged");
  if (merged.some((item) => !item.prUrl)) return conflict("an assignment is merged but has no recorded PR.");
  const failed = assignments.filter((item) => item.status === "failed");
  const release = (): void => { history.push({ stage: "release", enteredAt: null, evidence: { kind: "legacy-implementation",
    outcomes: merged.map((item) => ({ outcomeId: item.outcomeId, seatId: item.seatId, prUrl: item.prUrl! })),
    ...(failed.length ? { unmerged: failed.map((item) => ({ outcomeId: item.outcomeId, seatId: item.seatId })) } : {}) } }); };
  const integration = goal.integration;
  if (!integration) {
    if (merged.length < assignments.length) return done();
    release();
    return done({ kind: "legacy-migration", integration: "none" });
  }
  if (integration.status === "collecting") return done();
  const unsettled = assignments.filter((item) => item.status !== "merged" && item.status !== "failed");
  if (unsettled.length || !merged.length) return conflict(`its integration is ${integration.status}, but ${unsettled.length ? `outcome ${unsettled.map((item) => `${item.outcomeId} is ${item.status}`).join(", ")}` : "no outcome merged"}.`);
  release();
  const recorded = { prUrl: integration.prUrl, mergedSha: integration.mergedSha };
  if (integration.status === "reverted") return done({ kind: "legacy-migration", integration: "reverted", ...recorded, revertPrUrl: integration.revertPrUrl });
  if (integration.status === "merged" && !integration.revertPrUrl) {
    // A sprint whose merge commit already carries the ceremony was released by it: its running-build check and retro still follow.
    if (releasedWithCeremony === undefined) return conflict(`its integration ${integration.prUrl} merged as ${integration.mergedSha}, but that commit could not be inspected in the project checkout to tell whether it contains the ceremony (src/ceremony.ts).`);
    if (releasedWithCeremony) return done();
    return done({ kind: "legacy-migration", integration: "merged", ...recorded });
  }
  // An open integration PR, or a merged one with its revert PR open, still needs the owner: it enters release.
  return done();
}

export interface TeamGoalConflict { teamId: string; goalIds: string[] }
/** A goal without a ceremony is unclosed until migration records one; migration closes only goals whose evidence proves them finished. */
export function openGoalConflicts(goals: PlanningGoal[]): TeamGoalConflict[] {
  const byTeam = new Map<string, string[]>();
  for (const goal of goals) if (!goal.ceremony?.closure) byTeam.set(goal.teamId, [...(byTeam.get(goal.teamId) ?? []), goal.id]);
  return [...byTeam].filter(([, ids]) => ids.length > 1).map(([teamId, goalIds]) => ({ teamId, goalIds }));
}

export function assertTeamAvailable(goals: PlanningGoal[], teamId: string): void {
  const open = goals.filter((goal) => goal.teamId === teamId && !goal.ceremony?.closure);
  requireThat(!open.length, `Team ${teamId} has unclosed goals: ${open.map((goal) => goal.id).join(", ")}.`);
}
