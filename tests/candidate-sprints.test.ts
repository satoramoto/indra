import { describe, expect, it } from "vitest";
import { rankCandidateSprints, upcomingCandidateSprints, validateCandidateMembership } from "../src/candidate-sprints.js";

describe("candidate sprints", () => {
  it("orders candidates by rank with stable identities breaking ties, without changing stored order", () => {
    const candidates = [
      { id: "candidate-later", rank: 3, ticketIds: ["ticket-later"] },
      { id: "candidate-b", rank: 1, ticketIds: ["ticket-b"] },
      { id: "candidate-a", rank: 1, ticketIds: ["ticket-a"] },
    ];
    expect(rankCandidateSprints(candidates).map((candidate) => candidate.id)).toEqual(["candidate-a", "candidate-b", "candidate-later"]);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["candidate-later", "candidate-b", "candidate-a"]);
    expect(rankCandidateSprints(candidates).flatMap((candidate) => candidate.ticketIds)).toEqual(["ticket-a", "ticket-b", "ticket-later"]);
  });

  it("selects upcoming work by rank while preserving proposed, completed and discarded history", () => {
    const candidates = [
      { id: "candidate-proposed", rank: 1, status: "proposed" },
      { id: "candidate-completed", rank: 1, status: "completed" },
      { id: "candidate-discarded", rank: 1, status: "discarded" },
      { id: "candidate-later", rank: 4, status: "candidate" },
      { id: "candidate-next", rank: 2, status: "candidate" },
    ];
    expect(upcomingCandidateSprints(candidates).map((candidate) => candidate.id)).toEqual(["candidate-next", "candidate-later"]);
    expect(candidates).toHaveLength(5);
    expect(upcomingCandidateSprints(candidates.slice(0, 3))).toEqual([]);
  });

  it("rejects missing ticket references and repeated membership or candidate identities", () => {
    const tickets = [{ id: "ticket-one" }, { id: "ticket-two" }];
    const candidate = { id: "candidate-one", ticketIds: ["ticket-one", "ticket-two"] };
    expect(() => validateCandidateMembership(tickets, [candidate])).not.toThrow();
    expect(() => validateCandidateMembership(tickets, [{ ...candidate, ticketIds: ["ticket-absent"] }])).toThrow("unknown ticket");
    expect(() => validateCandidateMembership(tickets, [{ ...candidate, ticketIds: ["ticket-one", "ticket-one"] }])).toThrow("duplicate ticket");
    expect(() => validateCandidateMembership(tickets, [{ ...candidate, ticketIds: [] }])).toThrow("must contain tickets");
    expect(() => validateCandidateMembership(tickets, [candidate, candidate])).toThrow("Duplicate candidate");
  });
});
