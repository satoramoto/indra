import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCeremonyAdapters, createOwnerControls } from "../src/auto-mode-adapter.js";
import { controlModules, createOwnerControls as composeOwnerControls } from "../src/control-adapters.js";
import { advanceCeremony, proposalDigest, startCeremony } from "../src/ceremony.js";
import { OwnerSettingsCommands } from "../src/owner-settings.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import type { AutomaticGateRequest, CeremonyContext, PlanningChat, Post } from "../src/planning-bridge.js";
import { proposalMessage } from "../src/planning-text.js";
import { ceremonyReadiness } from "../src/retro-publication.js";
import { loadSeatPersonas, withPersonaChat } from "../src/seat-persona.js";
import type { SeatProcessPort } from "../src/supervisor.js";
import { git, stateCheckout } from "./state-checkout.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(leadSeatId = "seat-lead") {
  const at = "2026-09-01T00:00:00Z";
  const goal: PlanningGoal = {
    id: "goal-one", teamId: "team-one", seatId: leadSeatId, participantSeatIds: [], goal: "Reliable delivery",
    projectRefs: ["test/project"], stage: "awaiting-review", createdAt: at, updatedAt: at,
    mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Reliable delivery", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-one", createdAt: at, summary: "Improve delivery", outcomes: [
      { id: "outcome-one", seatId: "seat-dev", title: "Retry", description: "Retry failed deliveries" },
    ], risks: [], openQuestions: [] }, ceremony: startCeremony(at),
  };
  goal.ceremony = advanceCeremony(goal, { to: "proposal", at });
  const seats = [
    { id: leadSeatId, displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } },
    { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "dev", username: "developer" } } },
  ];
  const checkout = await stateCheckout("indra-auto-mode-", {
    $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [goal], teams: [{
      id: "team-one", slug: "yahaha", displayName: "Yahaha", mission: "Make delivery dependable", project: { github: "test/project" },
      externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats,
    }],
  }); dirs.push(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
  const store = new PlanningStore(checkout, undefined, ceremonyReadiness);
  const post: Post & { delete_at?: number } = { id: "proposal-post", channel_id: "home", root_id: "root", user_id: "chick", create_at: Date.parse(at),
    props: { indra_delivery_id: "proposal:proposal-one" }, message: proposalMessage(goal, new Map(seats.map((seat) => [seat.id, seat.displayName]))) };
  const chat: PlanningChat = { ownUserId: async () => "chick", since: async () => [post], reactions: async () => [], isBot: async () => true,
    post: vi.fn(async () => { throw new Error("An authorization adapter must not post or execute work."); }) };
  const owner = new OwnerSettingsCommands(store);
  const enable = async () => { await owner.chooseScope("team-one", { kind: "mission" }); await createOwnerControls({ store }).autoMode!.enable("team-one"); };
  const context = { store, goal } as CeremonyContext;
  const request: AutomaticGateRequest = { kind: "proposal", postId: post.id, proposalId: goal.proposal!.id, proposalDigest: proposalDigest(goal.proposal!) };
  const authorize = async () => (await createCeremonyAdapters({ chat })).automaticGate!(context, request);
  return { store, owner, enable, chat, post, context, request, authorize };
}

describe("automatic gate activation", () => {
  it("ships both factories, keeps composition off by default, and requires the owner's explicit scope", async () => {
    const f = await fixture();
    expect(controlModules["./auto-mode-adapter.ts"]).toMatchObject({ controlServices: ["policy"] });
    const processes: SeatProcessPort = { read: async () => ({}), ensureAll: vi.fn(), restart: vi.fn(), stop: vi.fn() };
    const head = git(f.store.checkout, "rev-parse", "HEAD");
    const controls = await composeOwnerControls({ store: f.store, processes, appDir: "/app" });
    expect(controls.available?.policy).toBe(true);
    expect(controls.autoMode).toBeDefined();
    expect(await f.authorize()).toBeUndefined();
    expect(git(f.store.checkout, "rev-parse", "HEAD")).toBe(head);
    await expect(controls.autoMode!.enable("team-one")).rejects.toThrow("Choose mission-wide or named-problem scope");
    expect(processes.ensureAll).not.toHaveBeenCalled();
    await f.store.updateOwnerSettings("team-one", { autoMode: true });
    expect(await f.authorize()).toBeUndefined(); // A legacy boolean setting supplies no scope grant.
    await f.enable();
    const enabledHead = git(f.store.checkout, "rev-parse", "HEAD");
    expect(await f.authorize()).toMatchObject({ source: "automatic", target: {
      kind: "proposal", goalId: f.context.goal.id, proposalId: f.request.proposalId, proposalDigest: f.request.proposalDigest,
    } });
    expect(git(f.store.checkout, "rev-parse", "HEAD")).toBe(enabledHead);
    expect((await f.store.read()).planningGoals![0].automaticApprovals).toBeUndefined();
    await controls.settings!.updateOwnerSettings("team-one", { autoMode: false });
    expect(await f.authorize()).toBeUndefined();
  });

  it.each(["missing", "edited", "author", "channel", "thread", "deleted", "identity"])("refuses a proposal whose current delivery is %s", async (problem) => {
    const f = await fixture(); await f.enable();
    if (problem === "missing") vi.spyOn(f.chat, "since").mockResolvedValue([]);
    if (problem === "edited") f.post.message += "Changed";
    if (problem === "author") f.post.user_id = "dev";
    if (problem === "channel") f.post.channel_id = "another-home";
    if (problem === "thread") f.post.root_id = "another-root";
    if (problem === "deleted") f.post.delete_at = Date.now();
    if (problem === "identity") f.post.props!.indra_delivery_id = "proposal:proposal-old";
    await expect(f.authorize()).rejects.toThrow("verified delivery of the current proposal");
    expect((await f.store.read()).planningGoals![0].stage).toBe("awaiting-review");
  });

  it("accepts the production chat's persona formatting without accepting changes to the proposal", async () => {
    const f = await fixture("seat-001"); await f.enable();
    const raw = f.post.message;
    f.chat.post = async (_channel, message) => { f.post.message = message; return f.post; };
    await withPersonaChat(f.chat, (await loadSeatPersonas())["seat-001"]).post("home", raw, "root");
    expect(f.post.message).not.toBe(raw);
    expect(await f.authorize()).toMatchObject({ source: "automatic" });
    f.post.message = f.post.message.replace("Retry failed deliveries", "Drop failed deliveries");
    await expect(f.authorize()).rejects.toThrow("verified delivery");
  });

  it.each(["off", "proposal", "scope"])("rechecks %s after the delivery GET, including with a stale caller context", async (change) => {
    const f = await fixture(); await f.enable();
    vi.spyOn(f.chat, "since").mockImplementation(async () => {
      if (change === "off") await f.owner.disable("team-one");
      else if (change === "scope") await f.owner.chooseScope("team-one", { kind: "problem", goalId: f.context.goal.id });
      else await f.store.update((state) => { state.planningGoals![0].proposal!.summary = "A revised proposal"; }, "Revise proposal");
      return [f.post];
    });
    expect(await f.authorize()).toBeUndefined();
    expect((await f.store.read()).planningGoals![0].automaticApprovals).toBeUndefined();
  });

  it("does not hide policy read failures or reuse a decision after a restart", async () => {
    const f = await fixture(); await f.enable();
    const first = await f.authorize();
    const path = join(f.store.checkout, "autonomy.json");
    const document = await readFile(path, "utf8");
    await writeFile(path, `${document}\n`);
    await expect(f.authorize()).rejects.toThrow();
    await writeFile(path, document);
    await f.owner.disable("team-one");
    expect(await f.authorize()).toBeUndefined();
    await f.owner.enable("team-one");
    expect(await f.authorize()).toMatchObject({ policyRevision: first!.policyRevision + 2 });
    expect(f.chat.post).not.toHaveBeenCalled();
  });
});
