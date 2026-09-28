import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./codex-runtime.js";
import { planningId } from "./codex-runtime.js";
import { PlanningStore, developerSeats, planningChannelId, validateOutcomeSeats, type PlanningDocument, type PlanningGoal, type RuntimeRecord } from "./planning.js";

export interface Post { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number; props?: { indra_delivery_id?: string } }
export interface PlanningChat {
  ownUserId(): Promise<string>;
  post(channelId: string, message: string, rootId?: string, deliveryId?: string): Promise<Post>;
  since(channelId: string, timestamp: number): Promise<Post[]>;
  /** Mattermost's `is_bot` flag for the user; only a human may approve a proposal. */
  isBot(userId: string): Promise<boolean>;
}
type Seat = { id: string; displayName: string };

const briefSchema = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "brief.json");
const proposalSchema = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "proposal.json");
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
function proposalMessage(goal: PlanningGoal, seats: Map<string, string>): string {
  const draft = goal.proposal!;
  return `**Draft proposal ${draft.id} — awaiting review**\n${draft.summary}\n${draft.outcomes.map((item) => `- **${item.title}** → ${seatLabel(seats, item.seatId)}: ${item.description}`).join("\n")}\n\nRecorded in indra-state as ${goal.id}. No work has been approved or executed. Send /approve in this thread to approve it.`;
}
function approvalMessage(goal: PlanningGoal, seats: Map<string, string>): string {
  const titles = new Map(goal.proposal!.outcomes.map((item) => [item.id, item.title]));
  return `**Proposal ${goal.proposal!.id} approved**\n${(goal.assignments ?? []).map((item) => `- ${titles.get(item.outcomeId) ?? item.outcomeId} → ${seatLabel(seats, item.seatId)}`).join("\n")}\n\nRecorded in indra-state as ${goal.id}. Each outcome is queued for its Developer seat.`;
}
const isCommand = (message: string) => ["/proposal", "/approve"].includes(message.trim());

function prompt(goal: PlanningGoal, input: string, drafting: boolean, developers: Seat[]): string {
  const seats = developers.map((seat) => `${seat.id} (${seat.displayName})`).join(", ");
  return `You are Chick Corea, the Team Lead seat in Indra. This is planning only. Read referenced projects when useful, but do not edit files, run implementation, deploy, or claim approval. Return only JSON. ${drafting ? `Create a proposed outcome-based roadmap with keys summary, outcomes (title, description and seatId), risks, openQuestions. This is a draft for human review. Assign every outcome to one of these Developer seats by its seat ID: ${seats || "none"}. Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.` : "Respond to the message and update the durable brief. Keys: reply, summary, decisions (agreed facts only), openQuestions. Ask focused clarification where useful."}\nGoal: ${goal.goal}\nProjects: ${goal.projectRefs.join(", ")}\nCurrent brief: ${JSON.stringify(goal.brief)}\nHuman message: ${input}`;
}

/** One process serializes each seat. Poll cursors and post ids survive restart. */
export class PlanningBridge {
  private readonly busy = new Map<string, Promise<void>>();
  constructor(private readonly store: PlanningStore, private readonly chat: PlanningChat, private readonly runtime: AgentRuntime, private readonly maxQueue = 20) {}

  /** Without an explicit channel, the thread goes to the team's recorded planning channel. */
  async start(goalText: string, explicitChannelId: string | undefined, projectRefs: string[], participantSeatIds: string[] = []): Promise<PlanningGoal> {
    const state = await this.store.read();
    const team = (state.teams as { id: string; slug: string; seats: { id: string; externalIdentities: { mattermost: { username: string } } }[] }[]).find((item) => item.slug === "yahaha");
    const seat = team?.seats.find((item) => item.externalIdentities.mattermost.username === "chickcorea");
    if (!team || !seat) throw new Error("Chick's Yahaha seat is missing from state.");
    const channelId = explicitChannelId ?? planningChannelId(state, team.id);
    if (!channelId?.trim()) throw new Error("No planning channel: pass --channel, or record the team's externalIdentities.mattermost.planningChannelId in state.json.");
    if (!goalText.trim()) throw new Error("A goal is required.");
    if (participantSeatIds.some((id) => !team.seats.some((seat) => seat.id === id))) throw new Error("A participant seat is not in Yahaha.");
    const id = planningId();
    const root = await this.chat.post(channelId, `**Planning goal ${id} — Chick**\n${goalText}\n\nReply here to clarify. Send /proposal in this thread to request a draft for review.`);
    const now = new Date().toISOString();
    const goal: PlanningGoal = { id, teamId: team.id, seatId: seat.id, participantSeatIds, goal: goalText, projectRefs, stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId, rootPostId: root.id }, brief: { summary: goalText, decisions: [], openQuestions: [] } };
    try { await this.store.update((state) => { state.planningGoals = [...(state.planningGoals ?? []), goal]; }, `Start planning goal ${id}`); }
    catch (error) { throw new Error(`Planning root post ${root.id} was created, but state persistence failed; inspect that post and retry after repair.`, { cause: error }); }
    const metadata: RuntimeRecord = { lastSeenAt: Math.max(0, root.create_at - 5000), processedPostIds: [root.id], runs: [] };
    await this.store.saveRuntime(id, metadata);
    const run = await this.runtime.message(prompt(goal, "Start this planning conversation. State what you understand and ask the most useful clarifying question.", false, []), briefSchema);
    metadata.sessionId = run.sessionId;
    metadata.runs.push({ startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.store.saveRuntime(id, metadata);
    const update = brief(run.response);
    await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.brief = { summary: update.summary, decisions: update.decisions, openQuestions: update.openQuestions }; found.updatedAt = new Date().toISOString(); }, `Update brief for goal ${id}`);
    metadata.pending = { inputPostId: root.id, since: root.create_at, message: update.reply };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
    return goal;
  }

  async poll(): Promise<void> {
    const own = await this.chat.ownUserId();
    const goals = (await this.store.read()).planningGoals ?? [];
    for (const goal of goals) {
      const metadata = await this.store.runtime(goal.id);
      if (metadata.pending) await this.deliver(goal, metadata);
      if (goal.stage === "awaiting-review" || goal.stage === "approved") {
        const commands = (await this.chat.since(goal.mattermost.channelId, metadata.lastSeenAt)).filter((post) => post.root_id === goal.mattermost.rootPostId && post.user_id !== own && isCommand(post.message) && !metadata.processedPostIds.includes(post.id)).sort((a, b) => a.create_at - b.create_at);
        for (const post of commands.slice(0, this.maxQueue)) await this.enqueue(goal.seatId, () => this.command(goal.id, post));
        continue;
      }
      const posts = (await this.chat.since(goal.mattermost.channelId, metadata.lastSeenAt)).filter((post) => post.root_id === goal.mattermost.rootPostId && post.user_id !== own && !metadata.processedPostIds.includes(post.id)).sort((a, b) => a.create_at - b.create_at);
      for (const post of posts.slice(0, this.maxQueue)) await this.enqueue(goal.seatId, () => this.handle(goal.id, post));
      if (!posts.length) { metadata.lastSeenAt = Math.max(metadata.lastSeenAt, Date.now() - 5000); await this.store.saveRuntime(goal.id, metadata); }
    }
  }

  private enqueue(seatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.busy.get(seatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.busy.set(seatId, next);
    void next.finally(() => { if (this.busy.get(seatId) === next) this.busy.delete(seatId); }).catch(() => {});
    return next;
  }

  private async handle(id: string, post: Post): Promise<void> {
    const goal = (await this.store.read()).planningGoals?.find((goal) => goal.id === id);
    if (!goal) return;
    const metadata = await this.store.runtime(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (goal.stage === "awaiting-review" || goal.stage === "approved") return;
    if (metadata.processedPostIds.includes(post.id)) return;
    if (post.message.trim() === "/approve") {
      metadata.pending = { inputPostId: post.id, since: post.create_at, message: `Nothing to approve: goal ${id} is at the ${goal.stage} stage. /approve works only while a proposal is awaiting review${goal.stage === "clarifying" ? "; send /proposal to request one" : ""}.` };
      await this.store.saveRuntime(id, metadata);
      await this.deliver(goal, metadata);
      return;
    }
    const drafting = post.message.trim() === "/proposal";
    if (drafting) await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.stage = "drafting"; found.updatedAt = new Date().toISOString(); }, `Start drafting a proposal for goal ${id}`);
    const developers = drafting ? developerSeats(await this.store.read(), goal.teamId).map((seat) => ({ id: seat.id, displayName: seat.displayName ?? seat.id })) : [];
    const run = await this.runtime.message(prompt(goal, post.message, drafting, developers), drafting ? proposalSchema : briefSchema, metadata.sessionId);
    metadata.sessionId = run.sessionId;
    metadata.runs.push({ startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.store.saveRuntime(id, metadata);
    if (drafting) {
      const draft = proposal(run.response, developers);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.proposal = draft; found.stage = "awaiting-review"; found.updatedAt = new Date().toISOString(); }, `Draft proposal for goal ${id}: ${draft.outcomes.length} outcome${draft.outcomes.length === 1 ? "" : "s"}`);
      metadata.pending = { inputPostId: post.id, since: post.create_at, message: proposalMessage({ ...goal, proposal: draft }, teamSeats(await this.store.read(), goal.teamId)) };
    } else {
      const update = brief(run.response);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.brief = { summary: update.summary, decisions: update.decisions, openQuestions: update.openQuestions }; found.updatedAt = new Date().toISOString(); }, `Update brief for goal ${id}`);
      metadata.pending = { inputPostId: post.id, since: post.create_at, message: update.reply };
    }
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  /** Thread commands once a proposal exists. Replies are rebuilt from durable state, so a restart repeats nothing. */
  private async command(id: string, post: Post): Promise<void> {
    const state = await this.store.read();
    const goal = state.planningGoals?.find((item) => item.id === id);
    if (!goal || (goal.stage !== "awaiting-review" && goal.stage !== "approved")) return;
    const metadata = await this.store.runtime(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (metadata.processedPostIds.includes(post.id)) return;
    const seats = teamSeats(state, goal.teamId);
    let message: string;
    if (post.message.trim() === "/proposal") message = goal.stage === "approved" ? approvalMessage(goal, seats) : proposalMessage(goal, seats);
    else if (!(await this.human(state, goal, post))) message = "Only a human can approve a proposal. Nothing changed.";
    else if (goal.stage === "approved") message = approvalMessage(goal, seats);
    else {
      let approved = goal;
      await this.store.update((state) => {
        const found = state.planningGoals!.find((item) => item.id === id)!;
        if (found.stage === "awaiting-review") {
          const now = new Date().toISOString();
          found.stage = "approved";
          found.assignments = found.proposal!.outcomes.map((outcome) => ({ outcomeId: outcome.id, seatId: outcome.seatId, status: "queued", updatedAt: now }));
          found.updatedAt = now;
        }
        approved = structuredClone(found);
      }, () => `Approve goal ${id}: ${approved.assignments?.length ?? 0} assignment${approved.assignments?.length === 1 ? "" : "s"}`);
      message = approvalMessage(approved, seats);
    }
    metadata.pending = { inputPostId: post.id, since: post.create_at, message };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  /** A non-bot Mattermost user who is neither this bridge's account nor Chick's seat. */
  private async human(state: PlanningDocument, goal: PlanningGoal, post: Post): Promise<boolean> {
    const team = (state.teams as { id: string; seats: { id: string; externalIdentities?: { mattermost?: { userId?: string } } }[] }[]).find((item) => item.id === goal.teamId);
    const chick = team?.seats.find((seat) => seat.id === goal.seatId)?.externalIdentities?.mattermost?.userId;
    if (post.user_id === (await this.chat.ownUserId()) || post.user_id === chick) return false;
    return !(await this.chat.isBot(post.user_id));
  }

  private async deliver(goal: PlanningGoal, metadata: RuntimeRecord): Promise<void> {
    const pending = metadata.pending;
    if (!pending) return;
    const own = await this.chat.ownUserId();
    const delivered = (await this.chat.since(goal.mattermost.channelId, Math.max(0, pending.since - 5000))).some((post) => post.user_id === own && post.root_id === goal.mattermost.rootPostId && post.props?.indra_delivery_id === pending.inputPostId);
    if (!delivered) await this.chat.post(goal.mattermost.channelId, pending.message, goal.mattermost.rootPostId, pending.inputPostId);
    metadata.processedPostIds.push(pending.inputPostId);
    metadata.lastSeenAt = Math.max(metadata.lastSeenAt, pending.since);
    delete metadata.pending;
    await this.store.saveRuntime(goal.id, metadata);
  }
}
