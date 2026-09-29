/** A team has one serving Team Lead; Product grooms work and Developers implement it. */
export const SEAT_ROLES = ["Team Lead", "Developer", "Product"] as const;
export type SeatRole = typeof SEAT_ROLES[number];
export const SEAT_STATUSES = ["pending", "active", "retiring", "retired"] as const;
export type SeatStatus = typeof SEAT_STATUSES[number];
/** Missing status is the original v1 active seat. Retiring seats finish existing work only. */
export const seatStatus = (seat: { status?: SeatStatus }): SeatStatus => seat.status ?? "active";
export const isActiveSeat = (seat: { status?: SeatStatus }): boolean => seatStatus(seat) === "active";

export const INITIAL_TEAM_MISSION = "Indra is a startup simulator: a control plane where agent seats run a software team end to end on a real project, so the owner steers only by problems, value and approvals.";

/** Durable identity. A pending bot has a chosen username but need not have an account yet. */
export interface SeatRecord {
  id: string; displayName: string; roles: SeatRole[]; status?: SeatStatus;
  externalIdentities: { mattermost: { username: string; userId?: string } };
}
export interface StandingPolicyRevision {
  revision: number; enabled: boolean; source: "owner-command"; at: string;
}
/** Append-only owner decisions. No record means off; the last revision is the current setting. */
export interface StandingPolicy { revisions: StandingPolicyRevision[] }
export const autoModeEnabled = (team: { standingPolicy?: StandingPolicy }): boolean => team.standingPolicy?.revisions.at(-1)?.enabled === true;
export interface BacklogTicket {
  id: string; title: string; description: string; value: string;
  status: "open" | "planned" | "done" | "discarded";
  createdAt: string; updatedAt: string; createdBySeatId: string; updatedBySeatId: string;
  dependsOn?: string[];
  research?: { url: string; finding: string }[];
}
export interface SprintCandidate {
  id: string; title: string; summary: string; value: string; rank: number;
  status: "candidate" | "proposed" | "completed" | "discarded";
  ticketIds: string[]; createdAt: string; updatedAt: string; createdBySeatId: string; updatedBySeatId: string;
  goalId?: string; retrospectiveGoalId?: string;
}
export interface TeamFeatures {
  /** Set only through the owner's settings port; never inferred from agent output. */
  mission?: string;
  standingPolicy?: StandingPolicy;
  backlog?: BacklogTicket[];
  sprintCandidates?: SprintCandidate[];
}
export interface TeamRecord extends TeamFeatures {
  id: string; slug: string; displayName: string; project?: { github: string };
  externalIdentities: { mattermost: { teamId: string; homeChannelId?: string } };
  seats: SeatRecord[];
}

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const text = { type: "string", pattern: "\\S" };
const id = { type: "string", pattern: "^[a-z][a-z0-9-]+$" };
const time = { type: "string", format: "date-time" };
const ids = { type: "array", uniqueItems: true, items: id };
const authors = { createdAt: time, updatedAt: time, createdBySeatId: id, updatedBySeatId: id };
/** Shared by the reader and the shipped JSON Schema, so new durable fields reject runtime bookkeeping. */
export const TEAM_SCHEMA_DEFS = {
  standingPolicy: object({ revisions: { type: "array", minItems: 1, items: object({ revision: { type: "integer", minimum: 1 }, enabled: { type: "boolean" }, source: { const: "owner-command" }, at: time }) } }),
  backlogTicket: object({ id, title: text, description: text, value: text, status: { enum: ["open", "planned", "done", "discarded"] }, ...authors,
    dependsOn: ids, research: { type: "array", items: object({ url: { type: "string", pattern: "^https?://", format: "uri" }, finding: text }) },
  }, ["id", "title", "description", "value", "status", ...Object.keys(authors)]),
  sprintCandidate: object({ id, title: text, summary: text, value: text, rank: { type: "integer", minimum: 1 }, status: { enum: ["candidate", "proposed", "completed", "discarded"] },
    ticketIds: { ...ids, minItems: 1 }, ...authors, goalId: id, retrospectiveGoalId: id,
  }, ["id", "title", "summary", "value", "rank", "status", "ticketIds", ...Object.keys(authors)]),
  teamFeatures: object({ mission: text, standingPolicy: { $ref: "#/$defs/standingPolicy" }, backlog: { type: "array", items: { $ref: "#/$defs/backlogTicket" } }, sprintCandidates: { type: "array", items: { $ref: "#/$defs/sprintCandidate" } } }, []),
};

/** Business records used by the terminal, independent of their storage or source. */
export interface StateSeat {
  id: string;
  displayName: string;
  handle: string;
  /** Empty for a pending seat without an account (and a cancelled pending seat); never persisted as an ID. */
  mattermostUserId: string;
  status?: SeatStatus;
  /** Exactly one entry from SEAT_ROLES once validated. */
  roles: string[];
}

export interface StateTeam extends TeamFeatures {
  id: string;
  slug: string;
  displayName: string;
  mattermostTeamId: string;
  /** `externalIdentities.mattermost.homeChannelId`: where Chick opens the team's planning threads. */
  homeChannelId?: string;
  /** The team's GitHub repository; Indra keeps its own clone of it. */
  project?: { github: string };
  seats: StateSeat[];
}

export interface StateSnapshot {
  teams: StateTeam[];
}

/** Each refresh asks this port for a fresh snapshot. */
export interface StateRepository {
  read(): Promise<StateSnapshot>;
}

export class StateInventory {
  constructor(private readonly repository: StateRepository) {}

  async current(): Promise<StateSnapshot> {
    const snapshot = await this.repository.read();
    return {
      teams: snapshot.teams.map((team) => ({
        ...team,
        seats: [...team.seats].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      })).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }
}
