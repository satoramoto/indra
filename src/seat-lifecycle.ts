import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SeatLifecyclePorts } from "./autonomy-ports.js";
import type { AddSeatRequest, RemoveSeatRequest, SeatLifecycleControls } from "./control-adapters.js";
import { ownsSeatRecord, seatRecordName } from "./developer-maintenance.js";
import { hasUnfinishedSeatWork, PlanningStore, type PlanningDocument } from "./planning.js";
import { implementationEligible } from "./implementation-facts.js";
import { isActiveSeat, seatStatus, type SeatRecord, type TeamRecord } from "./state-domain.js";
import { withFileLock } from "./state-commit.js";
import { hostedProcessFor, turnLockFile } from "./tmux-host.js";

const teamsOf = (state: PlanningDocument) => state.teams as TeamRecord[];
const unfinished = (state: PlanningDocument, seatId: string) => (state.planningGoals ?? []).some((goal) => hasUnfinishedSeatWork(goal, seatId));
function teamOf(state: PlanningDocument, teamId: string): TeamRecord {
  const team = teamsOf(state).find((item) => item.id === teamId);
  if (!team) throw new Error("Seat team is no longer available.");
  return team;
}
function seatOf(state: PlanningDocument, teamId: string, seatId: string): SeatRecord {
  const seat = teamOf(state, teamId).seats.find((item) => item.id === seatId);
  if (!seat) throw new Error("Seat is no longer available.");
  return seat;
}
const sameSeat = (a: SeatRecord, b: SeatRecord) => isDeepStrictEqual({ ...a, status: seatStatus(a) }, { ...b, status: seatStatus(b) });

/** All durable changes use the state transaction; credentials and process observations never enter Git. */
export class SeatLifecycle implements SeatLifecycleControls {
  constructor(private readonly store: PlanningStore, private readonly ports: SeatLifecyclePorts) {}

  async add(request: AddSeatRequest): Promise<void> { await this.addPending(request); }

  private async addPending(request: AddSeatRequest, firstProduct = false): Promise<void> {
    if (!["Developer", "Product"].includes(request.role) || !request.displayName.trim() || request.displayName.length > 160
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.username)) throw new Error("A seat needs a display name, a bot username and the Developer or Product role.");
    await this.store.update((state) => {
      const team = teamOf(state, request.teamId);
      // A historical Product seat records that provisioning already happened, including an owner's cancellation.
      if (firstProduct && team.seats.some((seat) => seat.roles.includes("Product"))) return;
      const existing = teamsOf(state).flatMap((item) => item.seats).find((seat) => seat.externalIdentities.mattermost.username === request.username);
      if (existing) {
        if (team.seats.includes(existing) && existing.displayName === request.displayName.trim() && existing.roles[0] === request.role
          && ["pending", "active"].includes(seatStatus(existing))) return;
        throw new Error("That bot username is already reserved by a current or historical seat.");
      }
      team.seats.push({ id: `seat-${randomUUID()}`, displayName: request.displayName.trim(), roles: [request.role], status: "pending",
        externalIdentities: { mattermost: { username: request.username } } });
    }, `Add pending ${request.role} seat to ${request.teamId}`);
  }

  /** Explicit rollout provisioning, through the same pending/credential path as the owner's Add action. */
  async provisionProductSeats(): Promise<void> {
    for (const team of teamsOf(await this.store.read())) {
      if (team.seats.some((seat) => seat.roles.includes("Product"))) continue;
      await this.addPending({ teamId: team.id, displayName: "Product", username: `${team.slug.slice(0, 48)}-product`, role: "Product" }, true);
    }
  }

  async remove(request: RemoveSeatRequest): Promise<void> {
    await this.store.update((state) => {
      const seat = seatOf(state, request.teamId, request.seatId);
      if (!sameSeat(seat, request.expected)) throw new Error("Seat changed since confirmation; review its removal again.");
      if (seat.roles.includes("Team Lead")) throw new Error("The team's required Team Lead cannot be removed.");
      if (seatStatus(seat) === "pending") seat.status = "retired";
      else if (isActiveSeat(seat)) seat.status = "retiring";
    }, `Request retirement of ${request.seatId}`);
  }

  async reconcile(): Promise<void> {
    const problems: string[] = [];
    for (const team of teamsOf(await this.store.read())) for (const seat of team.seats) {
      try {
        if (seatStatus(seat) === "pending") await this.activate(team, seat);
        else if (seat.status === "active") await this.startActivated(team, seat);
        else if (["retiring", "retired"].includes(seatStatus(seat))) await this.retire(team, seat);
      } catch {
        // Credential/transport/process errors can include arbitrary output; report only the durable seat identity.
        problems.push(seat.id);
      }
    }
    if (problems.length) throw new Error(`Seat lifecycle will retry: ${problems.join(", ")}.`);
  }

  private async activate(team: TeamRecord, pending: SeatRecord): Promise<void> {
    const identity = await this.ports.credentialIdentity(team, pending);
    const expected = pending.externalIdentities.mattermost;
    if (!identity || identity.isBot !== true || !identity.userId?.trim() || identity.username !== expected.username
      || (expected.userId !== undefined && identity.userId !== expected.userId)) return;
    let activated: SeatRecord | undefined;
    await this.store.update((state) => {
      const seat = seatOf(state, team.id, pending.id);
      if (!sameSeat(seat, pending) || seatStatus(seat) !== "pending") return;
      if (teamsOf(state).flatMap((item) => item.seats).some((item) => item.id !== seat.id && item.externalIdentities.mattermost.userId === identity.userId)) return;
      seat.externalIdentities.mattermost.userId = identity.userId;
      seat.status = "active";
      activated = structuredClone(seat);
    }, `Activate verified seat ${pending.id}`);
    // A crash here is recovered by the explicit active record on the next pass, including after UI restart.
    if (activated) await this.startActivated(team, activated);
  }

  private async startActivated(team: TeamRecord, seat: SeatRecord): Promise<void> {
    const name = `seat-activation-${seat.id}`;
    if (await this.store.readRuntimeFile(name)) return;
    await this.ports.startSeat(team, seat);
    // Retry interrupted starts, but respect the owner's Stop control once activation has successfully hosted the seat.
    await this.store.saveRuntime(name, { startedAt: new Date().toISOString() });
  }

  private async retire(team: TeamRecord, retiring: SeatRecord): Promise<void> {
    if (retiring.roles.includes("Team Lead")) return;
    await this.betweenTurns(retiring, async () => {
      const state = await this.store.read();
      const seat = seatOf(state, team.id, retiring.id);
      if (!["retiring", "retired"].includes(seatStatus(seat)) || unfinished(state, seat.id)
        || !await this.ports.workSettled(team.id, seat.id)) return;
      await this.store.update((current) => {
        const target = seatOf(current, team.id, seat.id);
        if (seatStatus(target) === "retiring" && !unfinished(current, seat.id)) target.status = "retired";
      }, `Retire settled seat ${seat.id}`);
      const current = seatOf(await this.store.read(), team.id, seat.id);
      if (seatStatus(current) === "retired") await this.ports.retireSeat(team, current);
    });
  }

  /** Safe transfer preserves the approved proposal and all old runtime/worktree evidence. Live or PR work must finish first. */
  async reassign(request: { teamId: string; goalId: string; outcomeId: string; fromSeatId: string; toSeatId: string; updatedAt: string; reason: string }): Promise<void> {
    if (!request.reason.trim()) throw new Error("Reassignment needs a recorded reason.");
    const from = seatOf(await this.store.read(), request.teamId, request.fromSeatId);
    const done = await this.betweenTurns(from, async () => this.store.withGoalLock(request.goalId, async () => {
      const saved = await this.store.readRuntimeFile(seatRecordName(from.id, request.goalId, request.outcomeId));
      if (saved && (!ownsSeatRecord(this.store.runtimeDir, from.id, request.goalId, request.outcomeId, saved) || saved.prUrl || saved.retainedPrUrl)) {
        throw new Error("Resolve the seat's retained PR or uncertain runtime record before reassigning its work.");
      }
      await this.store.update((state) => {
        const source = seatOf(state, request.teamId, from.id);
        const target = seatOf(state, request.teamId, request.toSeatId);
        const goal = state.planningGoals?.find((item) => item.id === request.goalId && item.teamId === request.teamId);
        const assignment = goal?.assignments?.find((item) => item.outcomeId === request.outcomeId);
        if (seatStatus(source) !== "retiring" || !isActiveSeat(target) || !target.roles.includes("Developer") || source.id === target.id
          || !goal || !implementationEligible(goal) || !assignment || assignment.seatId !== source.id || assignment.updatedAt !== request.updatedAt
          || !["queued", "failed"].includes(assignment.status) || assignment.prUrl) throw new Error("Reassignment needs unchanged queued or failed work without a PR, from a retiring seat to an active Developer.");
        const at = new Date().toISOString();
        assignment.reassignments = [...(assignment.reassignments ?? []), { fromSeatId: source.id, toSeatId: target.id, at, reason: request.reason.trim() }];
        assignment.seatId = target.id;
        assignment.status = "queued";
        assignment.updatedAt = goal.updatedAt = at;
        delete assignment.note;
      }, `Reassign ${request.goalId}/${request.outcomeId} from ${from.id} to ${request.toSeatId}`);
    }));
    if (!done) throw new Error("Seat has a running turn; retry reassignment when it is idle.");
  }

  /** Matches the runner's lock order: turn, goal (when transferring), then state. A busy turn simply waits for another poll. */
  private async betweenTurns(seat: SeatRecord, work: () => Promise<void>): Promise<boolean> {
    let acquired = false;
    try {
      await withFileLock(turnLockFile(this.store.checkout, hostedProcessFor(seat)), async () => { acquired = true; await work(); }, 100);
    } catch (error) { if (acquired) throw error; }
    return acquired;
  }
}
