/**
 * Approved-work records written by plan approval and advanced by Developer seats.
 * Shared contract with the plan approval change; reconcile here when it lands.
 */
export type AssignmentStatus = "queued" | "running" | "in-review" | "merged" | "failed";
export const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ["queued", "running", "in-review", "merged", "failed"];

export interface ApprovedOutcome { id: string; title: string; description: string; seatId?: string }

export interface Assignment {
  outcomeId: string;
  seatId: string;
  status: AssignmentStatus;
  updatedAt: string;
  prUrl?: string;
  note?: string;
}
