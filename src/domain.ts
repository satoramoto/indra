/** Provider-neutral records exposed to the terminal inventory. */
export interface Team {
  id: string;
  slug: string;
  displayName: string;
}

export interface Seat {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  roleError?: string;
}

export interface TeamReader {
  listTeams(): Promise<Team[]>;
}

export interface SeatReader {
  listSeats(team: Team): Promise<Seat[]>;
}

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

/** Sorting and inventory use cases need no knowledge of the selected service. */
export class Inventory {
  constructor(
    private readonly teamReader: TeamReader,
    private readonly seatReader: SeatReader,
  ) {}

  async teams(): Promise<Team[]> {
    const teams = await this.teamReader.listTeams();
    return [...teams].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  }

  async seats(team: Team): Promise<Seat[]> {
    const seats = await this.seatReader.listSeats(team);
    return [...seats].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
      a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
    );
  }
}
