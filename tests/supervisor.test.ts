import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore } from "../src/planning.js";
import { signalReady, TmuxHost, type TmuxRunner } from "../src/tmux-host.js";
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

describe("CLI goal starter", () => {
  it("saves a typed planning channel to the team as a state commit", async () => {
    const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [seat("seat-001", "Chick", ["Team Lead"])] }] };
    const dir = await stateCheckout("indra-goal-starter-", state);
    const starter = new CliGoalStarter(dir, dir);
    expect(await starter.channelFor("team-001")).toBeUndefined();
    await starter.saveChannel("team-001", "abcdefghijklmnopqrstuvwxyz");
    expect(await starter.channelFor("team-001")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("Record the planning channel for team team-001");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });
});
