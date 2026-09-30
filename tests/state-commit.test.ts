import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import { git, stateCheckout } from "./state-checkout.js";

const state = {
  $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [],
  teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }],
};
const fixture = async () => new PlanningStore(await stateCheckout("indra-commit-", state));
const goal = (id: string): PlanningGoal => {
  const now = new Date().toISOString();
  return { id, teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Goal", projectRefs: [], stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } };
};
const addGoal = (id: string) => (doc: PlanningDocument) => { doc.planningGoals = [...(doc.planningGoals ?? []), goal(id)]; };
const subjects = (dir: string) => git(dir, "log", "--format=%s").trim().split("\n").reverse();
const exists = (file: string) => stat(file).then(() => true, () => false);

describe("state commits", () => {
  it("commits each change with its message and only state.json, leaving other staged and untracked files alone", async () => {
    const store = await fixture();
    await writeFile(join(store.checkout, "notes.txt"), "staged\n");
    git(store.checkout, "add", "notes.txt");
    await writeFile(join(store.checkout, "scratch.txt"), "untracked\n");
    await store.update(addGoal("goal-one"), "Start planning goal goal-one");
    await store.update((doc) => { doc.planningGoals![0].brief.summary = "Sharper"; }, (doc) => `Update brief for goal ${doc.planningGoals![0].id}`);
    expect(subjects(store.checkout)).toEqual(["Initial state", "Start planning goal goal-one", "Update brief for goal goal-one"]);
    expect(git(store.checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe("state.json");
    expect(git(store.checkout, "show", "--name-only", "--format=", "HEAD~1").trim()).toBe("state.json");
    expect(git(store.checkout, "diff", "--cached", "--name-only").trim()).toBe("notes.txt");
    expect(git(store.checkout, "status", "--porcelain", "--", "state.json")).toBe("");
    expect(await exists(join(store.checkout, "scratch.txt"))).toBe(true);
    expect((await store.read()).planningGoals![0].brief.summary).toBe("Sharper");
  });

  it("writes state with a failing owner signer configured, preserving identity and configuration", async () => {
    const store = await fixture();
    git(store.checkout, "config", "commit.gpgsign", "true");
    git(store.checkout, "config", "gpg.program", "/usr/bin/false");
    git(store.checkout, "config", "gpg.format", "openpgp");
    const config = await readFile(join(store.checkout, ".git/config"), "utf8");
    const identity = git(store.checkout, "log", "-1", "--format=%an <%ae>|%cn <%ce>");
    expect(() => git(store.checkout, "commit", "--allow-empty", "-qm", "Would require signing")).toThrow();
    await store.update(addGoal("goal-unsigned"), "Unattended state write");
    expect(subjects(store.checkout).at(-1)).toBe("Unattended state write");
    expect(git(store.checkout, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(identity);
    expect(git(store.checkout, "cat-file", "commit", "HEAD")).not.toContain("gpgsig");
    expect(await readFile(join(store.checkout, ".git/config"), "utf8")).toBe(config);
  });

  it("makes no commit when a write changes nothing", async () => {
    const store = await fixture();
    await store.update(addGoal("goal-one"), "Start planning goal goal-one");
    await store.update(() => {}, "Nothing");
    expect(subjects(store.checkout)).toEqual(["Initial state", "Start planning goal goal-one"]);
  });

  it("refuses to write, loudly, when state.json has uncommitted changes it did not make", async () => {
    const store = await fixture();
    const file = join(store.checkout, "state.json");
    const edited = JSON.stringify({ ...state, planningGoals: [goal("goal-hand")] });
    await writeFile(file, edited);
    await expect(store.update(addGoal("goal-one"), "Start planning goal goal-one")).rejects.toThrow("has changes that are not committed");
    expect(await readFile(file, "utf8")).toBe(edited);
    expect(subjects(store.checkout)).toEqual(["Initial state"]);
    git(store.checkout, "add", "state.json");
    await expect(store.update(addGoal("goal-one"), "Start planning goal goal-one")).rejects.toThrow("has changes that are not committed");
  });

  it("rolls the file back and throws when the commit fails", async () => {
    const store = await fixture();
    const hook = join(store.checkout, ".git", "hooks", "pre-commit");
    await mkdir(join(store.checkout, ".git", "hooks"), { recursive: true });
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(store.update(addGoal("goal-one"), "Start planning goal goal-one")).rejects.toThrow("rolled back");
    expect(git(store.checkout, "status", "--porcelain", "--", "state.json")).toBe("");
    expect((await store.read()).planningGoals).toEqual([]);
    expect(await exists(join(store.runtimeDir, "state-commit.json"))).toBe(false);
    await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await store.update(addGoal("goal-one"), "Start planning goal goal-one");
    expect(subjects(store.checkout)).toEqual(["Initial state", "Start planning goal goal-one"]);
  });

  it("finishes the commit of a write whose process stopped before committing", async () => {
    const store = await fixture();
    const written = `${JSON.stringify({ ...state, planningGoals: [goal("goal-crash")] }, null, 2)}\n`;
    await mkdir(store.runtimeDir, { recursive: true });
    await writeFile(join(store.runtimeDir, "state-commit.json"), JSON.stringify({ sha256: createHash("sha256").update(written).digest("hex"), message: "Start planning goal goal-crash" }));
    await writeFile(join(store.checkout, "state.json"), written);
    await store.update(addGoal("goal-next"), "Start planning goal goal-next");
    expect(subjects(store.checkout)).toEqual(["Initial state", "Start planning goal goal-crash", "Start planning goal goal-next"]);
    expect((await store.read()).planningGoals!.map((item) => item.id)).toEqual(["goal-crash", "goal-next"]);
    expect(await exists(join(store.runtimeDir, "state-commit.json"))).toBe(false);
  });

  it("serializes concurrent writes from this process and from other processes without losing any", async () => {
    const store = await fixture();
    const tsx = resolve("node_modules/.bin/tsx");
    const writer = resolve("tests/fixtures/state-writer.ts");
    const child = (label: string) => new Promise<void>((done, fail) => {
      execFile(tsx, [writer, store.checkout, label, "4"], { encoding: "utf8" }, (error, _stdout, stderr) => error ? fail(new Error(`${label}: ${stderr || error.message}`)) : done());
    });
    await Promise.all([
      child("a"), child("b"), child("c"),
      ...[0, 1, 2, 3].map((index) => new PlanningStore(store.checkout).update(addGoal(`goal-local-${index}`), `Start planning goal goal-local-${index}`)),
    ]);
    const ids = (await store.read()).planningGoals!.map((item) => item.id).sort();
    const expected = ["a", "b", "c", "local"].flatMap((label) => [0, 1, 2, 3].map((index) => `goal-${label}-${index}`)).sort();
    expect(ids).toEqual(expected);
    const log = subjects(store.checkout);
    expect(log).toHaveLength(17);
    expect(log.slice(1).map((subject) => subject.replace("Start planning goal ", "")).sort()).toEqual(expected);
    expect(git(store.checkout, "log", "--format=", "--name-only").trim().split("\n").filter(Boolean).every((name) => name === "state.json")).toBe(true);
    expect(git(store.checkout, "status", "--porcelain", "--", "state.json")).toBe("");
    expect(await exists(join(store.runtimeDir, "state.lock"))).toBe(false);
  }, 60_000);

  it("breaks a lock left by a process that no longer exists", async () => {
    const store = await fixture();
    const dead = spawnSync("true").pid;
    await mkdir(store.runtimeDir, { recursive: true });
    await writeFile(join(store.runtimeDir, "state.lock"), `${dead} left-behind`);
    await store.update(addGoal("goal-one"), "Start planning goal goal-one");
    expect(subjects(store.checkout)).toEqual(["Initial state", "Start planning goal goal-one"]);
  });

  it("pushes in the background, and a push that cannot succeed never fails the write", async () => {
    const store = await fixture();
    const remote = await mkdtemp(join(tmpdir(), "indra-remote-"));
    git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    git(store.checkout, "remote", "add", "origin", remote);
    git(store.checkout, "push", "--quiet", "-u", "origin", "main");
    await store.update(addGoal("goal-one"), "Start planning goal goal-one");
    const head = git(store.checkout, "rev-parse", "HEAD").trim();
    const deadline = Date.now() + 10_000;
    while (git(remote, "rev-parse", "main").trim() !== head && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    expect(git(remote, "rev-parse", "main").trim()).toBe(head);
    git(store.checkout, "remote", "set-url", "origin", join(remote, "missing"));
    await store.update(addGoal("goal-two"), "Start planning goal goal-two");
    expect(subjects(store.checkout).at(-1)).toBe("Start planning goal goal-two");
  });
});
