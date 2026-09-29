import { evaluateAutomaticGate } from "./auto-policy.js";
import type { AutomaticGateRequest, CeremonyContext, PlanningChat } from "./planning-bridge.js";
import { requireTeamHome } from "./planning.js";
import { proposalMessage } from "./planning-text.js";
import { personaPost, type SeatPersonas } from "./seat-persona.js";
import type { TeamRecord } from "./state-domain.js";

/**
 * Authorize only the gate the bridge is currently checking. The evaluator reads the owner's committed scope and
 * current revision on every call; the shared proposal/merge paths record the decision and recheck before acting.
 * Keep progression, delivery recovery, running-build verification and archival closure in those same paths.
 */
export async function automaticGate({ store, goal }: CeremonyContext, request: AutomaticGateRequest,
  chat: PlanningChat, profiles: SeatPersonas) {
  const approval = await evaluateAutomaticGate(store, goal.id, request);
  if (!approval || request.kind !== "proposal") return approval;
  // A recovered outbox acknowledgement is not proof that the current proposal is still in the thread.
  const state = await store.read();
  const current = state.planningGoals!.find((item) => item.id === goal.id)!;
  const team = (state.teams as TeamRecord[]).find((item) => item.id === current.teamId)!;
  const { channelId } = requireTeamHome(state, team.id);
  const own = await chat.ownUserId();
  const posts = await chat.since(channelId, Math.max(0, Date.parse(current.createdAt) - 5000));
  const post = posts.find((item) => item.id === request.postId);
  const message = personaPost(proposalMessage(current, new Map(team.seats.map((seat) => [seat.id, seat.displayName]))), profiles[current.seatId]);
  if (!own || !post || (post as { delete_at?: number }).delete_at || post.user_id !== own || post.channel_id !== channelId
    || current.mattermost.channelId !== channelId || post.root_id !== current.mattermost.rootPostId
    || post.props?.indra_delivery_id !== `proposal:${request.proposalId}` || post.message !== message) {
    throw new Error("Automatic proposal approval is waiting for verified delivery of the current proposal.");
  }
  // The GET may have raced an owner setting or proposal edit. Never reuse its earlier policy decision.
  return await evaluateAutomaticGate(store, goal.id, request);
}
