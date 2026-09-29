import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processShell } from "../src/developer-seat.js";
import { commitHasCeremony, mergedWithCeremony } from "../src/project-checkout.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { advanceCeremony, closeCeremony, closeRevertedRelease, migrateLegacyCeremony, type PublishedRetroEvidence, type RunningReleaseEvidence } from "../src/ceremony.js";
import type { CeremonyWriteReadiness } from "../src/ceremony-ports.js";
import { legacyMigrationBlocker, PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import { isFinishedSprint } from "../src/finished-sprint.js";
import { projectSprint } from "../src/session-snapshot.js";
import { git, stateCheckout } from "./state-checkout.js";

/** A trimmed copy of the real indra-state before the ceremony build: four goals on team-001, none with a ceremony. */
const real = JSON.parse(await readFile(resolve("tests/fixtures/legacy-state.json"), "utf8")) as PlanningDocument;
const schema = JSON.parse(await readFile(resolve("schema/v1/state.schema.json"), "utf8")) as object;
const ajv = new Ajv2020({ strict: false }); addFormats.default(ajv);
const validSchema = ajv.compile(schema);
const ready: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
const migratedAt = "2026-09-29T12:00:00.000Z";
const goalOf = (state: PlanningDocument, id: string) => state.planningGoals!.find((goal) => goal.id === id)!;
const legacy = (id: string) => structuredClone(goalOf(real, id));
/** The real merged sprints (#32, #46) predate the ceremony: their merge commits have no src/ceremony.ts. */
const preCeremony = async () => false;

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function store(state: PlanningDocument = real): Promise<PlanningStore> {
  const checkout = await stateCheckout("indra-legacy-", state); dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile(resolve("schema/v1/state.schema.json"), join(checkout, "schema/v1/state.schema.json"));
  git(checkout, "add", "schema"); git(checkout, "commit", "--quiet", "-m", "Add schema");
  return new PlanningStore(checkout, undefined, ready);
}
const commits = (persistence: PlanningStore) => git(persistence.checkout, "log", "--format=%s").trim().split("\n");

describe("migrating the real legacy goals", () => {
  it("closes goal-855701cc: approved, every assignment merged, and no integration (it predates sprint branches)", () => {
    const result = migrateLegacyCeremony(legacy("goal-855701cc"), migratedAt);
    if (result.status !== "ready") throw new Error(result.reason);
    expect(result.ceremony).toEqual({ version: 1, stage: "release", migratedAt, history: [
      { stage: "planning", enteredAt: "2026-09-28T16:39:06.370Z" },
      { stage: "proposal", enteredAt: null },
      { stage: "implement", enteredAt: null, evidence: { kind: "legacy-approval", proposalId: "proposal-d4510a0a" } },
      { stage: "release", enteredAt: null, evidence: { kind: "legacy-implementation", outcomes: [20, 21, 22, 23].map((pr, index) => ({
        outcomeId: `outcome-${index + 1}`, seatId: `seat-00${index + 2}`, prUrl: `https://github.com/satoramoto/indra/pull/${pr}` })) } },
    ], closure: { closedAt: migratedAt, evidence: { kind: "legacy-migration", integration: "none" } } });
  });
  it.each([
    ["goal-ca9dd9ed", "https://github.com/satoramoto/indra/pull/32", "baca998cb037b5cd6f0ce8ffb3bd9a9998e391b5"],
    ["goal-df104a26", "https://github.com/satoramoto/indra/pull/46", "d368f068605ad08d8b4847d6e08595c47c4e4119"],
  ])("closes %s, whose integration merged before the ceremony existed, without inventing a retro or timings", (id, prUrl, mergedSha) => {
    const result = migrateLegacyCeremony(legacy(id), migratedAt, false);
    if (result.status !== "ready") throw new Error(result.reason);
    expect(result.ceremony.stage).toBe("release");
    expect(result.ceremony.history.slice(1).every((entry) => entry.enteredAt === null)).toBe(true);
    expect(result.ceremony.closure).toEqual({ closedAt: migratedAt, evidence: { kind: "legacy-migration", integration: "merged", prUrl, mergedSha } });
  });
  it("puts goal-88dd199e (every assignment merged, integration PR open) in release, open, so #64 can merge and release and retro follow", () => {
    const item = legacy("goal-88dd199e");
    const result = migrateLegacyCeremony(item, migratedAt);
    if (result.status !== "ready") throw new Error(result.reason);
    expect(result.ceremony.stage).toBe("release");
    expect(result.ceremony.closure).toBeUndefined();
    expect(result.ceremony.history.at(-1)).toMatchObject({ stage: "release", enteredAt: null, evidence: { kind: "legacy-implementation" } });
    // Merging #64 through the merge gate, then the running-build evidence, then the published retro.
    item.ceremony = result.ceremony;
    item.integration = { ...item.integration!, status: "merged", mergedSha: "e".repeat(40) };
    const running: RunningReleaseEvidence = { kind: "release-running", prUrl: item.integration.prUrl!, mergedSha: "e".repeat(40), mergePostId: "merge-post",
      approval: { source: "owner-command", command: "planning merge", at: "2026-09-29T12:10:00.000Z" }, checksPassed: true, buildSha: "e".repeat(40), runningSha: "e".repeat(40), runningAt: "2026-09-29T12:20:00.000Z" };
    item.ceremony = advanceCeremony(item, { to: "retro", at: "2026-09-29T12:21:00.000Z", evidence: running });
    const retro: PublishedRetroEvidence = { kind: "retro-published", path: "docs/retros/goal-88dd199e.md", prUrl: "https://github.com/satoramoto/indra/pull/70", baseBranch: "main",
      mergedSha: "f".repeat(40), postId: "retro-post", publishedAt: "2026-09-29T13:00:00.000Z", factsOnly: true, suggestions: "owner-proposals-only" };
    item.ceremony = closeCeremony(item, "2026-09-29T13:01:00.000Z", retro);
    expect(item.ceremony.closure?.evidence.kind).toBe("retro-published");
  });
  it("migrates the whole real state at start-up in one commit per goal, valid against the v1 schema, and is idempotent", async () => {
    const persistence = await store();
    const results = await persistence.migrateLegacyGoals(migratedAt, preCeremony);
    expect(results).toEqual([
      { goalId: "goal-855701cc", status: "migrated", summary: "closed at release (legacy migration)" },
      { goalId: "goal-ca9dd9ed", status: "migrated", summary: "closed at release (legacy migration)" },
      { goalId: "goal-df104a26", status: "migrated", summary: "closed at release (legacy migration)" },
      { goalId: "goal-88dd199e", status: "migrated", summary: "entered release" },
    ]);
    const state = await persistence.read();
    expect(validSchema(state), JSON.stringify(validSchema.errors)).toBe(true);
    // Only the ceremony is added: workflow facts, including updatedAt, are exactly the original record.
    for (const goal of state.planningGoals!) { const { ceremony, ...rest } = goal; expect(ceremony?.migratedAt).toBe(migratedAt); expect(rest).toEqual(goalOf(real, goal.id)); }
    expect(commits(persistence).slice(0, 4)).toEqual([
      "Migrate legacy goal goal-88dd199e into the ceremony: entered release",
      "Migrate legacy goal goal-df104a26 into the ceremony: closed at release (legacy migration)",
      "Migrate legacy goal goal-ca9dd9ed into the ceremony: closed at release (legacy migration)",
      "Migrate legacy goal goal-855701cc into the ceremony: closed at release (legacy migration)",
    ]);
    const before = await readFile(join(persistence.checkout, "state.json"), "utf8");
    expect(await persistence.migrateLegacyGoals("2026-09-30T00:00:00.000Z")).toEqual([]);
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(before);
    expect(commits(persistence)).toHaveLength(6);
  });
  it("lets a new goal start once the finished goals are migrated, and names only the open sprint until then", async () => {
    const finished = structuredClone(real); finished.planningGoals = finished.planningGoals!.filter((goal) => goal.id !== "goal-88dd199e");
    const persistence = await store(finished);
    const next: PlanningGoal = { ...legacy("goal-855701cc"), id: "goal-next", stage: "clarifying", createdAt: "2026-09-29T12:30:00.000Z", updatedAt: "2026-09-29T12:30:00.000Z" };
    delete next.proposal; delete next.assignments;
    await expect(persistence.createGoal(next)).rejects.toThrow("goal-855701cc, goal-ca9dd9ed, goal-df104a26");
    await persistence.migrateLegacyGoals(migratedAt, preCeremony);
    await persistence.createGoal(next);
    expect(goalOf(await persistence.read(), "goal-next").ceremony?.stage).toBe("planning");

    const all = await store();
    await all.migrateLegacyGoals(migratedAt, preCeremony);
    await expect(all.createGoal(next)).rejects.toThrow(/unclosed goals: goal-88dd199e\.$/);
  });
  it("hides exactly the goals that no longer block a new one", async () => {
    const persistence = await store();
    const unmigrated = (await persistence.read()).planningGoals!;
    expect(unmigrated.map((goal) => isFinishedSprint(projectSprint(goal)))).toEqual([false, false, false, false]);
    await persistence.migrateLegacyGoals(migratedAt, preCeremony);
    const migrated = (await persistence.read()).planningGoals!;
    expect(migrated.map((goal) => isFinishedSprint(projectSprint(goal)))).toEqual(migrated.map((goal) => Boolean(goal.ceremony?.closure)));
    expect(migrated.filter((goal) => !isFinishedSprint(projectSprint(goal))).map((goal) => goal.id)).toEqual(["goal-88dd199e"]);
  });
});

describe("legacy migration shapes and conflicts", () => {
  it("enters planning, proposal and implement from what the goal recorded", () => {
    const planning = legacy("goal-88dd199e"); Object.assign(planning, { stage: "clarifying" }); delete planning.proposal; delete planning.assignments; delete planning.integration;
    const proposal = legacy("goal-88dd199e"); Object.assign(proposal, { stage: "awaiting-review" }); delete proposal.assignments; delete proposal.integration;
    const collecting = legacy("goal-88dd199e"); Object.assign(collecting.integration!, { status: "collecting" }); delete collecting.integration!.prUrl;
    const building = legacy("goal-88dd199e"); building.assignments![0].status = "running"; Object.assign(building.integration!, { status: "collecting" }); delete building.integration!.prUrl;
    const unintegrated = legacy("goal-855701cc"); unintegrated.assignments![0].status = "failed";
    for (const [item, stage] of [[planning, "planning"], [proposal, "proposal"], [collecting, "implement"], [building, "implement"], [unintegrated, "implement"]] as const) {
      const result = migrateLegacyCeremony(item, migratedAt);
      expect(result.status === "ready" && [result.ceremony.stage, result.ceremony.closure]).toEqual([stage, undefined]);
    }
  });
  it("closes a reverted integration, and leaves a merged one with its revert PR open in release", () => {
    const reverted = legacy("goal-ca9dd9ed"); Object.assign(reverted.integration!, { status: "reverted", revertPrUrl: "https://github.com/satoramoto/indra/pull/33" });
    const result = migrateLegacyCeremony(reverted, migratedAt);
    expect(result.status === "ready" && result.ceremony.closure?.evidence).toMatchObject({ kind: "legacy-migration", integration: "reverted", revertPrUrl: "https://github.com/satoramoto/indra/pull/33" });
    const revertOpen = legacy("goal-ca9dd9ed"); revertOpen.integration!.revertPrUrl = "https://github.com/satoramoto/indra/pull/33";
    const open = migrateLegacyCeremony(revertOpen, migratedAt);
    expect(open.status === "ready" && [open.ceremony.stage, open.ceremony.closure]).toEqual(["release", undefined]);
  });
  it("reports conflicting evidence instead of guessing, and the store leaves those goals untouched", async () => {
    const running = legacy("goal-df104a26"); running.assignments![1].status = "running";
    expect(migrateLegacyCeremony(running, migratedAt)).toEqual({ status: "conflict", reason: "its integration is merged, but outcome outcome-2 is running." });
    const unassigned = legacy("goal-ca9dd9ed"); unassigned.assignments!.pop();
    expect(migrateLegacyCeremony(unassigned, migratedAt)).toMatchObject({ status: "conflict", reason: expect.stringContaining("do not match its proposed outcomes") });
    const state = structuredClone(real); state.planningGoals![2] = running;
    const persistence = await store(state);
    const results = await persistence.migrateLegacyGoals(migratedAt, preCeremony);
    expect(results.find((item) => item.goalId === "goal-df104a26")).toEqual({ goalId: "goal-df104a26", status: "conflict", reason: "its integration is merged, but outcome outcome-2 is running." });
    expect(goalOf(await persistence.read(), "goal-df104a26")).toEqual(running);
    expect(legacyMigrationBlocker(running)).toContain("evidence conflicts: its integration is merged, but outcome outcome-2 is running.");
    expect(legacyMigrationBlocker(legacy("goal-df104a26"))).toContain("not migrated yet");
  });
  it("accepts only the migration its evidence proves, never a hand-written one", async () => {
    const persistence = await store();
    const derived = migrateLegacyCeremony(legacy("goal-88dd199e"), migratedAt);
    if (derived.status !== "ready") throw new Error(derived.reason);
    const closed = structuredClone(derived.ceremony); closed.closure = { closedAt: migratedAt, evidence: { kind: "legacy-migration", integration: "none" } };
    const timed = structuredClone(derived.ceremony); timed.history[1].enteredAt = "2026-09-29T01:30:00.000Z";
    for (const ceremony of [closed, timed]) {
      await expect(persistence.update((state) => { goalOf(state, "goal-88dd199e").ceremony = ceremony; }, "Hand-written migration")).rejects.toThrow();
    }
    expect(goalOf(await persistence.read(), "goal-88dd199e").ceremony).toBeUndefined();
  });
});

describe("a release reverted before it ran", () => {
  it("closes as reverted from release, so the team is not locked", async () => {
    const item = legacy("goal-88dd199e");
    const result = migrateLegacyCeremony(item, migratedAt);
    if (result.status !== "ready") throw new Error(result.reason);
    item.ceremony = result.ceremony;
    expect(() => closeRevertedRelease(item, "2026-09-29T12:40:00.000Z")).toThrow("reverted integration");
    item.integration = { ...item.integration!, status: "reverted", mergedSha: "e".repeat(40), revertPrUrl: "https://github.com/satoramoto/indra/pull/65" };
    expect(() => advanceCeremony(item, { to: "retro", at: "2026-09-29T12:40:00.000Z", evidence: { kind: "release-running", prUrl: "https://github.com/satoramoto/indra/pull/64", mergedSha: "e".repeat(40), mergePostId: "merge-post",
      approval: { source: "owner-command", command: "planning merge", at: "2026-09-29T12:10:00.000Z" }, checksPassed: true, buildSha: "e".repeat(40), runningSha: "e".repeat(40), runningAt: "2026-09-29T12:20:00.000Z" } })).toThrow("not been reverted");
    const persistence = await store({ ...structuredClone(real), planningGoals: [item] });
    await persistence.update((state) => { const found = state.planningGoals![0]; found.ceremony = closeRevertedRelease(found, "2026-09-29T12:40:00.000Z"); }, "Close reverted release");
    const saved = (await persistence.read()).planningGoals![0];
    expect(validSchema(await persistence.read())).toBe(true);
    expect(saved.ceremony?.closure).toEqual({ closedAt: "2026-09-29T12:40:00.000Z", evidence: { kind: "release-reverted", prUrl: "https://github.com/satoramoto/indra/pull/64", mergedSha: "e".repeat(40), revertPrUrl: "https://github.com/satoramoto/indra/pull/65" } });
    expect(isFinishedSprint(projectSprint(saved))).toBe(true);
    const next: PlanningGoal = { ...legacy("goal-855701cc"), id: "goal-next", stage: "clarifying", createdAt: "2026-09-29T12:50:00.000Z", updatedAt: "2026-09-29T12:50:00.000Z" };
    delete next.proposal; delete next.assignments;
    await persistence.createGoal(next);
  });
});

/** A project repository with a commit before the ceremony code and one that contains it. */
async function project(): Promise<{ dir: string; before: string; after: string }> {
  const dir = await mkdtemp(join(tmpdir(), "indra-project-")); dirs.push(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(dir, "README.md"), "Indra\n");
  git(dir, "add", "README.md"); git(dir, "commit", "--quiet", "-m", "Before the ceremony");
  const before = git(dir, "rev-parse", "HEAD").trim();
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/ceremony.ts"), "export {};\n");
  git(dir, "add", "src/ceremony.ts"); git(dir, "commit", "--quiet", "-m", "Add the ceremony");
  return { dir, before, after: git(dir, "rev-parse", "HEAD").trim() };
}

describe("a merged legacy sprint, told apart by its merge commit", () => {
  it("inspects the merge commit in the project checkout, and cannot tell when the commit or checkout is unavailable", async () => {
    const repo = await project();
    expect(await commitHasCeremony(processShell, repo.dir, repo.before)).toBe(false);
    expect(await commitHasCeremony(processShell, repo.dir, repo.after)).toBe(true);
    expect(await commitHasCeremony(processShell, repo.dir, "c".repeat(40))).toBeUndefined();
    const failing = { run: async () => ({ code: 1, stdout: "", stderr: "offline" }) };
    const runtimeDir = await mkdtemp(join(tmpdir(), "indra-runtime-")); dirs.push(runtimeDir);
    expect(await mergedWithCeremony(failing, runtimeDir, "satoramoto/indra", repo.after)).toBeUndefined();
  });
  it("keeps a sprint released with the ceremony open in release, closes an older one, and reports one it cannot inspect", async () => {
    const repo = await project();
    const state = structuredClone(real);
    const released = goalOf(state, "goal-88dd199e"); released.integration = { ...released.integration!, status: "merged", mergedSha: repo.after };
    goalOf(state, "goal-df104a26").integration!.mergedSha = repo.before;
    state.planningGoals = state.planningGoals!.filter((goal) => goal.id !== "goal-855701cc");
    const persistence = await store(state);
    const results = await persistence.migrateLegacyGoals(migratedAt, (_goal, sha) => commitHasCeremony(processShell, repo.dir, sha));
    expect(results).toEqual([
      { goalId: "goal-ca9dd9ed", status: "conflict", reason: expect.stringContaining("could not be inspected") },
      { goalId: "goal-df104a26", status: "migrated", summary: "closed at release (legacy migration)" },
      { goalId: "goal-88dd199e", status: "migrated", summary: "entered release" },
    ]);
    const saved = await persistence.read();
    expect(goalOf(saved, "goal-ca9dd9ed")).toEqual(goalOf(state, "goal-ca9dd9ed"));
    expect(goalOf(saved, "goal-88dd199e").ceremony).toMatchObject({ stage: "release", migratedAt });
    expect(goalOf(saved, "goal-88dd199e").ceremony?.closure).toBeUndefined();
    expect(legacyMigrationBlocker(goalOf(saved, "goal-ca9dd9ed"))).toContain("merge commit could not be inspected");
    // The released sprint then records its running build and enters retro as usual.
    await persistence.update((doc) => {
      const goal = goalOf(doc, "goal-88dd199e");
      goal.ceremony = advanceCeremony(goal, { to: "retro", at: "2026-09-29T12:21:00.000Z", evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: repo.after, mergePostId: "merge-post",
        approval: { source: "owner-command", command: "planning merge", at: "2026-09-29T12:10:00.000Z" }, checksPassed: true, buildSha: repo.after, runningSha: repo.after, runningAt: "2026-09-29T12:20:00.000Z" } });
    }, "Verify running release");
    expect(goalOf(await persistence.read(), "goal-88dd199e").ceremony?.stage).toBe("retro");
  });
  it("does not accept a hand-written choice between the two paths", async () => {
    const state = structuredClone(real); state.planningGoals = [goalOf(state, "goal-ca9dd9ed")];
    const persistence = await store(state);
    const open = migrateLegacyCeremony(legacy("goal-ca9dd9ed"), migratedAt, true);
    if (open.status !== "ready") throw new Error(open.reason);
    await expect(persistence.update((doc) => { doc.planningGoals![0].ceremony = open.ceremony; }, "Hand-picked migration")).rejects.toThrow("Migration must preserve");
  });
});

describe("legacy evidence outside migration", () => {
  it.each(["implement", "release"] as const)("rejects a hand-written %s append that uses legacy evidence", async (stage) => {
    const item = legacy("goal-88dd199e");
    const integration = { branch: item.integration!.branch, baseSha: item.integration!.baseSha, status: "collecting" as const };
    const assignments = item.assignments!;
    if (stage === "implement") { item.stage = "awaiting-review"; delete item.assignments; delete item.integration; }
    else item.integration = integration;
    const persistence = await store({ ...structuredClone(real), planningGoals: [item] });
    await persistence.migrateLegacyGoals(migratedAt, preCeremony);
    const migrated = (await persistence.read()).planningGoals![0];
    expect(migrated.ceremony?.stage).toBe(stage === "implement" ? "proposal" : "implement");
    await expect(persistence.update((doc) => {
      const goal = doc.planningGoals![0];
      if (stage === "implement") {
        Object.assign(goal, { stage: "approved", assignments, integration });
        goal.ceremony!.history.push({ stage: "implement", enteredAt: null, evidence: { kind: "legacy-approval", proposalId: goal.proposal!.id } });
      } else {
        goal.ceremony!.history.push({ stage: "release", enteredAt: null, evidence: { kind: "legacy-implementation", outcomes: assignments.map((item) => ({ outcomeId: item.outcomeId, seatId: item.seatId, prUrl: item.prUrl! })) } });
      }
      goal.ceremony!.stage = stage;
    }, "Hand-written legacy append")).rejects.toThrow("Only legacy migration records legacy evidence");
    expect((await persistence.read()).planningGoals![0]).toEqual(migrated);
  });
});

describe("a dirty state checkout", () => {
  it("stops migration with one start-up error instead of a conflict per goal", async () => {
    const persistence = await store();
    await writeFile(join(persistence.checkout, "state.json"), `${JSON.stringify(real, null, 2)}\n`);
    await expect(persistence.migrateLegacyGoals(migratedAt, preCeremony)).rejects.toThrow("not committed");
    expect(commits(persistence)).toHaveLength(2);
  });
  it("refuses to retire the legacy draft sprints over uncommitted edits", async () => {
    const persistence = await store(withDraftSprint());
    const edited = `${JSON.stringify(withDraftSprint(), null, 2)}\n`;
    await writeFile(join(persistence.checkout, "state.json"), edited);
    await expect(persistence.retireLegacySprints()).rejects.toThrow("not committed");
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(edited);
    expect(commits(persistence)).toHaveLength(2);
  });
});

/** The real state as it still is: its one draft sprint from the original proof of concept, before planning goals. */
function withDraftSprint(): PlanningDocument {
  return { ...structuredClone(real), sprints: [{
    id: "sprint-001", teamId: "team-001", status: "draft", phase: "planning", goal: "Define and validate the first one-seat work cycle",
    proposedWork: [{ id: "work-001", title: "Define the cycle", description: "Describe one seat's work cycle from goal to merged PR." }],
    proposedAllocations: [{ seatId: "seat-002", workIds: ["work-001"] }],
  }] };
}

describe("retiring the legacy draft sprints", () => {
  it("empties the top-level sprints in one commit, keeping the key for older builds, valid against the v1 schema, and is idempotent", async () => {
    const legacyState = withDraftSprint();
    expect(validSchema(legacyState), JSON.stringify(validSchema.errors)).toBe(true);
    const persistence = await store(legacyState);
    expect(await persistence.retireLegacySprints()).toBe(true);
    const state = await persistence.read();
    expect(state.sprints).toEqual([]);
    expect(state).toEqual({ ...legacyState, sprints: [] });
    expect(validSchema(state), JSON.stringify(validSchema.errors)).toBe(true);
    expect(commits(persistence)).toEqual(["Retire legacy draft sprints", "Add schema", "Initial state"]);
    expect(git(persistence.checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe("state.json");

    const before = await readFile(join(persistence.checkout, "state.json"), "utf8");
    expect(await persistence.retireLegacySprints()).toBe(false);
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(before);
    expect(commits(persistence)).toHaveLength(3);
  });
  it.each([["already empty", real], ["without the key", (({ sprints: _sprints, ...rest }) => rest)(real)]])("changes nothing when sprints are %s", async (_label, state) => {
    const persistence = await store(state);
    const before = await readFile(join(persistence.checkout, "state.json"), "utf8");
    expect(await persistence.retireLegacySprints()).toBe(false);
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(before);
    expect(commits(persistence)).toHaveLength(2);
  });
  it("runs alongside the legacy goal migration, ending with the whole real state valid against the v1 schema", async () => {
    const persistence = await store(withDraftSprint());
    await persistence.migrateLegacyGoals(migratedAt, preCeremony);
    expect(await persistence.retireLegacySprints()).toBe(true);
    const state = await persistence.read();
    expect(state.sprints).toEqual([]);
    expect(state.planningGoals!.every((goal) => goal.ceremony)).toBe(true);
    expect(validSchema(state), JSON.stringify(validSchema.errors)).toBe(true);
    expect(commits(persistence)[0]).toBe("Retire legacy draft sprints");
  });
});
