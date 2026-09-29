import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { BacklogStore, parseBacklogEdit, ticketDescription, type BacklogEdit, type BacklogSnapshot } from "./backlog.js";
import type { AgentRuntime } from "./codex-runtime.js";
import { requireTeamHome, type PlanningStore } from "./planning.js";
import { productPrompt } from "./product-prompts.js";
import { productResearchReader, type ResearchReader, type ResearchSource } from "./product-research.js";
import { redactSecrets } from "./redact.js";
import { schemaPathOf } from "./reload.js";
import { AgentRunError, type TokenUsage } from "./runtime-facts.js";
import { withFileLock } from "./state-commit.js";
import { isActiveSeat, type TeamRecord } from "./state-domain.js";
import schema from "../schemas/product.json?raw";

export const GROOMING_TURN_MS = 3 * 60_000;
export const GROOMING_INTERVAL_MS = 15 * 60_000;
export const GROOMING_RETRY_MS = 60_000;
const validate = new Ajv2020({ strict: false }).compile(JSON.parse(schema));
const schemaPath = schemaPathOf(import.meta.url, "product.json");
export interface ProductOutput {
  summary: string; evidence: { url: string; quote: string; finding: string }[]; edit: BacklogEdit;
}

/** Reject the whole response before journaling it. Never echo invalid input into errors or logs. */
export function parseProductOutput(value: unknown, snapshot: BacklogSnapshot, sources: ResearchSource[]): ProductOutput {
  if (JSON.stringify(value)?.length > 100_000 || !validate(value)) throw new Error("Invalid grooming output.");
  const output = structuredClone(value) as ProductOutput;
  parseBacklogEdit(output.edit);
  if (output.edit.expectedRevision !== snapshot.revision) throw new Error("Invalid grooming revision.");
  if ((output.edit.ticketChanges.length || output.edit.candidateChanges.length) && !output.evidence.length) throw new Error("Grooming changes require cited evidence.");
  const inspect = (item: unknown, key = ""): void => {
    if (typeof item === "string") {
      const text = key === "url" ? item.replace(/\/[a-f0-9]{40}\//g, "/revision/") : item;
      if (key !== "expectedRevision" && (text.length > 12_000 || redactSecrets(text) !== text)) throw new Error("Unsafe grooming output.");
    } else if (Array.isArray(item)) item.forEach((child) => inspect(child));
    else if (item && typeof item === "object") for (const [name, child] of Object.entries(item)) inspect(child, name);
  };
  inspect(output);
  for (const citation of output.evidence) {
    if (citation.quote.trim().length < 12 || !sources.some((source) => source.url === citation.url && source.text.includes(citation.quote))) throw new Error("Grooming evidence does not quote an available source.");
  }
  const protectedTickets = new Set(snapshot.candidates.filter((candidate) => candidate.goalId || ["proposed", "completed"].includes(candidate.status)).flatMap((candidate) => candidate.ticketIds));
  for (const { ticket } of output.edit.ticketChanges) {
    const previous = snapshot.tickets.find((item) => item.id === ticket.id);
    if (!["open", "discarded"].includes(ticket.status) || (previous && !["open", "discarded"].includes(previous.status)) || protectedTickets.has(ticket.id)) throw new Error("Grooming cannot change committed sprint tickets.");
    if (!ticket.research.length || ticket.research.some((citation) => !output.evidence.some((evidence) => evidence.url === citation.url && evidence.finding === citation.finding))) throw new Error("Changed tickets require cited research findings.");
  }
  for (const { candidate } of output.edit.candidateChanges) {
    const previous = snapshot.candidates.find((item) => item.id === candidate.id);
    if (candidate.goalId !== null || !["candidate", "discarded"].includes(candidate.status) || previous?.goalId || (previous && !["candidate", "discarded"].includes(previous.status))) throw new Error("Grooming cannot propose or complete a sprint.");
    if (candidate.status === "candidate" && candidate.ticketIds.some((id) => {
      const ticket = output.edit.ticketChanges.find((change) => change.ticket.id === id)?.ticket ?? snapshot.tickets.find((item) => item.id === id);
      return !ticket || ticket.status !== "open" || protectedTickets.has(id);
    })) throw new Error("Upcoming candidates require open, uncommitted tickets.");
  }
  return output;
}

export interface GroomingRecord {
  version: 1; teamId: string; seatId: string; role: string; project: string;
  nextRunAt: number; sessionId?: string; cumulativeUsage?: TokenUsage;
  feedback?: "stale" | "invalid";
  /** A validated response is saved before the state transaction. No arbitrary agent response is persisted. */
  pending?: { snapshot: BacklogSnapshot; sources: ResearchSource[]; output: ProductOutput };
  phase: "running" | "pending" | "idle";
}
export const groomingRecordName = (teamId: string, seatId: string): string => {
  if (![teamId, seatId].every((id) => /^[a-z][a-z0-9-]+$/.test(id))) throw new Error("Invalid grooming identity.");
  return `grooming-${teamId}-${seatId}`;
};

/** Detect a commit completed just before a crash; never replay its creates or overwrite later edits. */
function alreadyApplied(snapshot: BacklogSnapshot, edit: BacklogEdit, seatId: string): boolean {
  return edit.ticketChanges.every(({ ticket }) => {
    const saved = snapshot.tickets.find((item) => item.id === ticket.id);
    return saved?.updatedBySeatId === seatId && saved.title === ticket.title && saved.description === ticketDescription(ticket) && saved.value === ticket.value && saved.status === ticket.status
      && JSON.stringify(saved.dependsOn ?? []) === JSON.stringify(ticket.dependsOn) && JSON.stringify(saved.research ?? []) === JSON.stringify(ticket.research);
  }) && edit.candidateChanges.every(({ candidate }) => {
    const saved = snapshot.candidates.find((item) => item.id === candidate.id);
    return saved?.updatedBySeatId === seatId && saved.title === candidate.title && saved.summary === candidate.summary && saved.value === candidate.value && saved.rank === candidate.rank && saved.status === candidate.status
      && JSON.stringify(saved.ticketIds) === JSON.stringify(candidate.ticketIds) && (saved.goalId ?? null) === candidate.goalId && (saved.retrospectiveGoalId ?? null) === candidate.retrospectiveGoalId;
  });
}

export interface GroomerOptions {
  research?: ResearchReader; now?: () => number; log?: (message: string) => void;
}

/**
 * A seat has one resumable grooming journal, separate from planning/implementation sessions. Only the brief
 * read/apply operations take the state lock; research and model turns hold only this seat's grooming lock.
 */
export class BacklogGroomer {
  private active?: Promise<"idle" | "worked">;
  private readonly backlog: BacklogStore;
  private readonly research: ResearchReader;
  private readonly now: () => number;
  private readonly name: string;
  constructor(private readonly store: PlanningStore, private readonly teamId: string, private readonly seatId: string,
    private readonly runtimeFor: (cwd: string) => AgentRuntime, private readonly options: GroomerOptions = {}) {
    this.backlog = new BacklogStore(store);
    this.research = options.research ?? productResearchReader(store.runtimeDir);
    this.now = options.now ?? Date.now;
    this.name = groomingRecordName(teamId, seatId);
  }

  /** Bridge adapter: schedule at most one job and return immediately so workflow polling keeps moving. */
  poll(): void { void this.tick(); }
  /** Product runner awaits this to retain its existing seat turn lock through a bounded model turn. */
  tick(): Promise<"idle" | "worked"> {
    if (this.active) return this.active;
    const work = withFileLock(join(this.store.runtimeDir, `${this.name}.lock`), () => this.turn(), 1)
      .catch(() => { this.options.log?.("Backlog grooming is pending; it will retry."); return "idle" as const; });
    this.active = work;
    void work.finally(() => { if (this.active === work) this.active = undefined; });
    return work;
  }
  /** Useful at graceful shutdown and in tests; poll never awaits this. */
  async settled(): Promise<void> { await this.active; }

  private async turn(): Promise<"idle" | "worked"> {
    const state = await this.store.read();
    const team = (state.teams as TeamRecord[]).find((item) => item.id === this.teamId);
    const seat = team?.seats.find((item) => item.id === this.seatId);
    if (!team || !seat || !isActiveSeat(seat) || !["Product", "Team Lead"].includes(seat.roles[0]) || !team.mission?.trim()) return "idle";
    const { github } = requireTeamHome(state, team.id);
    let record = await this.store.readRuntimeFile<GroomingRecord>(this.name);
    if (record && (record.version !== 1 || record.teamId !== team.id || record.seatId !== seat.id || record.role !== seat.roles[0] || record.project !== github)) throw new Error("Grooming journal identity changed.");
    record ??= { version: 1, teamId: team.id, seatId: seat.id, role: seat.roles[0], project: github, nextRunAt: 0, phase: "idle" };
    if (!record.pending && record.nextRunAt > this.now()) return "idle";
    // Complete any interrupted state commit before comparing revisions or recovering an application.
    await this.store.update(() => {}, "Recover state before backlog grooming");
    if (record.pending) { await this.apply(record); return "worked"; }
    const snapshot = await this.backlog.read(team.id);
    if (!snapshot.mission?.trim()) return "idle";
    record.phase = "running";
    // Persist the retry delay before launching, so repeated process restarts cannot create a tight loop.
    record.nextRunAt = this.now() + GROOMING_RETRY_MS;
    await this.store.saveRuntime(this.name, record);
    try {
      const research = await this.research(state, team.id);
      // A changed mission or another role's edits during preparation require a new snapshot and new research.
      if ((await this.backlog.read(team.id)).revision !== snapshot.revision) {
        record.feedback = "stale"; record.phase = "idle";
        await this.store.saveRuntime(this.name, record); return "worked";
      }
      const run = await this.runtimeFor(research.cwd).message(productPrompt({ seat, snapshot, sources: research.sources,
        goals: (state.planningGoals ?? []).filter((goal) => goal.teamId === team.id), feedback: record.feedback }), schemaPath, record.sessionId,
      { timeoutMs: GROOMING_TURN_MS, purpose: "groom", previousSessionUsage: record.cumulativeUsage });
      record.sessionId = run.sessionId;
      record.cumulativeUsage = run.facts?.cumulativeUsage;
      const output = parseProductOutput(run.response, snapshot, research.sources);
      record.pending = { snapshot, sources: research.sources, output }; record.phase = "pending";
      await this.store.saveRuntime(this.name, record);
      await this.apply(record);
    } catch (error) {
      if (error instanceof AgentRunError && error.facts.sessionId) {
        record.sessionId = error.facts.sessionId; record.cumulativeUsage = error.facts.cumulativeUsage;
      }
      record.phase = record.pending ? "pending" : "idle";
      record.feedback = "invalid";
      record.nextRunAt = this.now() + GROOMING_RETRY_MS;
      await this.store.saveRuntime(this.name, record);
      this.options.log?.("Backlog grooming could not finish; it will retry with current context.");
    }
    return "worked";
  }

  private async apply(record: GroomingRecord): Promise<void> {
    const { snapshot, sources, output } = record.pending!;
    try { parseProductOutput(output, snapshot, sources); }
    catch { await this.finish(record, "invalid"); return; }
    const current = await this.backlog.read(this.teamId);
    if (current.revision !== snapshot.revision) {
      const recovered = alreadyApplied(current, output.edit, this.seatId);
      await this.finish(record, recovered ? undefined : "stale"); return;
    }
    try { await this.backlog.apply(this.teamId, this.seatId, output.edit); }
    catch {
      // A competitor may commit between read and apply. Reconcile on the next bounded turn, never force an edit.
      await this.finish(record, (await this.backlog.read(this.teamId)).revision === snapshot.revision ? "invalid" : "stale"); return;
    }
    await this.finish(record);
  }

  private async finish(record: GroomingRecord, feedback?: GroomingRecord["feedback"]): Promise<void> {
    delete record.pending; record.feedback = feedback; record.phase = "idle";
    record.nextRunAt = this.now() + (feedback ? GROOMING_RETRY_MS : GROOMING_INTERVAL_MS);
    await this.store.saveRuntime(this.name, record);
  }
}
