import { createHash } from "node:crypto";
import { upcomingCandidateSprints } from "./candidate-sprints.js";
import { startCeremony, validateCeremony } from "./ceremony.js";
import type { BridgeAdapterServices } from "./control-adapters.js";
import { PlanningBridge, type CeremonyAdapters, type CeremonyContext, type PlanningChat } from "./planning-bridge.js";
import { developerSeats, requireTeamHome, type PlanningDocument, type PlanningGoal, type PlanningStore } from "./planning.js";
import { nextSprintText, rootMessage, type NextSprintRetro } from "./planning-text.js";
import { isActiveSeat, type BacklogTicket, type SprintCandidate, type TeamRecord } from "./state-domain.js";

export const controlServices = ["nextSprint"] as const;
export const nextSprintRuntimeName = (goalId: string) => `next-sprint-${goalId}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const closureKey = (goal: PlanningGoal) => `closed-sprint:${goal.id}:${goal.ceremony!.closure!.closedAt}`;
const nextGoalId = (key: string) => `goal-next-${digest(key).slice(0, 20)}`;

export type CandidateSelection = { status: "eligible"; candidate: SprintCandidate; tickets: BacklogTicket[] }
  | { status: "waiting"; reason: string };

/** Internal dependencies may land together; external dependencies must already be done. */
export function selectNextCandidate(team: TeamRecord): CandidateSelection {
  const tickets = new Map((team.backlog ?? []).map((ticket) => [ticket.id, ticket]));
  if (![...tickets.values()].some((ticket) => ticket.status === "open")) return { status: "waiting", reason: "The backlog has no open tickets." };
  const candidates = upcomingCandidateSprints(team.sprintCandidates ?? []);
  if (!candidates.length) return { status: "waiting", reason: "The backlog has no upcoming sprint candidates." };
  const blocked: string[] = [];
  for (const candidate of candidates) {
    const members = new Set(candidate.ticketIds);
    const visited = new Set<string>(); const visiting = new Set<string>();
    const eligible = (id: string): boolean => {
      const ticket = tickets.get(id);
      if (!ticket || (members.has(id) ? ticket.status !== "open" : ticket.status !== "done")) return false;
      if (!members.has(id) || visited.has(id)) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      if (!(ticket.dependsOn ?? []).every(eligible)) return false;
      visiting.delete(id); visited.add(id);
      return true;
    };
    const reserved = (team.sprintCandidates ?? []).some((other) => other.id !== candidate.id && other.status === "proposed" && other.ticketIds.some((id) => members.has(id)));
    if (candidate.goalId || reserved || !members.size || members.size !== candidate.ticketIds.length || !candidate.ticketIds.every(eligible)) {
      blocked.push(candidate.id); continue;
    }
    return { status: "eligible", candidate, tickets: candidate.ticketIds.map((id) => tickets.get(id)!) };
  }
  return { status: "waiting", reason: `Upcoming candidates are blocked by ticket status, reservations or dependencies: ${blocked.join(", ")}.` };
}

/** Delivery journals and waiting reasons stay in runtime; candidate/goal links stay in state. */
export interface NextSprintRecord {
  key: string; status: "waiting" | "reserved" | "proposed"; reason?: string; goalId?: string;
}
class Waiting extends Error {}
const wait = (reason: string): never => { throw new Waiting(reason); };
const teamIn = (state: PlanningDocument, id: string) => (state.teams as TeamRecord[]).find((team) => team.id === id)!;
const latestClosed = (state: PlanningDocument, teamId: string) => (state.planningGoals ?? [])
  .filter((goal) => goal.teamId === teamId && goal.ceremony?.closure)
  .sort((a, b) => Date.parse(b.ceremony!.closure!.closedAt) - Date.parse(a.ceremony!.closure!.closedAt) || a.id.localeCompare(b.id))[0];

interface FrozenPublication {
  goalId: string; github: string; prUrl?: string; postIds?: string[]; verifiedAt?: string;
  frozen?: { markdown: string; sha256: string; draft?: { narrative?: { ownerProposals?: { text: string; evidenceId: string }[] } } };
}

/** Missing local evidence never becomes a reconstructed retrospective or an invented recommendation. */
export async function latestFrozenRetro(store: PlanningStore, state: PlanningDocument, teamId: string): Promise<NextSprintRetro | undefined> {
  const goals = (state.planningGoals ?? []).filter((goal) => goal.teamId === teamId && goal.ceremony?.closure?.evidence.kind === "retro-published")
    .sort((a, b) => Date.parse(b.ceremony!.closure!.closedAt) - Date.parse(a.ceremony!.closure!.closedAt) || a.id.localeCompare(b.id));
  for (const goal of goals) {
    const evidence = goal.ceremony!.closure!.evidence;
    if (evidence.kind !== "retro-published") continue;
    let record: FrozenPublication | undefined;
    try { record = await store.readRuntimeFile<FrozenPublication>(`retro-publication-${goal.id}`); }
    catch { continue; }
    const frozen = record?.frozen;
    if (!frozen || typeof frozen.markdown !== "string" || !frozen.markdown.trim() || digest(frozen.markdown) !== frozen.sha256
      || record!.goalId !== goal.id || record!.github !== teamIn(state, teamId).project?.github || record!.prUrl !== evidence.prUrl
      || !Array.isArray(record!.postIds) || !record!.postIds.includes(evidence.postId) || record!.verifiedAt !== evidence.publishedAt) continue;
    const recorded = frozen.draft?.narrative?.ownerProposals;
    const proposals = Array.isArray(recorded) ? recorded.filter((item) => item && typeof item.text === "string" && typeof item.evidenceId === "string" && frozen.markdown.includes(item.text) && frozen.markdown.includes(`[${item.evidenceId}]`)) : [];
    return { goalId: goal.id, evidence, ownerProposals: proposals };
  }
}

function basis(state: PlanningDocument, teamId: string) {
  const team = teamIn(state, teamId);
  const selection = selectNextCandidate(team);
  if (selection.status === "waiting") return wait(selection.reason);
  if (!team.mission?.trim()) return wait("The owner has not set the team mission.");
  const lead = team.seats.find((seat) => seat.roles.includes("Team Lead") && isActiveSeat(seat));
  if (!lead) return wait("The team has no active Team Lead.");
  const developers = developerSeats(state, teamId);
  if (!developers.length) return wait("The team has no active Developer seats.");
  const home = requireTeamHome(state, teamId);
  return { ...selection, mission: team.mission, lead, developers, home };
}

/**
 * The same team creation lock as PlanningBridge.start excludes owner starts and other closure handlers.
 * A generic, recoverable root precedes one state transaction reserving the CURRENT candidate and its goal.
 * Chick's existing draft outbox and approval path own everything after that transaction.
 */
export class NextSprint {
  constructor(private readonly store: PlanningStore, private readonly chat: PlanningChat) {}

  async closedSprint(context: CeremonyContext, key: string): Promise<void> {
    await this.store.withGoalLock(`planning-team-${context.goal.teamId}-creation`, async () => {
      try {
        // Recover an interrupted state commit before inspecting closure or reservation evidence.
        await this.store.update(() => {}, "Recover next sprint reservation");
        const state = await this.store.read();
        const closed = state.planningGoals?.find((goal) => goal.id === context.goal.id);
        if (!closed?.ceremony?.closure || closureKey(closed) !== key) return wait("Sprint closure has not been verified.");
        validateCeremony(closed);
        if (latestClosed(state, closed.teamId)?.id !== closed.id) return;
        if (closed.ceremony.closure.evidence.kind === "legacy-migration") return wait("Legacy migration has no new sprint closure to propose from.");
        const id = nextGoalId(key);
        let goal = state.planningGoals?.find((item) => item.id === id);
        if (!goal) goal = await this.reserve(state, closed, key, id);
        if (goal.teamId !== closed.teamId || !goal.source) return wait("The reserved next goal has conflicting source evidence.");
        await this.store.saveRuntime(nextSprintRuntimeName(closed.id), { key, goalId: id, status: "reserved" } satisfies NextSprintRecord);
        const metadata = await this.store.runtime(id);
        if (goal.proposal && metadata.proposalPostIds?.length) {
          await this.store.saveRuntime(nextSprintRuntimeName(closed.id), { key, goalId: id, status: "proposed" } satisfies NextSprintRecord);
          return;
        }
        if (!goal.proposal) {
          if (metadata.lastDraftError && Date.now() - Date.parse(metadata.lastDraftError.at) < 30_000) return wait("Chick's draft failed; the reserved candidate will be retried shortly.");
          // This queues a draft, never an approval. requestProposal and the bridge serialize on the goal lock.
          await PlanningBridge.requestProposal(this.store, id);
        }
        return wait("The candidate is reserved; waiting for Chick's proposal to be delivered.");
      } catch (error) {
        if (error instanceof Waiting) {
          const record = await this.store.readRuntimeFile<NextSprintRecord>(nextSprintRuntimeName(context.goal.id));
          await this.store.saveRuntime(nextSprintRuntimeName(context.goal.id), { ...record, key, status: "waiting", reason: error.message } satisfies NextSprintRecord);
          await this.store.withGoalLock(context.goal.id, () => context.post(`next-sprint-waiting:${digest(error.message)}`, `**Next sprint: waiting**\n${error.message}`));
        }
        // The bridge acknowledges a closure hook only after it succeeds. Waiting must remain retryable.
        throw error;
      }
    });
  }

  private async reserve(state: PlanningDocument, closed: PlanningGoal, key: string, id: string): Promise<PlanningGoal> {
    const open = state.planningGoals?.find((goal) => goal.teamId === closed.teamId && !goal.ceremony?.closure);
    if (open) return wait(`Team ${closed.teamId} still has open goal ${open.id}.`);
    if ((await this.store.readRuntimeFile<{ pending?: unknown }>(`planning-start-${closed.teamId}`))?.pending) return wait("An existing planning start is awaiting recovery.");
    const selected = basis(state, closed.teamId);
    const revision = digest(JSON.stringify(selected));
    const retro = await latestFrozenRetro(this.store, state, closed.teamId);
    const own = await this.chat.ownUserId();
    if (selected.lead.externalIdentities.mattermost.userId !== own) return wait("Chick's chat identity does not match the team's active Team Lead.");
    return this.store.withGoalLock(id, async () => {
      const delivery = `planning-root:${id}`;
      const root = (await this.chat.since(selected.home.channelId, Math.max(0, Date.parse(closed.ceremony!.closure!.closedAt) - 5000)))
        .find((post) => post.user_id === own && post.channel_id === selected.home.channelId && !post.root_id && post.props?.indra_delivery_id === delivery)
        ?? await this.chat.post(selected.home.channelId, rootMessage(id, `Next sprint after verified closure of ${closed.id}. Chick is selecting the highest-ranked eligible backlog candidate; the proposal will cite its tickets, value and available frozen retrospective.`), undefined, delivery);
      const at = new Date().toISOString();
      const source: NonNullable<PlanningGoal["source"]> = { candidateId: selected.candidate.id, ticketIds: selected.candidate.ticketIds, ...(retro ? { retrospectiveGoalId: retro.goalId } : {}) };
      const goalText = nextSprintText({ closedGoalId: closed.id, mission: selected.mission, candidate: selected.candidate, tickets: selected.tickets, github: selected.home.github, retro });
      const goal: PlanningGoal = { id, teamId: closed.teamId, seatId: selected.lead.id, participantSeatIds: [], goal: goalText,
        projectRefs: [selected.home.github], stage: "clarifying", createdAt: at, updatedAt: at,
        mattermost: { channelId: selected.home.channelId, rootPostId: root.id }, brief: { summary: goalText, decisions: [], openQuestions: [] }, source, ceremony: startCeremony(at) };
      await this.store.saveRuntime(id, { lastSeenAt: Math.max(0, root.create_at - 5000), processedPostIds: [root.id], runs: [] });
      await this.store.update((current) => {
        if (latestClosed(current, closed.teamId)?.id !== closed.id || current.planningGoals?.some((item) => item.teamId === closed.teamId && !item.ceremony?.closure)) return wait("The team's current sprint changed before reservation.");
        const currentBasis = basis(current, closed.teamId);
        if (digest(JSON.stringify(currentBasis)) !== revision) return wait("The candidate or team changed before reservation; selection will be refreshed.");
        current.planningGoals = [...(current.planningGoals ?? []), goal];
        Object.assign(currentBasis.candidate, { status: "proposed", goalId: id, updatedAt: at, updatedBySeatId: selected.lead.id });
        if (retro) currentBasis.candidate.retrospectiveGoalId = retro.goalId;
        else delete currentBasis.candidate.retrospectiveGoalId;
        for (const ticket of currentBasis.tickets) Object.assign(ticket, { status: "planned", updatedAt: at, updatedBySeatId: selected.lead.id });
      }, `Reserve candidate ${selected.candidate.id} for next sprint ${id}`);
      await this.store.saveRuntime(nextSprintRuntimeName(closed.id), { key, goalId: id, status: "reserved" } satisfies NextSprintRecord);
      return goal;
    });
  }
}

export function createCeremonyAdapters(services: BridgeAdapterServices): CeremonyAdapters {
  const next = new NextSprint(services.store, services.chat);
  return { closedSprint: (context, key) => next.closedSprint(context, key) };
}
