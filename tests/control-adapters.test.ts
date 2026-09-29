import { describe, expect, it, vi } from "vitest";
import { controlModules, createOwnerControls, productRunnerFactory, registerCeremonyAdapters, type ControlModules } from "../src/control-adapters.js";
import { PlanningStore } from "../src/planning.js";
import type { CeremonyAdapters } from "../src/planning-bridge.js";
import type { SeatProcessPort } from "../src/supervisor.js";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { stateCheckout, git } from "./state-checkout.js";
import { StateInventory } from "../src/state-domain.js";
import { LocalStateRepository } from "../src/local-state.js";
import { TerminalUiModel } from "../src/terminal-ui.js";

function services() {
  const updateOwnerSettings = vi.fn(async () => {});
  const processes: SeatProcessPort = { read: async () => ({}), ensureAll: vi.fn(async () => []), restart: vi.fn(), stop: vi.fn() };
  return { store: { updateOwnerSettings } as unknown as PlanningStore, processes, appDir: "/app", updateOwnerSettings };
}

describe("optional production control composition", () => {
  it("persists an owner-confirmed mission through the real store and reloads it in a new UI", async () => {
    const checkout = await stateCheckout("indra-owner-controls-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], teams: [{
      id: "team-one", slug: "one", displayName: "One", externalIdentities: { mattermost: { teamId: "mm-team" } },
      seats: [{ id: "seat-lead", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { username: "lead", userId: "lead-id" } } }],
    }] });
    try {
      await mkdir(join(checkout, "schema/v1"), { recursive: true });
      await copyFile("schema/v1/state.schema.json", join(checkout, "schema/v1/state.schema.json"));
      const store = new PlanningStore(checkout);
      const controls = await createOwnerControls({ ...services(), store }, {});
      const inventory = new StateInventory(new LocalStateRepository(checkout));
      const sessions = { readSessions: async () => ({ connection: "connected" as const, sessions: [] }) };
      const ui = () => new TerminalUiModel(inventory, sessions, undefined, undefined, undefined, undefined, controls);
      const model = ui(); await model.refresh(); model.key("c", "C"); model.key("e", "e");
      expect(model.teamInput?.kind).toBe("mission");
      if (model.teamInput?.kind === "mission") model.teamInput.value = "Owner's saved mission";
      model.key("enter"); model.key("y", "y"); await model.teamConfirmed();
      expect(model.notice).toBe("Team mission saved.");
      const reopened = ui(); await reopened.refresh();
      expect(reopened.team?.mission).toBe("Owner's saved mission");
      expect(reopened.team?.standingPolicy).toBeUndefined();
      expect(git(checkout, "show", "--format=", "--name-only", "HEAD").trim()).toBe("state.json");
      await store.sync();
    } finally { await rm(checkout, { recursive: true, force: true }); await rm(`${checkout}.runtime`, { recursive: true, force: true }); }
  });

  it("provides only the owner settings writer when adapters are absent, without starting or approving work", async () => {
    const fixture = services();
    const controls = await createOwnerControls(fixture, {});
    expect(controls.available).toEqual({ product: false });
    expect(controls.lifecycle).toBeUndefined();
    expect(controls.autoMode).toBeUndefined();
    expect(productRunnerFactory({})).toBeUndefined();
    expect(fixture.updateOwnerSettings).not.toHaveBeenCalled();
    expect(fixture.processes.ensureAll).not.toHaveBeenCalled();
    await controls.settings!.updateOwnerSettings("team-one", { mission: "Owner mission" });
    expect(fixture.updateOwnerSettings).toHaveBeenCalledWith("team-one", { mission: "Owner mission" }, undefined);
  });

  it("discovers shipped modules without requiring the later lifecycle, Product or automation files", async () => {
    expect(controlModules["./release-activation.ts"]).toBeDefined();
    expect(controlModules["./retro-publication.ts"]).toBeDefined();
    const controls = await createOwnerControls(services());
    // The initial composition builds with no optional capability advertised by an absent module.
    if (!controlModules["./product-seat.ts"]) expect(controls.available?.product).toBe(false);
    if (!controlModules["./auto-mode-adapter.ts"]) expect(controls.autoMode).toBeUndefined();
    if (!controlModules["./seat-lifecycle.ts"]) expect(controls.lifecycle).toBeUndefined();
  });

  it("registers independent owner and workflow services without calling their gated actions", async () => {
    const lifecycle = { add: vi.fn(), remove: vi.fn(), reconcile: vi.fn() };
    const autoMode = { enable: vi.fn() };
    const product = vi.fn(async () => ({ tick: vi.fn() }));
    const bridgeFactory = vi.fn(() => ({}));
    const modules: ControlModules = {
      lifecycle: { createOwnerControls: () => ({ lifecycle }) },
      policy: { createOwnerControls: () => ({ autoMode }), controlServices: ["policy"], createCeremonyAdapters: bridgeFactory },
      product: { createProductRunner: product },
      next: { controlServices: ["nextSprint"], createCeremonyAdapters: bridgeFactory },
      facts: { controlServices: ["releaseFacts"], createCeremonyAdapters: bridgeFactory },
      grooming: { controlServices: ["grooming"], createCeremonyAdapters: bridgeFactory },
    };
    const controls = await createOwnerControls(services(), modules);
    expect(controls.lifecycle).toBe(lifecycle);
    expect(controls.autoMode).toBe(autoMode);
    expect(controls.available).toEqual({ product: true, policy: true, nextSprint: true, releaseFacts: true, grooming: true });
    expect(productRunnerFactory(modules)).toBe(product);
    for (const call of [product, bridgeFactory, lifecycle.add, lifecycle.remove, lifecycle.reconcile, autoMode.enable]) expect(call).not.toHaveBeenCalled();
  });

  it("rejects competing owners and never treats service labels as an enabling adapter", async () => {
    const module = { createOwnerControls: () => ({ autoMode: { enable: vi.fn() } }) };
    await expect(createOwnerControls(services(), { a: module, b: module })).rejects.toThrow("Multiple owner control adapters");
    const runner = { createProductRunner: async () => ({ tick: async () => "idle" as const }) };
    expect(() => productRunnerFactory({ a: runner, b: runner })).toThrow("Multiple adapters");
    const controls = await createOwnerControls(services(), { labels: { controlServices: ["policy", "nextSprint"] } });
    expect(controls.autoMode).toBeUndefined();
    expect(controls.available?.policy).toBeUndefined();
  });

  it("refuses to overwrite an existing ceremony hook", () => {
    const release = { poll: vi.fn() };
    const adapters: CeremonyAdapters = {};
    registerCeremonyAdapters(adapters, { release });
    expect(adapters.release).toBe(release);
    expect(() => registerCeremonyAdapters(adapters, { release })).toThrow("Multiple ceremony adapters provide release");
    expect(release.poll).not.toHaveBeenCalled();
  });
});
