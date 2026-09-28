import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { readToken } from "./credential.js";
import { Inventory, InventoryError, type Seat, type Team } from "./domain.js";
import { LocalStateRepository, StateDataError } from "./local-state.js";
import { MattermostClient, MattermostInventory } from "./mattermost.js";
import { printState } from "./state-cli.js";
import { StateInventory } from "./state-domain.js";
import { PlanningStore } from "./planning.js";
import { PlanningBridge } from "./planning-bridge.js";
import { MattermostPlanningChat, readBotToken, readChickToken, type BotTokenOptions } from "./planning-mattermost.js";
import { readServiceToken, stageServiceToken } from "./service-account.js";
import { DeveloperSeat, loadDeveloperSeat, processShell } from "./developer-seat.js";
import { CodexRuntime } from "./codex-runtime.js";
import { defaultAppDir, signalReady, TmuxHost, turnLockFile } from "./tmux-host.js";
import { withFileLock } from "./state-commit.js";
import { readBuildStamp } from "./build-stamp.js";
import { SelfUpdater } from "./self-update.js";
import { appRootOf, isEntry, LAUNCHER_ENV, RELOAD_EXIT_CODE } from "./reload.js";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import type { UiView } from "./terminal-ui.js";
import { LocalSessionReader } from "./session-snapshot.js";
import { CliGoalStarter, Supervisor } from "./supervisor.js";
import { checkConsistency, printConsistency, type TeamMemberReader } from "./consistency.js";

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

/**
 * Reads a process's bot token with the service account token the control plane staged, if any.
 * A hosted process (one with a ready nonce) never falls back to a desktop prompt; when its token is missing,
 * it tells the tmux host "no credential" before failing.
 */
export async function hostedToken(checkout: string, readyNonce: string | undefined, read: (options: BotTokenOptions) => Promise<string>, lingerMs = 5000): Promise<string> {
  try { return await read({ serviceToken: await readServiceToken(checkout), headless: !!readyNonce }); }
  catch (error) {
    if (readyNonce) {
      await signalReady(checkout, readyNonce, "no-credential").catch(() => {});
      // Stay alive briefly so the host sees the signal from a verified pane rather than a vanished one.
      await new Promise((done) => setTimeout(done, lingerMs));
    }
    throw error;
  }
}

/** Prints the live Mattermost vs state report; returns the exit code (1 when anything differs). */
export async function runConsistencyCheck(state: StateInventory, reader: TeamMemberReader, write: Write): Promise<number> {
  const reports = await checkConsistency(await state.current(), reader);
  return printConsistency(reports, timestamp(), write) > 0 ? 1 : 0;
}

type Options = { mode: "help" } | { mode: "seat"; seatId: string; checkout: string; readyNonce?: string } | { mode: "state"; checkout: string; once: boolean } | { mode: "ui"; checkout: string } | { mode: "mattermost"; slug: string } | { mode: "mattermost"; checkout: string; once: boolean } | { mode: "planning"; action: "start" | "serve" | "host" | "status" | "approve"; checkout: string; goal?: string; participants: string[]; readyNonce?: string };

const usage = "Usage: npm start -- [--state PATH] [--once] | --ui [--state PATH] | --mattermost [--state PATH] [--once] | --mattermost --team SLUG | planning start --goal TEXT [--participant SEAT_ID] [--state PATH] | planning approve --goal GOAL_ID [--state PATH] | planning serve|host|status [--state PATH] | seat run --seat SEAT_ID [--state PATH]\nPlanning serves only Chick's Yahaha thread, in the team's home channel and project from state. Reply in the thread to clarify; react :memo: on Chick's goal post to request a draft, and :white_check_mark: on the proposal post to approve it.";

export function parseOptions(args: string[], stateEnv = process.env.INDRA_STATE_REPO): Options {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { mode: "help" };
  if (args[0] === "seat") {
    if (args[1] !== "run") throw new StateDataError(usage);
    let checkout: string | undefined; let seatId: string | undefined; let readyNonce: string | undefined;
    for (let index = 2; index < args.length; index++) {
      const key = args[index]; const value = args[++index];
      if (!value || value.startsWith("--")) throw new StateDataError(usage);
      if (key === "--state" && !checkout) checkout = value;
      else if (key === "--seat" && !seatId) seatId = value;
      else if (key === "--ready-nonce" && !readyNonce && /^[a-f0-9-]{36}$/.test(value)) readyNonce = value;
      else throw new StateDataError(usage);
    }
    if (!seatId) throw new StateDataError(usage);
    const projectRoot = appRootOf(import.meta.url);
    return { mode: "seat", seatId, checkout: resolve(checkout || stateEnv || resolve(projectRoot, "..", "indra-state")), ...(readyNonce ? { readyNonce } : {}) };
  }
  if (args[0] === "planning") {
    const action = args[1];
    if (action !== "start" && action !== "serve" && action !== "host" && action !== "status" && action !== "approve") throw new StateDataError(usage);
    let checkout: string | undefined; let goal: string | undefined; let readyNonce: string | undefined;
    const participants: string[] = [];
    for (let index = 2; index < args.length; index++) {
      const key = args[index]; const value = args[++index];
      if (!value || value.startsWith("--")) throw new StateDataError(usage);
      if (key === "--state" && !checkout) checkout = value;
      else if (key === "--goal" && !goal) goal = value;
      else if (key === "--participant" && action === "start") participants.push(value);
      else if (key === "--ready-nonce" && !readyNonce && action === "serve" && /^[a-f0-9-]{36}$/.test(value)) readyNonce = value;
      else throw new StateDataError(usage);
    }
    if ((action === "start" || action === "approve") !== !!goal) throw new StateDataError(usage);
    const projectRoot = appRootOf(import.meta.url);
    return { mode: "planning", action, checkout: resolve(checkout || stateEnv || resolve(projectRoot, "..", "indra-state")), goal, participants, ...(readyNonce ? { readyNonce } : {}) };
  }
  let mattermost = false;
  let checkout: string | undefined;
  let slug: string | undefined;
  let once = false;
  let ui = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--mattermost" && !mattermost) mattermost = true;
    else if (arg === "--ui" && !ui) ui = true;
    else if (arg === "--once" && !once) once = true;
    else if ((arg === "--state" || arg === "--team") && args[index + 1] && !args[index + 1].startsWith("--")) {
      const value = args[++index];
      if (arg === "--state" && !checkout) checkout = value;
      else if (arg === "--team" && !slug) slug = value;
      else throw new StateDataError(usage);
    } else throw new StateDataError(usage);
  }
  if (slug && !mattermost) throw new StateDataError("--team requires --mattermost.\n" + usage);
  if (ui && (once || mattermost)) throw new StateDataError(usage);
  if (slug) {
    if (checkout || once) throw new StateDataError(usage);
    return { mode: "mattermost", slug };
  }
  const projectRoot = appRootOf(import.meta.url);
  const stateCheckout = resolve(checkout || stateEnv || resolve(projectRoot, "..", "indra-state"));
  if (mattermost) return { mode: "mattermost", checkout: stateCheckout, once };
  // The terminal UI is the default; --ui is kept as an alias.
  return once ? { mode: "state", checkout: stateCheckout, once } : { mode: "ui", checkout: stateCheckout };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseOptions(args);
    if (options.mode === "help") {
      console.log(usage);
      return 0;
    }
    if (options.mode === "seat") {
      try {
        const store = new PlanningStore(options.checkout);
        const seat = await loadDeveloperSeat(store, options.seatId);
        const chat = new MattermostPlanningChat(await hostedToken(options.checkout, options.readyNonce, (tokenOptions) => readBotToken(seat.username, tokenOptions)));
        if (options.readyNonce) await signalReady(options.checkout, options.readyNonce);
        const runner = new DeveloperSeat(store, seat, chat, processShell, (cwd, write) => new CodexRuntime(cwd, 60 * 60_000, write), (line) => console.log(`[${new Date().toISOString()}] ${line}`));
        console.log(`Developer seat ${seat.id} (@${seat.username}) running. Stop with Ctrl-C.`);
        while (true) {
          // Each step holds the turn lock, so the supervisor only restarts this runner for an update between steps.
          if (await withFileLock(turnLockFile(options.checkout, { kind: "seat", seatId: seat.id }), () => runner.tick(), 24 * 60 * 60_000) === "idle") await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      } catch (error) {
        console.error(`Seat error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }
    if (options.mode === "ui") {
      const { runTerminalUi } = await import("./terminal-ui-solid.js");
      // The view to restore after a reload for new code; read once, then removed.
      const viewFile = join(`${options.checkout}.runtime`, "ui-view.json");
      const view = await readFile(viewFile, "utf8").then((text) => JSON.parse(text) as UiView, () => undefined);
      await rm(viewFile, { force: true });
      const updater = new SelfUpdater(defaultAppDir);
      return await runTerminalUi(new StateInventory(new LocalStateRepository(options.checkout)), new LocalSessionReader(options.checkout), {
        processes: new Supervisor(options.checkout, undefined, undefined, undefined, undefined, () => stageServiceToken(options.checkout)),
        goals: new CliGoalStarter(options.checkout),
        sync: new PlanningStore(options.checkout),
        update: {
          running: await readBuildStamp(defaultAppDir),
          canReload: process.env[LAUNCHER_ENV] === "1",
          check: () => updater.check(),
          current: () => readBuildStamp(defaultAppDir),
        },
        view,
        reload: async (current) => {
          // Best effort: without the saved view the reloaded UI opens on its default page.
          await mkdir(dirname(viewFile), { recursive: true, mode: 0o700 }).then(() => writeFile(viewFile, JSON.stringify(current), { mode: 0o600 })).catch(() => undefined);
          return RELOAD_EXIT_CODE;
        },
      });
    }
    if (options.mode === "state") {
      const inventory = new StateInventory(new LocalStateRepository(options.checkout));
      console.log(`State checkout: ${options.checkout}`);
      printState(await inventory.current(), timestamp(), console.log);
      return 0;
    }
    if (options.mode === "planning") {
      if (options.action === "host") {
        await stageServiceToken(options.checkout);
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
      if (options.action === "approve") {
        // Run by the terminal UI: like a hosted process, it reads Chick's token only with the staged service account token.
        try {
          const chat = new MattermostPlanningChat(await readChickToken({ serviceToken: await readServiceToken(options.checkout), headless: true }));
          const { goal, alreadyApproved } = await new PlanningBridge(store, chat, new CodexRuntime(process.cwd())).approve(options.goal!);
          console.log(alreadyApproved ? `Goal ${goal.id} was already approved; no new assignments.` : `Approved goal ${goal.id}: ${goal.assignments?.length ?? 0} outcome(s) queued for Developer seats.`);
          return 0;
        } catch (error) {
          console.error(`Planning error: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      if (options.action === "start") {
        try {
          const chat = new MattermostPlanningChat(await hostedToken(options.checkout, options.readyNonce, readChickToken));
          const goal = await new PlanningBridge(store, chat, new CodexRuntime(process.cwd())).start(options.goal!, options.participants);
          console.log(`Planning goal ${goal.id}: ${SERVER}/yahaha/pl/${goal.mattermost.rootPostId}`);
          return 0;
        } catch (error) {
          console.error(`Planning error: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      const chat = new MattermostPlanningChat(await hostedToken(options.checkout, options.readyNonce, readChickToken));
      const bridge = new PlanningBridge(store, chat, new CodexRuntime(process.cwd()));
      console.log("Chick planning bridge running. Stop with Ctrl-C.");
      let ready = false;
      while (true) {
        // A poll finishes its Codex turns and saves pending deliveries before it releases the turn lock.
        await withFileLock(turnLockFile(options.checkout, { kind: "bridge" }), () => bridge.poll(), 24 * 60 * 60_000);
        if (!ready && options.readyNonce) {
          await signalReady(options.checkout, options.readyNonce);
          ready = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    const adapter = new MattermostInventory(new MattermostClient(SERVER, await readToken()));
    const inventory = new Inventory(adapter, adapter);
    if ("slug" in options) {
      const slug = options.slug;
      const team = (await inventory.teams()).find((item) => item.slug === slug);
      if (!team) throw new InventoryError(`Team '${slug}' is not visible to this credential.`);
      printSeats(team, await inventory.seats(team), timestamp(), console.log);
      return 0;
    }
    const state = new StateInventory(new LocalStateRepository(options.checkout));
    console.log(`State checkout: ${options.checkout}`);
    if (options.once) return await runConsistencyCheck(state, adapter, console.log);
    try {
      await runConsistencyCheck(state, adapter, console.log);
    } catch (error) {
      if (error instanceof StateDataError) console.log(`State error: ${error.message}`);
      else if (error instanceof InventoryError) console.log(`Connection/error: ${error.message}`);
      else throw error;
      console.log("The Mattermost vs state check did not complete; no match can be concluded.");
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

if (isEntry(import.meta.url)) {
  process.exitCode = await main();
}
