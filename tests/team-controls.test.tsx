import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { OwnerControls } from "../src/control-adapters.js";
import { INITIAL_TEAM_MISSION, StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import { TerminalUiModel, type UpdatePort } from "../src/terminal-ui.js";

const initial: StateSnapshot = { teams: [{ id: "team-one", slug: "one", displayName: "One", mattermostTeamId: "mm-team", seats: [
  { id: "seat-lead", displayName: "Lead", handle: "lead", roles: ["Team Lead"], mattermostUserId: "lead-id" },
  { id: "seat-product", displayName: "Product", handle: "productbot", roles: ["Product"], status: "pending", mattermostUserId: "" },
] }] };

async function fixture(available = true, update?: UpdatePort) {
  const state = structuredClone(initial);
  let unreadable = false;
  const settings = { updateOwnerSettings: vi.fn(async (teamId: string, patch: { mission?: string; autoMode?: boolean }) => {
    const team = state.teams.find((item) => item.id === teamId)!;
    if (patch.mission !== undefined) team.mission = patch.mission;
    if (patch.autoMode !== undefined) team.standingPolicy = { revisions: [...team.standingPolicy?.revisions ?? [], {
      revision: (team.standingPolicy?.revisions.length ?? 0) + 1, source: "owner-command", at: new Date().toISOString(), enabled: patch.autoMode,
    }] };
  }) };
  const lifecycle = { add: vi.fn(async () => {}), remove: vi.fn(async () => {}), reconcile: vi.fn(async () => {}) };
  const autoMode = { enable: vi.fn(async (teamId: string) => settings.updateOwnerSettings(teamId, { autoMode: true })) };
  const controls: OwnerControls = { settings, ...(available ? { lifecycle, autoMode, available: { product: true, policy: true } } : {}) };
  const inventory = new StateInventory({ read: async () => { if (unreadable) throw new Error("Offline"); return structuredClone(state); } });
  const sessions = { readSessions: async () => ({ connection: "connected" as const, sessions: [] }) };
  const model = new TerminalUiModel(inventory, sessions, undefined, undefined, undefined, update, controls);
  await model.refresh(); model.key("c", "C"); model.seatId = "seat-product";
  const key = (text: string) => model.key(text.toLowerCase(), text);
  return { model, state, settings, lifecycle, autoMode, controls, inventory, sessions, key, failReads: () => { unreadable = true; } };
}

describe("owner team controls", () => {
  it.each([80, 120])("renders default-off, missing capabilities and exact pending-seat instructions at width %s", async (width) => {
    const f = await fixture(false);
    const setup = await testRender(() => <TerminalApp model={f.model} revision={() => f.model.revision} onKey={() => {}} />, { width, height: 42 });
    try {
      await setup.renderOnce(); const frame = setup.captureCharFrame();
      expect(frame).toContain("OWNER TEAM CONTROLS");
      expect(frame).toContain("Auto mode: OFF (default)");
      expect(frame).toContain("Automation unavailable");
      expect(frame).toContain("Seat lifecycle: unavailable");
      expect(frame).toContain("Product runner:");
      expect(frame).toContain("Create Mattermost bot account: @productbot");
      expect(frame).toContain('1Password item: "Mattermost bot - productbot" · field: "token"');
      expect(frame).toContain("Product · Product · pending");
    } finally { setup.renderer.destroy(); }
    for (const key of ["+", "-", "o"]) {
      f.key(key); expect(f.model.notice).toContain("unavailable"); expect(f.model.confirm).toBeUndefined();
      f.key("y"); await f.model.teamConfirmed();
    }
    expect(f.settings.updateOwnerSettings).not.toHaveBeenCalled();
    expect(f.lifecycle.add).not.toHaveBeenCalled(); expect(f.autoMode.enable).not.toHaveBeenCalled();
  });

  it("dispatches the rendered add form and confirmation to the lifecycle adapter with the selected role", async () => {
    const f = await fixture(); const [revision, setRevision] = createSignal(f.model.revision);
    f.model.changed = () => setRevision(f.model.revision);
    let pending = Promise.resolve();
    const setup = await testRender(() => <TerminalApp model={f.model} revision={revision} onKey={(name, _ctrl, text) => {
      const action = f.model.key(name, text); setRevision(f.model.revision);
      if (action === "team-control") pending = f.model.teamConfirmed();
    }} />, { width: 120, height: 42 });
    try {
      setup.mockInput.pressKey("+"); await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("New seat · displayName");
      setup.mockInput.typeText("Pat"); setup.mockInput.pressKey("\t"); setup.mockInput.typeText("patbot");
      setup.mockInput.pressKey("\t"); setup.mockInput.pressKey("\u001b[C");
      await setup.renderOnce(); expect(setup.captureCharFrame()).toContain("Role: Product");
      setup.mockInput.pressKey("\r"); await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Add Pat as Product");
      expect(f.lifecycle.add).not.toHaveBeenCalled();
      setup.mockInput.pressKey("y"); await pending;
      expect(f.lifecycle.add).toHaveBeenCalledExactlyOnceWith({ teamId: "team-one", displayName: "Pat", username: "patbot", role: "Product" });
      expect(f.settings.updateOwnerSettings).not.toHaveBeenCalled();
    } finally { setup.renderer.destroy(); }
  });

  it.each(["e", "+", "-", "o"])("cancels %s without any persistent change", async (key) => {
    const f = await fixture();
    f.key(key); expect(f.model.teamInput ?? f.model.confirm).toBeDefined();
    f.key("escape"); f.key("y"); await f.model.teamConfirmed();
    expect(f.model.teamInput).toBeUndefined(); expect(f.model.confirm).toBeUndefined();
    expect(f.state).toEqual(initial);
    for (const method of [f.settings.updateOwnerSettings, f.lifecycle.add, f.lifecycle.remove, f.autoMode.enable]) expect(method).not.toHaveBeenCalled();
  });

  it("confirms a mission edit and keeps mission and auto settings across refresh and a new UI", async () => {
    const f = await fixture();
    f.key("e"); expect(f.model.teamInput).toMatchObject({ value: INITIAL_TEAM_MISSION });
    f.model.teamInput = { kind: "mission", teamId: "team-one", expected: f.model.teamInput!.expected, value: "A mission chosen by the owner" };
    f.key("enter"); expect(f.settings.updateOwnerSettings).not.toHaveBeenCalled();
    expect(f.key("y")).toBe("team-control"); await f.model.teamConfirmed();
    expect(f.model.team?.mission).toBe("A mission chosen by the owner");
    f.key("o"); f.key("y"); await f.model.teamConfirmed(); await f.model.refresh();
    expect(f.model.team?.standingPolicy?.revisions.at(-1)?.enabled).toBe(true);
    const reopened = new TerminalUiModel(f.inventory, f.sessions, undefined, undefined, undefined, undefined, f.controls);
    reopened.restore(f.model.view()); await reopened.refresh();
    expect(reopened.page).toBe("controls"); expect(reopened.team?.mission).toBe(f.model.team?.mission);
    expect(reopened.team?.standingPolicy).toEqual(f.model.team?.standingPolicy);
    const calls = f.settings.updateOwnerSettings.mock.calls.length;
    await reopened.refresh(); expect(f.settings.updateOwnerSettings).toHaveBeenCalledTimes(calls);
    reopened.key("o", "o"); reopened.key("y", "y"); await reopened.teamConfirmed();
    expect(reopened.team?.standingPolicy?.revisions.map((item) => item.enabled)).toEqual([true, false]);
    expect(f.autoMode.enable).toHaveBeenCalledOnce();
  });

  it("allows the owner to turn off a persisted policy even when automation is unavailable", async () => {
    const f = await fixture(false);
    await f.settings.updateOwnerSettings("team-one", { autoMode: true }); await f.model.refresh();
    f.settings.updateOwnerSettings.mockClear();
    f.key("o"); expect(f.model.confirm).toMatchObject({ change: { kind: "auto", enabled: false } });
    f.key("y"); await f.model.teamConfirmed();
    expect(f.settings.updateOwnerSettings).toHaveBeenCalledExactlyOnceWith("team-one", { autoMode: false });
    expect(f.autoMode.enable).not.toHaveBeenCalled();
  });

  it.each(["mission", "auto", "remove", "add"] as const)("expires a stale %s confirmation after y and before dispatch", async (kind) => {
    const f = await fixture();
    f.key({ mission: "e", auto: "o", remove: "-", add: "+" }[kind]);
    if (f.model.teamInput?.kind === "add") Object.assign(f.model.teamInput.request, { displayName: "New", username: "newbot" });
    if (f.model.teamInput) f.key("enter");
    expect(f.key("y")).toBe("team-control");
    if (kind === "mission") f.state.teams[0].mission = "A newer mission";
    else if (kind === "auto") f.state.teams[0].standingPolicy = { revisions: [{ revision: 1, enabled: true, source: "owner-command", at: new Date().toISOString() }] };
    else f.state.teams[0].seats[1].status = "retired";
    await f.model.teamConfirmed(); expect(f.model.notice).toContain("confirmation expired");
    for (const method of [f.settings.updateOwnerSettings, f.lifecycle.add, f.lifecycle.remove, f.autoMode.enable]) expect(method).not.toHaveBeenCalled();
  });

  it("expires an open confirmation on refresh and does not overwrite mission edits made while typing", async () => {
    const f = await fixture(); f.key("e");
    f.state.teams[0].mission = "Changed while typing"; await f.model.refresh();
    f.key("enter"); await f.model.refresh();
    expect(f.model.confirm).toBeUndefined(); expect(f.model.notice).toContain("confirmation expired");
    f.key("y"); await f.model.teamConfirmed(); expect(f.settings.updateOwnerSettings).not.toHaveBeenCalled();
  });

  it("targets the named seat even if the selection changes, and never offers Team Lead removal", async () => {
    const f = await fixture(); f.key("-"); f.key("y"); f.model.seatId = "seat-lead";
    await f.model.teamConfirmed();
    expect(f.lifecycle.remove).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-one", seatId: "seat-product", expected: expect.objectContaining({ status: "pending" }) }));
    f.key("-"); expect(f.model.confirm).toBeUndefined(); expect(f.model.notice).toContain("Developer or Product");
  });

  it("retains visible settings on a read failure while refusing mutations and stale confirmations", async () => {
    const f = await fixture(); f.key("o"); f.failReads(); await f.model.refresh();
    expect(f.model.team?.id).toBe("team-one"); expect(f.model.confirm).toBeUndefined();
    f.key("e"); expect(f.model.teamInput).toBeUndefined(); expect(f.model.notice).toContain("refresh current state");
    expect(f.settings.updateOwnerSettings).not.toHaveBeenCalled();
  });

  it("polls lifecycle independently of read refresh and keeps only one reconciliation in flight", async () => {
    const f = await fixture(); let finish = () => {};
    f.lifecycle.reconcile.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await f.model.refresh(); expect(f.lifecycle.reconcile).not.toHaveBeenCalled();
    const pending = f.model.pollControls(); await f.model.pollControls();
    expect(f.lifecycle.reconcile).toHaveBeenCalledOnce();
    finish(); await pending;
    expect(f.settings.updateOwnerSettings).not.toHaveBeenCalled();
  });
});
