import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { ceremonyRuntimeName, type BridgeCeremonyRecord, type CeremonyAdapters, type CeremonyContext, type CeremonyProgress, type Post } from "./planning-bridge.js";
import { type CeremonyStage, type HumanApproval, type PublishedRetroEvidence, validateCeremony } from "./ceremony.js";
import type { CeremonyWriteReadiness } from "./ceremony-ports.js";
import { requireTeamHome, type PlanningStore } from "./planning.js";
import { processShell, type SeatTaskRecord } from "./developer-seat.js";
import { seatRecordName } from "./developer-maintenance.js";
import { retroPath, SprintGitHub, releaseAttemptsName, type ReleaseAttempts, type RetroArchive, type RetroPr, type RetroReview, type RetroRejection } from "./sprint.js";
import { goalRuntimeFilename, validateGoalReport, type GoalRuntimeRecord, type WorkflowFailure } from "./goal-contract.js";
import { draftSprintRetro, renderSprintRetro, RetroGenerationError, type RetroGeneration, type RetroInput, type RetroPriorAttempt, type SprintRetroDraft } from "./sprint-retro.js";
import { readImplementationFacts } from "./implementation-facts.js";
import { loadSeatEngines, SeatRuntime, type GoalAgentSession } from "./seat-runtime.js";
import { developerGoalJournalName } from "./developer-goal.js";
import { seatHarnessDir } from "./harness-home.js";
import { loadSeatPersonas, personaPost, withPersonaRuntime } from "./seat-persona.js";
import { AgentRunError } from "./runtime-facts.js";
import { CHICK_USERNAME, MattermostPlanningChat, readChickToken } from "./planning-mattermost.js";
import { opCredential } from "./service-account.js";
import { schemaPathOf } from "./reload.js";
import { redactSecrets } from "./redact.js";
import { validateWorkflowEvent } from "./remodel-events.js";
import { mattermostPostUrl } from "./hub-format.js";

/** The store still checks the companion schema before writing any ceremony state. */
export const ceremonyReadiness: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
export const retroRuntimeName = (goalId: string) => { retroPath(goalId); return `retro-publication-${goalId}`; };
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const pending = (reason: string, failure?: WorkflowFailure): CeremonyProgress<PublishedRetroEvidence> => ({ status: "pending", reason, ...(failure ? { failure } : {}) });

export interface RetroPublicationRecord {
  version: 1; goalId: string; github: string;
  /** Older records have neither finishedAt nor errorKind; a missing finishedAt on a new attempt means it was aborted. */
  attempts: { startedAt: string; finishedAt?: string; errorKind?: string; generation?: RetroGeneration;
    /** Consumed atomically with the reservation, before model work; retained across failed or interrupted turns. */
    retry?: { id: string; at: string } }[];
  /** A recoverable goals-v1 draft blocker; frozen content clears it without discarding attempt history. */
  failure?: WorkflowFailure;
  frozen?: { draft: SprintRetroDraft; parts: string[]; markdown: string; sha256: string };
  postIds?: string[];
  prUrl?: string;
  gate?: { headSha: string; postId: string; announcedAt: string };
  authorization?: { headSha: string; prUrl: string; postId: string; approval: HumanApproval };
  review?: { headSha: string; result: RetroReview };
  /** Superseded publications are append-only snapshots, including their successful generation and delivered evidence. */
  revisions?: RetroPublicationRevision[];
  correction?: { revision: number; retry: { id: string; at: string }; notice?: { message: string; postId?: string }; resultHeadSha?: string };
  verifiedAt?: string;
  /** Final completion timing, recorded before returning closure proof; the bridge journals closedAt from state. */
  stageTimings?: { stage: CeremonyStage; enteredAt: string | null; throughAt: string | null; elapsedMs: number | null }[];
}
export interface RetroPublicationRevision extends Pick<RetroPublicationRecord, "attempts" | "gate" | "review" | "authorization" | "correction"> {
  frozen: NonNullable<RetroPublicationRecord["frozen"]>; postIds: string[]; prUrl: string;
  headSha: string; rejection: RetroRejection; supersededAt: string;
}
/** `prior` lists the earlier failed or aborted attempts, oldest first, for the retro phase facts. */
export type RetroDraft = (context: CeremonyContext, prior: RetroPriorAttempt[]) => Promise<SprintRetroDraft>;

/** Exponential backoff between failed drafts: 15 s, 30 s, 1 min, 2 min, 4 min, then every 5 min. */
export const RETRO_RETRY = { baseMs: 15_000, maxMs: 5 * 60_000 } as const;
export function retroRetryDelayMs(failures: number): number {
  return failures < 1 ? 0 : Math.min(RETRO_RETRY.baseMs * 2 ** Math.min(failures - 1, 20), RETRO_RETRY.maxMs);
}
/** Every attempt before a frozen draft failed or was aborted. */
export function priorRetroAttempts(attempts: RetroPublicationRecord["attempts"]): RetroPriorAttempt[] {
  return attempts.map((attempt) => ({ startedAt: attempt.startedAt, sessionId: attempt.generation?.sessionId ?? null, invocationId: attempt.generation?.invocationId ?? null,
    errorKind: attempt.errorKind ?? (attempt.generation?.status === "timed-out" || attempt.generation?.status === "interrupted" ? attempt.generation.status : attempt.generation ? "runtime-failed" : "unrecorded") }));
}
/** A previous goals-v1 attempt without frozen content always needs a new explicit retry, including old journals. */
function draftFailure(record: RetroPublicationRecord): WorkflowFailure {
  const last = record.attempts.at(-1)!;
  return { at: last.finishedAt ?? last.startedAt, message: `Chick's retrospective draft for ${record.goalId} failed or was interrupted (attempt ${record.attempts.length}); run planning retry --goal ${record.goalId} after resolving the failure.`, retryable: true };
}
function freshDraftRetry(context: CeremonyContext, record: RetroPublicationRecord, after?: string): { id: string; at: string } | undefined {
  if (context.event?.kind !== "retry") return;
  const event = validateWorkflowEvent(context.event);
  if (event.kind !== "retry" || event.goalId !== context.goal.id || event.teamId !== context.goal.teamId || !event.id.trim()
    || [...record.revisions?.flatMap((revision) => revision.attempts) ?? [], ...record.attempts].some((attempt) => attempt.retry?.id === event.id)
    || (after && !(Date.parse(event.at) > Date.parse(after)))) return;
  const last = record.attempts.at(-1);
  if (last && !(Date.parse(event.at) > Date.parse(last.finishedAt ?? last.startedAt))) return;
  return { id: event.id, at: event.at };
}
/** The persona attribution belongs to the thread post only; the archive holds the frozen parts exactly. */
const archiveOf = (parts: string[]) => parts.join("");
export interface RetroPublicationServices {
  /** Fresh GET evidence, independent of the bridge's cached outbox acknowledgements. */
  thread(context: CeremonyContext): Promise<{ ownUserId: string; posts: (Post & { delete_at?: number })[] }>;
  review(context: CeremonyContext, worktree: string, pr: RetroPr): Promise<unknown>;
  formatPost?(context: CeremonyContext, message: string): Promise<string>;
}

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
  constructor(private readonly archive: RetroArchive, private readonly draft: RetroDraft, private readonly services: RetroPublicationServices) {}

  private async formatPost(context: CeremonyContext, message: string): Promise<string> {
    return this.services.formatPost ? await this.services.formatPost(context, message) : message;
  }

  private async verifyPosts(context: CeremonyContext, record: Pick<RetroPublicationRecord, "frozen" | "postIds" | "correction">): Promise<void> {
    const { frozen, postIds } = record;
    if (!frozen || !postIds?.length || postIds.length !== frozen.parts.length || new Set(postIds).size !== postIds.length) throw new Error("Retrospective fragments are incomplete.");
    const { ownUserId, posts } = await this.services.thread(context);
    const messages = postIds.map((id, index) => ({ id, message: frozen.parts[index] }));
    if (record.correction) {
      if (!record.correction.notice?.postId) throw new Error("Correction notice delivery is incomplete.");
      messages.push({ id: record.correction.notice.postId, message: record.correction.notice.message });
    }
    for (const { id, message } of messages) {
      const post = posts.find((item) => item.id === id);
      if (!ownUserId || !post || post.delete_at || post.user_id !== ownUserId || post.channel_id !== context.goal.mattermost.channelId
        || post.root_id !== context.goal.mattermost.rootPostId || post.message !== await this.formatPost(context, message)) throw new Error("Retrospective fragment delivery or content is unverified.");
    }
  }

  private async review(context: CeremonyContext, record: RetroPublicationRecord, pr: RetroPr): Promise<void> {
    await this.archive.reviewRetroPr(record.github, context.goal.id, record.frozen!.markdown, pr.url, pr.headSha, async (worktree) => {
      if (record.review?.headSha === pr.headSha) return record.review.result;
      const value = await this.services.review(context, worktree, pr) as RetroReview | undefined;
      if (typeof value?.summary !== "string" || !Array.isArray(value.findings) || value.findings.some((item) => !item || item.path !== retroPath(context.goal.id)
        || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > record.frozen!.markdown.split("\n").length || typeof item.reason !== "string" || !item.reason.trim())) throw new Error("Invalid archival reviewer response.");
      const result = { summary: redactSecrets(value.summary), findings: value.findings.map((item) => ({ path: item.path, line: item.line, reason: redactSecrets(item.reason) })) };
      record.review = { headSha: pr.headSha, result };
      await this.save(context, record);
      return result;
    });
  }

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
    for (const publication of [...record.revisions ?? [], record]) {
      if (!publication.frozen) continue;
      const frozen = publication.frozen;
      // Version 1 drafts were frozen before phase reflections, with the persona attribution inside the archive.
      // They are verified against their own frozen bytes and cannot be re-rendered by the current renderer.
      const legacy = (frozen.draft.snapshot as { version: number }).version === 1;
      const archive = legacy ? (await Promise.all(frozen.parts.map((message) => this.formatPost(context, message)))).join("") : archiveOf(frozen.parts);
      if (digest(frozen.markdown) !== frozen.sha256 || frozen.parts.join("") !== frozen.draft.markdown
        || (!legacy && await renderSprintRetro(frozen.draft.snapshot, frozen.draft.narrative, frozen.draft.generation) !== frozen.draft.markdown)
        // Without a re-render, a legacy archive must at least carry nothing the redactor would remove.
        || (legacy && redactSecrets(frozen.markdown) !== frozen.markdown)
        || archive !== frozen.markdown) throw new Error("Frozen retrospective content failed verification.");
    }
    return record;
  }
  private async save(context: CeremonyContext, record: RetroPublicationRecord): Promise<void> {
    await context.store.saveRuntime(retroRuntimeName(context.goal.id), record);
  }

  private async advance(context: CeremonyContext, record: RetroPublicationRecord, reserved = false): Promise<CeremonyProgress<PublishedRetroEvidence>> {
    if (!record.frozen) {
      const failures = record.attempts.length;
      const finite = context.goal.workflowModel === "goals-v1" || !!record.correction;
      const retry = finite ? freshDraftRetry(context, record) : undefined;
      if (failures && finite && !retry && !reserved) {
        record.failure = draftFailure(record); await this.save(context, record);
        return pending(record.failure.message, record.failure);
      }
      if (failures && !finite) {
        const last = record.attempts.at(-1)!;
        const retryAt = Date.parse(last.finishedAt ?? last.startedAt) + retroRetryDelayMs(failures);
        if (!(Date.now() >= retryAt)) return pending(`Chick's retrospective draft failed or was interrupted ${failures} time(s); the next attempt starts after ${new Date(Number.isFinite(retryAt) ? retryAt : Date.now()).toISOString()}.`);
      }
      if (record.correction) {
        const previous = record.revisions![record.correction.revision];
        const proof = await this.archive.inspectRetroPr(record.github, context.goal.id, previous.frozen.markdown, previous.prUrl);
        if (proof.state !== "OPEN" || proof.headSha !== previous.headSha || JSON.stringify(proof.rejection) !== JSON.stringify(previous.rejection)) throw new Error("The rejected publication changed before correction drafting.");
        await this.verifyPosts(context, previous);
      }
      // The final attempt of each frozen revision succeeded; only real failures precede it.
      const prior = priorRetroAttempts([...record.revisions?.flatMap((revision) => revision.attempts.slice(0, -1)) ?? [], ...record.attempts.slice(0, reserved ? -1 : undefined)]);
      if (!reserved) record.attempts.push({ startedAt: new Date().toISOString(), ...(retry ? { retry } : {}) });
      await this.save(context, record);
      const attempt = record.attempts.at(-1)!;
      let draft: SprintRetroDraft;
      try { draft = await this.draft(context, prior); }
      catch (error) {
        attempt.finishedAt = new Date().toISOString();
        if (error instanceof RetroGenerationError) { attempt.generation = error.generation; attempt.errorKind = error.kind; }
        else attempt.errorKind = "draft-error";
        if (finite) record.failure = draftFailure(record);
        await this.save(context, record);
        return pending(record.failure?.message ?? "Chick's retrospective draft failed or was interrupted; it will be retried with backoff.", record.failure);
      }
      if (draft.snapshot.goalId !== context.goal.id || draft.snapshot.leadSeatId !== context.goal.seatId || draft.markdown !== await renderSprintRetro(draft.snapshot, draft.narrative, draft.generation)
        || (record.correction && draft.markdown === record.revisions![record.correction.revision].frozen.markdown)) {
        Object.assign(attempt, { finishedAt: new Date().toISOString(), errorKind: "unverified-content", generation: draft.generation });
        if (finite) record.failure = draftFailure(record);
        await this.save(context, record);
        throw new Error("Retrospective content was not rendered from this goal's recorded facts.");
      }
      const messages = parts(draft.markdown);
      // The Chick chat adds its persona attribution to each thread post; verifyPosts expects exactly that.
      // The archive keeps the frozen parts only, so no attribution lines appear between fragments.
      const markdown = archiveOf(messages);
      attempt.finishedAt = new Date().toISOString();
      attempt.generation = draft.generation;
      record.frozen = { draft, parts: messages, markdown, sha256: digest(markdown) };
      delete record.failure;
      await this.save(context, record);
    }
    const frozen = record.frozen;
    const postIds: string[] = [];
    for (const [index, message] of frozen.parts.entries()) postIds.push(await context.post(`retro-content:${frozen.sha256}:${index}`, message));
    record.postIds = postIds;
    if (record.correction) {
      const previous = record.revisions![record.correction.revision];
      if (!record.correction.notice) {
        const team = ((await context.store.read()).teams as { id: string; slug?: string }[]).find((team) => team.id === context.goal.teamId);
        const links = previous.postIds.flatMap((id) => { const url = mattermostPostUrl(team?.slug, id); return url ? [`[earlier thread part](${url})`] : []; });
        record.correction.notice = { message: `**Corrected retrospective: ${context.goal.id}**\nThis publication supersedes the [earlier frozen retrospective](https://github.com/${record.github}/blob/${previous.headSha}/${retroPath(context.goal.id)}) (${previous.frozen.sha256}) after review ${previous.rejection.reviewId} requested corrections.${links.length ? ` Earlier posts: ${links.join(", ")}.` : ""} Historical posts remain unchanged. The corrected archive still requires a fresh current-head review and passing CI.` };
        await this.save(context, record);
      }
      record.correction.notice.postId = await context.post(`retro-correction:${previous.frozen.sha256}:${frozen.sha256}`, record.correction.notice.message);
    }
    await this.save(context, record);
    await this.verifyPosts(context, record);
    if (record.correction) {
      const previous = record.revisions![record.correction.revision];
      try {
        if (!this.archive.correctRetroPr) throw new Error("The archive correction adapter is unavailable.");
        record.correction.resultHeadSha = await this.archive.correctRetroPr(record.github, context.goal.id, previous.frozen.markdown, frozen.markdown, previous.prUrl, previous.rejection);
        record.prUrl = previous.prUrl;
        delete record.failure;
      } catch {
        record.failure = { at: record.correction.retry.at, message: `The corrected retrospective for ${context.goal.id} is frozen; its guarded archive update needs reconciliation. Preserve both revisions and resolve the PR head or publication problem.`, retryable: true };
        await this.save(context, record); return pending(record.failure.message, record.failure);
      }
    } else record.prUrl = await this.archive.ensureRetroPr(record.github, context.goal.id, frozen.markdown);
    await this.save(context, record);
    let pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
    if (pr.url !== record.prUrl) return pending("The inspected archival PR does not match this publication.");
    if (record.correction && pr.headSha !== record.correction.resultHeadSha) {
      record.failure = { at: record.correction.retry.at, message: `The corrected retrospective head for ${context.goal.id} changed after its guarded update; reconcile the PR before publication can finish.`, retryable: true };
      await this.save(context, record); return pending(record.failure.message, record.failure);
    }
    if (pr.state === "CLOSED") return pending("The retrospective PR is closed without merging; the owner must resolve it before the goal can close.");
    if (pr.state === "OPEN") {
      const announcedAt = record.gate?.headSha === pr.headSha ? record.gate.announcedAt : new Date().toISOString();
      // Save the start of the announcement before delivery; a reaction received during a lost response is fresh.
      if (record.gate?.headSha !== pr.headSha) {
        record.gate = { headSha: pr.headSha, postId: "", announcedAt };
        await this.save(context, record);
      }
      const postId = await context.post(`retro-merge:${pr.headSha}`, `**Retrospective archive: ${context.goal.id}**\n${pr.url}\n\nOnly \`${retroPath(context.goal.id)}\` may change. A fresh review and passing CI are required. It merges automatically once the current head is approved and CI passes. Suggested process changes remain proposals for the owner.`, "retro");
      record.gate = { headSha: pr.headSha, postId, announcedAt };
      await this.save(context, record);
      if (!pr.reviewed && !pr.rejection) {
        await this.review(context, record, pr);
        pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
      }
      if (pr.state === "OPEN" && pr.rejection) {
        record.failure = { at: pr.rejection.submittedAt, message: `The retrospective archive for ${context.goal.id} was rejected by satori-miyamoto on its current head (review ${pr.rejection.reviewId}); resolve the findings and run planning retry --goal ${context.goal.id} to publish a corrected revision.`, retryable: true };
        const retry = freshDraftRetry(context, record, pr.rejection.submittedAt);
        if (!retry || !this.archive.correctRetroPr) { await this.save(context, record); return pending(record.failure.message, record.failure); }
        await this.verifyPosts(context, record);
        const revision: RetroPublicationRevision = structuredClone({ frozen, attempts: record.attempts, postIds, prUrl: pr.url, headSha: pr.headSha, rejection: pr.rejection,
          supersededAt: retry.at, gate: record.gate, review: record.review, authorization: record.authorization, correction: record.correction });
        (record.revisions ??= []).push(revision);
        record.correction = { revision: record.revisions.length - 1, retry };
        record.attempts = [{ startedAt: new Date().toISOString(), retry }];
        delete record.frozen; delete record.postIds; delete record.gate; delete record.review; delete record.authorization; delete record.verifiedAt; delete record.stageTimings;
        // The intent, immutable source revision and consumed retry are one write before any correction model work.
        await this.save(context, record);
        return await this.advance(context, record, true);
      }
      delete record.failure;
      await this.save(context, record);
      if (pr.state === "OPEN" && pr.reviewed && pr.checksPassed) {
        await this.verifyPosts(context, record);
        const merge = await this.archive.mergeRetroPr(record.github, context.goal.id, frozen.markdown, pr.url, pr.headSha);
        pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
        if (!merge.merged && pr.state !== "MERGED") return pending(merge.reason);
      }
      if (pr.state !== "MERGED") return pending(!pr.reviewed ? "The retrospective archive needs a fresh review on its current head." : !pr.checksPassed ? "The retrospective archive is waiting for passing CI." : "The archival merge is pending verification.");
    }
    if (!pr.reviewed || !pr.checksPassed || !pr.mergedSha) return pending("The archival merge still needs current-head review and passing CI.");
    await this.verifyPosts(context, record);
    record.verifiedAt ??= new Date().toISOString();
    record.stageTimings = context.goal.ceremony!.history.map((entry, index, history) => {
      const throughAt = index + 1 < history.length ? history[index + 1].enteredAt : record.verifiedAt!;
      return { stage: entry.stage, enteredAt: entry.enteredAt, throughAt, elapsedMs: entry.enteredAt === null || throughAt === null ? null : Date.parse(throughAt) - Date.parse(entry.enteredAt) };
    });
    await this.save(context, record);
    return { status: "complete", evidence: { kind: "retro-published", path: retroPath(context.goal.id), prUrl: pr.url, baseBranch: "main", mergedSha: pr.mergedSha,
      postId: postIds.at(-1)!, publishedAt: record.verifiedAt, factsOnly: true, suggestions: "owner-proposals-only" } };
  }

  async poll(context: CeremonyContext): Promise<CeremonyProgress<PublishedRetroEvidence>> {
    let retained: RetroPublicationRecord | undefined;
    try {
      const record = await this.load(context); retained = record;
      return await this.advance(context, record);
    } catch {
      const record = retained;
      if (record && (context.goal.workflowModel === "goals-v1" || record.correction) && !record.frozen && record.attempts.length) {
        record.failure = draftFailure(record);
        // A lost reservation acknowledgement still blocks replay. A later turn recovers from the retained attempt.
        try { await this.save(context, record); } catch { /* Preserve the blocker even when the runtime journal is unavailable. */ }
        return pending(record.failure.message, record.failure);
      }
      // Neither provider diagnostics nor local paths may enter a thread or the state journal.
      return pending("Retrospective publication or archival verification is pending; retry after resolving the delivery or PR problem.");
    }
  }

  /** Compatibility retry; authorization is the approved goal, never a second human action. */
  async merge(context: CeremonyContext, _historicalApproval?: HumanApproval): Promise<string> {
    const result = await this.poll({ ...context, event: { kind: "retry", id: `retro-merge-retry:${randomUUID()}`, teamId: context.goal.teamId, goalId: context.goal.id,
      at: new Date().toISOString(), reason: "Explicit planning merge compatibility retry" } });
    if (result.status === "pending") throw new Error(result.reason);
    return `Retrospective archive merged: ${result.evidence.prUrl}. Closure follows verified thread delivery and archival merge.`;
  }

}

interface DeveloperJournalEvidence { version: number; goalId: string; seatId: string; planning: GoalAgentSession[]; lanes: Record<string, { sessions: GoalAgentSession[] }> }
type RetroSessionFact = RetroInput["facts"]["sessions"][number];

/** Developer turns persisted by runGoalAgent. Wall time is their interval union, only when every turn completed with runtime facts. */
async function developerJournalFacts(store: PlanningStore, goalId: string, seatId: string): Promise<{ sessions: RetroSessionFact[]; wallTimeMs: number | null; missing: string[] }> {
  const journal = await store.readRuntimeFile<DeveloperJournalEvidence>(developerGoalJournalName(goalId));
  if (!journal) return { sessions: [], wallTimeMs: null, missing: ["The Developer goal journal is unavailable, and the public goal record does not contain Developer invocation timings or token counters; these remain unknown."] };
  const lanes = journal.lanes && typeof journal.lanes === "object" ? Object.entries(journal.lanes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : null;
  if (journal.version !== 1 || journal.goalId !== goalId || journal.seatId !== seatId || !Array.isArray(journal.planning) || !lanes || lanes.some(([, lane]) => !Array.isArray(lane?.sessions))) {
    return { sessions: [], wallTimeMs: null, missing: [`${seatId}: the Developer goal journal belongs to another goal or seat or is malformed; Developer invocation timings and token counters remain unknown.`] };
  }
  const sessions: RetroSessionFact[] = []; const missing: string[] = []; const intervals: [number, number][] = [];
  const turns = [...journal.planning.map((turn) => ({ turn, where: "planning" })), ...lanes.flatMap(([laneId, lane]) => lane.sessions.map((turn) => ({ turn, where: `lane ${laneId}` })))];
  for (const { turn, where } of turns) {
    const facts = turn?.status === "complete" ? turn.result?.facts : undefined;
    const started = Date.parse(facts?.startedAt ?? ""); const finished = Date.parse(facts?.finishedAt ?? "");
    if (!facts || !Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
      missing.push(`${seatId}: a Developer ${typeof turn?.role === "string" ? turn.role : "agent"} turn in ${where} ${turn?.status === "complete" ? "has no recorded runtime facts" : "was interrupted or failed without recorded timing or usage"}; wall time remains unknown.`);
      continue;
    }
    sessions.push({ seatId, sessionId: facts.sessionId ?? turn.result!.sessionId ?? "unknown", invocationId: facts.invocationId, startedAt: facts.startedAt, finishedAt: facts.finishedAt, usage: facts.usage ?? null });
    intervals.push([started, finished]);
  }
  if (!turns.length) missing.push(`${seatId}: the Developer goal journal records no agent turns; wall time remains unknown.`);
  if (missing.length) return { sessions, wallTimeMs: null, missing };
  let wallTimeMs = 0; let end = -Infinity;
  for (const [start, finish] of intervals.sort((a, b) => a[0] - b[0])) {
    if (finish <= end) continue;
    wallTimeMs += finish - Math.max(start, end); end = finish;
  }
  return { sessions, wallTimeMs, missing };
}

/** Read only persisted evidence. Missing attempt coverage and unrecorded wall time stay explicitly unknown. */
export async function recordedRetroInput(context: CeremonyContext, retroAttempts: RetroPriorAttempt[] = [], github = new SprintGitHub(processShell, context.store.runtimeDir)): Promise<RetroInput> {
  const { goal, store } = context;
  const record = await store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(goal.id));
  const facts: RetroInput["facts"] = structuredClone(record?.facts ?? { seats: [], sessions: [], reviews: [], rounds: [], failures: [] });
  const missing: string[] = [];
  if (!record) missing.push("Chick's historical ceremony runtime record is unavailable.");
  if (goal.workflowModel === "goals-v1") {
    const release = goal.ceremony?.history.find((entry) => entry.stage === "release");
    const delivered = release?.evidence.kind === "implementation" ? release.evidence.goalDelivery : undefined;
    const report = validateGoalReport(delivered);
    const runtime = await store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename(goal.id));
    if (runtime && (runtime.goalId !== goal.id || runtime.teamId !== goal.teamId)) throw new Error("Goal runtime evidence belongs to another goal.");
    const project = requireTeamHome(await store.read(), goal.teamId).github;
    const lanePrs = [];
    for (const proof of report.lanePrs) {
      const source = await github.prRetrospective(project, goal.id, proof.url, proof.headSha);
      for (const key of ["decisions", "followUps"] as const) {
        if (source[key] === null) missing.push(`${proof.laneId}: the merged PR has no ${key === "decisions" ? "Decisions" : "Follow-ups"} section.`);
        else if (source[key]!.length > 1800) { source[key] = `${source[key]!.slice(0, 1800)} [truncated for archive]`; missing.push(`${proof.laneId}: a long PR section was truncated for the archive.`); }
      }
      lanePrs.push(source);
      const lane = runtime?.lanes.find((lane) => lane.id === proof.laneId && lane.headSha === proof.headSha && lane.mergedSha === proof.mergedSha);
      if (lane && [lane.fixRounds, lane.conflictRounds].every((count) => Number.isSafeInteger(count) && count >= 0)) {
        facts.rounds.push({ outcomeId: lane.id, fix: lane.fixRounds, conflict: lane.conflictRounds });
        facts.reviews.push({ outcomeId: lane.id, prUrl: proof.url, findings: lane.findings.map((finding) => `${finding.path}:${finding.line}: ${finding.reason}`) });
      } else missing.push(`${proof.laneId}: complete shared lane round and finding records are unavailable.`);
    }
    const developer = await developerJournalFacts(store, goal.id, report.seatId);
    for (const session of developer.sessions) if (!facts.sessions.some((item) => item.seatId === session.seatId && item.sessionId === session.sessionId && item.startedAt === session.startedAt)) facts.sessions.push(session);
    if (!facts.seats.some((seat) => seat.seatId === report.seatId)) facts.seats.push({ seatId: report.seatId, wallTimeMs: developer.wallTimeMs });
    if (!facts.seats.some((seat) => seat.seatId === goal.seatId)) facts.seats.push({ seatId: goal.seatId, wallTimeMs: null });
    missing.push(...developer.missing, "Lane findings are the latest recorded verdict, not a complete history of earlier reviews.");
    const releaseAttempts = await store.readRuntimeFile<ReleaseAttempts>(releaseAttemptsName(goal.id));
    if (!releaseAttempts) missing.push("Integration conflict and merge-attempt history is unavailable.");
    return { goal, facts, cutoffAt: new Date().toISOString(), missing, retroAttempts, lanePrs, releaseAttempts };
  }
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
  const implementation = await readImplementationFacts(store, goal.id);
  return { goal, facts, cutoffAt: new Date().toISOString(), missing, implementation, retroAttempts };
}

/** Discovered by cli.ts's existing module extension point; no shared wiring changes are needed. */
export async function createCeremonyAdapters({ store }: { store: PlanningStore }): Promise<CeremonyAdapters> {
  const profiles = await loadSeatPersonas(import.meta.url);
  const runtimeFor = async (context: CeremonyContext, cwd: string) => {
    const state = await store.read();
    const all = (state.teams as { seats: { id: string; roles?: string[] }[] }[]).flatMap((team) => team.seats);
    const engines = await loadSeatEngines(store.runtimeDir, all.map((seat) => seat.id));
    const roles = all.find((seat) => seat.id === context.goal.seatId)?.roles;
    return new SeatRuntime(engines[context.goal.seatId] ?? "codex", cwd, undefined, undefined, undefined, seatHarnessDir(store.runtimeDir, context.goal.seatId), roles);
  };
  const retro = new RetroPublication(new SprintGitHub(processShell, store.runtimeDir), async (context, prior) => {
    const state = await store.read();
    const all = (state.teams as { seats: { id: string; roles?: string[] }[] }[]).flatMap((team) => team.seats);
    const engines = await loadSeatEngines(store.runtimeDir, all.map((seat) => seat.id));
    const roles = all.find((seat) => seat.id === context.goal.seatId)?.roles;
    const input = await recordedRetroInput(context, prior);
    return await draftSprintRetro(input, (cwd) => {
      const runtime = withPersonaRuntime(new SeatRuntime(engines[context.goal.seatId] ?? "codex", cwd, undefined, undefined, undefined, seatHarnessDir(store.runtimeDir, context.goal.seatId), roles), profiles[context.goal.seatId]);
      return { message: async (...args) => {
        try { const run = await runtime.message(...args); await context.recordRun(run); return run; }
        catch (error) { if (error instanceof AgentRunError) await context.recordSession(error.facts); throw error; }
      } };
    });
  }, {
    formatPost: async (context, message) => personaPost(message, profiles[context.goal.seatId]),
    thread: async (context) => {
      const chat = new MattermostPlanningChat(await readChickToken(await opCredential(store.checkout)), CHICK_USERNAME);
      return { ownUserId: await chat.ownUserId(), posts: await chat.since(context.goal.mattermost.channelId, Date.parse(context.goal.createdAt) - 5000) };
    },
    review: async (context, cwd, pr) => {
      const runtime = await runtimeFor(context, cwd);
      try {
        const run = await runtime.message(`You are a fresh reviewer in Indra. You did not draft this retrospective. Review ${pr.url} at HEAD ${pr.headSha} against AGENTS.md and the recorded facts in docs/retros/${context.goal.id}.md. Inspect the diff against origin/main. Flag only real bugs or project-rule violations, with the document path, line and a one-line reason; never style or naming. Suggestions must remain owner proposals. You are read-only without network. Do not edit files, commit, push, merge or post. Never include credentials in output. Indra will post your line comments and an approval or changes-requested verdict. Return JSON: summary and findings (path, line, reason; empty when there are none).`, schemaPathOf(import.meta.url, "retro-review.json"), undefined, { purpose: "review" });
        await context.recordRun(run);
        return run.response;
      } catch (error) { if (error instanceof AgentRunError) await context.recordSession(error.facts); throw error; }
    },
  });
  return { retro };
}
