import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./codex-runtime.js";
import { planningId } from "./codex-runtime.js";
import { PlanningStore, type PlanningGoal, type RuntimeRecord } from "./planning.js";

export interface Post { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number; props?: { indra_delivery_id?: string } }
export interface PlanningChat {
  ownUserId(): Promise<string>;
  post(channelId: string, message: string, rootId?: string, deliveryId?: string): Promise<Post>;
  since(channelId: string, timestamp: number): Promise<Post[]>;
  typing?(channelId: string, rootPostId: string, signal: AbortSignal): Promise<void>;
  stopTyping?(): void;
}

const TYPING_REFRESH_MS = 3_000;

/** Typing is advisory; failed or slow signaling never changes message delivery. */
function startTyping(chat: PlanningChat, channelId: string, rootPostId: string): () => void {
  if (!chat.typing) return () => {};
  const controller = new AbortController();
  let sending = false;
  const refresh = () => {
    if (controller.signal.aborted || sending) return;
    sending = true;
    void chat.typing!(channelId, rootPostId, controller.signal).catch(() => {}).finally(() => { sending = false; });
  };
  refresh();
  const timer = setInterval(refresh, TYPING_REFRESH_MS);
  timer.unref?.();
  return () => { clearInterval(timer); controller.abort(); try { chat.stopTyping?.(); } catch { /* advisory cleanup */ } };
}

const briefSchema = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "brief.json");
const proposalSchema = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "proposal.json");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && !!item.trim());

function brief(value: unknown): { reply: string; summary: string; decisions: string[]; openQuestions: string[] } {
  if (!isObject(value) || typeof value.reply !== "string" || typeof value.summary !== "string" || !value.summary.trim() || !stringArray(value.decisions) || !stringArray(value.openQuestions)) throw new Error("Codex returned an invalid brief response.");
  return value as { reply: string; summary: string; decisions: string[]; openQuestions: string[] };
}
function proposal(value: unknown): NonNullable<PlanningGoal["proposal"]> {
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.outcomes) || !value.outcomes.length || !value.outcomes.every((item) => isObject(item) && typeof item.title === "string" && !!item.title.trim() && typeof item.description === "string" && !!item.description.trim()) || !stringArray(value.risks) || !stringArray(value.openQuestions)) throw new Error("Codex returned an invalid proposal.");
  return { id: `proposal-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), summary: value.summary, outcomes: value.outcomes.map((item, index) => ({ id: `outcome-${index + 1}`, title: item.title, description: item.description })), risks: value.risks, openQuestions: value.openQuestions };
}
function proposalMessage(goal: PlanningGoal): string {
  const draft = goal.proposal!;
  return `**Draft proposal ${draft.id} — awaiting review**\n${draft.summary}\n${draft.outcomes.map((item) => `- **${item.title}:** ${item.description}`).join("\n")}\n\nRecorded in indra-state as ${goal.id}. No work has been approved or executed.`;
}

function prompt(goal: PlanningGoal, input: string, drafting: boolean): string {
  return `You are Chick Corea, the Team Lead seat in Indra. This is planning only. Read referenced projects when useful, but do not edit files, run implementation, deploy, or claim approval. Return only JSON. ${drafting ? "Create a proposed outcome-based roadmap with keys summary, outcomes (title and description), risks, openQuestions. This is a draft for human review." : "Respond to the message and update the durable brief. Keys: reply, summary, decisions (agreed facts only), openQuestions. Ask focused clarification where useful."}\nGoal: ${goal.goal}\nProjects: ${goal.projectRefs.join(", ")}\nCurrent brief: ${JSON.stringify(goal.brief)}\nHuman message: ${input}`;
}

/** One process serializes each seat. Poll cursors and post ids survive restart. */
export class PlanningBridge {
  private readonly busy = new Map<string, Promise<void>>();
  constructor(private readonly store: PlanningStore, private readonly chat: PlanningChat, private readonly runtime: AgentRuntime, private readonly maxQueue = 20) {}

  async start(goalText: string, channelId: string, projectRefs: string[], participantSeatIds: string[] = []): Promise<PlanningGoal> {
    const state = await this.store.read();
    const team = (state.teams as { id: string; slug: string; seats: { id: string; externalIdentities: { mattermost: { username: string } } }[] }[]).find((item) => item.slug === "yahaha");
    const seat = team?.seats.find((item) => item.externalIdentities.mattermost.username === "chickcorea");
    if (!team || !seat) throw new Error("Chick's Yahaha seat is missing from state.");
    if (!goalText.trim() || !channelId.trim()) throw new Error("Goal and channel ID are required.");
    if (participantSeatIds.some((id) => !team.seats.some((seat) => seat.id === id))) throw new Error("A participant seat is not in Yahaha.");
    const id = planningId();
    const root = await this.chat.post(channelId, `**Planning goal ${id} — Chick**\n${goalText}\n\nReply here to clarify. Send /proposal in this thread to request a draft for review.`);
    const now = new Date().toISOString();
    const goal: PlanningGoal = { id, teamId: team.id, seatId: seat.id, participantSeatIds, goal: goalText, projectRefs, stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId, rootPostId: root.id }, brief: { summary: goalText, decisions: [], openQuestions: [] } };
    try { await this.store.update((state) => { state.planningGoals = [...(state.planningGoals ?? []), goal]; }); }
    catch (error) { throw new Error(`Planning root post ${root.id} was created, but state persistence failed; inspect that post and retry after repair.`, { cause: error }); }
    const metadata: RuntimeRecord = { lastSeenAt: Math.max(0, root.create_at - 5000), processedPostIds: [root.id], runs: [] };
    await this.store.saveRuntime(id, metadata);
    const run = await this.runtime.message(prompt(goal, "Start this planning conversation. State what you understand and ask the most useful clarifying question.", false), briefSchema);
    metadata.sessionId = run.sessionId;
    metadata.runs.push({ startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.store.saveRuntime(id, metadata);
    const update = brief(run.response);
    await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.brief = { summary: update.summary, decisions: update.decisions, openQuestions: update.openQuestions }; found.updatedAt = new Date().toISOString(); });
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
      if (goal.stage === "awaiting-review") {
        const request = (await this.chat.since(goal.mattermost.channelId, metadata.lastSeenAt)).find((post) => post.root_id === goal.mattermost.rootPostId && post.user_id !== own && post.message.trim() === "/proposal" && !metadata.processedPostIds.includes(post.id));
        if (request && goal.proposal) {
          metadata.pending = { inputPostId: request.id, since: request.create_at, message: proposalMessage(goal) };
          await this.store.saveRuntime(goal.id, metadata);
          await this.deliver(goal, metadata);
        }
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
    if (goal.stage === "awaiting-review") return;
    if (metadata.processedPostIds.includes(post.id)) return;
    const stopTyping = startTyping(this.chat, goal.mattermost.channelId, goal.mattermost.rootPostId);
    try {
    const drafting = post.message.trim() === "/proposal";
    if (drafting) await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.stage = "drafting"; found.updatedAt = new Date().toISOString(); });
    const run = await this.runtime.message(prompt(goal, post.message, drafting), drafting ? proposalSchema : briefSchema, metadata.sessionId);
    metadata.sessionId = run.sessionId;
    metadata.runs.push({ startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.store.saveRuntime(id, metadata);
    if (drafting) {
      const draft = proposal(run.response);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.proposal = draft; found.stage = "awaiting-review"; found.updatedAt = new Date().toISOString(); });
      metadata.pending = { inputPostId: post.id, since: post.create_at, message: proposalMessage({ ...goal, proposal: draft }) };
    } else {
      const update = brief(run.response);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.brief = { summary: update.summary, decisions: update.decisions, openQuestions: update.openQuestions }; found.updatedAt = new Date().toISOString(); });
      metadata.pending = { inputPostId: post.id, since: post.create_at, message: update.reply };
    }
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
    } finally { stopTyping(); }
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
