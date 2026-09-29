import type { ImplementationEvidence, PublishedRetroEvidence } from "./ceremony.js";
import type { PlanningGoal } from "./planning.js";
import type { BacklogTicket, SprintCandidate } from "./state-domain.js";
import { sprintBranch } from "./sprint.js";

/** 📝 on Chick's goal post requests a draft proposal. */
export const PROPOSE_EMOJI = "memo";
/** ✅ on Chick's proposal post approves it. */
export const APPROVE_EMOJI = "white_check_mark";

export type Seat = { id: string; displayName: string };

/** These messages describe the gate, never infer an authorization from the current setting. */
export function approvalGateText(kind: "proposal" | "integration" | "retro"): string {
  const human = kind === "proposal"
    ? `To approve it, a person reacts :${APPROVE_EMOJI}: on this post. The owner may also use planning approve. With auto mode off, one of these human approvals is required.`
    : `With auto mode off, a person reacts :${APPROVE_EMOJI}: on this post or the owner presses M in Chick's detail.`;
  const checks = kind === "proposal" ? "the proposal checks pass"
    : `a fresh review of the current head and green CI are verified${kind === "retro" ? ", together with the running release and the frozen retrospective archive" : ""}`;
  return `${human} With auto mode on, Indra may ${kind === "proposal" ? "approve" : "merge"} under the owner's current standing policy only after ${checks}; it records the approval as automatic. Turning auto mode off stops at the next approval gate.`;
}

export interface NextSprintRetro {
  goalId: string; evidence: PublishedRetroEvidence; ownerProposals: { text: string; evidenceId: string }[];
}
export interface NextSprintTextInput {
  closedGoalId: string; mission: string; candidate: SprintCandidate; tickets: BacklogTicket[]; github: string; retro?: NextSprintRetro;
}
/** A frozen planning basis, retained verbatim in the proposal even if the model omits its citations. */
export function nextSprintText({ closedGoalId, mission, candidate, tickets, github, retro }: NextSprintTextInput): string {
  const retrospective = retro
    ? `Latest available frozen retrospective: [${retro.goalId}](https://github.com/${github}/blob/${retro.evidence.mergedSha}/${retro.evidence.path}), archived by ${retro.evidence.prUrl}; verified thread post ${retro.evidence.postId}.\n${retro.ownerProposals.length ? `Recorded owner proposals (suggestions for this plan, not approvals):\n${retro.ownerProposals.map((item) => `- ${item.text} [${item.evidenceId}]`).join("\n")}` : "No owner proposals were extracted; consult the frozen archive for its recorded facts."}`
    : "No verified frozen retrospective is available. Retrospective evidence and recommendations are unknown; do not invent them.";
  return `Next sprint after verified closure of ${closedGoalId}.\nMission: ${mission}\nCandidate ${candidate.id}: ${candidate.title}\n${candidate.summary}\nValue this sprint would deliver: ${candidate.value}\n\nBacklog tickets (indra-state IDs):\n${tickets.map((ticket) => `- **${ticket.id}: ${ticket.title}**\n  ${ticket.description}\n  Value: ${ticket.value}\n  Dependencies: ${ticket.dependsOn?.join(", ") || "none"}${ticket.research?.length ? `\n  Research: ${ticket.research.map((item) => `${item.url} — ${item.finding}`).join("; ")}` : ""}`).join("\n")}\n\n${retrospective}`;
}

function seatLabel(seats: Map<string, string>, seatId: string): string {
  return seats.has(seatId) ? `${seats.get(seatId)} (${seatId})` : seatId;
}
export function rootMessage(id: string, goalText: string): string {
  return `**Planning goal ${id} — Chick**\n**Stage: planning**\n${goalText}\n\nReply here to clarify. React :${PROPOSE_EMOJI}: on this post to request a draft proposal for review.`;
}
export function proposalMessage(goal: PlanningGoal, seats: Map<string, string>): string {
  const draft = goal.proposal!;
  return `**Draft proposal ${draft.id} — awaiting review**\n${draft.summary}\n${draft.outcomes.map((item) => `- **${item.title}** → ${seatLabel(seats, item.seatId)}: ${item.description}`).join("\n")}${goal.source ? `\n\n**Backlog and retrospective basis**\n${goal.goal}` : ""}\n\nRecorded in indra-state as ${goal.id}. No work has been approved or executed. ${approvalGateText("proposal")}`;
}
export function approvalMessage(goal: PlanningGoal, seats: Map<string, string>): string {
  const titles = new Map(goal.proposal!.outcomes.map((item) => [item.id, item.title]));
  const implementation = goal.ceremony?.history.find((entry) => entry.stage === "implement");
  const approval = implementation?.stage === "implement" && (implementation.evidence.kind === "approval" || implementation.evidence.kind === "automatic-approval") ? implementation.evidence.approval : undefined;
  const provenance = approval?.source === "automatic" ? `\nApproved automatically under the owner's standing policy revision ${approval.policyRevision}.`
    : approval?.source === "reaction" ? "\nApproved by a verified human reaction." : approval?.source === "owner-command" ? "\nApproved by the owner's planning approve command." : "";
  return `**Proposal ${goal.proposal!.id} approved**${provenance}\n${(goal.assignments ?? []).map((item) => `- ${titles.get(item.outcomeId) ?? item.outcomeId} → ${seatLabel(seats, item.seatId)}`).join("\n")}\n\nRecorded in indra-state as ${goal.id}. Each outcome is queued for its Developer seat.${goal.integration ? ` Their PRs target \`${goal.integration.branch}\`; once every outcome merges, Chick opens one PR from it into main.` : ""}`;
}
export function outcomeLines(goal: PlanningGoal, seats: Map<string, string>, omissions: ImplementationEvidence["omissions"]): { merged: string[]; missed: string[] } {
  const titles = new Map(goal.proposal!.outcomes.map((item) => [item.id, item.title]));
  const merged: string[] = []; const missed: string[] = [];
  for (const item of goal.assignments ?? []) {
    const head = `**${titles.get(item.outcomeId) ?? item.outcomeId}** → ${seatLabel(seats, item.seatId)}`;
    const omitted = omissions?.find((entry) => entry.outcomeId === item.outcomeId);
    if (omitted) { missed.push(`- ${head}: omitted by owner (${omitted.reason})`); continue; }
    if (item.status === "merged") merged.push(`- ${head}: ${item.prUrl ?? "merged"}`);
    else missed.push(`- ${head}: ${item.status === "failed" ? `failed${item.note ? ` (${item.note})` : ""}` : `skipped (${item.status})`}${item.prUrl ? ` ${item.prUrl}` : ""}`);
  }
  return { merged, missed };
}
/** The integration PR's body: the goal, each outcome with its seat and PR, and what failed or was skipped. */
export function sprintSummary(goal: PlanningGoal, seats: Map<string, string>, omissions: ImplementationEvidence["omissions"]): string {
  const { merged, missed } = outcomeLines(goal, seats, omissions);
  return `Sprint integration for planning goal ${goal.id}.\n\n**Goal:** ${goal.goal}\n\n**Outcomes**\n${merged.join("\n") || "- none"}${missed.length ? `\n\n**Failed or skipped**\n${missed.join("\n")}` : ""}\n\nMerging this PR lands the whole sprint on main; \`planning rollback --goal ${goal.id}\` reverts it as a unit.`;
}
export function integrationMessage(goal: PlanningGoal, prUrl: string, omissions: ImplementationEvidence["omissions"]): string {
  const partial = omissions?.length ? `\n\n**Owner-authorized omissions**\n${omissions.map((item) => `- ${item.outcomeId}: ${item.reason}`).join("\n")}` : "";
  return `**Sprint ${goal.id} is ready: ${prUrl}**\nThis PR takes \`${sprintBranch(goal.id)}\` into main. ${approvalGateText("integration")}${partial}`;
}
export function revertMessage(goal: PlanningGoal, prUrl: string): string {
  return `**Rollback of sprint ${goal.id}: ${prUrl}**\nThis PR on main reverts the sprint's merge commit ${goal.integration!.mergedSha!.slice(0, 7)}. To merge the revert once its CI is green, a person reacts :${APPROVE_EMOJI}: on this post (or the owner presses M in Chick's detail).`;
}
/** Chick's prompts are contracts: the outcome and its acceptance, what Indra does next, the constraints and the schema. */
export function prompt(goal: PlanningGoal, input: string, drafting: boolean, developers: Seat[]): string {
  const seats = developers.map((seat) => `${seat.id} (${seat.displayName})`).join(", ");
  const task = drafting
    ? `Outcome: a proposed outcome-based roadmap for this goal. This is a draft for human review, awaiting the plan approval gate.
Acceptance: each outcome is small, focused on one concern, and independently verifiable; its description states its acceptance criteria and targeted tests. Keep outcomes roughly equal in size. In each outcome's description, list every file it will touch, including test files. Outcomes assigned to different seats must not touch the same file. Name each dependency by outcome title and owning seat ID, and state the order in which dependent work must land. For any shared-file wiring, name one owning outcome and seat; list its files only under that owner and make the other outcomes depend on it. Assign every outcome to one of these Developer seats by its seat ID: ${seats || "none"}. Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.
Afterwards Indra posts the draft in the goal thread. With auto mode off: Nothing starts until a person approves it through a verified human reaction or the owner's planning approve command; then Indra queues each outcome for its Developer seat. With auto mode on, Indra may approve under the owner's current standing policy after all proposal checks pass, recording automatic provenance. You never grant approval. Cite the selected backlog tickets, the value this sprint would deliver and the latest available frozen retrospective when supplied; unavailable evidence stays unknown.
Return only JSON with keys summary, outcomes (title, description and seatId), risks, openQuestions.`
    : `Outcome: a reply to the human message and an updated durable brief. Acceptance: decisions hold agreed facts only, and openQuestions names what is still unclear.
Afterwards Indra posts your reply in the goal thread and keeps the brief for the next message and the draft.
Return only JSON with keys reply, summary, decisions (agreed facts only), openQuestions.`;
  return `You are Chick Corea, the Team Lead seat in Indra. This is planning only.
${task}
Constraints: do not edit files, run implementation, deploy, or claim approval. Never put credentials in your output.
Goal: ${goal.goal}
Projects: ${goal.projectRefs.join(", ")}
Current brief: ${JSON.stringify(goal.brief)}
Human message: ${input}`;
}
