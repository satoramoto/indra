/** The only permanent seat roles. A team has exactly one Team Lead; every other seat is a Developer. */
export const SEAT_ROLES = ["Team Lead", "Developer"] as const;

/** Business records used by the terminal, independent of their storage or source. */
export interface StateSeat {
  id: string;
  displayName: string;
  handle: string;
  mattermostUserId: string;
  /** Exactly one entry from SEAT_ROLES once validated. */
  roles: string[];
}

export interface StateTeam {
  id: string;
  slug: string;
  displayName: string;
  mattermostTeamId: string;
  seats: StateSeat[];
}

export interface ProposedWork {
  id: string;
  title: string;
  description: string;
}

export interface ProposedAllocation {
  seatId: string;
  workIds: string[];
}

export interface DraftSprint {
  id: string;
  teamId: string;
  status: "draft";
  phase: string;
  goal: string;
  proposedWork: ProposedWork[];
  proposedAllocations: ProposedAllocation[];
}

export interface StateSnapshot {
  teams: StateTeam[];
  sprints: DraftSprint[];
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
      sprints: [...snapshot.sprints].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
}
