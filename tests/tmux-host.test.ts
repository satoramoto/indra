import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemTmux, TmuxHost, type TmuxRunner } from "../src/tmux-host.js";
import { LocalSessionReader } from "../src/session-snapshot.js";
import { PlanningStore } from "../src/planning.js";
import { git } from "./state-checkout.js";

class FakeTmux implements TmuxRunner {
  calls: string[][] = [];
  pane?: string;
  session?: string;
  identity = "123:456";
  dead = false;
  globalEnv = "";
  onStart?: (nonce: string) => Promise<void>;
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args.includes("display-message")) { if (!this.pane) throw new Error("gone"); return this.identity.split(":")[0]; }
    if (args.includes("kill-session")) { this.pane = undefined; return ""; }
    if (args.includes("list-panes")) { if (!this.pane) throw new Error("gone"); return `${this.pane}:${this.dead ? 1 : 0}`; }
    if (args.includes("list-sessions")) return this.pane ? `${this.session} ${this.identity.split(":")[1]}` : "";
    if (args.includes("has-session")) throw new Error("absent");
    if (args.includes("show-environment")) return this.globalEnv;
    if (args.includes("new-session")) { this.pane = "%1"; this.session = args[args.indexOf("-s") + 1]; if (this.onStart) await this.onStart(args[args.indexOf("--ready-nonce") + 1]); return `${args[args.indexOf("-s") + 1]}:%1`; }
    throw new Error("unexpected tmux call");
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "indra-tmux-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "cli.js"), "");
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }], sprints: [], planningGoals: [] };
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

describe("tmux host", () => {
  it("uses exact owned names and argv, then reuses a verified session", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir);
    fake.onStart = async (nonce) => { await writeFile(host.readyFile(nonce), JSON.stringify({ nonce })); };
    const record = await host.start();
    const launch = fake.calls.find((args) => args.includes("new-session"))!;
    expect(launch).toContain(process.execPath);
    expect(launch).toContain(join(dir, "dist", "cli.js"));
    expect(launch).toContain("serve");
    expect(launch).not.toContain("sh");
    expect(host.attachTarget(record)).toMatch(/^indra-[a-f0-9]{12}:chick-[a-f0-9]{12}$/);
    await host.start();
    expect(fake.calls.filter((args) => args.includes("new-session"))).toHaveLength(1);
  });

  it("unsets OP_SERVICE_ACCOUNT_TOKEN and any OP_* variable in the tmux server's environment for the hosted pane", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir);
    fake.globalEnv = "HOME=/h\nOP_SERVICE_ACCOUNT_TOKEN=ops_old\nOP_SESSION_owner=s\n-OP_GONE";
    fake.onStart = async (nonce) => { await writeFile(host.readyFile(nonce), JSON.stringify({ nonce })); };
    await host.start();
    const launch = fake.calls.find((args) => args.includes("new-session"))!;
    const command = launch.slice(launch.indexOf("/usr/bin/env"));
    expect(command.slice(0, command.indexOf(process.execPath))).toEqual(["/usr/bin/env", "-u", "OP_SERVICE_ACCOUNT_TOKEN", "-u", "OP_SESSION_owner"]);
    expect(launch.join(" ")).not.toContain("ops_old");
  });

  it("withholds attach target when pane no longer matches", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir);
    fake.onStart = async (nonce) => { await writeFile(host.readyFile(nonce), JSON.stringify({ nonce })); };
    await host.start();
    fake.identity = "987:654";
    expect(await host.verifiedRecord()).toBeUndefined();
    const snapshot = await new LocalSessionReader(dir, new PlanningStore(dir), host).readSessions();
    expect(snapshot.connection).toBe("disconnected");
    expect(snapshot.sessions).toEqual([]);
  });

  it("returns a neutral snapshot with a verified attach target", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir);
    fake.onStart = async (nonce) => { await writeFile(host.readyFile(nonce), JSON.stringify({ nonce })); };
    await host.start();
    const store = new PlanningStore(dir);
    git(dir, "init", "--quiet"); git(dir, "add", "state.json"); git(dir, "commit", "--quiet", "-m", "Initial state");
    await store.update((state) => { state.planningGoals = [{ id: "goal-1", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Plan", projectRefs: [], stage: "clarifying", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Plan", decisions: [], openQuestions: [] } }]; }, "Start planning goal goal-1");
    const snapshot = await new LocalSessionReader(dir, store, host).readSessions();
    expect(snapshot.connection).toBe("connected");
    expect(snapshot.sessions[0]).toMatchObject({ id: "goal-1", status: "idle", engine: "codex", attach: { kind: "tmux", target: host.attachTarget((await host.readRecord())!) } });
  });

  it("does not claim readiness before the bridge signals its first successful poll", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir, 100);
    await expect(host.start()).rejects.toThrow("did not become ready");
  });

  it("rejects a dead pane even with matching identifiers", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir);
    fake.onStart = async (nonce) => { await writeFile(host.readyFile(nonce), JSON.stringify({ nonce })); };
    await host.start();
    fake.dead = true;
    expect(await host.verifiedRecord()).toBeUndefined();
  });

  it("kills the session it just created when identity capture fails", async () => {
    const dir = await fixture(); const fake = new FakeTmux(); const host = new TmuxHost(dir, fake, dir);
    fake.identity = "123:";
    await expect(host.start()).rejects.toThrow("stable server and session identity");
    const kill = fake.calls.find((args) => args.includes("kill-session"))!;
    expect(kill.slice(-2)).toEqual(["-t", `=${fake.session}:`]);
    expect(fake.pane).toBeUndefined();
    expect(await host.readRecord()).toBeUndefined();
  });
});

let hasTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { hasTmux = false; }

describe.skipIf(!hasTmux)("tmux host on a real tmux server", () => {
  it("starts, verifies its record and stops", async () => {
    const dir = await fixture();
    // The fixture CLI writes the ready file for the nonce it is given, then keeps the pane alive.
    await writeFile(join(dir, "dist", "cli.js"), `const fs = require("node:fs"); const path = require("node:path"); const a = process.argv; const nonce = a[a.indexOf("--ready-nonce") + 1]; const state = a[a.indexOf("--state") + 1]; const file = path.join(path.resolve(state) + ".runtime", "host-ready-" + nonce + ".json"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ nonce })); setInterval(() => {}, 1000);`);
    const host = new TmuxHost(dir, new SystemTmux(), dir);
    try {
      const record = await host.start();
      expect(record.tmuxIdentity).toMatch(/^\d+:\d+$/);
      expect(await host.verifiedRecord()).toEqual(record);
      expect(await host.stop()).toBe(true);
      expect(await host.verifiedRecord()).toBeUndefined();
    } finally {
      const record = await host.readRecord();
      // The server exits by itself after stop(); this only cleans up after a failure.
      if (record) try { execFileSync("tmux", ["-L", record.socket, "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
    }
  }, 30_000);
});
