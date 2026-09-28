import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel, type SessionReadResult, type StateSyncPort, type UpdatePort } from "../src/terminal-ui.js";
import type { UpdateResult } from "../src/self-update.js";
import type { StateSyncResult } from "../src/state-commit.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import { attachTmux, parseOwnedTmuxTarget } from "../src/tmux-attach.js";
import type { GoalStarter, SeatLive, SeatProcessPort } from "../src/supervisor.js";

const names = ["Chick Corea", "George Duke", "Aaron Magner", "Corey Henry", "Jordan Rudess"];
const snapshot: StateSnapshot = {
  teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "external-team",
    seats: names.map((displayName, index) => ({ id: "seat-00" + (index + 1), displayName, handle: displayName.toLowerCase().replace(" ", ""), mattermostUserId: "user-" + (index + 1), roles: [index === 0 ? "Team Lead" : "Developer"] })),
  }],
  sprints: [{ id: "sprint-001", teamId: "team-001", status: "draft", phase: "planning", goal: "Review the first cycle", proposedWork: [], proposedAllocations: [] }],
};

const homed: StateSnapshot = { ...snapshot, teams: [{ ...snapshot.teams[0], homeChannelId: "o9rogqxy7br1zkrcami681sray", project: { github: "satoramoto/indra" } }] };

function harness() {
  let state = snapshot;
  let sessions: SessionReadResult = { connection: "disconnected", sessions: [] };
  const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => sessions });
  return { model, state: (next: StateSnapshot) => { state = next; }, sessions: (next: SessionReadResult) => { sessions = next; } };
}

describe("terminal UI", () => {
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
    expect(fixture.model.key("a")).toBe("attach");
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
      expect(initial).toContain("DRAFT SPRINT");
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
      expect(setup.captureCharFrame()).toContain("Stage: clarifying");
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

  it("only accepts exact socket:session tmux targets", () => {
    expect(parseOwnedTmuxTarget("indra-bridge:indra-goal-1")).toEqual({ socket: "indra-bridge", session: "indra-goal-1" });
    for (const invalid of ["indra-bridge", "one:two:three", "one:$(id)", "one:two;kill", "UPPER:case", "one:/tmp"]) {
      expect(() => parseOwnedTmuxTarget(invalid)).toThrow("valid Indra tmux target");
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
    const [revision] = createSignal(fixture.model.revision);
    const setup = await testRender(() => <TerminalApp model={fixture.model} revision={revision} onKey={() => {}} />, { width: 120, height: 30 });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("OCCUPANCY UNKNOWN");
      expect(frame).toContain("Recorded: Earlier response");
      expect(frame).toContain("Planning goal: Plan the next cycle");
      expect(frame).toContain("Stage: clarifying");
      expect(frame).toContain("no verified tmux target");
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
      expect(detail).toContain("Stage: drafting");
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
      expect(frame).toMatch(/George Duke {2}· {2}Developer {2}· {2}RUNNING/);
      expect(frame).toContain("Second · in-review · https://github.com/o/r/pull/2");
      expect(frame).toContain("Latest: Opened PR 2");
      expect(frame).toMatch(/Aaron Magner {2}· {2}Developer {2}· {2}NO CREDENTIAL/);
      expect(frame).toMatch(/Corey Henry {2}· {2}Developer {2}· {2}STOPPED/);
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
    const goals: GoalStarter = { start: async () => { calls.push("start"); return "ok"; }, approve: async () => { calls.push("approve"); return "ok"; } };
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
    expect(model.readyToReload()).toBe(true);
  });

  it("starts a new planning goal from a typed line alone, with the team's home channel and project from state", async () => {
    const started: string[] = [];
    const goals: GoalStarter = {
      start: async (goal) => { started.push(goal); return "Planning goal plan-1: https://example/pl/root"; },
      approve: async () => { throw new Error("not used"); },
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
    } finally { setup.renderer.destroy(); }
  });

  it("names the missing state field instead of asking for a channel or project", async () => {
    const goals: GoalStarter = { start: async () => { throw new Error("must not start"); }, approve: async () => { throw new Error("not used"); } };
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
    const goals: GoalStarter = { start: async () => "unused", approve: async (goalId) => { approvals.push(goalId); return `Approved goal ${goalId}: 2 outcome(s) queued for Developer seats.`; } };
    let stage = "awaiting-review";
    const session = () => ({ id: "goal-1", teamId: "team-001", seatId: "seat-001", status: "idle" as const, engine: "codex" as const, sessionId: "codex-1", goal: "Plan the next cycle", stage, updatedAt: "2026-01-02T00:00:00Z", recentActivity: [] });
    const model = new TerminalUiModel(new StateInventory({ read: async () => homed }), { readSessions: async () => ({ connection: "connected", sessions: [session()] }) }, undefined, goals);
    await model.refresh();
    expect(model.key("a", "A")).toBe("none");
    expect(model.notice).toContain("Open Chick's seat");
    model.key("down");
    model.key("return");
    expect(model.seat?.id).toBe("seat-001");
    model.key("a", "A");
    expect(model.confirm).toEqual({ goalId: "goal-1", goal: "Plan the next cycle" });
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
      stage = "approved";
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

  it("attaches to the verified tmux session in read-only mode", async () => {
    const calls: { args: string[]; stdio: string }[] = [];
    await attachTmux("indra-bridge:chick-123", async (args, stdio) => { calls.push({ args, stdio }); return 0; });
    expect(calls).toEqual([
      { args: ["-L", "indra-bridge", "has-session", "-t", "=chick-123"], stdio: "ignore" },
      { args: ["-L", "indra-bridge", "attach-session", "-r", "-t", "=chick-123"], stdio: "inherit" },
    ]);
  });
});
