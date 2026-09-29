import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { BacklogStore, type BacklogEdit, type CandidateInput, type TicketInput } from "../src/backlog.js";
import { PlanningStore } from "../src/planning.js";
import { INITIAL_TEAM_MISSION, type TeamRecord, type SeatStatus } from "../src/state-domain.js";
import { git, stateCheckout } from "./state-checkout.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true }))); });
const teamId = "team-one";
const lead = "seat-lead";
const product = "seat-product";
const ownerMission = "Help the owner steer by value and approvals.";

async function fixture(mission: string | null = ownerMission, productStatus?: SeatStatus): Promise<BacklogStore> {
  const seats: TeamRecord["seats"] = [
    { id: lead, displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { username: "chick", userId: "chick" } } },
    { id: product, displayName: "Product", roles: ["Product"], ...(productStatus ? { status: productStatus } : {}), externalIdentities: { mattermost: { username: "product", userId: "product" } } },
    { id: "seat-developer", displayName: "Corey", roles: ["Developer"], externalIdentities: { mattermost: { username: "corey", userId: "corey" } } },
  ];
  const team: TeamRecord = { id: teamId, slug: "team-one", displayName: "Team one", ...(mission === null ? {} : { mission }),
    externalIdentities: { mattermost: { teamId: "mattermost-team" } }, seats };
  const dir = await stateCheckout("indra-backlog-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [team], sprints: [], planningGoals: [] });
  dirs.push(dir);
  await mkdir(join(dir, "schema/v1"), { recursive: true });
  await writeFile(join(dir, "schema/v1/state.schema.json"), await readFile(new URL("../schema/v1/state.schema.json", import.meta.url), "utf8"));
  return new BacklogStore(new PlanningStore(dir));
}

const ticket = (id = "ticket-one", patch: Partial<TicketInput> = {}): TicketInput => ({
  id, title: `Problem ${id}`, problem: "Owners must remember unfinished work between sprints.", value: "The next proposal follows the mission without another owner brief.",
  acceptanceCriteria: ["Unfinished work survives a restart.", "The next proposal cites the backlog."], status: "open", dependsOn: [],
  research: [{ url: "https://github.com/satoramoto/indra/issues/1", finding: "The owner describes repeated sprint planning." }], ...patch,
});
const candidate = (id = "candidate-one", patch: Partial<CandidateInput> = {}): CandidateInput => ({
  id, title: "Preserve planning context", summary: "Keep a durable mission-linked backlog.", value: "The owner only approves the next valuable sprint.",
  rank: 1, status: "candidate", ticketIds: ["ticket-one"], goalId: null, retrospectiveGoalId: null, ...patch,
});
async function editFor(backlog: BacklogStore, patch: Partial<BacklogEdit> = {}): Promise<BacklogEdit> {
  return { expectedRevision: (await backlog.read(teamId)).revision, ticketChanges: [], candidateChanges: [], ...patch };
}
const head = (backlog: BacklogStore) => git(backlog.store.checkout, "rev-parse", "HEAD").trim();
const content = (backlog: BacklogStore) => readFile(join(backlog.store.checkout, "state.json"), "utf8");

describe("transactional mission-linked backlog", () => {
  it("initializes the requested mission only when absent and never changes the default-off policy", async () => {
    const backlog = await fixture(null);
    expect(INITIAL_TEAM_MISSION).toBe("Indra is a startup simulator: a control plane where agent seats run a software team end to end on a real project, so the owner steers only by problems, value and approvals.");
    expect((await backlog.read(teamId)).mission).toBeUndefined();
    expect(await backlog.initializeMission(teamId)).toBe(true);
    expect((await new BacklogStore(new PlanningStore(backlog.store.checkout)).read(teamId)).mission).toBe(INITIAL_TEAM_MISSION);
    const initialized = head(backlog);
    expect(await backlog.initializeMission(teamId)).toBe(false);
    expect(head(backlog)).toBe(initialized);
    expect((await backlog.store.read()).teams[0]).not.toHaveProperty("standingPolicy");
    await backlog.store.updateOwnerSettings(teamId, { mission: ownerMission });
    const ownerRevision = head(backlog);
    expect(await backlog.initializeMission(teamId)).toBe(false);
    expect((await backlog.read(teamId)).mission).toBe(ownerMission);
    expect(head(backlog)).toBe(ownerRevision);
    const existing = await fixture();
    const original = head(existing);
    expect(await existing.initializeMission(teamId)).toBe(false);
    expect(head(existing)).toBe(original);
  });

  it("preserves an owner's mission edit racing with initialization", async () => {
    const backlog = await fixture(null);
    await Promise.all([
      backlog.initializeMission(teamId),
      new PlanningStore(backlog.store.checkout).updateOwnerSettings(teamId, { mission: ownerMission }),
      new BacklogStore(new PlanningStore(backlog.store.checkout)).initializeMission(teamId),
    ]);
    expect((await backlog.read(teamId)).mission).toBe(ownerMission);
  });

  it("invalidates grooming when the owner changes the mission, even if the original text is later restored", async () => {
    const backlog = await fixture();
    const edit = await editFor(backlog, { ticketChanges: [{ action: "create", ticket: ticket() }] });
    await backlog.store.updateOwnerSettings(teamId, { mission: "A revised mission" });
    await backlog.store.updateOwnerSettings(teamId, { mission: ownerMission });
    await expect(backlog.apply(teamId, product, edit)).rejects.toThrow("Stale backlog edit");
    expect((await backlog.read(teamId)).tickets).toEqual([]);
  });

  it("persists problems, criteria, value, research, dependencies and ranked candidate membership across reloads", async () => {
    const backlog = await fixture();
    const edit = await editFor(backlog, {
      ticketChanges: [
        { action: "create", ticket: ticket("ticket-two", { dependsOn: ["ticket-one"] }) },
        { action: "create", ticket: ticket() },
      ],
      candidateChanges: [
        { action: "create", candidate: candidate("candidate-later", { rank: 2, ticketIds: ["ticket-two"] }) },
        { action: "create", candidate: candidate() },
      ],
    });
    const result = await backlog.apply(teamId, product, edit);
    expect(result.revision).not.toBe(edit.expectedRevision);
    const reloaded = await new BacklogStore(new PlanningStore(backlog.store.checkout)).read(teamId);
    expect(reloaded).toEqual(result);
    expect(reloaded.mission).toBe(ownerMission);
    const saved = reloaded.tickets.find((item) => item.id === "ticket-one")!;
    expect(saved).toMatchObject({ id: "ticket-one", title: ticket().title, value: ticket().value, research: ticket().research, createdBySeatId: product, updatedBySeatId: product });
    expect(saved.description).toContain(ticket().problem);
    for (const criterion of ticket().acceptanceCriteria) expect(saved.description).toContain(criterion);
    expect(reloaded.tickets.find((item) => item.id === "ticket-two")?.dependsOn).toEqual(["ticket-one"]);
    expect(reloaded.candidates.map((item) => [item.id, item.rank, item.ticketIds, item.value])).toEqual([
      ["candidate-one", 1, ["ticket-one"], candidate().value], ["candidate-later", 2, ["ticket-two"], candidate().value],
    ]);
    const ajv = new Ajv2020({ strict: false }); addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(await readFile(join(backlog.store.checkout, "schema/v1/state.schema.json"), "utf8")));
    expect(validate(JSON.parse(await content(backlog))), JSON.stringify(validate.errors)).toBe(true);
    expect(git(backlog.store.checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe("state.json");
  });

  it("keeps ticket identity, original authorship and membership when another seat updates its contents", async () => {
    const backlog = await fixture();
    const first = await backlog.apply(teamId, product, await editFor(backlog, {
      ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate() }],
    }));
    const next = await backlog.apply(teamId, lead, await editFor(backlog, {
      ticketChanges: [{ action: "update", ticket: ticket("ticket-one", { problem: "A sharper problem", status: "planned" }) }],
      candidateChanges: [{ action: "update", candidate: candidate("candidate-one", { rank: 7, value: "A sharper outcome" }) }],
    }));
    expect(next.tickets).toHaveLength(1);
    expect(next.tickets[0]).toMatchObject({ id: first.tickets[0].id, createdAt: first.tickets[0].createdAt, createdBySeatId: product, updatedBySeatId: lead, status: "planned" });
    expect(next.tickets[0].description).toContain("A sharper problem");
    expect(next.candidates[0]).toMatchObject({ id: "candidate-one", ticketIds: ["ticket-one"], rank: 7, value: "A sharper outcome", createdBySeatId: product, updatedBySeatId: lead });
  });

  it("rejects duplicate creates, repeated operations and updates to missing identities without making a commit", async () => {
    const backlog = await fixture();
    await backlog.apply(teamId, product, await editFor(backlog, { ticketChanges: [{ action: "create", ticket: ticket() }] }));
    for (const changes of [
      [{ action: "create" as const, ticket: ticket() }],
      [{ action: "update" as const, ticket: ticket("ticket-missing") }],
      [{ action: "create" as const, ticket: ticket("ticket-new") }, { action: "update" as const, ticket: ticket("ticket-new") }],
    ]) {
      const before = head(backlog); const text = await content(backlog);
      await expect(backlog.apply(teamId, product, await editFor(backlog, { ticketChanges: changes }))).rejects.toThrow(/identity/i);
      expect(head(backlog)).toBe(before); expect(await content(backlog)).toBe(text);
    }
  });

  it("allows exactly one concurrent edit at a revision, then lets the loser reload and retry without losing either ticket", async () => {
    const backlog = await fixture(); const other = new BacklogStore(new PlanningStore(backlog.store.checkout));
    const edit = await editFor(backlog);
    const results = await Promise.allSettled(["ticket-one", "ticket-two"].map((id, index) =>
      (index ? other : backlog).apply(teamId, index ? lead : product, { ...edit, ticketChanges: [{ action: "create", ticket: ticket(id) }] })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toContain("Stale backlog edit");
    const current = await backlog.read(teamId);
    const missingId = current.tickets[0].id === "ticket-one" ? "ticket-two" : "ticket-one";
    await other.apply(teamId, lead, await editFor(other, { ticketChanges: [{ action: "create", ticket: ticket(missingId) }] }));
    expect((await backlog.read(teamId)).tickets.map((item) => item.id).sort()).toEqual(["ticket-one", "ticket-two"]);
    expect(git(backlog.store.checkout, "rev-list", "--count", "HEAD").trim()).toBe("3");
  });

  it("rejects invalid dependency graphs and candidate membership atomically, including forward references that never resolve", async () => {
    const backlog = await fixture();
    const base = await editFor(backlog); const before = await content(backlog);
    const badBatches: Partial<BacklogEdit>[] = [
      { ticketChanges: [{ action: "create", ticket: ticket("ticket-one", { dependsOn: ["ticket-missing"] }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket("ticket-one", { dependsOn: ["ticket-one"] }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket("ticket-one", { dependsOn: ["ticket-two"] }) }, { action: "create", ticket: ticket("ticket-two", { dependsOn: ["ticket-one"] }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }, { action: "create", ticket: ticket("ticket-two", { dependsOn: ["ticket-one", "ticket-one"] }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate("candidate-one", { ticketIds: ["ticket-missing"] }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate("candidate-one", { ticketIds: ["ticket-one", "ticket-one"] }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate("candidate-one", { goalId: "goal-missing" }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate("candidate-one", { retrospectiveGoalId: "goal-missing" }) }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate() }, { action: "create", candidate: candidate("candidate-two") }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate() }, { action: "create", candidate: candidate() }] },
      { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "update", candidate: candidate() }] },
    ];
    for (const patch of badBatches) {
      await expect(backlog.apply(teamId, product, { ...base, ...patch })).rejects.toThrow();
      expect(head(backlog)).toBe(base.expectedRevision); expect(await content(backlog)).toBe(before);
    }
  });

  it("refuses blank problem, value or criteria and unsupported research URLs", async () => {
    const backlog = await fixture(); const base = await editFor(backlog);
    for (const patch of [{ problem: " " }, { value: "" }, { acceptanceCriteria: [] }, { acceptanceCriteria: [" "] }, { research: [{ url: "file:///local", finding: "Research" }] }, { research: [{ url: "https://example.test", finding: " " }] }]) {
      await expect(backlog.apply(teamId, product, { ...base, ticketChanges: [{ action: "create", ticket: ticket("ticket-one", patch) }] })).rejects.toThrow("Invalid backlog edit");
    }
    expect(head(backlog)).toBe(base.expectedRevision);
  });

  it("rejects attempted owner-setting or authorship changes before any state write", async () => {
    const backlog = await fixture();
    const base = await editFor(backlog, { ticketChanges: [{ action: "create", ticket: ticket() }] });
    const before = await content(backlog);
    for (const patch of [
      { mission: "An agent-picked mission" }, { standingPolicy: { revisions: [] } }, { source: "owner-command" }, { teams: [] },
      { ticketChanges: [{ action: "create", ticket: { ...ticket(), createdBySeatId: lead } }] },
      { candidateChanges: [{ action: "create", candidate: { ...candidate(), mission: "An agent-picked mission" } }] },
    ]) await expect(backlog.apply(teamId, product, { ...base, ...patch })).rejects.toThrow("Invalid backlog edit");
    expect(head(backlog)).toBe(base.expectedRevision); expect(await content(backlog)).toBe(before);
  });

  it("limits grooming to a serving Product or Team Lead from the same team", async () => {
    const backlog = await fixture(); const base = await editFor(backlog);
    for (const seatId of ["seat-developer", "seat-missing"]) await expect(backlog.apply(teamId, seatId, base)).rejects.toThrow("active Product or Team Lead");
    await expect(backlog.apply("team-missing", product, base)).rejects.toThrow("Unknown backlog team");
    for (const status of ["pending", "retiring", "retired"] as const) {
      const inactive = await fixture(ownerMission, status);
      await expect(inactive.apply(teamId, product, await editFor(inactive))).rejects.toThrow("active Product or Team Lead");
    }
  });

  it("rolls back the complete batch if its Git commit fails, leaving the same revision available for a retry", async () => {
    const backlog = await fixture(); const before = await content(backlog);
    const edit = await editFor(backlog, { ticketChanges: [{ action: "create", ticket: ticket() }], candidateChanges: [{ action: "create", candidate: candidate() }] });
    const hook = join(backlog.store.checkout, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(backlog.apply(teamId, product, edit)).rejects.toThrow("rolled back");
    expect(head(backlog)).toBe(edit.expectedRevision); expect(await content(backlog)).toBe(before);
    expect(git(backlog.store.checkout, "status", "--porcelain", "--", "state.json")).toBe("");
    await rm(hook);
    const result = await backlog.apply(teamId, product, edit);
    expect(result.tickets).toHaveLength(1); expect(result.candidates).toHaveLength(1);
  });

  it("rolls back failed mission initialization and retries through the normal recovery path", async () => {
    const backlog = await fixture(null); const before = await content(backlog); const revision = head(backlog);
    const hook = join(backlog.store.checkout, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(backlog.initializeMission(teamId)).rejects.toThrow("rolled back");
    expect(await content(backlog)).toBe(before); expect(head(backlog)).toBe(revision);
    await rm(hook);
    expect(await backlog.initializeMission(teamId)).toBe(true);
    expect((await backlog.read(teamId)).mission).toBe(INITIAL_TEAM_MISSION);
  });

  it("recovers an interrupted initial mission commit through PlanningStore after a restart", async () => {
    const backlog = await fixture(null);
    const state = await backlog.store.read();
    (state.teams as TeamRecord[])[0].mission = INITIAL_TEAM_MISSION;
    const after = `${JSON.stringify(state, null, 2)}\n`;
    await backlog.store.saveRuntime("state-commit", { sha256: createHash("sha256").update(after).digest("hex"), message: "Initialize the team mission" });
    await writeFile(join(backlog.store.checkout, "state.json"), after);
    const restarted = new BacklogStore(new PlanningStore(backlog.store.checkout));
    expect(await restarted.initializeMission(teamId)).toBe(false);
    expect((await restarted.read(teamId)).mission).toBe(INITIAL_TEAM_MISSION);
    expect(git(backlog.store.checkout, "log", "-1", "--format=%s").trim()).toBe("Initialize the team mission");
    expect(await restarted.store.readRuntimeFile("state-commit")).toBeUndefined();
    expect(git(backlog.store.checkout, "status", "--porcelain", "--", "state.json")).toBe("");
  });

  it("refuses initialization before the checkout's schema accepts missions", async () => {
    const backlog = await fixture(null); const before = await content(backlog); const revision = head(backlog);
    const schemaFile = join(backlog.store.checkout, "schema/v1/state.schema.json");
    const schema = JSON.parse(await readFile(schemaFile, "utf8"));
    delete schema.$defs.team.properties.mission;
    await writeFile(schemaFile, JSON.stringify(schema));
    await expect(backlog.initializeMission(teamId)).rejects.toThrow("v1 schema");
    expect(await content(backlog)).toBe(before); expect(head(backlog)).toBe(revision);
  });
});
