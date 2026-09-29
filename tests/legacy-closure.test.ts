import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLegacyGoals } from "../src/legacy-closure.js";
import { REMODEL_CLOSURE_GOALS, closeRemodelGoal, migrateLegacyCeremony, advanceCeremony, validateCeremony, validateCeremonyMutation } from "../src/ceremony.js";
import { PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import { StateGit } from "../src/state-commit.js";
import { git, stateCheckout } from "./state-checkout.js";
const at = "2026-09-01T00:00:00Z";
function stuck(id: keyof typeof REMODEL_CLOSURE_GOALS): PlanningGoal {
  const stage = REMODEL_CLOSURE_GOALS[id];
  const goal: PlanningGoal = { id, teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "Historical goal", projectRefs: ["owner/project"], stage: "approved", createdAt: at, updatedAt: at, mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-one", createdAt: at, summary: "Proposal", outcomes: [{ id: "outcome-one", seatId: "seat-dev", title: "Outcome", description: "Do it" }], risks: [], openQuestions: [] },
    assignments: [{ outcomeId: "outcome-one", seatId: "seat-dev", status: stage === "implement" ? "running" : "merged", updatedAt: at, ...(stage === "implement" ? {} : { prUrl: "https://github.com/owner/project/pull/1" }) }],
    integration: { branch: `sprint/${id}`, baseSha: "a".repeat(40), status: stage === "implement" ? "collecting" : "merged", ...(stage === "implement" ? {} : { prUrl: "https://github.com/owner/project/pull/2", mergedSha: "b".repeat(40) }) },
  };
  const migration = migrateLegacyCeremony(goal, at, true);
  if (migration.status !== "ready") throw new Error(migration.reason);
  goal.ceremony = migration.ceremony;
  if (stage === "retro") goal.ceremony = advanceCeremony(goal, { to: "retro", at, evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: "b".repeat(40), mergeVerification: { headSha: "a".repeat(40), reviewCommitSha: "a".repeat(40), reviewer: "satori-miyamoto", checksPassed: true }, checksPassed: true, buildSha: "b".repeat(40), runningSha: "b".repeat(40), runningAt: at } });
  return goal;
}
describe("remodel closure contract", () => {
  it.each(Object.keys(REMODEL_CLOSURE_GOALS) as (keyof typeof REMODEL_CLOSURE_GOALS)[])("closes only %s at its recorded stage without inventing history", (id) => {
    const goal = stuck(id); const history = structuredClone(goal.ceremony!.history);
    const closed = { ...goal, ceremony: closeRemodelGoal(goal, at) };
    expect(closed.ceremony.history).toEqual(history);
    expect(closed.ceremony.stage).toBe(REMODEL_CLOSURE_GOALS[id]);
    expect(closed.ceremony.closure?.evidence).toMatchObject({ kind: "remodel-closure", goalId: id, observed: { planningStage: "approved" } });
    expect(() => validateCeremonyMutation(goal, closed)).not.toThrow();
    expect(() => validateCeremony(closed)).not.toThrow();
    const forged = structuredClone(closed);
    if (forged.ceremony.closure!.evidence.kind !== "remodel-closure") throw new Error("Wrong evidence");
    forged.ceremony.closure!.evidence.observed.assignments = [];
    expect(() => validateCeremony(forged)).toThrow("observed");
  });
  it("refuses unknown goals and changes to workflow facts during closure", () => {
    const goal = stuck("goal-2b118e79");
    expect(() => closeRemodelGoal({ ...goal, id: "goal-other" }, at)).toThrow("six remodel");
    const closed = { ...goal, ceremony: closeRemodelGoal(goal, at), assignments: [] };
    expect(() => validateCeremonyMutation(goal, closed)).toThrow("observed workflow");
  });
});

const ids = Object.keys(REMODEL_CLOSURE_GOALS) as (keyof typeof REMODEL_CLOSURE_GOALS)[];
const closedAt = "2026-09-29T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).flatMap((root) => [root, `${root}.runtime`]).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(goals = ids.map(stuck), product = false) {
  const state: PlanningDocument = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{
    id: "team-one", slug: "fixture", displayName: "Fixture", ...(product ? { workflowModel: "goals-v1" } : {}), project: { github: "owner/project" },
    externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-one", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "lead", username: "lead" } } },
      { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
      ...(product ? [{ id: "seat-product", displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { userId: "product", username: "product" } } }] : []),
    ],
  }], planningGoals: structuredClone(goals) };
  const root = await stateCheckout("indra-remodel-closure-", state); roots.push(root);
  await mkdir(join(root, "schema/v1"), { recursive: true });
  await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(root, "schema/v1/state.schema.json"));
  git(root, "add", "schema"); git(root, "commit", "--quiet", "-m", "Fixture schema");
  // Exercise the real transaction and Git commit, without starting a detached network push in a fixture.
  vi.spyOn(StateGit.prototype, "pushInBackground").mockImplementation(() => {});
  const store = new PlanningStore(root, undefined, { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } });
  return { root, store, state, head: git(root, "rev-parse", "HEAD").trim(), bytes: await readFile(join(root, "state.json"), "utf8") };
}
function newGoal(id = "goal-new"): PlanningGoal {
  return { id, workflowModel: "goals-v1", ownedFiles: ["src/new.ts"], teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "New goal", projectRefs: ["owner/project"],
    stage: "clarifying", createdAt: at, updatedAt: at, mattermost: { channelId: "home", rootPostId: "new-root" }, brief: { summary: "New goal", decisions: [], openQuestions: [] },
    ceremony: { version: 1, stage: "planning", history: [{ stage: "planning", enteredAt: at }] } };
}

describe("startup closure through the real state transaction", () => {
  it("closes all six once, retaining complete history and exactly the observed partial abandoned work", async () => {
    const goals = ids.map(stuck);
    const abandoned = goals[0];
    abandoned.assignments![0].note = "Interrupted; no completion proof";
    abandoned.proposal!.outcomes.push({ id: "outcome-two", seatId: "seat-dev", title: "Other work", description: "Historical work" });
    abandoned.assignments!.push({ outcomeId: "outcome-two", seatId: "seat-dev", status: "failed", updatedAt: at, prUrl: "https://github.com/owner/project/pull/9", note: "Closed without merge" });
    const f = await fixture(goals);
    expect(await closeLegacyGoals(f.store, closedAt)).toEqual(ids.map((goalId) => ({ goalId, status: "closed", reason: expect.stringContaining(goalId === ids[0] ? "abandoned" : "superseded") })));
    const saved = await f.store.read();
    for (const [index, goal] of saved.planningGoals!.entries()) {
      const before = f.state.planningGoals![index];
      const closure = goal.ceremony!.closure!;
      expect(goal).toEqual({ ...before, ceremony: { ...before.ceremony, closure } });
      expect(closure).toMatchObject({ closedAt, evidence: { kind: "remodel-closure", goalId: goal.id, stage: REMODEL_CLOSURE_GOALS[goal.id as keyof typeof REMODEL_CLOSURE_GOALS] } });
      expect(() => validateCeremonyMutation(before, goal)).not.toThrow();
    }
    expect(saved.planningGoals![0].ceremony!.closure!.evidence).toMatchObject({ observed: {
      integration: { branch: `sprint/${ids[0]}`, status: "collecting", prUrl: null, mergedSha: null, revertPrUrl: null },
      assignments: [
        { outcomeId: "outcome-one", status: "running", prUrl: null, note: "Interrupted; no completion proof" },
        { outcomeId: "outcome-two", status: "failed", prUrl: "https://github.com/owner/project/pull/9", note: "Closed without merge" },
      ],
    } });
    expect(git(f.root, "rev-list", "--count", `${f.head}..HEAD`).trim()).toBe("1");
    expect(git(f.root, "show", "--format=", "--name-only", "HEAD").trim()).toBe("state.json");
    expect(git(f.root, "status", "--porcelain").trim()).toBe("");
    const bytes = await readFile(join(f.root, "state.json"), "utf8"); const head = git(f.root, "rev-parse", "HEAD");
    expect((await closeLegacyGoals(f.store, "2026-10-01T00:00:00.000Z")).map((result) => result.status)).toEqual(ids.map(() => "already-closed"));
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(bytes); expect(git(f.root, "rev-parse", "HEAD")).toBe(head);
  });

  it("does not modify unrelated, new-model, or already-closed records and never fabricates missing goals", async () => {
    const unrelated = stuck(ids[0]); unrelated.id = "goal-unrelated"; unrelated.integration!.branch = "sprint/goal-unrelated";
    const closed = stuck(ids[1]); closed.ceremony = closeRemodelGoal(closed, closedAt);
    const f = await fixture([unrelated, newGoal(), newGoal(ids[2]), closed], true);
    expect(await closeLegacyGoals(f.store, closedAt)).toEqual([
      { goalId: ids[2], status: "conflict", reason: expect.stringContaining("new workflow") },
      { goalId: ids[1], status: "already-closed", reason: expect.any(String) },
    ]);
    expect(await f.store.read()).toEqual(f.state);
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(f.bytes);
    expect(git(f.root, "rev-parse", "HEAD").trim()).toBe(f.head);
    const absent = await fixture([unrelated]); const update = vi.spyOn(absent.store, "update");
    expect(await closeLegacyGoals(absent.store, closedAt)).toEqual([]); expect(update).not.toHaveBeenCalled();
  });

  it("reports missing or unexpected ceremony evidence while closing independent eligible records", async () => {
    const missing = stuck(ids[0]); delete missing.ceremony;
    const wrong = stuck(ids[0]); wrong.id = ids[1]; wrong.integration!.branch = `sprint/${wrong.id}`;
    const f = await fixture([missing, wrong, stuck(ids[2])]);
    expect((await closeLegacyGoals(f.store, closedAt)).map(({ goalId, status }) => ({ goalId, status }))).toEqual([
      { goalId: ids[0], status: "conflict" }, { goalId: ids[1], status: "conflict" }, { goalId: ids[2], status: "closed" },
    ]);
    expect((await f.store.read()).planningGoals!.slice(0, 2)).toEqual([missing, wrong]);
  });

  it.each(["invalid-time", "2026-08-01T00:00:00.000Z"])("rejects the unsafe closure timestamp %s without rewriting history", async (time) => {
    const f = await fixture();
    expect((await closeLegacyGoals(f.store, time)).every((result) => result.status === "conflict")).toBe(true);
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(f.bytes); expect(git(f.root, "rev-parse", "HEAD").trim()).toBe(f.head);
  });

  it.each(["malformed-json", "invalid-evidence"])("does not write when stored state has %s", async (problem) => {
    const f = await fixture();
    const malformed = structuredClone(f.state);
    malformed.planningGoals![0].ceremony!.history = [];
    const bytes = problem === "malformed-json" ? "{private invalid state" : JSON.stringify(malformed);
    await writeFile(join(f.root, "state.json"), bytes);
    const update = vi.spyOn(f.store, "update");
    const result = await closeLegacyGoals(f.store, closedAt);
    expect(result.map((item) => item.goalId)).toEqual(ids); expect(result.every((item) => item.status === "conflict")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private"); expect(update).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(bytes); expect(git(f.root, "rev-parse", "HEAD").trim()).toBe(f.head);
  });

  it("preserves uncommitted state and refuses to claim that the closure was committed", async () => {
    const f = await fixture(); const changed = structuredClone(f.state); changed.planningGoals![0].brief.summary = "Owner's uncommitted direction";
    const bytes = JSON.stringify(changed); await writeFile(join(f.root, "state.json"), bytes);
    const diff = git(f.root, "diff");
    expect((await closeLegacyGoals(f.store, closedAt)).every((result) => result.status === "conflict")).toBe(true);
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(bytes); expect(git(f.root, "diff")).toBe(diff);
    expect(git(f.root, "rev-parse", "HEAD").trim()).toBe(f.head);
  });

  it("uses the real schema guard and leaves the entire batch unchanged when closure writes are unsupported", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "schema/v1/state.schema.json"), JSON.stringify({ not: {} }));
    git(f.root, "add", "schema"); git(f.root, "commit", "--quiet", "-m", "Fixture rejects closure writes");
    const head = git(f.root, "rev-parse", "HEAD"); const save = vi.spyOn(f.store, "saveRuntime");
    expect((await closeLegacyGoals(f.store, closedAt)).every((result) => result.status === "conflict")).toBe(true);
    expect(save).not.toHaveBeenCalled(); expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(f.bytes);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(head);
  });

  it("serializes concurrent startup invocations into one state commit", async () => {
    const f = await fixture(); const results = await Promise.all([closeLegacyGoals(f.store, closedAt), closeLegacyGoals(f.store, closedAt)]);
    expect(results.flat().filter((item) => item.status === "closed")).toHaveLength(6);
    expect(results.flat().filter((item) => item.status === "already-closed")).toHaveLength(6);
    expect(git(f.root, "rev-list", "--count", `${f.head}..HEAD`).trim()).toBe("1");
  });

  it("recovers an interrupted normal state commit without generating a second closure or timestamp", async () => {
    const f = await fixture(); const written = structuredClone(f.state);
    for (const goal of written.planningGoals!) goal.ceremony = closeRemodelGoal(goal, closedAt);
    const bytes = `${JSON.stringify(written, null, 2)}\n`;
    await f.store.saveRuntime("state-commit", { sha256: createHash("sha256").update(bytes).digest("hex"), message: "Interrupted fixture closure" });
    await writeFile(join(f.root, "state.json"), bytes);
    expect((await closeLegacyGoals(f.store, "2026-10-01T00:00:00.000Z")).every((item) => item.status === "already-closed")).toBe(true);
    expect(await f.store.read()).toEqual(written); expect(git(f.root, "rev-list", "--count", `${f.head}..HEAD`).trim()).toBe("1");
    expect(git(f.root, "log", "-1", "--format=%s").trim()).toBe("Interrupted fixture closure");
    expect(await f.store.readRuntimeFile("state-commit")).toBeUndefined(); expect(git(f.root, "status", "--porcelain").trim()).toBe("");
  });

  it("does not invent confirmation after a lost commit response, and reconciles the next invocation", async () => {
    const f = await fixture(); const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementationOnce(async (...args) => { await update(...args); throw new Error("Lost response"); });
    expect((await closeLegacyGoals(f.store, closedAt)).every((item) => item.status === "conflict")).toBe(true);
    expect((await closeLegacyGoals(f.store, closedAt)).every((item) => item.status === "already-closed")).toBe(true);
    expect(git(f.root, "rev-list", "--count", `${f.head}..HEAD`).trim()).toBe("1");
  });
});
