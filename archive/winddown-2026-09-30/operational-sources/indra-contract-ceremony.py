from pathlib import Path
p=Path('/Users/ryan/.codex/worktrees/indra-remodel-contract/indra/src/ceremony.ts');s=p.read_text()
def e(old,new):
 global s
 assert old in s,old[:120];s=s.replace(old,new)
e('import type { PlanningGoal } from "./planning.js";','import type { PlanningGoal } from "./planning.js";\nimport { validateGoalReport, type GoalReport } from "./goal-contract.js";')
e('  kind: "implementation";','  kind: "implementation";\n  /** New-model delivery is one immutable whole-goal report; lane/session orchestration stays in runtime. */\n  goalDelivery?: GoalReport;')
e('export interface RunningReleaseEvidence {\n  kind: "release-running"; prUrl: string; mergedSha: string; mergePostId: string; approval: HumanApproval;', '''export interface MergeVerification { headSha: string; reviewCommitSha: string; reviewer: "satori-miyamoto"; checksPassed: true }
export interface RunningReleaseEvidence {
  kind: "release-running"; prUrl: string; mergedSha: string;
  /** Historical second-gate evidence remains readable, but is never synthesized for new releases. */
  mergePostId?: string; approval?: HumanApproval;
  mergeVerification?: MergeVerification;''')
e('export type ClosureEvidence = PublishedRetroEvidence | RevertedReleaseEvidence | LegacyClosureEvidence;', '''/** A one-time closure list from docs/mission.md, never a general-purpose bypass. */
export const REMODEL_CLOSURE_GOALS = {
  "goal-2b118e79": "implement", "goal-855701cc": "release", "goal-ca9dd9ed": "release", "goal-df104a26": "release", "goal-88dd199e": "retro", "goal-96296dff": "retro",
} as const;
export interface RemodelClosureEvidence {
  kind: "remodel-closure"; goalId: keyof typeof REMODEL_CLOSURE_GOALS; stage: "implement" | "release" | "retro";
  reason: "abandoned" | "superseded";
  observed: {
    planningStage: PlanningGoal["stage"];
    integration: { branch: string; baseSha: string; status: string; prUrl: string | null; mergedSha: string | null; revertPrUrl: string | null } | null;
    assignments: { outcomeId: string; seatId: string; status: string; updatedAt: string; prUrl: string | null; note: string | null }[];
  };
}
export type ClosureEvidence = PublishedRetroEvidence | RevertedReleaseEvidence | LegacyClosureEvidence | RemodelClosureEvidence;''')
e('    approval, checksPassed: { const: true }, buildSha: sha, runningSha: sha, runningAt: time,','    approval, mergeVerification: object({ headSha: sha, reviewCommitSha: sha, reviewer: { const: "satori-miyamoto" }, checksPassed: { const: true } }), checksPassed: { const: true }, buildSha: sha, runningSha: sha, runningAt: time,')
e('  ceremonyRelease: object({','  ceremonyRelease: { ...object({')
e('  }, ["kind", "prUrl", "mergedSha", "mergePostId", "approval", "checksPassed", "buildSha", "runningSha", "runningAt"]),','  }, ["kind", "prUrl", "mergedSha", "checksPassed", "buildSha", "runningSha", "runningAt"]), anyOf: [{ required: ["mergeVerification"] }, { required: ["mergePostId", "approval"] }] },')
e('  ceremonyEntry: { oneOf: [','''  ceremonyRemodelClosure: object({ kind: { const: "remodel-closure" }, goalId: { enum: Object.keys(REMODEL_CLOSURE_GOALS) }, stage: { enum: ["implement", "release", "retro"] }, reason: { enum: ["abandoned", "superseded"] },
    observed: object({ planningStage: { enum: ["clarifying", "drafting", "awaiting-review", "approved"] },
      integration: { anyOf: [{ type: "null" }, object({ branch: text, baseSha: sha, status: { enum: ["collecting", "pr-open", "merged", "reverted"] }, prUrl: { anyOf: [ref("ceremonyPr"), { type: "null" }] }, mergedSha: { anyOf: [sha, { type: "null" }] }, revertPrUrl: { anyOf: [ref("ceremonyPr"), { type: "null" }] } })] },
      assignments: { type: "array", items: object({ outcomeId: id, seatId: id, status: { enum: ["queued", "running", "in-review", "merged", "failed"] }, updatedAt: time, prUrl: { anyOf: [ref("ceremonyPr"), { type: "null" }] }, note: { anyOf: [text, { type: "null" }] } }) },
    }),
  }),
  ceremonyEntry: { oneOf: [''')
e('ref("ceremonyLegacyClosure")]','ref("ceremonyLegacyClosure"), ref("ceremonyRemodelClosure")]')
e('    { if: closedBy(["legacy-migration"]), then:', '    { if: closedBy(["remodel-closure"]), then: { properties: { stage: { enum: ["implement", "release", "retro"] } } } },\n    { if: closedBy(["legacy-migration"]), then:')
# Goal report strict schema comes from the shared module schema file at schema generation time. In-memory validation delegates to validator.
e('const shape = ajv.compile(','''// State evidence stores only the frozen deliverable proof, never session IDs or mutable lane progress.
const implementationSchema = CEREMONY_SCHEMA_DEFS.ceremonyImplementation;
Object.assign(CEREMONY_SCHEMA_DEFS, { ceremonyImplementation: { anyOf: [implementationSchema,
  object({ kind: { const: "implementation" }, outcomes: { type: "array", maxItems: 0 }, goalDelivery: { type: "object" } }),
] } });
const shape = ajv.compile(''')
e('  requireThat(goal.proposal?.id === evidence.proposalId, "Approval evidence must reference this goal\'s proposal.");','''  if (goal.workflowModel === "goals-v1") {
    requireThat(goal.goalProposal?.proposalId === evidence.proposalId && goal.stage === "approved" && !!goal.ownedFiles?.length && same(goal.ownedFiles, goal.goalProposal.ownedFiles), "Approval requires this Product proposal and its nonempty owned files.");
    validateHuman(evidence.approval, "planning approve", evidence.proposalPostId, goal);
    notBefore(evidence.approval.at, goal.createdAt);
    return;
  }
  requireThat(goal.proposal?.id === evidence.proposalId, "Approval evidence must reference this goal's proposal.");''')
e('function validateImplementation(goal: PlanningGoal, evidence: ImplementationEvidence): void {','''function validateImplementation(goal: PlanningGoal, evidence: ImplementationEvidence): void {
  if (goal.workflowModel === "goals-v1") {
    const report = validateGoalReport(evidence.goalDelivery);
    requireThat(evidence.outcomes.length === 0 && !evidence.omissions && !evidence.partialApproval && report.goalId === goal.id && report.teamId === goal.teamId && report.seatId === goal.goalAssignment?.seatId && goal.goalAssignment.status === "reported" && report.sprintBranch === goal.integration?.branch, "Whole-goal implementation requires its assigned Developer's verified report.");
    requireThat(report.lanePrs.length > 0 && report.checks.length > 0 && report.checks.every((check) => check.exitCode === 0) && report.neededButUnowned.length === 0, "A completed goal report requires merged lane proof, passing checks and no unowned work.");
    return;
  }
  requireThat(!evidence.goalDelivery, "Historical outcomes cannot acquire a whole-goal report.");''')
e('  validateHuman(evidence.approval, "planning merge", evidence.mergePostId, goal);\n  notBefore(evidence.runningAt, evidence.approval.at);','''  if (evidence.mergeVerification) {
    requireThat(evidence.mergeVerification.headSha === evidence.mergeVerification.reviewCommitSha && evidence.mergeVerification.reviewer === "satori-miyamoto" && evidence.mergeVerification.checksPassed === true, "Release requires current-head bot approval and passing CI.");
  } else {
    requireThat(evidence.approval && evidence.mergePostId, "Historical release requires its recorded approval.");
    validateHuman(evidence.approval, "planning merge", evidence.mergePostId, goal);
    notBefore(evidence.runningAt, evidence.approval.at);
  }''')
e('      notBefore(entry.evidence.approval.at, prior);\n      if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.runningAt);','      if (entry.evidence.approval) notBefore(entry.evidence.approval.at, prior);\n      if (entry.enteredAt) notBefore(entry.enteredAt, entry.evidence.runningAt);')
e('  } else requireThat(!closure, "Unknown closure evidence.");','''  } else if (closure?.evidence.kind === "remodel-closure") {
    const evidence = closure.evidence;
    requireThat(goal.workflowModel === undefined && REMODEL_CLOSURE_GOALS[evidence.goalId] === ceremony.stage && evidence.goalId === goal.id && evidence.stage === ceremony.stage, "Remodel closure is restricted to the six mission-listed goals at their recorded stages.");
    requireThat(same(evidence, remodelClosureEvidence(goal)), "Remodel closure must preserve the observed workflow facts.");
    notBefore(closure.closedAt, previous);
  } else requireThat(!closure, "Unknown closure evidence.");''')
e('export function startCeremony(at: string): CeremonyRecord {','''/** Exact state observations; migration may close these records without fabricating a stage or approval. */
export function remodelClosureEvidence(goal: PlanningGoal): RemodelClosureEvidence {
  const stage = REMODEL_CLOSURE_GOALS[goal.id as keyof typeof REMODEL_CLOSURE_GOALS];
  requireThat(stage && goal.ceremony?.stage === stage && !goal.workflowModel, "Goal is not one of the six remodel closures at its expected stage.");
  const integration = goal.integration;
  return { kind: "remodel-closure", goalId: goal.id as keyof typeof REMODEL_CLOSURE_GOALS, stage,
    reason: goal.id === "goal-2b118e79" ? "abandoned" : "superseded", observed: {
      planningStage: goal.stage,
      integration: integration ? { branch: integration.branch, baseSha: integration.baseSha, status: integration.status, prUrl: integration.prUrl ?? null, mergedSha: integration.mergedSha ?? null, revertPrUrl: integration.revertPrUrl ?? null } : null,
      assignments: (goal.assignments ?? []).map((item) => ({ outcomeId: item.outcomeId, seatId: item.seatId, status: item.status, updatedAt: item.updatedAt, prUrl: item.prUrl ?? null, note: item.note ?? null })),
    } };
}
export function closeRemodelGoal(goal: PlanningGoal, at: string): CeremonyRecord {
  requireThat(goal.ceremony && !goal.ceremony.closure, "Remodel closure requires an existing open ceremony.");
  const next = { ...structuredClone(goal.ceremony), closure: { closedAt: at, evidence: remodelClosureEvidence(goal) } };
  validateCeremony(goal, next);
  return next;
}

export function startCeremony(at: string): CeremonyRecord {''')
e('  if (CEREMONY_STAGES.indexOf(old.stage) >= 3) requireThat(same(before.assignments, after.assignments),','  if (CEREMONY_STAGES.indexOf(old.stage) >= 3) requireThat(same(before.assignments, after.assignments) && same(before.goalAssignment, after.goalAssignment),')
e('    else requireThat(kind === "release-reverted"', '''    else if (kind === "remodel-closure") {
      const original = { ...before, ceremony: undefined, updatedAt: undefined };
      const closed = { ...after, ceremony: undefined, updatedAt: undefined };
      requireThat(old.stage === next.stage && same(old.history, next.history) && same(original, closed), "Remodel closure cannot rewrite history or observed workflow facts.");
      requireThat(same(next.closure.evidence, remodelClosureEvidence(before)), "Remodel closure must preserve observed facts for an explicitly listed goal.");
    } else requireThat(kind === "release-reverted"''')
e('  for (const goal of goals) if (!goal.ceremony?.closure)', '  for (const goal of goals) if (!goal.ceremony?.closure && goal.workflowModel !== "goals-v1")')
p.write_text(s)
