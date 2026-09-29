import type { ProductProposal, WorkflowEvent } from "./goal-contract.js";
import type { PlanningStore } from "./planning.js";

export const PRODUCT_QUEUE_CAP = 5;
export interface ProductProposalServices { store: PlanningStore; teamId: string; productSeatId: string }
export interface ProposalTurnResult { status: "disabled" | "idle" | "proposed" | "refined"; proposals: ProductProposal[] }
/** Contract stub for the Product lane. Does not approve, schedule, write state or post messages. */
export async function proposeGoals(_services: ProductProposalServices, _event: WorkflowEvent): Promise<ProposalTurnResult> {
  return { status: "disabled", proposals: [] };
}
