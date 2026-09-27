import type { StateInventory, StateSeat, StateSnapshot, StateTeam } from "./state-domain.js";

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
export type UiAction = "none" | "refresh" | "quit" | "attach";

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

  constructor(private readonly state: StateInventory, private readonly sessions: SessionReadPort) {}

  get teams(): StateTeam[] { return this.snapshot?.teams ?? []; }
  get team(): StateTeam | undefined { return this.teams.find((team) => team.id === this.teamId); }
  get seat(): StateSeat | undefined { return this.team?.seats.find((seat) => seat.id === this.seatId); }

  sessionsFor(seatId: string): TerminalSession[] {
    return this.sessionResult.sessions.filter((session) => session.teamId === this.teamId && session.seatId === seatId);
  }

  selectedSession(): TerminalSession | undefined { return currentSession(this.seat ? this.sessionsFor(this.seat.id) : []); }
  attachTarget(): string | undefined {
    if (this.sessionResult.connection !== "connected") return undefined;
    const attach = this.selectedSession()?.attach;
    return attach?.kind === "tmux" ? attach.target : undefined;
  }

  async refresh(): Promise<boolean> {
    const previous = JSON.stringify([this.snapshot, this.stateError, this.sessionResult]);
    const previousState = JSON.stringify(this.snapshot);
    const [state, sessions] = await Promise.allSettled([this.state.current(), this.sessions.readSessions()]);
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
    const changed = previous !== JSON.stringify([this.snapshot, this.stateError, this.sessionResult]);
    if (changed) this.revision++;
    return changed;
  }

  key(value: string): UiAction {
    this.notice = undefined;
    const input = value.toLowerCase();
    if (input === "q") return "quit";
    if (input === "r") return "refresh";
    if (input === "b" || input === "left" || input === "escape") {
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
      if (this.page !== "seat") this.notice = "Open a seat first to inspect its bridge log.";
      else if (!this.attachTarget()) this.notice = "No verified Indra tmux bridge target is available for this session.";
      else return "attach";
    }
    this.revision++;
    return "none";
  }
}
