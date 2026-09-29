import type { AutomaticApproval, PublishedRetroEvidence } from "./ceremony.js";
import type { PlanningDocument, PlanningGoal, PlanningStore } from "./planning.js";
import type { BacklogTicket, SeatRecord, SprintCandidate, StandingPolicyRevision, TeamRecord } from "./state-domain.js";

/** The capability supplied to agent-facing features. Its writer rejects changes to owner settings. */
export type AgentStatePort = Pick<PlanningStore, "read" | "update">;
/** Supplied only to owner command/TUI handlers, never to an agent tool or parsed agent response. */
export type OwnerSettingsPort = Pick<PlanningStore, "updateOwnerSettings">;

/** No credential value crosses this boundary. The adapter reads the 1Password item at runtime. */
export interface SeatLifecyclePorts {
  /** Verify the existing bot account with its credential; never create Mattermost accounts. */
  credentialIdentity(team: TeamRecord, seat: SeatRecord): Promise<{ userId: string; username: string; isBot: true } | undefined>;
  /** True only after GitHub confirms this source branch has no PR in any state; unknown results refuse transfer. */
  branchHasNoPr(team: TeamRecord, branch: string): Promise<boolean>;
  /** Check local running work as well as durable assignments before recording retirement. */
  workSettled(teamId: string, seatId: string): Promise<boolean>;
  startSeat(team: TeamRecord, seat: SeatRecord): Promise<void>;
  retireSeat(team: TeamRecord, seat: SeatRecord): Promise<void>;
}
export function seatCredentialRequirement(seat: SeatRecord): { username: string; item: string; field: "token" } {
  const username = seat.externalIdentities.mattermost.username;
  return { username, item: `Mattermost bot - ${username}`, field: "token" };
}

export interface BacklogGroomingInput {
  state: PlanningDocument; team: TeamRecord; seat: SeatRecord;
  latestRetro?: { goalId: string; evidence: PublishedRetroEvidence };
}
/** Only backlog/candidate records can be proposed by Product and the Team Lead; settings are not in the result. */
export interface BacklogGroomingPorts {
  groom(input: BacklogGroomingInput): Promise<{ tickets: BacklogTicket[]; candidates: SprintCandidate[] }>;
  proposeNext(team: TeamRecord, candidate: SprintCandidate, latestRetro?: BacklogGroomingInput["latestRetro"]): Promise<PlanningGoal | undefined>;
}

export interface ReviewedPrHead {
  prUrl: string; headSha: string; baseBranch: "main";
  checksPassed: true; reviewApproved: true; reviewer: "satori-miyamoto"; reviewedHeadSha: string;
}
/**
 * Adapters verify external facts; absent/unknown checks never satisfy a gate. Re-read the current policy inside the
 * state transaction, append goal.automaticApprovals, then execute. A cached decision is not permission after off.
 * Merge with GitHub's expected-head check, and persist the same authorization in release/retro ceremony evidence.
 * Retro additionally requires the existing verified running release and the frozen one-file archival change.
 */
export interface AutonomyGatePorts {
  proposal(goal: PlanningGoal, policy: StandingPolicyRevision): Promise<AutomaticApproval | undefined>;
  integration(goal: PlanningGoal, policy: StandingPolicyRevision): Promise<ReviewedPrHead | undefined>;
  retro(goal: PlanningGoal, policy: StandingPolicyRevision): Promise<ReviewedPrHead | undefined>;
}
