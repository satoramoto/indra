import type { PlanningStore } from "./planning.js";

export interface LegacyClosureResult { goalId: string; status: "closed" | "already-closed" | "conflict"; reason: string }
/** Contract stub. The Migration lane implements the six explicit closures; never runs on live data during the remodel. */
export async function closeLegacyGoals(_store: PlanningStore, _at = new Date().toISOString()): Promise<LegacyClosureResult[]> {
  return [];
}
