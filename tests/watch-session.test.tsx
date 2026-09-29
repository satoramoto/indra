import { testRender } from "@opentui/solid";
import { describe, expect, it } from "vitest";
import { enterUiSession, insideUiSession, isUiInvocation, uiSessionCommand, uiSessionPlan, UI_SOCKET } from "../src/ui-session.js";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel } from "../src/terminal-ui.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import { HELP_SECTIONS } from "../src/help-overlay.js";
import type { TranscriptPoll, TranscriptSource } from "../src/session-transcript.js";

type Call = { args: string[]; stdio: string };
const recorder = (codes: (args: string[]) => number = () => 0) => {
  const calls: Call[] = [];
  return { calls, run: async (args: string[], stdio: "ignore" | "inherit") => { calls.push({ args, stdio }); return codes(args); } };
};

describe("npm start and the UI session", () => {
  const tmuxEnv = (socket: string) => ({ TMUX: `/private/tmp/tmux-501/${socket},123,0` });

  it("runs the UI through Indra's UI session only from a terminal, outside it, for the UI itself", () => {
    expect(uiSessionPlan({ args: [], env: {}, tty: true })).toEqual({ kind: "session" });
    expect(uiSessionPlan({ args: ["--state", "/x/indra-state"], env: tmuxEnv("default"), tty: true })).toEqual({ kind: "session" });
    expect(uiSessionPlan({ args: ["--ui"], env: {}, tty: true })).toEqual({ kind: "session" });
    // Already inside Indra's UI session: run the UI here.
    expect(uiSessionPlan({ args: [], env: tmuxEnv(UI_SOCKET), tty: true })).toEqual({ kind: "run" });
    // No terminal, or a command that is not the UI.
    expect(uiSessionPlan({ args: [], env: {}, tty: false })).toEqual({ kind: "run" });
    for (const args of [["--once"], ["planning", "status"], ["seat", "run", "--seat", "seat-002"], ["--mattermost"], ["--state"], ["--help"]]) {
      expect(isUiInvocation(args)).toBe(false);
      expect(uiSessionPlan({ args, env: {}, tty: true })).toEqual({ kind: "run" });
    }
    expect(insideUiSession(tmuxEnv("indra-ui-other"))).toBe(false);
  });

  it("attaches to a running UI session, or creates it running the launcher, and addresses only Indra's UI socket", async () => {
    const command = ["/usr/bin/node", "/app/dist/launcher.js", "--state", "/x/indra-state"];
    for (const exists of [true, false]) {
      const { calls, run } = recorder((args) => args.includes("has-session") ? (exists ? 0 : 1) : 0);
      expect(await enterUiSession(command, "/app", run)).toBe(0);
      expect(calls).toEqual([
        { args: ["-L", UI_SOCKET, "has-session", "-t", "=ui"], stdio: "ignore" },
        { args: uiSessionCommand(exists, command, "/app"), stdio: "inherit" },
      ]);
      for (const call of calls) expect(call.args.slice(0, 2)).toEqual(["-L", UI_SOCKET]);
    }
    const keysOff = [
      ";", "set-option", "-t", "=ui:", "status", "off",
      ";", "set-option", "-g", "prefix", "None",
      ";", "set-option", "-g", "prefix2", "None",
      ";", "set-option", "-g", "mouse", "off",
      ";", "unbind-key", "-a", "-T", "root",
    ];
    expect(uiSessionCommand(true, command, "/app")).toEqual(["-L", UI_SOCKET, "attach-session", "-t", "=ui", ...keysOff]);
    expect(uiSessionCommand(false, command, "/app")).toEqual(["-L", UI_SOCKET, "new-session", "-A", "-s", "ui", "-c", "/app", ...command, ...keysOff]);
    // Without tmux the launcher runs the UI directly.
    expect(await enterUiSession(command, "/app", async () => { throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }); })).toBeUndefined();
  });
});

const snapshot: StateSnapshot = {
  teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "external-team",
    seats: [
      { id: "seat-001", displayName: "Chick Corea", handle: "chick", mattermostUserId: "user-1", roles: ["Team Lead"] },
      { id: "seat-002", displayName: "George Duke", handle: "george", mattermostUserId: "user-2", roles: ["Developer"] },
    ],
  }],
};

async function seatPage() {
  const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) });
  await model.refresh();
  model.seatId = "seat-002";
  model.page = "seat";
  return model;
}

async function frame(model: TerminalUiModel, transcript?: TranscriptSource): Promise<string> {
  const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} transcript={transcript} />, { width: 120, height: 60 });
  try {
    await setup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally { setup.renderer.destroy(); }
}

describe("help and transcript overlays", () => {
  it("? shows every key in plain words, including how to drive and stop driving, and Esc, q or ? closes it", async () => {
    const model = await seatPage();
    const footer = await frame(model);
    expect(footer).toContain("Tab next panel · i drive session · t transcript");
    expect(footer).toContain("? help");
    expect(model.key("?", "?")).toBe("none");
    expect(model.overlay).toBe("help");
    const help = await frame(model);
    expect(help).toContain("HELP · Esc, q or ? closes");
    expect(help).toContain("Esc Esc");
    expect(help).toContain("stop driving (two quick presses)");
    expect(help).toContain("read the seat's session transcript");
    // The shortcut bar stays on screen over the help.
    expect(help).toContain("Esc  q  ? close help");
    const words = JSON.stringify(HELP_SECTIONS);
    expect(words).not.toMatch(/tmux|Ctrl-b|Ctrl-\]|copy mode|detach/i);
    // q closes the overlay instead of quitting.
    expect(model.key("q", "q")).toBe("none");
    expect(model.overlay).toBeUndefined();
    model.key("?", "?");
    model.key("?", "?");
    expect(model.overlay).toBeUndefined();
    model.key("?", "?");
    model.key("escape");
    expect(model.overlay).toBeUndefined();
    expect(model.key("q", "q")).toBe("quit");
  });

  it("t opens the seat's live transcript, read through the source only, and Esc returns", async () => {
    const model = await seatPage();
    model.page = "team";
    model.key("t", "t");
    expect(model.overlay).toBeUndefined();
    expect(model.notice).toBe("Open a seat first to read its session transcript.");
    model.page = "seat";
    model.key("t", "t");
    expect(model.overlay).toBe("transcript");
    const seats: string[] = [];
    const poll: TranscriptPoll = { status: "ok", reset: true, location: { engine: "codex", sessionId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", path: "/x" }, entries: [
      { kind: "assistant", label: "Assistant", text: "Looking at the diff.", at: "2026-09-29T10:00:00.000Z" },
      { kind: "tool", label: "Tool · shell", text: "gh pr diff 12" },
      { kind: "error", label: "Tool error", text: "1 failed" },
    ] };
    const source: TranscriptSource = { feed: (seat) => { seats.push(seat.id); return { poll: async () => poll }; } };
    const view = await frame(model, source);
    expect(seats).toEqual(["seat-002"]);
    expect(view).toContain("TRANSCRIPT · George Duke · Codex session 0199a1b2 · read-only · Esc/q back");
    expect(view).toContain("Assistant");
    expect(view).toContain("Looking at the diff.");
    expect(view).toContain("Tool · shell");
    expect(view).toContain("gh pr diff 12");
    expect(view).toContain("Tool error");
    expect(view).toContain("Home End start, or follow live");
    // T still retries rather than opening the transcript.
    model.key("escape");
    expect(model.overlay).toBeUndefined();
    expect(model.page).toBe("seat");
    model.key("t", "T");
    expect(model.overlay).toBeUndefined();
  });
});
