import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readToken } from "./credential.js";
import { Inventory, InventoryError, type Seat, type Team } from "./domain.js";
import { LocalStateRepository, StateDataError } from "./local-state.js";
import { MattermostClient, MattermostInventory } from "./mattermost.js";
import { interactiveState, printState } from "./state-cli.js";
import { StateInventory } from "./state-domain.js";
import { PlanningStore } from "./planning.js";
import { PlanningBridge } from "./planning-bridge.js";
import { MattermostPlanningChat, readChickToken } from "./planning-mattermost.js";
import { CodexRuntime } from "./codex-runtime.js";
import { TmuxHost } from "./tmux-host.js";
import { LocalSessionReader } from "./session-snapshot.js";
import { mkdir, writeFile } from "node:fs/promises";

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

type Options = { mode: "help" } | { mode: "state"; checkout: string; once: boolean } | { mode: "mattermost"; slug?: string } | { mode: "planning"; action: "start" | "serve" | "host" | "status"; checkout: string; channel?: string; goal?: string; projects: string[]; participants: string[]; readyNonce?: string };

const usage = "Usage: npm start -- [--state PATH] [--once] | --mattermost [--team SLUG] | planning start --goal TEXT --channel CHANNEL_ID [--project PATH] [--participant SEAT_ID] [--state PATH] | planning serve|host|status [--state PATH]\nPlanning serves only Chick's Yahaha thread. Reply in the thread to clarify; send /proposal there to request a draft.";

export function parseOptions(args: string[], stateEnv = process.env.INDRA_STATE_REPO): Options {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { mode: "help" };
  if (args[0] === "planning") {
    const action = args[1];
    if (action !== "start" && action !== "serve" && action !== "host" && action !== "status") throw new StateDataError(usage);
    let checkout: string | undefined; let channel: string | undefined; let goal: string | undefined; let readyNonce: string | undefined;
    const projects: string[] = []; const participants: string[] = [];
    for (let index = 2; index < args.length; index++) {
      const key = args[index]; const value = args[++index];
      if (!value || value.startsWith("--")) throw new StateDataError(usage);
      if (key === "--state" && !checkout) checkout = value;
      else if (key === "--channel" && !channel) channel = value;
      else if (key === "--goal" && !goal) goal = value;
      else if (key === "--project") projects.push(value);
      else if (key === "--participant") participants.push(value);
      else if (key === "--ready-nonce" && !readyNonce && action === "serve" && /^[a-f0-9-]{36}$/.test(value)) readyNonce = value;
      else throw new StateDataError(usage);
    }
    if (action === "start" && (!goal || !channel)) throw new StateDataError(usage);
    if (action !== "start" && (goal || channel || projects.length || participants.length)) throw new StateDataError(usage);
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    return { mode: "planning", action, checkout: resolve(checkout || stateEnv || resolve(projectRoot, "..", "indra-state")), goal, channel, projects, participants, readyNonce };
  }
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
    if (options.mode === "planning") {
      if (options.action === "host") {
        const host = new TmuxHost(options.checkout);
        const record = await host.start();
        console.log(`Chick bridge hosted in tmux. Attach target: ${host.attachTarget(record)}`);
        return 0;
      }
      if (options.action === "status") {
        console.log(JSON.stringify(await new LocalSessionReader(options.checkout).readSessions(), null, 2));
        return 0;
      }
      const store = new PlanningStore(options.checkout);
      const chat = new MattermostPlanningChat(await readChickToken());
      const runtime = new CodexRuntime(process.cwd());
      const bridge = new PlanningBridge(store, chat, runtime);
      if (options.action === "start") {
        const goal = await bridge.start(options.goal!, options.channel!, options.projects, options.participants);
        console.log(`Planning goal ${goal.id}: ${SERVER}/yahaha/pl/${goal.mattermost.rootPostId}`);
        return 0;
      }
      console.log("Chick planning bridge running. Stop with Ctrl-C.");
      let ready = false;
      while (true) {
        await bridge.poll();
        if (!ready && options.readyNonce) {
          const host = new TmuxHost(options.checkout);
          await mkdir(host.runtimeDir, { recursive: true, mode: 0o700 });
          await writeFile(host.readyFile(options.readyNonce), JSON.stringify({ nonce: options.readyNonce, pid: process.pid, readyAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
          ready = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
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
