import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerSettingsCommands, createOwnerControls, runOwnerSettingsCommand, type OwnerScopeChoice } from "../src/owner-settings.js";
import { approvalPolicy, POLICY_FILE, readPolicyDocument, validatePolicyDocument } from "../src/auto-policy.js";
import { PlanningStore, type PlanningDocument, type PlanningGoal } from "../src/planning.js";
import { startCeremony } from "../src/ceremony.js";
import { autoModeEnabled, type TeamRecord } from "../src/state-domain.js";
import { StateGit } from "../src/state-commit.js";
import type { AgentStatePort } from "../src/autonomy-ports.js";
import { stateCheckout, git } from "./state-checkout.js";

vi.setConfig({ testTimeout: 30_000 });
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).flatMap((dir) => [rm(dir, { recursive: true, force: true }), rm(`${dir}.runtime`, { recursive: true, force: true })]));
});
async function fixture() {
  const at = "2026-09-01T00:00:00Z";
  const goal: PlanningGoal = { id: "goal-one", teamId: "team-one", seatId: "seat-lead", participantSeatIds: [], goal: "Reduce failed deliveries", projectRefs: ["test/project"],
    stage: "clarifying", createdAt: at, updatedAt: at, mattermost: { channelId: "home", rootPostId: "root" },
    brief: { summary: "Reduce failed deliveries", decisions: [], openQuestions: [] }, ceremony: startCeremony(at) };
  const state: PlanningDocument = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [goal], teams: [{
    id: "team-one", slug: "one", displayName: "One", project: { github: "test/project" }, mission: "Run a software team",
    externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } },
    seats: [{ id: "seat-lead", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "lead", username: "lead" } } }],
  }] };
  const checkout = await stateCheckout("indra-owner-policy-", state); dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout);
  const commands = new OwnerSettingsCommands(store);
  const team = async () => (await store.read()).teams[0] as TeamRecord;
  return { store, commands, team, checkout, goal };
}

describe("owner settings commands", () => {
  it("dispatches explicit owner terminal choices and rejects forged extra arguments", async () => {
    const f = await fixture();
    await expect(runOwnerSettingsCommand(f.store, "team-one", ["auto", "on"])).rejects.toThrow("Choose mission-wide or named-problem scope");
    await runOwnerSettingsCommand(f.store, "team-one", ["scope", "problem", f.goal.id]);
    expect(autoModeEnabled(await f.team())).toBe(false);
    await runOwnerSettingsCommand(f.store, "team-one", ["auto", "on"]);
    expect(autoModeEnabled(await f.team())).toBe(true);
    await expect(runOwnerSettingsCommand(f.store, "team-one", ["scope", "mission", "--source", "owner-command"])).rejects.toThrow("Owner settings command");
    await runOwnerSettingsCommand(f.store, "team-one", ["auto", "off"]);
    await runOwnerSettingsCommand(f.store, "team-one", ["mission", "Deliver valuable software"]);
    await runOwnerSettingsCommand(f.store, "team-one", ["scope", "mission"]);
    expect((await readPolicyDocument(f.checkout)).policies[0].scope).toEqual({ kind: "mission", mission: "Deliver valuable software" });
    expect(autoModeEnabled(await f.team())).toBe(false);
  });

  it("defaults off without choosing a scope; choosing a scope alone does not enable", async () => {
    const f = await fixture();
    expect(autoModeEnabled(await f.team())).toBe(false);
    expect(await readPolicyDocument(f.checkout)).toEqual({ version: 1, policies: [] });
    await f.commands.disable("team-one");
    expect((await f.team()).standingPolicy).toBeUndefined();
    await expect(f.commands.enable("team-one")).rejects.toThrow("Choose mission-wide or named-problem scope");
    await f.commands.chooseScope("team-one", { kind: "mission" });
    expect(autoModeEnabled(await f.team())).toBe(false);
    expect((await readPolicyDocument(f.checkout)).policies[0]).toMatchObject({ teamId: "team-one", scope: { kind: "mission", mission: "Run a software team" }, grants: [] });
    expect(git(f.checkout, "show", "--format=", "--name-only", "HEAD").trim()).toBe(POLICY_FILE);
  });

  it("persists identity and exact revisions across commands, scope changes and restart", async () => {
    const f = await fixture();
    await f.commands.chooseScope("team-one", { kind: "mission" }); await f.commands.enable("team-one");
    const first = (await readPolicyDocument(f.checkout)).policies[0];
    const original = approvalPolicy({ version: 1, policies: [first] }, await f.team(), 1)!;
    expect(original).toMatchObject({ policyId: first.id, revision: 1, source: "owner-command", enabled: true, scope: first.scope });
    await f.commands.enable("team-one"); // Same enabled policy is idempotent.
    expect((await f.team()).standingPolicy?.revisions).toHaveLength(1);
    await f.commands.chooseScope("team-one", { kind: "problem", goalId: f.goal.id });
    expect(autoModeEnabled(await f.team())).toBe(false);
    const restarted = new OwnerSettingsCommands(new PlanningStore(f.checkout));
    await restarted.enable("team-one");
    const document = await readPolicyDocument(f.checkout);
    expect(document.policies[0].id).toBe(first.id);
    expect(document.policies[0].grants.map((grant) => grant.revision)).toEqual([1, 3]);
    expect(approvalPolicy(document, await f.team(), 1)).toEqual(original);
    expect(approvalPolicy(document, await f.team(), 3)?.scope).toEqual({ kind: "problem", goalId: f.goal.id, problem: f.goal.goal });
    await restarted.disable("team-one");
    expect((await f.team()).standingPolicy?.revisions.map((revision) => revision.enabled)).toEqual([true, false, true, false]);
    expect(await readPolicyDocument(f.checkout)).toEqual(document);
  });

  it("disables on a changed mission and requires the owner to select the new mission scope", async () => {
    const f = await fixture();
    await f.commands.chooseScope("team-one", { kind: "mission" }); await f.commands.enable("team-one");
    const controls = createOwnerControls({ store: f.store });
    await controls.settings.updateOwnerSettings("team-one", { mission: "Run a software team" });
    expect(autoModeEnabled(await f.team())).toBe(true);
    await controls.settings.updateOwnerSettings("team-one", { mission: "Make delivery dependable" });
    expect(await f.team()).toMatchObject({ mission: "Make delivery dependable" });
    expect(autoModeEnabled(await f.team())).toBe(false);
    await expect(f.commands.enable("team-one")).rejects.toThrow("choose its scope again");
    await f.commands.chooseScope("team-one", { kind: "mission" }); await f.commands.enable("team-one");
    expect((await f.team()).standingPolicy?.revisions.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(approvalPolicy(await readPolicyDocument(f.checkout), await f.team(), 1)?.scope).toEqual({ kind: "mission", mission: "Run a software team" });
  });

  it("rejects unknown problems, empty missions and forged agent settings without writes", async () => {
    const f = await fixture(); const head = git(f.checkout, "rev-parse", "HEAD");
    await expect(f.commands.chooseScope("team-one", { kind: "problem", goalId: "goal-other" })).rejects.toThrow("open problem on this team");
    await expect(f.commands.chooseScope("team-one", { kind: "mission", source: "owner-command" } as OwnerScopeChoice)).rejects.toThrow("Unknown owner setting");
    await expect(f.commands.updateOwnerSettings("team-one", { mission: " " })).rejects.toThrow("must not be empty");
    await expect(f.commands.updateOwnerSettings("team-one", { autoMode: "true" } as never)).rejects.toThrow("on or off");
    await expect(f.commands.updateOwnerSettings("team-one", { autoMode: true, source: "owner-command", actor: "owner" } as never)).rejects.toThrow("Unknown owner setting");
    const agent: AgentStatePort = { read: () => f.store.read(), update: (mutator, message) => f.store.update(mutator, message) };
    expect(agent).not.toHaveProperty("updateOwnerSettings");
    for (const patch of [{ mission: "Agent mission" }, { standingPolicy: { revisions: [{ revision: 1, enabled: true, source: "owner-command", at: "2026-09-02T00:00:00Z" }] } }]) {
      await expect(agent.update((state) => Object.assign(state.teams[0] as TeamRecord, patch), "Forged owner settings")).rejects.toThrow("Only the owner settings port");
    }
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(head);
    expect(await readPolicyDocument(f.checkout)).toEqual({ version: 1, policies: [] });
  });

  it("keeps off available when policy storage is dirty or corrupt", async () => {
    const f = await fixture();
    await f.commands.chooseScope("team-one", { kind: "mission" }); await f.commands.enable("team-one");
    await writeFile(join(f.checkout, POLICY_FILE), "invalid owner settings");
    await expect(f.commands.enable("team-one")).rejects.toThrow("changes that are not committed");
    await createOwnerControls({ store: f.store }).settings.updateOwnerSettings("team-one", { autoMode: false });
    expect(autoModeEnabled(await f.team())).toBe(false);
    expect(await readFile(join(f.checkout, POLICY_FILE), "utf8")).toBe("invalid owner settings");
  });

  it("revokes before changing scope, and remains off if the scope commit fails", async () => {
    const f = await fixture();
    await f.commands.chooseScope("team-one", { kind: "mission" }); await f.commands.enable("team-one");
    const before = await readPolicyDocument(f.checkout);
    const commit = StateGit.prototype.commit;
    vi.spyOn(StateGit.prototype, "commit").mockImplementation(async function (this: StateGit, message) {
      if (this.path === POLICY_FILE) throw new Error("Commit unavailable");
      await commit.call(this, message);
    });
    await expect(f.commands.chooseScope("team-one", { kind: "problem", goalId: f.goal.id })).rejects.toThrow("policy file was restored");
    expect(autoModeEnabled(await f.team())).toBe(false);
    expect(await readPolicyDocument(f.checkout)).toEqual(before);
  });

  it("does not activate a prepared grant after a failed state commit, and can retry after restart", async () => {
    const f = await fixture(); await f.commands.chooseScope("team-one", { kind: "mission" });
    const update = f.store.updateOwnerSettings.bind(f.store);
    const fail = vi.spyOn(f.store, "updateOwnerSettings").mockImplementation(async (team, patch, at) => {
      if (patch.autoMode === true) throw new Error("State commit failed");
      await update(team, patch, at);
    });
    await expect(f.commands.enable("team-one")).rejects.toThrow("State commit failed");
    const prepared = await readPolicyDocument(f.checkout);
    expect(prepared.policies[0].grants).toHaveLength(1);
    expect(approvalPolicy(prepared, await f.team(), 1)).toBeUndefined();
    fail.mockRestore();
    await new OwnerSettingsCommands(new PlanningStore(f.checkout)).enable("team-one");
    const document = await readPolicyDocument(f.checkout);
    expect(document.policies[0].grants).toHaveLength(2);
    expect(approvalPolicy(document, await f.team(), 1)?.at).toBe(document.policies[0].grants[1].at);
  });

  it("serializes a later disable behind an in-flight enable without losing the disable", async () => {
    const f = await fixture(); await f.commands.chooseScope("team-one", { kind: "mission" });
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const update = f.store.updateOwnerSettings.bind(f.store);
    vi.spyOn(f.store, "updateOwnerSettings").mockImplementation(async (team, patch, at) => {
      if (patch.autoMode === true) { enter(); await released; }
      await update(team, patch, at);
    });
    const enabling = f.commands.enable("team-one"); await entered;
    const disabling = new OwnerSettingsCommands(new PlanningStore(f.checkout)).disable("team-one");
    release(); await Promise.all([enabling, disabling]);
    expect(autoModeEnabled(await f.team())).toBe(false);
    expect((await f.team()).standingPolicy?.revisions.map((revision) => revision.enabled)).toEqual([true, false]);
  });

  it("rejects additional document fields and duplicate policy identities", async () => {
    const f = await fixture(); await f.commands.chooseScope("team-one", { kind: "mission" });
    const document = await readPolicyDocument(f.checkout);
    expect(() => validatePolicyDocument({ ...document, actor: "owner" })).toThrow("Invalid owner autonomy policy");
    expect(() => validatePolicyDocument({ ...document, policies: [...document.policies, document.policies[0]] })).toThrow("Invalid owner autonomy policy");
    expect(() => validatePolicyDocument({ ...document, policies: [{ ...document.policies[0], scope: { kind: "mission" } }] })).toThrow("Invalid owner autonomy policy");
  });
});
