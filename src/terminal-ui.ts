import type { StateInventory, StateSeat, StateSnapshot, StateTeam } from "./state-domain.js";
import type { GoalStarter, SeatLive, SeatProcessPort } from "./supervisor.js";

/** Structural read port. A stable seat is never treated as a running agent without a runtime session. */
export interface TerminalSession {
  id: string;
  teamId: string;
  seatId: string;
  status: "idle" | "running" | "error";
  engine: "codex";
  goal: string;
  stage: string;
  updatedAt?: string;
  recentActivity: string[];
  sessionId?: string;
  attach?: { kind: "tmux"; target: string };
}

export interface SessionReadResult {
  connection: "connected" | "disconnected" | "error";
  sessions: TerminalSession[];
  message?: string;
}

export interface SessionReadPort {
  readSessions(): Promise<SessionReadResult>;
}

export type UiPage = "teams" | "team" | "seat";
export type UiAction = "none" | "refresh" | "quit" | "attach" | "stop" | "restart" | "submit";
/** The one-line text input: a new planning goal, then (once per UI session) a channel ID. */
export interface UiInput { kind: "goal" | "channel"; value: string; goal?: string }

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
  revision = 0;
  /** Live process, assignment and thread activity per seat ID; empty without a process supervisor. */
  live: Record<string, SeatLive> = {};
  input?: UiInput;
  /** A channel ID typed once in this UI session, used when state has no planning channel. */
  channelId?: string;
  /** Called after changes made outside a key press or refresh, so the screen redraws. */
  changed?: () => void;

  constructor(private readonly state: StateInventory, private readonly sessions: SessionReadPort, private readonly processes?: SeatProcessPort, private readonly goals?: GoalStarter) {}

  private bump(): void { this.revision++; this.changed?.(); }

  /** Hosts the bridge and seat runners that are not already running; problems become the notice. */
  async ensureProcesses(): Promise<void> {
    if (!this.processes) return;
    try {
      const problems = await this.processes.ensureAll();
      if (problems.length) this.notice = "Could not start: " + problems.join("; ");
    } catch (error) { this.notice = "Could not start seat processes: " + (error instanceof Error ? error.message : String(error)); }
    await this.refresh();
    this.bump();
  }

  /** Stops or restarts the selected seat's hosted process. */
  async control(action: "stop" | "restart"): Promise<void> {
    const seat = this.seat;
    if (!seat || !this.processes) return;
    this.notice = (action === "stop" ? "Stopping " : "Restarting ") + seat.displayName + "…";
    this.bump();
    try {
      await this.processes[action](seat.id);
      this.notice = (action === "stop" ? "Stopped " : "Restarted ") + seat.displayName + ".";
    } catch (error) { this.notice = `Could not ${action} ${seat.displayName}: ` + (error instanceof Error ? error.message : String(error)); }
    await this.refresh();
    this.bump();
  }

  /** Enter in the input: start the goal, or ask for a channel first when state has none. */
  async submitInput(): Promise<void> {
    const input = this.input;
    if (!input || !this.goals || !this.teamId) return;
    const value = input.value.trim();
    if (!value) return;
    let goal = value; let channel: string | undefined;
    if (input.kind === "channel") {
      if (!/^[a-z0-9]{26}$/.test(value)) { this.notice = "A Mattermost channel ID is 26 lowercase letters and digits."; this.bump(); return; }
      goal = input.goal!; channel = this.channelId = value;
    } else {
      try { channel = this.channelId ?? await this.goals.channelFor(this.teamId); }
      catch (error) { this.notice = "Could not read the planning channel: " + (error instanceof Error ? error.message : String(error)); this.bump(); return; }
      if (!channel) { this.input = { kind: "channel", value: "", goal }; this.bump(); return; }
    }
    this.input = undefined;
    this.notice = "Starting planning goal… Chick will post in Mattermost.";
    this.bump();
    try { this.notice = await this.goals.start(goal, channel); }
    catch (error) {
      if (input.kind === "channel") this.channelId = undefined;
      this.notice = "Could not start the planning goal: " + (error instanceof Error ? error.message : String(error));
    }
    this.bump();
  }

  get teams(): StateTeam[] { return this.snapshot?.teams ?? []; }
  get team(): StateTeam | undefined { return this.teams.find((team) => team.id === this.teamId); }
  get seat(): StateSeat | undefined { return this.team?.seats.find((seat) => seat.id === this.seatId); }

  sessionsFor(seatId: string): TerminalSession[] {
    return this.sessionResult.sessions.filter((session) => session.teamId === this.teamId && session.seatId === seatId);
  }

  selectedSession(): TerminalSession | undefined { return currentSession(this.seat ? this.sessionsFor(this.seat.id) : []); }
  attachTarget(): string | undefined {
    const bridge = this.sessionResult.connection === "connected" ? this.selectedSession()?.attach : undefined;
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
    if (sessions.status === "fulfilled") this.sessionResult = sessions.value;
    else this.sessionResult = { connection: "error", sessions: [], message: sessions.reason instanceof Error ? sessions.reason.message : "Session reader failed." };
    const changed = previous !== JSON.stringify([this.snapshot, this.stateError, this.sessionResult, this.live]);
    if (changed) this.revision++;
    return changed;
  }

  /** `text` is the key's raw character, used only while the text input is open. */
  key(value: string, text?: string): UiAction {
    if (this.input) {
      const name = value.toLowerCase();
      if (name === "escape") this.input = undefined;
      else if (name === "return" || name === "enter") { if (this.input.value.trim()) return "submit"; }
      else if (name === "backspace") this.input.value = this.input.value.slice(0, -1);
      else if (text && text.length === 1 && text >= " " && text !== "\u007f" && this.input.value.length < 2000) this.input.value += text;
      this.revision++;
      return "none";
    }
    this.notice = undefined;
    const input = value.toLowerCase();
    if (input === "q") return "quit";
    if (input === "r") return "refresh";
    if (input === "n") {
      if (!this.goals || !this.teamId) this.notice = "Planning goals cannot be started from this screen.";
      else this.input = { kind: "goal", value: "" };
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
    } else if (input === "a") {
      if (this.page !== "seat") this.notice = "Open a seat first to inspect its process log.";
      else if (!this.attachTarget()) this.notice = "No verified Indra tmux target is available for this seat.";
      else return "attach";
    }
    this.revision++;
    return "none";
  }
}
