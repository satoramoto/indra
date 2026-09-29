import type { AgentRuntime } from "./codex-runtime.js";
import type { WorkflowEvent } from "./goal-contract.js";
import type { PlanningStore } from "./planning.js";

export interface ProductSeatIdentity { id: string; teamId: string; displayName: string; username: string; roles: ["Product"] }
export interface ProductSeatServices { store: PlanningStore; seat: ProductSeatIdentity; runtime: AgentRuntime }
export interface ProductTurnResult { status: "disabled" | "idle" | "proposed" | "refined"; proposalIds: string[] }

/** Readiness is explicit; never reassign George or invent identity/project/channel data. */
export async function loadProductSeat(store: PlanningStore, seatId: string): Promise<ProductSeatIdentity | undefined> {
  const teams = (await store.read()).teams as { id: string; workflowModel?: string; seats: { id: string; displayName: string; roles: string[]; externalIdentities: { mattermost: { username: string } } }[] }[];
  for (const team of teams) {
    const seat = team.seats.find((item) => item.id === seatId && item.roles[0] === "Product");
    if (!seat) continue;
    if (team.workflowModel !== "goals-v1") throw new Error("Product requires a ready goals-v1 team.");
    return { id: seat.id, teamId: team.id, displayName: seat.displayName, username: seat.externalIdentities.mattermost.username, roles: ["Product"] };
  }
  return undefined;
}
/** Contract stub: exactly one finite event turn, no model run, credential read, post, timer or write. */
export class ProductSeat {
  constructor(readonly services: ProductSeatServices) {}
  async turn(_event: WorkflowEvent): Promise<ProductTurnResult> { return { status: "disabled", proposalIds: [] }; }
}
