import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxHost, type TmuxRunner } from "../src/tmux-host.js";
import { LocalSessionReader } from "../src/session-snapshot.js";
import { PlanningStore } from "../src/planning.js";

class FakeTmux implements TmuxRunner {
  calls: string[][] = [];
  pane?: string;
  identity = "123:456";
  dead = false;
  onStart?: (nonce: string) => Promise<void>;
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args.includes("display-message")) { if (!this.pane) throw new Error("gone"); return this.identity; }
    if (args.includes("list-panes")) { if (!this.pane) throw new Error("gone"); return `${this.pane}:${this.dead ? 1 : 0}`; }
    if (args.includes("list-sessions")) return this.pane ? args[args.indexOf("-s") + 1] ?? "" : "";
    if (args.includes("has-session")) throw new Error("absent");
    if (args.includes("new-session")) { this.pane = "%1"; if (this.onStart) await this.onStart(args[args.indexOf("--ready-nonce") + 1]); return `${args[args.indexOf("-s") + 1]}:%1`; }
    throw new Error("unexpected tmux call");
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "indra-tmux-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "cli.js"), "");
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: [], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }], sprints: [], planningGoals: [] };
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
    await store.update((state) => { state.planningGoals = [{ id: "goal-1", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Plan", projectRefs: [], stage: "clarifying", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Plan", decisions: [], openQuestions: [] } }]; });
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
});
