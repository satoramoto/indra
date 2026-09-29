/**
 * Whether a sprint is done and can leave the team's sprint list.
 * - With an integration record: finished once it is reverted, or merged with no revert PR open (`revert-open` still needs the owner).
 * - Without one: every approved sprint gets its integration at approval (since #27), so this is a legacy goal whose PRs merged
 *   straight into main and `I` never applies. It is finished only when every ticket merged; a failed ticket keeps it visible so
 *   its retry stays reachable.
 */
export function isFinishedSprint(loop: { integration?: { status: string; revertPrUrl?: string }; tickets: { status: string }[] } | undefined): boolean {
  if (!loop) return false;
  const integration = loop.integration;
  if (integration) return integration.status === "reverted" || (integration.status === "merged" && !integration.revertPrUrl);
  return loop.tickets.length > 0 && loop.tickets.every((ticket) => ticket.status === "merged");
}
