/**
 * Whether a sprint is done and can leave the team's sprint list. It is the same rule that decides whether a goal
 * still holds its team's lock (`TerminalUiModel.openGoals`), so the owner is never blocked by a goal they can't see.
 * - With a persisted ceremony: finished only once the ceremony is closed (retro published, release reverted before it
 *   ran, or a finished legacy goal closed by migration). A merged integration still in release or retro stays visible.
 * - Without a ceremony: a legacy goal that start-up migration has not closed (its evidence conflicts, or it has not
 *   run yet). It stays visible and open, whatever its integration says, until migration records its ceremony.
 */
export function isFinishedSprint(loop: {
  ceremony?: { closure?: unknown };
  closedAt?: string;
  integration?: { status: string; revertPrUrl?: string };
  tickets: { status: string }[];
} | undefined): boolean {
  if (!loop) return false;
  if (loop.ceremony) return Boolean(loop.ceremony.closure);
  return Boolean(loop.closedAt);
}
