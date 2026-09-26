import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readToken } from "./credential.js";
import { Inventory, InventoryError, type Seat, type Team } from "./domain.js";
import { LocalStateRepository, StateDataError } from "./local-state.js";
import { MattermostClient, MattermostInventory } from "./mattermost.js";
import { interactiveState, printState } from "./state-cli.js";
import { StateInventory } from "./state-domain.js";

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

type Options = { mode: "help" } | { mode: "state"; checkout: string; once: boolean } | { mode: "mattermost"; slug?: string };

const usage = "Usage: npm start -- [--state PATH] [--once] | --mattermost [--team SLUG]\nDefault: inspect the local indra-state checkout; use r to refresh.\n--mattermost: read the live Mattermost inventory using the existing 1Password credential.";

export function parseOptions(args: string[], stateEnv = process.env.INDRA_STATE_REPO): Options {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { mode: "help" };
  let mattermost = false;
  let checkout: string | undefined;
  let slug: string | undefined;
  let once = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--mattermost" && !mattermost) mattermost = true;
    else if (arg === "--once" && !once) once = true;
    else if ((arg === "--state" || arg === "--team") && args[index + 1] && !args[index + 1].startsWith("--")) {
      const value = args[++index];
      if (arg === "--state" && !checkout) checkout = value;
      else if (arg === "--team" && !slug) slug = value;
      else throw new StateDataError(usage);
    } else throw new StateDataError(usage);
  }
  if (mattermost) {
    if (checkout || once) throw new StateDataError(usage);
    return { mode: "mattermost", slug };
  }
  if (slug) throw new StateDataError("--team requires --mattermost.\n" + usage);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return { mode: "state", checkout: resolve(checkout || stateEnv || resolve(projectRoot, "..", "indra-state")), once };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseOptions(args);
    if (options.mode === "help") {
      console.log(usage);
      return 0;
    }
    if (options.mode === "state") {
      const inventory = new StateInventory(new LocalStateRepository(options.checkout));
      console.log(`State checkout: ${options.checkout}`);
      if (options.once) {
        printState(await inventory.current(), timestamp(), console.log);
        return 0;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await interactiveState(inventory, (prompt) => rl.question(prompt), console.log);
      } finally {
        rl.close();
      }
    }
    const slug = options.slug;
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
    if (error instanceof StateDataError) console.error(`State error: ${error.message}`);
    else if (error instanceof InventoryError) console.error(`Connection/error: ${error.message}`);
    else if (error instanceof Error && error.name !== "AbortError") console.error("Connection/error: The inventory could not complete.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
