from pathlib import Path
root=Path('/Users/ryan/.codex/worktrees/indra-remodel-contract/indra')
def edit(file, old, new):
 p=root/file;s=p.read_text();assert old in s,(file,old[:100]);p.write_text(s.replace(old,new))
edit('src/state-domain.ts','/** The only permanent seat roles. A team has exactly one Team Lead; every other seat is a Developer. */\nexport const SEAT_ROLES = ["Team Lead", "Developer"] as const;', '/** New-model teams have one Team Lead, one Product and at least one Developer. */\nexport const SEAT_ROLES = ["Team Lead", "Product", "Developer"] as const;')
edit('src/state-domain.ts','export interface StateTeam {','export interface StateTeam {\n  /** Absent on historical two-role v1 records. */\n  workflowModel?: "goals-v1";')
edit('src/local-state.ts','["id", "slug", "displayName", "project", "externalIdentities", "seats"]','["id", "slug", "displayName", "project", "externalIdentities", "seats", "workflowModel"]')
edit('src/local-state.ts','  const project = data.project', '  if (data.workflowModel !== undefined && data.workflowModel !== "goals-v1") throw new StateDataError(`${path}.workflowModel is unsupported.`);\n  const project = data.project')
edit('src/local-state.ts','  return {\n    id: id(data.id, `${path}.id`),','  const products = seats.filter((seat) => seat.roles[0] === "Product").length;\n  if (data.workflowModel === "goals-v1") {\n    if (products !== 1 || !seats.some((seat) => seat.roles[0] === "Developer")) throw new StateDataError(`${path}.seats requires exactly one Product and at least one Developer for goals-v1.`);\n  } else if (products) throw new StateDataError(`${path}.workflowModel must be goals-v1 before a Product seat is enabled.`);\n  return {\n    ...(data.workflowModel === "goals-v1" ? { workflowModel: "goals-v1" as const } : {}),\n    id: id(data.id, `${path}.id`),')
edit('src/planning.ts','import { assertCeremonyReady, type CeremonyWriteReadiness } from "./ceremony-ports.js";', 'import { assertCeremonyReady, type CeremonyWriteReadiness } from "./ceremony-ports.js";\nimport { validateOwnedFiles, validateProductProposal, ownedFilesOverlap, type ProductProposal } from "./goal-contract.js";\nimport { advanceCeremony, type ApprovalEvidence } from "./ceremony.js";')
edit('src/planning.ts','export interface PlanningGoal {','export interface GoalAssignment { seatId: string; status: "assigned" | "running" | "reported" | "failed"; updatedAt: string }\nexport interface PlanningGoal {\n  /** Explicit readiness boundary; absence always means historical per-outcome workflow. */\n  workflowModel?: "goals-v1";\n  ownedFiles?: string[];\n  goalProposal?: ProductProposal;\n  /** Approved goals wait without an assignment until an idle Developer is chosen. */\n  goalAssignment?: GoalAssignment;')
edit('src/planning.ts','"assignments", "integration", "ceremony"]);','"assignments", "integration", "ceremony", "workflowModel", "ownedFiles", "goalProposal", "goalAssignment"]);')
edit('src/planning.ts','  if (!timestamp(goal.createdAt)', '''  if (goal.workflowModel !== undefined && goal.workflowModel !== "goals-v1") throw new Error("Unsupported goal workflow model.");
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
  if (!timestamp(goal.createdAt)''')
edit('src/planning.ts','!== Boolean(goal.proposal))','!== Boolean(goal.workflowModel === "goals-v1" ? goal.goalProposal : goal.proposal))')
edit('src/planning.ts','    const developers = new Set(developerSeats(state, goal.teamId).map((seat) => seat.id));','''    const developers = new Set(developerSeats(state, goal.teamId).map((seat) => seat.id));
    if (goal.workflowModel === "goals-v1") {
      if ((team as TeamRecord & { workflowModel?: string }).workflowModel !== "goals-v1") throw new Error("New-model goals require a ready goals-v1 team.");
      if (!(team.seats as SeatRecord[]).find((seat) => seat.id === goal.seatId && Array.isArray(seat.roles) && seat.roles.includes("Team Lead"))) throw new Error("The Team Lead owns goal scheduling.");
      if (goal.goalProposal && !(team.seats as SeatRecord[]).find((seat) => seat.id === goal.goalProposal!.productSeatId && Array.isArray(seat.roles) && seat.roles.includes("Product"))) throw new Error("Proposal provenance must name the team's Product seat.");
      if (goal.goalAssignment && !developers.has(goal.goalAssignment.seatId)) throw new Error("A whole goal must be assigned to a Developer on its team.");
    }''')
edit('src/planning.ts','if (closure) prs.push(...[closure.prUrl,','if (closure) prs.push(...["prUrl" in closure ? closure.prUrl : undefined,')
edit('src/planning.ts','\n}\n\ntype TeamHomeRecord =', '''
  const active = (state.planningGoals ?? []).filter((goal) => goal.workflowModel === "goals-v1" && goal.goalAssignment && !goal.ceremony?.closure);
  for (let i = 0; i < active.length; i++) for (const other of active.slice(i + 1)) {
    const goal = active[i];
    if (goal.teamId !== other.teamId) continue;
    if (ownedFilesOverlap(goal.ownedFiles!, other.ownedFiles!)) throw new Error(`Active goals ${goal.id} and ${other.id} overlap owned files.`);
    const holding = (item: PlanningGoal) => item.goalAssignment?.status === "assigned" || item.goalAssignment?.status === "running";
    if (holding(goal) && holding(other) && goal.goalAssignment!.seatId === other.goalAssignment!.seatId) throw new Error("A Developer may hold only one goal at a time.");
  }
}

type TeamHomeRecord =''')
edit('src/planning.ts','  /**\n   * Gives every goal without a ceremony', '''  /** One human proposal gate. Callers verify the reaction identity with GET before supplying evidence. */
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
      if ((state.planningGoals ?? []).some((other) => other.teamId === goal.teamId && other.workflowModel !== "goals-v1" && !other.ceremony?.closure)) throw new Error("Unclosed legacy goals block new dispatch until migration is complete.");
      goal.goalAssignment = { seatId, status: "assigned", updatedAt: at };
      goal.integration = structuredClone(integration);
      goal.updatedAt = at;
    }, `Assign whole goal ${id} to ${seatId}`);
  }
  /**
   * Gives every goal without a ceremony''')
edit('src/planning.ts','      if (active) validateCeremonyMutation(old, next, this.releaseFacts.get(old.id));','''      if (old.workflowModel !== next?.workflowModel) throw new Error("A goal workflow model is immutable; historical goals cannot be promoted implicitly.");
      if (old.workflowModel === "goals-v1" && old.stage === "approved") {
        if (!["ownedFiles", "goalProposal", "goal", "teamId", "seatId", "projectRefs"].every((key) => JSON.stringify(old[key as keyof PlanningGoal]) === JSON.stringify(next?.[key as keyof PlanningGoal]))) throw new Error("Approved goal scope and proposal are immutable.");
        if (old.goalAssignment && next?.goalAssignment?.seatId !== old.goalAssignment.seatId) throw new Error("A dispatched goal's Developer identity is immutable.");
      }
      if (active) validateCeremonyMutation(old, next, this.releaseFacts.get(old.id));''')
edit('src/planning.ts','      assertTeamAvailable([...oldGoals, ...added.filter((other) => other !== goal)], goal.teamId);','      if (goal.workflowModel !== "goals-v1") assertTeamAvailable([...oldGoals, ...added.filter((other) => other !== goal)], goal.teamId);')
