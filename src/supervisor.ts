import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { PlanningStore, type PlanningDocument } from "./planning.js";
import { defaultAppDir, NoCredentialError, SystemTmux, TmuxHost, type TmuxRunner } from "./tmux-host.js";

export type ProcessState = "running" | "stopped" | "no credential";
/** What the team view shows for a seat beyond its stable state record. */
export interface SeatLive {
  process: ProcessState;
  assignment?: { title: string; status: string; prUrl?: string };
  activity?: { message: string; at: string };
  attach?: { kind: "tmux"; target: string };
}
export interface SeatProcessPort {
  /** Hosts every missing process; returns short problems to show, never throws for one seat. */
  ensureAll(): Promise<string[]>;
  read(): Promise<Record<string, SeatLive>>;
  stop(seatId: string): Promise<void>;
  restart(seatId: string): Promise<void>;
}
export interface GoalStarter {
  /** Starts a planning goal in the team's home channel, for the team's project, and returns a one-line result for the screen. */
  start(goal: string): Promise<string>;
  /** Approves a goal's proposal as the owner and returns a one-line result for the screen. */
  approve(goalId: string): Promise<string>;
}

/** Newest progress post a Developer seat made in its goal thread; kept in `<state-checkout>.runtime`. */
export const activityRecordName = (seatId: string) => `activity-${seatId}`;

type SeatRow = { id: string; roles: string[] };
const ACTIVE = ["running", "in-review"];

function seatsOf(state: PlanningDocument): SeatRow[] {
  return (state.teams as { seats: SeatRow[] }[]).flatMap((team) => team.seats);
}

/**
 * Keeps Chick's planning bridge (for Team Lead seats) and one runner per Developer seat hosted in Indra-owned tmux sessions.
 * Every action goes through TmuxHost, which only reuses or stops a session it owns and has verified.
 */
export class Supervisor implements SeatProcessPort {
  constructor(
    private readonly checkout: string,
    private readonly runner: TmuxRunner = new SystemTmux(),
    private readonly appDir = defaultAppDir,
    private readonly readinessTimeoutMs = 15_000,
    private readonly store = new PlanningStore(checkout),
    /** Hands the 1Password service account token to hosted processes; runs once, before the first process starts. */
    private readonly stageCredential?: () => Promise<void>,
  ) {}

  private staged = false;

  /** Stages the credential until it succeeds once; a failure is reported and the processes show "no credential". */
  private async credential(): Promise<string | undefined> {
    if (this.staged || !this.stageCredential) return undefined;
    try { await this.stageCredential(); this.staged = true; return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  private host(seat: SeatRow): TmuxHost {
    const hosted = seat.roles.includes("Team Lead") ? { kind: "bridge" as const } : { kind: "seat" as const, seatId: seat.id };
    return new TmuxHost(this.checkout, this.runner, this.appDir, this.readinessTimeoutMs, hosted);
  }

  private async seat(seatId: string): Promise<SeatRow> {
    const seat = seatsOf(await this.store.read()).find((item) => item.id === seatId);
    if (!seat) throw new Error(`Seat '${seatId}' is not in state.`);
    return seat;
  }

  async ensureAll(): Promise<string[]> {
    const problems: string[] = [];
    const credentialProblem = await this.credential();
    if (credentialProblem) problems.push(credentialProblem);
    const started = new Set<string>();
    // Sequential: tmux starts one owned server for the socket, and each host waits for its own readiness.
    for (const seat of seatsOf(await this.store.read())) {
      const host = this.host(seat);
      if (started.has(host.session)) continue;
      started.add(host.session);
      try { await host.start(); }
      catch (error) {
        if (!(error instanceof NoCredentialError)) problems.push(`${seat.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems;
  }

  async processState(host: TmuxHost): Promise<{ process: ProcessState; target?: string }> {
    const verified = await host.verifiedRecord().catch(() => undefined);
    if (verified) return { process: "running", target: host.attachTarget(verified) };
    const record = await host.readRecord().catch(() => undefined);
    if (record && record.session === host.session && await host.readiness(record).catch(() => undefined) === "no-credential") return { process: "no credential" };
    return { process: "stopped" };
  }

  async read(): Promise<Record<string, SeatLive>> {
    const state = await this.store.read();
    const live: Record<string, SeatLive> = {};
    for (const seat of seatsOf(state)) {
      const { process, target } = await this.processState(this.host(seat));
      const held = (state.planningGoals ?? []).filter((goal) => goal.stage === "approved").flatMap((goal) => (goal.assignments ?? []).filter((item) => item.seatId === seat.id).map((assignment) => ({ goal, assignment })));
      const current = held.find((item) => ACTIVE.includes(item.assignment.status))
        ?? held.filter((item) => item.assignment.status === "queued").sort((a, b) => a.assignment.updatedAt.localeCompare(b.assignment.updatedAt))[0];
      const activity = await this.store.readRuntimeFile<{ message?: unknown; at?: unknown }>(activityRecordName(seat.id)).catch(() => undefined);
      live[seat.id] = {
        process,
        ...(current ? { assignment: { title: current.goal.proposal?.outcomes.find((item) => item.id === current.assignment.outcomeId)?.title ?? current.assignment.outcomeId, status: current.assignment.status, prUrl: current.assignment.prUrl } } : {}),
        ...(typeof activity?.message === "string" && typeof activity.at === "string" ? { activity: { message: activity.message, at: activity.at } } : {}),
        ...(target ? { attach: { kind: "tmux" as const, target } } : {}),
      };
    }
    return live;
  }

  async stop(seatId: string): Promise<void> {
    await this.host(await this.seat(seatId)).stop();
  }

  async restart(seatId: string): Promise<void> {
    const host = this.host(await this.seat(seatId));
    const credentialProblem = await this.credential();
    await host.stop();
    try { await host.start(); }
    catch (error) { if (!(error instanceof NoCredentialError)) throw error; }
    if (credentialProblem) throw new Error(credentialProblem);
  }
}

/**
 * Starts and approves planning goals through the built CLI, so Chick's credential never enters the terminal UI process.
 * `run` executes one CLI invocation; tests replace it.
 */
export class CliGoalStarter implements GoalStarter {
  constructor(
    private readonly checkout: string,
    private readonly appDir = defaultAppDir,
    private readonly run: (args: string[], timeoutMs: number) => Promise<string> = (args, timeoutMs) => runCli(appDir, args, timeoutMs),
  ) {}

  async start(goal: string): Promise<string> {
    return await this.run(["planning", "start", "--state", resolve(this.checkout), "--goal", goal], 30 * 60_000) || "Planning goal started.";
  }

  async approve(goalId: string): Promise<string> {
    return await this.run(["planning", "approve", "--state", resolve(this.checkout), "--goal", goalId], 5 * 60_000) || `Approved goal ${goalId}.`;
  }
}

/** Runs `dist/cli.js` and resolves with its last stdout line; rejects with its last stderr line. */
function runCli(appDir: string, cliArgs: string[], timeoutMs: number): Promise<string> {
  const args = ["--experimental-ffi", "--use-system-ca", join(appDir, "dist", "cli.js"), ...cliArgs];
  return new Promise((done, fail) => {
    execFile(process.execPath, args, { cwd: appDir, encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
      const last = (text: string) => text.trim().split("\n").at(-1) ?? "";
      if (error) fail(new Error(last(stderr) || `planning ${cliArgs[1]} failed.`));
      else done(last(stdout));
    });
  });
}
