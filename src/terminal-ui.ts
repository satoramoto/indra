import type { StateInventory, StateSeat, StateSnapshot, StateTeam } from "./state-domain.js";
import type { AssignmentRetry, GoalStarter, SeatLive, SeatProcessPort, SprintAction } from "./supervisor.js";
import { isFinishedSprint } from "./finished-sprint.js";
import { missingTeamHome,missingTeamMessage } from "./planning.js";
import type { StateSyncResult } from "./state-commit.js";
import type { BuildStamp } from "./build-stamp.js";
import type { RollbackPlan, UpdateResult } from "./self-update.js";
import type { SessionSnapshot, SprintLoop } from "./session-snapshot.js";
import type { LiveUsage, LiveUsagePort } from "./live-usage.js";
import type { TokenUsage } from "./runtime-facts.js";
import type { WorkflowEvent } from "./goal-contract.js";
import { sumUsage } from "./hub-format.js";

/** Keeps Indra's own code current: pulls and builds new commits, and says when `dist/` holds a newer build. */
export interface UpdatePort {
  /** The build this UI process runs; undefined when `dist/` had no stamp at start. */
  running?: BuildStamp;
  /** True under the `npm start` launcher, which restarts the UI when it exits for a reload. */
  canReload: boolean;
  /** Pulls and builds unless auto-update is paused; while paused it only reports what waits on origin/main. */
  check(): Promise<UpdateResult>;
  current(): Promise<BuildStamp | undefined>;
  /** The persisted pause setting (`U`). */
  paused?(): Promise<boolean>;
  setPaused?(paused: boolean): Promise<void>;
  /** The previous build a rollback (`R`) would switch to; undefined when there is none. */
  rollbackPlan?(): Promise<RollbackPlan | undefined>;
  /** Switches `dist` back to the previous build and pauses auto-update. */
  rollback?(): Promise<{ rolledBack: boolean; message: string }>;
  /** The SHAs of the last rollback while `dist` still runs it. */
  rolledBack?(): Promise<{ sha: string; fromSha: string } | undefined>;
}
/** What a reload restores. */
export interface UiView { page: UiPage; teamId?: string; seatId?: string }

/** Structural read port. A stable seat is never treated as a running agent without a runtime session. */
export type TerminalSession = SessionSnapshot["sessions"][number];

export interface TerminalSprint { id: string; goal: string; loop: SprintLoop; planningStage?: string }

/** Use the persisted ceremony even when an older reader also supplies a legacy loop stage. */
export function sessionSprint(session: TerminalSession): TerminalSprint {
  const ceremony = session.ceremony ?? session.loop?.ceremony;
  return { id: session.id, goal: session.goal, planningStage: session.stage, loop: {
    ...session.loop, stage: ceremony?.stage ?? session.loop?.stage ?? "Goal", tickets: session.loop?.tickets ?? [],
    ...(ceremony ? { ceremony } : {}),
    closedAt: ceremony ? ceremony.closure?.closedAt : session.closedAt ?? session.loop?.closedAt,
    release: session.release ?? session.loop?.release,
    retro: session.retro ?? session.loop?.retro,
  } };
}

export interface SessionReadResult {
  connection: "connected" | "disconnected" | "error";
  sessions: TerminalSession[];
  message?: string;
}

export interface SessionReadPort {
  readSessions(): Promise<SessionReadResult>;
}

/** Syncs the state checkout with its remote; never throws for git or network problems. */
export interface StateSyncPort {
  sync(): Promise<StateSyncResult>;
}

export type UiPage = "teams" | "team" | "seat";
export type UiAction = "none" | "refresh" | "quit" | "attach" | "drive" | "stop" | "restart" | "retry" | "submit" | "approve" | "propose" | "sprint" | "pause" | "ask-rollback" | "rollback";
/** Longest goal the new-goal input accepts; a Mattermost post (~16k) holds it with room to spare. */
export const GOAL_INPUT_LIMIT = 8000;
/** The multi-line text input for a new planning goal. The channel and project come from the team in state. */
export interface UiInput { value: string }
/**
 * A goal whose proposal the owner is requesting (`P`) or approving (`A`) from the terminal, or whose sprint the owner
 * integrates (`I`) or rolls back (`V`).
 */
export interface UiApproval {
  action: "approve" | "propose" | "integrate" | "revert";
  goalId: string; goal: string;
  prUrl?: string;
  /** An approval cannot silently approve a replaced proposal. */
  updatedAt?: string;
}
/** `revert` in the UI (V) is `planning rollback`; `rollback` alone is the self-update rollback (R). */
const sprintActions: Record<string, SprintAction> = { integrate: "integrate", revert: "rollback" };
/** A rollback (`R`) from the running build's short SHA to the previous build's. */
export interface UiRollback { action: "rollback"; from: string; to: string }
export interface UiRetry extends AssignmentRetry { action: "retry" }

const shortSha = (sha?: string) => sha?.slice(0, 7) || "unknown build";

/** Remove terminal controls from state and runtime text before giving it to the renderer. */
export function displayText(value: string | undefined, limit = 400): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function currentSession(sessions: TerminalSession[]): TerminalSession | undefined {
  return [...sessions].sort((a, b) =>
    Number(b.status === "running" && !!b.sessionId) - Number(a.status === "running" && !!a.sessionId) ||
    Number(!!b.sessionId) - Number(!!a.sessionId) ||
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  )[0];
}

/** The newest planning record can differ from the session currently occupying a seat. */
export function newestPlanningRecord(sessions: TerminalSession[]): TerminalSession | undefined {
  return sessions.reduce<TerminalSession | undefined>((latest, session) =>
    !latest || (session.updatedAt ?? "") >= (latest.updatedAt ?? "") ? session : latest, undefined);
}

export class TerminalUiModel {
  page: UiPage = "teams";
  teamId?: string;
  seatId?: string;
  snapshot?: StateSnapshot;
  stateError?: string;
  sessionResult: SessionReadResult = { connection: "disconnected", sessions: [], message: "Runtime session reader has not connected." };
  refreshedAt?: string;
  notice?: string;
  /** How Indra was launched makes macOS blame ttyd or an unverified tmux server for privacy prompts (src/launch-check.ts). */
  launchWarning?: string;
  /** Returns the launch warning, if any; set by the UI runner. */
  launchCheck?: () => Promise<string | undefined>;
  revision = 0;
  /** Live process, assignment and thread activity per seat ID; empty without a process supervisor. */
  live: Record<string, SeatLive> = {};
  /** Running token totals of the headed runs still going, per seat ID of the open team; read at most every few seconds. */
  liveUsage: Record<string, LiveUsage> = {};
  /** Reads those totals; set by the UI runner. */
  liveUsagePort?: LiveUsagePort;
  input?: UiInput;
  /** Set while a y/n confirmation is open. */
  confirm?: UiApproval | UiRollback | UiRetry;
  /** A full-screen view over the page: the key help (`?`) or the selected seat's session transcript (`t`). */
  overlay?: "help" | "transcript";
  private retrying?: UiRetry;
  private retryPending = false;
  /** The approval the owner confirmed, until `approveConfirmed` runs it. */
  private approving?: UiApproval;
  /** The proposal request the owner confirmed, until `proposeConfirmed` runs it. */
  private proposing?: UiApproval;
  /** The sprint action (`I` or `V`) the owner confirmed, until `sprintConfirmed` runs it. */
  private sprinting?: UiApproval;
  private ceremonyPending = false;
  private starting = false;
  private sessionsReadable = false;
  /** Called after changes made outside a key press or refresh, so the screen redraws. */
  changed?: () => void;

  /** The last finished sync of the state checkout; undefined until the first one ends. */
  syncResult?: StateSyncResult;
  syncing = false;

  /** The last finished check of Indra's own checkout; undefined until the first one ends. */
  updateResult?: UpdateResult;
  updating = false;
  /** Auto-update is paused (`U`, or after a rollback); read from the persisted setting. */
  paused = false;
  /** Set while `dist` runs the build of the last rollback. */
  rolledBack?: { sha: string; fromSha: string };
  /** Set once `dist/` holds a different build than this UI runs; the UI reloads at its next safe point. */
  reloadWanted = false;
  /** Actions in flight (goal start, proposal request, approval, stop or restart, hosting); the UI never reloads under one. */
  private busy = 0;
  /** Settles when the update in progress (install, build, switch and restarts) ends. */
  private updateRun?: Promise<void>;
  workflowError?: string;
  workflowSuspended = false;
  private updateQueued = false;
  private eventRun?: Promise<void>;
  private pendingEvents = new Map<string, WorkflowEvent>();
  private pendingMerges = new Map<string, Extract<WorkflowEvent, { kind: "merge" }>>();

  private workflowBusy(): boolean { return this.workflowSuspended || !!this.input || !!this.confirm || this.busy > 0 || this.updating || this.syncing; }

  /** Event acknowledgements retain pending work even while input, an action or attachment owns the UI. */
  async workflowEvent(event: WorkflowEvent): Promise<void> {
    const key = event.kind === "queue-changed" ? `${event.teamId}:${event.id.split(":")[0]}` : event.kind === "startup" ? `startup:${event.teamId}` : event.id;
    this.pendingEvents.set(key, event);
    await this.flushWorkflowEvents();
  }

  async flushWorkflowEvents(): Promise<void> {
    if (this.eventRun) return this.eventRun;
    if (this.workflowBusy() || (!this.pendingEvents.size && !this.updateQueued)) return;
    this.eventRun = (async () => {
      do {
        const events = [...this.pendingEvents.values()]; this.pendingEvents.clear();
        await this.refresh();
        for (const event of events) if (event.kind === "merge" && event.laneId === null) this.pendingMerges.set(event.id, event);
        for (const [id, event] of this.pendingMerges) {
          const session = this.sessionResult.sessions.find((session) => session.teamId === event.teamId && session.id === event.goalId);
          const integration = session?.loop?.integration;
          if (!integration) continue; // A state event may arrive after the merge event.
          const release = event.prUrl === integration.prUrl && integration.status === "merged" && event.mergedSha === integration.mergedSha;
          const revert = event.prUrl === integration.revertPrUrl && integration.status === "reverted";
          if (release || revert) { this.pendingMerges.delete(id); this.updateQueued = true; }
          else if (event.prUrl !== integration.prUrl && event.prUrl !== integration.revertPrUrl) this.pendingMerges.delete(id);
        }
        // Build/running receipts only observe readiness. Calling check() here would write another receipt forever.
        await this.checkBuild();
        if (this.workflowBusy()) break;
        if (this.updateQueued) await this.updateCode();
        else if (events.length && !this.reloadWanted && !this.updateResult?.installFailed && this.processes?.upgrade) {
          await this.exclusive(async () => { await this.processes!.upgrade!(); await this.refresh(); });
        }
      } while (this.pendingEvents.size && !this.workflowBusy());
    })();
    try { await this.eventRun; } finally { this.eventRun = undefined; this.bump(); }
  }

  async settleWorkflow(): Promise<void> { await this.eventRun; await this.updateRun; }


  constructor(private readonly state: StateInventory, private readonly sessions: SessionReadPort, private readonly processes?: SeatProcessPort, private readonly goals?: GoalStarter, private readonly stateSync?: StateSyncPort, private readonly update?: UpdatePort) {}

  private bump(): void { this.revision++; this.changed?.(); }

  /**
   * Every action that spawns Indra code (s, n, P, A, hosting) goes through here. It waits while an update may be
   * changing node_modules or dist, and does not run at all after a failed dependency install.
   */
  private async tracked(work: () => Promise<void>): Promise<void> {
    while (this.updateRun) await this.updateRun;
    if (this.updateResult?.installFailed) {
      this.notice = "Not started: Indra is blocked because a dependency install failed; it retries on the next update check.";
      this.bump();
      return;
    }
    this.busy++;
    try { await work(); } finally { this.busy--; this.bump(); }
  }

  /** Syncs the state checkout first, then hosts the processes, so they start from the remote's state; then checks for new code. */
  async start(): Promise<void> {
    await this.syncState();
    await this.ensureProcesses();
    await this.checkLaunch();
    await this.updateCode();
  }

  /** Sets the launch warning after hosting, when the seats' tmux server exists; other notices never clear it. */
  async checkLaunch(): Promise<void> {
    if (!this.launchCheck) return;
    this.launchWarning = await this.launchCheck().catch(() => undefined);
    this.bump();
  }

  /**
   * Pulls and builds new Indra commits. Once this UI runs the newest build, restarts hosted processes that run an
   * older one, each at its own safe point; an older UI leaves that to the reloaded one.
   */
  async updateCode(): Promise<void> {
    const update = this.update;
    if (!update) return;
    this.updateQueued = true;
    if (this.workflowBusy()) return;
    this.updateQueued = false;
    await this.exclusive(async () => {
      try {
        await this.loadUpdateSettings();
        this.updateResult = await update.check();
        // After a failed install node_modules may be half written: no reload and no restarts until one succeeds.
        if (this.updateResult.installFailed) return;
        await this.afterSwitch();
      } catch (error) { this.updateResult = { outcome: "blocked", message: "update check failed: " + (error instanceof Error ? error.message : String(error)), at: new Date().toISOString() }; }
    });
  }

  /** Runs an update or rollback; actions that spawn Indra code wait for it (see `tracked`). */
  private async exclusive(work: () => Promise<void>): Promise<void> {
    this.updating = true;
    let release = () => {};
    this.updateRun = new Promise((done) => { release = done; });
    this.bump();
    try { await work(); }
    finally {
      this.updating = false;
      this.updateRun = undefined;
      release();
      this.bump();
    }
  }

  /** After `dist` may have changed: reload this UI, or else restart hosted processes on an older build at their safe points. */
  private async afterSwitch(): Promise<void> {
    const reloading = await this.checkBuild() && !!this.update?.canReload;
    if (!reloading && this.processes?.upgrade) {
      const { problems } = await this.processes.upgrade();
      if (problems.length) this.notice = "Could not restart after an update: " + problems.join("; ");
      await this.refresh();
    }
  }

  /** Reads the persisted pause setting and whether `dist` runs a rollback; keeps the last values when unreadable. */
  async loadUpdateSettings(): Promise<void> {
    const update = this.update;
    if (!update) return;
    if (update.paused) this.paused = await update.paused().catch(() => this.paused);
    if (update.rolledBack) this.rolledBack = await update.rolledBack().catch(() => this.rolledBack);
  }

  /** `U`: pauses or resumes auto-update. Resuming checks for new code at once. */
  async togglePause(): Promise<void> {
    const update = this.update;
    if (!update?.setPaused) { this.notice = "Auto-update cannot be paused from this screen."; this.bump(); return; }
    const paused = !this.paused;
    try {
      await update.setPaused(paused);
      this.paused = paused;
      this.notice = paused ? "Auto-update paused: Indra will not pull, build or switch builds until you press U again." : "Auto-update resumed.";
    } catch (error) { this.notice = "Could not change auto-update: " + (error instanceof Error ? error.message : String(error)); }
    this.bump();
    if (!paused && !this.paused) await this.updateCode();
  }

  /** `R`: asks y/n naming both versions, or says there is no previous build. */
  async askRollback(): Promise<void> {
    const update = this.update;
    if (!update?.rollbackPlan || !update.rollback) this.notice = "Rollback is not available from this screen.";
    else if (this.updating) this.notice = "An update is running; press R again when it ends.";
    else {
      const plan = await update.rollbackPlan().catch(() => undefined);
      if (!plan) this.notice = "No previous build to roll back to; nothing changed.";
      else if (!this.input && !this.confirm) this.confirm = { action: "rollback", from: shortSha(plan.from?.sha), to: shortSha(plan.to?.sha) };
    }
    this.bump();
  }

  /**
   * Runs the rollback the owner confirmed with y: `dist` goes back to the previous build and auto-update pauses; then,
   * as after an update, the UI reloads and hosted processes restart at their safe points.
   */
  async rollbackConfirmed(): Promise<void> {
    const update = this.update;
    if (!update?.rollback) return;
    if (this.updating || this.busy) {
      this.notice = "Not rolled back: an update or action is still running. Press R again when it finishes.";
      this.bump();
      return;
    }
    const rollback = update.rollback;
    await this.exclusive(async () => {
      this.notice = "Rolling back…";
      try {
        const result = await rollback.call(update);
        this.notice = result.message;
        if (!result.rolledBack) return;
        this.paused = true;
        await this.loadUpdateSettings();
        await this.afterSwitch();
      } catch (error) { this.notice = "Could not roll back: " + (error instanceof Error ? error.message : String(error)); }
    });
  }

  /** True once `dist/` holds a different build than this UI runs (a self-update or an `npm run dev` rebuild). */
  async checkBuild(): Promise<boolean> {
    if (!this.update || this.reloadWanted) return this.reloadWanted;
    const current = await this.update.current().catch(() => undefined);
    if (current && current.id !== this.update.running?.id) { this.reloadWanted = true; this.bump(); }
    return this.reloadWanted;
  }

  /** A reload is due and nothing is in flight: no typing, confirmation, state sync, update or action. */
  readyToReload(): boolean {
    return this.reloadWanted && !!this.update?.canReload && !this.updateResult?.installFailed && !this.input && !this.confirm && !this.syncing && !this.updating && this.busy === 0;
  }

  view(): UiView { return { page: this.page, ...(this.teamId ? { teamId: this.teamId } : {}), ...(this.seatId ? { seatId: this.seatId } : {}) }; }

  /** Restores a view saved before a reload; the next refresh drops a team or seat that no longer exists. */
  restore(view: UiView): void {
    if (!["teams", "team", "seat"].includes(view.page)) return;
    this.page = view.page;
    this.teamId = typeof view.teamId === "string" ? view.teamId : undefined;
    this.seatId = typeof view.seatId === "string" ? view.seatId : undefined;
  }

  /** One line for the screen: the running version and the update state; undefined without an updater. */
  updateLine(): { text: string; ok: boolean } | undefined {
    if (!this.update) return undefined;
    const version = "Indra " + (this.update.running?.sha.slice(0, 7) || "unknown build");
    const last = this.updateResult;
    const waiting = this.teams.flatMap((team) => team.seats).filter((seat) => this.live[seat.id]?.updatePending).map((seat) => seat.displayName);
    const rolled = this.rolledBack ? " · rolled back to " + shortSha(this.rolledBack.sha) + " from " + shortSha(this.rolledBack.fromSha) : "";
    const restarts = waiting.length ? " · " + waiting.join(", ") + " restart when idle" : "";
    if (last?.installFailed) return { text: version + " · blocked: " + last.message + " · retrying on the next check", ok: false };
    if (this.reloadWanted) return { text: version + rolled + " · update pending · " + (this.update.canReload ? "reloads when idle" : "new build ready; restart Indra to use it"), ok: true };
    if (this.paused) return { text: version + rolled + " · updates paused" + (this.updating ? " · checking…" : last?.outcome === "paused" ? " · " + last.message : "") + restarts, ok: true };
    if (this.updating) return { text: version + rolled + " · updating…", ok: true };
    if (last && (last.outcome === "blocked" || last.outcome === "failed")) return { text: version + " · blocked · " + last.message, ok: false };
    if (waiting.length) return { text: version + rolled + " · update pending" + restarts, ok: true };
    return { text: version + rolled + " · " + (last ? "up to date" : "checking for updates…"), ok: true };
  }

  /** Pulls the state checkout's remote changes and pushes Indra's; a changed state.json refreshes the screen. */
  async syncState(): Promise<void> {
    if (!this.stateSync || this.syncing) return;
    this.syncing = true;
    this.bump();
    try { this.syncResult = await this.stateSync.sync(); }
    catch (error) { this.syncResult = { outcome: "error", message: "State sync failed: " + (error instanceof Error ? error.message : String(error)), changed: false, at: new Date().toISOString() }; }
    finally { this.syncing = false; }
    if (this.syncResult.changed) await this.refresh().catch(() => false);
    this.bump();
  }

  /** One line for the screen: when the state checkout last synced and how that went; undefined without sync. */
  syncLine(): { text: string; ok: boolean } | undefined {
    if (!this.stateSync) return undefined;
    const last = this.syncResult;
    if (!last) return { text: "State sync: syncing with the remote…", ok: true };
    const ok = last.outcome === "synced" || last.outcome === "skipped";
    return { text: "State sync " + last.at.slice(11, 19) + " UTC · " + (ok ? "" : last.outcome.toUpperCase() + " · ") + last.message + (this.syncing ? " · syncing…" : ""), ok };
  }

  /** Hosts the bridge and seat runners that are not already running; problems become the notice. */
  async ensureProcesses(): Promise<void> {
    const processes = this.processes;
    if (!processes) return;
    await this.tracked(async () => {
      try {
        const problems = await processes.ensureAll();
        if (problems.length) this.notice = "Could not start: " + problems.join("; ");
      } catch (error) { this.notice = "Could not start seat processes: " + (error instanceof Error ? error.message : String(error)); }
    });
    await this.refresh();
    this.bump();
  }

  /** Stops or restarts the selected seat's hosted process. */
  async control(action: "stop" | "restart"): Promise<void> {
    const seat = this.seat;
    if (!seat || !this.processes) return;
    this.notice = (action === "stop" ? "Stopping " : "Restarting ") + seat.displayName + "…";
    this.bump();
    const processes = this.processes;
    await this.tracked(async () => {
      try {
        await processes[action](seat.id);
        this.notice = (action === "stop" ? "Stopped " : "Restarted ") + seat.displayName + ".";
      } catch (error) { this.notice = `Could not ${action} ${seat.displayName}: ` + (error instanceof Error ? error.message : String(error)); }
    });
    await this.refresh();
    this.bump();
  }

  /** Runs only the failed attempt named in the confirmation, even if selection or live state changed meanwhile. */
  async retryConfirmed(): Promise<void> {
    const target = this.retrying;
    this.retrying = undefined;
    const processes = this.processes;
    if (!target || !processes?.retry || this.retryPending) return;
    this.retryPending = true;
    this.notice = `Re-queuing ${target.goalId}/${target.outcomeId} for ${target.seatId}…`;
    this.bump();
    try {
      await this.tracked(async () => {
        try { this.notice = await processes.retry!(target); }
        catch (error) { this.notice = "Could not retry: " + (error instanceof Error ? error.message : String(error)); }
      });
      await this.refresh();
    } finally { this.retryPending = false; this.bump(); }
  }

  /** Enter in the input: start the goal in the team's home channel, for the team's project. */
  async submitInput(): Promise<void> {
    const input = this.input;
    if (!input || !this.goals || !this.teamId || this.starting) return;
    const goal = input.value.trim();
    if (!goal) return;
    const teamId = this.teamId;
    const goals = this.goals;
    this.starting = true;
    try {
      await this.tracked(async () => {
        await this.refresh();
        // Escape can cancel this input while an update or refresh is in flight.
        if (this.input !== input) return;
        const blocked = this.newGoalBlocked(true);
        if (blocked || teamId !== this.teamId) {
          this.notice = blocked ?? "The selected team changed; review the goal before starting it.";
          return;
        }
        this.input = undefined;
        this.notice = "Starting planning goal… Chick will post in the team's home channel.";
        this.bump();
        try { this.notice = await goals.start(goal); }
        catch (error) {
          this.input = input;
          this.notice = "Could not start the planning goal: " + (error instanceof Error ? error.message : String(error));
        }
        await this.refresh();
      });
    } finally { this.starting = false; this.bump(); }
  }

  /** Every goal the team list shows holds the team's lock, and only those: an integration merge alone never closes one. */
  openGoals(): TerminalSession[] {
    return this.sessionResult.sessions.filter((session) => session.teamId === this.teamId && !isFinishedSprint(sessionSprint(session).loop));
  }

  newGoalBlocked(submitting = false): string | undefined {
    if (!this.goals || !this.team) return "Planning goals cannot be started from this screen.";
    if (this.stateError || !this.sessionsReadable) return "Cannot start a planning goal: current goal state is unavailable; refresh first.";
    if (this.team.workflowModel === "goals-v1") return "Product proposes this team’s goals; approve its published proposal or reply to redirect.";
    const missing = missingTeamHome(this.team);
    if (missing.length) return "Cannot start a planning goal: " + missingTeamMessage(this.team.displayName, missing);
    const open = this.openGoals();
    if (open.length) return "New goal blocked by open goal " + open.map((session) => `${session.id} (${sessionSprint(session).loop.ceremony?.stage ?? `ceremony not recorded${session.migration ? `; legacy goal ${displayText(session.migration, 200)}` : ""}`}): ${displayText(session.goal, 80)}`).join("; ") + ". Close it after retro publication.";
    if (this.starting && !submitting) return "A planning goal is starting; wait for it to finish.";
    if (this.ceremonyPending) return "A ceremony action is in progress; wait for it to finish.";
    return undefined;
  }

  /** Only operations supported by both the durable stage and its recorded work are offered. */
  private operation(session: TerminalSession, action: UiApproval["action"]): UiApproval | undefined {
    if (!this.goals || this.stateError || !this.sessionsReadable) return undefined;
    const owner = this.teams.find((team) => team.id === session.teamId)?.seats.find((seat) => seat.id === session.seatId);
    if (!owner?.roles.includes("Team Lead")) return undefined;
    const loop = sessionSprint(session).loop;
    const stage = loop.ceremony?.stage;
    if (!stage) return undefined;
    const integration = loop.integration;
    const target: UiApproval = { action, goalId: session.id, goal: session.goal };
    // Reverting a released sprint remains possible in history, independently of closure.
    if (action === "revert") return this.goals.sprint && integration?.status === "merged" && !integration.revertPrUrl
      && (stage === "release" || stage === "retro") ? { ...target, prUrl: integration.prUrl } : undefined;
    if (loop.closedAt) return undefined;
    if (action === "propose") return (stage === "planning" || stage === "proposal") && session.stage === "clarifying" ? target : undefined;
    if (action === "approve") return stage === "proposal" && session.stage === "awaiting-review" ? { ...target, updatedAt: session.updatedAt } : undefined;
    if (!this.goals.sprint || session.stage !== "approved") return undefined;
    if (action === "integrate") return (stage === "implement" || stage === "release") && integration?.status === "collecting"
      && loop.tickets.some((ticket) => ticket.status === "merged")
      && !loop.tickets.some((ticket) => ticket.status === "building" || ticket.status === "in review") ? target : undefined;
    return undefined;
  }

  actionGoal(action: UiApproval["action"]): TerminalSession | undefined {
    return this.seat?.roles.includes("Team Lead") && !this.ceremonyPending && !this.starting
      ? newestPlanningRecord(this.sessionsFor(this.seat.id).filter((session) => this.operation(session, action))) : undefined;
  }

  reviewGoal(): TerminalSession | undefined { return this.actionGoal("approve"); }
  clarifyingGoal(): TerminalSession | undefined { return this.actionGoal("propose"); }

  ceremonyKeys(): string[] {
    if (this.page !== "seat") return [];
    const keys: string[] = [];
    for (const [action, label] of [["propose", "P propose"], ["approve", "A approve"], ["integrate", "I integrate"], ["revert", "V revert"]] as const) {
      const session = this.actionGoal(action);
      const target = session && this.operation(session, action);
      if (target) keys.push(label);
    }
    return keys;
  }

  private confirmationCurrent(target: UiApproval): boolean {
    const session = this.sessionResult.sessions.find((item) => item.id === target.goalId);
    const current = session && this.operation(session, target.action);
    return !!current && JSON.stringify(current) === JSON.stringify(target);
  }

  /** Re-read after waiting for updates; never redirect an owner's confirmation to a different PR or proposal. */
  private async runConfirmed(target: UiApproval | undefined, run: () => Promise<string>, failure: string): Promise<void> {
    if (!target || this.ceremonyPending) return;
    this.ceremonyPending = true;
    try {
      await this.tracked(async () => {
        await this.refresh();
        if (!this.confirmationCurrent(target)) {
          this.notice = `Not run: ${target.action} for ${target.goalId} changed or is no longer available. Review the refreshed ceremony and confirm again.`;
          return;
        }
        this.notice = `Running ${target.action} for ${target.goalId}…`;
        this.bump();
        try { this.notice = await run(); }
        catch (error) { this.notice = failure + (error instanceof Error ? error.message : String(error)); }
        await this.refresh();
      });
    } finally { this.ceremonyPending = false; this.bump(); }
  }

  async proposeConfirmed(): Promise<void> {
    const target = this.proposing; this.proposing = undefined;
    if (target && this.goals) await this.runConfirmed(target, () => this.goals!.propose(target.goalId), `Could not request a proposal for ${target.goalId}: `);
  }

  async sprintConfirmed(): Promise<void> {
    const target = this.sprinting; this.sprinting = undefined;
    const action = target && sprintActions[target.action];
    if (target && action && this.goals?.sprint) await this.runConfirmed(target, () => this.goals!.sprint!(action, target.goalId), `Could not ${action} sprint ${target.goalId}: `);
  }

  async approveConfirmed(): Promise<void> {
    const target = this.approving; this.approving = undefined;
    if (target && this.goals) await this.runConfirmed(target, () => this.goals!.approve(target.goalId), `Could not approve ${target.goalId}: `);
  }

  get teams(): StateTeam[] { return this.snapshot?.teams ?? []; }
  get team(): StateTeam | undefined { return this.teams.find((team) => team.id === this.teamId); }
  get seat(): StateSeat | undefined { return this.team?.seats.find((seat) => seat.id === this.seatId); }

  sessionsFor(seatId: string): TerminalSession[] {
    return this.sessionResult.sessions.filter((session) => session.teamId === this.teamId && (session.seatId === seatId || session.goalOwnerSeatId === seatId));
  }

  /** Team history includes every planning sprint, independent of which seat currently holds work. */
  sprintsForTeam(): TerminalSprint[] {
    const sessions = this.sessionResult.sessions.filter((session) => session.teamId === this.teamId);
    // Finished sprints leave the list.
    return sessions.map(sessionSprint).filter((sprint) => !isFinishedSprint(sprint.loop));
  }

  selectedSession(): TerminalSession | undefined { return currentSession(this.seat ? this.sessionsFor(this.seat.id) : []); }
  attachTarget(): string | undefined {
    const bridge = this.seat?.roles.includes("Team Lead") && this.sessionResult.connection === "connected" ? this.selectedSession()?.attach : undefined;
    // A Developer seat's runner has its own verified tmux session.
    const attach = bridge ?? (this.seat ? this.live[this.seat.id]?.attach : undefined);
    return attach?.kind === "tmux" ? attach.target : undefined;
  }

  async refresh(): Promise<boolean> {
    const previous = JSON.stringify([this.snapshot, this.stateError, this.sessionResult, this.live]);
    const previousState = JSON.stringify(this.snapshot);
    const [state, sessions, live] = await Promise.allSettled([this.state.current(), this.sessions.readSessions(), this.processes ? this.processes.read() : Promise.resolve({})]);
    // A failed process read keeps the last known values rather than inventing "stopped".
    if (live.status === "fulfilled") this.live = live.value;
    if (state.status === "fulfilled") {
      this.snapshot = state.value;
      this.stateError = undefined;
      if (!this.refreshedAt || previousState !== JSON.stringify(state.value)) this.refreshedAt = new Date().toISOString();
      if (!this.teamId || !this.teams.some((team) => team.id === this.teamId)) {
        this.teamId = this.teams[0]?.id;
        this.seatId = undefined;
        this.page = this.teams.length === 1 ? "team" : "teams";
      }
      if (!this.seatId || !this.team?.seats.some((seat) => seat.id === this.seatId)) {
        this.seatId = this.team?.seats[0]?.id;
        if (this.page === "seat" && !this.seatId) this.page = "team";
      }
    } else {
      this.stateError = state.reason instanceof Error ? state.reason.message : "State could not be read.";
    }
    this.sessionsReadable = sessions.status === "fulfilled";
    if (sessions.status === "fulfilled") this.sessionResult = sessions.value;
    else this.sessionResult = { connection: "error", sessions: [], message: sessions.reason instanceof Error ? sessions.reason.message : "Session reader failed." };
    let staleConfirmation = false;
    if (this.confirm && this.confirm.action !== "retry" && this.confirm.action !== "rollback" && !this.confirmationCurrent(this.confirm)) {
      this.notice = `Confirmation for ${this.confirm.goalId} expired: its operation changed or is unavailable. Review the refreshed ceremony and confirm again.`;
      this.confirm = undefined;
      staleConfirmation = true;
    }
    const liveChanged = await this.readLiveUsage();
    const changed = staleConfirmation || liveChanged || previous !== JSON.stringify([this.snapshot, this.stateError, this.sessionResult, this.live]);
    if (changed) this.revision++;
    return changed;
  }

  /**
   * A seat's recorded usage plus its headed run's live totals, unless that session is already recorded (a live total
   * read just before the run finished must not count twice). Undefined `recorded` with no live run stays undefined.
   */
  withLiveUsage(seatId: string, recorded: TokenUsage | undefined, recordedIds: (string | undefined)[]): TokenUsage | undefined {
    const live = this.liveUsage[seatId];
    if (!live || (live.sessionId && recordedIds.includes(live.sessionId))) return recorded;
    return sumUsage([recorded, live.usage]);
  }

  /** Reads the open team's live token totals (the port throttles each seat); true when any changed. */
  private async readLiveUsage(): Promise<boolean> {
    const port = this.liveUsagePort;
    if (!port) return false;
    const next: Record<string, LiveUsage> = {};
    await Promise.all((this.team?.seats ?? []).map(async (seat) => {
      const hosted = seat.roles.includes("Team Lead") ? { kind: "bridge" as const } : seat.roles.some((role) => role === "Developer" || role === "Product") ? { kind: "seat" as const, seatId: seat.id } : undefined;
      const found = hosted ? await port.read(hosted).catch(() => undefined) : undefined;
      if (found) next[seat.id] = found;
    }));
    if (JSON.stringify(next) === JSON.stringify(this.liveUsage)) return false;
    this.liveUsage = next;
    return true;
  }

  /** `text` is the key's raw character, used only while the text input is open. */
  key(value: string, text?: string): UiAction {
    if (this.input) {
      const name = value.toLowerCase();
      if (name === "escape") this.input = undefined;
      else if (name === "return" || name === "enter") { if (this.input.value.trim()) return "submit"; }
      else if (name === "backspace") this.input.value = this.input.value.slice(0, -1);
      else if (text && !/^\u001b/.test(text)) {
        // Printable characters only (a paste may arrive as one multi-character sequence); anything past the limit is dropped.
        const printable = text.replace(/[\r\n\t]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        this.input.value = (this.input.value + printable).slice(0, GOAL_INPUT_LIMIT);
      }
      this.revision++;
      return "none";
    }
    if (this.confirm) {
      const target = this.confirm;
      this.confirm = undefined;
      this.revision++;
      if ((text ?? value).toLowerCase() === "y") {
        if (target.action === "retry") { this.retrying = target; return "retry"; }
        if (target.action === "rollback") return "rollback";
        if (target.action === "propose") { this.proposing = target; return "propose"; }
        if (target.action === "approve") { this.approving = target; return "approve"; }
        this.sprinting = target;
        return "sprint";
      }
      this.notice = (target.action === "retry" ? "Retry" : target.action === "rollback" ? "Rollback" : target.action === "propose" ? "Proposal request" : target.action === "approve" ? "Approval" : "Sprint " + target.action) + " cancelled; nothing changed.";
      return "none";
    }
    if (this.overlay) {
      // Esc or q returns; the overlay handles its own scrolling keys.
      const name = value.toLowerCase();
      if (name === "escape" || name === "q" || (this.overlay === "help" && text === "?")) { this.overlay = undefined; this.revision++; }
      return "none";
    }
    this.notice = undefined;
    const input = value.toLowerCase();
    if (text === "?") { this.overlay = "help"; this.revision++; return "none"; }
    if (text === "t" || (text === undefined && value === "t")) {
      if (this.page !== "seat" || !this.seat) this.notice = "Open a seat first to read its session transcript.";
      else this.overlay = "transcript";
      this.revision++;
      return "none";
    }
    if (input === "q") return "quit";
    if (text === "U") return "pause";
    if (text === "R") return "ask-rollback";
    if (input === "r") {
      // A manual one-off check; while paused it only looks at origin/main.
      if (this.paused) this.notice = "Updates are paused: checking origin/main only, nothing is pulled or built. U resumes.";
      this.revision++;
      return "refresh";
    }
    if (text === "T") {
      const seat = this.seat;
      const target = seat && this.live[seat.id]?.retry;
      if (this.page === "teams" || !seat?.roles.includes("Developer")) this.notice = "Choose a Developer seat to retry a failed assignment.";
      else if (!this.processes?.retry) this.notice = "Assignments cannot be retried from this screen.";
      else if (this.retrying || this.retryPending) this.notice = "A retry is already in progress.";
      else if (!target) this.notice = "No eligible failed assignment for this seat.";
      else this.confirm = { ...target, action: "retry" };
    } else if (text === "A") {
      const target = this.reviewGoal();
      if (this.page !== "seat" || !this.seat?.roles.includes("Team Lead")) this.notice = "Open Chick's seat to approve a proposal.";
      else if (!this.goals) this.notice = "Proposals cannot be approved from this screen.";
      else if (!target) this.notice = "No proposal is awaiting review for this seat.";
      else this.confirm = this.operation(target, "approve");
    } else if (text === "P") {
      const target = this.clarifyingGoal();
      if (this.page !== "seat" || !this.seat?.roles.includes("Team Lead")) this.notice = "Open Chick's seat to request a proposal.";
      else if (!this.goals) this.notice = "Proposals cannot be requested from this screen.";
      else if (!target) this.notice = "No goal is being clarified for this seat.";
      else this.confirm = this.operation(target, "propose");
    } else if (text === "I" || text === "V") {
      const action = text === "I" ? "integrate" : "revert";
      const target = this.actionGoal(action);
      if (this.page !== "seat" || !this.seat?.roles.includes("Team Lead")) this.notice = "Open Chick's seat to " + action + " a sprint.";
      else if (!this.goals?.sprint) this.notice = "Sprints cannot be managed from this screen.";
      else if (!target) this.notice = text === "I" ? "Integration unavailable: a sprint needs merged work and no outcome building or in review." : "No merged sprint to roll back for this seat.";
      else this.confirm = this.operation(target, action);
    } else if (input === "n") {
      const blocked = this.newGoalBlocked();
      if (blocked) this.notice = blocked;
      else this.input = { value: "" };
    } else if (input === "s" || input === "x") {
      if (this.page === "teams" || !this.seat) this.notice = "Choose a seat first.";
      else if (!this.processes) this.notice = "Seat processes are not managed from this screen.";
      else { this.revision++; return input === "s" ? "restart" : "stop"; }
    } else if (input === "b" || input === "left" || input === "escape") {
      if (this.page === "seat") this.page = "team";
      else if (this.page === "team") this.page = "teams";
    } else if (["up", "k", "down", "j"].includes(input)) {
      const direction = input === "up" || input === "k" ? -1 : 1;
      if (this.page === "teams") {
        const index = this.teams.findIndex((team) => team.id === this.teamId);
        const next = this.teams[Math.max(0, Math.min(this.teams.length - 1, index + direction))];
        if (next) { this.teamId = next.id; this.seatId = next.seats[0]?.id; }
      } else if (this.page === "team") {
        const seats = this.team?.seats ?? [];
        const index = seats.findIndex((seat) => seat.id === this.seatId);
        this.seatId = seats[Math.max(0, Math.min(seats.length - 1, index + direction))]?.id;
      }
    } else if (input === "enter" || input === "return" || input === "right") {
      if (this.page === "teams" && this.team) this.page = "team";
      else if (this.page === "team" && this.seat) this.page = "seat";
    } else if (text === "D" || (text === undefined && value === "D")) {
      if (this.page !== "seat") this.notice = "Open a seat first to drive its live session.";
      else if (!this.attachTarget()) this.notice = "No live session to drive for this seat; its process is not running under Indra.";
      else return "drive";
    } else if (input === "a") {
      if (this.page !== "seat") this.notice = "Open a seat first to watch its live process.";
      else if (!this.attachTarget()) this.notice = "No live view is available for this seat; its process is not running under Indra.";
      else return "attach";
    }
    this.revision++;
    return "none";
  }
}

export type WorkflowEventSource = (onEvent: (event: WorkflowEvent) => Promise<void>, signal: AbortSignal) => Promise<void>;

/** Owns the host lifetime separately from finite UI turns. The source is subscribed before startup reconciliation. */
export class TerminalUiWorkflow {
  private readonly controller = new AbortController();
  private sourceRun?: Promise<void>;
  private startRun?: Promise<void>;
  private ready = false;
  private active = true;
  private attached = false;
  constructor(private readonly model: TerminalUiModel, private readonly source?: WorkflowEventSource, private readonly idle: () => void = () => {}) { model.workflowSuspended = true; }
  start(): Promise<void> {
    if (this.startRun) return this.startRun;
    this.startRun = (async () => {
      if (this.source) this.sourceRun = Promise.resolve().then(() => this.source!((event) => this.model.workflowEvent(event), this.controller.signal)).then(() => {
        if (!this.controller.signal.aborted) throw new Error("Event host stopped.");
      }).catch(() => {
        if (!this.controller.signal.aborted) {
          this.controller.abort();
          this.model.workflowError = "Workflow event host failed; restart Indra to reconcile retained events.";
          this.model.revision++; this.model.changed?.();
        }
      });
      await this.model.start();
      this.ready = true;
      await this.wake();
    })();
    return this.startRun;
  }
  async setAttached(attached: boolean): Promise<void> { this.attached = attached; await this.wake(); }
  async wake(): Promise<void> {
    this.model.workflowSuspended = !this.active || !this.ready || this.attached;
    if (this.model.workflowSuspended) return;
    await this.model.flushWorkflowEvents();
    if (this.active && !this.attached && this.model.readyToReload()) this.idle();
  }
  async stop(): Promise<void> {
    this.active = false; this.model.workflowSuspended = true; this.controller.abort();
    await Promise.allSettled([this.sourceRun, this.startRun, this.model.settleWorkflow()]);
  }
}
