import { closeRemodelGoal, REMODEL_CLOSURE_GOALS } from "./ceremony.js";
import type { PlanningGoal, PlanningStore } from "./planning.js";

export interface LegacyClosureResult { goalId: string; status: "closed" | "already-closed" | "conflict"; reason: string }
const named = (goal: PlanningGoal) => Object.hasOwn(REMODEL_CLOSURE_GOALS, goal.id);
const conflict = (goalId: string, reason: string): LegacyClosureResult => ({ goalId, status: "conflict", reason });

/** Close only the mission's six recorded ceremonies, in one ordinary validated state transaction. */
export async function closeLegacyGoals(store: PlanningStore, at = new Date().toISOString()): Promise<LegacyClosureResult[]> {
  let ids: string[];
  try { ids = ((await store.read()).planningGoals ?? []).filter(named).map((goal) => goal.id); }
  catch {
    // No trustworthy inventory exists. These results identify the allowlist, not invented state records.
    return Object.keys(REMODEL_CLOSURE_GOALS).map((id) => conflict(id, "Cannot inspect this named closure because state is unreadable or invalid."));
  }
  if (!ids.length) return [];
  let results: LegacyClosureResult[] = [];
  try {
    await store.update((state) => {
      // Re-read candidates under the state lock; a concurrent startup may already have closed them.
      results = (state.planningGoals ?? []).filter(named).map((goal): LegacyClosureResult => {
        if (goal.workflowModel !== undefined) return conflict(goal.id, "This named goal uses the new workflow; no historical closure was applied.");
        if (goal.ceremony?.closure) return { goalId: goal.id, status: "already-closed", reason: "Its recorded ceremony is already closed." };
        if (!goal.ceremony) return conflict(goal.id, "No existing ceremony proves this goal's stage and history.");
        const stage = REMODEL_CLOSURE_GOALS[goal.id as keyof typeof REMODEL_CLOSURE_GOALS];
        if (goal.ceremony.stage !== stage) return conflict(goal.id, `Expected an existing ${stage} ceremony; the recorded stage is ${goal.ceremony.stage}.`);
        try { goal.ceremony = closeRemodelGoal(goal, at); }
        catch { return conflict(goal.id, "The existing ceremony or closure timestamp conflicts with its historical evidence."); }
        return { goalId: goal.id, status: "closed", reason: stage === "implement" ? "Closed as abandoned with its recorded workflow facts retained." : "Closed as superseded with its recorded workflow facts retained." };
      });
    }, "Close mission-listed historical goals for the remodel");
    return results;
  } catch {
    // Do not claim success if validation, dirty-state protection, or commit/recovery failed.
    // Diagnostics may contain provider output or paths; report only our own safe explanation.
    return (results.length ? results.map((result) => result.goalId) : ids).map((id) => conflict(id, "The closure transaction could not be confirmed; retained state requires inspection before retry."));
  }
}
