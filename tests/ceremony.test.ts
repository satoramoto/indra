import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { advanceCeremony, CEREMONY_STAGES, closeCeremony, migrateLegacyCeremony, openGoalConflicts, startCeremony, validateCeremony, type ApprovalEvidence, type CeremonyStage, type CeremonyTransition, type ImplementationEvidence, type PublishedRetroEvidence, type RunningReleaseEvidence } from "../src/ceremony.js";
import type { CeremonyWriteReadiness } from "../src/ceremony-ports.js";
import { PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import { parseState } from "../src/local-state.js";
import { childEnv } from "../src/op-env.js";
import { git, stateCheckout } from "./state-checkout.js";

const at = (second: number) => `2026-09-01T00:00:${String(second).padStart(2, "0")}Z`;
const sha = (letter: string) => letter.repeat(40);
const ready: CeremonyWriteReadiness = { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } };
const plan: ApprovalEvidence = { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: at(2) } };
const implementation: ImplementationEvidence = { kind: "implementation", outcomes: [{ outcomeId: "outcome-one", seatId: "seat-two", prUrl: "https://github.com/owner/project/pull/1", baseBranch: "sprint/goal-one", mergedSha: sha("a"), checksPassed: true, reviewApproved: true }] };
const running: RunningReleaseEvidence = { kind: "release-running", prUrl: "https://github.com/owner/project/pull/2", mergedSha: sha("b"), mergePostId: "merge-post", approval: { source: "owner-command", command: "planning merge", at: at(5) }, checksPassed: true, buildSha: sha("b"), runningSha: sha("b"), runningAt: at(6) };
const descendant: RunningReleaseEvidence = { ...running, buildSha: sha("e"), runningSha: sha("e"), ancestry: { ancestorSha: running.mergedSha, descendantSha: sha("e"), verified: true } };
const retro: PublishedRetroEvidence = { kind: "retro-published", path: "docs/retros/goal-one.md", prUrl: "https://github.com/owner/project/pull/3", baseBranch: "main", mergedSha: sha("c"), postId: "retro-post", publishedAt: at(8), factsOnly: true, suggestions: "owner-proposals-only" };

function goal(id = "goal-one"): PlanningGoal {
  return { id, teamId: "team-one", seatId: "seat-one", participantSeatIds: ["seat-two"], goal: "Ship the goal", projectRefs: ["owner/project"], stage: "clarifying", createdAt: at(0), updatedAt: at(0), mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Ship it", decisions: [], openQuestions: [] } };
}
function document(goals: PlanningGoal[] = []): PlanningDocument {
  const seat = (id: string, role: string) => ({ id, displayName: id, roles: [role], externalIdentities: { mattermost: { userId: id, username: id } } });
  return { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: goals,
    teams: [{ id: "team-one", slug: "team-one", displayName: "Team", project: { github: "owner/project" }, externalIdentities: { mattermost: { teamId: "external-team", homeChannelId: "home" } }, seats: [seat("seat-one", "Team Lead"), seat("seat-two", "Developer")] }],
  };
}
function transition(to: CeremonyStage): CeremonyTransition {
  if (to === "proposal") return { to, at: at(1) };
  if (to === "implement") return { to, at: at(3), evidence: structuredClone(plan) };
  if (to === "release") return { to, at: at(4), evidence: structuredClone(implementation) };
  return { to: to as "retro", at: at(7), evidence: structuredClone(running) };
}
/** Supply actual goal-side facts separately from transition proof, so tests exercise their relationship. */
function prepare(item: PlanningGoal, to: CeremonyStage): void {
  if (to === "proposal") {
    item.stage = "awaiting-review";
    item.proposal = { id: "proposal-one", createdAt: at(1), summary: "A small change", outcomes: [{ id: "outcome-one", seatId: "seat-two", title: "Change", description: "Acceptance" }], risks: [], openQuestions: [] };
  } else if (to === "implement") {
    item.stage = "approved";
    item.assignments = [{ outcomeId: "outcome-one", seatId: "seat-two", status: "queued", updatedAt: at(3) }];
    item.integration = { branch: `sprint/${item.id}`, baseSha: sha("d"), status: "collecting" };
  } else if (to === "release") {
    Object.assign(item.assignments![0], { status: "merged", prUrl: implementation.outcomes[0].prUrl });
  } else if (to === "retro") {
    Object.assign(item.integration!, { status: "merged", prUrl: running.prUrl, mergedSha: running.mergedSha });
  }
}
function staged(stage: CeremonyStage): PlanningGoal {
  const item = goal(); item.ceremony = startCeremony(item.createdAt);
  for (const to of CEREMONY_STAGES.slice(1, CEREMONY_STAGES.indexOf(stage) + 1)) {
    prepare(item, to); item.ceremony = advanceCeremony(item, transition(to));
  }
  return item;
}
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function store(goals: PlanningGoal[] = [], enabled = true): Promise<PlanningStore> {
  const checkout = await stateCheckout("indra-ceremony-", document(goals)); dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile(resolve("schema/v1/state.schema.json"), join(checkout, "schema/v1/state.schema.json"));
  return new PlanningStore(checkout, undefined, enabled ? ready : undefined);
}

describe("ordered ceremony", () => {
  it("has exactly five stages, and closes only with a published retro after entering retro", () => {
    expect(CEREMONY_STAGES).toEqual(["planning", "proposal", "implement", "release", "retro"]);
    const item = staged("retro");
    expect(item.ceremony?.closure).toBeUndefined();
    item.ceremony = closeCeremony(item, at(9), retro);
    expect(item.ceremony.stage).toBe("retro");
    expect(item.ceremony.history.map((entry) => entry.stage)).toEqual(CEREMONY_STAGES);
    expect(item.ceremony.closure).toEqual({ closedAt: at(9), evidence: retro });
    expect(() => closeCeremony(item, at(10), retro)).toThrow();
    expect(() => advanceCeremony(item, transition("proposal"))).toThrow("closed");
  });
  it.each(CEREMONY_STAGES.flatMap((from, index) => CEREMONY_STAGES.map((to, next) => ({ from, to, allowed: next === index + 1 }))))("$from -> $to permits only the next stage ($allowed)", ({ from, to, allowed }) => {
    const item = staged(from); const previous = structuredClone(item.ceremony);
    if (allowed) prepare(item, to);
    if (allowed) expect(advanceCeremony(item, transition(to)).stage).toBe(to);
    else expect(() => advanceCeremony(item, transition(to))).toThrow();
    expect(item.ceremony).toEqual(previous);
  });
  it.each(CEREMONY_STAGES.slice(0, -1))("rejects closure during %s", (stage) => {
    expect(() => closeCeremony(staged(stage), at(9), retro)).toThrow();
  });
  it("rejects missing proof, unknown fields, fabricated history and clocks going backwards", () => {
    const item = staged("proposal"); prepare(item, "implement");
    expect(() => advanceCeremony(item, { to: "implement", at: at(3) } as CeremonyTransition)).toThrow();
    expect(() => advanceCeremony(item, { to: "implement", at: at(0), evidence: plan })).toThrow();
    const unknown = staged("planning"); unknown.ceremony!.history[0].enteredAt = null;
    expect(() => validateCeremony(unknown)).toThrow();
    (unknown.ceremony as unknown as Record<string, unknown>).sessionId = "local-only";
    expect(() => validateCeremony(unknown)).toThrow();
    expect(() => startCeremony("yesterday")).toThrow();
  });
  it("binds approval to the draft, proposed seats, sprint branch and a verified human gate", () => {
    const item = staged("proposal"); prepare(item, "implement");
    for (const evidence of [
      { ...plan, proposalId: "proposal-other" },
      { ...plan, approval: { source: "owner-command", command: "planning merge", at: at(2) } },
      { ...plan, approval: { source: "reaction", userId: "person", postId: "root", emoji: "white_check_mark", verifiedHuman: true, at: at(2) } },
      { ...plan, approval: { source: "reaction", userId: "person", postId: "proposal-post", emoji: "white_check_mark", verifiedHuman: false, at: at(2) } },
    ]) expect(() => advanceCeremony(item, { to: "implement", at: at(3), evidence } as CeremonyTransition)).toThrow();
    item.assignments![0].seatId = "seat-one";
    expect(() => advanceCeremony(item, transition("implement"))).toThrow("assignment");
    item.assignments![0].seatId = "seat-two"; item.integration!.branch = "main";
    expect(() => advanceCeremony(item, transition("implement"))).toThrow("sprint branch");
  });
  it("accepts a verified human reaction on the matching proposal and merge posts", () => {
    const item = staged("proposal"); prepare(item, "implement");
    const evidence: ApprovalEvidence = { ...plan, approval: { source: "reaction", userId: "person", postId: "proposal-post", emoji: "white_check_mark", verifiedHuman: true, at: at(2) } };
    item.ceremony = advanceCeremony(item, { to: "implement", at: at(3), evidence });
    prepare(item, "release"); item.ceremony = advanceCeremony(item, transition("release"));
    prepare(item, "retro");
    item.ceremony = advanceCeremony(item, { to: "retro", at: at(7), evidence: { ...running, approval: { source: "reaction", userId: "person", postId: "merge-post", emoji: "white_check_mark", verifiedHuman: true, at: at(5) } } });
    expect(() => parseState(document([item]))).not.toThrow();
  });
  it("requires every outcome to have a reviewed, green PR merged into this sprint", () => {
    const item = staged("implement");
    expect(() => advanceCeremony(item, transition("release"))).toThrow("every assigned PR");
    prepare(item, "release");
    for (const patch of [{ baseBranch: "main" }, { seatId: "seat-one" }, { outcomeId: "outcome-other" }, { prUrl: "https://github.com/owner/project/pull/9" }, { checksPassed: false }, { reviewApproved: false }, { mergedSha: "" }]) {
      const evidence = { ...implementation, outcomes: [{ ...implementation.outcomes[0], ...patch }] } as ImplementationEvidence;
      expect(() => advanceCeremony(item, { to: "release", at: at(4), evidence })).toThrow();
    }
    for (const outcomes of [[], [...implementation.outcomes, ...implementation.outcomes]]) {
      expect(() => advanceCeremony(item, { to: "release", at: at(4), evidence: { ...implementation, outcomes } })).toThrow();
    }
  });
  it("does not confuse a merge or successful build with a running release", () => {
    const item = staged("release");
    expect(() => advanceCeremony(item, transition("retro"))).toThrow("merged integration PR");
    prepare(item, "retro");
    for (const patch of [{ buildSha: sha("a") }, { runningSha: sha("a") }, { mergedSha: sha("a") }, { runningAt: at(3) }, { checksPassed: false }, { approval: plan.approval }]) {
      expect(() => advanceCeremony(item, { to: "retro", at: at(7), evidence: { ...running, ...patch } as RunningReleaseEvidence })).toThrow();
    }
    item.integration!.status = "reverted";
    expect(() => advanceCeremony(item, transition("retro"))).toThrow("not been reverted");
  });
  it("accepts a running descendant only with verified ancestry bound to the merged and running build commits", () => {
    const item = staged("release"); prepare(item, "retro");
    const advance = (evidence: RunningReleaseEvidence) => advanceCeremony(item, { to: "retro", at: at(7), evidence });
    expect(advance(descendant).stage).toBe("retro");
    for (const patch of [
      { ancestry: undefined },
      { ancestry: { ...descendant.ancestry, verified: false } },
      { ancestry: { ...descendant.ancestry, ancestorSha: sha("a") } },
      { ancestry: { ...descendant.ancestry, descendantSha: sha("a") } },
      { runningSha: sha("a") },
    ]) expect(() => advance({ ...descendant, ...patch } as RunningReleaseEvidence)).toThrow();
    expect(() => advance({ ...running, ancestry: descendant.ancestry })).toThrow();
    expect(item.ceremony?.stage).toBe("release");
  });
  it("requires the goal's retro document, merged PR, thread post and recorded facts", () => {
    const item = staged("retro");
    for (const patch of [{ path: "docs/retros/goal-other.md" }, { mergedSha: "" }, { postId: "" }, { prUrl: "" }, { factsOnly: false }, { suggestions: "apply-automatically" }, { publishedAt: at(0) }]) {
      expect(() => closeCeremony(item, at(9), { ...retro, ...patch } as PublishedRetroEvidence)).toThrow();
    }
  });
});

describe("ceremony persistence and team lock", () => {
  it("keeps writes off until every consumer is ready and the checkout schema accepts the contract", async () => {
    const disabled = await store([], false);
    await expect(disabled.createGoal(goal())).rejects.toThrow("disabled");
    const partial = new PlanningStore(disabled.checkout, undefined, { version: 1, consumers: { planning: 1 } } as CeremonyWriteReadiness);
    await expect(partial.createGoal(goal())).rejects.toThrow("disabled");
    const enabled = new PlanningStore(disabled.checkout, undefined, ready);
    const file = join(enabled.checkout, "schema/v1/state.schema.json");
    const schema = JSON.parse(await readFile(file, "utf8")); delete schema.$defs.planningGoal.properties.ceremony;
    await writeFile(file, JSON.stringify(schema));
    await expect(enabled.createGoal(goal())).rejects.toThrow("compatible schema");
    expect((await enabled.read()).planningGoals).toEqual([]);
    expect(git(enabled.checkout, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
  it("serializes concurrent creation across processes and leaves one unclosed goal", async () => {
    const persistence = await store();
    const script = `import { PlanningStore } from ${JSON.stringify(pathToFileURL(resolve("src/planning.ts")).href)};
      const [checkout, encodedGoal, readiness] = process.argv.slice(1);
      const store = new PlanningStore(checkout, undefined, JSON.parse(readiness));
      try { await store.createGoal(JSON.parse(encodedGoal)); process.stdout.write('created'); }
      catch (error) { if (!error.message.includes('unclosed goals')) throw error; process.stdout.write('blocked'); }`;
    const child = (index: number) => new Promise<string>((done, fail) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, persistence.checkout, JSON.stringify(goal(`goal-${index}`)), JSON.stringify(ready)], { env: childEnv() }, (error, stdout) => error ? fail(error) : done(stdout));
    });
    const results = await Promise.all([0, 1, 2, 3].map(child));
    expect(results.filter((result) => result === "created")).toHaveLength(1);
    expect(results.filter((result) => result === "blocked")).toHaveLength(3);
    expect((await persistence.read()).planningGoals).toHaveLength(1);
    expect(git(persistence.checkout, "rev-list", "--count", "HEAD").trim()).toBe("2");
  }, 30_000);
  it("also guards generic creation and keeps the lock through release and retro until closure", async () => {
    const persistence = await store([staged("retro")]);
    await expect(persistence.update((doc) => { doc.planningGoals!.push(goal("goal-two")); }, "Bypass creation")).rejects.toThrow("unclosed");
    await persistence.update((doc) => { const item = doc.planningGoals![0]; item.ceremony = closeCeremony(item, at(9), retro); }, "Close after retro");
    await persistence.createGoal(goal("goal-two"));
    expect((await persistence.read()).planningGoals?.map((item) => [item.id, item.ceremony?.stage, !!item.ceremony?.closure])).toEqual([["goal-one", "retro", true], ["goal-two", "planning", false]]);
    expect(git(persistence.checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe("state.json");
  });
  it("does not let the team lock block an unrelated team", async () => {
    const persistence = await store([staged("planning")]);
    await persistence.update((doc) => { const other = structuredClone(doc.teams[0]) as { id: string; slug: string }; other.id = "team-two"; other.slug = "team-two"; doc.teams.push(other); }, "Add another team");
    await persistence.createGoal({ ...goal("goal-two"), teamId: "team-two" });
    expect((await persistence.read()).planningGoals).toHaveLength(2);
  });
  it("persists a verified running descendant and releases the team lock after its retro closes", async () => {
    const persistence = await store([staged("release")]);
    await persistence.update((doc) => {
      const item = doc.planningGoals![0]; prepare(item, "retro");
      item.ceremony = advanceCeremony(item, { to: "retro", at: at(7), evidence: descendant });
    }, "Record the running descendant");
    expect((await persistence.read()).planningGoals![0].ceremony?.history.at(-1)).toMatchObject({ stage: "retro", evidence: descendant });
    await expect(persistence.createGoal(goal("goal-two"))).rejects.toThrow("unclosed");
    await persistence.update((doc) => { const item = doc.planningGoals![0]; item.ceremony = closeCeremony(item, at(9), retro); }, "Close after retro");
    await persistence.createGoal(goal("goal-two"));
    expect(await persistence.teamConflicts()).toEqual([]);
  });
  it("cannot bypass order, rewrite evidence, remove history, delete goals or reopen through a mutator", async () => {
    const persistence = await store([staged("implement")]);
    const before = await readFile(join(persistence.checkout, "state.json"), "utf8");
    const mutations: ((item: PlanningGoal) => void)[] = [
      (item) => { delete item.ceremony; },
      (item) => { item.ceremony = staged("retro").ceremony; Object.assign(item, { assignments: staged("retro").assignments, integration: staged("retro").integration }); },
      (item) => { item.ceremony!.history[0].enteredAt = at(1); },
      (item) => { item.ceremony!.stage = "planning"; item.ceremony!.history = [item.ceremony!.history[0]]; },
      (item) => { item.teamId = "team-two"; },
      (item) => { item.proposal!.summary = "Changed after approval"; },
    ];
    for (const mutate of mutations) await expect(persistence.update((doc) => mutate(doc.planningGoals![0]), "Invalid mutation")).rejects.toThrow();
    await expect(persistence.update((doc) => { doc.planningGoals = []; }, "Delete goal")).rejects.toThrow();
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(before);
    const closed = staged("retro"); closed.ceremony = closeCeremony(closed, at(9), retro);
    const closedStore = await store([closed]);
    await expect(closedStore.update((doc) => { delete doc.planningGoals![0].ceremony!.closure; }, "Reopen")).rejects.toThrow("immutable");
  });
  it("persists the next stage and its proof atomically and prevents an unready writer from changing it", async () => {
    const persistence = await store([staged("proposal")]);
    await persistence.update((doc) => { const item = doc.planningGoals![0]; prepare(item, "implement"); item.ceremony = advanceCeremony(item, transition("implement")); }, "Approve ceremony");
    expect((await persistence.read()).planningGoals![0].ceremony?.stage).toBe("implement");
    const unready = new PlanningStore(persistence.checkout);
    await expect(unready.update((doc) => { doc.planningGoals![0].assignments![0].status = "running"; }, "Old writer")).rejects.toThrow("disabled");
    expect((await persistence.read()).planningGoals![0].assignments![0].status).toBe("queued");
  });
  it("retains historical release proof and closure when a later rollback is recorded", async () => {
    const item = staged("retro"); item.ceremony = closeCeremony(item, at(9), retro);
    const persistence = await store([item]);
    await persistence.update((doc) => {
      Object.assign(doc.planningGoals![0].integration!, { status: "reverted", revertPrUrl: "https://github.com/owner/project/pull/4" });
    }, "Record an owner-approved rollback");
    expect((await persistence.read()).planningGoals![0].ceremony).toEqual(item.ceremony);
    await persistence.createGoal(goal("goal-two"));
  });
  it("rolls back a failed commit and recovers a persisted stage exactly once after a crash", async () => {
    const persistence = await store([staged("planning")]);
    const hook = join(persistence.checkout, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const promote = (doc: PlanningDocument) => { const item = doc.planningGoals![0]; prepare(item, "proposal"); item.ceremony = advanceCeremony(item, transition("proposal")); };
    await expect(persistence.update(promote, "Enter proposal")).rejects.toThrow("rolled back");
    expect((await persistence.read()).planningGoals![0].ceremony?.stage).toBe("planning");
    await rm(hook);
    const state = await persistence.read(); promote(state);
    const written = JSON.stringify(state, null, 2) + "\n";
    await persistence.saveRuntime("state-commit", { sha256: createHash("sha256").update(written).digest("hex"), message: "Recover proposal" });
    await writeFile(join(persistence.checkout, "state.json"), written);
    await persistence.update(() => {}, "Nothing");
    await persistence.update(() => {}, "Nothing again");
    expect((await persistence.read()).planningGoals![0].ceremony?.history.map((entry) => entry.stage)).toEqual(["planning", "proposal"]);
    expect(git(persistence.checkout, "log", "--format=%s").trim().split("\n")).toEqual(["Recover proposal", "Initial state"]);
    await expect(readFile(join(persistence.runtimeDir, "state-commit.json"))).rejects.toThrow();
  });
  it("does not recover malformed ceremony state just because a commit intent matches its bytes", async () => {
    const persistence = await store([staged("planning")]);
    const state = await persistence.read(); state.planningGoals![0].ceremony!.stage = "release";
    const written = JSON.stringify(state);
    await persistence.saveRuntime("state-commit", { sha256: createHash("sha256").update(written).digest("hex"), message: "Invalid recovery" });
    await writeFile(join(persistence.checkout, "state.json"), written);
    await expect(persistence.update(() => {}, "Nothing")).rejects.toThrow();
    expect(git(persistence.checkout, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(written);
  });
});

describe("legacy migration", () => {
  it("requires migration before an activated writer changes a legacy workflow", async () => {
    const item = staged("proposal"); delete item.ceremony;
    const persistence = await store([item]);
    const before = await readFile(join(persistence.checkout, "state.json"), "utf8");
    await expect(persistence.update((doc) => prepare(doc.planningGoals![0], "implement"), "Approve without evidence")).rejects.toThrow("migration");
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(before);
    expect(git(persistence.checkout, "rev-list", "--count", "HEAD").trim()).toBe("1");
    await persistence.migrateLegacyGoals(at(2));
    await persistence.update((doc) => {
      const goal = doc.planningGoals![0]; prepare(goal, "implement");
      goal.ceremony = advanceCeremony(goal, transition("implement"));
    }, "Approve with evidence after migration");
    expect((await persistence.read()).planningGoals![0].ceremony?.history.at(-1)).toMatchObject({ stage: "implement", evidence: plan });
  });
  it("guards legacy drafting, proposal, assignment and integration changes after activation", async () => {
    for (const [stage, mutate] of [
      ["planning", (item) => { item.stage = "drafting"; }],
      ["proposal", (item) => { item.proposal!.summary = "Another proposal"; }],
      ["implement", (item) => { item.assignments![0].status = "running"; }],
      ["release", (item) => prepare(item, "retro")],
    ] satisfies [CeremonyStage, (item: PlanningGoal) => void][]) {
      const item = staged(stage); delete item.ceremony;
      const persistence = await store([item]);
      await expect(persistence.update((doc) => mutate(doc.planningGoals![0]), "Advance legacy workflow")).rejects.toThrow("migration");
      expect((await persistence.read()).planningGoals![0]).toEqual(item);
    }
  });
  it("leaves legacy behavior available before rollout and guards old writers in mixed documents", async () => {
    const item = staged("proposal"); delete item.ceremony;
    const disabled = await store([item], false);
    await disabled.update((doc) => prepare(doc.planningGoals![0], "implement"), "Legacy approval");
    expect((await disabled.read()).planningGoals![0].stage).toBe("approved");
    const mixed = await store([item, { ...staged("planning"), id: "goal-two" }], false);
    await expect(mixed.update((doc) => prepare(doc.planningGoals![0], "implement"), "Old writer approval")).rejects.toThrow("migration");
    await mixed.update((doc) => { doc.planningGoals![0].brief.decisions.push("Keep a historical note"); }, "Annotate legacy goal");
    expect((await mixed.read()).planningGoals![0].brief.decisions).toEqual(["Keep a historical note"]);
  });
  it.each(["proposal", "implement", "release", "retro"] as const)("cannot erase known %s facts while attaching migration provenance", async (stage) => {
    const item = staged(stage); delete item.ceremony;
    const persistence = await store([item]);
    const before = await readFile(join(persistence.checkout, "state.json"), "utf8");
    await expect(persistence.update((doc) => {
      const target = doc.planningGoals![0]; target.stage = "clarifying";
      delete target.proposal; delete target.assignments; delete target.integration;
      target.ceremony = { ...startCeremony(target.createdAt), migratedAt: at(10) };
    }, "Erase known history")).rejects.toThrow("migration");
    expect(await readFile(join(persistence.checkout, "state.json"), "utf8")).toBe(before);
    expect(git(persistence.checkout, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
  it("validates a migration against the original record and keeps unknown times unknown", async () => {
    const item = staged("retro"); delete item.ceremony;
    const persistence = await store([item]);
    const result = migrateLegacyCeremony(item, at(10));
    if (result.status !== "ready") throw new Error("Expected migration");
    for (const mutate of [
      (goal: PlanningGoal) => { goal.proposal!.summary = "Replace the approved plan"; },
      (goal: PlanningGoal) => { goal.assignments![0].status = "queued"; },
      (goal: PlanningGoal) => { goal.integration!.status = "collecting"; },
      (goal: PlanningGoal) => { goal.ceremony!.history[1].enteredAt = at(1); },
    ]) {
      await expect(persistence.update((doc) => {
        doc.planningGoals![0].ceremony = structuredClone(result.ceremony); mutate(doc.planningGoals![0]);
      }, "Rewrite legacy history")).rejects.toThrow();
    }
    expect((await persistence.read()).planningGoals![0]).toEqual(item);
    await persistence.migrateLegacyGoals(at(10));
    expect((await persistence.read()).planningGoals![0]).toEqual({ ...item, ceremony: result.ceremony });
  });
  it("closes an approved, merged legacy goal at release without claiming a human approval, running build or retro", () => {
    const item = staged("retro"); delete item.ceremony;
    const before = structuredClone(item);
    const migrated = migrateLegacyCeremony(item, at(10));
    if (migrated.status !== "ready") throw new Error("Expected migration");
    expect(migrated.ceremony.stage).toBe("release");
    expect(migrated.ceremony.history.map((entry) => entry.stage === "implement" || entry.stage === "release" ? entry.evidence.kind : entry.stage)).toEqual(["planning", "proposal", "legacy-approval", "legacy-implementation"]);
    expect(migrated.ceremony.closure).toEqual({ closedAt: at(10), evidence: { kind: "legacy-migration", integration: "merged", prUrl: running.prUrl, mergedSha: running.mergedSha } });
    expect(item).toEqual(before);
  });
  it("migrates legacy planning/proposal facts without inventing historical entry times", () => {
    for (const stage of ["planning", "proposal"] as const) {
      const item = staged(stage); delete item.ceremony;
      const migrated = migrateLegacyCeremony(item, at(10));
      expect(migrated.status).toBe("ready");
      if (migrated.status !== "ready") throw new Error("Expected migration");
      expect(migrated.ceremony.stage).toBe(stage);
      expect(migrated.ceremony.history[0].enteredAt).toBe(item.createdAt);
      if (stage === "proposal") expect(migrated.ceremony.history[1].enteredAt).toBeNull();
      expect(migrated.ceremony.closure).toBeUndefined();
    }
  });
  it("allows later transitions after migration while keeping old times unknown", () => {
    const item = staged("proposal"); delete item.ceremony;
    const result = migrateLegacyCeremony(item, at(2));
    if (result.status !== "ready") throw new Error("Expected migration");
    item.ceremony = result.ceremony; prepare(item, "implement");
    item.ceremony = advanceCeremony(item, transition("implement"));
    expect(item.ceremony.history[1].enteredAt).toBeNull();
    expect(item.ceremony.history[2].enteredAt).toBe(at(3));
  });
  it("resolves open-goal conflicts only as far as the evidence proves, and blocks creation until then", async () => {
    const first = staged("retro"); delete first.ceremony;
    const second = goal("goal-two");
    const persistence = await store([first, second]);
    expect(await persistence.teamConflicts()).toEqual([{ teamId: "team-one", goalIds: ["goal-one", "goal-two"] }]);
    await expect(persistence.createGoal(goal("goal-three"))).rejects.toThrow("goal-one, goal-two");
    await persistence.migrateLegacyGoals(at(10));
    expect(git(persistence.checkout, "rev-list", "--count", "HEAD").trim()).toBe("3");
    expect(openGoalConflicts((await persistence.read()).planningGoals!)).toEqual([]);
    expect((await persistence.read()).planningGoals?.map((item) => [item.id, item.ceremony?.stage, !!item.ceremony?.closure])).toEqual([["goal-one", "release", true], ["goal-two", "planning", false]]);
    await expect(persistence.createGoal(goal("goal-three"))).rejects.toThrow("unclosed goals: goal-two.");
  });
});
