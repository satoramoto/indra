import { describe, expect, it, vi } from "vitest";
import { loadProductSeat, ProductSeat } from "../src/product-seat.js";
import type { PlanningStore } from "../src/planning.js";

describe("Product contract stub", () => {
  it("loads only an explicit Product identity and executes no background work", async () => {
    const state = { teams: [{ id: "team-one", workflowModel: "goals-v1", seats: [{ id: "seat-002", displayName: "George Duke", roles: ["Product"], externalIdentities: { mattermost: { username: "georgeduke" } } }] }] };
    const store = { read: vi.fn(async () => state) } as unknown as PlanningStore;
    const seat = await loadProductSeat(store, "seat-002");
    expect(seat).toMatchObject({ id: "seat-002", displayName: "George Duke", username: "georgeduke", roles: ["Product"] });
    const runtime = { message: vi.fn() };
    expect(await new ProductSeat({ store, seat: seat!, runtime }).turn({ kind: "startup", teamId: "team-one", at: "2026-09-01T00:00:00Z" })).toEqual({ status: "disabled", proposalIds: [] });
    expect(runtime.message).not.toHaveBeenCalled();
    state.teams[0].seats[0].roles = ["Developer"];
    expect(await loadProductSeat(store, "seat-002")).toBeUndefined();
  });
});
