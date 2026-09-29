import { proposalDigest, validateAutomaticApproval, type AutomaticApproval } from "./ceremony.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanningDocument, PlanningGoal } from "./planning.js";
import type { AutomaticGateRequest } from "./planning-bridge.js";
import type { PlanningStore } from "./planning.js";
import type { StandingPolicyRevision, TeamRecord } from "./state-domain.js";
import { StateGit, withFileLock } from "./state-commit.js";

/** Scope is an owner choice, bound to the mission or problem the owner actually saw. */
export type PolicyScope =
  | { kind: "mission"; mission: string }
  | { kind: "problem"; goalId: string; problem: string };
export interface ScopedPolicyRevision extends StandingPolicyRevision { policyId: string; scope: PolicyScope }
/** A grant is effective only with the identically numbered and dated enabled revision in state.json. */
export interface PolicyGrant { revision: number; at: string; scope: PolicyScope }
export interface OwnerPolicy { id: string; teamId: string; scope: PolicyScope; grants: PolicyGrant[] }
export interface PolicyDocument { version: 1; policies: OwnerPolicy[] }
export const POLICY_FILE = "autonomy.json";
export type PolicyDecision = { allowed: true; policyId: string; approval: AutomaticApproval } | { allowed: false; reason: string };

const object = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]+$/.test(value);
const time = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function validPolicyScope(scope: unknown): scope is PolicyScope {
  return object(scope, ["kind", "mission"]) && scope.kind === "mission" && text(scope.mission)
    || object(scope, ["kind", "goalId", "problem"]) && scope.kind === "problem" && id(scope.goalId) && text(scope.problem);
}
/** Strict companion document; it contains owner decisions, never runtime data or agent-supplied settings. */
export function validatePolicyDocument(value: unknown): asserts value is PolicyDocument {
  const invalid = () => { throw new Error("Invalid owner autonomy policy document."); };
  if (!object(value, ["version", "policies"]) || value.version !== 1 || !Array.isArray(value.policies)) return invalid();
  const teams = new Set<string>(); const identities = new Set<string>();
  for (const policy of value.policies) {
    if (!object(policy, ["id", "teamId", "scope", "grants"]) || !id(policy.id) || !policy.id.startsWith("policy-") || !id(policy.teamId)
      || !validPolicyScope(policy.scope) || !Array.isArray(policy.grants) || teams.has(policy.teamId) || identities.has(policy.id)) return invalid();
    teams.add(policy.teamId); identities.add(policy.id);
    let previousTime = -Infinity; let previousRevision = 0;
    for (const grant of policy.grants) {
      if (!object(grant, ["revision", "at", "scope"]) || !Number.isSafeInteger(grant.revision) || (grant.revision as number) < 1
        || !time(grant.at) || !validPolicyScope(grant.scope) || Date.parse(grant.at) <= previousTime || (grant.revision as number) < previousRevision) return invalid();
      previousTime = Date.parse(grant.at); previousRevision = grant.revision as number;
    }
  }
}

/** Call under state.lock when pairing this document with state.json. Uncommitted policy edits cannot authorize work. */
export async function readPolicyDocument(checkout: string): Promise<PolicyDocument> {
  await new StateGit(checkout, POLICY_FILE).assertClean();
  const raw = await readFile(join(checkout, POLICY_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error("Could not read the owner autonomy policy document.");
  });
  if (raw === undefined) return { version: 1, policies: [] };
  let document: unknown;
  try { document = JSON.parse(raw); } catch { throw new Error("Invalid owner autonomy policy document."); }
  validatePolicyDocument(document);
  return document;
}

/** Historical lookup also works after disabling or changing scope; the state revision supplies the identity link. */
export function approvalPolicy(document: PolicyDocument, team: TeamRecord, revision: number): ScopedPolicyRevision | undefined {
  const setting = team.standingPolicy?.revisions.find((item) => item.revision === revision);
  const policy = document.policies.find((item) => item.teamId === team.id);
  const grant = policy?.grants.find((item) => item.revision === revision && item.at === setting?.at);
  if (!setting?.enabled || !policy || !grant) return;
  return { ...setting, policyId: policy.id, scope: structuredClone(grant.scope) };
}

export function policyScopeMatches(policy: ScopedPolicyRevision, team: TeamRecord, goal: PlanningGoal): boolean {
  if (goal.teamId !== team.id) return false;
  return policy.scope.kind === "mission" ? policy.scope.mission === team.mission
    : policy.scope.goalId === goal.id;
}

/** Re-read state at each gate. A previous decision or a caller's cached goal is never the current policy. */
export function currentAutoPolicy(state: PlanningDocument, document: PolicyDocument, goalId: string):
  { team: TeamRecord; goal: PlanningGoal; policy: ScopedPolicyRevision } | undefined {
  const goal = state.planningGoals?.find((item) => item.id === goalId);
  const team = (state.teams as TeamRecord[]).find((item) => item.id === goal?.teamId);
  const revision = team?.standingPolicy?.revisions.at(-1)?.revision;
  const policy = team && revision ? approvalPolicy(document, team, revision) : undefined;
  if (!goal || !team || !policy?.enabled || !goal.ceremony || goal.ceremony.closure || !policyScopeMatches(policy, team, goal)) return;
  return { team, goal, policy };
}

/** Called inside the state transaction and immediately before a checked external action. */
export function assertPolicyCurrent(state: PlanningDocument, document: PolicyDocument, goalId: string, approval: AutomaticApproval): void {
  const current = currentAutoPolicy(state, document, goalId);
  if (!current || approval.policyRevision !== current.policy.revision
    || Date.parse(approval.at) < Date.parse(current.policy.at)) throw new Error("Automatic authorization requires the owner's current enabled policy and matching scope.");
  validateAutomaticApproval(current.goal, approval);
}

/**
 * Evaluates verified gate input; this does not merge, start work, or write an authorization by itself.
 * The shared bridge records the returned approval with its transition and rechecks at execution.
 */
export function evaluateAutoPolicy(state: PlanningDocument, document: PolicyDocument, goalId: string, request: AutomaticGateRequest, at = new Date().toISOString()): PolicyDecision {
  const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
  const current = currentAutoPolicy(state, document, goalId);
  if (!current) return deny("Auto mode is off, unconfigured, outside scope, or the goal is closed.");
  const { team, goal, policy } = current;
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(policy.at)) return deny("The decision predates the current policy.");
  if (typeof request.postId !== "string" || !request.postId.trim() || request.postId === goal.mattermost.rootPostId) return deny("The matching approval post must be delivered first.");
  let target: AutomaticApproval["target"];
  if (request.kind === "proposal") {
    if (goal.stage !== "awaiting-review" || goal.ceremony!.stage !== "proposal" || !goal.proposal
      || request.proposalId !== goal.proposal.id || request.proposalDigest !== proposalDigest(goal.proposal)) return deny("The proposal changed or is not awaiting approval.");
    if (goal.proposal.openQuestions.length) return deny("The proposal still has unanswered questions.");
    target = { kind: "proposal", goalId, proposalId: goal.proposal.id, proposalDigest: request.proposalDigest };
  } else if (request.kind === "integration" || request.kind === "retro") {
    const pr = request.pr;
    // inspectReviewedPr has already verified the project's expected branch/base and exact reviewed head.
    if (pr.state !== "OPEN" || pr.reviewed !== true || pr.checksPassed !== true || pr.conflicting === true
      || !/^[0-9a-f]{40}$/.test(pr.headSha) || !pr.url.startsWith(`https://github.com/${team.project?.github}/pull/`)) return deny("A current main-targeting PR needs green CI and a fresh review.");
    const implementation = goal.ceremony!.history.find((entry) => entry.stage === "release");
    if (request.kind === "integration") {
      if (goal.ceremony!.stage !== "release" || goal.integration?.status !== "pr-open" || goal.integration.prUrl !== pr.url
        || implementation?.stage !== "release" || implementation.evidence.kind !== "implementation"
        || implementation.evidence.omissions?.length || implementation.evidence.partialApproval) return deny("Integration requires complete implementation; partial releases need human approval.");
    } else {
      const running = goal.ceremony!.history.find((entry) => entry.stage === "retro");
      if (goal.ceremony!.stage !== "retro" || goal.integration?.status !== "merged"
        || running?.stage !== "retro" || running.evidence.kind !== "release-running") return deny("Retro archival requires a verified running release.");
    }
    target = { kind: request.kind, goalId, prUrl: pr.url, headSha: pr.headSha, checksPassed: true, reviewApproved: true,
      reviewer: "satori-miyamoto", reviewedHeadSha: pr.headSha };
  } else return deny("Reverts and partial release decisions always require human approval.");
  const previous = goal.automaticApprovals?.find((item) => item.policyRevision === policy.revision && JSON.stringify(item.target) === JSON.stringify(target));
  const approval: AutomaticApproval = previous ?? { source: "automatic", policyRevision: policy.revision, at, target };
  try { assertPolicyCurrent(state, document, goalId, approval); }
  catch { return deny("The automatic approval no longer matches this goal or policy."); }
  return { allowed: true, policyId: policy.policyId, approval: structuredClone(approval) };
}

/** Adapter entry point. No cached settings; recording and execution remain in the shared bridge gates. */
export async function evaluateAutomaticGate(store: Pick<PlanningStore, "checkout" | "runtimeDir" | "read">, goalId: string, request: AutomaticGateRequest): Promise<AutomaticApproval | undefined> {
  return await withFileLock(join(store.runtimeDir, "state.lock"), async () => {
    const state = await store.read();
    const document = await readPolicyDocument(store.checkout);
    const decision = evaluateAutoPolicy(state, document, goalId, request);
    return decision.allowed ? decision.approval : undefined;
  });
}
