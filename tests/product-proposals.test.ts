import { expect, it } from "vitest";
import { PRODUCT_QUEUE_CAP, proposeGoals } from "../src/product-proposals.js";
import { assertProductQueueCapacity, type ProductRuntimeRecord } from "../src/goal-contract.js";
import type { PlanningStore } from "../src/planning.js";
it("keeps Product's queue boundary while its no-op stub performs no I/O", async () => {
  expect(PRODUCT_QUEUE_CAP).toBe(5);
  expect(await proposeGoals({ store: {} as PlanningStore, teamId: "team-one", productSeatId: "seat-002" }, { kind: "startup", teamId: "team-one", at: "2026-09-01T00:00:00Z" })).toEqual({ status: "disabled", proposals: [] });
});

it("caps all unpublished and published unapproved proposals together without double counting", () => {
  const record: ProductRuntimeRecord = { version: 1, teamId: "team-one", seatId: "seat-002", events: [], handledEventIds: [], pending: null, failure: null, updatedAt: "2026-09-01T00:00:00Z", queue: Array.from({ length: 5 }, (_, index) => ({
    proposal: { version: 1, goalId: `goal-${index}`, proposalId: `proposal-${index}`, productSeatId: "seat-002", rank: index + 1, mission: "docs/mission.md", summary: "Goal", outcomes: [{ number: 1, title: "Outcome", description: "Deliver", reason: "Mission", currentCode: [] }], ownedFiles: ["src/**"], risks: [], rationale: "Useful", basedOnRetros: [] },
    status: "proposed", rootPostId: null, proposalPostId: null, vetting: null,
  })) };
  expect(() => assertProductQueueCapacity(record, [{ goalId: "goal-0", proposalId: "proposal-0" }])).not.toThrow();
  expect(() => assertProductQueueCapacity(record, [{ goalId: "goal-extra", proposalId: "proposal-extra" }])).toThrow("five");
  expect(() => assertProductQueueCapacity(record, [{ goalId: "goal-0", proposalId: "proposal-0" }, { goalId: "goal-1", proposalId: "proposal-1" }])).toThrow("one published");
});
