import type { AgentRuntime } from "./codex-runtime.js";
import type { WorkflowEvent } from "./goal-contract.js";
import type { PlanningStore } from "./planning.js";
import type { RuntimeFactory } from "./developer-seat.js";
import type { Shell } from "./command-shell.js";
import { ProductTurnError, proposeGoals, type ProductChat } from "./product-proposals.js";

export interface ProductSeatIdentity { id: string; teamId: string; displayName: string; username: string; roles: ["Product"] }
export interface ProductSeatServices { store: PlanningStore; seat: ProductSeatIdentity; runtime: AgentRuntime; runtimeFor?: RuntimeFactory; chat?: ProductChat; shell?: Shell }
export interface ProductTurnResult { status: "disabled" | "blocked" | "idle" | "proposed" | "refined"; proposalIds: string[] }

/** Readiness is explicit; never reassign George or invent identity/project/channel data. */
export async function loadProductSeat(store: PlanningStore, seatId: string): Promise<ProductSeatIdentity | undefined> {
  const teams = (await store.read()).teams as { id: string; workflowModel?: string; seats: { id: string; displayName: string; roles: string[]; externalIdentities: { mattermost: { username: string } } }[] }[];
  for (const team of teams) {
    const seat = team.seats.find((item) => item.id === seatId && item.roles.length === 1 && item.roles[0] === "Product");
    if (!seat) continue;
    if (team.workflowModel !== "goals-v1") throw new Error("Product requires a ready goals-v1 team.");
    return { id: seat.id, teamId: team.id, displayName: seat.displayName, username: seat.externalIdentities.mattermost.username, roles: ["Product"] };
  }
  return undefined;
}
/** One finite Product turn; the host supplies the project runtime and its authenticated own-bot chat. */
export class ProductSeat {
  constructor(readonly services: ProductSeatServices) {}
  async turn(event: WorkflowEvent): Promise<ProductTurnResult> {
    const current = await loadProductSeat(this.services.store, this.services.seat.id);
    if (!current || current.teamId !== this.services.seat.teamId) return { status: "disabled", proposalIds: [] };
    try {
      const result = await proposeGoals({ ...this.services, teamId: current.teamId, productSeatId: current.id }, event);
      return { status: result.status, proposalIds: result.proposals.map((proposal) => proposal.proposalId) };
    } catch (error) {
      // Only a durably saved blocker may be receipted. Persistence/identity failures still stop the host.
      if (error instanceof ProductTurnError && error.recorded) return { status: "blocked", proposalIds: [] };
      throw error;
    }
  }
}
