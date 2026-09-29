import { PlanningStore, type PlanningGoal, type SprintIntegration } from "./planning.js";
import { TmuxHost } from "./tmux-host.js";
import { LocalReleaseActivationReader, type ReleaseActivation } from "./release-activation.js";

export type SessionEngine = "codex" | "claude" | "unknown";
/** Persisted handles: unqualified legacy IDs are Codex; only claude:<id> identifies Claude. */
export function sessionEngine(handle?: string): SessionEngine {
  if (!handle?.includes(":")) return "codex";
  return handle.startsWith("claude:") && handle.slice(7).trim() ? "claude" : "unknown";
}
export const engineLabel = (engine: SessionEngine): string => ({ codex: "Codex", claude: "Claude Code", unknown: "Unknown engine" })[engine];

export const SPRINT_STAGES = ["Goal", "Clarify", "Propose", "Approve", "Build", "Review", "Integrate", "Merge", "Updated"] as const;
export const CEREMONY_STAGES = ["planning", "proposal", "implement", "release", "retro"] as const;
export type CeremonyStage = typeof CEREMONY_STAGES[number];
export type SprintStage = typeof SPRINT_STAGES[number] | CeremonyStage;
/** State facts are projected verbatim; the transition owner defines and validates their complete shape. */
export interface CeremonySnapshot {
  stage: CeremonyStage;
  closedAt?: string;
  release?: Record<string, unknown>;
  retro?: { status: string; prUrl?: string; [fact: string]: unknown };
  [fact: string]: unknown;
}
export type CeremonyGoal = PlanningGoal & { ceremony?: CeremonySnapshot };
export interface SprintTicket {
  id: string; title: string; seatId: string; prUrl?: string;
  status: "queued" | "building" | "in review" | "merged" | "failed" | "not assigned";
}
export interface SprintBuild {
  status: ReleaseActivation["status"];
  runningSha?: string; bridgeSha?: string; availableSha?: string;
  reason?: string;
  evidence?: ReleaseActivation["evidence"];
}
export interface SprintLoop {
  stage: SprintStage;
  /** The persisted ceremony, including closure, release facts and retro progress, independent of live readiness. */
  ceremony?: CeremonySnapshot;
  tickets: SprintTicket[];
  integration?: SprintIntegration;
  build?: SprintBuild;
}

/** Read-only projection: finished and failed assignments remain in the same sprint as active work. */
export function projectSprint(goal: CeremonyGoal, build?: SprintBuild): SprintLoop {
  const assignments = new Map(goal.assignments?.map((item) => [item.outcomeId, item]));
  const tickets: SprintTicket[] = (goal.proposal?.outcomes ?? []).map((outcome) => {
    const assignment = assignments.get(outcome.id);
    const status = assignment?.status;
    return { id: outcome.id, title: outcome.title, seatId: assignment?.seatId ?? outcome.seatId,
      status: status === "running" ? "building" : status === "in-review" ? "in review" : status ?? "not assigned",
      ...(assignment?.prUrl ? { prUrl: assignment.prUrl } : {}) };
  });
  const integration = goal.integration;
  // Integration wins even when the owner chose to integrate only part of the sprint.
  if (integration?.status === "reverted") build = { status: "reverted", reason: "The integration was reverted." };
  else if (integration?.revertPrUrl) build = { status: "revert-open", reason: "A revert PR is recorded." };
  else if (integration?.status === "merged" && !build) build = { status: "unavailable" };
  let stage: SprintStage;
  if (goal.ceremony) {
    stage = goal.ceremony.stage;
  } else if (integration && integration.status !== "collecting") {
    stage = integration.status === "merged" && build?.status === "running" ? "Updated" : "Merge";
  } else if (goal.stage !== "approved") {
    stage = { clarifying: "Clarify", drafting: "Propose", "awaiting-review": "Approve" }[goal.stage] as SprintStage;
  } else if (tickets.length && tickets.every((ticket) => ticket.status === "merged" || ticket.status === "failed") && tickets.some((ticket) => ticket.status === "merged")) {
    stage = "Integrate";
  } else if (tickets.length && tickets.every((ticket) => ticket.status === "in review" || ticket.status === "merged")) {
    stage = "Review";
  } else stage = "Build";
  return { stage, tickets, ...(goal.ceremony ? { ceremony: structuredClone(goal.ceremony) } : {}), ...(integration ? { integration: { ...integration } } : {}), ...(build ? { build: structuredClone(build) } : {}) };
}

export interface SprintBuildReadPort { read(integration: SprintIntegration): Promise<SprintBuild> }
/** Compatibility name for UI consumers; the bridge and UI now use the same readiness gate. */
export class LocalSprintBuildReader extends LocalReleaseActivationReader implements SprintBuildReadPort {}

export interface SessionSnapshot {
  connection: "connected" | "disconnected" | "error";
  sessions: {
    id: string; teamId: string; seatId: string; status: "idle" | "running" | "error"; engine: SessionEngine;
    sessionId?: string; goal: string; stage: string; updatedAt?: string; recentActivity: string[];
    ceremony?: CeremonySnapshot;
    attach?: { kind: "tmux"; target: string };
    /** The sprint's integration status; `revert-open` is a merged sprint whose revert PR is open. */
    sprint?: SprintView;
    loop?: SprintLoop;
  }[];
}
export type SprintView = "collecting" | "pr-open" | "merged" | "revert-open" | "reverted";

export function sprintView(goal: PlanningGoal): SprintView | undefined {
  const integration = goal.integration;
  if (!integration) return undefined;
  return integration.status === "merged" && integration.revertPrUrl ? "revert-open" : integration.status;
}
export interface SessionReadPort { readSessions(): Promise<SessionSnapshot> }

export class LocalSessionReader implements SessionReadPort {
  constructor(stateCheckout: string, private readonly store: Pick<PlanningStore, "read" | "runtime"> = new PlanningStore(stateCheckout), private readonly host: Pick<TmuxHost, "verifiedRecord" | "isReady" | "attachTarget"> = new TmuxHost(stateCheckout), private readonly builds: SprintBuildReadPort = new LocalSprintBuildReader(stateCheckout)) {}
  async readSessions(): Promise<SessionSnapshot> {
    let connection: SessionSnapshot["connection"] = "disconnected";
    let target: string | undefined;
    try {
      const record = await this.host.verifiedRecord();
      if (record && await this.host.isReady(record)) { connection = "connected"; target = this.host.attachTarget(record); }
    } catch { connection = "error"; }
    const state = await this.store.read();
    const sessions: SessionSnapshot["sessions"] = [];
    for (const goal of state.planningGoals ?? []) {
      const build = goal.integration && ["merged", "reverted"].includes(goal.integration.status)
        ? await this.builds.read(goal.integration).catch((): SprintBuild => ({ status: "unavailable" })) : undefined;
      const loop = projectSprint(goal, build);
      const context = { id: goal.id, teamId: goal.teamId, seatId: goal.seatId, goal: goal.goal, stage: goal.stage, updatedAt: goal.updatedAt,
        loop, ...(loop.ceremony ? { ceremony: structuredClone(loop.ceremony) } : {}), ...(goal.integration ? { sprint: sprintView(goal) } : {}) };
      let runtime: Awaited<ReturnType<PlanningStore["runtime"]>>;
      try {
        runtime = await this.store.runtime(goal.id);
        if (!Array.isArray(runtime.runs) || (runtime.sessionId !== undefined && typeof runtime.sessionId !== "string")) throw new Error("Invalid runtime metadata.");
      }
      catch { sessions.push({ ...context, status: "error", engine: "unknown", recentActivity: ["Runtime metadata is unreadable."] }); continue; }
      const engine = sessionEngine(runtime.sessionId);
      sessions.push({ ...context, status: connection === "error" ? "error" : "idle", engine, sessionId: runtime.sessionId, recentActivity: runtime.runs.slice(-3).map((run) => `${engineLabel(engine)} run finished ${run.finishedAt}`), ...(target ? { attach: { kind: "tmux" as const, target } } : {}) });
    }
    return { connection, sessions };
  }
}
