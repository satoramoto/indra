import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import { withFileLock } from "../src/state-commit.js";
import { git, stateCheckout } from "./state-checkout.js";

const state = {
  $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [],
  teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }],
};
const pretty = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
const goal = (id: string): PlanningGoal => {
  const now = new Date().toISOString();
  return { id, teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Goal", projectRefs: [], stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } };
};
const addGoal = (id: string) => (doc: PlanningDocument) => { doc.planningGoals = [...(doc.planningGoals ?? []), goal(id)]; };
const head = (dir: string, ref = "HEAD") => git(dir, "rev-parse", ref).trim();
const subjects = (dir: string, ref = "HEAD") => git(dir, "log", "--format=%s", ref).trim().split("\n").reverse();

/** A state checkout tracking a bare "remote", and a second clone standing in for PRs merged on GitHub. */
async function fixture() {
  const checkout = await stateCheckout("indra-sync-", state);
  await writeFile(join(checkout, "state.json"), pretty(state));
  git(checkout, "commit", "--quiet", "-am", "Format state");
  const remote = await mkdtemp(join(tmpdir(), "indra-sync-remote-"));
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "--quiet", "-u", "origin", "main");
  const other = join(await mkdtemp(join(tmpdir(), "indra-sync-other-")), "clone");
  execFileSync("git", ["clone", "--quiet", remote, other]);
  const store = new PlanningStore(checkout);
  /** Merges a change to state.json on the remote, as a merged indra-state PR would. */
  const merge = async (change: (doc: typeof state) => void, message: string) => {
    git(other, "pull", "--quiet", "--ff-only");
    const doc = JSON.parse(await readFile(join(other, "state.json"), "utf8")) as typeof state;
    change(doc);
    await writeFile(join(other, "state.json"), pretty(doc));
    git(other, "commit", "--quiet", "-am", message);
    git(other, "push", "--quiet");
  };
  /** An Indra write whose background push cannot reach the remote, so the commit stays local. */
  const localWrite = async (id: string) => {
    git(checkout, "remote", "set-url", "--push", "origin", join(remote, "unreachable"));
    await store.update(addGoal(id), `Start planning goal ${id}`);
    git(checkout, "remote", "set-url", "--push", "origin", remote);
  };
  return { checkout, remote, store, merge, localWrite };
}
const renameLead = (name: string) => (doc: typeof state) => { doc.teams[0].seats[0].displayName = name; };

const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; });

describe("state sync", () => {
  it("fast-forwards to changes merged on the remote and reports that state.json changed", async () => {
    const { checkout, store, merge } = await fixture();
    await merge(renameLead("Chick Corea"), "Rename Chick");
    const result = await store.sync();
    expect(result).toMatchObject({ outcome: "synced", changed: true, message: "Pulled 1 commit from origin/main." });
    expect(subjects(checkout).at(-1)).toBe("Rename Chick");
    expect((await store.read()).teams).toMatchObject([{ seats: [{ displayName: "Chick Corea" }] }]);
    expect(await store.sync()).toMatchObject({ outcome: "synced", changed: false, message: "Up to date with origin/main." });
  });

  it("rebases unpushed Indra commits onto the remote and pushes them without forcing", async () => {
    const { checkout, remote, store, merge, localWrite } = await fixture();
    await merge(renameLead("Chick Corea"), "Rename Chick");
    const remoteTip = head(remote, "main");
    await localWrite("goal-one");
    await localWrite("goal-two");
    // Record every git command the sync runs.
    const bin = await mkdtemp(join(tmpdir(), "indra-sync-bin-"));
    const log = join(bin, "git.log");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath}`;
    const result = await store.sync();
    process.env.PATH = originalPath;
    expect(result).toMatchObject({ outcome: "synced", changed: true, message: "Pulled 1 commit from origin/main; pushed 2 local commits." });
    expect(subjects(checkout)).toEqual(["Initial state", "Format state", "Rename Chick", "Start planning goal goal-one", "Start planning goal goal-two"]);
    expect(head(remote, "main")).toBe(head(checkout));
    expect(() => git(remote, "merge-base", "--is-ancestor", remoteTip, "main")).not.toThrow();
    const doc = await store.read();
    expect(doc.planningGoals!.map((item) => item.id)).toEqual(["goal-one", "goal-two"]);
    expect(doc.teams).toMatchObject([{ seats: [{ displayName: "Chick Corea" }] }]);
    const pushes = (await readFile(log, "utf8")).split("\n").filter((line) => / push( |$)/.test(line));
    expect(pushes).toHaveLength(1);
    expect(pushes.every((line) => !/--force|--mirror|(^| )-f( |$)| \+/.test(line))).toBe(true);
  });

  it("rebases local state commits with an unavailable owner signer without changing its configuration", async () => {
    const { checkout, remote, store, merge, localWrite } = await fixture();
    await merge(renameLead("Chick Corea"), "Remote change");
    await localWrite("goal-one");
    const before = head(checkout);
    const identity = git(checkout, "log", "-1", "--format=%an <%ae>|%cn <%ce>");
    git(checkout, "config", "commit.gpgsign", "true");
    git(checkout, "config", "gpg.program", "/usr/bin/false");
    git(checkout, "config", "gpg.format", "openpgp");
    const config = await readFile(join(checkout, ".git/config"), "utf8");
    expect(await store.sync()).toMatchObject({ outcome: "synced", changed: true });
    expect(head(checkout)).not.toBe(before);
    expect(head(remote, "main")).toBe(head(checkout));
    expect(git(checkout, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(identity);
    expect(git(checkout, "cat-file", "commit", "HEAD")).not.toContain("gpgsig");
    expect(await readFile(join(checkout, ".git/config"), "utf8")).toBe(config);
  });

  it("aborts a conflicting rebase and leaves the checkout and the remote exactly as they were", async () => {
    const { checkout, remote, store, merge } = await fixture();
    await merge((doc) => { (doc as { planningGoals: PlanningGoal[] }).planningGoals = [goal("goal-remote")]; }, "Add goal-remote");
    const remoteTip = head(remote, "main");
    git(checkout, "remote", "set-url", "--push", "origin", join(remote, "unreachable"));
    await store.update(addGoal("goal-local"), "Start planning goal goal-local");
    git(checkout, "remote", "set-url", "--push", "origin", remote);
    const before = { head: head(checkout), file: await readFile(join(checkout, "state.json"), "utf8"), status: git(checkout, "status", "--porcelain") };
    const result = await store.sync();
    expect(result.outcome).toBe("conflict");
    expect(result.changed).toBe(false);
    expect(result.message).toContain("the checkout is unchanged");
    expect(head(checkout)).toBe(before.head);
    expect(await readFile(join(checkout, "state.json"), "utf8")).toBe(before.file);
    expect(git(checkout, "status", "--porcelain")).toBe(before.status);
    expect(git(checkout, "status")).not.toContain("rebase");
    expect(head(remote, "main")).toBe(remoteTip);
    // The next interval tries again and reports the same conflict rather than failing.
    expect((await store.sync()).outcome).toBe("conflict");
  });

  it("does not touch a checkout with uncommitted changes, and reports it", async () => {
    const { checkout, store, merge } = await fixture();
    await merge(renameLead("Chick Corea"), "Rename Chick");
    const edited = pretty({ ...state, sprints: [] }).replace("Yahaha", "Hand edited");
    await writeFile(join(checkout, "state.json"), edited);
    const before = head(checkout);
    const result = await store.sync();
    expect(result).toMatchObject({ outcome: "dirty", changed: false });
    expect(head(checkout)).toBe(before);
    expect(await readFile(join(checkout, "state.json"), "utf8")).toBe(edited);
  });

  it("reports a remote it cannot reach as a status and changes nothing", async () => {
    const { checkout, remote, store } = await fixture();
    git(checkout, "remote", "set-url", "origin", join(remote, "missing"));
    const before = head(checkout);
    const result = await store.sync();
    expect(result.outcome).toBe("offline");
    expect(result.message).toContain("Could not fetch origin/main");
    expect(head(checkout)).toBe(before);
  });

  it("waits for the state lock, so it never interleaves with a write", async () => {
    const { checkout, store, merge, localWrite } = await fixture();
    await merge(renameLead("Chick Corea"), "Rename Chick");
    let release!: () => void;
    const held = withFileLock(join(store.runtimeDir, "state.lock"), () => new Promise<void>((done) => { release = done; }));
    await new Promise((done) => setTimeout(done, 50));
    let finished = false;
    const syncing = store.sync().then((result) => { finished = true; return result; });
    await new Promise((done) => setTimeout(done, 500));
    expect(finished).toBe(false);
    expect(subjects(checkout).at(-1)).toBe("Format state");
    release();
    await held;
    expect((await syncing).outcome).toBe("synced");
    expect(subjects(checkout).at(-1)).toBe("Rename Chick");

    await merge(renameLead("Chick C."), "Rename Chick again");
    await Promise.all([store.sync(), localWrite("goal-concurrent")]);
    await store.sync();
    expect(subjects(checkout).slice(-2).sort()).toEqual(["Rename Chick again", "Start planning goal goal-concurrent"].sort());
    expect(git(checkout, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(checkout, "rev-list", "--merges", "HEAD").trim()).toBe("");
    const doc = await store.read();
    expect(doc.planningGoals!.map((item) => item.id)).toEqual(["goal-concurrent"]);
    expect(doc.teams).toMatchObject([{ seats: [{ displayName: "Chick C." }] }]);
  }, 30_000);
});
