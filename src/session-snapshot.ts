import { PlanningStore } from "./planning.js";
import { TmuxHost } from "./tmux-host.js";

export interface SessionSnapshot {
  connection: "connected" | "disconnected" | "error";
  sessions: {
    id: string; teamId: string; seatId: string; status: "idle" | "running" | "error"; engine: "codex";
    sessionId?: string; goal: string; stage: string; updatedAt?: string; recentActivity: string[];
    attach?: { kind: "tmux"; target: string };
  }[];
}
export interface SessionReadPort { readSessions(): Promise<SessionSnapshot> }

export class LocalSessionReader implements SessionReadPort {
  constructor(private readonly stateCheckout: string, private readonly store = new PlanningStore(stateCheckout), private readonly host = new TmuxHost(stateCheckout)) {}
  async readSessions(): Promise<SessionSnapshot> {
    let connection: SessionSnapshot["connection"] = "disconnected";
    let target: string | undefined;
    try {
      const record = await this.host.verifiedRecord();
      if (record) { connection = "connected"; target = this.host.attachTarget(record); }
    } catch { connection = "error"; }
    const state = await this.store.read();
    const sessions: SessionSnapshot["sessions"] = [];
    for (const goal of state.planningGoals ?? []) {
      let runtime: Awaited<ReturnType<PlanningStore["runtime"]>>;
      try { runtime = await this.store.runtime(goal.id); }
      catch { sessions.push({ id: goal.id, teamId: goal.teamId, seatId: goal.seatId, status: "error", engine: "codex", goal: goal.goal, stage: goal.stage, updatedAt: goal.updatedAt, recentActivity: ["Runtime metadata is unreadable."] }); continue; }
      sessions.push({ id: goal.id, teamId: goal.teamId, seatId: goal.seatId, status: connection === "error" ? "error" : connection === "connected" && goal.stage !== "awaiting-review" ? "running" : "idle", engine: "codex", sessionId: runtime.sessionId, goal: goal.goal, stage: goal.stage, updatedAt: goal.updatedAt, recentActivity: runtime.runs.slice(-3).map((run) => `Codex run finished ${run.finishedAt}`), ...(target ? { attach: { kind: "tmux" as const, target } } : {}) });
    }
    return { connection, sessions };
  }
}
