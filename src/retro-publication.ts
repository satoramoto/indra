import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { assertCurrentAutomaticApproval, recordAutomaticApproval, ceremonyRuntimeName, type BridgeCeremonyRecord, type CeremonyAdapters, type CeremonyContext, type CeremonyProgress, type Post } from "./planning-bridge.js";
import { type ApprovalProvenance, type CeremonyStage, type PublishedRetroEvidence, validateCeremony } from "./ceremony.js";
import type { CeremonyWriteReadiness } from "./ceremony-ports.js";
import { requireTeamHome, type PlanningStore } from "./planning.js";
import type { SeatTaskRecord } from "./developer-seat.js";
import { processShell } from "./command-shell.js";
import { seatRecordName } from "./developer-maintenance.js";
import { retroPath, SprintGitHub, type RetroArchive, type RetroPr, type RetroReview } from "./sprint.js";
import { draftSprintRetro, renderSprintRetro, RetroGenerationError, type RetroGeneration, type RetroInput, type RetroPriorAttempt, type SprintRetroDraft } from "./sprint-retro.js";
import { readImplementationFacts } from "./implementation-facts.js";
import { loadSeatEngines, SeatRuntime } from "./seat-runtime.js";
import { seatHarnessDir } from "./harness-home.js";
import { loadSeatPersonas, personaPost, withPersonaRuntime } from "./seat-persona.js";
import { AgentRunError } from "./runtime-facts.js";
import { CHICK_USERNAME, MattermostPlanningChat, readChickToken } from "./planning-mattermost.js";
import { opCredential } from "./service-account.js";
import { schemaPathOf } from "./reload.js";
import { redactSecrets } from "./redact.js";
import { reviewIntegration } from "./integration-review.js";

/** The store still checks the companion schema before writing any ceremony state. */
export const ceremonyReadiness: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
export const retroRuntimeName = (goalId: string) => { retroPath(goalId); return `retro-publication-${goalId}`; };
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const pending = (reason: string): CeremonyProgress<PublishedRetroEvidence> => ({ status: "pending", reason });

export interface RetroPublicationRecord {
  version: 1; goalId: string; github: string;
  /** Older records have neither finishedAt nor errorKind; a missing finishedAt on a new attempt means it was aborted. */
  attempts: { startedAt: string; finishedAt?: string; errorKind?: string; generation?: RetroGeneration }[];
  frozen?: { draft: SprintRetroDraft; parts: string[]; markdown: string; sha256: string };
  postIds?: string[];
  prUrl?: string;
  gate?: { headSha: string; postId: string; announcedAt: string };
  authorization?: { headSha: string; prUrl: string; postId: string; approval: ApprovalProvenance };
  review?: { headSha: string; result: RetroReview };
  verifiedAt?: string;
  /** Final completion timing, recorded before returning closure proof; the bridge journals closedAt from state. */
  stageTimings?: { stage: CeremonyStage; enteredAt: string | null; throughAt: string | null; elapsedMs: number | null }[];
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

  private async verifyPosts(context: CeremonyContext, record: RetroPublicationRecord): Promise<void> {
    const { frozen, postIds } = record;
    if (!frozen || !postIds?.length || postIds.length !== frozen.parts.length || new Set(postIds).size !== postIds.length) throw new Error("Retrospective fragments are incomplete.");
    const { ownUserId, posts } = await this.services.thread(context);
    for (const [index, id] of postIds.entries()) {
      const post = posts.find((item) => item.id === id);
      if (!ownUserId || !post || post.delete_at || post.user_id !== ownUserId || post.channel_id !== context.goal.mattermost.channelId
        || post.root_id !== context.goal.mattermost.rootPostId || post.message !== await this.formatPost(context, frozen.parts[index])) throw new Error("Retrospective fragment delivery or content is unverified.");
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
    if (record.frozen) {
      const frozen = record.frozen;
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

  async poll(context: CeremonyContext): Promise<CeremonyProgress<PublishedRetroEvidence>> {
    try {
      const record = await this.load(context);
      if (!record.frozen) {
        const failures = record.attempts.length;
        if (failures) {
          const last = record.attempts.at(-1)!;
          const retryAt = Date.parse(last.finishedAt ?? last.startedAt) + retroRetryDelayMs(failures);
          if (!(Date.now() >= retryAt)) return pending(`Chick's retrospective draft failed or was interrupted ${failures} time(s); the next attempt starts after ${new Date(Number.isFinite(retryAt) ? retryAt : Date.now()).toISOString()}.`);
        }
        const prior = priorRetroAttempts(record.attempts);
        record.attempts.push({ startedAt: new Date().toISOString() });
        await this.save(context, record);
        const attempt = record.attempts.at(-1)!;
        let draft: SprintRetroDraft;
        try { draft = await this.draft(context, prior); }
        catch (error) {
          attempt.finishedAt = new Date().toISOString();
          if (error instanceof RetroGenerationError) { attempt.generation = error.generation; attempt.errorKind = error.kind; }
          else attempt.errorKind = "draft-error";
          await this.save(context, record);
          return pending("Chick's retrospective draft failed or was interrupted; it will be retried with backoff.");
        }
        if (draft.snapshot.goalId !== context.goal.id || draft.snapshot.leadSeatId !== context.goal.seatId || draft.markdown !== await renderSprintRetro(draft.snapshot, draft.narrative, draft.generation)) {
          Object.assign(attempt, { finishedAt: new Date().toISOString(), errorKind: "unverified-content", generation: draft.generation });
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
        await this.save(context, record);
      }
      const frozen = record.frozen;
      const postIds: string[] = [];
      for (const [index, message] of frozen.parts.entries()) postIds.push(await context.post(`retro-content:${frozen.sha256}:${index}`, message));
      record.postIds = postIds;
      await this.save(context, record);
      await this.verifyPosts(context, record);
      record.prUrl = await this.archive.ensureRetroPr(record.github, context.goal.id, frozen.markdown);
      await this.save(context, record);
      let pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
      if (pr.state === "CLOSED") return pending("The retrospective PR is closed without merging; the owner must resolve it before the goal can close.");
      if (pr.state === "OPEN") {
        const announcedAt = record.gate?.headSha === pr.headSha ? record.gate.announcedAt : new Date().toISOString();
        // Save the start of the announcement before delivery; a reaction received during a lost response is fresh.
        if (record.gate?.headSha !== pr.headSha) {
          delete record.authorization;
          record.gate = { headSha: pr.headSha, postId: "", announcedAt };
          await this.save(context, record);
        }
        const postId = await context.post(`retro-merge:${pr.headSha}`, `**Retrospective archive: ${context.goal.id}**\n${pr.url}\n\nOnly \`${retroPath(context.goal.id)}\` may change. A fresh review and passing CI are required. React ✅ on this post or use \`planning merge --goal ${context.goal.id}\` (M) to authorize this archive. Earlier plan and release approvals do not apply. Suggested process changes remain proposals for the owner.`, "retro");
        record.gate = { headSha: pr.headSha, postId, announcedAt };
        await this.save(context, record);
        await context.releaseEvent?.({ key: `retro-head:${pr.headSha}:${announcedAt}`, kind: "head-observed", at: announcedAt, gate: "retro", prUrl: pr.url, headSha: pr.headSha });
        if (!pr.reviewed) {
          await context.releaseEvent?.({ key: `retro-review-started:${pr.headSha}`, kind: "review-started", at: new Date().toISOString(), gate: "retro", prUrl: pr.url, headSha: pr.headSha });
          await this.review(context, record, pr);
          await context.releaseEvent?.({ key: `retro-review-finished:${pr.headSha}`, kind: "review-finished", at: new Date().toISOString(), gate: "retro", prUrl: pr.url, headSha: pr.headSha });
          pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
        }
        if (pr.state === "OPEN" && record.authorization?.approval.source === "automatic") {
          try { await this.checkPolicy(context, record.authorization.approval); }
          catch {
            // A revoked pending write needs a new authorization; keep receipts for merges already accepted.
            delete record.authorization;
            await this.save(context, record);
          }
        }
        if (pr.state === "OPEN" && !this.authorized(record, pr) && pr.headSha === record.gate.headSha && pr.reviewed && pr.checksPassed && context.automaticGate) {
          const approval = await context.automaticGate({ kind: "retro", pr, postId: record.gate.postId });
          if (approval) {
            await this.merge(context, approval);
            context = { ...context, goal: (await context.store.read()).planningGoals!.find((goal) => goal.id === context.goal.id)! };
            Object.assign(record, await this.load(context));
            pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl!);
          }
        }
        if (pr.state === "OPEN" && this.authorized(record, pr) && pr.reviewed && pr.checksPassed) {
          await this.checkPolicy(context, record.authorization!.approval);
          await this.verifyPosts(context, record);
          await this.mergeArchive(context, record, pr);
          pr = await this.archive.inspectRetroPr(record.github, context.goal.id, frozen.markdown, record.prUrl);
        }
        if (pr.state !== "MERGED") return pending(!pr.reviewed ? "The retrospective archive needs a fresh review on its current head." : !pr.checksPassed ? "The retrospective archive is waiting for passing CI." : this.authorized(record, pr) ? "The authorized archival merge is pending; it will be retried." : "The retrospective archive is waiting for a new human checkmark or the owner's M.");
      }
      if (!this.authorized(record, pr) || !pr.reviewed || !pr.checksPassed || !pr.mergedSha) return pending("The archival merge still needs verified human authorization, current-head review and passing CI.");
      await this.verifyPosts(context, record);
      record.verifiedAt ??= new Date().toISOString();
      record.stageTimings = context.goal.ceremony!.history.map((entry, index, history) => {
        const throughAt = index + 1 < history.length ? history[index + 1].enteredAt : record.verifiedAt!;
        return { stage: entry.stage, enteredAt: entry.enteredAt, throughAt, elapsedMs: entry.enteredAt === null || throughAt === null ? null : Date.parse(throughAt) - Date.parse(entry.enteredAt) };
      });
      await this.save(context, record);
      await context.releaseEvent?.({ key: `retro-merged:${pr.mergedSha}`, kind: "merged", at: record.verifiedAt, gate: "retro", prUrl: pr.url, headSha: pr.headSha, mergedSha: pr.mergedSha });
      return { status: "complete", evidence: { kind: "retro-published", path: retroPath(context.goal.id), prUrl: pr.url, baseBranch: "main", mergedSha: pr.mergedSha,
        postId: postIds.at(-1)!, publishedAt: record.verifiedAt, factsOnly: true, suggestions: "owner-proposals-only",
        authorization: { headSha: record.authorization!.headSha, mergePostId: record.authorization!.postId, approval: record.authorization!.approval } } };
    } catch {
      // Neither provider diagnostics nor local paths may enter a thread or the state journal.
      return pending("Retrospective publication or archival verification is pending; retry after resolving the delivery or PR problem.");
    }
  }

  private authorized(record: RetroPublicationRecord, pr: RetroPr): boolean {
    const authorization = record.authorization;
    return !!authorization && authorization.prUrl === pr.url && authorization.headSha === pr.headSha && authorization.postId === record.gate?.postId && record.gate.headSha === pr.headSha;
  }

  private async checkPolicy(context: CeremonyContext, approval: ApprovalProvenance): Promise<void> {
    if (approval.source !== "automatic") return;
    if (!context.automaticGate) throw new Error("The automatic archival adapter is absent.");
    assertCurrentAutomaticApproval(await context.store.read(), context.goal, approval);
  }

  private async mergeArchive(context: CeremonyContext, record: RetroPublicationRecord, pr: RetroPr) {
    return await this.archive.mergeRetroPr(record.github, context.goal.id, record.frozen!.markdown, pr.url, pr.headSha, async () => {
      await context.releaseEvent?.({ key: `retro-merge:${randomUUID()}`, kind: "merge-requested", at: new Date().toISOString(), gate: "retro", prUrl: pr.url, headSha: pr.headSha });
      await this.checkPolicy(context, record.authorization!.approval);
    });
  }

  /** Human and policy authorization share the delivery, review, CI and pinned-head merge checks. */
  async merge(context: CeremonyContext, approval: ApprovalProvenance): Promise<string> {
    let record = await this.load(context);
    // The bridge may consume a reaction immediately after recovering its outbox, before our next poll.
    if (record.gate && !record.gate.postId) { await this.poll(context); record = await this.load(context); }
    if (!record.frozen || !record.prUrl || !record.gate?.postId || !record.postIds?.length) throw new Error("Publish the retrospective and its archival PR before approving its merge.");
    const pr = await this.archive.inspectRetroPr(record.github, context.goal.id, record.frozen.markdown, record.prUrl);
    if (pr.state === "MERGED" && this.authorized(record, pr) && pr.reviewed && pr.checksPassed) return `Retrospective archive is already merged: ${pr.url}.`;
    if (pr.state !== "OPEN" || pr.headSha !== record.gate.headSha) throw new Error("The retrospective PR changed or is closed; reconcile it before a new approval.");
    const release = context.goal.ceremony!.history.find((entry) => entry.stage === "retro")!;
    if (!Number.isFinite(Date.parse(approval.at)) || Date.parse(approval.at) < Date.parse(record.gate.announcedAt) || Date.parse(approval.at) < Date.parse(release.enteredAt ?? context.goal.createdAt)
      || (approval.source === "owner-command" ? approval.command !== "planning merge" : approval.source === "reaction" ? approval.emoji !== "white_check_mark" || approval.verifiedHuman !== true || approval.postId !== record.gate.postId
        : approval.target.kind !== "retro" || approval.target.prUrl !== pr.url || approval.target.headSha !== pr.headSha)) throw new Error("The archive requires a new human checkmark on its own post, the owner's M, or matching policy authorization.");
    if (!pr.reviewed || !pr.checksPassed) throw new Error("The retrospective archive needs a fresh current-head review and passing CI before merging.");
    await this.verifyPosts(context, record);
    await this.checkPolicy(context, approval);
    if (approval.source === "automatic") await recordAutomaticApproval(context.store, context.goal.id, approval);
    record.authorization = { headSha: pr.headSha, prUrl: pr.url, postId: record.gate.postId, approval };
    await this.save(context, record);
    const result = await this.mergeArchive(context, record, pr);
    if (!result.merged) throw new Error(result.reason);
    return `Retrospective archive merged: ${pr.url}. Closure follows verified thread delivery and archival merge.`;
  }
}

/** Read only persisted evidence. Missing attempt coverage and unrecorded wall time stay explicitly unknown. */
export async function recordedRetroInput(context: CeremonyContext, retroAttempts: RetroPriorAttempt[] = []): Promise<RetroInput> {
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
  const implementation = await readImplementationFacts(store, goal.id);
  return { goal, facts, cutoffAt: new Date().toISOString(), missing, implementation, retroAttempts };
}

/** Discovered by cli.ts's existing module extension point; no shared wiring changes are needed. */
export async function createCeremonyAdapters({ store }: { store: PlanningStore }): Promise<CeremonyAdapters> {
  const profiles = await loadSeatPersonas(import.meta.url);
  const runtimeFor = async (context: CeremonyContext, cwd: string) => {
    const state = await store.read();
    const seats = (state.teams as { seats: { id: string }[] }[]).flatMap((team) => team.seats).map((seat) => seat.id);
    const engines = await loadSeatEngines(store.runtimeDir, seats);
    return new SeatRuntime(engines[context.goal.seatId] ?? "codex", cwd, undefined, undefined, undefined, seatHarnessDir(store.runtimeDir, context.goal.seatId));
  };
  const retro = new RetroPublication(new SprintGitHub(processShell, store.runtimeDir), async (context, prior) => {
    const state = await store.read();
    const seats = (state.teams as { seats: { id: string }[] }[]).flatMap((team) => team.seats).map((seat) => seat.id);
    const engines = await loadSeatEngines(store.runtimeDir, seats);
    const input = await recordedRetroInput(context, prior);
    return await draftSprintRetro(input, (cwd) => {
      const runtime = withPersonaRuntime(new SeatRuntime(engines[context.goal.seatId] ?? "codex", cwd, undefined, undefined, undefined, seatHarnessDir(store.runtimeDir, context.goal.seatId)), profiles[context.goal.seatId]);
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
  return { retro, integrationReview: reviewIntegration };
}
