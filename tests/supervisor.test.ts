import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import { signalReady, TmuxHost, turnLockFile, type TmuxRunner } from "../src/tmux-host.js";
import { withFileLock } from "../src/state-commit.js";
import { activityRecordName, CliGoalStarter, Supervisor } from "../src/supervisor.js";
import { git, stateCheckout } from "./state-checkout.js";

/** A tmux server with several sessions. `onStart` decides how a new hosted process behaves. */
class FakeTmux implements TmuxRunner {
  calls: string[][] = [];
  sessions = new Map<string, { pane: string; identity: string }>();
  private next = 1;
  onStart: (session: string, nonce: string) => Promise<void> = async () => {};
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    const target = args.includes("-t") ? args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "") : "";
    const live = this.sessions.get(target);
    if (args.includes("display-message")) return "100";
    if (args.includes("list-panes")) { if (!live) throw new Error("gone"); return `${live.pane}:0`; }
    if (args.includes("list-sessions")) return [...this.sessions].map(([name, { identity }]) => args.at(-1)!.includes("session_created") ? `${name} ${identity.split(":")[1]}` : name).join("\n");
    if (args.includes("kill-session")) { if (!live) throw new Error("gone"); this.sessions.delete(target); return ""; }
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      if (this.sessions.has(name)) throw new Error("duplicate session");
      const pane = `%${this.next++}`;
      this.sessions.set(name, { pane, identity: `100:${this.next}` });
      await this.onStart(name, args[args.indexOf("--ready-nonce") + 1]);
      return `${name}:${pane}`;
    }
    throw new Error("unexpected tmux call");
  }
  launches(): string[][] { return this.calls.filter((args) => args.includes("new-session")); }
  kills(): string[][] { return this.calls.filter((args) => args.includes("kill-session")); }
}

const seat = (id: string, name: string, roles: string[]) => ({ id, displayName: name, roles, externalIdentities: { mattermost: { userId: id, username: name.toLowerCase() } } });

async function fixture() {
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [seat("seat-001", "Chick", ["Team Lead"]), seat("seat-002", "George", ["Developer"]), seat("seat-003", "Herbie", ["Developer"])] }] };
  const dir = await stateCheckout("indra-supervisor-", state);
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "cli.js"), "");
  const tmux = new FakeTmux();
  tmux.onStart = async (_session, nonce) => { await signalReady(dir, nonce); };
  return { dir, tmux, supervisor: new Supervisor(dir, tmux, dir, 1000) };
}

describe("seat process supervisor", () => {
  it("hosts the bridge and one runner per Developer seat, then reuses them instead of duplicating", async () => {
    const { dir, tmux, supervisor } = await fixture();
    expect(await supervisor.ensureAll()).toEqual([]);
    const launches = tmux.launches();
    expect(launches).toHaveLength(3);
    expect(launches[0]).toEqual(expect.arrayContaining(["planning", "serve"]));
    expect(launches[1]).toEqual(expect.arrayContaining(["seat", "run", "--seat", "seat-002", "--state", dir]));
    expect(launches[2]).toEqual(expect.arrayContaining(["seat", "run", "--seat", "seat-003"]));
    expect(new Set(launches.map((args) => args[args.indexOf("-s") + 1])).size).toBe(3);

    expect(await supervisor.ensureAll()).toEqual([]);
    expect(await new Supervisor(dir, tmux, dir, 1000).ensureAll()).toEqual([]);
    expect(tmux.launches()).toHaveLength(3);
    const live = await supervisor.read();
    expect(Object.values(live).map((item) => item.process)).toEqual(["running", "running", "running"]);
    expect(live["seat-002"].attach?.target).toMatch(/^indra-[a-f0-9]{12}:dev-seat-002-[a-f0-9]{12}$/);
  });

  it("never touches a session it does not own", async () => {
    const { tmux, supervisor } = await fixture();
    await supervisor.ensureAll();
    const george = [...tmux.sessions.keys()].find((name) => name.startsWith("dev-seat-002"))!;
    // Another process replaced George's session under the same name: the identity no longer matches the record.
    tmux.sessions.set(george, { pane: "%99", identity: "999:999" });
    expect((await supervisor.read())["seat-002"].process).toBe("stopped");
    await supervisor.stop("seat-002");
    expect(tmux.kills()).toEqual([]);
    expect(await supervisor.ensureAll()).toEqual([expect.stringContaining("seat-002")]);
    expect(tmux.sessions.get(george)).toEqual({ pane: "%99", identity: "999:999" });
    expect(tmux.launches()).toHaveLength(4);
  });

  it("refuses a same-named session with no ownership record", async () => {
    const { dir, tmux, supervisor } = await fixture();
    const foreign = new TmuxHost(dir, tmux, dir, 1000, { kind: "seat", seatId: "seat-002" }).session;
    tmux.sessions.set(foreign, { pane: "%70", identity: "7:7" });
    expect(await supervisor.ensureAll()).toEqual([expect.stringMatching(/^seat-002: .*without an ownership record/)]);
    expect(tmux.kills()).toEqual([]);
    expect(tmux.sessions.get(foreign)).toEqual({ pane: "%70", identity: "7:7" });
    expect(tmux.launches()).toHaveLength(2);
  });

  it("stops and restarts only its own verified session", async () => {
    const { tmux, supervisor } = await fixture();
    await supervisor.ensureAll();
    await supervisor.stop("seat-003");
    expect(tmux.kills()).toHaveLength(1);
    expect(tmux.kills()[0][tmux.kills()[0].indexOf("-t") + 1]).toMatch(/^=dev-seat-003-/);
    expect((await supervisor.read())["seat-003"].process).toBe("stopped");
    await supervisor.restart("seat-003");
    expect((await supervisor.read())["seat-003"].process).toBe("running");
    expect(tmux.launches()).toHaveLength(4);
  });

  it("stages the service account credential once before hosting, and retries it on restart after a failure", async () => {
    const { dir, tmux } = await fixture();
    const order: string[] = [];
    tmux.onStart = async (session, nonce) => { order.push(session.split("-")[0]); await signalReady(dir, nonce); };
    let staged = 0;
    const ok = new Supervisor(dir, tmux, dir, 1000, undefined, async () => { staged++; order.push("stage"); });
    expect(await ok.ensureAll()).toEqual([]);
    await ok.ensureAll();
    await ok.restart("seat-002");
    expect(staged).toBe(1);
    expect(order[0]).toBe("stage");

    const fresh = await fixture();
    let attempts = 0;
    const failing = new Supervisor(fresh.dir, fresh.tmux, fresh.dir, 1000, undefined, async () => { if (++attempts === 1) throw new Error("1Password could not supply the service account token"); });
    expect(await failing.ensureAll()).toEqual(["1Password could not supply the service account token"]);
    expect(fresh.tmux.launches()).toHaveLength(3);
    await failing.restart("seat-002");
    expect(attempts).toBe(2);
    await failing.restart("seat-002");
    expect(attempts).toBe(2);
  });

  it("shows a seat without a bot credential as no credential and keeps the others running", async () => {
    const { dir, tmux, supervisor } = await fixture();
    tmux.onStart = async (session, nonce) => { await signalReady(dir, nonce, session.startsWith("dev-seat-003") ? "no-credential" : undefined); };
    expect(await supervisor.ensureAll()).toEqual([]);
    // The runner exits after signalling.
    tmux.sessions.delete([...tmux.sessions.keys()].find((name) => name.startsWith("dev-seat-003"))!);
    const live = await supervisor.read();
    expect(live["seat-003"].process).toBe("no credential");
    expect(live["seat-002"].process).toBe("running");
    expect(live["seat-001"].process).toBe("running");
  });

  it("shows a seat whose bot cannot join its home channel as no channel, naming the bot and channel", async () => {
    const { dir, tmux, supervisor } = await fixture();
    const message = "@george can't join the home channel home (HTTP 403): add it or make the channel public.";
    tmux.onStart = async (session, nonce) => { await (session.startsWith("dev-seat-002") ? signalReady(dir, nonce, "no-channel", message) : signalReady(dir, nonce)); };
    // Shown on the seat rather than as a start-up notice, like a missing credential.
    expect(await supervisor.ensureAll()).toEqual([]);
    tmux.sessions.delete([...tmux.sessions.keys()].find((name) => name.startsWith("dev-seat-002"))!);
    const live = await supervisor.read();
    expect(live["seat-002"]).toMatchObject({ process: "no channel", problem: message });
    expect(live["seat-003"].process).toBe("running");
    expect(tmux.launches()).toHaveLength(3);
  });

  it("restarts processes on an older build only at a safe point: a busy seat and a bridge mid-poll wait", async () => {
    const { dir, tmux, supervisor } = await fixture();
    const stamp = (id: string) => writeFile(join(dir, "dist", "build-stamp.json"), JSON.stringify({ id, sha: "abc1234", builtAt: "now" }));
    await stamp("build-1");
    await supervisor.ensureAll();
    expect(Object.values(await supervisor.read()).some((item) => item.updatePending)).toBe(false);
    expect(await supervisor.upgrade()).toEqual({ pending: [], problems: [] });
    expect(tmux.kills()).toHaveLength(0);

    const store = new PlanningStore(dir);
    const setStatus = (status: "in-review" | "merged") => store.update((state) => {
      state.planningGoals = [{
        id: "goal-abc", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Build it", projectRefs: [], stage: "approved",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mattermost: { channelId: "channel", rootPostId: "root" },
        brief: { summary: "Build it", decisions: [], openQuestions: [] },
        proposal: { id: "proposal-1", createdAt: "2026-01-01T00:00:00Z", summary: "Plan", risks: [], openQuestions: [], outcomes: [{ id: "outcome-1", title: "First", description: "Do it", seatId: "seat-002" }] },
        assignments: [{ outcomeId: "outcome-1", seatId: "seat-002", status, updatedAt: "2026-01-01T00:00:00Z" }],
      }];
    }, `Assignment ${status}`);
    await setStatus("in-review");
    await stamp("build-2");
    // The bridge is mid-poll: it holds its turn lock until released.
    let release = () => {};
    const polling = withFileLock(turnLockFile(dir, { kind: "bridge" }), () => new Promise<void>((done) => { release = done; }));
    await new Promise((done) => setTimeout(done, 50));

    expect(await supervisor.upgrade()).toEqual({ pending: ["bridge", "seat-002"], problems: [] });
    const herbie = tmux.kills().map((args) => args[args.indexOf("-t") + 1]);
    expect(herbie).toHaveLength(1);
    expect(herbie[0]).toMatch(/^=dev-seat-003-/);
    const live = await supervisor.read();
    expect([live["seat-001"].updatePending, live["seat-002"].updatePending, live["seat-003"].updatePending]).toEqual([true, true, undefined]);
    expect(live["seat-003"].process).toBe("running");

    release();
    await polling;
    await setStatus("merged");
    expect(await supervisor.upgrade()).toEqual({ pending: [], problems: [] });
    expect(tmux.kills()).toHaveLength(3);
    expect(tmux.launches()).toHaveLength(6);
    expect(Object.values(await supervisor.read()).map((item) => [item.process, item.updatePending])).toEqual([["running", undefined], ["running", undefined], ["running", undefined]]);
  });

  it("reads the held assignment and newest thread activity", async () => {
    const { dir, supervisor } = await fixture();
    const store = new PlanningStore(dir);
    await store.update((state) => {
      state.planningGoals = [{
        id: "goal-abc", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Build it", projectRefs: ["/proj"], stage: "approved",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mattermost: { channelId: "channel", rootPostId: "root" },
        brief: { summary: "Build it", decisions: [], openQuestions: [] },
        proposal: { id: "proposal-1", createdAt: "2026-01-01T00:00:00Z", summary: "Plan", risks: [], openQuestions: [], outcomes: [
          { id: "outcome-1", title: "First", description: "Do it", seatId: "seat-002" },
          { id: "outcome-2", title: "Second", description: "Do it", seatId: "seat-002" },
          { id: "outcome-3", title: "Third", description: "Do it", seatId: "seat-003" },
        ] },
        assignments: [
          { outcomeId: "outcome-1", seatId: "seat-002", status: "merged", updatedAt: "2026-01-01T00:00:00Z", prUrl: "https://github.com/o/r/pull/1" },
          { outcomeId: "outcome-2", seatId: "seat-002", status: "in-review", updatedAt: "2026-01-02T00:00:00Z", prUrl: "https://github.com/o/r/pull/2" },
          { outcomeId: "outcome-3", seatId: "seat-003", status: "merged", updatedAt: "2026-01-02T00:00:00Z" },
        ],
      }];
    }, "Add a planning goal");
    await store.saveRuntime(activityRecordName("seat-002"), { message: "Opened PR 2", at: "2026-01-02T00:00:00Z" });
    const live = await supervisor.read();
    expect(live["seat-002"]).toMatchObject({ process: "stopped", assignment: { title: "Second", status: "in-review", prUrl: "https://github.com/o/r/pull/2" }, activity: { message: "Opened PR 2" } });
    expect(live["seat-003"].assignment).toBeUndefined();
  });
});

function failedGoal(id = "goal-retry", updatedAt = "2026-01-02T00:00:00Z"): PlanningGoal {
  return {
    id, teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Fix the terminal", projectRefs: [], stage: "approved",
    createdAt: "2026-01-01T00:00:00Z", updatedAt, mattermost: { channelId: "channel", rootPostId: "root" },
    brief: { summary: "Fix it", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-1", createdAt: updatedAt, summary: "Plan", risks: [], openQuestions: [], outcomes: [{ id: "outcome-1", title: "Retry failed work", description: "Add T", seatId: "seat-002" }] },
    assignments: [{ outcomeId: "outcome-1", seatId: "seat-002", status: "failed", updatedAt, note: "Interrupted", prUrl: "https://github.com/o/r/pull/1" }],
    integration: { branch: `sprint/${id}`, baseSha: "a".repeat(40), status: "collecting" },
  };
}

async function retryFixture(goals = [failedGoal()]) {
  const fixtureValue = await fixture();
  const store = new PlanningStore(fixtureValue.dir);
  await store.update((state) => { state.planningGoals = goals; }, "Add failed assignments");
  const target = (await fixtureValue.supervisor.read())["seat-002"].retry!;
  return { ...fixtureValue, store, target };
}

describe("failed assignment retries", () => {
  it("offers the newest eligible failure for each Developer, skipping other statuses and closed sprints", async () => {
    const old = failedGoal("goal-old", "2026-01-01T00:00:00Z");
    delete old.integration; // Goals approved before sprint branches also remain retryable.
    const newest = failedGoal();
    newest.proposal!.outcomes.push({ id: "outcome-2", title: "Newer failure", description: "Fix it", seatId: "seat-002" });
    newest.assignments!.push({ outcomeId: "outcome-2", seatId: "seat-002", status: "failed", updatedAt: "2026-01-03T00:00:00Z" });
    const closed = failedGoal("goal-closed", "2026-01-04T00:00:00Z");
    Object.assign(closed.integration!, { status: "pr-open", prUrl: "https://github.com/o/r/pull/2" });
    const other = failedGoal("goal-other", "2026-01-05T00:00:00Z");
    other.proposal!.outcomes[0].seatId = other.assignments![0].seatId = "seat-003";
    const lead = failedGoal("goal-lead", "2026-01-05T00:00:00Z");
    lead.assignments![0].seatId = "seat-001";
    const active = (["queued", "running", "in-review", "merged"] as const).map((status) => {
      const goal = failedGoal(`goal-${status}`, "2026-01-06T00:00:00Z");
      goal.assignments![0].status = status;
      return goal;
    });
    const { supervisor } = await retryFixture([old, newest, closed, other, lead, ...active]);
    const live = await supervisor.read();
    expect(live["seat-002"].retry).toEqual({ seatId: "seat-002", goalId: "goal-retry", goal: "Fix the terminal", outcomeId: "outcome-2", title: "Newer failure", updatedAt: "2026-01-03T00:00:00Z" });
    expect(live["seat-003"].retry?.goalId).toBe("goal-other");
    expect(live["seat-001"].retry).toBeUndefined();
  });

  it("commits one re-queue to the same seat, preserving the prior PR and runner metadata, even for simultaneous requests", async () => {
    const { store, supervisor, target, dir } = await retryFixture();
    const runtime = { worktree: "/retained/worktree", step: "review", prUrl: "https://github.com/o/r/pull/1" };
    await store.saveRuntime("seat-seat-002-goal-retry-outcome-1", runtime);
    const before = git(dir, "rev-list", "--count", "HEAD");
    const results = await Promise.allSettled([supervisor.retry(target), supervisor.retry(target)]);
    expect(results.filter((item) => item.status === "fulfilled")).toEqual([{ status: "fulfilled", value: "Re-queued goal-retry/outcome-1 for seat-002." }]);
    const failure = results.find((item) => item.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason.message).toContain("queued, not failed");
    const state = await store.read(); // Also validates the saved schema and references.
    expect(state.planningGoals![0].assignments).toEqual([{ outcomeId: "outcome-1", seatId: "seat-002", status: "queued", updatedAt: expect.any(String), prUrl: runtime.prUrl }]);
    expect(state.planningGoals![0].assignments![0].updatedAt).not.toBe(target.updatedAt);
    expect(state.planningGoals![0].updatedAt).toBe(state.planningGoals![0].assignments![0].updatedAt);
    expect(await store.readRuntimeFile("seat-seat-002-goal-retry-outcome-1")).toEqual(runtime);
    expect(Number(git(dir, "rev-list", "--count", "HEAD")) - Number(before)).toBe(1);
    expect(git(dir, "show", "--format=", "--name-only", "HEAD").trim()).toBe("state.json");
    expect((await supervisor.read())["seat-002"]).toMatchObject({ assignment: { status: "queued" } });
    expect((await supervisor.read())["seat-002"].retry).toBeUndefined();
    await expect(supervisor.retry(target)).rejects.toThrow("queued, not failed");
  });

  it.each(["queued", "running", "in-review", "merged"] as const)("refuses a stale selection that became %s", async (status) => {
    const { store, supervisor, target, dir } = await retryFixture();
    await store.update((state) => { state.planningGoals![0].assignments![0].status = status; }, "Advance assignment");
    const head = git(dir, "rev-parse", "HEAD");
    await expect(supervisor.retry(target)).rejects.toThrow(`${status}, not failed`);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("refuses an old confirmation after a subsequent failure, and accepts a fresh confirmation", async () => {
    const { store, supervisor, target } = await retryFixture();
    await store.update((state) => { state.planningGoals![0].assignments![0].updatedAt = "2026-01-03T00:00:00Z"; }, "Record a later failure");
    await expect(supervisor.retry(target)).rejects.toThrow("changed since confirmation");
    expect((await store.read()).planningGoals![0].assignments![0].status).toBe("failed");
    await expect(supervisor.retry((await supervisor.read())["seat-002"].retry!)).resolves.toContain("Re-queued");
  });

  it.each(["pr-open", "merged", "reverted"] as const)("refuses retries once sprint integration is %s", async (status) => {
    const { store, supervisor, target } = await retryFixture();
    // The bridge holds this same lock while opening the integration PR. A retry must wait and reread its result.
    let result: Promise<unknown>;
    await store.withGoalLock(target.goalId, async () => {
      result = expect(supervisor.retry(target)).rejects.toThrow(`is ${status}; it no longer accepts retries`);
      await store.update((state) => {
        Object.assign(state.planningGoals![0].integration!, { status, prUrl: "https://github.com/o/r/pull/2", ...(status !== "pr-open" ? { mergedSha: "b".repeat(40) } : {}), ...(status === "reverted" ? { revertPrUrl: "https://github.com/o/r/pull/3" } : {}) });
      }, "Close sprint integration");
    });
    await result!;
    expect((await supervisor.read())["seat-002"].retry).toBeUndefined();
    expect((await store.read()).planningGoals![0].assignments![0].status).toBe("failed");
  });

  it("rechecks ownership, Developer role and approval without picking a different failure", async () => {
    const { store, supervisor, target } = await retryFixture([failedGoal(), failedGoal("goal-older", "2026-01-01T00:00:00Z")]);
    await store.update((state) => { state.planningGoals![0].assignments![0].seatId = "seat-003"; }, "Reassign outcome");
    await expect(supervisor.retry(target)).rejects.toThrow("no longer assigned to seat-002");
    await expect(supervisor.retry({ ...target, seatId: "seat-001" })).rejects.toThrow("not a Developer");
    await store.update((state) => {
      const goal = state.planningGoals![0];
      goal.stage = "awaiting-review";
      delete goal.assignments; delete goal.integration;
    }, "Remove approval");
    await expect(supervisor.retry(target)).rejects.toThrow("no longer approved");
    await store.update((state) => { state.planningGoals!.shift(); }, "Remove goal");
    await expect(supervisor.retry(target)).rejects.toThrow("no longer approved or available");
    expect((await store.read()).planningGoals![0].assignments![0].status).toBe("failed");
  });
});

describe("CLI goal starter", () => {
  it("starts goals with only the goal text and approves through planning approve", async () => {
    const calls: string[][] = [];
    const starter = new CliGoalStarter("/state", "/app", async (args) => { calls.push(args); return args[1] === "start" ? "Planning goal goal-1: link" : args[1] === "propose" ? "Requested a proposal for goal goal-2." : "Approved goal goal-1: 2 outcome(s) queued for Developer seats."; });
    expect(await starter.start("Fix tests")).toBe("Planning goal goal-1: link");
    expect(await starter.approve("goal-1")).toContain("Approved goal goal-1");
    expect(await starter.propose("goal-2")).toBe("Requested a proposal for goal goal-2.");
    for (const action of ["integrate", "merge", "rollback"] as const) await starter.sprint(action, "goal-1");
    expect(calls).toEqual([
      ["planning", "start", "--state", "/state", "--goal", "Fix tests"],
      ["planning", "approve", "--state", "/state", "--goal", "goal-1"],
      ["planning", "propose", "--state", "/state", "--goal", "goal-2"],
      ["planning", "integrate", "--state", "/state", "--goal", "goal-1"],
      ["planning", "merge", "--state", "/state", "--goal", "goal-1"],
      ["planning", "rollback", "--state", "/state", "--goal", "goal-1"],
    ]);
  });
});
