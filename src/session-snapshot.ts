import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PlanningStore, type PlanningGoal, type SprintIntegration } from "./planning.js";
import { TmuxHost } from "./tmux-host.js";
import { readBuildStamp, readStampIn, type BuildStamp } from "./build-stamp.js";
import { appRootOf } from "./reload.js";

export type SessionEngine = "codex" | "claude" | "unknown";
/** Persisted handles: unqualified legacy IDs are Codex; only claude:<id> identifies Claude. */
export function sessionEngine(handle?: string): SessionEngine {
  if (!handle?.includes(":")) return "codex";
  return handle.startsWith("claude:") && handle.slice(7).trim() ? "claude" : "unknown";
}
export const engineLabel = (engine: SessionEngine): string => ({ codex: "Codex", claude: "Claude Code", unknown: "Unknown engine" })[engine];

export const SPRINT_STAGES = ["Goal", "Clarify", "Propose", "Approve", "Build", "Review", "Integrate", "Merge", "Updated"] as const;
export type SprintStage = typeof SPRINT_STAGES[number];
export interface SprintTicket {
  id: string; title: string; seatId: string; prUrl?: string;
  status: "queued" | "building" | "in review" | "merged" | "failed" | "not assigned";
}
export interface SprintBuild {
  status: "running" | "reload-pending" | "update-pending" | "unavailable" | "revert-open" | "reverted";
  runningSha?: string; availableSha?: string;
}
export interface SprintLoop {
  stage: SprintStage;
  tickets: SprintTicket[];
  integration?: SprintIntegration;
  build?: SprintBuild;
}

/** Read-only projection: finished and failed assignments remain in the same sprint as active work. */
export function projectSprint(goal: PlanningGoal, build?: SprintBuild): SprintLoop {
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
  if (integration?.status === "reverted") build = { ...build, status: "reverted" };
  else if (integration?.revertPrUrl) build = { ...build, status: "revert-open" };
  else if (integration?.status === "merged" && !build) build = { status: "unavailable" };
  let stage: SprintStage;
  if (integration && integration.status !== "collecting") {
    stage = integration.status === "merged" && build?.status === "running" ? "Updated" : "Merge";
  } else if (goal.stage !== "approved") {
    stage = { clarifying: "Clarify", drafting: "Propose", "awaiting-review": "Approve" }[goal.stage] as SprintStage;
  } else if (tickets.length && tickets.every((ticket) => ticket.status === "merged" || ticket.status === "failed") && tickets.some((ticket) => ticket.status === "merged")) {
    stage = "Integrate";
  } else if (tickets.length && tickets.every((ticket) => ticket.status === "in review" || ticket.status === "merged")) {
    stage = "Review";
  } else stage = "Build";
  return { stage, tickets, ...(integration ? { integration: { ...integration } } : {}), ...(build ? { build } : {}) };
}

export interface SprintBuildReadPort { read(integration: SprintIntegration): Promise<SprintBuild> }
const fullSha = (sha?: string): sha is string => !!sha && /^[0-9a-f]{40}$/.test(sha);

/** Uses the loaded immutable build, never checkout HEAD or a newly switched dist, as running evidence. */
export class LocalSprintBuildReader implements SprintBuildReadPort {
  private readonly ancestry = new Map<string, boolean>();
  constructor(
    private readonly appDir = appRootOf(import.meta.url),
    private readonly running = readStampIn(dirname(fileURLToPath(import.meta.url))),
  ) {}
  private async contains(ancestor: string, build?: BuildStamp): Promise<boolean | undefined> {
    if (!build || !fullSha(ancestor) || !fullSha(build.sha)) return undefined;
    if (ancestor === build.sha) return true;
    const key = `${ancestor}:${build.sha}`;
    if (this.ancestry.has(key)) return this.ancestry.get(key);
    const result = await new Promise<boolean | undefined>((resolve) => {
      execFile("git", ["merge-base", "--is-ancestor", ancestor, build.sha], { cwd: this.appDir, timeout: 2000, maxBuffer: 4096 }, (error) => {
        resolve(!error ? true : error.code === 1 ? false : undefined);
      });
    });
    if (result !== undefined) this.ancestry.set(key, result);
    return result;
  }
  async read(integration: SprintIntegration): Promise<SprintBuild> {
    if (integration.status === "reverted") return { status: "reverted" };
    if (integration.revertPrUrl) return { status: "revert-open" };
    const running = await this.running;
    const available = await readBuildStamp(this.appDir);
    const shas = { ...(fullSha(running?.sha) ? { runningSha: running.sha } : {}), ...(fullSha(available?.sha) ? { availableSha: available.sha } : {}) };
    const included = await this.contains(integration.mergedSha ?? "", running);
    if (included === true) return { status: "running", ...shas };
    if (included === undefined) return { status: "unavailable", ...shas };
    const ready = await this.contains(integration.mergedSha ?? "", available);
    return { status: ready === true ? "reload-pending" : ready === false ? "update-pending" : "unavailable", ...shas };
  }
}

export interface SessionSnapshot {
  connection: "connected" | "disconnected" | "error";
  sessions: {
    id: string; teamId: string; seatId: string; status: "idle" | "running" | "error"; engine: SessionEngine;
    sessionId?: string; goal: string; stage: string; updatedAt?: string; recentActivity: string[];
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
  constructor(stateCheckout: string, private readonly store: Pick<PlanningStore, "read" | "runtime"> = new PlanningStore(stateCheckout), private readonly host: Pick<TmuxHost, "verifiedRecord" | "isReady" | "attachTarget"> = new TmuxHost(stateCheckout), private readonly builds: SprintBuildReadPort = new LocalSprintBuildReader()) {}
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
      const context = { id: goal.id, teamId: goal.teamId, seatId: goal.seatId, goal: goal.goal, stage: goal.stage, updatedAt: goal.updatedAt,
        loop: projectSprint(goal, build), ...(goal.integration ? { sprint: sprintView(goal) } : {}) };
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
