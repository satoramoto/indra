import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { seatCredentialRequirement, type SeatLifecyclePorts } from "../src/autonomy-ports.js";
import { developerSeats, PlanningStore, type PlanningAssignment, type PlanningGoal } from "../src/planning.js";
import { SeatLifecycle } from "../src/seat-lifecycle.js";
import { seatStatus, type SeatRecord, type TeamRecord } from "../src/state-domain.js";
import { withFileLock } from "../src/state-commit.js";
import { turnLockFile } from "../src/tmux-host.js";
import { git, stateCheckout } from "./state-checkout.js";

const AT = "2026-01-01T00:00:00Z";
const READY = { version: 1 as const, consumers: { planning: 1 as const, developer: 1 as const, release: 1 as const, retro: 1 as const, tui: 1 as const } };
const add = { teamId: "team-001", displayName: "New Developer", username: "newdeveloper", role: "Developer" as const };
const seat = (id: string, role: SeatRecord["roles"][number]): SeatRecord => ({ id, displayName: id, roles: [role], externalIdentities: { mattermost: { username: id, userId: `user-${id}` } } });
function goal(status: PlanningAssignment["status"]): PlanningGoal {
  return {
    id: "goal-test", teamId: "team-001", seatId: "seat-001", participantSeatIds: ["seat-002"], goal: "Improve it", projectRefs: ["o/r"], stage: "approved", createdAt: AT, updatedAt: AT,
    mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Improve", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-test", createdAt: AT, summary: "Plan", outcomes: [{ id: "outcome-1", seatId: "seat-002", title: "Improve", description: "Improve it" }], risks: [], openQuestions: [] },
    assignments: [{ outcomeId: "outcome-1", seatId: "seat-002", status, updatedAt: AT }],
    integration: { branch: "sprint/goal-test", status: "collecting", baseSha: "a".repeat(40) },
    ceremony: { version: 1, stage: "implement", history: [{ stage: "planning", enteredAt: AT }, { stage: "proposal", enteredAt: AT },
      { stage: "implement", enteredAt: AT, evidence: { kind: "approval", proposalId: "proposal-test", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: AT } } }] },
  };
}
async function fixture(status?: PlanningAssignment["status"]) {
  const team: TeamRecord = { id: "team-001", slug: "yahaha", displayName: "Yahaha", project: { github: "o/r" }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "channel" } },
    seats: [seat("seat-001", "Team Lead"), seat("seat-002", "Developer"), seat("seat-003", "Developer")] };
  const dir = await stateCheckout("indra-lifecycle-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [team], sprints: [], planningGoals: status ? [goal(status)] : [] });
  await mkdir(join(dir, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(dir, "schema/v1/state.schema.json"));
  const store = new PlanningStore(dir, undefined, READY);
  const ports = {
    credentialIdentity: vi.fn<SeatLifecyclePorts["credentialIdentity"]>(async () => undefined),
    branchHasNoPr: vi.fn(async (_team: TeamRecord, _branch: string) => true),
    workSettled: vi.fn(async () => true), startSeat: vi.fn(async (_team: TeamRecord, _seat: SeatRecord) => {}), retireSeat: vi.fn(async (_team: TeamRecord, _seat: SeatRecord) => {}),
  };
  const lifecycle = new SeatLifecycle(store, ports);
  const seats = async () => ((await store.read()).teams as TeamRecord[])[0].seats;
  const getSeat = async (id = "seat-002") => (await seats()).find((item) => item.id === id)!;
  const remove = async (id = "seat-002") => lifecycle.remove({ teamId: team.id, seatId: id, expected: await getSeat(id) });
  return { dir, store, ports, lifecycle, seats, getSeat, remove };
}
const transfer = { teamId: "team-001", goalId: "goal-test", outcomeId: "outcome-1", fromSeatId: "seat-002", toSeatId: "seat-003", updatedAt: AT, reason: "Move remaining work to a serving Developer." };

describe("seat onboarding", () => {
  it("commits one pending identity for duplicate concurrent adds and names its exact credential", async () => {
    const { store, dir, lifecycle, seats, ports } = await fixture();
    const before = Number(git(dir, "rev-list", "--count", "HEAD"));
    await Promise.all([lifecycle.add(add), new SeatLifecycle(store, ports).add(add)]);
    const pending = (await seats()).find((item) => item.externalIdentities.mattermost.username === add.username)!;
    expect(pending).toMatchObject({ status: "pending", roles: ["Developer"], externalIdentities: { mattermost: { username: "newdeveloper" } } });
    expect(pending.externalIdentities.mattermost.userId).toBeUndefined();
    expect(seatCredentialRequirement(pending)).toEqual({ username: "newdeveloper", item: "Mattermost bot - newdeveloper", field: "token" });
    expect(developerSeats(await store.read(), "team-001").map((item) => item.id)).not.toContain(pending.id);
    expect(Number(git(dir, "rev-list", "--count", "HEAD")) - before).toBe(1);
    expect(git(dir, "show", "--format=", "--name-only", "HEAD").trim()).toBe("state.json");
    expect(ports.credentialIdentity).not.toHaveBeenCalled();
    await expect(lifecycle.add({ ...add, role: "Product" })).rejects.toThrow("reserved");
  });

  it.each([undefined, { userId: "wrong", username: "anotherbot", isBot: true }, { userId: "", username: add.username, isBot: true }, { userId: "person", username: add.username, isBot: false }])("keeps a missing or mismatched credential pending: %j", async (identity) => {
    const { lifecycle, ports, seats } = await fixture();
    await lifecycle.add(add);
    ports.credentialIdentity.mockResolvedValue(identity as Awaited<ReturnType<SeatLifecyclePorts["credentialIdentity"]>>);
    await lifecycle.reconcile();
    expect((await seats()).at(-1)?.status).toBe("pending");
    expect(ports.startSeat).not.toHaveBeenCalled();
  });

  it("retries credential readiness and recovers activation committed before a failed start after restart", async () => {
    const { lifecycle, store, ports, seats } = await fixture();
    await lifecycle.add(add);
    await lifecycle.reconcile();
    ports.credentialIdentity.mockResolvedValue({ userId: "verified-bot", username: add.username, isBot: true });
    ports.startSeat.mockRejectedValueOnce(new Error("start interrupted"));
    await expect(lifecycle.reconcile()).rejects.toThrow("will retry");
    expect((await seats()).at(-1)).toMatchObject({ status: "active", externalIdentities: { mattermost: { userId: "verified-bot" } } });
    await new SeatLifecycle(store, ports).reconcile();
    expect(ports.startSeat).toHaveBeenCalledTimes(2);
    expect(ports.credentialIdentity).toHaveBeenCalledTimes(2);
    expect(ports.startSeat.mock.calls[1][1]).toMatchObject({ status: "active" });
    await new SeatLifecycle(store, ports).reconcile();
    expect(ports.startSeat).toHaveBeenCalledTimes(2);
    const active = (await seats()).at(-1)!;
    expect(await store.readRuntimeFile(`seat-activation-${active.id}`)).toEqual({ startedAt: expect.any(String) });
    expect(git(store.checkout, "ls-files")).toBe("state.json\n");
  });

  it("rechecks a pending cancellation while its credential is being verified", async () => {
    const { lifecycle, ports, seats, remove } = await fixture();
    await lifecycle.add(add);
    const pending = (await seats()).at(-1)!;
    ports.credentialIdentity.mockImplementationOnce(async () => {
      await remove(pending.id);
      return { userId: "verified-bot", username: add.username, isBot: true };
    });
    await lifecycle.reconcile();
    expect((await seats()).at(-1)?.status).toBe("retired");
    expect(ports.startSeat).not.toHaveBeenCalled();
    await expect(lifecycle.add(add)).rejects.toThrow("historical");
  });

  it("does not replace a known ID or claim a bot ID already belonging to another seat", async () => {
    const { lifecycle, ports, store, seats } = await fixture();
    await lifecycle.add(add);
    ports.credentialIdentity.mockResolvedValue({ userId: "user-seat-002", username: add.username, isBot: true });
    await lifecycle.reconcile();
    expect((await seats()).at(-1)?.status).toBe("pending");
    await store.update((state) => { (state.teams as TeamRecord[])[0].seats.at(-1)!.externalIdentities.mattermost.userId = "expected-bot"; }, "Record known bot");
    ports.credentialIdentity.mockResolvedValue({ userId: "other-bot", username: add.username, isBot: true });
    await lifecycle.reconcile();
    expect((await seats()).at(-1)?.status).toBe("pending");
    expect(ports.startSeat).not.toHaveBeenCalled();
  });

  it("provisions Product through the same path once, including concurrent restarts and later cancellation", async () => {
    const { lifecycle, ports, store, seats, remove } = await fixture();
    await Promise.all([lifecycle.provisionProductSeats(), new SeatLifecycle(store, ports).provisionProductSeats()]);
    const product = (await seats()).filter((item) => item.roles[0] === "Product");
    expect(product).toHaveLength(1);
    expect(product[0].status).toBe("pending");
    expect(seatCredentialRequirement(product[0])).toEqual({ username: "yahaha-product", item: "Mattermost bot - yahaha-product", field: "token" });
    await remove(product[0].id);
    await new SeatLifecycle(store, ports).provisionProductSeats();
    expect((await seats()).filter((item) => item.roles[0] === "Product")).toEqual([{ ...product[0], status: "retired" }]);
  });

  it("keeps an existing owner-chosen Product identity", async () => {
    const { lifecycle, seats } = await fixture();
    await lifecycle.add({ ...add, role: "Product" });
    await lifecycle.provisionProductSeats();
    expect((await seats()).filter((item) => item.roles[0] === "Product").map((item) => item.externalIdentities.mattermost.username)).toEqual([add.username]);
  });
});

describe("safe retirement", () => {
  it.each(["queued", "running", "in-review", "failed"] as const)("excludes a retiring seat from new allocations while preserving its %s work", async (status) => {
    const { lifecycle, store, ports, getSeat, remove } = await fixture(status);
    const before = (await store.read()).planningGoals;
    await remove();
    await lifecycle.reconcile();
    expect((await getSeat()).status).toBe("retiring");
    expect((await store.read()).planningGoals).toEqual(before);
    expect(developerSeats(await store.read(), "team-001").map((item) => item.id)).toEqual(["seat-003"]);
    expect(ports.retireSeat).not.toHaveBeenCalled();
  });

  it("preserves the required Team Lead and refuses stale removal confirmation", async () => {
    const { lifecycle, store, getSeat, remove } = await fixture();
    await expect(remove("seat-001")).rejects.toThrow("required Team Lead");
    const expected = await getSeat();
    await store.update((state) => { (state.teams as TeamRecord[])[0].seats[1].displayName = "Renamed"; }, "Rename seat");
    await expect(lifecycle.remove({ teamId: "team-001", seatId: expected.id, expected })).rejects.toThrow("changed since confirmation");
    expect(seatStatus(await getSeat())).toBe("active");
  });

  it("waits for an actual running turn even after its durable assignment has merged, and retains history", async () => {
    const { lifecycle, store, ports, getSeat, remove } = await fixture("running");
    await remove();
    await withFileLock(turnLockFile(store.checkout, { kind: "seat", seatId: "seat-002" }), async () => {
      await store.update((state) => { state.planningGoals![0].assignments![0].status = "merged"; }, "Finish assignment");
      await lifecycle.reconcile();
      expect((await getSeat()).status).toBe("retiring");
      expect(ports.retireSeat).not.toHaveBeenCalled();
    });
    await lifecycle.reconcile();
    expect((await getSeat()).status).toBe("retired");
    expect(ports.retireSeat).toHaveBeenCalledTimes(1);
    const history = (await store.read()).planningGoals![0];
    expect(history.participantSeatIds).toContain("seat-002");
    expect(history.proposal!.outcomes[0].seatId).toBe("seat-002");
    expect(history.assignments![0].seatId).toBe("seat-002");
  });

  it("retries a failed process stop after restart without deleting the retired identity", async () => {
    const { lifecycle, store, ports, getSeat, remove } = await fixture();
    await remove();
    ports.retireSeat.mockRejectedValueOnce(new Error("unavailable"));
    await expect(lifecycle.reconcile()).rejects.toThrow("will retry");
    expect((await getSeat()).status).toBe("retired");
    await new SeatLifecycle(store, ports).reconcile();
    expect(ports.retireSeat).toHaveBeenCalledTimes(2);
  });

  it("requires local work to be settled and rechecks durable work inside the retirement transaction", async () => {
    const { lifecycle, store, ports, getSeat, remove } = await fixture("queued");
    await remove();
    await store.update((state) => { state.planningGoals![0].assignments![0].status = "merged"; }, "Finish");
    ports.workSettled.mockResolvedValueOnce(false);
    await lifecycle.reconcile();
    expect((await getSeat()).status).toBe("retiring");
    ports.workSettled.mockImplementationOnce(async () => {
      await store.update((state) => { state.planningGoals![0].assignments![0].status = "failed"; }, "Recover unfinished work");
      return true;
    });
    await lifecycle.reconcile();
    expect((await getSeat()).status).toBe("retiring");
    expect(ports.retireSeat).not.toHaveBeenCalled();
  });

  it.each(["queued", "failed"] as const)("records a safe %s reassignment while preserving proposal and runtime evidence", async (status) => {
    const { lifecycle, store, ports, getSeat, remove } = await fixture(status);
    await store.saveRuntime("seat-seat-002-goal-test-outcome-1", { goalId: "goal-test", outcomeId: "outcome-1", branch: "seat-002/goal-test-outcome-1", worktree: join(store.runtimeDir, "worktrees/goal-test-outcome-1"), step: "build", sessions: [] });
    const runtime = await readFile(join(store.runtimeDir, "seat-seat-002-goal-test-outcome-1.json"), "utf8");
    await remove();
    await lifecycle.reassign(transfer);
    expect(ports.branchHasNoPr).toHaveBeenCalledWith(expect.objectContaining({ id: "team-001", project: { github: "o/r" } }), "seat-002/goal-test-outcome-1");
    await lifecycle.reconcile();
    const state = await store.read();
    expect(state.planningGoals![0].assignments![0]).toMatchObject({ status: "queued", seatId: "seat-003", reassignments: [{ fromSeatId: "seat-002", toSeatId: "seat-003", at: expect.any(String), reason: transfer.reason }] });
    expect(state.planningGoals![0].proposal!.outcomes[0].seatId).toBe("seat-002");
    expect((await getSeat()).status).toBe("retired");
    expect(await readFile(join(store.runtimeDir, "seat-seat-002-goal-test-outcome-1.json"), "utf8")).toBe(runtime);
  });

  it.each(["missing", "initial", "retry"])("blocks an unrecorded PR with a %s runtime record, including after restart", async (record) => {
    const { lifecycle, store, ports, getSeat, remove } = await fixture("failed");
    const suffix = record === "retry" ? "-attempt-00000000-0000-4000-8000-000000000001" : "";
    const branch = `seat-002/goal-test-outcome-1${suffix}`;
    const name = "seat-seat-002-goal-test-outcome-1";
    if (record !== "missing") await store.saveRuntime(name, { goalId: "goal-test", outcomeId: "outcome-1", branch,
      worktree: join(store.runtimeDir, `worktrees/goal-test-outcome-1${suffix}`), step: "build", sessions: [] });
    await remove();
    const before = await store.read();
    const runtime = await store.readRuntimeFile(name);
    ports.branchHasNoPr.mockResolvedValue(false);
    await expect(lifecycle.reassign(transfer)).rejects.toThrow("source branch");
    const restarted = new SeatLifecycle(store, ports);
    await expect(restarted.reassign(transfer)).rejects.toThrow("source branch");
    await restarted.reconcile();
    expect(ports.branchHasNoPr).toHaveBeenCalledTimes(2);
    expect(ports.branchHasNoPr).toHaveBeenCalledWith(expect.objectContaining({ project: { github: "o/r" } }), branch);
    expect(await store.read()).toEqual(before);
    expect(await store.readRuntimeFile(name)).toEqual(runtime);
    expect((await getSeat()).status).toBe("retiring");
    expect(ports.retireSeat).not.toHaveBeenCalled();
  });

  it("keeps work when the PR check throws and permits retry only after confirming no PR exists", async () => {
    const { lifecycle, store, ports, remove } = await fixture("queued");
    await remove();
    const before = await store.read();
    ports.branchHasNoPr.mockRejectedValueOnce(new Error("private transport diagnostics"));
    await expect(lifecycle.reassign(transfer)).rejects.toThrow("Cannot verify the source branch has no PR");
    expect(await store.read()).toEqual(before);
    await lifecycle.reassign(transfer);
    expect((await store.read()).planningGoals![0].assignments![0].seatId).toBe("seat-003");
    expect(ports.branchHasNoPr).toHaveBeenCalledTimes(2);
  });

  it.each(["project", "assignment"])("holds the runner locks during the PR check and refuses a changed %s at commit", async (changed) => {
    const { lifecycle, store, ports, remove } = await fixture("failed");
    await remove();
    ports.branchHasNoPr.mockImplementationOnce(async () => {
      for (const lock of [turnLockFile(store.checkout, { kind: "seat", seatId: "seat-002" }), join(store.runtimeDir, "goal-test.lock")]) {
        expect(await readFile(lock, "utf8")).toMatch(new RegExp(`^${process.pid} `));
      }
      await store.update((state) => {
        if (changed === "project") {
          (state.teams as TeamRecord[])[0].project = { github: "o/changed" };
          state.planningGoals![0].projectRefs.push("o/changed");
        } else state.planningGoals![0].assignments![0].status = "running";
      }, "Update while checking PR state");
      return true;
    });
    await expect(lifecycle.reassign(transfer)).rejects.toThrow(changed === "project" ? "Team project changed" : "unchanged queued or failed work");
    const assignment = (await store.read()).planningGoals![0].assignments![0];
    expect(assignment.seatId).toBe("seat-002");
    expect(assignment.reassignments).toBeUndefined();
  });

  it.each(["running", "in-review", "merged"] as const)("refuses to transfer %s work", async (status) => {
    const { lifecycle, store, remove } = await fixture(status);
    await remove();
    await expect(lifecycle.reassign(transfer)).rejects.toThrow("unchanged queued or failed work");
    expect((await store.read()).planningGoals![0].assignments![0].seatId).toBe("seat-002");
  });

  it("refuses transfer during a turn, for stale confirmations, to non-developers, and with PR or uncertain runtime evidence", async () => {
    const { lifecycle, store, remove } = await fixture("failed");
    await remove();
    await withFileLock(turnLockFile(store.checkout, { kind: "seat", seatId: "seat-002" }), async () => {
      await expect(lifecycle.reassign(transfer)).rejects.toThrow("running turn");
    });
    await expect(lifecycle.reassign({ ...transfer, updatedAt: "2026-02-01T00:00:00Z" })).rejects.toThrow("unchanged");
    await expect(lifecycle.reassign({ ...transfer, toSeatId: "seat-001" })).rejects.toThrow("active Developer");
    await store.update((state) => { state.planningGoals![0].assignments![0].prUrl = "https://github.com/o/r/pull/1"; }, "Retain PR");
    await expect(lifecycle.reassign(transfer)).rejects.toThrow("without a PR");
    await store.saveRuntime("seat-seat-002-goal-test-outcome-1", { unexpected: true });
    await expect(lifecycle.reassign(transfer)).rejects.toThrow("uncertain runtime record");
  });
});
