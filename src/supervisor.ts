import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { PlanningStore, type PlanningDocument } from "./planning.js";
import { defaultAppDir, NoChannelError, NoCredentialError, SystemTmux, TmuxHost, turnLockFile, type HostRecord, type TmuxRunner } from "./tmux-host.js";
import { readBuildStamp } from "./build-stamp.js";
import { withFileLock } from "./state-commit.js";

/** `no channel`: the seat's bot could not join its team's Mattermost team or home channel. */
export type ProcessState = "running" | "stopped" | "no credential" | "no channel";
/** What the team view shows for a seat beyond its stable state record. */
export interface SeatLive {
  process: ProcessState;
  /** Why the process is not running, in its own words, e.g. which bot cannot join which channel. */
  problem?: string;
  /** Running an older build than `dist/`; it is restarted at its next safe point. */
  updatePending?: boolean;
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
  /** Restarts processes running an older build, each only at a safe point; see Supervisor.upgrade. */
  upgrade?(): Promise<{ pending: string[]; problems: string[] }>;
}
export interface GoalStarter {
  /** Starts a planning goal in the team's home channel, for the team's project, and returns a one-line result for the screen. */
  start(goal: string): Promise<string>;
  /** Approves a goal's proposal as the owner and returns a one-line result for the screen. */
  approve(goalId: string): Promise<string>;
  /** Requests Chick's proposal for a clarifying goal as the owner and returns a one-line result for the screen. */
  propose(goalId: string): Promise<string>;
  /** The owner's sprint actions on an approved goal: open its integration PR, merge its open integration or revert PR, or roll it back. */
  sprint?(action: SprintAction, goalId: string): Promise<string>;
}
export type SprintAction = "integrate" | "merge" | "rollback";

/** Newest progress post a Developer seat made in its goal thread; kept in `<state-checkout>.runtime`. */
export const activityRecordName = (seatId: string) => `activity-${seatId}`;

/** A hosted process that exited for a missing credential or an unjoinable home channel; the seat shows why, so it is not a notice. */
const shownOnSeat = (error: unknown) => error instanceof NoCredentialError || error instanceof NoChannelError;

type SeatRow = { id: string; roles: string[] };
const ACTIVE = ["running", "in-review"];

function seatsOf(state: PlanningDocument): SeatRow[] {
  return (state.teams as { seats: SeatRow[] }[]).flatMap((team) => team.seats);
}

/** True when the seat holds a running or in-review assignment on an approved goal. */
function holdsWork(state: PlanningDocument, seatId: string): boolean {
  return (state.planningGoals ?? []).some((goal) => goal.stage === "approved" && (goal.assignments ?? []).some((item) => item.seatId === seatId && ACTIVE.includes(item.status)));
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
        if (!shownOnSeat(error)) problems.push(`${seat.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems;
  }

  async processState(host: TmuxHost): Promise<{ process: ProcessState; problem?: string; target?: string; record?: HostRecord }> {
    const verified = await host.verifiedRecord().catch(() => undefined);
    if (verified) return { process: "running", target: host.attachTarget(verified), record: verified };
    const record = await host.readRecord().catch(() => undefined);
    const ready = record && record.session === host.session ? await host.readyState(record).catch(() => undefined) : undefined;
    if (ready?.readiness === "no-credential") return { process: "no credential" };
    if (ready?.readiness === "no-channel") return { process: "no channel", ...(ready.message ? { problem: ready.message } : {}) };
    return { process: "stopped" };
  }

  async read(): Promise<Record<string, SeatLive>> {
    const state = await this.store.read();
    const live: Record<string, SeatLive> = {};
    const stamp = await readBuildStamp(this.appDir);
    for (const seat of seatsOf(state)) {
      const { process, problem, target, record } = await this.processState(this.host(seat));
      const held = (state.planningGoals ?? []).filter((goal) => goal.stage === "approved").flatMap((goal) => (goal.assignments ?? []).filter((item) => item.seatId === seat.id).map((assignment) => ({ goal, assignment })));
      const current = held.find((item) => ACTIVE.includes(item.assignment.status))
        ?? held.filter((item) => item.assignment.status === "queued").sort((a, b) => a.assignment.updatedAt.localeCompare(b.assignment.updatedAt))[0];
      const activity = await this.store.readRuntimeFile<{ message?: unknown; at?: unknown }>(activityRecordName(seat.id)).catch(() => undefined);
      live[seat.id] = {
        process,
        ...(problem ? { problem } : {}),
        ...(record && stamp && record.build !== stamp.id ? { updatePending: true } : {}),
        ...(current ? { assignment: { title: current.goal.proposal?.outcomes.find((item) => item.id === current.assignment.outcomeId)?.title ?? current.assignment.outcomeId, status: current.assignment.status, prUrl: current.assignment.prUrl } } : {}),
        ...(typeof activity?.message === "string" && typeof activity.at === "string" ? { activity: { message: activity.message, at: activity.at } } : {}),
        ...(target ? { attach: { kind: "tmux" as const, target } } : {}),
      };
    }
    return live;
  }

  /**
   * Restarts each verified hosted process whose build is older than `dist/`, only at a safe point: the supervisor
   * takes the process's turn lock (so no bridge poll or seat step is in flight), and a seat runner must also hold
   * no running or in-review assignment. A process that is busy stays up and is named in `pending`; the next call
   * tries again. Only this checkout's own verified sessions are stopped, through TmuxHost.
   */
  async upgrade(): Promise<{ pending: string[]; problems: string[] }> {
    const stamp = await readBuildStamp(this.appDir);
    const pending: string[] = [];
    const problems: string[] = [];
    if (!stamp) return { pending, problems };
    const seen = new Set<string>();
    for (const seat of seatsOf(await this.store.read())) {
      const host = this.host(seat);
      if (seen.has(host.session)) continue;
      seen.add(host.session);
      const record = await host.verifiedRecord().catch(() => undefined);
      if (!record || record.build === stamp.id) continue;
      const label = host.hosted.kind === "bridge" ? "bridge" : seat.id;
      let stopped = false as boolean;
      try {
        await withFileLock(turnLockFile(this.checkout, host.hosted), async () => {
          // Read under the lock: a seat runner claims work only while it holds this lock.
          if (host.hosted.kind === "seat" && holdsWork(await this.store.read(), seat.id)) return;
          stopped = await host.stop();
        }, 1000);
      } catch { /* The turn lock is held: a poll or step is in flight. */ }
      if (!stopped) { pending.push(label); continue; }
      try { await host.start(); }
      catch (error) { if (!shownOnSeat(error)) problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { pending, problems };
  }

  async stop(seatId: string): Promise<void> {
    await this.host(await this.seat(seatId)).stop();
  }

  async restart(seatId: string): Promise<void> {
    const host = this.host(await this.seat(seatId));
    const credentialProblem = await this.credential();
    await host.stop();
    try { await host.start(); }
    catch (error) { if (!shownOnSeat(error)) throw error; }
    if (credentialProblem) throw new Error(credentialProblem);
  }
}

/**
 * Starts planning goals, requests their proposals and approves them through the built CLI, so Chick's credential never enters the terminal UI process.
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

  async propose(goalId: string): Promise<string> {
    return await this.run(["planning", "propose", "--state", resolve(this.checkout), "--goal", goalId], 5 * 60_000) || `Requested a proposal for goal ${goalId}.`;
  }

  async sprint(action: SprintAction, goalId: string): Promise<string> {
    // A rollback may clone the project first.
    return await this.run(["planning", action, "--state", resolve(this.checkout), "--goal", goalId], action === "rollback" ? 30 * 60_000 : 5 * 60_000) || `Ran planning ${action} for goal ${goalId}.`;
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
