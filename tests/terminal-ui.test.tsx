import { testRender } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { GOAL_INPUT_LIMIT, TerminalUiModel, sessionSprint, type SessionReadResult, type StateSyncPort, type TerminalSession, type UpdatePort } from "../src/terminal-ui.js";
import type { UpdateResult } from "../src/self-update.js";
import type { StateSyncResult } from "../src/state-commit.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import type { AssignmentRetry, GoalStarter, SeatLive, SeatProcessPort } from "../src/supervisor.js";
import { prLabel } from "../src/hub-format.js";
import { CEREMONY_STAGES, type CeremonySnapshot, type CeremonyStage, type SprintBuild, type SprintLoop } from "../src/session-snapshot.js";

const ceremony = (stage: CeremonyStage): CeremonySnapshot => ({ version: 1, stage,
  history: CEREMONY_STAGES.slice(0, CEREMONY_STAGES.indexOf(stage) + 1).map((stage, i) => ({ stage, enteredAt: `2026-01-0${i + 1}T00:00:00Z` })),
});

const names = ["Chick Corea", "George Duke", "Aaron Magner", "Corey Henry", "Jordan Rudess"];
const snapshot: StateSnapshot = {
  teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "external-team",
    seats: names.map((displayName, index) => ({ id: "seat-00" + (index + 1), displayName, handle: displayName.toLowerCase().replace(" ", ""), mattermostUserId: "user-" + (index + 1), roles: [index === 0 ? "Team Lead" : "Developer"] })),
  }],
};

const homed: StateSnapshot = { ...snapshot, teams: [{ ...snapshot.teams[0], homeChannelId: "o9rogqxy7br1zkrcami681sray", project: { github: "satoramoto/indra" } }] };

function harness() {
  let state = snapshot;
  let sessions: SessionReadResult = { connection: "disconnected", sessions: [] };
  const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => sessions });
  return { model, state: (next: StateSnapshot) => { state = next; }, sessions: (next: SessionReadResult) => { sessions = next; } };
}

async function retryHarness(retry?: (target: AssignmentRetry) => Promise<string>) {
  const target: AssignmentRetry = { seatId: "seat-002", goalId: "goal-retry", goal: "Fix the terminal", outcomeId: "outcome-1", title: "Retry failed work", updatedAt: "2026-01-02T00:00:00Z" };
  const live: Record<string, SeatLive> = { "seat-002": { process: "running", retry: { ...target } } };
  const calls: AssignmentRetry[] = [];
  const processes: SeatProcessPort = {
    ensureAll: async () => [], read: async () => live, stop: async () => {}, restart: async () => {},
    retry: async (selected) => {
      calls.push(selected);
      if (retry) return await retry(selected);
      delete live["seat-002"].retry;
      live["seat-002"].assignment = { title: selected.title, status: "queued" };
      return "Re-queued goal-retry/outcome-1 for seat-002.";
    },
  };
  const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes);
  await model.refresh();
  model.seatId = "seat-002";
  return { model, target, live, calls, processes };
}

describe("terminal UI", () => {
  it("names the failed goal and outcome in T's confirmation and queues it only after y", async () => {
    const { model, target, calls } = await retryHarness();
    expect(model.key("t", "T")).toBe("none");
    expect(model.confirm).toEqual({ ...target, action: "retry" });
    await model.retryConfirmed();
    expect(calls).toEqual([]);
    const [revision, setRevision] = createSignal(model.revision);
    for (const size of [{ width: 120, height: 30 }, { width: 80, height: 24 }]) {
      const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, size);
      try {
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Retry failed work · failed · T retry");
        expect(frame).toContain("Retry goal goal-retry: Fix the terminal");
        expect(frame).toContain("Outcome outcome-1: Retry failed work?");
        expect(frame).toContain("y re-queue for seat-002 · n/Esc cancel");
      } finally { setup.renderer.destroy(); }
    }
    expect(model.key("y", "y")).toBe("retry");
    expect(model.confirm).toBeUndefined();
    // Changing the selected seat cannot redirect the confirmed request.
    model.seatId = "seat-003";
    await model.retryConfirmed();
    await model.retryConfirmed();
    expect(calls).toEqual([{ ...target, action: "retry" }]);
    expect(model.notice).toBe("Re-queued goal-retry/outcome-1 for seat-002.");
    model.seatId = "seat-002";
    model.page = "seat";
    setRevision(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 80, height: 24 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Re-queued goal-retry/outcome-1 for seat-002.");
      expect(setup.captureCharFrame()).toContain("Assignment: Retry failed work · queued");
    } finally { setup.renderer.destroy(); }
    model.key("t", "T");
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toBe("No eligible failed assignment for this seat.");
  });

  it.each(["n", "escape", "return", "t"])("cancels a retry with %s without re-queuing it", async (key) => {
    const { model, calls } = await retryHarness();
    model.page = "seat";
    model.key("t", "T");
    expect(model.key(key, key === "t" ? "T" : undefined)).toBe("none");
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toBe("Retry cancelled; nothing changed.");
    await model.retryConfirmed();
    expect(model.key("y", "y")).toBe("none");
    expect(calls).toEqual([]);
  });

  it("binds a confirmation to its original failure and shows a stale-state refusal from the supervisor", async () => {
    const { model, target, live, calls } = await retryHarness(async () => { throw new Error("Sprint goal-retry is pr-open; it no longer accepts retries."); });
    model.key("t", "T");
    live["seat-002"].retry = { ...target, goalId: "goal-newer", outcomeId: "outcome-newer", updatedAt: "2026-01-03T00:00:00Z" };
    await model.refresh();
    expect(model.confirm).toEqual({ ...target, action: "retry" });
    expect(model.key("y", "y")).toBe("retry");
    await model.retryConfirmed();
    expect(calls).toEqual([{ ...target, action: "retry" }]);
    expect(model.notice).toBe("Could not retry: Sprint goal-retry is pr-open; it no longer accepts retries.");
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(model.notice);
    } finally { setup.renderer.destroy(); }
  });

  it("blocks repeated retry requests while the confirmed request is still running", async () => {
    let finish = (_message: string) => {};
    const { model, calls } = await retryHarness(() => new Promise<string>((done) => { finish = done; }));
    model.key("t", "T");
    model.key("y", "y");
    const pending = model.retryConfirmed();
    model.key("t", "T");
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toBe("A retry is already in progress.");
    expect(model.key("y", "y")).toBe("none");
    await model.retryConfirmed();
    expect(calls).toHaveLength(1);
    finish("Re-queued once.");
    await pending;
    expect(model.notice).toBe("Re-queued once.");
  });

  it("requires a Developer seat, an eligible failure, and a supervisor that supports retry", async () => {
    const { model, processes } = await retryHarness();
    model.seatId = "seat-001";
    model.key("t", "T");
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toContain("Choose a Developer seat");
    model.seatId = "seat-002";
    model.key("t", "t");
    expect(model.confirm).toBeUndefined();
    model.page = "teams";
    model.key("t", "T");
    expect(model.confirm).toBeUndefined();
    model.page = "seat";
    delete processes.retry;
    model.key("t", "T");
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toBe("Assignments cannot be retried from this screen.");
  });

  it("shows five stable seats without inventing occupancy, then keeps selection during automatic updates", async () => {
    const fixture = harness();
    await fixture.model.refresh();
    expect(fixture.model.page).toBe("team");
    expect(fixture.model.team?.seats.map((seat) => seat.displayName)).toEqual([...names].sort());
    expect(fixture.model.sessionResult.connection).toBe("disconnected");
    fixture.model.key("down");
    expect(fixture.model.seat?.displayName).toBe("Chick Corea");
    fixture.sessions({ connection: "connected", sessions: [{
      id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "running", engine: "codex",
      sessionId: "codex-123", goal: "Plan the next cycle", stage: "clarifying", recentActivity: ["Read the brief"],
      attach: { kind: "tmux", target: "indra-bridge:indra-goal-1" },
    }] });
    expect(await fixture.model.refresh()).toBe(true);
    expect(fixture.model.seat?.displayName).toBe("Chick Corea");
    expect(fixture.model.sessionsFor("seat-003")).toEqual([]);
    fixture.model.key("return");
    expect(fixture.model.attachTarget()).toBe("indra-bridge:indra-goal-1");
    // i focuses the session pane and asks to drive it; Esc leaves before the check answers.
    expect(fixture.model.key("i", "i")).toBe("drive");
    expect(fixture.model.key("escape")).toBe("release");
    fixture.model.key("b");
    fixture.model.key("b");
    expect(fixture.model.page).toBe("teams");
    fixture.model.key("return");
    expect(fixture.model.page).toBe("team");
  });

  it("preserves the last good roster and labels read failures", async () => {
    let reads = 0;
    const model = new TerminalUiModel(new StateInventory({ read: async () => {
      if (++reads > 1) throw new Error("state checkout unreadable");
      return snapshot;
    } }), { readSessions: async () => { throw new Error("bridge unavailable"); } });
    await model.refresh();
    await model.refresh();
    expect(model.team?.seats).toHaveLength(5);
    expect(model.stateError).toContain("unreadable");
    expect(model.sessionResult.connection).toBe("error");
    expect(model.key("a")).toBe("none");
  });

  it("renders a colored Solid frame and reacts to a new runtime snapshot", async () => {
    const fixture = harness();
    fixture.sessions({ connection: "connected", sessions: [] });
    await fixture.model.refresh();
    const [revision, setRevision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const initial = setup.captureCharFrame();
      for (const name of names) expect(initial).toContain(name);
      expect(initial).toContain("NO ACTIVE SESSION");
      fixture.sessions({ connection: "connected", sessions: [{
        id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "running", engine: "codex",
        sessionId: "codex-123", goal: "Plan the next cycle", stage: "clarifying", recentActivity: ["Old note", "Read the brief"],
        attach: { kind: "tmux", target: "indra-bridge:indra-goal-1" },
      }] });
      await fixture.model.refresh();
      setRevision(fixture.model.revision);
      await setup.renderOnce();
      const updated = setup.captureCharFrame();
      expect(updated).toContain("RUNNING SESSION");
      expect(updated).toContain("Latest: Read the brief");
      expect(updated).not.toContain("Latest: Old note");
      fixture.model.key("down");
      fixture.model.key("enter");
      setRevision(fixture.model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Planning detail: clarifying");
      fixture.model.key("b");
      setRevision(fixture.model.revision);
      const narrow = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 80, height: 24 });
      try {
        await narrow.renderOnce();
        const frame = narrow.captureCharFrame();
        for (const name of names) expect(frame).toContain(name);
      } finally { narrow.renderer.destroy(); }
    } finally {
      setup.renderer.destroy();
    }
  });


  it("keeps planning context visible with no Codex session and marks disconnected occupancy unknown", async () => {
    const fixture = harness();
    fixture.sessions({ connection: "disconnected", sessions: [{
      id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "idle", engine: "codex",
      goal: "Plan the next cycle", stage: "clarifying", recentActivity: ["Earlier response"],
      attach: { kind: "tmux", target: "indra-bridge:indra-goal-1" },
    }] });
    await fixture.model.refresh();
    fixture.model.key("down");
    expect(fixture.model.attachTarget()).toBeUndefined();
    fixture.model.key("return");
    const [revision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("OCCUPANCY UNKNOWN");
      expect(frame).toContain("Earlier response");
      expect(frame).toContain("Planning goal: Plan the next cycle");
      expect(frame).toContain("Planning detail: clarifying");
      expect(frame).toContain("Live session: not available");
    } finally { setup.renderer.destroy(); }
  });

  it("shows runtime metadata errors without a session ID", async () => {
    const fixture = harness();
    fixture.sessions({ connection: "connected", sessions: [{
      id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "error", engine: "codex",
      goal: "Plan the next cycle", stage: "clarifying", recentActivity: ["Runtime metadata is unreadable."],
    }] });
    await fixture.model.refresh();
    const [revision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("RUNTIME RECORD ERROR");
      expect(frame).toContain("Runtime metadata is unreadable.");
    } finally { setup.renderer.destroy(); }
  });

  it("surfaces a newer goal error while an older saved session still occupies the seat", async () => {
    const fixture = harness();
    fixture.sessions({ connection: "connected", sessions: [
      { id: "goal-old", teamId: "team-001", seatId: "seat-001", status: "idle", engine: "codex", sessionId: "codex-old", goal: "Old goal", stage: "clarifying", updatedAt: "2026-01-01T00:00:00Z", recentActivity: ["Old activity"] },
      { id: "goal-new", teamId: "team-001", seatId: "seat-001", status: "error", engine: "codex", goal: "New goal", stage: "drafting", updatedAt: "2026-01-02T00:00:00Z", recentActivity: ["Runtime metadata is unreadable."] },
    ] });
    await fixture.model.refresh();
    const [revision, setRevision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("RUNTIME ERROR · SAVED SESSION");
      expect(frame).toContain("Latest: Runtime metadata is unreadable.");
      expect(frame).not.toContain("Latest: Old activity");
      fixture.model.key("down");
      fixture.model.key("return");
      setRevision(fixture.model.revision);
      await setup.renderOnce();
      const detail = setup.captureCharFrame();
      expect(detail).toContain("Planning goal: New goal");
      expect(detail).toContain("Planning detail: drafting");
    } finally { setup.renderer.destroy(); }
  });

  it("shows each seat's process, held assignment and thread activity, and stops or restarts the selected seat", async () => {
    const controls: string[] = [];
    const live: Record<string, SeatLive> = {
      "seat-001": { process: "running", attach: { kind: "tmux", target: "indra-abc:chick-abc" } },
      "seat-002": { process: "running", assignment: { title: "Second", status: "in-review", prUrl: "https://github.com/o/r/pull/2" }, activity: { message: "Opened PR 2", at: "2026-01-02T00:00:00Z" }, attach: { kind: "tmux", target: "indra-abc:dev-seat-002-abc" } },
      "seat-003": { process: "no credential" },
      "seat-004": { process: "stopped" },
      "seat-005": { process: "running", assignment: { title: "Third", status: "queued" } },
    };
    const processes: SeatProcessPort = {
      ensureAll: async () => [],
      read: async () => live,
      stop: async (seatId) => { controls.push("stop " + seatId); },
      restart: async (seatId) => { controls.push("restart " + seatId); },
    };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes);
    await model.refresh();
    const [revision, setRevision] = createSignal(model.revision);
    const wide = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await wide.renderOnce();
      const frame = wide.captureCharFrame();
      expect(frame).toMatch(/George Duke +Developer +RUNNING/);
      expect(frame).toContain("Second · in-review 🐙 #2");
      expect(frame).toContain("Latest: Opened PR 2");
      expect(frame).toMatch(/Aaron Magner +Developer +NO CREDENTIAL/);
      expect(frame).toMatch(/Corey Henry +Developer +STOPPED/);
      expect(frame).toContain("Third · queued");
      expect(frame).toContain("No thread activity yet.");
    } finally { wide.renderer.destroy(); }
    const narrow = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 80, height: 24 });
    try {
      await narrow.renderOnce();
      const frame = narrow.captureCharFrame();
      for (const name of names) expect(frame).toContain(name);
      expect(frame).toContain("NO CREDENTIAL");
      expect(frame).toContain("Second · in-review");
    } finally { narrow.renderer.destroy(); }

    for (const _ of [1, 2, 3]) model.key("down");
    expect(model.seat?.id).toBe("seat-002");
    expect(model.key("x")).toBe("stop");
    await model.control("stop");
    expect(model.key("s")).toBe("restart");
    await model.control("restart");
    expect(controls).toEqual(["stop seat-002", "restart seat-002"]);
    expect(model.notice).toContain("Restarted George Duke");
    model.key("enter");
    expect(model.attachTarget()).toBe("indra-abc:dev-seat-002-abc");
    setRevision(model.revision);
    const detail = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 80, height: 24 });
    try {
      await detail.renderOnce();
      const frame = detail.captureCharFrame();
      expect(frame).toContain("Process: running (seat runner)");
      expect(frame).toContain("Assignment: Second · in-review");
    } finally { detail.renderer.destroy(); }
  });

  it("shows on the seat which bot cannot join which home channel", async () => {
    const problem = "@chickcorea can't join the home channel home (HTTP 403): add it or make the channel public.";
    const processes: SeatProcessPort = { ensureAll: async () => [], read: async () => ({ "seat-001": { process: "no channel", problem }, "seat-002": { process: "running" } }), stop: async () => {}, restart: async () => {} };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes);
    await model.refresh();
    const [revision] = createSignal(model.revision);
    for (const size of [{ width: 120, height: 30 }, { width: 80, height: 24 }]) {
      const view = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, size);
      try {
        await view.renderOnce();
        const frame = view.captureCharFrame();
        expect(frame).toContain("NO CHANNEL");
        expect(frame).toContain("@chickcorea can't join the home channel home");
      } finally { view.renderer.destroy(); }
    }
  });

  it("syncs the state checkout before hosting processes, refreshes when state changed, and shows the last result", async () => {
    const calls: string[] = [];
    let state = snapshot;
    const results: StateSyncResult[] = [
      { outcome: "synced", changed: true, message: "Pulled 1 commit from origin/main.", at: "2026-09-28T10:00:05.000Z" },
      { outcome: "conflict", changed: false, message: "Local state commits conflict with origin/main; the checkout is unchanged.", at: "2026-09-28T10:01:05.000Z" },
    ];
    const sync: StateSyncPort = { sync: async () => {
      calls.push("sync");
      const next = results.shift()!;
      if (next.changed) state = { ...snapshot, teams: [{ ...snapshot.teams[0], displayName: "Yahaha Merged" }] };
      return next;
    } };
    const processes: SeatProcessPort = { ensureAll: async () => { calls.push("ensureAll"); return []; }, read: async () => ({}), stop: async () => {}, restart: async () => {} };
    const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes, undefined, sync);
    await model.refresh();
    expect(model.syncLine()?.text).toContain("syncing with the remote");
    await model.start();
    expect(calls).toEqual(["sync", "ensureAll"]);
    expect(model.team?.displayName).toBe("Yahaha Merged");
    expect(model.syncLine()).toEqual({ ok: true, text: "State sync 10:00:05 UTC · Pulled 1 commit from origin/main." });
    await model.syncState();
    expect(model.syncLine()?.ok).toBe(false);
    const [revision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("State sync 10:01:05 UTC · CONFLICT · Local state commits conflict with origin/main");
    } finally { setup.renderer.destroy(); }
    const failing = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, undefined, undefined, { sync: async () => { throw new Error("lock timeout"); } });
    await failing.syncState();
    expect(failing.syncLine()?.text).toContain("ERROR · State sync failed: lock timeout");
  });

  it("shows the running version and update state, restarts outdated processes, and reloads only when nothing is in flight", async () => {
    const calls: string[] = [];
    let onDisk = { id: "build-1", sha: "abc1234def", builtAt: "now" };
    let result: UpdateResult = { outcome: "up-to-date", message: "up to date at abc1234", at: "now" };
    const update: UpdatePort = { running: { id: "build-1", sha: "abc1234def", builtAt: "now" }, canReload: true, check: async () => { calls.push("check"); return result; }, current: async () => onDisk };
    let live: Record<string, SeatLive> = { "seat-002": { process: "running", updatePending: true } };
    const processes: SeatProcessPort = { ensureAll: async () => { calls.push("ensureAll"); return []; }, read: async () => live, stop: async () => {}, restart: async () => {}, upgrade: async () => { calls.push("upgrade"); return { pending: ["seat-002"], problems: [] }; } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes, undefined, undefined, update);
    model.restore({ page: "seat", teamId: "team-001", seatId: "seat-003" });
    await model.refresh();
    expect([model.page, model.seat?.id]).toEqual(["seat", "seat-003"]);
    await model.start();
    expect(calls).toEqual(["ensureAll", "check", "upgrade"]);
    expect(model.updateLine()).toEqual({ ok: true, text: "Indra abc1234 · update pending · George Duke restart when idle" });
    live = { "seat-002": { process: "running" } };
    await model.refresh();
    expect(model.updateLine()?.text).toBe("Indra abc1234 · up to date");
    result = { outcome: "up-to-date", message: "up to date at abc1234", at: "now", branch: "hotfix", sha: "abc1234def" };
    await model.updateCode();
    expect(model.updateLine()?.text).toBe("Indra abc1234 · up to date · Live from local hotfix @ abc1234");

    result = { outcome: "blocked", message: "the Indra checkout has uncommitted changes", at: "now" };
    await model.updateCode();
    expect(model.updateLine()).toEqual({ ok: false, text: "Indra abc1234 · blocked · the Indra checkout has uncommitted changes" });

    // A new build lands while the owner is typing a goal: the reload waits until the input closes.
    result = { outcome: "built", message: "built fed4321", at: "now" };
    onDisk = { id: "build-2", sha: "fed4321abc", builtAt: "later" };
    model.input = { value: "half a goal" };
    calls.length = 0;
    await model.updateCode();
    expect(calls).toEqual(["check"]);
    expect(model.reloadWanted).toBe(true);
    expect(model.readyToReload()).toBe(false);
    expect(model.updateLine()?.text).toBe("Indra abc1234 · update pending · reloads when idle");
    model.key("escape");
    expect(model.readyToReload()).toBe(true);
    expect(model.view()).toEqual({ page: "seat", teamId: "team-001", seatId: "seat-003" });
  });

  it("holds restarts, goals and reloads while an update runs, and refuses them after a failed dependency install", async () => {
    const calls: string[] = [];
    let finish: (result: UpdateResult) => void = () => {};
    const update: UpdatePort = { running: { id: "build-1", sha: "abc1234def", builtAt: "now" }, canReload: true, check: () => new Promise((done) => { calls.push("check"); finish = done; }), current: async () => ({ id: "build-2", sha: "fed4321abc", builtAt: "now" }) };
    const processes: SeatProcessPort = { ensureAll: async () => [], read: async () => ({}), stop: async () => {}, restart: async () => { calls.push("restart"); }, upgrade: async () => { calls.push("upgrade"); return { pending: [], problems: [] }; } };
    const goals: GoalStarter = { start: async () => { calls.push("start"); return "ok"; }, approve: async () => { calls.push("approve"); return "ok"; }, propose: async () => { calls.push("propose"); return "ok"; } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes, goals, undefined, update);
    await model.refresh();
    model.restore({ page: "seat", teamId: "team-001", seatId: "seat-002" });
    await model.refresh();

    const updating = model.updateCode();
    const restart = model.control("restart");
    model.input = { value: "a goal" };
    const submit = model.submitInput();
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual(["check"]);
    expect(model.readyToReload()).toBe(false);
    finish({ outcome: "blocked", message: "dependency install failed: npm ci failed: ENOSPC", at: "now", installFailed: true });
    await Promise.all([updating, restart, submit]);
    // The install failed: no reload, no restarts, and the held actions do not run on a half-installed node_modules.
    expect(calls).toEqual(["check"]);
    expect(model.reloadWanted).toBe(false);
    expect(model.updateLine()).toEqual({ ok: false, text: "Indra abc1234 · blocked: dependency install failed: npm ci failed: ENOSPC · retrying on the next check" });

    // The next check installs and builds: the new build is live, then held actions run again.
    const retry = model.updateCode();
    const again = model.control("restart");
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual(["check", "check"]);
    finish({ outcome: "built", message: "built fed4321", at: "now" });
    await Promise.all([retry, again]);
    expect(calls).toEqual(["check", "check", "restart"]);
    expect(model.input?.value).toBe("a goal");
    expect(model.readyToReload()).toBe(false);
    model.key("escape");
    expect(model.readyToReload()).toBe(true);
  });

  it("pauses and resumes auto-update with U, and rolls back with R after a y/n naming both versions", async () => {
    const calls: string[] = [];
    let paused = false;
    let onDisk = { id: "build-2", sha: "fed4321abc", builtAt: "now" };
    let previous: { build: string; from: typeof onDisk; to: typeof onDisk } | undefined;
    let rolledBack: { sha: string; fromSha: string } | undefined;
    const update: UpdatePort = {
      running: onDisk, canReload: false, current: async () => onDisk,
      check: async () => { calls.push(paused ? "check (paused)" : "check"); return paused ? { outcome: "paused", message: "2 new commits waiting on origin/main", at: "now" } : { outcome: "up-to-date", message: "", at: "now" }; },
      paused: async () => paused,
      setPaused: async (value) => { calls.push(value ? "pause" : "resume"); paused = value; },
      rollbackPlan: async () => previous,
      rollback: async () => {
        calls.push("rollback");
        if (!previous) return { rolledBack: false, message: "No previous build to roll back to; nothing changed." };
        paused = true;
        rolledBack = { sha: previous.to.sha, fromSha: previous.from.sha };
        onDisk = previous.to;
        return { rolledBack: true, message: "Rolled back to abc1234 from fed4321; updates paused (U resumes)." };
      },
      rolledBack: async () => rolledBack,
    };
    const processes: SeatProcessPort = { ensureAll: async () => [], read: async () => ({}), stop: async () => {}, restart: async () => {}, upgrade: async () => { calls.push("upgrade"); return { pending: [], problems: [] }; } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes, undefined, undefined, update);
    await model.refresh();

    // U pauses; the setting is read back from the port, as a reloaded UI would.
    expect(model.key("u", "U")).toBe("pause");
    await model.togglePause();
    expect(paused).toBe(true);
    const reloaded = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes, undefined, undefined, update);
    await reloaded.refresh();
    await reloaded.updateCode();
    expect(reloaded.paused).toBe(true);
    expect(reloaded.updateLine()?.text).toBe("Indra fed4321 · updates paused · 2 new commits waiting on origin/main");
    // r still checks once and says it is paused.
    expect(reloaded.key("r")).toBe("refresh");
    expect(reloaded.notice).toContain("Updates are paused");
    // U again resumes and checks at once.
    calls.length = 0;
    await model.togglePause();
    expect(calls).toEqual(["resume", "check", "upgrade"]);
    expect(model.updateLine()?.text).toBe("Indra fed4321 · up to date");

    // R without a previous build says so and changes nothing.
    expect(model.key("r", "R")).toBe("ask-rollback");
    await model.askRollback();
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toBe("No previous build to roll back to; nothing changed.");

    // R with a previous build asks, naming both versions; any other key cancels.
    previous = { build: "abc1234def-1", from: onDisk, to: { id: "build-1", sha: "abc1234def", builtAt: "then" } };
    await model.askRollback();
    expect(model.confirm).toEqual({ action: "rollback", from: "fed4321", to: "abc1234" });
    const [revision, setRevision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Roll back from fed4321 to abc1234 and pause auto-update? y roll back");
      expect(model.key("n", "n")).toBe("none");
      expect(model.notice).toBe("Rollback cancelled; nothing changed.");
      await model.askRollback();
      calls.length = 0;
      expect(model.key("y", "y")).toBe("rollback");
      await model.rollbackConfirmed();
      // Rolled back and paused; hosted processes restart at safe points as after an update.
      expect(calls).toEqual(["rollback", "upgrade"]);
      expect(model.paused).toBe(true);
      expect(model.reloadWanted).toBe(true);
      expect(model.notice).toContain("Rolled back to abc1234 from fed4321");
      expect(model.updateLine()?.text).toBe("Indra fed4321 · rolled back to abc1234 from fed4321 · update pending · new build ready; restart Indra to use it");
      // The UI started on the rolled-back build shows it with the pause.
      const after = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, processes, undefined, undefined, { ...update, running: onDisk });
      await after.updateCode();
      expect(after.updateLine()?.text).toBe("Indra abc1234 · rolled back to abc1234 from fed4321 · updates paused · 2 new commits waiting on origin/main");
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Auto-update paused · U resumes");
    } finally { setup.renderer.destroy(); }
  });

  it("starts a new planning goal from a typed line alone, with the team's home channel and project from state", async () => {
    const started: string[] = [];
    const goals: GoalStarter = {
      start: async (goal) => { started.push(goal); return "Planning goal plan-1: https://example/pl/root"; },
      approve: async () => { throw new Error("not used"); },
      propose: async () => { throw new Error("not used"); },
    };
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, undefined, goals);
    await model.refresh();
    const type = (text: string) => { for (const char of text) model.key(char === " " ? "space" : char.toLowerCase(), char); };
    model.key("n");
    expect(model.input).toEqual({ value: "" });
    type("Fix tsx");
    model.key("backspace");
    model.key("backspace");
    type("ests");
    expect(model.key("q", "q")).toBe("none");
    expect(model.input?.value).toBe("Fix testsq");
    model.key("backspace");
    const [revision, setRevision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("New planning goal: Fix tests▏");
      expect(frame).toContain("satoramoto/indra · home channel");
      expect(model.key("return")).toBe("submit");
      await model.submitInput();
      expect(started).toEqual(["Fix tests"]);
      expect(model.input).toBeUndefined();
      expect(model.notice).toContain("Planning goal plan-1");
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("channel ID");
      model.key("n");
      type("Second goal");
      expect(model.key("enter")).toBe("submit");
      await model.submitInput();
      expect(started).toEqual(["Fix tests", "Second goal"]);
      model.key("n");
      model.key("escape");
      expect(model.input).toBeUndefined();

      // Long goals: typing past 1,000 characters keeps accepting input, and Escape still cancels.
      model.key("n");
      type("a".repeat(1500));
      expect(model.input?.value.length).toBe(1500);
      model.key("escape");
      expect(model.input).toBeUndefined();
      // Enter submits the full long text; the box wraps and shows the cursor.
      model.key("n");
      const long = "word ".repeat(600) + "end";
      type(long);
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("end▏");
      expect(model.key("return")).toBe("submit");
      await model.submitInput();
      expect(started.at(-1)).toBe(long);
      // At the limit, extra characters (typed or pasted) are dropped with a visible hint, and keys still work.
      model.key("n");
      model.key("x", "x".repeat(GOAL_INPUT_LIMIT - 1));
      type("yz");
      expect(model.input?.value).toBe("x".repeat(GOAL_INPUT_LIMIT - 1) + "y");
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Limit reached");
      model.key("escape");
      expect(model.input).toBeUndefined();
    } finally { setup.renderer.destroy(); }
  });

  it("names the missing state field instead of asking for a channel or project", async () => {
    const goals: GoalStarter = { start: async () => { throw new Error("must not start"); }, approve: async () => { throw new Error("not used"); }, propose: async () => { throw new Error("not used"); } };
    const cases: [StateSnapshot, string[], string[]][] = [
      [snapshot, ["externalIdentities.mattermost.homeChannelId", "project.github"], []],
      [{ ...homed, teams: [{ ...homed.teams[0], homeChannelId: undefined }] }, ["externalIdentities.mattermost.homeChannelId"], ["project.github"]],
      [{ ...homed, teams: [{ ...homed.teams[0], project: undefined }] }, ["project.github"], ["homeChannelId"]],
    ];
    for (const [state, named, unnamed] of cases) {
      const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, undefined, goals);
      await model.refresh();
      model.key("n");
      expect(model.input).toBeUndefined();
      expect(model.notice).toContain("Cannot start a planning goal: Team Yahaha has no");
      for (const field of named) expect(model.notice).toContain(field);
      for (const field of unnamed) expect(model.notice).not.toContain(field);
    }
  });

  it("approves the selected seat's proposal awaiting review with A and a y/n confirmation", async () => {
    const approvals: string[] = [];
    const goals: GoalStarter = { start: async () => "unused", approve: async (goalId) => { approvals.push(goalId); stage = "approved"; return `Approved goal ${goalId}: 2 outcome(s) queued for Developer seats.`; }, propose: async () => { throw new Error("not used"); } };
    let stage = "awaiting-review";
    const session = () => ({ id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "idle" as const, engine: "codex" as const, sessionId: "codex-1", goal: "Plan the next cycle", stage, ceremony: ceremony(stage === "approved" ? "implement" : "proposal"), updatedAt: "2026-01-02T00:00:00Z", recentActivity: [] });
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions: [session()] }) }, undefined, goals);
    await model.refresh();
    expect(model.key("a", "A")).toBe("none");
    expect(model.notice).toContain("Open Chick's seat");
    model.key("down");
    model.key("return");
    expect(model.seat?.id).toBe("seat-001");
    model.key("a", "A");
    expect(model.confirm).toEqual({ action: "approve", goalId: "goal-1", goal: "Plan the next cycle", updatedAt: "2026-01-02T00:00:00Z" });
    const [revision, setRevision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Approve the proposal for goal-1");
      expect(frame).toContain("y approve");
      expect(frame).toContain("A approves it here");
      // Anything but y cancels.
      expect(model.key("n", "n")).toBe("none");
      expect(model.confirm).toBeUndefined();
      expect(model.notice).toContain("cancelled");
      await model.approveConfirmed();
      expect(approvals).toEqual([]);
      model.key("a", "A");
      expect(model.key("y", "y")).toBe("approve");
      await model.approveConfirmed();
      expect(approvals).toEqual(["goal-1"]);
      expect(model.notice).toBe("Approved goal goal-1: 2 outcome(s) queued for Developer seats.");
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("A approves it here");
      model.key("a", "A");
      expect(model.confirm).toBeUndefined();
      expect(model.notice).toContain("No proposal is awaiting review");
      // Lowercase a still attaches rather than approving.
      expect(model.key("a", "a")).not.toBe("approve");
    } finally { setup.renderer.destroy(); }
  });

  it("opens, merges and rolls back a sprint with I, M and V, each after a y/n confirmation", async () => {
    const calls: string[] = [];
    let sprint: TerminalSession["sprint"] = "collecting";
    const goals: GoalStarter = { start: async () => "unused", approve: async () => "unused", propose: async () => "unused", sprint: async (action, goalId) => { calls.push(`${action} ${goalId}`); return `ran ${action}`; } };
    const prUrl = "https://github.com/example/indra/pull/80";
    const session = (): TerminalSession => ({ id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "idle", engine: "codex", sessionId: "codex-1", goal: "Plan the next cycle", stage: "approved", updatedAt: "2026-01-02T00:00:00Z", recentActivity: [], sprint,
      loop: { stage: "release", ceremony: ceremony(sprint === "collecting" ? "implement" : "release"),
        tickets: [{ id: "one", title: "Merged outcome", seatId: "seat-002", status: "merged" }],
        integration: { branch: "sprint/goal-1", baseSha: "a".repeat(40), status: sprint === "revert-open" ? "merged" : sprint!, prUrl,
          ...(sprint === "revert-open" ? { revertPrUrl: "https://github.com/example/indra/pull/81" } : {}) } } });
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions: [session()] }) }, undefined, goals);
    await model.refresh();
    model.key("down");
    model.key("return");
    expect(model.key("m", "M")).toBe("none");
    expect(model.notice).toContain("No sprint has an eligible release, revert or retro PR open");
    model.key("i", "I");
    expect(model.confirm).toEqual({ action: "integrate", goalId: "goal-1", goal: "Plan the next cycle" });
    const [revision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 160, height: 30 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Open the integration PR into main");
      // While the y/n is open the shortcut bar shows its keys; the ceremony key is offered on the seat screen.
      expect(setup.captureCharFrame()).toContain("y confirm · any other key cancel");
      expect(model.ceremonyKeys()).toContain("I integrate");
    } finally { setup.renderer.destroy(); }
    expect(model.key("n", "n")).toBe("none");
    expect(model.notice).toContain("cancelled");
    await model.sprintConfirmed();
    expect(calls).toEqual([]);
    model.key("i", "I");
    expect(model.key("y", "y")).toBe("sprint");
    await model.sprintConfirmed();
    sprint = "pr-open";
    await model.refresh();
    model.key("m", "M");
    expect(model.confirm).toEqual({ action: "merge", goalId: "goal-1", goal: "Plan the next cycle", mergeKind: "release", prUrl });
    expect(model.key("y", "y")).toBe("sprint");
    await model.sprintConfirmed();
    sprint = "merged";
    await model.refresh();
    // R stays the self-update rollback; V rolls the sprint back.
    model.key("v", "V");
    expect(model.confirm).toEqual({ action: "revert", goalId: "goal-1", goal: "Plan the next cycle", prUrl });
    expect(model.key("y", "y")).toBe("sprint");
    await model.sprintConfirmed();
    sprint = "revert-open";
    await model.refresh();
    model.key("m", "M");
    expect(model.confirm).toMatchObject({ action: "merge", mergeKind: "revert", prUrl: "https://github.com/example/indra/pull/81" });
    expect(model.key("y", "y")).toBe("sprint");
    await model.sprintConfirmed();
    expect(calls).toEqual(["integrate goal-1", "merge goal-1", "rollback goal-1", "merge goal-1"]);
    expect(model.notice).toBe("ran merge");
  });

  it("requests Chick's proposal for the newest clarifying goal with P and a y/n confirmation", async () => {
    const requests: string[] = [];
    const goals: GoalStarter = { start: async () => "unused", approve: async () => { throw new Error("must not approve"); }, propose: async (goalId) => { requests.push(goalId); stage = "drafting"; return `Requested a proposal for goal ${goalId}; Chick drafts it on the bridge's next poll and posts it in the thread.`; } };
    let stage = "clarifying";
    const record = (id: string, goal: string, updatedAt: string, at = stage) => ({ id, teamId: "team-001", seatId: "seat-001", status: "idle" as const, engine: "codex" as const, sessionId: "codex-" + id, goal, stage: at, ceremony: ceremony(at === "clarifying" ? "planning" : "proposal"), updatedAt, recentActivity: [] });
    const sessions = () => [record("goal-old", "Old goal", "2026-01-01T00:00:00Z", "clarifying"), record("goal-2", "Plan the next cycle", "2026-01-03T00:00:00Z")];
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions: sessions() }) }, undefined, goals);
    await model.refresh();
    expect(model.key("p", "P")).toBe("none");
    expect(model.notice).toContain("Open Chick's seat");
    model.key("down");
    model.key("return");
    expect(model.seat?.id).toBe("seat-001");
    model.key("p", "P");
    expect(model.confirm).toEqual({ action: "propose", goalId: "goal-2", goal: "Plan the next cycle" });
    const [revision, setRevision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 140, height: 40 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Request Chick's proposal for goal-2");
      expect(frame).toContain("y request");
      expect(model.ceremonyKeys()).toContain("P propose");
      expect(model.ceremonyKeys()).not.toContain("A approve");
      expect(frame).toContain("P requests Chick's proposal here");
      // Anything but y cancels, and nothing runs.
      expect(model.key("n", "n")).toBe("none");
      expect(model.confirm).toBeUndefined();
      expect(model.notice).toBe("Proposal request cancelled; nothing changed.");
      await model.proposeConfirmed();
      expect(requests).toEqual([]);
      model.key("p", "P");
      expect(model.key("y", "y")).toBe("propose");
      await model.proposeConfirmed();
      expect(requests).toEqual(["goal-2"]);
      expect(model.notice).toContain("Requested a proposal for goal goal-2");
      // With the newest goal drafting, P falls back to the older clarifying goal; lowercase p does nothing.
      model.key("p", "P");
      expect(model.confirm).toMatchObject({ action: "propose", goalId: "goal-old" });
      model.key("n", "n");
      expect(model.key("p", "p")).toBe("none");
      expect(model.confirm).toBeUndefined();
      setRevision(model.revision);
    } finally { setup.renderer.destroy(); }
  });

  it("shows the CLI's reason when a proposal cannot be requested", async () => {
    const goals: GoalStarter = { start: async () => "unused", approve: async () => "unused", propose: async () => { throw new Error("Goal goal-1 is at the drafting stage; a proposal can be requested only while it is clarifying."); } };
    let sessions: TerminalSession[] = [];
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions }) }, undefined, goals);
    await model.refresh();
    model.key("down");
    model.key("return");
    model.key("p", "P");
    expect(model.confirm).toBeUndefined();
    expect(model.notice).toBe("No goal is being clarified for this seat.");
    sessions = [{ ...projectedSession("goal-1", { stage: "planning", ceremony: ceremony("planning"), tickets: [] }), stage: "clarifying" }];
    await model.refresh();
    model.key("p", "P");
    expect(model.key("y", "y")).toBe("propose");
    await model.proposeConfirmed();
    expect(model.notice).toBe("Could not request a proposal for goal-1: Goal goal-1 is at the drafting stage; a proposal can be requested only while it is clarifying.");
  });

});

const projectedSession = (id: string, loop: SprintLoop): TerminalSession => ({
  id, teamId: "team-001", seatId: "seat-001", goal: `Sprint ${id}`, status: "idle", engine: "codex", stage: "approved", recentActivity: [], loop,
});
const ticketLoop: SprintLoop = {
  stage: "implement", ceremony: ceremony("implement"),
  tickets: (["queued", "building", "in review", "merged", "failed"] as const).map((status, index) => ({
    id: `ticket-${index}`, title: `Outcome ${index} stays visible`, seatId: "seat-002", status, prUrl: `https://github.com/example/indra/pull/${index + 30}`,
  })),
  integration: { branch: "sprint/goal-one", baseSha: "a".repeat(40), status: "collecting" },
};

async function scrollFrames(setup: Awaited<ReturnType<typeof testRender>>, id: string): Promise<string[]> {
  const scroll = setup.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
  expect(scroll).toBeDefined();
  const frames: string[] = [];
  for (let top = 0; top < scroll.scrollHeight; top += 5) {
    scroll.scrollTo(top);
    await setup.renderOnce();
    frames.push(setup.captureCharFrame().split("\n").map((line) => line.slice(scroll.x, scroll.x + scroll.width)).join("\n"));
  }
  return frames;
}
const compactFrame = (text: string) => text.replace(/[\s│┃║█▀▄]/g, "");
const visibleIn = (frames: string[], text: string) => frames.some((frame) => compactFrame(frame).includes(compactFrame(text)));

function ceremonySession(stage: CeremonyStage, id = "goal-ceremony"): TerminalSession {
  const prUrl = "https://github.com/example/indra/pull/200";
  return { ...projectedSession(id, {
    stage, ceremony: ceremony(stage),
    tickets: stage === "planning" || stage === "proposal" ? [] : [{ id: "outcome-1", title: "Recorded implementation", seatId: "seat-002", status: "merged", prUrl: "https://github.com/example/indra/pull/199" }],
    ...(stage === "planning" || stage === "proposal" ? {} : { integration: {
      branch: `sprint/${id}`, baseSha: "a".repeat(40), status: stage === "implement" ? "collecting" as const : stage === "release" ? "pr-open" as const : "merged" as const,
      ...(stage !== "implement" ? { prUrl } : {}), ...(stage === "retro" ? { mergedSha: "b".repeat(40) } : {}),
    } }),
    ...(stage === "retro" ? { release: { kind: "release-running" as const, prUrl, mergedSha: "b".repeat(40), buildSha: "b".repeat(40), runningSha: "b".repeat(40), runningAt: "2026-01-05T00:00:00Z" }, retro: { status: "pending" as const } } : {}),
  }), stage: stage === "planning" ? "clarifying" : stage === "proposal" ? "awaiting-review" : "approved", updatedAt: "2026-01-05T00:00:00Z" };
}

function closeSession(session: TerminalSession): TerminalSession {
  const closed = structuredClone(session);
  closed.loop!.ceremony!.closure = { closedAt: "2026-01-06T00:00:00Z", evidence: {
    path: `docs/retros/${session.id}.md`, prUrl: "https://github.com/example/indra/pull/201", publishedAt: "2026-01-06T00:00:00Z",
  } };
  return closed;
}

async function ceremonyHarness(initial: TerminalSession[]) {
  let sessions = initial;
  let unreadable = false;
  const goals: GoalStarter = { start: vi.fn(async () => "Goal started."), propose: vi.fn(async () => "Proposal requested."), approve: vi.fn(async () => "Plan approved."), sprint: vi.fn(async () => "PR merged.") };
  const state = new StateInventory({ read: async () => ({ ...homed, sprints: [] }) });
  const reader = { readSessions: async (): Promise<SessionReadResult> => {
    if (unreadable) throw new Error("State cannot be read.");
    return { connection: "disconnected", sessions: structuredClone(sessions) };
  } };
  const model = new TerminalUiModel(state, reader, undefined, goals);
  await model.refresh();
  model.restore({ page: "seat", teamId: "team-001", seatId: "seat-001" });
  return { model, goals, state, reader, sessions: (next: TerminalSession[]) => { sessions = next; }, unreadable: () => { unreadable = true; } };
}

describe("persisted ceremony and allowed actions", () => {
  it.each(CEREMONY_STAGES)("shows the same %s ceremony in team, lead and Developer views", async (stage) => {
    const fixture = await ceremonyHarness([ceremonySession(stage)]);
    // A stale legacy projection must not override durable ceremony state.
    const record = ceremonySession(stage);
    record.loop!.stage = "Updated";
    fixture.sessions([record]);
    await fixture.model.refresh();
    const [revision, setRevision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 100, height: 32 });
    try {
      for (const view of [{ page: "team", seatId: "seat-001" }, { page: "seat", seatId: "seat-001" }, { page: "seat", seatId: "seat-002" }] as const) {
        fixture.model.restore({ ...view, teamId: "team-001" });
        setRevision((value) => value + 1);
        await setup.renderOnce();
        const frames = await scrollFrames(setup, view.page === "team" ? "team-scroll" : "detail-scroll");
        const cycle = CEREMONY_STAGES.map((name) => name === stage ? `[${name}]` : name).join(" → ");
        expect(visibleIn(frames, cycle), view.page + " " + view.seatId).toBe(true);
        expect(visibleIn(frames, "Current stage: " + stage)).toBe(true);
        expect(visibleIn(frames, "Closure: open")).toBe(true);
        expect(visibleIn(frames, "Current stage: Updated")).toBe(false);
      }
      for (const action of Object.values(fixture.goals)) expect(action).not.toHaveBeenCalled();
    } finally { setup.renderer.destroy(); }
  });

  it("enables only the operation applicable to the persisted stage and its work", async () => {
    const fixture = await ceremonyHarness([]);
    const check = async (session: TerminalSession, expected: string[]) => {
      fixture.sessions([session]); await fixture.model.refresh();
      expect(fixture.model.ceremonyKeys()).toEqual(expected);
      for (const [key, label] of [["P", "P propose"], ["A", "A approve"], ["I", "I integrate"], ["M", "M merge"], ["V", "V revert"]]) {
        fixture.model.key(key.toLowerCase(), key);
        expect(!!fixture.model.confirm, `${session.loop?.ceremony?.stage}: ${key}`).toBe(expected.some((item) => item.startsWith(label)));
        if (fixture.model.confirm) fixture.model.key("escape");
      }
    };
    await check(ceremonySession("planning"), ["P propose"]);
    await check({ ...ceremonySession("proposal"), stage: "clarifying" }, ["P propose"]);
    await check({ ...ceremonySession("proposal"), stage: "drafting" }, []);
    await check(ceremonySession("proposal"), ["A approve"]);
    await check(ceremonySession("implement"), ["I integrate"]);
    for (const status of ["building", "in review", "failed", "queued"] as const) {
      const session = ceremonySession("implement"); session.loop!.tickets[0].status = status;
      await check(session, []);
    }
    const working = ceremonySession("implement");
    working.loop!.tickets.push({ id: "other", title: "Still reviewing", seatId: "seat-003", status: "in review" });
    await check(working, []);
    await check(ceremonySession("release"), ["M merge release"]);
    const updating = ceremonySession("release"); updating.loop!.integration!.status = "merged";
    updating.loop!.build = { status: "unavailable", reason: "Build failed." };
    await check(updating, ["V revert"]);
    await check(ceremonySession("retro"), ["V revert"]);
    const publishing = ceremonySession("retro"); publishing.loop!.retro!.prUrl = "https://github.com/example/indra/pull/201";
    await check(publishing, ["M merge retro", "V revert"]);
    publishing.loop!.integration!.revertPrUrl = "https://github.com/example/indra/pull/202";
    await check(publishing, ["M merge revert"]);
    await check(closeSession(ceremonySession("retro")), ["V revert"]);
    const legacy = ceremonySession("release"); delete legacy.loop!.ceremony;
    await check(legacy, []);
    const inconsistent = ceremonySession("planning"); inconsistent.stage = "awaiting-review";
    await check(inconsistent, []);
    fixture.model.seatId = "seat-002";
    await check(ceremonySession("proposal"), []);
  });

  it.each(["refresh", "restart"])("offers a confirmed proposal retry after draft recovery on %s", async (recovery) => {
    const drafting = { ...ceremonySession("proposal"), stage: "drafting" };
    const fixture = await ceremonyHarness([drafting]);
    expect(fixture.model.ceremonyKeys()).toEqual([]);
    fixture.sessions([{ ...drafting, stage: "clarifying" }]);
    const model = recovery === "restart" ? new TerminalUiModel(fixture.state, fixture.reader, undefined, fixture.goals) : fixture.model;
    model.restore(fixture.model.view());
    await model.refresh();
    expect(model.ceremonyKeys()).toEqual(["P propose"]);
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} />, { width: 100, height: 32 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("P propose");
      const frames = await scrollFrames(setup, "detail-scroll");
      expect(visibleIn(frames, "Current stage: proposal")).toBe(true);
      expect(visibleIn(frames, "P requests Chick's proposal here")).toBe(true);
    } finally { setup.renderer.destroy(); }
    model.key("p", "P");
    expect(model.confirm).toEqual({ action: "propose", goalId: drafting.id, goal: drafting.goal });
    await model.proposeConfirmed();
    expect(fixture.goals.propose).not.toHaveBeenCalled();
    vi.mocked(fixture.goals.propose).mockImplementation(async () => { fixture.sessions([drafting]); return "Proposal requested."; });
    expect(model.key("y", "y")).toBe("propose");
    await model.proposeConfirmed();
    expect(fixture.goals.propose).toHaveBeenCalledExactlyOnceWith(drafting.id);
    expect(model.ceremonyKeys()).toEqual([]);
    expect(model.sprintsForTeam()[0].loop.ceremony).toEqual(drafting.loop!.ceremony);
    expect(fixture.goals.approve).not.toHaveBeenCalled();
  });

  it("blocks new goals for open and legacy goals after restart, hiding closed goals from the sprint list", async () => {
    const closed = closeSession(ceremonySession("retro", "goal-closed"));
    const open = ceremonySession("retro", "goal-open");
    const fixture = await ceremonyHarness([closed, open]);
    const restarted = new TerminalUiModel(fixture.state, fixture.reader, undefined, fixture.goals);
    restarted.restore(fixture.model.view()); await restarted.refresh();
    for (const model of [fixture.model, restarted]) {
      model.key("n");
      expect(model.input).toBeUndefined();
      expect(model.notice).toContain("goal-open (retro)");
      expect(model.notice).not.toContain("goal-closed");
      // A closed goal is finished (#59): it leaves the sprint list but stays on its seat's records.
      expect(model.sprintsForTeam().map((sprint) => sprint.id)).toEqual(["goal-open"]);
      expect(model.sessionsFor("seat-001").map((session) => session.id)).toEqual(["goal-closed", "goal-open"]);
    }
    fixture.sessions([closed]); await fixture.model.refresh();
    fixture.model.key("n"); expect(fixture.model.input).toEqual({ value: "" });
    fixture.model.key("escape");
    const legacy = ceremonySession("retro", "goal-legacy"); delete legacy.loop!.ceremony;
    legacy.migration = "evidence conflicts: its integration is merged, but outcome outcome-1 is running.";
    fixture.sessions([closed, legacy]); await fixture.model.refresh();
    fixture.model.key("n"); expect(fixture.model.input).toBeUndefined();
    expect(fixture.model.notice).toContain("goal-legacy (ceremony not recorded; legacy goal evidence conflicts: its integration is merged, but outcome outcome-1 is running.)");
    // The goal that blocks is the one the team list still shows.
    expect(fixture.model.sprintsForTeam().map((sprint) => sprint.id)).toEqual(["goal-legacy"]);
    expect(fixture.goals.start).not.toHaveBeenCalled();
  });

  it("preserves typed input when a concurrent goal blocks submission and refreshes after a successful start", async () => {
    const fixture = await ceremonyHarness([]);
    fixture.model.key("n"); fixture.model.key("paste", "My next goal");
    fixture.sessions([ceremonySession("planning", "goal-concurrent")]);
    await fixture.model.submitInput();
    expect(fixture.goals.start).not.toHaveBeenCalled();
    expect(fixture.model.notice).toContain("goal-concurrent");
    expect(fixture.model.input?.value).toBe("My next goal");
    fixture.sessions([closeSession(ceremonySession("retro", "goal-concurrent"))]);
    vi.mocked(fixture.goals.start).mockImplementation(async () => { fixture.sessions([ceremonySession("planning", "goal-new")]); return "Goal started."; });
    await fixture.model.submitInput();
    expect(fixture.goals.start).toHaveBeenCalledExactlyOnceWith("My next goal");
    expect(fixture.model.input).toBeUndefined();
    expect(fixture.model.newGoalBlocked()).toContain("goal-new");
  });

  it.each(["update", "refresh"])("cancels a goal submission with Escape while waiting for %s", async (waitingFor) => {
    const fixture = await ceremonyHarness([]);
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const update: UpdatePort = {
      canReload: false, current: async () => undefined,
      check: vi.fn(async (): Promise<UpdateResult> => { await waiting; return { outcome: "up-to-date", message: "Up to date.", at: "now" }; }),
    };
    const model = new TerminalUiModel(fixture.state, fixture.reader, undefined, fixture.goals, undefined, update);
    await model.refresh();
    const readSessions = vi.spyOn(fixture.reader, "readSessions");
    let updating: Promise<void> | undefined;
    if (waitingFor === "update") {
      updating = model.updateCode();
      await vi.waitFor(() => expect(update.check).toHaveBeenCalledOnce());
    } else {
      readSessions.mockImplementationOnce(async () => { await waiting; return { connection: "disconnected", sessions: [] }; });
    }
    model.key("n"); model.key("paste", "The canceled goal");
    expect(model.key("return")).toBe("submit");
    const submitting = model.submitInput();
    if (waitingFor === "refresh") expect(readSessions).toHaveBeenCalledOnce();
    expect(fixture.goals.start).not.toHaveBeenCalled();
    model.key("escape");
    expect(model.input).toBeUndefined();
    finish();
    await Promise.all([updating, submitting]);
    expect(fixture.goals.start).not.toHaveBeenCalled();
    expect(model.input).toBeUndefined();
    expect(model.newGoalBlocked()).toBeUndefined();
    model.key("n"); model.key("paste", "A later goal");
    await model.submitInput();
    expect(fixture.goals.start).toHaveBeenCalledExactlyOnceWith("A later goal");
  });

  it("expires stale confirmations on refresh and refuses an approval that changes after y", async () => {
    const fixture = await ceremonyHarness([ceremonySession("proposal")]);
    fixture.model.key("a", "A"); expect(fixture.model.confirm?.action).toBe("approve");
    fixture.sessions([ceremonySession("implement")]); await fixture.model.refresh();
    expect(fixture.model.confirm).toBeUndefined();
    expect(fixture.model.notice).toContain("expired");
    expect(fixture.model.key("y", "y")).toBe("none");
    const proposal = ceremonySession("proposal");
    fixture.sessions([proposal]); await fixture.model.refresh();
    fixture.model.key("a", "A"); expect(fixture.model.key("y", "y")).toBe("approve");
    fixture.sessions([{ ...proposal, updatedAt: "2026-01-06T00:00:00Z" }]);
    await fixture.model.approveConfirmed();
    expect(fixture.goals.approve).not.toHaveBeenCalled();
    expect(fixture.model.notice).toContain("confirm again");
  });

  it("does not redirect a release confirmation to a revert or a replacement retro PR", async () => {
    const fixture = await ceremonyHarness([ceremonySession("release")]);
    fixture.model.key("m", "M"); expect(fixture.model.key("y", "y")).toBe("sprint");
    const reverted = ceremonySession("release"); reverted.loop!.integration!.status = "merged";
    reverted.loop!.integration!.revertPrUrl = "https://github.com/example/indra/pull/202";
    fixture.sessions([reverted]); await fixture.model.sprintConfirmed();
    expect(fixture.goals.sprint).not.toHaveBeenCalled();
    expect(fixture.model.notice).toContain("confirm again");
    const retro = ceremonySession("retro"); retro.loop!.retro!.prUrl = "https://github.com/example/indra/pull/201";
    fixture.sessions([retro]); await fixture.model.refresh();
    fixture.model.key("m", "M"); expect(fixture.model.key("y", "y")).toBe("sprint");
    retro.loop!.retro!.prUrl = "https://github.com/example/indra/pull/203";
    fixture.sessions([retro]); await fixture.model.sprintConfirmed();
    expect(fixture.goals.sprint).not.toHaveBeenCalled();
    expect(fixture.model.ceremonyKeys()).toContain("M merge retro");
  });

  it("refuses actions when the current state cannot be read", async () => {
    const fixture = await ceremonyHarness([ceremonySession("proposal")]);
    fixture.model.key("a", "A"); fixture.model.key("y", "y"); fixture.unreadable();
    await fixture.model.approveConfirmed();
    expect(fixture.goals.approve).not.toHaveBeenCalled();
    expect(fixture.model.ceremonyKeys()).toEqual([]);
    fixture.model.key("n"); expect(fixture.model.input).toBeUndefined();
    expect(fixture.model.notice).toContain("current goal state is unavailable");
  });

  it("refreshes after backend refusal and dispatches an in-flight confirmation only once", async () => {
    const fixture = await ceremonyHarness([ceremonySession("release")]);
    let reject = (_error: Error) => {};
    vi.mocked(fixture.goals.sprint!).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    fixture.model.key("m", "M"); fixture.model.key("y", "y");
    const pending = fixture.model.sprintConfirmed();
    await vi.waitFor(() => expect(fixture.goals.sprint).toHaveBeenCalledOnce());
    fixture.model.key("m", "M"); expect(fixture.model.confirm).toBeUndefined();
    await fixture.model.sprintConfirmed();
    const changed = ceremonySession("release"); changed.loop!.integration!.status = "merged";
    fixture.sessions([changed]); reject(new Error("The merge target changed; confirm again."));
    await pending;
    expect(fixture.model.notice).toContain("Could not merge sprint goal-ceremony: The merge target changed");
    expect(fixture.model.ceremonyKeys()).toEqual(["V revert"]);
    expect(fixture.goals.sprint).toHaveBeenCalledOnce();
  });

  it.each(["drafting", "awaiting-review"])("shows proposal %s within its stage", async (detail) => {
    const fixture = await ceremonyHarness([{ ...ceremonySession("proposal"), stage: detail }]);
    fixture.model.page = "team";
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={() => fixture.model.revision} onKey={() => {}} />, { width: 100, height: 32 });
    try {
      await setup.renderOnce();
      const frames = await scrollFrames(setup, "team-scroll");
      expect(visibleIn(frames, "Current stage: proposal")).toBe(true);
      expect(visibleIn(frames, detail === "drafting" ? "Chick is drafting the proposal." : "Draft ready; waiting for the owner's plan approval.")).toBe(true);
    } finally { setup.renderer.destroy(); }
  });

  it.each(["Dependency install failed; retry pending.", "Build failed; old build is running.", "Updates are paused.", "Application reloaded; bridge restart is pending."])("keeps release waiting and displays: %s", async (reason) => {
    const session = ceremonySession("release"); session.loop!.integration!.status = "merged";
    session.loop!.build = { status: "unavailable", reason };
    const fixture = await ceremonyHarness([session]); fixture.model.page = "team";
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={() => fixture.model.revision} onKey={() => {}} />, { width: 100, height: 32 });
    try {
      await setup.renderOnce();
      const frames = await scrollFrames(setup, "team-scroll");
      expect(visibleIn(frames, "Release waiting: " + reason)).toBe(true);
      expect(visibleIn(frames, "Current stage: release")).toBe(true);
      expect(visibleIn(frames, "Integration PR: 🐙 " + prLabel(session.loop!.integration!.prUrl, true))).toBe(true);
      expect(fixture.model.ceremonyKeys()).not.toContain("M merge release");
    } finally { setup.renderer.destroy(); }
  });

  it("names the retro PR in M's confirmation, then drops the closed sprint from the list while its records keep the evidence", async () => {
    const retro = ceremonySession("retro"); retro.loop!.retro!.prUrl = "https://github.com/example/indra/pull/201";
    const fixture = await ceremonyHarness([retro]);
    const closed = closeSession(retro);
    // Today's live process failure must not erase the recorded released build.
    closed.loop!.build = { status: "unavailable", reason: "Current process evidence is unavailable." };
    vi.mocked(fixture.goals.sprint!).mockImplementation(async () => { fixture.sessions([closed]); return "Retro published; goal closed."; });
    fixture.model.key("m", "M");
    const [revision, setRevision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 100, height: 32 });
    try {
      await setup.renderOnce();
      const before = setup.captureCharFrame();
      expect(compactFrame(before)).toContain(compactFrame("Merge the retro publication PR into main for sprint goal-ceremony"));
      expect(before).toContain(retro.loop!.retro!.prUrl);
      expect(fixture.goals.sprint).not.toHaveBeenCalled();
      expect(fixture.model.key("y", "y")).toBe("sprint");
      await fixture.model.sprintConfirmed();
      expect(fixture.goals.sprint).toHaveBeenCalledExactlyOnceWith("merge", "goal-ceremony");
      expect(fixture.model.newGoalBlocked()).toBeUndefined();
      setRevision(fixture.model.revision); await setup.renderOnce();
      // Closed means finished (#59): the sprint card leaves the list.
      expect(fixture.model.sprintsForTeam().map((sprint) => sprint.id)).not.toContain("goal-ceremony");
      const frames = await scrollFrames(setup, "detail-scroll");
      expect(visibleIn(frames, "Current stage: retro")).toBe(false);
      // The seat's record still carries the published retro and the recorded release.
      const [record] = fixture.model.sessionsFor("seat-001");
      const loop = sessionSprint(record!).loop;
      expect(loop.closedAt).toBe("2026-01-06T00:00:00Z");
      expect(loop.ceremony?.closure?.evidence).toMatchObject({ path: "docs/retros/goal-ceremony.md", prUrl: retro.loop!.retro!.prUrl, publishedAt: "2026-01-06T00:00:00Z" });
      expect(loop.release).toEqual(retro.loop!.release);
      expect(fixture.model.ceremonyKeys()).not.toContain("M merge retro");
    } finally { setup.renderer.destroy(); }
  });
});

describe("visible sprint loop", () => {
  it("highlights the current stage in text and color without starting or approving work", async () => {
    const processes: SeatProcessPort = { read: vi.fn(async () => ({})), ensureAll: vi.fn(async () => []), stop: vi.fn(), restart: vi.fn(), retry: vi.fn() };
    const goals: GoalStarter = { start: vi.fn(), propose: vi.fn(), approve: vi.fn(), sprint: vi.fn() };
    const session = projectedSession("goal-one", ticketLoop);
    session.goal = "Make the full sprint loop visible while preserving every outcome, approval, and integration detail. ".repeat(15);
    const model = new TerminalUiModel(new StateInventory({ read: async () => ({ ...homed, sprints: [] }) }), { readSessions: async () => ({ connection: "disconnected", sessions: [session] }) }, processes, goals);
    await model.refresh();
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} />, { width: 140, height: 35 });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Current stage: implement");
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const current = spans.find((span) => span.text.includes("[implement]"));
      expect(current?.fg.toInts().slice(0, 3)).toEqual([103, 232, 249]);
      expect(spans.find((span) => span.text.includes("planning →"))?.fg.toInts()).not.toEqual(current?.fg.toInts());
      const frames = await scrollFrames(setup, "team-scroll");
      for (const ticket of ticketLoop.tickets) {
        expect(visibleIn(frames, `${ticket.title} · ${ticket.status}`)).toBe(true);
        expect(visibleIn(frames, "🐙 " + prLabel(ticket.prUrl))).toBe(true);
      }
      for (const action of [processes.ensureAll, processes.stop, processes.restart, processes.retry, goals.start, goals.propose, goals.approve, goals.sprint]) expect(action).not.toHaveBeenCalled();
      expect(model.confirm).toBeUndefined();
    } finally { setup.renderer.destroy(); }
  });

  it.each([80, 44])("keeps multiple sprints, completed/failed tickets, and integration links readable at %s columns", async (width) => {
    const first = projectedSession("goal-one", ticketLoop);
    const second = projectedSession("goal-two", {
      stage: "release", ceremony: ceremony("release"), tickets: [{ id: "failed", title: "Failed ticket retained", seatId: "seat-003", status: "failed", prUrl: "https://github.com/example/indra/pull/99" }],
      integration: { branch: "sprint/goal-two", baseSha: "b".repeat(40), status: "pr-open", prUrl: "https://github.com/example/indra/pull/100" },
    });
    const fixture = harness();
    fixture.state(homed);
    fixture.sessions({ connection: "disconnected", sessions: [first, second] });
    await fixture.model.refresh();
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={() => fixture.model.revision} onKey={() => {}} />, { width, height: 24 });
    try {
      await setup.renderOnce();
      const frames = await scrollFrames(setup, "team-scroll");
      for (const text of ["SPRINT · goal-one", "SPRINT · goal-two", "Current stage: implement", "Current stage: release", "Integration PR: 🐙 " + prLabel(second.loop!.integration!.prUrl, true), "Failed ticket retained · failed", "👤 George Duke", "👤 Aaron Magner", "🐙 " + prLabel(second.loop!.tickets[0].prUrl)]) {
        expect(visibleIn(frames, text), text).toBe(true);
      }
      expect(visibleIn(frames, "planning → proposal → [implement] → release → retro")).toBe(true);
      for (const ticket of ticketLoop.tickets) {
        expect(visibleIn(frames, `${ticket.title} · ${ticket.status}`), `${ticket.title} · ${ticket.status}`).toBe(true);
        expect(visibleIn(frames, "🐙 " + prLabel(ticket.prUrl)), ticket.prUrl).toBe(true);
      }
    } finally { setup.renderer.destroy(); }
  });

  it("lets keyboard users page through sprint history", async () => {
    const fixture = harness(); fixture.sessions({ connection: "connected", sessions: [projectedSession("goal-one", ticketLoop)] });
    await fixture.model.refresh();
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={() => fixture.model.revision} onKey={(name, _ctrl, text) => { fixture.model.key(name, text); }} />, { width: 80, height: 24 });
    try {
      await setup.renderOnce();
      const scroll = setup.renderer.root.findDescendantById("team-scroll") as ScrollBoxRenderable;
      expect(scroll.scrollTop).toBe(0);
      setup.mockInput.pressKey("\u001b[6~");
      await setup.renderOnce();
      expect(scroll.scrollTop).toBeGreaterThan(10);
      setup.mockInput.pressKey("\u001b[5~");
      await setup.renderOnce();
      expect(scroll.scrollTop).toBe(0);
      fixture.model.confirm = { action: "approve", goalId: "goal-one", goal: "Sprint goal-one" };
      setup.mockInput.pressKey("\u001b[6~");
      await setup.renderOnce();
      expect(fixture.model.confirm).toBeUndefined();
      expect(fixture.model.notice).toContain("cancelled; nothing changed");
      expect(scroll.scrollTop).toBe(0);
    } finally { setup.renderer.destroy(); }
  });

  it.each<[SprintBuild["status"], string]>([
    ["running", "Running build contains the integration commit."],
    ["reload-pending", "Pending reload:"], ["update-pending", "Update pending:"],
    ["unavailable", "Build evidence unavailable; release is not confirmed."],
    ["revert-open", "Revert PR open; awaiting human merge confirmation."],
    ["reverted", "Reverted on main; running revert build is unverified."],
  ])("renders %s build evidence explicitly", async (status, message) => {
    const fixture = harness(); fixture.state(homed);
    fixture.sessions({ connection: "connected", sessions: [projectedSession("goal-built", { stage: "release", ceremony: ceremony("release"), tickets: [], build: { status } })] });
    await fixture.model.refresh();
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={() => fixture.model.revision} onKey={() => {}} />, { width: 120, height: 40 });
    try {
      await setup.renderOnce();
      const frames = await scrollFrames(setup, "team-scroll");
      expect(visibleIn(frames, message), frames[0]).toBe(true);
      expect(visibleIn(frames, "Current stage: release")).toBe(true);
    } finally { setup.renderer.destroy(); }
  });

  it.each([["codex", "legacy-123", "Codex"], ["claude", "claude:123", "Claude Code"], ["unknown", "future:123", "Unknown engine"]] as const)("renders %s session labels without claiming another engine", async (engine, sessionId, label) => {
    const fixture = harness();
    fixture.sessions({ connection: "connected", sessions: [{ ...projectedSession("goal-engine", { stage: "Clarify", tickets: [] }), engine, sessionId }] });
    await fixture.model.refresh(); fixture.model.seatId = "seat-001"; fixture.model.page = "seat";
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={() => fixture.model.revision} onKey={() => {}} />, { width: 100, height: 40 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain(`IDLE SESSION · ${label}`);
      expect(frame).toContain(`${label} session: ${sessionId}`);
      if (engine !== "codex") expect(frame).not.toContain("Codex");
    } finally { setup.renderer.destroy(); }
  });
});
