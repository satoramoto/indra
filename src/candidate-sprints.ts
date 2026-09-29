/** Lower ranks come first; identities break ties without depending on storage order. */
export function rankCandidateSprints<T extends { id: string; rank: number }>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => left.rank - right.rank || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Proposed and past sprints stay in history but cannot become the next upcoming candidate. */
export function upcomingCandidateSprints<T extends { id: string; rank: number; status: string }>(candidates: readonly T[]): T[] {
  return rankCandidateSprints(candidates.filter((candidate) => candidate.status === "candidate"));
}

/** Membership uses durable ticket IDs, never titles or array positions. */
export function validateCandidateMembership(
  tickets: readonly { id: string }[],
  candidates: readonly { id: string; ticketIds: readonly string[] }[],
): void {
  const ticketIds = new Set(tickets.map((ticket) => ticket.id));
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) throw new Error("Duplicate candidate sprint identity.");
    candidateIds.add(candidate.id);
    if (!candidate.ticketIds.length) throw new Error("A candidate sprint must contain tickets.");
    const members = new Set<string>();
    for (const id of candidate.ticketIds) {
      if (!ticketIds.has(id)) throw new Error("A candidate sprint references an unknown ticket.");
      if (members.has(id)) throw new Error("A candidate sprint contains a duplicate ticket.");
      members.add(id);
    }
  }
}
