/** A sprint is finished once its integration merged or was reverted, or, for a legacy goal without an integration branch, once every ticket merged or failed. */
export function isFinishedSprint(loop: { integration?: { status: string }; tickets: { status: string }[] } | undefined): boolean {
  if (!loop) return false;
  if (loop.integration) return loop.integration.status === "merged" || loop.integration.status === "reverted";
  return loop.tickets.length > 0 && loop.tickets.every((ticket) => ticket.status === "merged" || ticket.status === "failed");
}
