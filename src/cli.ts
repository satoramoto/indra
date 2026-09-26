import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { readToken } from "./credential.js";
import { Inventory, InventoryError, type Seat, type Team } from "./domain.js";
import { MattermostClient, MattermostInventory } from "./mattermost.js";

export const SERVER = "https://mattermost.newegypt.io";
export type Write = (line: string) => void;
export type Read = (prompt: string) => Promise<string>;

function timestamp(): string {
  return new Date().toISOString();
}

export function printTeams(teams: Team[], refreshed: string, write: Write): void {
  write(`Connected to ${SERVER} | teams refreshed ${refreshed}`);
  write("Inventory is limited to teams and bots visible to this credential.");
  if (teams.length === 0) write("No teams are visible to this credential.");
  teams.forEach((team, index) => write(`  ${index + 1}. ${team.displayName} (${team.slug})`));
}

export function printSeats(team: Team, seats: Seat[], refreshed: string, write: Write): void {
  write(`${team.displayName} (${team.slug}) | seats refreshed ${refreshed}`);
  write("Connection: team and bot reads succeeded; any Role read errors appear per seat. Agent occupancy: not connected yet.");
  if (seats.length === 0) write("No active bot seats are visible in this team's membership.");
  for (const seat of seats) {
    const roles = seat.roleError ? `unavailable (${seat.roleError})` : seat.roles.join(", ") || "none";
    write(`  ${seat.displayName} (@${seat.username}) | Role: ${roles}`);
  }
}

export async function interactive(inventory: Inventory, read: Read, write: Write): Promise<number> {
  let teams: Team[] = [];
  while (true) {
    try {
      teams = await inventory.teams();
      printTeams(teams, timestamp(), write);
    } catch (error) {
      if (!(error instanceof InventoryError)) throw error;
      write(`Connection/error: ${error.message}`);
      write("Team list was not refreshed; its previous contents may be stale.");
    }
    const choice = (await read("Team number, [r]efresh, or [q]uit: ")).trim().toLowerCase();
    if (choice === "q") return 0;
    if (choice === "r") continue;
    const number = Number(choice);
    if (!/^\d+$/.test(choice) || number < 1 || number > teams.length) {
      write("Choose a listed team number, r, or q.");
      continue;
    }
    const team = teams[number - 1];
    while (true) {
      try {
        printSeats(team, await inventory.seats(team), timestamp(), write);
      } catch (error) {
        if (!(error instanceof InventoryError)) throw error;
        write(`Connection/error: ${error.message}`);
        write("Seat inventory is unavailable; no empty-seat conclusion can be drawn.");
      }
      const action = (await read("[r]efresh seats, [b]ack, or [q]uit: ")).trim().toLowerCase();
      if (action === "r") continue;
      if (action === "q") return 0;
      if (action === "b") break;
      write("Choose r, b, or q.");
    }
  }
}

function parseTeamArg(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("Usage: npm start -- [--team SLUG]\nInspect visible Mattermost teams and bot seats.\n");
    return "";
  }
  if (args.length === 2 && args[0] === "--team" && args[1]) return args[1];
  throw new InventoryError("Usage: npm start -- [--team SLUG]");
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const slug = parseTeamArg(args);
    if (slug === "") return 0;
    const adapter = new MattermostInventory(new MattermostClient(SERVER, await readToken()));
    const inventory = new Inventory(adapter, adapter);
    if (slug) {
      const team = (await inventory.teams()).find((item) => item.slug === slug);
      if (!team) throw new InventoryError(`Team '${slug}' is not visible to this credential.`);
      printSeats(team, await inventory.seats(team), timestamp(), console.log);
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await interactive(inventory, (prompt) => rl.question(prompt), console.log);
    } finally {
      rl.close();
    }
  } catch (error) {
    if (error instanceof InventoryError) console.error(`Connection/error: ${error.message}`);
    else if (error instanceof Error && error.name !== "AbortError") console.error("Connection/error: The inventory could not complete.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
