import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOptions } from "../src/cli.js";
import { LocalStateRepository, parseState, StateDataError } from "../src/local-state.js";
import { interactiveState, printState } from "../src/state-cli.js";
import { StateInventory } from "../src/state-domain.js";
import { advanceCeremony, migrateLegacyCeremony, startCeremony } from "../src/ceremony.js";
import type { PlanningDocument, PlanningGoal } from "../src/planning.js";
import { implementationEligible } from "../src/implementation-facts.js";

const fixture = () => ({
  $schema: "./schema/v1/state.schema.json",
  schemaVersion: 1,
  teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha",
    externalIdentities: { mattermost: { teamId: "external-team" } },
    seats: [
      { id: "seat-001", displayName: "Chick Corea", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "external-user-1", username: "chickcorea" } } },
      { id: "seat-002", displayName: "Corey Henry", roles: ["Developer"], externalIdentities: { mattermost: { userId: "external-user-2", username: "coreyhenry" } } },
    ],
  }],
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function checkout(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "indra-state-test-"));
  dirs.push(dir);
  await writeFile(join(dir, "state.json"), JSON.stringify(value));
  return dir;
}

describe("local state checkout", () => {
  it("validates planning goals and their references for readers as well as writers", () => {
    const now = "2026-09-01T00:00:00Z";
    const goal: PlanningGoal = { id: "goal-one", teamId: "team-001", seatId: "seat-001", participantSeatIds: ["seat-002"], goal: "Goal", projectRefs: ["owner/project"], stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } };
    const value = { ...fixture(), planningGoals: [goal] };
    expect(() => parseState(value)).not.toThrow();
    for (const [patch, message] of [
      [{ teamId: "team-absent" }, "Unknown planning team"],
      [{ seatId: "seat-absent" }, "outside the team"],
      [{ participantSeatIds: ["seat-absent"] }, "outside the team"],
      [{ sessionId: "runtime-only" }, "runtime metadata"],
    ] as const) expect(() => parseState({ ...value, planningGoals: [{ ...goal, ...patch }] })).toThrow(message);
    expect(() => parseState({ ...value, planningGoals: [goal, goal] })).toThrow("Duplicate planning goal");
    expect(() => parseState({ ...value, planningGoals: {} })).toThrow("must be an array");
  });

  it("binds ceremony evidence to team seats, the team home, proposal outcomes and the state project", () => {
    const now = "2026-09-01T00:00:00Z";
    const goal: PlanningGoal = { id: "goal-one", teamId: "team-001", seatId: "seat-001", participantSeatIds: ["seat-002"], goal: "Goal", projectRefs: ["owner/project"], stage: "awaiting-review", createdAt: now, updatedAt: now, mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] },
      proposal: { id: "proposal-one", createdAt: now, summary: "Proposal", outcomes: [{ id: "outcome-one", seatId: "seat-002", title: "Title", description: "Description" }], risks: [], openQuestions: [] }, ceremony: startCeremony(now) };
    goal.ceremony = advanceCeremony(goal, { to: "proposal", at: now });
    goal.stage = "approved"; goal.assignments = [{ outcomeId: "outcome-one", seatId: "seat-002", status: "queued", updatedAt: now }];
    goal.integration = { branch: "sprint/goal-one", baseSha: "a".repeat(40), status: "collecting" };
    goal.ceremony = advanceCeremony(goal, { to: "implement", at: now, evidence: { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-post", approval: { source: "reaction", userId: "person", postId: "proposal-post", emoji: "white_check_mark", verifiedHuman: true, at: now } } });
    const value = { ...fixture(), planningGoals: [goal] };
    Object.assign(value.teams[0], { project: { github: "owner/project" } });
    Object.assign(value.teams[0].externalIdentities.mattermost, { homeChannelId: "home" });
    expect(() => parseState(value)).not.toThrow();
    const entry = goal.ceremony.history[2];
    if (entry.stage !== "implement" || entry.evidence.kind !== "approval" || entry.evidence.approval.source !== "reaction") throw new Error("Expected approval");
    entry.evidence.approval.userId = "external-user-1";
    expect(() => parseState(value)).toThrow("cannot supply human approval");
    entry.evidence.approval.userId = "person";
    goal.mattermost.channelId = "elsewhere";
    expect(() => parseState(value)).toThrow("home channel");
    goal.mattermost.channelId = "home";
    goal.assignments![0].seatId = "seat-001";
    expect(() => parseState(value)).toThrow("proposed seat");
    goal.assignments![0].seatId = "seat-002";
    goal.assignments![0].status = "merged"; goal.assignments![0].prUrl = "https://github.com/another/project/pull/1";
    goal.ceremony = advanceCeremony(goal, { to: "release", at: now, evidence: { kind: "implementation", outcomes: [{ outcomeId: "outcome-one", seatId: "seat-002", prUrl: goal.assignments![0].prUrl, baseBranch: "sprint/goal-one", mergedSha: "b".repeat(40), checksPassed: true, reviewApproved: true }] } });
    expect(() => parseState(value)).toThrow("team's project");
  });

  it("reads the seed shape into neutral records", async () => {
    const inventory = new StateInventory(new LocalStateRepository(await checkout(fixture())));
    const snapshot = await inventory.current();
    expect(snapshot.teams[0].seats.map((seat) => seat.id)).toEqual(["seat-001", "seat-002"]);
    expect(snapshot.teams[0].seats[1]).toEqual({ id: "seat-002", displayName: "Corey Henry", handle: "coreyhenry", mattermostUserId: "external-user-2", roles: ["Developer"] });
    expect(snapshot.teams[0].mattermostTeamId).toBe("external-team");
    const output: string[] = [];
    printState(snapshot, "now", (line) => output.push(line));
    expect(output.join("\n")).toContain("Yahaha (yahaha) | 2 seats");
    expect(output.join("\n")).not.toContain("external-team");
  });

  it("still reads a document with the retired draft sprints, and needs no sprints at all", () => {
    const draft = { id: "sprint-001", teamId: "team-001", status: "draft", phase: "planning", goal: "Agree on a first cycle.", proposedWork: [], proposedAllocations: [] };
    expect(parseState({ ...fixture(), sprints: [draft] })).toEqual(parseState(fixture()));
    expect(parseState(fixture())).not.toHaveProperty("sprints");
    expect(() => parseState({ ...fixture(), sprints: {} })).toThrow("sprints must be an array");
  });

  it("rereads edits to Corey's roles on refresh", async () => {
    const dir = await checkout(fixture());
    const inventory = new StateInventory(new LocalStateRepository(dir));
    const output: string[] = [];
    let prompts = 0;
    await interactiveState(inventory, async () => {
      if (prompts++ === 0) {
        const edited = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as ReturnType<typeof fixture>;
        edited.teams[0].seats[0].roles = ["Developer"];
        edited.teams[0].seats[1].roles = ["Team Lead"];
        await writeFile(join(dir, "state.json"), JSON.stringify(edited));
        return "r";
      }
      return "q";
    }, (line) => output.push(line));
    const text = output.join("\n");
    expect(text).toContain("Corey Henry (@coreyhenry) | Role: Developer\n");
    expect(text).toContain("Corey Henry (@coreyhenry) | Role: Team Lead");
  });

  it("reports malformed JSON, unsupported version, shape, and bad references", async () => {
    const dir = await checkout(fixture());
    await writeFile(join(dir, "state.json"), "{bad");
    await expect(new LocalStateRepository(dir).read()).rejects.toThrow(/invalid JSON/);
    const bad = fixture();
    (bad as { schemaVersion: number }).schemaVersion = 2;
    expect(() => parseState(bad)).toThrow("Unsupported schemaVersion '2'");
    const missing = fixture();
    missing.teams[0].seats[1].roles = ["Developer", "Developer"];
    expect(() => parseState(missing)).toThrow("teams[0].seats[1].roles contains duplicate role 'Developer'");
    const unknown = fixture() as ReturnType<typeof fixture> & { secrets?: string };
    unknown.secrets = "no";
    expect(() => parseState(unknown)).toThrow("state.json.secrets is not part of state schema v1");
  });

  it("explains a missing checkout without treating it as an empty team", async () => {
    const repository = new LocalStateRepository("/path/that/does/not/exist");
    const error = await repository.read().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StateDataError);
    expect(String(error)).toContain("Set --state PATH or INDRA_STATE_REPO");
  });

  it("opens the terminal UI by default and keeps Mattermost opt-in", () => {
    expect(parseOptions([], "/tmp/fixture")).toEqual({ mode: "ui", checkout: "/tmp/fixture" });
    expect(parseOptions(["--ui"], "/tmp/fixture")).toEqual({ mode: "ui", checkout: "/tmp/fixture" });
    expect(parseOptions(["--state", "/tmp/explicit", "--once"], "/tmp/fixture")).toEqual({ mode: "state", checkout: "/tmp/explicit", once: true });
    expect(parseOptions(["--mattermost", "--team", "yahaha"])).toEqual({ mode: "mattermost", slug: "yahaha" });
    expect(() => parseOptions(["--team", "yahaha"])).toThrow("requires --mattermost");
    expect(parseOptions(["--mattermost", "--once"], "/tmp/fixture")).toEqual({ mode: "mattermost", checkout: "/tmp/fixture", once: true });
    expect(parseOptions(["--mattermost", "--state", "/tmp/explicit"], "/tmp/fixture")).toEqual({ mode: "mattermost", checkout: "/tmp/explicit", once: false });
    expect(() => parseOptions(["--mattermost", "--team", "yahaha", "--once"])).toThrow("Usage:");
    expect(() => parseOptions(["--mattermost", "--ui"])).toThrow("Usage:");
  });

  it("reads a team's optional home channel and GitHub project, naming the field when either is malformed", () => {
    expect(parseState(fixture()).teams[0]).not.toHaveProperty("homeChannelId");
    expect(parseState(fixture()).teams[0]).not.toHaveProperty("project");
    const home = (mattermost: object, project?: unknown) => {
      const value = fixture() as ReturnType<typeof fixture> & { teams: { project?: unknown }[] };
      Object.assign(value.teams[0].externalIdentities.mattermost, mattermost);
      if (project !== undefined) value.teams[0].project = project;
      return value;
    };
    expect(parseState(home({ homeChannelId: "o9rogqxy7br1zkrcami681sray" }, { github: "satoramoto/indra" })).teams[0]).toMatchObject({ homeChannelId: "o9rogqxy7br1zkrcami681sray", project: { github: "satoramoto/indra" } });
    expect(() => parseState(home({ homeChannelId: " " }))).toThrow("teams[0].externalIdentities.mattermost.homeChannelId must be a nonempty string");
    expect(() => parseState(home({ planningChannelId: "channel-1" }))).toThrow("teams[0].externalIdentities.mattermost.planningChannelId is not part of state schema v1");
    expect(() => parseState(home({}, "satoramoto/indra"))).toThrow("teams[0].project must be an object");
    expect(() => parseState(home({}, {}))).toThrow("teams[0].project.github must be a nonempty string");
    expect(() => parseState(home({}, { github: "satoramoto/indra", path: "/tmp" }))).toThrow("teams[0].project.path is not part of state schema v1");
    for (const github of ["indra", "https://github.com/satoramoto/indra", "../indra", "satoramoto/..", "a/b/c", "satoramoto/in dra"]) {
      expect(() => parseState(home({}, { github }))).toThrow("teams[0].project.github must be a GitHub repository as 'owner/repo'");
    }
  });

  it("keeps legacy teams on two roles until explicit remodel readiness", () => {
    const product = fixture();
    product.teams[0].seats[1].roles = ["Product"];
    expect(() => parseState(product)).toThrow("teams[0].workflowModel must be goals-v1 before a Product seat is enabled.");
    const two = fixture();
    two.teams[0].seats[1].roles = ["Developer", "Team Lead"];
    expect(() => parseState(two)).toThrow("teams[0].seats[1].roles must contain exactly one role");
    const none = fixture();
    none.teams[0].seats[1].roles = [];
    expect(() => parseState(none)).toThrow("teams[0].seats[1].roles must contain exactly one role");
    const noLead = fixture();
    noLead.teams[0].seats[0].roles = ["Developer"];
    expect(() => parseState(noLead)).toThrow("teams[0].seats must contain exactly one 'Team Lead' seat; found 0");
    const twoLeads = fixture();
    twoLeads.teams[0].seats[1].roles = ["Team Lead"];
    expect(() => parseState(twoLeads)).toThrow("teams[0].seats must contain exactly one 'Team Lead' seat; found 2");
  });
});


describe("explicit three-role readiness", () => {
  function remodel() {
    const value = fixture();
    Object.assign(value.teams[0], { workflowModel: "goals-v1" });
    value.teams[0].seats.push({ id: "seat-product", displayName: "George Duke", roles: ["Product"], externalIdentities: { mattermost: { userId: "george", username: "georgeduke" } } });
    return value;
  }
  it("reads old two-role teams and preserves existing identities when an explicitly ready team has three roles", () => {
    expect(() => parseState(fixture())).not.toThrow();
    const value = remodel();
    expect(parseState(value).teams[0]).toMatchObject({ workflowModel: "goals-v1", seats: expect.arrayContaining([expect.objectContaining({ id: "seat-product", displayName: "George Duke", handle: "georgeduke", roles: ["Product"] })]) });
  });
  it("requires one Product and Developers without guessing a historical role", () => {
    const value = remodel();
    Reflect.deleteProperty(value.teams[0], "workflowModel");
    expect(() => parseState(value)).toThrow("workflowModel");
    Object.assign(value.teams[0], { workflowModel: "goals-v1" });
    value.teams[0].seats[2].roles = ["Developer"];
    expect(() => parseState(value)).toThrow("exactly one Product");
    value.teams[0].seats[2].roles = ["Product"];
    value.teams[0].seats[1].roles = ["Product"];
    expect(() => parseState(value)).toThrow("exactly one Product");
  });

  async function convertedHistory() {
    const state = JSON.parse(await readFile(new URL("./fixtures/legacy-state.json", import.meta.url), "utf8")) as PlanningDocument;
    const goal = state.planningGoals!.find((item) => item.id === "goal-855701cc")!;
    state.planningGoals = [goal];
    const migration = migrateLegacyCeremony(goal, "2026-09-29T12:00:00.000Z");
    if (migration.status !== "ready" || !migration.ceremony.closure) throw new Error("The real check-in goal must have a proven legacy closure.");
    goal.ceremony = migration.ceremony;
    expect(() => parseState(state)).not.toThrow();
    const historical = structuredClone(goal);
    const team = state.teams[0] as { id: string; workflowModel?: string; seats: { id: string; displayName: string; roles: string[]; externalIdentities: unknown }[] };
    const george = team.seats.find((seat) => seat.id === "seat-002")!;
    const identity = structuredClone(george);
    team.workflowModel = "goals-v1"; george.roles = ["Product"];
    return { state, goal, historical, george, identity };
  }

  it("keeps closed real outcomes and assignments intact when George's existing seat becomes Product", async () => {
    const { state, goal, historical, george, identity } = await convertedHistory();
    expect(parseState(state).teams[0].seats.find((seat) => seat.id === "seat-002")).toMatchObject({ id: "seat-002", displayName: "George Duke", handle: "georgeduke", roles: ["Product"] });
    expect(george).toEqual({ ...identity, roles: ["Product"] });
    expect(goal).toEqual(historical);
    expect(goal.workflowModel).toBeUndefined();
    expect(goal.ownedFiles).toBeUndefined();
    expect(implementationEligible(goal)).toBe(false);
    george.id = "seat-replacement";
    expect(() => parseState(state)).toThrow("Historical outcome outcome-1 seat seat-002 is outside the team");
  });

  it.each(["unmigrated", "open ceremony"])("still rejects the converted Product seat on %s legacy work", async (kind) => {
    const { state, goal } = await convertedHistory();
    if (kind === "unmigrated") delete goal.ceremony;
    else delete goal.ceremony!.closure;
    expect(() => parseState(state)).toThrow("Outcome outcome-1 seat seat-002 is not a Developer");
    // An assignment cannot evade the role check by naming a different current Developer in its proposal.
    delete goal.ceremony;
    goal.proposal!.outcomes[0].seatId = "seat-003";
    expect(() => parseState(state)).toThrow("Assignment seat seat-002 is not a Developer");
  });

  it("does not extend the historical-role exemption to a new whole-goal assignment", async () => {
    const { state } = await convertedHistory();
    const at = "2026-09-29T12:30:00.000Z";
    const goal: PlanningGoal = {
      workflowModel: "goals-v1", ownedFiles: ["src/new.ts"], id: "goal-new", teamId: "team-001", seatId: "seat-001", participantSeatIds: [],
      goal: "New work", projectRefs: ["satoramoto/indra"], stage: "clarifying", createdAt: at, updatedAt: at,
      mattermost: { channelId: "o9rogqxy7br1zkrcami681sray", rootPostId: "new-proposal" }, brief: { summary: "New work", decisions: [], openQuestions: [] }, ceremony: startCeremony(at),
    };
    goal.goalProposal = { version: 1, goalId: goal.id, proposalId: "proposal-new", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "New work",
      outcomes: [{ number: 1, title: "New work", description: "Implement it", reason: "Mission", currentCode: ["src/planning.ts"] }], ownedFiles: goal.ownedFiles!, risks: [], rationale: "Useful", basedOnRetros: [] };
    goal.stage = "awaiting-review"; goal.ceremony = advanceCeremony(goal, { to: "proposal", at });
    goal.stage = "approved"; goal.ceremony = advanceCeremony(goal, { to: "implement", at, evidence: { kind: "approval", proposalId: "proposal-new", proposalPostId: "new-proposal", approval: { source: "owner-command", command: "planning approve", at } } });
    goal.goalAssignment = { seatId: "seat-002", status: "assigned", updatedAt: at };
    goal.integration = { branch: "sprint/goal-new", baseSha: "a".repeat(40), status: "collecting" };
    state.planningGoals!.push(goal);
    expect(() => parseState(state)).toThrow("A whole goal must be assigned to a Developer");
    goal.goalAssignment.seatId = "seat-003";
    expect(() => parseState(state)).not.toThrow();
  });
});
