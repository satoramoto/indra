import { describe, expect, it } from "vitest";
import {
  assertDisjointOwnedFiles, assertOwnedFilesWithin, goalRuntimeFilename, ownedFileMatches, ownedFilesOverlap,
  projectGoalRuntime, teamRuntimeFilename, validateGoalBrief, validateGoalReport, validateLanePlan,
  validateOwnedFiles, validateProductProposal,
  type DeveloperTurnService, type GoalBrief, type GoalReport, type GoalRuntimeRecord, type LanePlan, type ProductProposal,
} from "../src/goal-contract.js";

const at = "2026-09-29T12:00:00.000Z";
const sourceSha = "a".repeat(40);
const mergeSha = "b".repeat(40);

function brief(): GoalBrief {
  return {
    version: 1, goalId: "goal-example", teamId: "team-one", seatId: "seat-developer",
    header: { repo: "owner/project", baseBranch: "origin/main", baseSha: sourceSha, branch: "sprint/goal-example", prTarget: "main" },
    outcomes: [{ number: 1, title: "Schedule disjoint goals", description: "Dispatch each approved goal once.", reason: "Keep idle Developers supplied with work.", currentCode: ["src/planning.ts:40"] }],
    ownedFiles: ["src/planning.ts", "tests/planning.test.ts"],
    exclusions: [{ files: ["src/product-*.ts"], owner: "Product lane", reason: "The Product lane owns proposal generation." }],
    swarm: "Give independent files to individual workers.", retros: [], redirects: [],
    reportFormat: "PR URLs, head SHA, commands and exit codes, Decisions, Follow-ups, needed but unowned files.",
  };
}

function report(): GoalReport {
  return {
    version: 1, goalId: "goal-example", teamId: "team-one", seatId: "seat-developer",
    sprintBranch: "sprint/goal-example", headSha: mergeSha,
    lanePrs: [{ laneId: "scheduler", url: "https://github.com/owner/project/pull/12", headSha: sourceSha, mergedSha: mergeSha, reviewer: "satori-miyamoto", ci: "passed" }],
    checks: [{ command: "npm run typecheck", exitCode: 0 }],
    decisions: ["Scopes are disjoint."], followUps: ["Measure queue latency."], neededButUnowned: [],
  };
}

function plan(): LanePlan {
  return {
    version: 1, goalId: "goal-example", contractLaneId: "contract",
    lanes: [
      { id: "contract", branch: "codex/goal-example-contract", ownedFiles: ["src/contracts.ts"], dependsOn: [] },
      { id: "developer", branch: "codex/goal-example-developer", ownedFiles: ["src/developer.ts"], dependsOn: ["contract"] },
      { id: "scheduler", branch: "codex/goal-example-scheduler", ownedFiles: ["src/scheduler.ts"], dependsOn: ["contract"] },
    ],
  };
}

function proposal(): ProductProposal {
  return {
    version: 1, goalId: "goal-example", proposalId: "proposal-example", productSeatId: "seat-product", rank: 1,
    mission: "Continuously improve Indra with one approval per goal.", summary: "Keep Developers busy with disjoint work.",
    outcomes: brief().outcomes, ownedFiles: ["src/planning.ts", "tests/planning.test.ts"], risks: [],
    rationale: "The last retrospective identified idle seats.", basedOnRetros: ["goal-earlier"],
  };
}

describe("standard goal and lane briefs", () => {
  it("accepts the goal sprint and a lane with its own branch targeting that sprint", () => {
    const goal = brief();
    expect(validateGoalBrief(goal)).toEqual(goal);
    const lane = brief();
    lane.header = { ...lane.header, baseBranch: "origin/sprint/goal-example", branch: "codex/goal-example-scheduler", prTarget: "sprint/goal-example" };
    expect(validateGoalBrief(lane)).toEqual(lane);
  });

  it.each([
    ["wrong sprint identity", (value: GoalBrief) => { value.goalId = "goal-different"; }],
    ["lane targeting main", (value: GoalBrief) => { value.header.branch = "codex/goal-example-lane"; }],
    ["lane based on another sprint", (value: GoalBrief) => { Object.assign(value.header, { baseBranch: "sprint/goal-different", branch: "codex/lane", prTarget: "sprint/goal-example" }); }],
    ["lane editing the sprint branch", (value: GoalBrief) => { Object.assign(value.header, { baseBranch: "sprint/goal-example", prTarget: "sprint/goal-example" }); }],
    ["main as a lane branch", (value: GoalBrief) => { Object.assign(value.header, { baseBranch: "sprint/goal-example", branch: "main", prTarget: "sprint/goal-example" }); }],
    ["invalid team ID", (value: GoalBrief) => { value.teamId = "Team One"; }],
    ["invalid seat ID", (value: GoalBrief) => { value.seatId = "seat/other"; }],
    ["abbreviated base SHA", (value: GoalBrief) => { value.header.baseSha = "abc1234"; }],
    ["empty outcomes", (value: GoalBrief) => { value.outcomes = []; }],
    ["unnumbered outcomes", (value: GoalBrief) => { value.outcomes[0].number = 2; }],
    ["empty ownership", (value: GoalBrief) => { value.ownedFiles = []; }],
    ["contradictory exclusion", (value: GoalBrief) => { value.exclusions[0].files = ["src/**"]; }],
  ] satisfies [string, (value: GoalBrief) => void][])("rejects %s", (_name, mutate) => {
    const value = brief(); mutate(value);
    expect(() => validateGoalBrief(value)).toThrow();
  });

  it.each(["-unsafe", "branch..name", "branch.lock", "bad branch", "bad\\branch", "refs/heads/.hidden"])("rejects unsafe branch %s", (unsafe) => {
    const value = brief(); value.header.baseBranch = unsafe;
    expect(() => validateGoalBrief(value)).toThrow();
  });

  it("validates exact fields at every nested boundary instead of accepting runtime extras", () => {
    for (const target of ["root", "header", "outcome", "exclusion"] as const) {
      const value = brief();
      const row = target === "root" ? value : target === "header" ? value.header : target === "outcome" ? value.outcomes[0] : value.exclusions[0];
      Object.assign(row, { sessionId: "private-session" });
      expect(() => validateGoalBrief(value)).toThrow();
    }
    const missing = brief(); Reflect.deleteProperty(missing, "reportFormat");
    expect(() => validateGoalBrief(missing)).toThrow();
    const wrongType = brief(); Object.assign(wrongType.outcomes[0], { currentCode: "src/planning.ts" });
    expect(() => validateGoalBrief(wrongType)).toThrow();
    expect(() => validateGoalBrief({ ...brief(), version: 2 })).toThrow();
    expect(() => validateGoalBrief(null)).toThrow();
  });

  it("keeps at most three distinct matching retrospective documents and verified-shape redirects", () => {
    const value = brief();
    value.retros = ["one", "two", "three"].map((id) => ({ goalId: `goal-${id}`, path: `docs/retros/goal-${id}.md`, summary: `Learning ${id}` }));
    value.redirects = [{ postId: "redirect-post", userId: "human-user", at, message: "Prioritize the scheduler." }];
    expect(validateGoalBrief(value).retros).toHaveLength(3);
    const tooMany = structuredClone(value); tooMany.retros.push({ goalId: "goal-four", path: "docs/retros/goal-four.md", summary: "Fourth" });
    expect(() => validateGoalBrief(tooMany)).toThrow();
    const wrongPath = structuredClone(value); wrongPath.retros[0].path = "docs/retros/goal-other.md";
    expect(() => validateGoalBrief(wrongPath)).toThrow();
    const repeated = structuredClone(value); repeated.retros[1] = { ...repeated.retros[0] };
    expect(() => validateGoalBrief(repeated)).toThrow();
    const wrongTime = structuredClone(value); wrongTime.redirects[0].at = "sometime yesterday";
    expect(() => validateGoalBrief(wrongTime)).toThrow();
    const runtimeRedirect = structuredClone(value); Object.assign(runtimeRedirect.redirects[0], { sessionId: "private" });
    expect(() => validateGoalBrief(runtimeRedirect)).toThrow();
  });
});

describe("goal reports", () => {
  it.each(["independent-agent", "satori-miyamoto"] as const)("preserves the observed %s reviewer without relabeling history", (reviewer) => {
    const value = report(); value.lanePrs[0].reviewer = reviewer;
    expect(validateGoalReport(value)).toEqual(value);
    expect(validateGoalReport(value).lanePrs[0].reviewer).toBe(reviewer);
  });

  it("preserves failed check exit codes rather than converting them to success", () => {
    const value = report(); value.checks.push({ command: "npx vitest run tests/planning.test.ts", exitCode: 17 });
    expect(validateGoalReport(value)).toEqual(value);
    expect(validateGoalReport(value).checks[1].exitCode).toBe(17);
  });

  it.each([
    ["another sprint", (value: GoalReport) => { value.sprintBranch = "sprint/goal-other"; }],
    ["main", (value: GoalReport) => { value.sprintBranch = "main"; }],
    ["malformed goal ID", (value: GoalReport) => { value.goalId = "goal/other"; }],
    ["malformed team ID", (value: GoalReport) => { value.teamId = "TEAM"; }],
    ["malformed seat ID", (value: GoalReport) => { value.seatId = "../seat"; }],
    ["short sprint head", (value: GoalReport) => { value.headSha = "abcd"; }],
    ["missing merged commit", (value: GoalReport) => { value.lanePrs[0].mergedSha = ""; }],
    ["wrong reviewer", (value: GoalReport) => { Object.assign(value.lanePrs[0], { reviewer: "another-bot" }); }],
    ["unconfirmed CI", (value: GoalReport) => { Object.assign(value.lanePrs[0], { ci: "pending" }); }],
    ["claimed approval flag", (value: GoalReport) => { Object.assign(value.lanePrs[0], { approved: true }); }],
    ["issue instead of PR", (value: GoalReport) => { value.lanePrs[0].url = "https://github.com/owner/project/issues/12"; }],
    ["fractional exit code", (value: GoalReport) => { value.checks[0].exitCode = 0.5; }],
    ["empty lane reports", (value: GoalReport) => { value.lanePrs = []; }],
    ["unsafe unowned file", (value: GoalReport) => { value.neededButUnowned = ["../outside.ts"]; }],
  ] satisfies [string, (value: GoalReport) => void][])("rejects %s", (_name, mutate) => {
    const value = report(); mutate(value);
    expect(() => validateGoalReport(value)).toThrow();
  });

  it("rejects unknown fields, missing required fields and incorrectly typed evidence", () => {
    expect(() => validateGoalReport({ ...report(), usage: {} })).toThrow();
    const value = report(); Object.assign(value.checks[0], { exitCode: "0" });
    expect(() => validateGoalReport(value)).toThrow();
    const extra = report(); Object.assign(extra.checks[0], { approved: true });
    expect(() => validateGoalReport(extra)).toThrow();
    const missing = report(); Reflect.deleteProperty(missing.lanePrs[0], "reviewer");
    expect(() => validateGoalReport(missing)).toThrow();
    expect(() => validateGoalReport({ ...report(), decisions: [null] })).toThrow();
    expect(() => validateGoalReport({ ...report(), version: "1" })).toThrow();
  });

  it("does not combine PR evidence from different repositories or count a PR twice", () => {
    const different = report();
    different.lanePrs.push({ ...different.lanePrs[0], laneId: "other-lane", url: "https://github.com/another/project/pull/13" });
    expect(() => validateGoalReport(different)).toThrow();
    const repeated = report(); repeated.lanePrs.push({ ...repeated.lanePrs[0], laneId: "other-lane" });
    expect(() => validateGoalReport(repeated)).toThrow();
  });
});

describe("Product proposal provenance and scope", () => {
  it("preserves the Product identity, ranking, mission and retrospective basis", () => {
    const value = proposal();
    expect(validateProductProposal(value)).toEqual(value);
    expect(validateProductProposal(value)).toMatchObject({ productSeatId: "seat-product", proposalId: "proposal-example", rank: 1, basedOnRetros: ["goal-earlier"] });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])("rejects invalid rank %s", (rank) => {
    expect(() => validateProductProposal({ ...proposal(), rank })).toThrow();
  });

  it("requires exact, typed provenance and nonempty ownership", () => {
    for (const patch of [
      { productSeatId: "Product Seat" }, { proposalId: "../proposal" }, { goalId: "Goal" }, { mission: " " },
      { ownedFiles: [] }, { ownedFiles: "src/**" }, { risks: [false] }, { basedOnRetros: ["goal-earlier", "goal-earlier"] },
      { approved: true }, { version: 2 },
    ]) expect(() => validateProductProposal({ ...proposal(), ...patch })).toThrow();
    const missing = proposal(); Reflect.deleteProperty(missing, "productSeatId");
    expect(() => validateProductProposal(missing)).toThrow();
    const nested = proposal(); Object.assign(nested.outcomes[0], { assignedSeatId: "seat-other" });
    expect(() => validateProductProposal(nested)).toThrow();
  });
});

describe("file boundaries include future repository paths", () => {
  it.each([
    ["src/file.ts", "src/file.ts", true], ["src/file.ts", "src/files.ts", false],
    ["src/*.ts", "src/new.ts", true], ["src/*.ts", "src/new/file.ts", false],
    ["src/?.ts", "src/a.ts", true], ["src/?.ts", "src/ab.ts", false], ["src/?.ts", "src/.ts", false],
    ["src/**/file.ts", "src/file.ts", true], ["src/**/file.ts", "src/future/deep/file.ts", true],
    ["**/file.ts", "file.ts", true], ["**/file.ts", "test/file.ts", true],
    ["src/**", "src/future/deep/file.ts", true], ["src/**", "tests/file.ts", false],
    ["src/*.ts", "src/.hidden.ts", true],
  ])("matches %s against %s as %s", (pattern, file, expected) => {
    expect(ownedFileMatches(pattern as string, file as string)).toBe(expected);
  });

  it("finds intersections without reading whether the common filename exists yet", () => {
    expect(ownedFilesOverlap(["src/**"], ["src/not-created/deep/file.ts"])).toBe(true);
    expect(ownedFilesOverlap(["src/**/*.ts"], ["src/new/?.ts"])).toBe(true);
    expect(ownedFilesOverlap(["src/a*.ts"], ["src/*z.ts"])).toBe(true);
    expect(ownedFilesOverlap(["src/**"], ["tests/**"])).toBe(false);
    expect(ownedFilesOverlap(["src/*.ts"], ["src/deep/*.ts"])).toBe(false);
    expect(ownedFilesOverlap(["src/?.ts"], ["src/ab.ts"])).toBe(false);
  });

  it("proves containment against the union of approved patterns", () => {
    expect(() => assertOwnedFilesWithin(["src/new.ts", "src/deep/**"], ["src/**"])).not.toThrow();
    expect(() => assertOwnedFilesWithin(["src/new.ts", "tests/new.test.ts"], ["src/**", "tests/**"])).not.toThrow();
    // A one-character filename or a filename of two-or-more characters exhausts src/*.
    // Neither approved pattern alone contains the child scope.
    expect(() => assertOwnedFilesWithin(["src/*"], ["src/?", "src/??*"])).not.toThrow();
    expect(() => assertOwnedFilesWithin(["src/**"], ["src", "src/*/**"])).not.toThrow();
    expect(() => assertOwnedFilesWithin(["src/**"], ["src/*.ts"])).toThrow();
    expect(() => assertOwnedFilesWithin(["src/*"], ["src/?"])).toThrow();
    expect(() => assertOwnedFilesWithin(["src/?.ts"], ["src/a.ts", "src/b.ts"])).toThrow();
    expect(() => assertOwnedFilesWithin(["tests/new.test.ts"], ["src/**"])).toThrow();
  });

  it.each([
    "/src/file.ts", "../outside.ts", "src/../outside.ts", "src/./file.ts", "src//file.ts", "src/file.ts/",
    "src\\file.ts", "C:/outside.ts", "src/[ab].ts", "src/{a,b}.ts", "!src/file.ts", "src/**file.ts", "src/***.ts", " ",
  ])("rejects unsafe or unsupported pattern %s", (pattern) => {
    expect(() => validateOwnedFiles([pattern])).toThrow();
    expect(() => ownedFilesOverlap([pattern], ["src/**"])).toThrow();
  });

  it("requires nonempty, unique pattern lists and literal safe files", () => {
    for (const value of [[], null, "src/**", [false], ["src/**", "src/**"], ["src/**", "src/**/**"]]) {
      expect(() => validateOwnedFiles(value)).toThrow();
    }
    expect(() => ownedFileMatches("**", "../outside.ts")).toThrow();
    expect(() => ownedFileMatches("**", "src/*.ts")).toThrow();
    expect(validateOwnedFiles(["src/**", "tests/**/*.test.ts"])).toEqual(["src/**", "tests/**/*.test.ts"]);
  });

  it("rejects pairwise overlap for named owners and plain scope arrays", () => {
    expect(() => assertDisjointOwnedFiles([{ id: "one", ownedFiles: ["src/**"] }, { id: "two", ownedFiles: ["tests/**"] }])).not.toThrow();
    expect(() => assertDisjointOwnedFiles([["src/*.ts"], ["tests/*.ts"]])).not.toThrow();
    expect(() => assertDisjointOwnedFiles([{ id: "one", ownedFiles: ["src/**/*.ts"] }, { id: "two", ownedFiles: ["src/future.ts"] }])).toThrow();
    expect(() => assertDisjointOwnedFiles([["src/**"], ["src/new/**"]])).toThrow();
  });
});

describe("lane plans", () => {
  it("accepts disjoint lanes after a contract, transitive dependencies, or independent lanes without a contract", () => {
    expect(validateLanePlan(plan())).toEqual(plan());
    const transitive = plan(); transitive.lanes[2].dependsOn = ["developer"];
    expect(validateLanePlan(transitive)).toEqual(transitive);
    const independent = plan(); independent.contractLaneId = null;
    for (const lane of independent.lanes) lane.dependsOn = [];
    expect(validateLanePlan(independent)).toEqual(independent);
  });

  it.each([
    ["unknown dependency", (value: LanePlan) => { value.lanes[1].dependsOn = ["absent"]; }],
    ["self dependency", (value: LanePlan) => { value.lanes[1].dependsOn = ["developer"]; }],
    ["dependency cycle", (value: LanePlan) => { value.contractLaneId = null; value.lanes[0].dependsOn = ["developer"]; }],
    ["missing contract", (value: LanePlan) => { value.contractLaneId = "absent"; }],
    ["contract with prerequisites", (value: LanePlan) => { value.lanes[0].dependsOn = ["developer"]; value.lanes[1].dependsOn = []; }],
    ["lane skipping contract", (value: LanePlan) => { value.lanes[2].dependsOn = []; }],
    ["overlap despite sequencing", (value: LanePlan) => { value.lanes[0].ownedFiles = ["src/**"]; }],
    ["duplicate lane ID", (value: LanePlan) => { value.lanes[2].id = "developer"; }],
    ["duplicate branch", (value: LanePlan) => { value.lanes[2].branch = value.lanes[1].branch; }],
    ["main branch", (value: LanePlan) => { value.lanes[1].branch = "main"; }],
    ["another goal's sprint branch", (value: LanePlan) => { value.lanes[1].branch = "sprint/goal-other"; }],
    ["empty ownership", (value: LanePlan) => { value.lanes[1].ownedFiles = []; }],
  ] satisfies [string, (value: LanePlan) => void][])("rejects %s", (_name, mutate) => {
    const value = plan(); mutate(value);
    expect(() => validateLanePlan(value)).toThrow();
  });

  it("rejects unknown fields, missing nullable declaration and malformed nested types", () => {
    expect(() => validateLanePlan({ ...plan(), sessionId: "private" })).toThrow();
    const extra = plan(); Object.assign(extra.lanes[0], { runtimeDir: "/private/runtime" });
    expect(() => validateLanePlan(extra)).toThrow();
    const missing = plan(); Reflect.deleteProperty(missing, "contractLaneId");
    expect(() => validateLanePlan(missing)).toThrow();
    const wrongType = plan(); Object.assign(wrongType.lanes[1], { dependsOn: "contract" });
    expect(() => validateLanePlan(wrongType)).toThrow();
    expect(() => validateLanePlan({ ...plan(), goalId: "Goal" })).toThrow();
    expect(() => validateLanePlan({ ...plan(), version: false })).toThrow();
  });

  it("enforces the approved goal boundary when one is supplied", () => {
    expect(() => validateLanePlan(plan(), ["src/**"])).not.toThrow();
    const nested = plan(); nested.lanes[1].ownedFiles = ["src/developer/**"];
    expect(() => validateLanePlan(nested, ["src/**"])).not.toThrow();
    const outside = plan(); outside.lanes[2].ownedFiles = ["tests/**"];
    expect(() => validateLanePlan(outside, ["src/**"])).toThrow();
  });
});

// The actual projection fixture also typechecks the exact startup event at the finite service boundary.
// No mock service is invoked to pretend the interfaces themselves implement a workflow.
function runtime(event: Parameters<DeveloperTurnService["runTurn"]>[0]["event"] = { kind: "startup", at, teamId: "team-one" }): GoalRuntimeRecord {
  return {
    version: 1, goalId: "goal-example", teamId: "team-one",
    assignment: { seatId: "seat-developer", status: "reported", updatedAt: at }, brief: brief(), plan: plan(), report: report(),
    lanes: [{ id: "scheduler", branch: "codex/scheduler", ownedFiles: ["src/planning.ts"], dependsOn: [], status: "merged",
      prUrl: "https://github.com/owner/project/pull/12", headSha: sourceSha, mergedSha: mergeSha, reviewer: "satori-miyamoto", review: "approved", ci: "passed",
      findings: [], fixRounds: 1, conflictRounds: 0, decisions: ["Lane decision"], followUps: ["Lane follow-up"], updatedAt: at }],
    events: [event], handledEventIds: ["private-delivery-id"], redirects: [], failure: null, updatedAt: at,
  };
}

describe("runtime filenames and safe UI projection", () => {
  it("uses stable validated names without adding the store's JSON extension", () => {
    expect(goalRuntimeFilename("goal-one")).toBe("goal-workflow-goal-one");
    expect(teamRuntimeFilename("team-one")).toBe("team-workflow-team-one");
    for (const invalid of ["", "../other", "goal/other", "Goal", "goal-one.json"]) {
      expect(() => goalRuntimeFilename(invalid)).toThrow();
      expect(() => teamRuntimeFilename(invalid)).toThrow();
    }
  });

  it("exposes current goal, lane PRs and report decisions without private runtime fields", () => {
    const record = Object.assign(runtime(), { sessions: [{ sessionId: "private-session-id" }], credentials: { value: "private-fixture-marker" }, privateRecord: "private-record-marker" });
    const view = projectGoalRuntime(record);
    expect(view).toMatchObject({ goalId: "goal-example", teamId: "team-one", seatId: "seat-developer", status: "reported", headSha: mergeSha,
      summary: "Schedule disjoint goals", decisions: ["Scopes are disjoint."], followUps: ["Measure queue latency."] });
    expect(view.lanes).toEqual([{ id: "scheduler", branch: "codex/scheduler", ownedFiles: ["src/planning.ts"], status: "merged",
      prUrl: "https://github.com/owner/project/pull/12", headSha: sourceSha, mergedSha: mergeSha, ci: "passed", review: "approved" }]);
    for (const key of ["sessions", "credentials", "privateRecord", "events", "handledEventIds"]) expect(view).not.toHaveProperty(key);
    expect(JSON.stringify(view)).not.toMatch(/private-(?:session|fixture|record|delivery)/);
  });

  it("detaches every mutable projected collection and failure from the runtime record", () => {
    const record = runtime(); record.failure = { at, message: "CI failed", retryable: true };
    const before = structuredClone(record);
    const view = projectGoalRuntime(record);
    expect(view.status).toBe("failed");
    view.ownedFiles.push("injected.ts"); view.lanes[0].ownedFiles.push("injected-lane.ts");
    view.decisions.push("Injected decision"); view.followUps.push("Injected follow-up"); view.neededButUnowned.push("injected-needed.ts");
    view.failure!.message = "Changed in UI";
    expect(record).toEqual(before);
  });

  it("projects unassigned work without inventing a seat, report or PR", () => {
    const record = runtime(); record.assignment = null; record.brief = null; record.report = null; record.lanes = [];
    expect(projectGoalRuntime(record)).toMatchObject({ seatId: null, status: "unassigned", summary: "", ownedFiles: [], lanes: [], headSha: null, decisions: [], followUps: [], neededButUnowned: [] });
  });
});
