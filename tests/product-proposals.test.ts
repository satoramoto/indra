import { expect, it } from "vitest";
import { PRODUCT_QUEUE_CAP, productProposalDigest, productProposalMessage } from "../src/product-proposals.js";
import { assertProductQueueCapacity, type ProductRuntimeRecord, type ProductProposal } from "../src/goal-contract.js";
it("keeps strict canonical proposal digests and complete human approval text", () => {
  expect(PRODUCT_QUEUE_CAP).toBe(5);
  const proposal: ProductProposal = { version: 1, goalId: "goal-example", proposalId: "proposal-example", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "Improve recovery", outcomes: [{ number: 1, title: "Preserve delivery", description: "Recover the same post after a lost acknowledgment", reason: "The mission requires autonomous recovery", currentCode: ["src/product-seat.ts"] }], ownedFiles: ["src/product-*.ts", "tests/product-*.test.ts"], risks: ["Uncertain delivery must remain blocked"], rationale: "Prevent duplicate proposals", basedOnRetros: ["goal-earlier"] };
  const digest = productProposalDigest(proposal);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(productProposalDigest(Object.fromEntries(Object.entries(proposal).reverse()))).toBe(digest);
  expect(productProposalDigest({ ...proposal, ownedFiles: ["src/**"] })).not.toBe(digest);
  expect(() => productProposalDigest({ ...proposal, autoApprove: true })).toThrow();
  const message = productProposalMessage(proposal);
  for (const value of [proposal.summary, proposal.rationale, ...proposal.ownedFiles, ...proposal.risks, proposal.outcomes[0].reason, proposal.outcomes[0].currentCode[0], proposal.proposalId, proposal.goalId]) expect(message).toContain(value);
  expect(message).toContain("React ✅");
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
