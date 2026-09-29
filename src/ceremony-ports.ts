import type { PlanningGoal } from "./planning.js";
import type { ApprovalEvidence, CeremonyRecord, ImplementationEvidence, PublishedRetroEvidence, RunningReleaseEvidence } from "./ceremony.js";

/** Rollout is opt-in only after the companion schema and every reader/writer have shipped. Never persist this in state. */
export const CEREMONY_CONSUMERS = ["planning", "developer", "release", "retro", "tui"] as const;
export interface CeremonyWriteReadiness { version: 1; consumers: Record<typeof CEREMONY_CONSUMERS[number], 1> }
export function assertCeremonyReady(readiness?: CeremonyWriteReadiness): void {
  if (readiness?.version !== 1 || CEREMONY_CONSUMERS.some((consumer) => readiness.consumers?.[consumer] !== 1)) {
    throw new Error("Ceremony writes are disabled until all consumers support ceremony v1.");
  }
}

/**
 * Adapters verify external facts before returning evidence; absence is not success. Persist returned proof with
 * advanceCeremony/closeCeremony in a single PlanningStore.update. Store validation binds proof to the current goal.
 * Approval adapters accept only the owner's terminal command or a GET-verified human checkmark on Chick's matching
 * proposal/merge post, excluding bots, the bridge and Chick. No adapter automatically approves or applies suggestions.
 */
export interface CeremonyEvidencePorts {
  approval(goal: PlanningGoal): Promise<ApprovalEvidence | undefined>;
  implementation(goal: PlanningGoal): Promise<ImplementationEvidence | undefined>;
  /** Must observe the running build after restart; a merged PR or a successful build alone is insufficient. */
  runningRelease(goal: PlanningGoal): Promise<RunningReleaseEvidence | undefined>;
  /** Verify both the thread post and the merged PR containing docs/retros/<goal-id>.md. */
  publishedRetro(goal: PlanningGoal): Promise<PublishedRetroEvidence | undefined>;
}

/** Recorded facts only; unknown values stay null. These records belong under <state-checkout>.runtime. */
export interface CeremonyRuntimeFacts {
  seats: { seatId: string; wallTimeMs: number | null }[];
  sessions: { seatId: string; sessionId: string; startedAt: string; finishedAt: string | null; usage: unknown | null }[];
  reviews: { outcomeId: string; prUrl: string; findings: string[] }[];
  rounds: { outcomeId: string; fix: number; conflict: number }[];
  failures: { at: string; outcomeId?: string; message: string; retries: number }[];
}
export interface CeremonyRuntimeRecord {
  facts: CeremonyRuntimeFacts;
  /** Delivery IDs/cursors never join CeremonyRecord. Reconcile this outbox against durable history after a crash. */
  deliveredStages: string[];
  pending?: { key: string; message: string };
}
export interface CeremonyPresentationPorts {
  stageChanged(goal: PlanningGoal, ceremony: CeremonyRecord, deliveryKey: string): Promise<void>;
  retroFacts(goalId: string): Promise<CeremonyRuntimeFacts>;
}
