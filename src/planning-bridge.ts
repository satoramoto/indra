import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./codex-runtime.js";
import { schemaPathOf } from "./reload.js";
import { planningId } from "./codex-runtime.js";
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
  return `**Planning goal ${id} — Chick**\n${goalText}\n\nReply here to clarify. React :${PROPOSE_EMOJI}: on this post to request a draft proposal for review.`;
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
  return `**Sprint ${goal.id} is ready: ${prUrl}**\nThis PR takes \`${sprintBranch(goal.id)}\` into main. To merge the sprint once its CI is green, a person reacts :${APPROVE_EMOJI}: on this post (or the owner presses M in Chick's detail).`;
}
function revertMessage(goal: PlanningGoal, prUrl: string): string {
  return `**Rollback of sprint ${goal.id}: ${prUrl}**\nThis PR on main reverts the sprint's merge commit ${goal.integration!.mergedSha!.slice(0, 7)}. To merge the revert once its CI is green, a person reacts :${APPROVE_EMOJI}: on this post (or the owner presses M in Chick's detail).`;
}
function nothingToApprove(goal: PlanningGoal): string {
  return `Nothing to approve: goal ${goal.id} is at the ${goal.stage} stage. :${APPROVE_EMOJI}: approves only Chick's proposal post while it awaits review${goal.stage === "clarifying" ? `; react :${PROPOSE_EMOJI}: on the goal post to request one` : ""}.`;
}
/** Reactions have no ID; removing and re-adding one gives a new `create_at`, so it counts as a new request. */
const reactionKey = (reaction: Reaction) => `reaction:${reaction.post_id}:${reaction.user_id}:${reaction.emoji_name}:${reaction.create_at}`;
/** The input key of an owner approval made through `planning approve`. */
const ownerApprovalKey = (goalId: string) => `owner-approve:${goalId}`;
/** The input key of an owner proposal request made through `planning propose`. */
/** One key per owner request, so a request whose draft failed doesn't block the next one. */
const ownerProposalKey = (goalId: string, requestedAt: number) => `owner-propose:${goalId}:${requestedAt}`;
const reviewing = (goal: PlanningGoal) => goal.stage === "awaiting-review" || goal.stage === "approved";

function prompt(goal: PlanningGoal, input: string, drafting: boolean, developers: Seat[]): string {
  const seats = developers.map((seat) => `${seat.id} (${seat.displayName})`).join(", ");
  return `You are Chick Corea, the Team Lead seat in Indra. This is planning only. Read referenced projects when useful, but do not edit files, run implementation, deploy, or claim approval. Return only JSON. ${drafting ? `Create a proposed outcome-based roadmap with keys summary, outcomes (title, description and seatId), risks, openQuestions. This is a draft for human review. Assign every outcome to one of these Developer seats by its seat ID: ${seats || "none"}. Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.` : "Respond to the message and update the durable brief. Keys: reply, summary, decisions (agreed facts only), openQuestions. Ask focused clarification where useful."}\nGoal: ${goal.goal}\nProjects: ${goal.projectRefs.join(", ")}\nCurrent brief: ${JSON.stringify(goal.brief)}\nHuman message: ${input}`;
}

/** One process serializes each seat. Poll cursors, handled posts and handled reactions survive restart. */
export class PlanningBridge {
  private readonly busy = new Map<string, Promise<void>>();
  private readonly github: SprintGitHub;
  /** `shell` runs gh and git for the sprint's integration branch, PR, merge and rollback. */
  constructor(private readonly store: PlanningStore, private readonly chat: PlanningChat, private readonly runtime: AgentRuntime, private readonly maxQueue = 20, shell: Shell = processShell) {
    this.github = new SprintGitHub(shell, store.runtimeDir);
  }

  /** Opens the thread in the team's home channel and records the team's project on the goal; both come from state. */
  async start(goalText: string, participantSeatIds: string[] = []): Promise<PlanningGoal> {
    const state = await this.store.read();
    const team = (state.teams as { id: string; slug: string; seats: { id: string; externalIdentities: { mattermost: { username: string } } }[] }[]).find((item) => item.slug === "yahaha");
    const seat = team?.seats.find((item) => item.externalIdentities.mattermost.username === "chickcorea");
    if (!team || !seat) throw new Error("Chick's Yahaha seat is missing from state.");
    const { channelId, github } = requireTeamHome(state, team.id);
    if (!goalText.trim()) throw new Error("A goal is required.");
    if (participantSeatIds.some((id) => !team.seats.some((seat) => seat.id === id))) throw new Error("A participant seat is not in Yahaha.");
    const id = planningId();
    const root = await this.chat.post(channelId, rootMessage(id, goalText));
    const now = new Date().toISOString();
    const goal: PlanningGoal = { id, teamId: team.id, seatId: seat.id, participantSeatIds, goal: goalText, projectRefs: [github], stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId, rootPostId: root.id }, brief: { summary: goalText, decisions: [], openQuestions: [] } };
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
    // `planning approve` runs in another process; the goal lock keeps it and this poll off each other's runtime metadata.
    for (const goal of goals) await this.store.withGoalLock(goal.id, () => this.pollGoal(goal, own));
  }

  private async pollGoal(goal: PlanningGoal, own: string): Promise<void> {
    const metadata = await this.store.runtime(goal.id);
    if (metadata.pending) await this.deliver(goal, metadata);
    // Drafts run inside this goal's lock, so a goal still in `drafting` here was left by a crash, restart or older build.
    const current = (await this.store.read()).planningGoals?.find((item) => item.id === goal.id);
    if (current?.stage === "drafting") { await this.revertDraft(current, metadata, `draft-recovery:${current.updatedAt}`, Date.now()); return; }
    let budget = this.maxQueue;
    if (!reviewing(goal)) {
      const posts = (await this.chat.since(goal.mattermost.channelId, metadata.lastSeenAt)).filter((post) => post.root_id === goal.mattermost.rootPostId && post.user_id !== own && !metadata.processedPostIds.includes(post.id)).sort((a, b) => a.create_at - b.create_at).slice(0, budget);
      budget -= posts.length;
      for (const post of posts) await this.enqueue(goal.seatId, () => this.handle(goal.id, post));
      if (!posts.length) { metadata.lastSeenAt = Math.max(metadata.lastSeenAt, Date.now() - 5000); await this.store.saveRuntime(goal.id, metadata); }
    }
    const reactions = (await this.newReactions(goal, own)).slice(0, budget);
    budget -= reactions.length;
    for (const { reaction, key } of reactions) await this.enqueue(goal.seatId, () => this.react(goal.id, reaction, key));
    // After the reactions, so a 📝 and a `planning propose` seen in the same poll draft once.
    if (budget > 0 && (await this.store.runtime(goal.id)).proposalRequest) await this.enqueue(goal.seatId, () => this.ownerProposal(goal.id));
    // A GitHub problem is logged and retried on the next poll; it never stops the bridge.
    if (current?.stage === "approved" && current.integration?.status === "collecting") {
      try { await this.enqueue(goal.seatId, () => this.sprintProgress(goal.id)); }
      catch (error) { console.error(`Sprint ${goal.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /**
   * Opens the integration PR once every assignment merged, or, once each has either merged or failed, posts once
   * that the owner can still open it for what merged (`planning integrate`, I in the terminal UI).
   */
  private async sprintProgress(id: string): Promise<void> {
    const state = await this.store.read();
    const goal = state.planningGoals?.find((item) => item.id === id);
    if (!goal?.integration || goal.integration.status !== "collecting" || !goal.assignments?.length) return;
    const metadata = await this.store.runtime(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    const statuses = goal.assignments.map((item) => item.status);
    if (statuses.every((status) => status === "merged")) { await this.openIntegration(goal, metadata); return; }
    const key = `sprint-incomplete:${id}`;
    if (!statuses.every((status) => status === "merged" || status === "failed") || metadata.processedPostIds.includes(key)) return;
    const { merged, missed } = outcomeLines(goal, teamSeats(state, goal.teamId));
    metadata.pending = { inputPostId: key, since: Date.now(), message: `**Sprint ${id} is not complete**\n${missed.join("\n")}\n\n${merged.length ? `${merged.length} outcome(s) merged into \`${goal.integration.branch}\`. The owner can still open the integration PR for what merged: press I in Chick's detail (\`planning integrate --goal ${id}\`).` : "Nothing merged, so there is no integration PR to open."}` };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  /** Opens (or finds) the one PR from the sprint branch into main, records it and posts it in the thread as the merge post. */
  private async openIntegration(goal: PlanningGoal, metadata: RuntimeRecord): Promise<string> {
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
      const metadata = await this.store.runtime(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      return `Opened the integration PR for sprint ${id}: ${await this.openIntegration(goal, metadata)}`;
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
  private async mergeGate(id: string, kind: MergeKind | undefined): Promise<{ message: string; merged: boolean; post: boolean }> {
    const goal = this.approvedGoal((await this.store.read()).planningGoals?.find((item) => item.id === id), id);
    const integration = goal.integration!;
    const target: MergeKind | undefined = kind ?? (integration.status === "pr-open" ? "integration" : integration.status === "merged" && integration.revertPrUrl ? "revert" : undefined);
    if (target === "integration" && (integration.status === "merged" || integration.status === "reverted")) return { message: `Sprint ${id} is already merged into main as ${integration.mergedSha!.slice(0, 7)} (${integration.prUrl}).`, merged: false, post: true };
    if (target === "revert" && integration.status === "reverted") return { message: `Sprint ${id} is already rolled back (${integration.revertPrUrl}).`, merged: false, post: true };
    const prUrl = target === "integration" && integration.status === "pr-open" ? integration.prUrl : target === "revert" && integration.status === "merged" ? integration.revertPrUrl : undefined;
    if (!target || !prUrl) return { message: `Nothing to merge for sprint ${id}: it is ${integration.status}${integration.status === "collecting" ? " and has no integration PR yet" : ""}.`, merged: false, post: false };
    const result = await this.github.merge(prUrl);
    if (!result.merged) return { message: `Not merged: ${result.reason}. Nothing changed; merge again once CI is green.`, merged: false, post: true };
    await this.store.update((state) => {
      const found = state.planningGoals!.find((item) => item.id === id)!;
      const current = found.integration!;
      if (target === "integration" && current.status === "pr-open") found.integration = { ...current, status: "merged", mergedSha: result.sha };
      else if (target === "revert" && current.status === "merged") found.integration = { ...current, status: "reverted" };
      else return;
      found.updatedAt = new Date().toISOString();
    }, target === "integration" ? `Merge sprint ${id} into main` : `Revert sprint ${id} on main`);
    return { message: target === "integration" ? `**Sprint ${id} merged into main** as ${result.sha.slice(0, 7)} (${prUrl}). To roll the whole sprint back: \`planning rollback --goal ${id}\`, or V in Chick's detail.` : `**Sprint ${id} rolled back** on main by ${prUrl} (${result.sha.slice(0, 7)}).`, merged: true, post: true };
  }

  /** The owner's `planning merge` (M in the terminal UI): merges the open integration or revert PR through the same path as ✅. */
  async merge(id: string): Promise<string> {
    return await this.store.withGoalLock(id, async () => {
      const goal = this.approvedGoal((await this.store.read()).planningGoals?.find((item) => item.id === id), id);
      const metadata = await this.store.runtime(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      const result = await this.mergeGate(id, undefined);
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
      const metadata = await this.store.runtime(id);
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
    const metadata = await this.store.runtime(goal.id);
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
    const metadata = await this.store.runtime(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (reviewing(goal) || metadata.processedPostIds.includes(post.id)) return;
    await this.converse(goal, metadata, post.id, post.create_at, post.message, false);
  }

  /** Runs Chick's session on one input: a clarifying reply, or (when drafting) the request for a proposal. */
  private async converse(goal: PlanningGoal, metadata: RuntimeRecord, inputKey: string, since: number, message: string, drafting: boolean): Promise<void> {
    const id = goal.id;
    if (drafting) await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.stage = "drafting"; found.updatedAt = new Date().toISOString(); }, `Start drafting a proposal for goal ${id}`);
    const developers = drafting ? developerSeats(await this.store.read(), goal.teamId).map((seat) => ({ id: seat.id, displayName: seat.displayName ?? seat.id })) : [];
    let run: Awaited<ReturnType<AgentRuntime["message"]>>;
    let draft: NonNullable<PlanningGoal["proposal"]> | undefined;
    try {
      run = await this.runtime.message(prompt(goal, message, drafting, developers), drafting ? proposalSchema : briefSchema, metadata.sessionId);
      if (drafting) draft = proposal(run.response, developers);
    } catch (error) {
      if (!drafting) throw error;
      console.error(`Planning draft for goal ${id} failed; reverting to clarifying.`);
      await this.revertDraft(goal, metadata, inputKey, since);
      return;
    }
    metadata.sessionId = run.sessionId;
    metadata.runs.push({ startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage });
    await this.store.saveRuntime(id, metadata);
    if (draft) {
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.proposal = draft; found.stage = "awaiting-review"; found.updatedAt = new Date().toISOString(); }, `Draft proposal for goal ${id}: ${draft.outcomes.length} outcome${draft.outcomes.length === 1 ? "" : "s"}`);
      metadata.pending = { inputPostId: inputKey, since, message: proposalMessage({ ...goal, proposal: draft }, teamSeats(await this.store.read(), goal.teamId)), proposal: true };
    } else {
      const update = brief(run.response);
      await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === id)!; found.brief = { summary: update.summary, decisions: update.decisions, openQuestions: update.openQuestions }; found.updatedAt = new Date().toISOString(); }, `Update brief for goal ${id}`);
      metadata.pending = { inputPostId: inputKey, since, message: update.reply };
    }
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  /** Puts a goal whose draft failed or was interrupted back to clarifying and queues one reply saying so. */
  private async revertDraft(goal: PlanningGoal, metadata: RuntimeRecord, inputKey: string, since: number): Promise<void> {
    await this.store.update((state) => { const found = state.planningGoals!.find((item) => item.id === goal.id)!; if (found.stage === "drafting") { found.stage = "clarifying"; found.updatedAt = new Date().toISOString(); } }, `Revert goal ${goal.id} to clarifying after a failed draft`);
    metadata.pending = { inputPostId: inputKey, since, message: `Drafting the proposal failed, so goal ${goal.id} is back to clarifying. React :${PROPOSE_EMOJI}: on the goal post again (or press P in the UI) to retry.` };
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
    const metadata = await this.store.runtime(id);
    if (metadata.pending) await this.deliver(goal, metadata);
    if (metadata.processedPostIds.includes(key)) return;
    const seats = teamSeats(state, goal.teamId);
    const approving = reaction.emoji_name === APPROVE_EMOJI;
    const gate = approving ? metadata.mergePosts?.find((item) => item.id === reaction.post_id) : undefined;
    let message: string; let announcesProposal = false;
    if (!(await this.human(state, goal, reaction.user_id))) message = `Only a person can ${gate ? "merge a sprint" : approving ? "approve a proposal" : "request a proposal"}; reactions from bots and Chick don't count. Nothing changed.`;
    else if (gate) {
      try { message = (await this.mergeGate(id, gate.kind)).message; }
      catch (error) { console.error(`Sprint ${id} merge failed: ${error instanceof Error ? error.message : String(error)}`); message = `Could not merge the sprint's PR right now; nothing changed. React :${APPROVE_EMOJI}: again (remove and re-add it) to retry.`; }
    }
    else if (goal.stage === "approved") message = approvalMessage(goal, seats);
    else if (!approving && goal.stage === "awaiting-review") { message = proposalMessage(goal, seats); announcesProposal = true; }
    else if (!approving) { await this.draft(goal, metadata, key, reaction.create_at); return; }
    else if (goal.stage !== "awaiting-review") message = nothingToApprove(goal);
    else if (reaction.post_id === goal.mattermost.rootPostId) message = `To approve proposal ${goal.proposal!.id}, react :${APPROVE_EMOJI}: on Chick's proposal post rather than the goal post. Nothing changed.`;
    else {
      let integration: SprintIntegration;
      try { integration = await this.createSprint(state, goal); }
      catch (error) {
        console.error(`Sprint branch for goal ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
        message = `Could not create the sprint branch \`${sprintBranch(id)}\` on GitHub, so nothing was approved. React :${APPROVE_EMOJI}: again (remove and re-add it) or press A in Chick's detail to retry.`;
        metadata.pending = { inputPostId: key, since: reaction.create_at, message };
        await this.store.saveRuntime(id, metadata);
        await this.deliver(goal, metadata);
        return;
      }
      await this.approveAndConfirm(id, metadata, key, reaction.create_at, integration);
      return;
    }
    metadata.pending = { inputPostId: key, since: reaction.create_at, message, ...(announcesProposal ? { proposal: true } : {}) };
    await this.store.saveRuntime(id, metadata);
    await this.deliver(goal, metadata);
  }

  /** The one drafting path, used by the 📝 reaction and by `planning propose`. */
  private async draft(goal: PlanningGoal, metadata: RuntimeRecord, inputKey: string, since: number): Promise<void> {
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
    const metadata = await this.store.runtime(id);
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
  private async approveAndConfirm(id: string, metadata: RuntimeRecord, inputKey: string, since: number, integration?: SprintIntegration): Promise<PlanningGoal> {
    let approved: PlanningGoal | undefined;
    await this.store.update((state) => {
      const found = state.planningGoals?.find((item) => item.id === id);
      if (!found || !reviewing(found)) throw new Error(`Goal ${id} has no proposal awaiting review.`);
      if (found.stage === "awaiting-review") {
        if (!integration) throw new Error(`Goal ${id} has no sprint branch yet.`);
        const now = new Date().toISOString();
        found.stage = "approved";
        found.assignments = found.proposal!.outcomes.map((outcome) => ({ outcomeId: outcome.id, seatId: outcome.seatId, status: "queued", updatedAt: now }));
        found.integration = integration;
        found.updatedAt = now;
      }
      approved = structuredClone(found);
    }, () => `Approve goal ${id}: ${approved!.assignments?.length ?? 0} assignment${approved!.assignments?.length === 1 ? "" : "s"}`);
    const goal = approved!;
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
      const metadata = await this.store.runtime(id);
      if (metadata.pending) await this.deliver(goal, metadata);
      const key = ownerApprovalKey(id);
      const alreadyApproved = goal.stage === "approved";
      if (alreadyApproved && metadata.processedPostIds.includes(key)) return { goal, alreadyApproved };
      const integration = alreadyApproved ? undefined : await this.createSprint(await this.store.read(), goal);
      return { goal: await this.approveAndConfirm(id, metadata, key, Date.now(), integration), alreadyApproved };
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
      if (goal.stage !== "clarifying") throw new Error(`Goal ${id} is at the ${goal.stage} stage; a proposal can be requested only while it is clarifying.`);
      return goal;
    };
    check((await store.read()).planningGoals?.find((item) => item.id === id));
    return await store.withGoalLock(id, async () => {
      const goal = check((await store.read()).planningGoals?.find((item) => item.id === id));
      const metadata = await store.runtime(id);
      if (metadata.proposalRequest) return { goal, alreadyRequested: true };
      metadata.proposalRequest = { requestedAt: Date.now() };
      await store.saveRuntime(id, metadata);
      return { goal, alreadyRequested: false };
    });
  }

  /** A non-bot Mattermost user who is neither this bridge's account nor Chick's seat. */
  private async human(state: PlanningDocument, goal: PlanningGoal, userId: string): Promise<boolean> {
    const team = (state.teams as { id: string; seats: { id: string; externalIdentities?: { mattermost?: { userId?: string } } }[] }[]).find((item) => item.id === goal.teamId);
    const chick = team?.seats.find((seat) => seat.id === goal.seatId)?.externalIdentities?.mattermost?.userId;
    if (userId === (await this.chat.ownUserId()) || userId === chick) return false;
    return !(await this.chat.isBot(userId));
  }

  private async deliver(goal: PlanningGoal, metadata: RuntimeRecord): Promise<void> {
    const pending = metadata.pending;
    if (!pending) return;
    const own = await this.chat.ownUserId();
    const delivered = (await this.chat.since(goal.mattermost.channelId, Math.max(0, pending.since - 5000))).find((post) => post.user_id === own && post.root_id === goal.mattermost.rootPostId && post.props?.indra_delivery_id === pending.inputPostId);
    const post = delivered ?? await this.chat.post(goal.mattermost.channelId, pending.message, goal.mattermost.rootPostId, pending.inputPostId);
    // The proposal post is where people react ✅; it is found again after a restart by its delivery ID.
    if (pending.proposal && !(metadata.proposalPostIds ?? []).includes(post.id)) metadata.proposalPostIds = [...(metadata.proposalPostIds ?? []), post.id];
    if (pending.mergePost && !(metadata.mergePosts ?? []).some((item) => item.id === post.id)) metadata.mergePosts = [...(metadata.mergePosts ?? []), { id: post.id, kind: pending.mergePost }];
    metadata.processedPostIds.push(pending.inputPostId);
    metadata.lastSeenAt = Math.max(metadata.lastSeenAt, pending.since);
    delete metadata.pending;
    await this.store.saveRuntime(goal.id, metadata);
  }
}
