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
