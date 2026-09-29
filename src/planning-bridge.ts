import { join } from "node:path";
import { withFileLock } from "./state-commit.js";
import { advanceCeremony, closeCeremony, type CeremonyStage, type HumanApproval, type ImplementationEvidence, type PublishedRetroEvidence, type RunningReleaseEvidence } from "./ceremony.js";
import type { CeremonyRuntimeRecord } from "./ceremony-ports.js";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./codex-runtime.js";
import type { RuntimeSessionFacts } from "./runtime-facts.js";
import { schemaPathOf } from "./reload.js";
import { CLARIFY_TIMEOUT_MS, DRAFT_TIMEOUT_MS, planningId } from "./codex-runtime.js";
import { PlanningStore, developerSeats, missingTeamMessage, requireTeamHome, teamProject, validateOutcomeSeats, type MergeKind, type PlanningDocument, type PlanningGoal, type RuntimeRecord, type SprintIntegration } from "./planning.js";
import { processShell, type Shell } from "./developer-seat.js";
import { SprintGitHub, sprintBranch } from "./sprint.js";

export interface Post { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number; props?: { indra_delivery_id?: string } }
export interface Reaction { user_id: string; post_id: string; emoji_name: string; create_at: number }
export interface PlanningChat {
  ownUserId(): Promise<string>;
  post(channelId: string, message: string, rootId?: string, deliveryId?: string): Promise<Post>;
  since(channelId: string, timestamp: number): Promise<Post[]>;
  /** A post's current reactions; read with GET only. */
  reactions(postId: string): Promise<Reaction[]>;
  /** Mattermost's `is_bot` flag for the user; only a person may request or approve a proposal. */
  isBot(userId: string): Promise<boolean>;
}
type Seat = { id: string; displayName: string };

/** Local delivery/turn journals never belong in state.json. */
type BridgeMergeKind = MergeKind | "retro";
interface BridgeRecord extends Omit<RuntimeRecord, "pending" | "mergePosts"> {
  pending?: Omit<NonNullable<RuntimeRecord["pending"]>, "mergePost"> & { mergePost?: BridgeMergeKind };
  mergePosts?: { id: string; kind: BridgeMergeKind }[];
  delivered?: Record<string, string>;
  mergeApproval?: { postId: string; approval: HumanApproval };
  mergeIntent?: { kind: BridgeMergeKind; approval: HumanApproval };
  waiting?: { stage: CeremonyStage; reason: string };
  partialIntegration?: { authorizedAt: string; omissions: { outcomeId: string; seatId: string; status: string; reason: string }[] };
  initialReply?: boolean;
  turn?: { inputKey: string; since: number; drafting: boolean; startedAt: string; run?: Awaited<ReturnType<AgentRuntime["message"]>>; draft?: NonNullable<PlanningGoal["proposal"]>; failure?: { finishedAt: string; facts?: BridgeSessionFacts } };
}
interface StartIntent { goal: PlanningGoal; since: number }
/** Release/retro adapters return pending until they have verified external evidence. */
export type CeremonyProgress<T> = { status: "pending"; reason: string } | { status: "complete"; evidence: T };
export interface CeremonyContext {
  store: PlanningStore;
  goal: PlanningGoal;
  runtime: AgentRuntime;
  /** Stable keys reconcile accepted posts after crashes. Use mergePost for the retro PR's human gate. */
  post(key: string, message: string, mergePost?: "retro"): Promise<string>;
  recordRun(run: Awaited<ReturnType<AgentRuntime["message"]>>): Promise<void>;
  recordSession(facts: BridgeSessionFacts): Promise<void>;
}
export interface CeremonyAdapters {
  implementation?(context: CeremonyContext): Promise<CeremonyProgress<ImplementationEvidence>>;
  release?: { poll(context: CeremonyContext & { mergeApproval?: { postId: string; approval: HumanApproval } }): Promise<CeremonyProgress<RunningReleaseEvidence>> };
  retro?: {
    poll(context: CeremonyContext): Promise<CeremonyProgress<PublishedRetroEvidence>>;
    /** Called only from a verified human checkmark on an adapter post or the owner's M command. */
    merge?(context: CeremonyContext, approval: HumanApproval): Promise<string>;
  };
}
/** The producer contract is shared by successful results and AgentRunError.facts. */
export type BridgeSessionFacts = RuntimeSessionFacts;
function sessionFacts(value: unknown): BridgeSessionFacts | undefined {
  if (!isObject(value) || !isObject(value.facts)) return;
  const facts = value.facts;
  if (typeof facts.invocationId !== "string" || !facts.invocationId || !["codex", "claude"].includes(String(facts.engine)) || typeof facts.startedAt !== "string" || !Number.isFinite(Date.parse(facts.startedAt)) || typeof facts.finishedAt !== "string" || !Number.isFinite(Date.parse(facts.finishedAt)) || !["succeeded", "failed", "interrupted", "timed-out"].includes(String(facts.status))) return;
  const counters = (input: unknown) => !isObject(input) ? undefined : Object.fromEntries(["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"].flatMap((key) => typeof input[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= 0 ? [[key, input[key]]] : []));
  return { invocationId: facts.invocationId, engine: facts.engine as BridgeSessionFacts["engine"], ...(typeof facts.sessionId === "string" ? { sessionId: facts.sessionId } : {}), startedAt: facts.startedAt, finishedAt: facts.finishedAt, status: facts.status as BridgeSessionFacts["status"], usage: counters(facts.usage), cumulativeUsage: counters(facts.cumulativeUsage) };
}
/** Shared facts and stage event timestamps are runtime data; history in state reconstructs missing stage events. */
export interface BridgeCeremonyRecord extends CeremonyRuntimeRecord {
  stageEvents?: { stage: CeremonyStage; at: string | null }[];
  closedAt?: string;
  invocations?: (BridgeSessionFacts & { seatId: string })[];
}
export const ceremonyRuntimeName = (goalId: string) => `ceremony-${goalId}`;
const startIntentName = (teamId: string) => `planning-start-${teamId}`;

/** 📝 on Chick's goal post requests a draft proposal. */
export const PROPOSE_EMOJI = "memo";
/** ✅ on Chick's proposal post approves it. */
export const APPROVE_EMOJI = "white_check_mark";

const briefSchema = schemaPathOf(import.meta.url, "brief.json");
const proposalSchema = schemaPathOf(import.meta.url, "proposal.json");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && !!item.trim());

function brief(value: unknown): { reply: string; summary: string; decisions: string[]; openQuestions: string[] } {
  if (!isObject(value) || typeof value.reply !== "string" || typeof value.summary !== "string" || !value.summary.trim() || !stringArray(value.decisions) || !stringArray(value.openQuestions)) throw new Error("Codex returned an invalid brief response.");
  return value as { reply: string; summary: string; decisions: string[]; openQuestions: string[] };
}
function proposal(value: unknown, developers: Seat[]): NonNullable<PlanningGoal["proposal"]> {
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.outcomes) || !value.outcomes.length || !value.outcomes.every((item) => isObject(item) && typeof item.title === "string" && !!item.title.trim() && typeof item.description === "string" && !!item.description.trim() && typeof item.seatId === "string") || !stringArray(value.risks) || !stringArray(value.openQuestions)) throw new Error("Codex returned an invalid proposal.");
  const outcomes = value.outcomes.map((item, index) => ({ id: `outcome-${index + 1}`, title: item.title, description: item.description, seatId: item.seatId }));
  try { validateOutcomeSeats(outcomes, developers.map((seat) => seat.id)); }
  catch (error) { throw new Error(`Codex returned an invalid proposal: ${(error as Error).message}`, { cause: error }); }
  return { id: `proposal-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), summary: value.summary, outcomes, risks: value.risks, openQuestions: value.openQuestions };
}
function teamSeats(state: PlanningDocument, teamId: string): Map<string, string> {
  const team = (state.teams as { id: string; seats: Seat[] }[]).find((item) => item.id === teamId);
  return new Map((team?.seats ?? []).map((seat) => [seat.id, seat.displayName]));
}
function seatLabel(seats: Map<string, string>, seatId: string): string {
  return seats.has(seatId) ? `${seats.get(seatId)} (${seatId})` : seatId;
}
function rootMessage(id: string, goalText: string): string {
  return `**Planning goal ${id} — Chick**\n**Stage: planning**\n${goalText}\n\nReply here to clarify. React :${PROPOSE_EMOJI}: on this post to request a draft proposal for review.`;
}
function proposalMessage(goal: PlanningGoal, seats: Map<string, string>): string {
  const draft = goal.proposal!;
  return `**Draft proposal ${draft.id} — awaiting review**\n${draft.summary}\n${draft.outcomes.map((item) => `- **${item.title}** → ${seatLabel(seats, item.seatId)}: ${item.description}`).join("\n")}\n\nRecorded in indra-state as ${goal.id}. No work has been approved or executed. To approve it, a person reacts :${APPROVE_EMOJI}: on this post.`;
}
function approvalMessage(goal: PlanningGoal, seats: Map<string, string>): string {
  const titles = new Map(goal.proposal!.outcomes.map((item) => [item.id, item.title]));
  return `**Proposal ${goal.proposal!.id} approved**\n${(goal.assignments ?? []).map((item) => `- ${titles.get(item.outcomeId) ?? item.outcomeId} → ${seatLabel(seats, item.seatId)}`).join("\n")}\n\nRecorded in indra-state as ${goal.id}. Each outcome is queued for its Developer seat.${goal.integration ? ` Their PRs target \`${goal.integration.branch}\`; once every outcome merges, Chick opens one PR from it into main.` : ""}`;
}
function outcomeLines(goal: PlanningGoal, seats: Map<string, string>): { merged: string[]; missed: string[] } {
  const titles = new Map(goal.proposal!.outcomes.map((item) => [item.id, item.title]));
  const merged: string[] = []; const missed: string[] = [];
  for (const item of goal.assignments ?? []) {
    const head = `**${titles.get(item.outcomeId) ?? item.outcomeId}** → ${seatLabel(seats, item.seatId)}`;
    const omitted = goal.ceremony?.history.find((entry) => entry.stage === "release")?.evidence.omissions?.find((entry) => entry.outcomeId === item.outcomeId);
    if (omitted) { missed.push(`- ${head}: omitted by owner (${omitted.reason})`); continue; }
    if (item.status === "merged") merged.push(`- ${head}: ${item.prUrl ?? "merged"}`);
    else missed.push(`- ${head}: ${item.status === "failed" ? `failed${item.note ? ` (${item.note})` : ""}` : `skipped (${item.status})`}${item.prUrl ? ` ${item.prUrl}` : ""}`);
  }
  return { merged, missed };
}
/** The integration PR's body: the goal, each outcome with its seat and PR, and what failed or was skipped. */
function sprintSummary(goal: PlanningGoal, seats: Map<string, string>): string {
  const { merged, missed } = outcomeLines(goal, seats);
  return `Sprint integration for planning goal ${goal.id}.\n\n**Goal:** ${goal.goal}\n\n**Outcomes**\n${merged.join("\n") || "- none"}${missed.length ? `\n\n**Failed or skipped**\n${missed.join("\n")}` : ""}\n\nMerging this PR lands the whole sprint on main; \`planning rollback --goal ${goal.id}\` reverts it as a unit.`;
}
function integrationMessage(goal: PlanningGoal, prUrl: string): string {
  const omissions = goal.ceremony?.history.find((entry) => entry.stage === "release")?.evidence.omissions;
  const partial = omissions?.length ? `\n\n**Owner-authorized omissions**\n${omissions.map((item) => `- ${item.outcomeId}: ${item.reason}`).join("\n")}` : "";
  return `**Sprint ${goal.id} is ready: ${prUrl}**\nThis PR takes \`${sprintBranch(goal.id)}\` into main. To merge the sprint once its CI is green, a person reacts :${APPROVE_EMOJI}: on this post (or the owner presses M in Chick's detail).${partial}`;
}
function revertMessage(goal: PlanningGoal, prUrl: string): string {
  return `**Rollback of sprint ${goal.id}: ${prUrl}**\nThis PR on main reverts the sprint's merge commit ${goal.integration!.mergedSha!.slice(0, 7)}. To merge the revert once its CI is green, a person reacts :${APPROVE_EMOJI}: on this post (or the owner presses M in Chick's detail).`;
}
function nothingToApprove(goal: PlanningGoal): string {
  return `Nothing to approve: goal ${goal.id} is at the ${stageOf(goal)} stage. :${APPROVE_EMOJI}: approves only Chick's proposal post while it awaits review${goal.stage === "clarifying" ? `; react :${PROPOSE_EMOJI}: on the goal post to request one` : ""}.`;
}
/** Reactions have no ID; removing and re-adding one gives a new `create_at`, so it counts as a new request. */
const reactionKey = (reaction: Reaction) => `reaction:${reaction.post_id}:${reaction.user_id}:${reaction.emoji_name}:${reaction.create_at}`;
/** The input key of an owner approval made through `planning approve`. */
const ownerApprovalKey = (goalId: string) => `owner-approve:${goalId}`;
/** The input key of an owner proposal request made through `planning propose`. */
/** One key per owner request, so a request whose draft failed doesn't block the next one. */
const ownerProposalKey = (goalId: string, requestedAt: number) => `owner-propose:${goalId}:${requestedAt}`;
const reviewing = (goal: PlanningGoal) => goal.stage === "awaiting-review" || goal.stage === "approved";
const stageOf = (goal: PlanningGoal): CeremonyStage => goal.ceremony?.stage ?? (goal.stage === "approved" ? "implement" : goal.stage === "clarifying" ? "planning" : "proposal");
const canDraft = (goal: PlanningGoal) => !goal.ceremony?.closure && !goal.proposal && ["planning", "proposal"].includes(stageOf(goal));

/** Chick's prompts are contracts: the outcome and its acceptance, what Indra does next, the constraints and the schema. */
function prompt(goal: PlanningGoal, input: string, drafting: boolean, developers: Seat[]): string {
  const seats = developers.map((seat) => `${seat.id} (${seat.displayName})`).join(", ");
  const task = drafting
    ? `Outcome: a proposed outcome-based roadmap for this goal. This is a draft for human review.
Acceptance: each outcome is small, focused on one concern, and independently verifiable; its description states its acceptance criteria and targeted tests. Keep outcomes roughly equal in size. In each outcome's description, list every file it will touch, including test files. Outcomes assigned to different seats must not touch the same file. Name each dependency by outcome title and owning seat ID, and state the order in which dependent work must land. For any shared-file wiring, name one owning outcome and seat; list its files only under that owner and make the other outcomes depend on it. Assign every outcome to one of these Developer seats by its seat ID: ${seats || "none"}. Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.
Afterwards Indra posts the draft in the goal thread. Nothing starts until a person approves it; then Indra queues each outcome for its Developer seat.
Return only JSON with keys summary, outcomes (title, description and seatId), risks, openQuestions.`
    : `Outcome: a reply to the human message and an updated durable brief. Acceptance: decisions hold agreed facts only, and openQuestions names what is still unclear.
Afterwards Indra posts your reply in the goal thread and keeps the brief for the next message and the draft.
Return only JSON with keys reply, summary, decisions (agreed facts only), openQuestions.`;
  return `You are Chick Corea, the Team Lead seat in Indra. This is planning only.
${task}
Constraints: do not edit files, run implementation, deploy, or claim approval. Never put credentials in your output.
Goal: ${goal.goal}
Projects: ${goal.projectRefs.join(", ")}
Current brief: ${JSON.stringify(goal.brief)}
Human message: ${input}`;
}

/** One process serializes each seat. Poll cursors, handled posts and handled reactions survive restart. */
export class PlanningBridge {
  private readonly busy = new Map<string, Promise<void>>();
  private readonly github: SprintGitHub;
  /** `shell` runs gh and git for the sprint's integration branch, PR, merge and rollback. */
  constructor(private readonly store: PlanningStore, private readonly chat: PlanningChat, private readonly runtime: AgentRuntime, private readonly maxQueue = 20, private readonly shell: Shell = processShell, private readonly adapters: CeremonyAdapters = {}) {
    this.github = new SprintGitHub(shell, store.runtimeDir);
  }

  /** The team creation lock covers the reservation, remote post and state commit. */
  async start(goalText: string, participantSeatIds: string[] = []): Promise<PlanningGoal> {
    const state = await this.store.read();
    const team = (state.teams as { id: string; slug: string; seats: { id: string; externalIdentities: { mattermost: { username: string } } }[] }[]).find((item) => item.slug === "yahaha");
    const seat = team?.seats.find((item) => item.externalIdentities.mattermost.username === "chickcorea");
    if (!team || !seat) throw new Error("Chick's Yahaha seat is missing from state.");
    const { channelId, github } = requireTeamHome(state, team.id);
    if (!goalText.trim()) throw new Error("A goal is required.");
    if (new Set(participantSeatIds).size !== participantSeatIds.length || participantSeatIds.some((id) => !team.seats.some((seat) => seat.id === id))) throw new Error("A participant seat is not in Yahaha or is repeated.");
    const goal = await this.withTeamCreationLock(team.id, async () => {
      const pending = await this.store.readRuntimeFile<{ pending?: StartIntent }>(startIntentName(team.id));
      if (pending?.pending) {
        const recovered = await this.finishStart(pending.pending);
        if (recovered.goal === goalText && JSON.stringify(recovered.participantSeatIds) === JSON.stringify(participantSeatIds)) return recovered;
      }
      const current = await this.store.read();
      const open = current.planningGoals?.find((item) => item.teamId === team.id && !item.ceremony?.closure);
      if (open) throw new Error(`Team ${team.id} already has open goal ${open.id}; close it after its retro before starting another.`);
      const now = new Date().toISOString();
      const created: PlanningGoal = { id: planningId(), teamId: team.id, seatId: seat.id, participantSeatIds, goal: goalText, projectRefs: [github], stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId, rootPostId: "" }, brief: { summary: goalText, decisions: [], openQuestions: [] } };
      const intent: StartIntent = { goal: created, since: Date.now() };
      await this.store.saveRuntime(startIntentName(team.id), { pending: intent });
      return await this.finishStart(intent);
    });
    await this.store.withGoalLock(goal.id, async () => {
      await this.initialize(goal);
      await this.announceStages((await this.store.read()).planningGoals!.find((item) => item.id === goal.id)!, await this.metadata(goal.id));
    });
    return (await this.store.read()).planningGoals!.find((item) => item.id === goal.id)!;
  }

  private async finishStart(intent: StartIntent): Promise<PlanningGoal> {
    const goal = intent.goal;
    const existing = (await this.store.read()).planningGoals?.find((item) => item.id === goal.id);
    if (!existing) {
      const own = await this.chat.ownUserId();
      const key = `planning-root:${goal.id}`;
      const root = (await this.chat.since(goal.mattermost.channelId, Math.max(0, intent.since - 5000))).find((post) => post.channel_id === goal.mattermost.channelId && post.user_id === own && !post.root_id && post.props?.indra_delivery_id === key)
        ?? await this.chat.post(goal.mattermost.channelId, rootMessage(goal.id, goal.goal), undefined, key);
      goal.mattermost.rootPostId = root.id;
      await this.store.saveRuntime(goal.id, { lastSeenAt: Math.max(0, root.create_at - 5000), processedPostIds: [root.id], runs: [], initialReply: true } satisfies BridgeRecord);
      await this.store.update((state) => { state.planningGoals = [...(state.planningGoals ?? []), goal]; }, `Start planning goal ${goal.id}`);
    }
    await this.store.saveRuntime(startIntentName(goal.teamId), {});
    return existing ?? goal;
  }

  private async initialize(goal: PlanningGoal): Promise<void> {
    const metadata = await this.metadata(goal.id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (!metadata.initialReply) return;
    if (metadata.processedPostIds.includes(`initial-brief:${goal.id}`)) {
      delete metadata.initialReply;
      await this.store.saveRuntime(goal.id, metadata);
      return;
    }
    await this.converse(goal, metadata, `initial-brief:${goal.id}`, Date.parse(goal.createdAt), "Start this planning conversation. State what you understand and ask the most useful clarifying question.", false);
    delete metadata.initialReply;
    await this.store.saveRuntime(goal.id, metadata);
  }

  private async withTeamCreationLock<T>(teamId: string, work: () => Promise<T>): Promise<T> {
    return await this.store.withGoalLock(`planning-team-${teamId}-creation`, work);
  }

  private async metadata(id: string): Promise<BridgeRecord> { return await this.store.runtime(id); }

  private async facts(goal: PlanningGoal, change: (record: BridgeCeremonyRecord) => void): Promise<void> {
    await withFileLock(join(this.store.runtimeDir, `${ceremonyRuntimeName(goal.id)}.lock`), async () => {
      const record = await this.store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(goal.id)) ?? {
        facts: { seats: [], sessions: [], reviews: [], rounds: [], failures: [] }, deliveredStages: [],
      };
      change(record);
      await this.store.saveRuntime(ceremonyRuntimeName(goal.id), record);
    });
  }

  private async recordSession(goal: PlanningGoal, facts: BridgeSessionFacts): Promise<void> {
    const bounded = sessionFacts({ facts });
    if (!bounded) throw new Error("Invalid session evidence.");
    facts = bounded;
    await this.facts(goal, (record) => {
      if ((record.invocations ?? []).some((item) => item.invocationId === facts.invocationId)) return;
      record.invocations = [...(record.invocations ?? []), { ...facts, seatId: goal.seatId }];
      record.facts.sessions.push({ seatId: goal.seatId, sessionId: facts.sessionId ?? "unknown", startedAt: facts.startedAt, finishedAt: facts.finishedAt, usage: facts.usage ?? null });
    });
  }

  private async recordRun(goal: PlanningGoal, run: Awaited<ReturnType<AgentRuntime["message"]>>): Promise<void> {
    const facts = sessionFacts(run);
    if (facts) { await this.recordSession(goal, facts); return; }
    await this.facts(goal, (record) => {
      if (!record.facts.sessions.some((item) => item.seatId === goal.seatId && item.sessionId === run.sessionId && item.startedAt === run.startedAt)) {
        record.facts.sessions.push({ seatId: goal.seatId, sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage ?? null });
      }
    });
  }

  private async recordFailure(goal: PlanningGoal, metadata: BridgeRecord, finishedAt: string | null = null): Promise<void> {
    const turn = metadata.turn;
    if (!turn) return;
    const facts = turn.failure?.facts;
    if (facts) await this.recordSession(goal, facts);
    await this.facts(goal, (record) => {
      const message = turn.drafting ? "Chick proposal draft failed or was interrupted." : "Chick clarification failed or was interrupted.";
      if (!record.facts.failures.some((item) => item.at === turn.startedAt && item.message === message)) {
        record.facts.failures.push({ at: turn.startedAt, message, retries: record.facts.failures.filter((item) => item.message === message).length });
      }
      if (!turn.run && !record.facts.sessions.some((item) => item.seatId === goal.seatId && item.startedAt === (facts?.startedAt ?? turn.startedAt))) {
        record.facts.sessions.push({ seatId: goal.seatId, sessionId: facts?.sessionId ?? metadata.sessionId ?? "unknown", startedAt: facts?.startedAt ?? turn.startedAt, finishedAt: facts?.finishedAt ?? turn.failure?.finishedAt ?? finishedAt, usage: facts?.usage ?? null });
      }
    });
  }

  private async postIntent(goal: PlanningGoal, metadata: BridgeRecord, key: string, message: string, since = Date.now(), mergePost?: BridgeMergeKind): Promise<string> {
    if (metadata.pending) await this.deliver(goal, metadata);
    if (metadata.delivered?.[key]) return metadata.delivered[key];
    metadata.pending = { inputPostId: key, message, since, ...(mergePost ? { mergePost } : {}) };
    await this.store.saveRuntime(goal.id, metadata);
    return (await this.deliver(goal, metadata))!;
  }

  /** Reconstruct the ordered outbox from the committed stage prefix before handling any new input. */
  private async announceStages(goal: PlanningGoal, metadata: BridgeRecord): Promise<void> {
    if (!goal.ceremony) return;
    const seats = teamSeats(await this.store.read(), goal.teamId);
    for (const entry of goal.ceremony.history) {
      const key = `stage:${goal.id}:${entry.stage}`;
      if (entry.stage !== "planning") {
        const detail = entry.stage === "proposal" ? "Chick is preparing the draft for the owner's plan approval."
          : entry.stage === "implement" ? approvalMessage(goal, seats)
          : entry.stage === "release" ? "Implementation is frozen. The integration PR, human merge approval and running build verification complete this stage."
          : "The released build is verified running. Chick's retrospective must be published and archived before this goal closes.";
        await this.postIntent(goal, metadata, key, `**Stage: ${entry.stage}**\n${detail}`, entry.enteredAt ? Date.parse(entry.enteredAt) : Date.parse(goal.createdAt));
      }
      if (entry.stage === "implement") {
        const approval = entry.evidence.approval;
        const input = approval.source === "owner-command" ? ownerApprovalKey(goal.id) : reactionKey({ post_id: approval.postId, user_id: approval.userId, emoji_name: approval.emoji, create_at: Date.parse(approval.at) });
        if (!metadata.processedPostIds.includes(input)) { metadata.processedPostIds.push(input); await this.store.saveRuntime(goal.id, metadata); }
      }
      await this.facts(goal, (record) => {
        record.stageEvents = goal.ceremony!.history.map((item) => ({ stage: item.stage, at: item.enteredAt }));
        if (goal.ceremony!.closure) record.closedAt = goal.ceremony!.closure.closedAt;
        if (!record.deliveredStages.includes(key)) record.deliveredStages.push(key);
      });
    }
    if (goal.ceremony.closure) await this.postIntent(goal, metadata, `closed:${goal.id}`, `**Goal ${goal.id} closed**\nThe retrospective is published and archived: ${goal.ceremony.closure.evidence.prUrl}`, Date.parse(goal.ceremony.closure.closedAt));
  }

  private async ensureProposalAnnouncement(goal: PlanningGoal, metadata: BridgeRecord): Promise<void> {
    if (!goal.proposal || metadata.proposalPostIds?.length) return;
    if (metadata.pending) await this.deliver(goal, metadata);
    metadata.pending = { inputPostId: `proposal:${goal.proposal.id}`, since: Date.parse(goal.proposal.createdAt), message: proposalMessage(goal, teamSeats(await this.store.read(), goal.teamId)), proposal: true };
    await this.store.saveRuntime(goal.id, metadata);
    await this.deliver(goal, metadata);
  }

  private async recoverMilestonePosts(goal: PlanningGoal, metadata: BridgeRecord): Promise<void> {
    const integration = goal.integration;
    if (integration?.prUrl) await this.postIntent(goal, metadata, `integration-pr:${goal.id}`, integrationMessage(goal, integration.prUrl), Date.parse(goal.createdAt), "integration");
    if (integration?.revertPrUrl) await this.postIntent(goal, metadata, `revert-pr:${goal.id}`, revertMessage(goal, integration.revertPrUrl), Date.parse(goal.createdAt), "revert");
  }

  private context(goal: PlanningGoal): CeremonyContext {
    return {
      store: this.store, goal: structuredClone(goal), runtime: this.runtime,
      post: async (key, message, mergePost) => await this.postIntent(goal, await this.metadata(goal.id), `adapter:${goal.id}:${key}`, message, Date.parse(goal.createdAt), mergePost),
      recordRun: async (run) => await this.recordRun(goal, run),
      recordSession: async (facts) => await this.recordSession(goal, facts),
    };
  }

  private async ceremonyProgress(id: string): Promise<void> {
    let goal = (await this.store.read()).planningGoals!.find((item) => item.id === id)!;
    if (!goal.ceremony || goal.ceremony.closure) return;
    const metadata = await this.metadata(id);
    if (goal.ceremony.stage === "release" && goal.integration?.status === "merged") {
      const progress = await this.adapters.release?.poll({ ...this.context(goal), mergeApproval: metadata.mergeApproval }) ?? { status: "pending" as const, reason: "Waiting for the running-build verification adapter." };
      Object.assign(metadata, await this.metadata(id));
      if (progress.status === "pending") { metadata.waiting = { stage: "release", reason: progress.reason }; await this.store.saveRuntime(id, metadata); return; }
      if (!metadata.mergeApproval || progress.evidence.mergePostId !== metadata.mergeApproval.postId || JSON.stringify(progress.evidence.approval) !== JSON.stringify(metadata.mergeApproval.approval)) throw new Error("Running release evidence does not match the recorded human merge approval.");
      await this.store.update((state) => {
        const found = state.planningGoals!.find((item) => item.id === id)!;
        found.ceremony = advanceCeremony(found, { to: "retro", at: new Date().toISOString(), evidence: progress.evidence });
        found.updatedAt = new Date().toISOString();
      }, `Verify running release for goal ${id}`);
      goal = (await this.store.read()).planningGoals!.find((item) => item.id === id)!;
      delete metadata.waiting;
      await this.announceStages(goal, metadata);
    }
    if (goal.ceremony?.stage === "retro") {
      const progress = await this.adapters.retro?.poll(this.context(goal)) ?? { status: "pending" as const, reason: "Waiting for the retrospective publication and archival adapter." };
      // Adapters may have posted through context.post; keep their delivery journal when saving the wait reason.
      const latest = await this.metadata(id);
      if (progress.status === "pending") { latest.waiting = { stage: "retro", reason: progress.reason }; await this.store.saveRuntime(id, latest); return; }
      const own = await this.chat.ownUserId();
      const published = (await this.chat.since(goal.mattermost.channelId, Date.parse(goal.createdAt) - 5000)).find((post) => post.id === progress.evidence.postId && post.root_id === goal.mattermost.rootPostId && post.channel_id === goal.mattermost.channelId && post.user_id === own);
      if (!published) throw new Error("Retro thread publication has not been confirmed.");
      await this.store.update((state) => {
        const found = state.planningGoals!.find((item) => item.id === id)!;
        found.ceremony = closeCeremony(found, new Date().toISOString(), progress.evidence);
        found.updatedAt = found.ceremony.closure!.closedAt;
      }, `Close goal ${id} after published and archived retro`);
      delete latest.waiting;
      await this.announceStages((await this.store.read()).planningGoals!.find((item) => item.id === id)!, latest);
    }
  }

  async poll(): Promise<void> {
    const own = await this.chat.ownUserId();
    for (const team of (await this.store.read()).teams as { id: string }[]) {
      await this.withTeamCreationLock(team.id, async () => {
        const intent = await this.store.readRuntimeFile<{ pending?: StartIntent }>(startIntentName(team.id));
        if (intent?.pending) await this.finishStart(intent.pending);
      });
    }
    const goals = (await this.store.read()).planningGoals ?? [];
    // `planning approve` runs in another process; the goal lock keeps it and this poll off each other's runtime metadata.
    for (const goal of goals) await this.store.withGoalLock(goal.id, () => this.pollGoal(goal, own));
  }

  private async pollGoal(goal: PlanningGoal, own: string): Promise<void> {
    await this.initialize(goal);
    goal = (await this.store.read()).planningGoals!.find((item) => item.id === goal.id)!;
    const metadata = await this.metadata(goal.id);
    if (metadata.pending) await this.deliver(goal, metadata);
    await this.announceStages(goal, metadata);
    await this.ensureProposalAnnouncement(goal, metadata);
    await this.recoverMilestonePosts(goal, metadata);
    if (metadata.mergeIntent) {
      const intent = metadata.mergeIntent;
      const result = await this.mergeGate(goal.id, intent.kind, metadata, intent.approval);
      await this.postIntent(goal, metadata, `merge-recovery:${goal.id}:${intent.kind}`, result.message);
      delete metadata.mergeIntent;
      await this.store.saveRuntime(goal.id, metadata);
    }
    if (metadata.turn?.failure && metadata.turn.drafting) await this.revertDraft(goal, metadata, metadata.turn.inputKey, metadata.turn.since);
    else if (metadata.turn?.run) await this.finishTurn(goal, metadata);
    // Drafts run inside this goal's lock, so a goal still in `drafting` here was left by a crash, restart or older build.
    const current = (await this.store.read()).planningGoals?.find((item) => item.id === goal.id);
    if (current?.stage === "drafting") { await this.revertDraft(current, metadata, metadata.turn?.inputKey ?? `draft-recovery:${current.updatedAt}`, metadata.turn?.since ?? Date.now()); return; }
    let budget = this.maxQueue;
    if (stageOf(goal) === "planning") {
      const posts = (await this.chat.since(goal.mattermost.channelId, metadata.lastSeenAt)).filter((post) => post.root_id === goal.mattermost.rootPostId && post.user_id !== own && !metadata.processedPostIds.includes(post.id)).sort((a, b) => a.create_at - b.create_at).slice(0, budget);
      budget -= posts.length;
      for (const post of posts) await this.enqueue(goal.seatId, () => this.handle(goal.id, post));
      if (!posts.length) { metadata.lastSeenAt = Math.max(metadata.lastSeenAt, Date.now() - 5000); await this.store.saveRuntime(goal.id, metadata); }
    }
    const reactions = (await this.newReactions(goal, own)).slice(0, budget);
    budget -= reactions.length;
    for (const { reaction, key } of reactions) await this.enqueue(goal.seatId, () => this.react(goal.id, reaction, key));
    // After the reactions, so a 📝 and a `planning propose` seen in the same poll draft once.
    if (budget > 0 && (await this.metadata(goal.id)).proposalRequest) await this.enqueue(goal.seatId, () => this.ownerProposal(goal.id));
    // A GitHub problem is logged and retried on the next poll; it never stops the bridge.
    if (current?.stage === "approved" && current.integration?.status === "collecting") {
      try { await this.enqueue(goal.seatId, () => this.sprintProgress(goal.id)); }
      catch { console.error(`Sprint ${goal.id}: integration is pending; it will be retried.`); }
    }
    await this.ceremonyProgress(goal.id);
  }

  /**
   * Opens the integration PR once every assignment merged, or, once each has either merged or failed, posts once
   * that the owner can still open it for what merged (`planning integrate`, I in the terminal UI).
   */
  private async sprintProgress(id: string): Promise<void> {
    const state = await this.store.read();
    const goal = state.planningGoals?.find((item) => item.id === id);
    if (!goal?.integration || goal.integration.status !== "collecting" || !goal.assignments?.length) return;
    const metadata = await this.metadata(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (goal.ceremony?.stage === "release") { await this.openIntegration(goal, metadata); return; }
    const statuses = goal.assignments.map((item) => item.status);
    if (statuses.every((status) => status === "merged")) { await this.openIntegration(goal, metadata); return; }
    const key = `sprint-incomplete:${id}`;
    if (!statuses.every((status) => status === "merged" || status === "failed") || metadata.processedPostIds.includes(key)) return;
    const { merged, missed } = outcomeLines(goal, teamSeats(state, goal.teamId));
    metadata.pending = { inputPostId: key, since: Date.now(), message: `**Sprint ${id} is not complete**\n${missed.join("\n")}\n\n${merged.length ? `${merged.length} outcome(s) merged into \`${goal.integration.branch}\`. The owner can still open the integration PR for what merged: press I in Chick's detail (\`planning integrate --goal ${id}\`).` : "Nothing merged, so there is no integration PR to open."}` };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  private async implementationEvidence(goal: PlanningGoal): Promise<ImplementationEvidence> {
    if (this.adapters.implementation) {
      const progress = await this.adapters.implementation(this.context(goal));
      if (progress.status === "pending") throw new Error(progress.reason);
      return progress.evidence;
    }
    const outcomes: ImplementationEvidence["outcomes"] = [];
    for (const assignment of goal.assignments ?? []) {
      if (assignment.status !== "merged") continue;
      if (!assignment.prUrl) throw new Error("Implementation evidence is incomplete.");
      const view = await this.shell.run("gh", ["pr", "view", assignment.prUrl, "--json", "state,baseRefName,mergeCommit,reviewDecision"], this.store.checkout);
      if (view.code !== 0) throw new Error(`Cannot verify implementation PR for ${assignment.outcomeId}.`);
      const proof = JSON.parse(view.stdout) as { state?: string; baseRefName?: string; mergeCommit?: { oid?: string }; reviewDecision?: string };
      const checks = await this.shell.run("gh", ["pr", "checks", assignment.prUrl], this.store.checkout);
      if (proof.state !== "MERGED" || proof.baseRefName !== goal.integration!.branch || !/^[0-9a-f]{40}$/.test(proof.mergeCommit?.oid ?? "") || proof.reviewDecision !== "APPROVED" || checks.code !== 0) throw new Error(`Implementation PR for ${assignment.outcomeId} needs verified sprint base, merge, review and green CI.`);
      outcomes.push({ outcomeId: assignment.outcomeId, seatId: assignment.seatId, prUrl: assignment.prUrl, baseBranch: proof.baseRefName, mergedSha: proof.mergeCommit!.oid!, reviewApproved: true, checksPassed: true });
    }
    return { kind: "implementation", outcomes };
  }

  /** Freeze claims in the state transaction before any integration PR network call. */
  private async beginRelease(goal: PlanningGoal, metadata: BridgeRecord, owner: boolean): Promise<PlanningGoal> {
    if (goal.ceremony?.stage === "release") return goal;
    const omissions = (goal.assignments ?? []).filter((item) => item.status !== "merged").map((item) => ({ outcomeId: item.outcomeId, seatId: item.seatId, status: item.status, reason: item.note ?? `Owner omitted ${item.status} outcome from partial integration.` }));
    if (omissions.length && !owner) throw new Error("Partial integration requires the owner's integrate command.");
    if (omissions.some((item) => item.status === "running" || item.status === "in-review")) throw new Error(`A seat is still working on goal ${goal.id}; wait before integration.`);
    if (omissions.length) {
      metadata.partialIntegration = { authorizedAt: new Date().toISOString(), omissions };
      await this.store.saveRuntime(goal.id, metadata);
    }
    const proof = goal.ceremony ? await this.implementationEvidence(goal) : undefined;
    const evidence: ImplementationEvidence | undefined = proof ? { kind: "implementation", outcomes: proof.outcomes,
      ...(omissions.length ? { omissions: omissions.map(({ outcomeId, seatId, reason }) => ({ outcomeId, seatId, reason })), partialApproval: { source: "owner-command", command: "planning integrate", at: metadata.partialIntegration!.authorizedAt } } : {}),
    } : undefined;
    await this.store.update((state) => {
      const found = state.planningGoals!.find((item) => item.id === goal.id)!;
      if (stageOf(found) !== "implement" || found.integration?.status !== "collecting") throw new Error(`Goal ${goal.id} is no longer implementing.`);
      if (found.assignments?.some((item) => item.status === "running" || item.status === "in-review")) throw new Error(`A seat is still working on goal ${goal.id}; wait before integration.`);
      if (JSON.stringify(found.assignments) !== JSON.stringify(goal.assignments)) throw new Error("Assignments changed before integration; retry from their current state.");
      for (const assignment of found.assignments ?? []) if (assignment.status === "queued") {
        assignment.status = "failed";
        assignment.note = omissions.find((item) => item.outcomeId === assignment.outcomeId)!.reason;
        assignment.updatedAt = new Date().toISOString();
      }
      if (found.ceremony && evidence) {
        const at = new Date().toISOString();
        found.ceremony = advanceCeremony(found, { to: "release", at, evidence });
        found.updatedAt = at;
      }
    }, `Begin release for goal ${goal.id}`);
    const saved = (await this.store.read()).planningGoals!.find((item) => item.id === goal.id)!;
    await this.announceStages(saved, metadata);
    return saved;
  }

  /** Opens (or finds) the one PR from the sprint branch into main, records it and posts it in the thread as the merge post. */
  private async openIntegration(goal: PlanningGoal, metadata: BridgeRecord, owner = false): Promise<string> {
    goal = await this.beginRelease(goal, metadata, owner);
    const state = await this.store.read();
    const github = this.project(state, goal);
    const prUrl = await this.github.openPr(github, goal.integration!.branch, `Sprint ${goal.id}: ${goal.goal}`.slice(0, 200), sprintSummary(goal, teamSeats(state, goal.teamId)));
    await this.store.update((doc) => {
      const found = doc.planningGoals!.find((item) => item.id === goal.id)!;
      if (found.integration?.status === "collecting") { found.integration = { ...found.integration, status: "pr-open", prUrl }; found.updatedAt = new Date().toISOString(); }
    }, `Open integration PR for goal ${goal.id}`);
    metadata.pending = { inputPostId: `integration-pr:${goal.id}`, since: Date.now(), message: integrationMessage(goal, prUrl), mergePost: "integration" };
    await this.store.saveRuntime(goal.id, metadata);
    await this.deliver(goal, metadata);
    return prUrl;
  }

  private project(state: PlanningDocument, goal: PlanningGoal): string {
    const github = teamProject(state, goal.teamId);
    if (!github) throw new Error(missingTeamMessage(goal.teamId, ["project.github"]));
    return github;
  }

  /**
   * The owner's `planning integrate` (I in the terminal UI): opens the integration PR for what merged when some
   * outcomes failed or are still queued. Refused while a seat is still running or reviewing one. Repeating it finds the same PR.
   */
  async integrate(id: string): Promise<string> {
    return await this.store.withGoalLock(id, async () => {
      const goal = this.approvedGoal((await this.store.read()).planningGoals?.find((item) => item.id === id), id);
      const integration = goal.integration!;
      if (integration.status !== "collecting") return `Sprint ${id} is ${integration.status}${integration.prUrl ? `: ${integration.prUrl}` : ""}; nothing to open.`;
      const assignments = goal.assignments ?? [];
      if (assignments.some((item) => item.status === "running" || item.status === "in-review")) throw new Error(`A seat is still working on goal ${id}; open the integration PR once no outcome is running or in review.`);
      if (!assignments.some((item) => item.status === "merged")) throw new Error(`Nothing merged into ${integration.branch}; there is no sprint to integrate.`);
      const metadata = await this.metadata(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      return `Opened the integration PR for sprint ${id}: ${await this.openIntegration(goal, metadata, true)}`;
    });
  }

  private approvedGoal(goal: PlanningGoal | undefined, id: string): PlanningGoal {
    if (!goal) throw new Error(`No planning goal ${id} in state.`);
    if (goal.stage !== "approved" || !goal.integration) throw new Error(`Goal ${id} has no sprint integration branch; only goals approved with one have a sprint.`);
    return goal;
  }

  /**
   * The one merge path for the sprint's integration PR and its revert PR, used by a person's ✅ on the merge post
   * and by the owner's `planning merge`. It merges only once CI is green, records the result, and posts it.
   * Merging a PR that already merged changes nothing. Returns what happened, and whether it was merged.
   */
  private async mergeGate(id: string, kind: BridgeMergeKind | undefined, metadata: BridgeRecord, approval: HumanApproval): Promise<{ message: string; merged: boolean; post: boolean }> {
    const goal = this.approvedGoal((await this.store.read()).planningGoals?.find((item) => item.id === id), id);
    const integration = goal.integration!;
    const target: BridgeMergeKind | undefined = kind ?? (integration.status === "pr-open" ? "integration" : integration.status === "merged" && integration.revertPrUrl ? "revert" : goal.ceremony?.stage === "retro" ? "retro" : undefined);
    if (target === "retro") {
      if (goal.ceremony?.stage !== "retro" || goal.ceremony.closure) throw new Error("Retro merge requires an open goal at retro.");
      if (!this.adapters.retro?.merge) throw new Error("The retrospective merge adapter is not available yet.");
      const message = await this.adapters.retro.merge(this.context(goal), approval);
      Object.assign(metadata, await this.metadata(id));
      return { message, merged: true, post: true };
    }
    if (target === "integration" && (integration.status === "merged" || integration.status === "reverted")) return { message: `Sprint ${id} is already merged into main as ${integration.mergedSha!.slice(0, 7)} (${integration.prUrl}).`, merged: false, post: true };
    if (target === "revert" && integration.status === "reverted") return { message: `Sprint ${id} is already rolled back (${integration.revertPrUrl}).`, merged: false, post: true };
    const prUrl = target === "integration" && integration.status === "pr-open" ? integration.prUrl : target === "revert" && integration.status === "merged" ? integration.revertPrUrl : undefined;
    if (!target || !prUrl) return { message: `Nothing to merge for sprint ${id}: it is ${integration.status}${integration.status === "collecting" ? " and has no integration PR yet" : ""}.`, merged: false, post: false };
    const mergePost = metadata.mergePosts?.find((item) => item.kind === target && (approval.source !== "reaction" || item.id === approval.postId));
    if (!mergePost) throw new Error("The merge PR must be posted before human merge approval.");
    metadata.mergeIntent = { kind: target, approval };
    if (target === "integration") metadata.mergeApproval = { postId: mergePost.id, approval };
    await this.store.saveRuntime(id, metadata);
    const result = await this.github.merge(prUrl);
    if (!result.merged) {
      delete metadata.mergeIntent;
      await this.store.saveRuntime(id, metadata);
      return { message: `Not merged: ${result.reason}. Nothing changed; merge again once CI is green.`, merged: false, post: true };
    }
    await this.store.update((state) => {
      const found = state.planningGoals!.find((item) => item.id === id)!;
      const current = found.integration!;
      if (target === "integration" && current.status === "pr-open") found.integration = { ...current, status: "merged", mergedSha: result.sha };
      else if (target === "revert" && current.status === "merged") found.integration = { ...current, status: "reverted" };
      else return;
      found.updatedAt = new Date().toISOString();
    }, target === "integration" ? `Merge sprint ${id} into main` : `Revert sprint ${id} on main`);
    delete metadata.mergeIntent;
    await this.store.saveRuntime(id, metadata);
    return { message: target === "integration" ? `**Sprint ${id} merged into main** as ${result.sha.slice(0, 7)} (${prUrl}). Release remains pending until the new build is verified running. To roll the whole sprint back: \`planning rollback --goal ${id}\`, or V in Chick's detail.` : `**Sprint ${id} rolled back** on main by ${prUrl} (${result.sha.slice(0, 7)}).`, merged: true, post: true };
  }

  /** The owner's `planning merge` (M in the terminal UI): merges the open integration or revert PR through the same path as ✅. */
  async merge(id: string): Promise<string> {
    return await this.store.withGoalLock(id, async () => {
      const goal = this.approvedGoal((await this.store.read()).planningGoals?.find((item) => item.id === id), id);
      const metadata = await this.metadata(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      await this.recoverMilestonePosts(goal, metadata);
      const result = await this.mergeGate(id, undefined, metadata, { source: "owner-command", command: "planning merge", at: new Date().toISOString() });
      if (!result.merged) throw new Error(result.message);
      metadata.pending = { inputPostId: `owner-merge:${id}:${Date.now()}`, since: Date.now(), message: result.message };
      await this.store.saveRuntime(id, metadata);
      await this.deliver(goal, metadata);
      return result.message.replace(/\*\*/g, "");
    });
  }

  /**
   * The owner's `planning rollback` (V in the terminal UI): opens a PR on main that reverts the sprint's merge commit
   * and posts it as a merge post; merging it goes through the same ✅ or M gate. Repeating it returns the same PR.
   */
  async rollback(id: string): Promise<string> {
    return await this.store.withGoalLock(id, async () => {
      const state = await this.store.read();
      const goal = this.approvedGoal(state.planningGoals?.find((item) => item.id === id), id);
      const integration = goal.integration!;
      if (integration.status === "reverted") return `Sprint ${id} is already rolled back (${integration.revertPrUrl}).`;
      if (integration.status !== "merged") throw new Error(`Sprint ${id} is ${integration.status}; only a sprint merged into main can be rolled back.`);
      if (integration.revertPrUrl) return `The revert PR for sprint ${id} is already open: ${integration.revertPrUrl}`;
      const metadata = await this.metadata(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      const prUrl = await this.github.revertPr(this.project(state, goal), id, integration.mergedSha!, `Revert sprint ${id}: ${goal.goal}`.slice(0, 200), `Reverts sprint ${id} (${integration.prUrl}), merge commit ${integration.mergedSha}, as a unit.\n\n**Goal:** ${goal.goal}`);
      await this.store.update((doc) => {
        const found = doc.planningGoals!.find((item) => item.id === id)!;
        if (found.integration?.status === "merged" && !found.integration.revertPrUrl) { found.integration = { ...found.integration, revertPrUrl: prUrl }; found.updatedAt = new Date().toISOString(); }
      }, `Open revert PR for sprint ${id}`);
      metadata.pending = { inputPostId: `revert-pr:${id}`, since: Date.now(), message: revertMessage(goal, prUrl), mergePost: "revert" };
      await this.store.saveRuntime(id, metadata);
      await this.deliver(goal, metadata);
      return `Opened the revert PR for sprint ${id}: ${prUrl}`;
    });
  }

  /** Unhandled 📝 on the goal post and ✅ on the goal or proposal posts, oldest first; the bridge's own reactions never count. */
  private async newReactions(goal: PlanningGoal, own: string): Promise<{ reaction: Reaction; key: string }[]> {
    const metadata = await this.metadata(goal.id);
    const root = goal.mattermost.rootPostId;
    const found: Reaction[] = [];
    for (const postId of [root, ...(metadata.proposalPostIds ?? []), ...(metadata.mergePosts ?? []).map((item) => item.id)]) {
      found.push(...(await this.chat.reactions(postId)).filter((reaction) => reaction.post_id === postId && reaction.user_id !== own && (reaction.emoji_name === APPROVE_EMOJI || (reaction.emoji_name === PROPOSE_EMOJI && postId === root))));
    }
    return found.map((reaction) => ({ reaction, key: reactionKey(reaction) })).filter((item) => !metadata.processedPostIds.includes(item.key)).sort((a, b) => a.reaction.create_at - b.reaction.create_at);
  }

  private enqueue(seatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.busy.get(seatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.busy.set(seatId, next);
    void next.finally(() => { if (this.busy.get(seatId) === next) this.busy.delete(seatId); }).catch(() => {});
    return next;
  }

  /** A thread reply while the brief is being clarified. */
  private async handle(id: string, post: Post): Promise<void> {
    const goal = (await this.store.read()).planningGoals?.find((goal) => goal.id === id);
    if (!goal) return;
    const metadata = await this.metadata(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (stageOf(goal) !== "planning" || metadata.processedPostIds.includes(post.id)) return;
    await this.converse(goal, metadata, post.id, post.create_at, post.message, false);
  }

  /** The turn result is journaled before state changes so recovery never needs to redraft a saved proposal. */
  private async converse(goal: PlanningGoal, metadata: BridgeRecord, inputKey: string, since: number, message: string, drafting: boolean): Promise<void> {
    if (metadata.processedPostIds.includes(inputKey)) return;
    const id = goal.id;
    if (metadata.turn?.run && !metadata.turn.failure) { await this.finishTurn(goal, metadata); return; }
    if (drafting) {
      await this.store.update((state) => {
        const found = state.planningGoals!.find((item) => item.id === id)!;
        if (!canDraft(found)) throw new Error(`Goal ${id} cannot draft at ${stageOf(found)}.`);
        const at = new Date().toISOString();
        if (found.ceremony?.stage === "planning") found.ceremony = advanceCeremony(found, { to: "proposal", at });
        found.stage = "drafting"; found.updatedAt = at;
      }, `Start drafting a proposal for goal ${id}`);
      goal = (await this.store.read()).planningGoals!.find((item) => item.id === id)!;
      await this.announceStages(goal, metadata);
    }
    const developers = drafting ? developerSeats(await this.store.read(), goal.teamId).map((seat) => ({ id: seat.id, displayName: seat.displayName ?? seat.id })) : [];
    metadata.turn = { inputKey, since, drafting, startedAt: new Date().toISOString() };
    await this.store.saveRuntime(id, metadata);
    let run: Awaited<ReturnType<AgentRuntime["message"]>> | undefined;
    try {
      const recorded = await this.store.readRuntimeFile<BridgeCeremonyRecord>(ceremonyRuntimeName(id));
      const baseline = [...(recorded?.invocations ?? [])].reverse().find((item) => item.sessionId === metadata.sessionId && item.cumulativeUsage)?.cumulativeUsage;
      const options = { timeoutMs: drafting ? DRAFT_TIMEOUT_MS : CLARIFY_TIMEOUT_MS, purpose: drafting ? "draft" : "clarify", ...(baseline ? { previousSessionUsage: baseline } : {}) };
      run = await this.runtime.message(prompt(goal, message, drafting, developers), drafting ? proposalSchema : briefSchema, metadata.sessionId, options);
      metadata.sessionId = run.sessionId;
      metadata.runs.push({ startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
      const response = drafting ? proposal(run.response, developers) : brief(run.response);
      const bounded = { sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt, response, usage: sessionFacts(run)?.usage ?? run.usage, facts: sessionFacts(run) };
      metadata.turn.run = bounded;
      if (drafting) metadata.turn.draft = response as NonNullable<PlanningGoal["proposal"]>;
    } catch (error) {
      const facts = sessionFacts(error) ?? sessionFacts(run);
      if (facts?.sessionId) metadata.sessionId = facts.sessionId;
      metadata.turn.failure = { finishedAt: new Date().toISOString(), facts };
      if (run) {
        metadata.turn.run = { sessionId: run.sessionId, startedAt: run.startedAt, finishedAt: run.finishedAt, response: null, usage: run.usage };
        await this.recordRun(goal, run);
      }
      await this.store.saveRuntime(id, metadata);
      await this.recordFailure(goal, metadata);
      if (!drafting) throw error;
      const reason = "The proposal draft failed; request a retry.";
      console.error(`Planning draft for goal ${id} failed; awaiting a retry in proposal.`);
      metadata.lastDraftError = { at: new Date().toISOString(), message: reason };
      await this.revertDraft(goal, metadata, inputKey, since);
      return;
    }
    await this.store.saveRuntime(id, metadata);
    await this.finishTurn(goal, metadata);
  }

  private async finishTurn(goal: PlanningGoal, metadata: BridgeRecord): Promise<void> {
    const turn = metadata.turn!;
    const run = turn.run!;
    await this.recordRun(goal, run);
    if (turn.drafting) {
      const developers = developerSeats(await this.store.read(), goal.teamId).map((seat) => ({ id: seat.id, displayName: seat.displayName ?? seat.id }));
      const draft = turn.draft ?? proposal(run.response, developers);
      turn.draft = draft;
      await this.store.saveRuntime(goal.id, metadata);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === goal.id)!; found.proposal = draft; found.stage = "awaiting-review"; found.updatedAt = draft.createdAt; }, `Draft proposal for goal ${goal.id}: ${draft.outcomes.length} outcome${draft.outcomes.length === 1 ? "" : "s"}`);
      if (!metadata.processedPostIds.includes(turn.inputKey)) metadata.processedPostIds.push(turn.inputKey);
      metadata.pending = { inputPostId: `proposal:${draft.id}`, since: turn.since, message: proposalMessage({ ...goal, proposal: draft }, teamSeats(await this.store.read(), goal.teamId)), proposal: true };
    } else {
      const update = brief(run.response);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === goal.id)!; found.brief = { summary: update.summary, decisions: update.decisions, openQuestions: update.openQuestions }; found.updatedAt = Number.isFinite(Date.parse(run.finishedAt)) ? run.finishedAt : turn.startedAt; }, `Update brief for goal ${goal.id}`);
      metadata.pending = { inputPostId: turn.inputKey, since: turn.since, message: update.reply };
    }
    delete metadata.turn;
    await this.store.saveRuntime(goal.id, metadata);
    await this.deliver(goal, metadata);
  }

  /** A failed or interrupted draft clears only its substate; proposal remains the canonical stage. */
  private async revertDraft(goal: PlanningGoal, metadata: BridgeRecord, inputKey: string, since: number): Promise<void> {
    await this.recordFailure(goal, metadata);
    await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === goal.id)!; if (found.stage === "drafting") { found.stage = "clarifying"; found.updatedAt = new Date().toISOString(); } }, `Keep goal ${goal.id} in proposal after a failed draft`);
    delete metadata.turn;
    metadata.pending = { inputPostId: inputKey, since, message: `Drafting the proposal failed; goal ${goal.id} remains in proposal. React :${PROPOSE_EMOJI}: on the goal post again (or press P in the UI) to retry.` };
    await this.store.saveRuntime(goal.id, metadata);
    await this.deliver(goal, metadata);
  }

  /**
   * One 📝 or ✅ reaction. The stage is read again here, so a reaction that arrives at the wrong stage gets a reply
   * saying why nothing happened. Replies are rebuilt from durable state, so a restart repeats nothing.
   */
  private async react(id: string, reaction: Reaction, key: string): Promise<void> {
    const state = await this.store.read();
    const goal = state.planningGoals?.find((item) => item.id === id);
    if (!goal) return;
    const metadata = await this.metadata(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (metadata.processedPostIds.includes(key)) return;
    const seats = teamSeats(state, goal.teamId);
    const approving = reaction.emoji_name === APPROVE_EMOJI;
    const gate = approving ? metadata.mergePosts?.find((item) => item.id === reaction.post_id) : undefined;
    let message: string; let announcesProposal = false;
    if (!(await this.human(state, goal, reaction.user_id))) message = `Only a person can ${gate ? "merge a sprint" : approving ? "approve a proposal" : "request a proposal"}; reactions from bots and Chick don't count. Nothing changed.`;
    else if (gate) {
      try { message = (await this.mergeGate(id, gate.kind, metadata, { source: "reaction", userId: reaction.user_id, postId: reaction.post_id, emoji: "white_check_mark", verifiedHuman: true, at: new Date(reaction.create_at).toISOString() })).message; }
      catch (error) { console.error(`Sprint ${id} merge could not be confirmed.`); message = `Could not merge the sprint's PR right now; nothing changed. React :${APPROVE_EMOJI}: again (remove and re-add it) to retry.`; }
    }
    else if (goal.ceremony?.closure) message = `Goal ${id} is closed.`;
    else if (goal.stage === "approved") message = approvalMessage(goal, seats);
    else if (!approving && goal.stage === "awaiting-review") { message = proposalMessage(goal, seats); announcesProposal = true; }
    else if (!approving && canDraft(goal)) { await this.draft(goal, metadata, key, reaction.create_at); return; }
    else if (!approving) message = `Goal ${id} cannot draft at the ${stageOf(goal)} stage.`;
    else if (goal.stage !== "awaiting-review") message = nothingToApprove(goal);
    else if (reaction.post_id === goal.mattermost.rootPostId) message = `To approve proposal ${goal.proposal!.id}, react :${APPROVE_EMOJI}: on Chick's proposal post rather than the goal post. Nothing changed.`;
    else {
      let integration: SprintIntegration;
      try { integration = await this.createSprint(state, goal); }
      catch (error) {
        console.error(`Sprint branch for goal ${id} could not be created.`);
        message = `Could not create the sprint branch \`${sprintBranch(id)}\` on GitHub, so nothing was approved. React :${APPROVE_EMOJI}: again (remove and re-add it) or press A in Chick's detail to retry.`;
        metadata.pending = { inputPostId: key, since: reaction.create_at, message };
        await this.store.saveRuntime(id, metadata);
        await this.deliver(goal, metadata);
        return;
      }
      await this.approveAndConfirm(id, metadata, key, reaction.create_at, { source: "reaction", userId: reaction.user_id, postId: reaction.post_id, emoji: "white_check_mark", verifiedHuman: true, at: new Date(reaction.create_at).toISOString() }, integration);
      return;
    }
    metadata.pending = { inputPostId: key, since: reaction.create_at, message, ...(announcesProposal ? { proposal: true } : {}) };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  /** The one drafting path, used by the 📝 reaction and by `planning propose`. */
  private async draft(goal: PlanningGoal, metadata: BridgeRecord, inputKey: string, since: number): Promise<void> {
    await this.converse(goal, metadata, inputKey, since, "Draft the proposal now from the brief so far.", true);
  }

  /**
   * The owner's request recorded by `planning propose`. If a 📝 already moved the goal past drafting, the request is
   * dropped without a post: the proposal is drafted once. The request is consumed either way: a failed draft reverts the goal to clarifying with
   * one reply, and the owner can request again.
   */
  private async ownerProposal(id: string): Promise<void> {
    const goal = (await this.store.read()).planningGoals?.find((item) => item.id === id);
    if (!goal) return;
    const metadata = await this.metadata(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    const request = metadata.proposalRequest;
    if (!request) return;
    const key = ownerProposalKey(id, request.requestedAt);
    delete metadata.proposalRequest;
    if (reviewing(goal) || metadata.processedPostIds.includes(key)) { await this.store.saveRuntime(id, metadata); return; }
    await this.draft(goal, metadata, key, request.requestedAt);
  }

  /**
   * The one approval path, used by the ✅ reaction and by `planning approve`: queues one assignment per outcome
   * if the goal is still awaiting review (never twice), then posts the confirmation in the goal thread.
   */
  /** Creates the sprint's integration branch on GitHub from main (or finds it) before a goal is approved. */
  private async createSprint(state: PlanningDocument, goal: PlanningGoal): Promise<SprintIntegration> {
    const baseSha = await this.github.ensureBranch(this.project(state, goal), goal.id);
    return { branch: sprintBranch(goal.id), baseSha, status: "collecting" };
  }

  /**
   * `integration` is the sprint branch made just before; it is recorded in the same commit as the assignments, so no
   * seat ever sees an approved goal without the branch its PRs target.
   */
  private async approveAndConfirm(id: string, metadata: BridgeRecord, inputKey: string, since: number, approval: HumanApproval, integration?: SprintIntegration): Promise<PlanningGoal> {
    let approved: PlanningGoal | undefined;
    await this.store.update((state) => {
      const found = state.planningGoals?.find((item) => item.id === id);
      if (!found || !reviewing(found)) throw new Error(`Goal ${id} has no proposal awaiting review.`);
      if (found.stage === "awaiting-review") {
        if (!integration) throw new Error(`Goal ${id} has no sprint branch yet.`);
        const now = new Date(Math.max(Date.now(), Date.parse(approval.at))).toISOString();
        found.stage = "approved";
        found.assignments = found.proposal!.outcomes.map((outcome) => ({ outcomeId: outcome.id, seatId: outcome.seatId, status: "queued", updatedAt: now }));
        found.integration = integration;
        if (found.ceremony) {
          const proposalPostId = approval.source === "reaction" ? approval.postId : metadata.proposalPostIds?.[0];
          if (!proposalPostId || !metadata.proposalPostIds?.includes(proposalPostId)) throw new Error("The proposal must be delivered before it can be approved.");
          found.ceremony = advanceCeremony(found, { to: "implement", at: now, evidence: { kind: "approval", proposalId: found.proposal!.id, proposalPostId, approval } });
        }
        found.updatedAt = now;
      }
      approved = structuredClone(found);
    }, () => `Approve goal ${id}: ${approved!.assignments?.length ?? 0} assignment${approved!.assignments?.length === 1 ? "" : "s"}`);
    const goal = approved!;
    if (goal.ceremony) {
      await this.announceStages(goal, metadata);
      if (!metadata.processedPostIds.includes(inputKey)) metadata.processedPostIds.push(inputKey);
      await this.store.saveRuntime(id, metadata);
      return goal;
    }
    metadata.pending = { inputPostId: inputKey, since, message: approvalMessage(goal, teamSeats(await this.store.read(), goal.teamId)) };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
    return goal;
  }

  /**
   * The owner's approval from the terminal UI, through `planning approve`. It uses the same approval path as ✅,
   * including the thread confirmation. Repeating it, or approving by both routes, never queues assignments twice.
   */
  async approve(id: string): Promise<{ goal: PlanningGoal; alreadyApproved: boolean }> {
    const check = (goal: PlanningGoal | undefined): PlanningGoal => {
      if (!goal) throw new Error(`No planning goal ${id} in state.`);
      if (!reviewing(goal)) throw new Error(`Goal ${id} is at the ${goal.stage} stage; only a proposal awaiting review can be approved.`);
      return goal;
    };
    check((await this.store.read()).planningGoals?.find((item) => item.id === id));
    return await this.store.withGoalLock(id, async () => {
      const goal = check((await this.store.read()).planningGoals?.find((item) => item.id === id));
      const metadata = await this.metadata(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      await this.ensureProposalAnnouncement(goal, metadata);
      const key = ownerApprovalKey(id);
      const alreadyApproved = goal.stage === "approved";
      if (alreadyApproved && metadata.processedPostIds.includes(key)) return { goal, alreadyApproved };
      const integration = alreadyApproved ? undefined : await this.createSprint(await this.store.read(), goal);
      return { goal: await this.approveAndConfirm(id, metadata, key, Date.now(), { source: "owner-command", command: "planning approve", at: new Date().toISOString() }, integration), alreadyApproved };
    });
  }

  /**
   * The owner's request for a proposal from the terminal UI, through `planning propose`. It records the request under
   * the goal lock the bridge polls with; the bridge drafts it on its next poll through the same path as 📝, including
   * the thread posts. It needs no Mattermost credential. Repeating it, or requesting by both routes, drafts once.
   */
  static async requestProposal(store: PlanningStore, id: string): Promise<{ goal: PlanningGoal; alreadyRequested: boolean }> {
    const check = (goal: PlanningGoal | undefined): PlanningGoal => {
      if (!goal) throw new Error(`No planning goal ${id} in state.`);
      if (!canDraft(goal)) throw new Error(`Goal ${id} is at the ${goal.stage} stage; a proposal can be requested only in planning or while retrying proposal.`);
      return goal;
    };
    check((await store.read()).planningGoals?.find((item) => item.id === id));
    return await store.withGoalLock(id, async () => {
      const goal = check((await store.read()).planningGoals?.find((item) => item.id === id));
      const metadata = await store.runtime(id);
      if (metadata.proposalRequest) return { goal, alreadyRequested: true };
      metadata.proposalRequest = { requestedAt: Date.now() };
      await store.saveRuntime(id, metadata);
      if (goal.ceremony?.stage === "planning") await store.update((state) => {
        const found = state.planningGoals!.find((item) => item.id === id)!;
        found.ceremony = advanceCeremony(found, { to: "proposal", at: new Date().toISOString() });
        found.updatedAt = new Date().toISOString();
      }, `Request proposal for goal ${id}`);
      return { goal: (await store.read()).planningGoals!.find((item) => item.id === id)!, alreadyRequested: false };
    });
  }

  /** A non-bot Mattermost user who is neither this bridge's account nor Chick's seat. */
  private async human(state: PlanningDocument, goal: PlanningGoal, userId: string): Promise<boolean> {
    const team = (state.teams as { id: string; seats: { id: string; externalIdentities?: { mattermost?: { userId?: string } } }[] }[]).find((item) => item.id === goal.teamId);
    const chick = team?.seats.find((seat) => seat.id === goal.seatId)?.externalIdentities?.mattermost?.userId;
    if (userId === (await this.chat.ownUserId()) || userId === chick) return false;
    return !(await this.chat.isBot(userId));
  }

  private async deliver(goal: PlanningGoal, metadata: BridgeRecord): Promise<string | undefined> {
    const pending = metadata.pending;
    if (!pending) return;
    const own = await this.chat.ownUserId();
    const delivered = (await this.chat.since(goal.mattermost.channelId, Math.max(0, pending.since - 5000))).find((post) => post.user_id === own && post.root_id === goal.mattermost.rootPostId && post.props?.indra_delivery_id === pending.inputPostId);
    const post = delivered ?? await this.chat.post(goal.mattermost.channelId, pending.message, goal.mattermost.rootPostId, pending.inputPostId);
    // The proposal post is where people react ✅; it is found again after a restart by its delivery ID.
    if (pending.proposal && !(metadata.proposalPostIds ?? []).includes(post.id)) metadata.proposalPostIds = [...(metadata.proposalPostIds ?? []), post.id];
    if (pending.mergePost && !(metadata.mergePosts ?? []).some((item) => item.id === post.id)) metadata.mergePosts = [...(metadata.mergePosts ?? []), { id: post.id, kind: pending.mergePost }];
    if (!metadata.processedPostIds.includes(pending.inputPostId)) metadata.processedPostIds.push(pending.inputPostId);
    metadata.delivered = { ...metadata.delivered, [pending.inputPostId]: post.id };
    metadata.lastSeenAt = Math.max(metadata.lastSeenAt, pending.since);
    delete metadata.pending;
    await this.store.saveRuntime(goal.id, metadata);
    return post.id;
  }
}
