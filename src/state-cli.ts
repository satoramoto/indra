import type { Read, Write } from "./cli.js";
import { StateDataError } from "./local-state.js";
import { StateInventory, type StateSnapshot } from "./state-domain.js";

export function printState(snapshot: StateSnapshot, refreshed: string, write: Write): void {
  write(`Indra state | refreshed ${refreshed}`);
  write("Business records are read from the configured state checkout. Agent occupancy: not connected yet.");
  if (snapshot.teams.length === 0) write("No teams are recorded.");
  for (const team of snapshot.teams) {
    write(`\n${team.displayName} (${team.slug}) | ${team.seats.length} seats`);
    if (team.seats.length === 0) write("  No seats are recorded.");
    for (const seat of team.seats) {
      write(`  ${seat.displayName} (@${seat.handle}) | Role: ${seat.roles.join(", ") || "none"}`);
    }
  }
}

export async function interactiveState(inventory: StateInventory, read: Read, write: Write): Promise<number> {
  while (true) {
    try {
      printState(await inventory.current(), new Date().toISOString(), write);
    } catch (error) {
      if (!(error instanceof StateDataError)) throw error;
      write(`State error: ${error.message}`);
      write("State was not refreshed; correct the checkout and refresh.");
    }
    const choice = (await read("[r]efresh state or [q]uit: ")).trim().toLowerCase();
    if (choice === "q") return 0;
    if (choice !== "r") write("Choose r or q.");
  }
}
