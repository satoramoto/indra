import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel, type SessionReadResult } from "../src/terminal-ui.js";
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

  it("starts a new planning goal from a typed line, asking for a channel once when state has none", async () => {
    const started: [string, string][] = [];
    let channelReads = 0;
    const goals: GoalStarter = {
      channelFor: async () => { channelReads++; return undefined; },
      start: async (goal, channel) => { started.push([goal, channel]); return "Planning goal plan-1: https://example/pl/root"; },
    };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, undefined, goals);
    await model.refresh();
    const type = (text: string) => { for (const char of text) model.key(char === " " ? "space" : char.toLowerCase(), char); };
    model.key("n");
    expect(model.input).toEqual({ kind: "goal", value: "" });
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
      expect(setup.captureCharFrame()).toContain("New planning goal: Fix tests▏");
      expect(model.key("return")).toBe("submit");
      await model.submitInput();
      expect(model.input).toEqual({ kind: "channel", value: "", goal: "Fix tests" });
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Mattermost channel ID:");
      type("not-a-channel");
      await model.submitInput();
      expect(model.notice).toContain("26 lowercase letters");
      expect(started).toEqual([]);
      model.input!.value = "";
      type("abcdefghijklmnopqrstuvwxyz");
      await model.submitInput();
      expect(started).toEqual([["Fix tests", "abcdefghijklmnopqrstuvwxyz"]]);
      expect(model.input).toBeUndefined();
      expect(model.notice).toContain("Planning goal plan-1");
      model.key("n");
      type("Second goal");
      expect(model.key("enter")).toBe("submit");
      await model.submitInput();
      expect(started[1]).toEqual(["Second goal", "abcdefghijklmnopqrstuvwxyz"]);
      expect(channelReads).toBe(1);
      model.key("n");
      model.key("escape");
      expect(model.input).toBeUndefined();
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
