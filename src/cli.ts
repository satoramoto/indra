/// <reference types="vite/client" />
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { readToken } from "./credential.js";
import { Inventory, InventoryError, type Seat, type Team } from "./domain.js";
import { LocalStateRepository, StateDataError } from "./local-state.js";
import { MattermostClient, MattermostInventory } from "./mattermost.js";
import { printState } from "./state-cli.js";
import { StateInventory } from "./state-domain.js";
import { botTeamHome, PlanningStore, teamProject } from "./planning.js";
import { mergedWithCeremony } from "./project-checkout.js";
import { PlanningBridge, type CeremonyAdapters, type PlanningChat } from "./planning-bridge.js";
import { assertCeremonyReady, type CeremonyWriteReadiness } from "./ceremony-ports.js";
import type { ReleaseActivationOptions, ReleaseActivationReadPort } from "./release-activation.js";
import { MATTERMOST_SERVER } from "./hub-format.js";
import { CHICK_USERNAME, MattermostAccessError, MattermostPlanningChat, readBotToken, readChickToken, type BotTokenOptions } from "./planning-mattermost.js";
import { opCredential, stageServiceToken } from "./service-account.js";
import { captureOpEnvironment } from "./op-env.js";
import { DeveloperSeat, loadDeveloperSeat, processShell } from "./developer-seat.js";
import { DEVELOPER_SESSION_TIMEOUT_MS, type AgentRuntime, type WriteAccess } from "./codex-runtime.js";
import { loadSeatEngines, SeatRuntime } from "./seat-runtime.js";
import { seatHarnessDir } from "./harness-home.js";
import { loadSeatPersonas, withPersonaChat, withPersonaRuntime } from "./seat-persona.js";
import { defaultAppDir, signalReady, SystemTmux, TmuxHost, turnLockFile } from "./tmux-host.js";
import { checkLaunch } from "./launch-check.js";
import { withFileLock } from "./state-commit.js";
import { syncStateSchema } from "./state-schema.js";
import { readBuildStamp } from "./build-stamp.js";
import { recordRunningBuild, SelfUpdater } from "./self-update.js";
import { appRootOf, isEntry, LAUNCHER_ENV, RELOAD_EXIT_CODE } from "./reload.js";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import type { UiView } from "./terminal-ui.js";
import { LocalSessionReader } from "./session-snapshot.js";
import { CliGoalStarter, Supervisor } from "./supervisor.js";
import { TmuxPaneTail } from "./pane-tail.js";
import { attachTmux, parseOwnedTmuxTarget } from "./tmux-attach.js";
import { verifyOwnedSession } from "./tmux-attach-owned.js";
import { headedMarkerFile, useHeadedMarker } from "./headed-session.js";
import { LiveUsageReader } from "./live-usage.js";
import { LocalTranscriptSource, TranscriptLocator } from "./session-transcript.js";
import { checkConsistency, printConsistency, type TeamMemberReader } from "./consistency.js";

/**
 * Optional release-activation.ts and retro-publication.ts modules export this contract. Vite includes only
 * modules that exist in the build. The final adapter may advertise readiness after every consumer and the
 * companion schema have landed; without it, the store keeps its legacy rollout gate.
 */
export interface CeremonyAdapterModule {
  LocalReleaseActivationReader?: new (checkout: string, options?: ReleaseActivationOptions) => ReleaseActivationReadPort;
  ceremonyReadiness?: CeremonyWriteReadiness;
  createCeremonyAdapters?(services: { store: PlanningStore; runtime: AgentRuntime; appDir: string }): CeremonyAdapters | Promise<CeremonyAdapters>;
}
const ceremonyModules = import.meta.glob<CeremonyAdapterModule>(["./release-activation.ts", "./retro-publication.ts"], { eager: true });
export function createPlanningStore(checkout: string, modules: Record<string, CeremonyAdapterModule> = ceremonyModules): PlanningStore {
  const readiness = Object.values(modules).flatMap((module) => module.ceremonyReadiness ? [module.ceremonyReadiness] : []);
  for (const item of readiness) assertCeremonyReady(item);
  return new PlanningStore(checkout, undefined, readiness[0]);
}
export async function createPlanningBridge(store: PlanningStore, chat: PlanningChat, runtime: AgentRuntime, modules: Record<string, CeremonyAdapterModule> = ceremonyModules): Promise<PlanningBridge> {
  const adapters: CeremonyAdapters = {};
  for (const module of Object.values(modules)) {
    let supplied = await module.createCeremonyAdapters?.({ store, runtime, appDir: defaultAppDir });
    if (!supplied?.release && module.LocalReleaseActivationReader) {
      const reader = new module.LocalReleaseActivationReader(store.checkout, { appDir: defaultAppDir, runtimeDir: store.runtimeDir });
      supplied = { ...supplied, release: { poll: async ({ goal, mergeApproval }) => {
        if (!goal.integration?.prUrl || !mergeApproval) return { status: "pending", reason: "Waiting for the recorded human integration merge approval." };
        const checks = await processShell.run("gh", ["pr", "checks", goal.integration.prUrl], store.checkout);
        if (checks.code !== 0) return { status: "pending", reason: "The integration's CI is not confirmed green." };
        const result = await reader.read(goal.integration);
        if (result.status !== "running") return { status: "pending", reason: result.reason };
        const evidence = result.evidence;
        if (evidence.buildSha !== evidence.runningSha) return { status: "pending", reason: "Wait for the application and bridge to finish reloading the same build." };
        return { status: "complete", evidence: {
          kind: "release-running", prUrl: goal.integration.prUrl, mergedSha: evidence.mergedSha,
          mergePostId: mergeApproval.postId, approval: mergeApproval.approval, checksPassed: true,
          buildSha: evidence.buildSha, runningSha: evidence.runningSha, runningAt: new Date().toISOString(),
          ...(evidence.buildSha !== evidence.mergedSha ? { ancestry: { ancestorSha: evidence.mergedSha, descendantSha: evidence.buildSha, verified: true } } : {}),
        } };
      } } };
    }
    for (const key of ["implementation", "release", "retro"] as const) if (supplied?.[key]) {
      if (adapters[key]) throw new Error(`Multiple ceremony adapters provide ${key}.`);
      Object.assign(adapters, { [key]: supplied[key] });
    }
  }
  return new PlanningBridge(store, chat, runtime, 20, processShell, adapters);
}

export const SERVER = MATTERMOST_SERVER;
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
 * Reads a process's bot token with the owner's OP_SERVICE_ACCOUNT_TOKEN or else the staged service account token, if any.
 * A hosted process (one with a ready nonce) never falls back to a desktop prompt; when its token is missing,
 * it tells the tmux host "no credential" before failing.
 */
export async function hostedToken(checkout: string, readyNonce: string | undefined, read: (options: BotTokenOptions) => Promise<string>, lingerMs = 5000): Promise<string> {
  try { return await read({ ...await opCredential(checkout), headless: !!readyNonce }); }
  catch (error) {
    if (readyNonce) {
      await signalReady(checkout, readyNonce, "no-credential").catch(() => {});
      // Stay alive briefly so the host sees the signal from a verified pane rather than a vanished one.
      await new Promise((done) => setTimeout(done, lingerMs));
    }
    throw error;
  }
}

/**
 * Before a process's first post: makes sure its bot is in its team's Mattermost team and home channel from state
 * (nothing to do while state has no home). A hosted process whose join is refused tells the tmux host "no channel",
 * with the message naming the bot and channel, and then fails; it is not restarted in a loop.
 */
export async function joinTeamHome(checkout: string, readyNonce: string | undefined, store: PlanningStore, chat: Pick<MattermostPlanningChat, "ensureHomeMembership">, username: string, lingerMs = 5000): Promise<void> {
  const home = botTeamHome(await store.read(), username);
  if (!home) return;
  try { await chat.ensureHomeMembership(home.teamId, home.channelId); }
  catch (error) {
    if (readyNonce && error instanceof MattermostAccessError) {
      await signalReady(checkout, readyNonce, "no-channel", error.message).catch(() => {});
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

/** Planning actions on one existing goal, each taking `--goal GOAL_ID`. */
const GOAL_ACTIONS = ["approve", "propose", "integrate", "merge", "rollback"] as const;
type GoalAction = typeof GOAL_ACTIONS[number];
const isGoalAction = (action: string | undefined): action is GoalAction => (GOAL_ACTIONS as readonly (string | undefined)[]).includes(action);

/** All model and posting paths use the seat from state, local engine selection and optional Indra profiles. */
async function seatServices(store: PlanningStore, username: string, seatId?: string) {
  const state = await store.read();
  const teams = state.teams as { slug: string; seats: { id: string; roles?: string[]; externalIdentities: { mattermost: { username: string } } }[] }[];
  const seats = teams.flatMap((team) => team.seats);
  const candidates = seatId === undefined ? teams.find((team) => team.slug === "yahaha")?.seats ?? [] : seats.filter((item) => item.id === seatId);
  const seat = candidates.find((item) => item.externalIdentities.mattermost.username === username);
  if (!seat) throw new StateDataError("The bot's seat is not present in state.");
  const [engines, profiles] = await Promise.all([loadSeatEngines(store.runtimeDir, seats.map((item) => item.id)), loadSeatPersonas(import.meta.url)])
    .catch((error: Error) => { throw new StateDataError(error.message); });
  const profile = Object.hasOwn(profiles, seat.id) ? profiles[seat.id] : undefined;
  const engine = Object.hasOwn(engines, seat.id) ? engines[seat.id] : "codex";
  return {
    chat: (token: string) => withPersonaChat(new MattermostPlanningChat(token, username), profile),
    runtime: (cwd: string, timeoutMs?: number, write?: WriteAccess) => withPersonaRuntime(new SeatRuntime(engine, cwd, timeoutMs, write, undefined, seatHarnessDir(store.runtimeDir, seat.id), seat.roles), profile),
  };
}

type Options = { mode: "help" } | { mode: "seat"; seatId: string; checkout: string; readyNonce?: string } | { mode: "state"; checkout: string; once: boolean } | { mode: "ui"; checkout: string } | { mode: "mattermost"; slug: string } | { mode: "mattermost"; checkout: string; once: boolean } | { mode: "planning"; action: "start" | "serve" | "host" | "status" | GoalAction; checkout: string; goal?: string; participants: string[]; readyNonce?: string };

const usage = "Usage: npm start -- [--state PATH] [--once] | --ui [--state PATH] | --mattermost [--state PATH] [--once] | --mattermost --team SLUG | planning start --goal TEXT [--participant SEAT_ID] [--state PATH] | planning propose|approve|integrate|merge|rollback --goal GOAL_ID [--state PATH] | planning serve|host|status [--state PATH] | seat run --seat SEAT_ID [--state PATH]\nPlanning serves only Chick's Yahaha thread, in the team's home channel and project from state. Reply in the thread to clarify; react :memo: on Chick's goal post to request a draft, and :white_check_mark: on the proposal post to approve it.\nEach approved goal is a sprint on branch sprint/GOAL_ID; its seats' PRs target that branch, and one integration PR takes it into main. The ceremony is planning -> proposal -> implement -> release -> retro, followed by closure. Draft failures stay in proposal. integrate explicitly authorizes a partial release and records omitted outcomes once no seat is active. merge merges the applicable integration, revert or retro PR once its gates pass; it does not complete release. Release waits for the new build to run, and closure waits for the retro thread post and archival merge. rollback opens a PR on main reverting the merged sprint.";

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
    if (action !== "start" && action !== "serve" && action !== "host" && action !== "status" && !isGoalAction(action)) throw new StateDataError(usage);
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
    if ((action === "start" || isGoalAction(action)) !== !!goal) throw new StateDataError(usage);
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
  // OP_SERVICE_ACCOUNT_TOKEN and other OP_* variables go to `op` only; no other child process inherits them.
  captureOpEnvironment();
  try {
    const options = parseOptions(args);
    if (options.mode === "help") {
      console.log(usage);
      return 0;
    }
    if (options.mode === "seat") {
      recordRunningBuild(`${options.checkout}.runtime`, import.meta.url);
      if (options.readyNonce) useHeadedMarker(headedMarkerFile(options.checkout, options.readyNonce));
      try {
        const store = createPlanningStore(options.checkout);
        const seat = await loadDeveloperSeat(store, options.seatId);
        const services = await seatServices(store, seat.username, seat.id);
        const chat = services.chat(await hostedToken(options.checkout, options.readyNonce, (tokenOptions) => readBotToken(seat.username, tokenOptions)));
        await joinTeamHome(options.checkout, options.readyNonce, store, chat, seat.username);
        if (options.readyNonce) await signalReady(options.checkout, options.readyNonce);
        const runner = new DeveloperSeat(store, seat, chat, processShell, (cwd, write) => services.runtime(cwd, DEVELOPER_SESSION_TIMEOUT_MS, write), (line) => console.log(`[${new Date().toISOString()}] ${line}`));
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
      recordRunningBuild(`${options.checkout}.runtime`, import.meta.url);
      await syncStateSchema(options.checkout).then((result) => { if (result.outcome !== "unchanged") console.log(result.message); });
      const updater = new SelfUpdater(defaultAppDir, undefined, undefined, `${resolve(options.checkout)}.runtime`);
      const store = createPlanningStore(options.checkout);
      // After the schema sync, so the checkout's schema accepts migrated ceremonies. Conflicts also show on the team screen.
      // A merged legacy sprint whose merge commit already has the ceremony was released by it and stays open for its retro.
      const releasedWithCeremony = async (goal: { teamId: string }, sha: string) => {
        const github = teamProject(await store.read(), goal.teamId);
        return github ? await mergedWithCeremony(processShell, store.runtimeDir, github, sha) : undefined;
      };
      await store.migrateLegacyGoals(undefined, releasedWithCeremony).then((results) => {
        for (const result of results) console.log(result.status === "migrated" ? `Legacy goal ${result.goalId}: ${result.summary}.` : `Legacy goal ${result.goalId} was not migrated: ${result.reason}`);
      }, (error: unknown) => console.log(`Legacy goals were not migrated: ${error instanceof Error ? error.message : String(error)}`));
      await store.retireLegacySprints().then((removed) => { if (removed) console.log("Retired the legacy draft sprints in state.json."); },
        (error: unknown) => console.log(`Legacy draft sprints were not retired: ${error instanceof Error ? error.message : String(error)}`));
      return await runTerminalUi(new StateInventory(new LocalStateRepository(options.checkout)), new LocalSessionReader(options.checkout), {
        processes: new Supervisor(options.checkout, undefined, undefined, undefined, store, (force) => stageServiceToken(options.checkout, { force })),
        goals: new CliGoalStarter(options.checkout),
        paneTail: new TmuxPaneTail(options.checkout),
        // Watching a seat sets up keys, scrolling and the status line only on this checkout's verified sessions.
        // Driving leaves the pane's input on, only for a verified session with a headed run going.
        attach: (target, mode) => attachTmux(target, undefined, (socket, session) => verifyOwnedSession(options.checkout, socket, session), mode),
        driveCheck: async (target) => {
          const { socket, session } = parseOwnedTmuxTarget(target);
          return (await verifyOwnedSession(options.checkout, socket, session))?.headed === true;
        },
        liveUsage: new LiveUsageReader(options.checkout),
        transcript: new LocalTranscriptSource(new TranscriptLocator(options.checkout)),
        launchCheck: () => checkLaunch(options.checkout, new SystemTmux(), new TmuxHost(options.checkout).socket),
        sync: store,
        update: {
          running: await readBuildStamp(defaultAppDir),
          canReload: process.env[LAUNCHER_ENV] === "1",
          check: () => updater.check(),
          current: () => readBuildStamp(defaultAppDir),
          paused: () => updater.paused(),
          setPaused: (paused) => updater.setPaused(paused),
          rollbackPlan: () => updater.rollbackPlan(),
          rollback: () => updater.rollback(),
          rolledBack: () => updater.rolledBack(),
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
      const store = createPlanningStore(options.checkout);
      if (options.action === "propose") {
        // Run by the terminal UI: records the request for the bridge, which drafts through the 📝 path. No credential is read.
        try {
          const { goal, alreadyRequested } = await PlanningBridge.requestProposal(store, options.goal!);
          console.log(alreadyRequested ? `A proposal for goal ${goal.id} was already requested; Chick drafts it once.` : `Requested a proposal for goal ${goal.id}; Chick drafts it on the bridge's next poll and posts it in the thread.`);
          return 0;
        } catch (error) {
          console.error(`Planning error: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      const services = await seatServices(store, CHICK_USERNAME);
      if (options.action === "approve") {
        // Run by the terminal UI: like a hosted process, it reads Chick's token only with the staged service account token.
        try {
          const chat = services.chat(await readChickToken({ ...await opCredential(options.checkout), headless: true }));
          await joinTeamHome(options.checkout, undefined, store, chat, CHICK_USERNAME);
          const { goal, alreadyApproved } = await (await createPlanningBridge(store, chat, services.runtime(process.cwd()))).approve(options.goal!);
          console.log(alreadyApproved ? `Goal ${goal.id} was already approved; no new assignments.` : `Approved goal ${goal.id}: ${goal.assignments?.length ?? 0} outcome(s) queued for Developer seats.`);
          return 0;
        } catch (error) {
          console.error(`Planning error: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      if (options.action === "integrate" || options.action === "merge" || options.action === "rollback") {
        // Run by the terminal UI, like approve: Chick's token only with the staged service account token.
        try {
          const chat = services.chat(await readChickToken({ ...await opCredential(options.checkout), headless: true }));
          await joinTeamHome(options.checkout, undefined, store, chat, CHICK_USERNAME);
          const bridge = await createPlanningBridge(store, chat, services.runtime(process.cwd()));
          console.log(await (options.action === "integrate" ? bridge.integrate(options.goal!) : options.action === "merge" ? bridge.merge(options.goal!) : bridge.rollback(options.goal!)));
          return 0;
        } catch (error) {
          console.error(`Planning error: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      if (options.action === "start") {
        try {
          const chat = services.chat(await hostedToken(options.checkout, options.readyNonce, readChickToken));
          await joinTeamHome(options.checkout, undefined, store, chat, CHICK_USERNAME);
          const goal = await (await createPlanningBridge(store, chat, services.runtime(process.cwd()))).start(options.goal!, options.participants);
          console.log(`Planning goal ${goal.id}: ${SERVER}/yahaha/pl/${goal.mattermost.rootPostId}`);
          return 0;
        } catch (error) {
          console.error(`Planning error: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      recordRunningBuild(`${options.checkout}.runtime`, import.meta.url);
      if (options.readyNonce) useHeadedMarker(headedMarkerFile(options.checkout, options.readyNonce));
      const chat = services.chat(await hostedToken(options.checkout, options.readyNonce, readChickToken));
      await joinTeamHome(options.checkout, options.readyNonce, store, chat, CHICK_USERNAME);
      const bridge = await createPlanningBridge(store, chat, services.runtime(process.cwd()));
      console.log("Chick planning bridge running. Stop with Ctrl-C.");
      let ready = false;
      while (true) {
        // A poll finishes its model turns and saves pending deliveries before it releases the turn lock.
        await withFileLock(turnLockFile(options.checkout, { kind: "bridge" }), () => bridge.poll(), 24 * 60 * 60_000);
        if (!ready && options.readyNonce) {
          await signalReady(options.checkout, options.readyNonce);
          ready = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    const adapter = new MattermostInventory(new MattermostClient(SERVER, await readToken("checkout" in options ? await opCredential(options.checkout) : {})));
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
    else if (error instanceof MattermostAccessError) console.error(`Mattermost access: ${error.message}`);
    else if (error instanceof Error && error.name !== "AbortError") console.error("Connection/error: The inventory could not complete.");
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main();
}
