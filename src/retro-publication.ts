import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { ceremonyRuntimeName, type BridgeCeremonyRecord, type CeremonyAdapters, type CeremonyContext, type CeremonyProgress } from "./planning-bridge.js";
import { type CeremonyStage, type HumanApproval, type PublishedRetroEvidence, validateCeremony } from "./ceremony.js";
import type { CeremonyWriteReadiness } from "./ceremony-ports.js";
import { requireTeamHome, type PlanningStore } from "./planning.js";
import { processShell, type SeatTaskRecord } from "./developer-seat.js";
import { seatRecordName } from "./developer-maintenance.js";
import { retroPath, SprintGitHub, type RetroArchive, type RetroPr } from "./sprint.js";
import { draftSprintRetro, renderSprintRetro, RetroGenerationError, type RetroGeneration, type RetroInput, type SprintRetroDraft } from "./sprint-retro.js";
import { loadSeatEngines, SeatRuntime } from "./seat-runtime.js";
import { seatHarnessDir } from "./harness-home.js";
import { loadSeatPersonas, personaPost, withPersonaRuntime } from "./seat-persona.js";
import { AgentRunError } from "./runtime-facts.js";

/** The store still checks the companion schema before writing any ceremony state. */
export const ceremonyReadiness: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
export const retroRuntimeName = (goalId: string) => { retroPath(goalId); return `retro-publication-${goalId}`; };
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const pending = (reason: string): CeremonyProgress<PublishedRetroEvidence> => ({ status: "pending", reason });

export interface RetroPublicationRecord {
  version: 1; goalId: string; github: string;
  attempts: { startedAt: string; generation?: RetroGeneration }[];
  frozen?: { draft: SprintRetroDraft; parts: string[]; markdown: string; sha256: string };
  postIds?: string[];
  prUrl?: string;
  gate?: { headSha: string; postId: string; announcedAt: string };
  authorization?: { headSha: string; prUrl: string; postId: string; approval: HumanApproval };
  verifiedAt?: string;
  /** Final completion timing, recorded before returning closure proof; the bridge journals closedAt from state. */
  stageTimings?: { stage: CeremonyStage; enteredAt: string | null; throughAt: string | null; elapsedMs: number | null }[];
}
export type RetroDraft = (context: CeremonyContext) => Promise<SprintRetroDraft>;

/** Split at line boundaries below Mattermost's message limit. Joining parts preserves every source byte. */
function parts(markdown: string): string[] {
  const result: string[] = [];
  while (markdown.length > 10_000) {
    const newline = markdown.lastIndexOf("\n", 10_000);
    const end = newline > 0 ? newline + 1 : 10_000;
    result.push(markdown.slice(0, end)); markdown = markdown.slice(end);
  }
  if (markdown) result.push(markdown);
  return result;
}

/**
 * The bridge owns the goal lock, Chick's recoverable outbox, human identity checks, and the atomic state closure.
 * This adapter returns proof only after publication and a verified archival merge. It never applies proposals.
 */
export class RetroPublication {
  constructor(private readonly archive: RetroArchive, private readonly draft: RetroDraft,
    private readonly formatPost: (context: CeremonyContext, message: string) => Promise<string> = async (_context, message) => message) {}

  private async load(context: CeremonyContext): Promise<RetroPublicationRecord> {
    const { goal, store } = context;
    retroPath(goal.id);
    if (goal.ceremony?.stage !== "retro" || goal.ceremony.closure) throw new Error("Publication requires an open goal at retro.");
    validateCeremony(goal);
    const state = await store.read();
    const current = state.planningGoals?.find((item) => item.id === goal.id);
    if (JSON.stringify(current) !== JSON.stringify(goal)) throw new Error("Retrospective goal changed; retry with current state.");
    const home = requireTeamHome(state, goal.teamId);
    if (goal.mattermost.channelId !== home.channelId) throw new Error("Retrospective thread is outside the team's home.");
    const record = await store.readRuntimeFile<RetroPublicationRecord>(retroRuntimeName(goal.id)) ?? { version: 1, goalId: goal.id, github: home.github, attempts: [] };
    if (record.version !== 1 || record.goalId !== goal.id || record.github !== home.github) throw new Error("Retrospective journal does not match the team's configured project.");
    if (record.frozen) {
      const frozen = record.frozen;
      if (digest(frozen.markdown) !== frozen.sha256 || frozen.parts.join("") !== frozen.draft.markdown
        || await renderSprintRetro(frozen.draft.snapshot, frozen.draft.narrative, frozen.draft.generation) !== frozen.draft.markdown
        || (await Promise.all(frozen.parts.map((message) => this.formatPost(context, message)))).join("") !== frozen.markdown) throw new Error("Frozen retrospective content failed verification.");
    }
    return record;
  }
  private async save(context: CeremonyContext, record: RetroPublicationRecord): Promise<void> {
    await context.store.saveRuntime(retroRuntimeName(context.goal.id), record);
  }

  async poll(context: CeremonyContext): Promise<CeremonyProgress<PublishedRetroEvidence>> {
    try {
      const record = await this.load(context);
      if (!record.frozen) {
        record.attempts.push({ startedAt: new Date().toISOString() });
        await this.save(context, record);
        let draft: SprintRetroDraft;
        try { draft = await this.draft(context); }
        catch (error) {
          if (error instanceof RetroGenerationError) record.attempts.at(-1)!.generation = error.generation;
          await this.save(context, record);
          return pending("Chick's retrospective draft failed or was interrupted; it will be retried.");
        }
        if (draft.snapshot.goalId !== context.goal.id || draft.snapshot.leadSeatId !== context.goal.seatId || draft.markdown !== await renderSprintRetro(draft.snapshot, draft.narrative, draft.generation)) throw new Error("Retrospective content was not rendered from this goal's recorded facts.");
        const messages = parts(draft.markdown);
        // The normal Chick chat adds its persona attribution. Freeze those same bytes in the archive too.
        const markdown = (await Promise.all(messages.map((message) => this.formatPost(context, message)))).join("");
        record.attempts.at(-1)!.generation = draft.generation;
        record.frozen = { draft, parts: messages, markdown, sha256: digest(markdown) };
        await this.save(context, record);
      }
      const frozen = record.frozen;
      const postIds: string[] = [];
      for (const [index, message] of frozen.parts.entries()) postIds.push(await context.post(`retro-content:${frozen.sha256}:${index}`, message));
      record.postIds = postIds;
      await this.save(context, record);
      record.prUrl = await this.archive.ensureRetroPr(record.github, context.goal.id, frozen.markdown);
      await this.save(context, record);
      const pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
      if (pr.state === "CLOSED") return pending("The retrospective PR is closed without merging; the owner must resolve it before the goal can close.");
      if (pr.state === "OPEN") {
        const announcedAt = record.gate?.headSha === pr.headSha ? record.gate.announcedAt : new Date().toISOString();
        // Save the start of the announcement before delivery; a reaction received during a lost response is fresh.
        if (record.gate?.headSha !== pr.headSha) {
          record.gate = { headSha: pr.headSha, postId: "", announcedAt };
          await this.save(context, record);
        }
        const postId = await context.post(`retro-merge:${pr.headSha}`, `**Retrospective archive: ${context.goal.id}**\n${pr.url}\n\nOnly \`${retroPath(context.goal.id)}\` may change. A fresh review and passing CI are required. React ✅ on this post or use \`planning merge --goal ${context.goal.id}\` (M) to authorize this archive. Earlier plan and release approvals do not apply. Suggested process changes remain proposals for the owner.`, "retro");
        record.gate = { headSha: pr.headSha, postId, announcedAt };
        await this.save(context, record);
        return pending(!pr.reviewed ? "The retrospective archive needs a fresh review on its current head." : !pr.checksPassed ? "The retrospective archive is waiting for passing CI." : "The retrospective archive is waiting for a new human checkmark or the owner's M.");
      }
      if (!this.authorized(record, pr) || !pr.reviewed || !pr.checksPassed || !pr.mergedSha) return pending("The archival merge still needs verified human authorization, current-head review and passing CI.");
      record.verifiedAt ??= new Date().toISOString();
      record.stageTimings = context.goal.ceremony!.history.map((entry, index, history) => {
        const throughAt = index + 1 < history.length ? history[index + 1].enteredAt : record.verifiedAt!;
        return { stage: entry.stage, enteredAt: entry.enteredAt, throughAt, elapsedMs: entry.enteredAt === null || throughAt === null ? null : Date.parse(throughAt) - Date.parse(entry.enteredAt) };
      });
      await this.save(context, record);
      return { status: "complete", evidence: { kind: "retro-published", path: retroPath(context.goal.id), prUrl: pr.url, baseBranch: "main", mergedSha: pr.mergedSha,
        postId: postIds.at(-1)!, publishedAt: record.verifiedAt, factsOnly: true, suggestions: "owner-proposals-only" } };
    } catch {
      // Neither provider diagnostics nor local paths may enter a thread or the state journal.
      return pending("Retrospective publication or archival verification is pending; retry after resolving the delivery or PR problem.");
    }
  }

  private authorized(record: RetroPublicationRecord, pr: RetroPr): boolean {
    const authorization = record.authorization;
    return !!authorization && authorization.prUrl === pr.url && authorization.headSha === pr.headSha && authorization.postId === record.gate?.postId;
  }

  /** Called only by the bridge after a GET-verified human reaction, or the owner's terminal M. */
  async merge(context: CeremonyContext, approval: HumanApproval): Promise<string> {
    let record = await this.load(context);
    // The bridge may consume a reaction immediately after recovering its outbox, before our next poll.
    if (record.gate && !record.gate.postId) { await this.poll(context); record = await this.load(context); }
    if (!record.frozen || !record.prUrl || !record.gate?.postId || !record.postIds?.length) throw new Error("Publish the retrospective and its archival PR before approving its merge.");
    const pr = await this.archive.inspectRetroPr(record.github, context.goal.id, record.frozen.markdown, record.prUrl);
    if (pr.state === "MERGED" && this.authorized(record, pr) && pr.reviewed && pr.checksPassed) return `Retrospective archive is already merged: ${pr.url}.`;
    if (pr.state !== "OPEN" || pr.headSha !== record.gate.headSha) throw new Error("The retrospective PR changed or is closed; reconcile it before a new approval.");
    const release = context.goal.ceremony!.history.find((entry) => entry.stage === "retro")!;
    if (!Number.isFinite(Date.parse(approval.at)) || Date.parse(approval.at) < Date.parse(record.gate.announcedAt) || Date.parse(approval.at) < Date.parse(release.enteredAt ?? context.goal.createdAt)
      || (approval.source === "owner-command" ? approval.command !== "planning merge" : approval.emoji !== "white_check_mark" || approval.verifiedHuman !== true || approval.postId !== record.gate.postId)) throw new Error("The archive requires a new human checkmark on its own post or the owner's M.");
    if (!pr.reviewed || !pr.checksPassed) throw new Error("The retrospective archive needs a fresh current-head review and passing CI before merging.");
    record.authorization = { headSha: pr.headSha, prUrl: pr.url, postId: record.gate.postId, approval };
    await this.save(context, record);
    const result = await this.archive.mergeRetroPr(record.github, context.goal.id, record.frozen.markdown, pr.url, pr.headSha);
    if (!result.merged) throw new Error(result.reason);
    return `Retrospective archive merged: ${pr.url}. Closure follows verified thread delivery and archival merge.`;
  }
}

/** Read only persisted evidence. Missing attempt coverage and unrecorded wall time stay explicitly unknown. */
export async function recordedRetroInput(context: CeremonyContext): Promise<RetroInput> {
  const { goal, store } = context;
  const record = await store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(goal.id));
  const facts: RetroInput["facts"] = structuredClone(record?.facts ?? { seats: [], sessions: [], reviews: [], rounds: [], failures: [] });
  const missing: string[] = [];
  if (!record) missing.push("Chick's historical ceremony runtime record is unavailable.");
  const names = await readdir(store.runtimeDir);
  for (const assignment of goal.assignments ?? []) {
    const name = seatRecordName(assignment.seatId, goal.id, assignment.outcomeId);
    const matches = names.filter((file) => file === `${name}.json` || (file.startsWith(`${name}-retained-`) && file.endsWith(".json")));
    if (!matches.length) missing.push(`Runtime attempts for ${assignment.outcomeId} are unavailable.`);
    const records: SeatTaskRecord[] = [];
    for (const file of matches) {
      const attempt = await store.readRuntimeFile<SeatTaskRecord>(file.slice(0, -5));
      if (!attempt || attempt.goalId !== goal.id || attempt.outcomeId !== assignment.outcomeId || !Array.isArray(attempt.sessions)) { missing.push(`An unreadable attempt exists for ${assignment.outcomeId}.`); continue; }
      records.push(attempt);
      for (const session of attempt.sessions) if (!facts.sessions.some((item) => item.seatId === assignment.seatId && item.sessionId === session.sessionId && item.startedAt === session.startedAt)) facts.sessions.push({ seatId: assignment.seatId, sessionId: session.sessionId, startedAt: session.startedAt, finishedAt: session.finishedAt, usage: session.usage ?? null });
      if (attempt.prUrl && attempt.findings) facts.reviews.push({ outcomeId: assignment.outcomeId, prUrl: attempt.prUrl, findings: attempt.findings });
    }
    if (records.length) {
      const fixes = new Set(records.flatMap((attempt) => attempt.sessions.filter((session) => session.role === "fix").map((session) => `${session.sessionId}:${session.startedAt}`)));
      // Retained records can be snapshots of the same branch, not separate conflict rounds.
      const conflicts = new Map<string, number>();
      for (const attempt of records) if (attempt.conflictRounds !== undefined) conflicts.set(attempt.branch, Math.max(conflicts.get(attempt.branch) ?? 0, attempt.conflictRounds));
      if (!facts.rounds.some((item) => item.outcomeId === assignment.outcomeId)) {
        if (conflicts.size) facts.rounds.push({ outcomeId: assignment.outcomeId, fix: fixes.size, conflict: [...conflicts.values()].reduce((sum, count) => sum + count, 0) });
        else missing.push(`Conflict round counts for ${assignment.outcomeId} are unavailable.`);
      }
    }
    if (assignment.status === "failed" && assignment.note) missing.push(`Recorded terminal failure for ${assignment.outcomeId}: ${assignment.note}. Its retry count is unavailable.`);
  }
  missing.push("Seat attempt records may omit interrupted invocations, earlier findings, failures and retry counts; absence is not zero.");
  for (const seatId of new Set([goal.seatId, ...(goal.assignments ?? []).map((item) => item.seatId)])) if (!facts.seats.some((seat) => seat.seatId === seatId)) facts.seats.push({ seatId, wallTimeMs: null });
  return { goal, facts, cutoffAt: new Date().toISOString(), missing };
}

/** Discovered by cli.ts's existing module extension point; no shared wiring changes are needed. */
export async function createCeremonyAdapters({ store }: { store: PlanningStore }): Promise<CeremonyAdapters> {
  const profiles = await loadSeatPersonas(import.meta.url);
  const retro = new RetroPublication(new SprintGitHub(processShell, store.runtimeDir), async (context) => {
    const state = await store.read();
    const seats = (state.teams as { seats: { id: string }[] }[]).flatMap((team) => team.seats).map((seat) => seat.id);
    const engines = await loadSeatEngines(store.runtimeDir, seats);
    const input = await recordedRetroInput(context);
    return await draftSprintRetro(input, (cwd) => {
      const runtime = withPersonaRuntime(new SeatRuntime(engines[context.goal.seatId] ?? "codex", cwd, undefined, undefined, undefined, seatHarnessDir(store.runtimeDir, context.goal.seatId)), profiles[context.goal.seatId]);
      return { message: async (...args) => {
        try { const run = await runtime.message(...args); await context.recordRun(run); return run; }
        catch (error) { if (error instanceof AgentRunError) await context.recordSession(error.facts); throw error; }
      } };
    });
  }, async (context, message) => personaPost(message, profiles[context.goal.seatId]));
  return { retro };
}
