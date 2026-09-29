import { testRender } from "@opentui/solid";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachTmux } from "../src/tmux-attach.js";
import { attachSetup, hostedProcessOfSession, UNSAFE_MOUSE, verifyOwnedSession, watchSetup } from "../src/tmux-attach-owned.js";
import { headedMarkerFile } from "../src/headed-session.js";
import type { SeatLive } from "../src/supervisor.js";
import { driveWarning } from "../src/watch-keys.js";
import { TmuxHost, type HostedProcess, type TmuxRunner } from "../src/tmux-host.js";
import { enterUiSession, insideUiSession, isUiInvocation, uiSessionCommand, uiSessionPlan, UI_SOCKET } from "../src/ui-session.js";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel } from "../src/terminal-ui.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import { HELP_SECTIONS } from "../src/help-overlay.js";
import type { TranscriptPoll, TranscriptSource } from "../src/session-transcript.js";
import { RETURN_KEY_TMUX } from "../src/watch-keys.js";

type Call = { args: string[]; stdio: string };
const recorder = (codes: (args: string[]) => number = () => 0) => {
  const calls: Call[] = [];
  return { calls, run: async (args: string[], stdio: "ignore" | "inherit") => { calls.push({ args, stdio }); return codes(args); } };
};

describe("watching a seat", () => {
  it("attaches read-only and changes nothing when the session is not verified as Indra's own", async () => {
    for (const verify of [undefined, async () => undefined]) {
      const { calls, run } = recorder();
      await attachTmux("indra-abc:chick-123", run, verify);
      expect(calls.map((call) => call.args)).toEqual([
        ["-L", "indra-abc", "has-session", "-t", "=chick-123"],
        ["-L", "indra-abc", "attach-session", "-r", "-t", "=chick-123"],
      ]);
    }
  });

  it("sets keys, mouse and the status line only on the verified socket, session and pane, then attaches with input off", async () => {
    const { calls, run } = recorder();
    const checked: string[] = [];
    await attachTmux("indra-0123456789ab:dev-seat-002-0123456789ab", run, async (socket, session) => { checked.push(`${socket}:${session}`); return { paneId: "%7" }; });
    expect(checked).toEqual(["indra-0123456789ab:dev-seat-002-0123456789ab"]);
    const setup = calls.slice(1, -1).map((call) => call.args);
    expect(setup).toEqual(watchSetup("indra-0123456789ab", "dev-seat-002-0123456789ab", "%7"));
    for (const args of setup) expect(args.slice(0, 2)).toEqual(["-L", "indra-0123456789ab"]);
    // Server-wide changes are limited to keys and the mouse, on Indra's own socket: no prefix, no mouse menus.
    const serverWide = setup.filter((args) => args.includes("-g") || args[2]!.endsWith("bind-key"));
    expect(serverWide).toEqual([
      ["-L", "indra-0123456789ab", "set-option", "-g", "prefix", "None"],
      ["-L", "indra-0123456789ab", "set-option", "-g", "prefix2", "None"],
      ...UNSAFE_MOUSE.map((key) => ["-L", "indra-0123456789ab", "unbind-key", "-q", "-n", key]),
      ["-L", "indra-0123456789ab", "bind-key", "-n", RETURN_KEY_TMUX, "detach-client"],
      ["-L", "indra-0123456789ab", "bind-key", "-n", "PPage", "copy-mode", "-eu"],
      ["-L", "indra-0123456789ab", "set-option", "-g", "mouse", "on"],
    ]);
    expect(UNSAFE_MOUSE).toContain("MouseDown3Pane");
    const sessionOptions = setup.filter((args) => args[2] === "set-option" && !args.includes("-g"));
    expect(sessionOptions.length).toBeGreaterThan(0);
    for (const args of sessionOptions) expect(args.slice(3, 5)).toEqual(["-t", "=dev-seat-002-0123456789ab:"]);
    expect(sessionOptions.find((args) => args[5] === "status-right")?.[6]).toContain("Ctrl-] back to Indra");
    expect(setup.at(-1)).toEqual(["-L", "indra-0123456789ab", "select-pane", "-d", "-t", "%7"]);
    expect(calls.at(-1)).toEqual({ args: ["-L", "indra-0123456789ab", "attach-session", "-t", "=dev-seat-002-0123456789ab"], stdio: "inherit" });
  });

  it("falls back to a read-only attach when the pane's input cannot be switched off", async () => {
    const { calls, run } = recorder((args) => args.includes("select-pane") ? 1 : 0);
    await attachTmux("indra-abc:chick-123", run, async () => ({ paneId: "%1" }));
    expect(calls.at(-1)?.args).toEqual(["-L", "indra-abc", "attach-session", "-r", "-t", "=chick-123"]);
  });

  it("drive leaves the verified pane's input on while the owner is attached, then switches it off again; watch turns it off", async () => {
    const socket = "indra-0123456789ab"; const session = "dev-seat-002-0123456789ab";
    const headed = async () => ({ paneId: "%7", headed: true });
    const drive = recorder();
    expect(await attachTmux(`${socket}:${session}`, drive.run, headed, "drive")).toBe("drive");
    const attachAt = drive.calls.findIndex((call) => call.args.includes("attach-session"));
    expect(drive.calls.slice(1, attachAt).map((call) => call.args)).toEqual(attachSetup(socket, session, "%7", "drive"));
    expect(drive.calls[attachAt - 1]!.args).toEqual(["-L", socket, "select-pane", "-e", "-t", "%7"]);
    expect(drive.calls.some((call) => call.args.includes("select-pane") && call.args.includes("-d") && drive.calls.indexOf(call) < attachAt)).toBe(false);
    expect(drive.calls[attachAt]).toEqual({ args: ["-L", socket, "attach-session", "-t", "=" + session], stdio: "inherit" });
    expect(drive.calls.slice(attachAt + 1).map((call) => call.args)).toEqual([["-L", socket, "select-pane", "-d", "-t", "%7"]]);
    // A driver's PgUp reaches the agent CLI, and the status line says the owner is driving.
    const setup = drive.calls.slice(1, attachAt).map((call) => call.args);
    expect(setup).toContainEqual(["-L", socket, "unbind-key", "-q", "-n", "PPage"]);
    expect(setup.find((args) => args[5] === "status-left")?.[6]).toContain("DRIVING");
    expect(setup.find((args) => args[5] === "status-right")?.[6]).toContain("Ctrl-] back to Indra");
    for (const args of setup) expect(args.slice(0, 2)).toEqual(["-L", socket]);

    const watch = recorder();
    expect(await attachTmux(`${socket}:${session}`, watch.run, headed)).toBe("watch");
    const selects = watch.calls.filter((call) => call.args.includes("select-pane")).map((call) => call.args);
    expect(selects).toEqual([["-L", socket, "select-pane", "-d", "-t", "%7"]]);
    expect(watch.calls.at(-1)?.args).toEqual(["-L", socket, "attach-session", "-t", "=" + session]);
  });

  it("drives only a verified session: unverified ones attach read-only and untouched, and one without a headed run is watched", async () => {
    for (const verify of [undefined, async () => undefined]) {
      const { calls, run } = recorder();
      expect(await attachTmux("indra-abc:chick-123", run, verify, "drive")).toBe("read-only");
      expect(calls.map((call) => call.args)).toEqual([
        ["-L", "indra-abc", "has-session", "-t", "=chick-123"],
        ["-L", "indra-abc", "attach-session", "-r", "-t", "=chick-123"],
      ]);
    }
    const idle = recorder();
    expect(await attachTmux("indra-0123456789ab:chick-0123456789ab", idle.run, async () => ({ paneId: "%3", headed: false }), "drive")).toBe("watch");
    expect(idle.calls.slice(1, -1).map((call) => call.args)).toEqual(watchSetup("indra-0123456789ab", "chick-0123456789ab", "%3"));
    expect(idle.calls.some((call) => call.args.includes("-e"))).toBe(false);
    // A drive setup that fails part-way attaches read-only and switches the pane's input back off.
    const failing = recorder((args) => args.includes("status-style") ? 1 : 0);
    expect(await attachTmux("indra-abc:chick-123", failing.run, async () => ({ paneId: "%1", headed: true }), "drive")).toBe("read-only");
    expect(failing.calls.some((call) => call.args.includes("-e"))).toBe(false);
    expect(failing.calls.at(-2)?.args).toEqual(["-L", "indra-abc", "attach-session", "-r", "-t", "=chick-123"]);
    expect(failing.calls.at(-1)?.args).toEqual(["-L", "indra-abc", "select-pane", "-d", "-t", "%1"]);
  });

  it("D asks to drive only from a seat with a live session; a stays watch", async () => {
    const model = await seatPage();
    model.page = "team";
    expect(model.key("D", "D")).toBe("none");
    expect(model.notice).toBe("Open a seat first to drive its live session.");
    model.page = "seat";
    expect(model.key("D", "D")).toBe("none");
    expect(model.notice).toBe("No live session to drive for this seat; its process is not running under Indra.");
    model.live = { "seat-002": { process: "running", attach: { kind: "tmux", target: "indra-0123456789ab:dev-seat-002-0123456789ab" } } as SeatLive };
    expect(model.key("D", "D")).toBe("drive");
    expect(model.key("a", "a")).toBe("attach");
    expect(driveWarning("George Duke")).toBe("You're driving George Duke's live session. Ctrl-] returns to Indra.");
    const help = JSON.stringify(HELP_SECTIONS);
    expect(help).toContain("drive the seat's live agent session");
    expect(help).toContain("While driving a seat");
  });

  it("maps only Indra's session names to hosted processes", () => {
    expect(hostedProcessOfSession("chick-0123456789ab")).toEqual({ kind: "bridge" });
    expect(hostedProcessOfSession("dev-seat-002-0123456789ab")).toEqual({ kind: "seat", seatId: "seat-002" });
    for (const name of ["ui", "main", "chick-123", "dev-seat-002", "work-0123456789ab", "dev--0123456789ab"]) expect(hostedProcessOfSession(name)).toBeUndefined();
  });
});

const READ_ONLY = new Set(["display-message", "list-sessions", "list-panes"]);

class FakeTmux implements TmuxRunner {
  calls: string[][] = [];
  panes = new Map<string, string>();
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    const target = args[args.indexOf("-t") + 1]?.replace(/^=|:$/g, "");
    if (args.includes("display-message")) return "123";
    if (args.includes("list-panes")) { const pane = this.panes.get(target ?? ""); if (!pane) throw new Error("gone"); return `${pane}:0`; }
    if (args.includes("list-sessions")) return [...this.panes.keys()].map((name) => `${name} 456`).join("\n");
    if (args.includes("show-environment")) return "";
    if (args.includes("new-session")) { const name = args[args.indexOf("-s") + 1]!; const pane = `%${this.panes.size + 7}`; this.panes.set(name, pane); return `${name}:${pane}`; }
    throw new Error("unexpected tmux call " + args.join(" "));
  }
}

async function hosted(dir: string, fake: FakeTmux, process: HostedProcess) {
  const host = new TmuxHost(dir, fake, dir, 15_000, process);
  const run = fake.run.bind(fake);
  const original = fake.run;
  fake.run = async (args) => {
    const out = await run(args);
    if (args.includes("new-session")) await writeFile(host.readyFile(args[args.indexOf("--ready-nonce") + 1]!), JSON.stringify({ nonce: args[args.indexOf("--ready-nonce") + 1] }));
    return out;
  };
  const record = await host.start();
  fake.run = original;
  return { host, record };
}

describe("owned session check", () => {
  it("verifies this checkout's own bridge and seat sessions, and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indra-owned-"));
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "cli.js"), "");
    const fake = new FakeTmux();
    const bridge = await hosted(dir, fake, { kind: "bridge" });
    const seat = await hosted(dir, fake, { kind: "seat", seatId: "seat-002" });
    fake.calls = [];
    expect(await verifyOwnedSession(dir, bridge.host.socket, bridge.host.session, fake, dir)).toEqual({ paneId: bridge.record.paneId, headed: false });
    expect(await verifyOwnedSession(dir, seat.host.socket, seat.host.session, fake, dir)).toEqual({ paneId: seat.record.paneId, headed: false });
    // A headed run is recognised only by the marker named after the verified record's nonce, and only while its process lives.
    await writeFile(headedMarkerFile(dir, seat.record.readyNonce), JSON.stringify({ pid: 4242, engine: "claude", startedAt: "x" }));
    expect(await verifyOwnedSession(dir, seat.host.socket, seat.host.session, fake, dir, (pid) => pid === 4242)).toEqual({ paneId: seat.record.paneId, headed: true });
    expect(await verifyOwnedSession(dir, seat.host.socket, seat.host.session, fake, dir, () => false)).toEqual({ paneId: seat.record.paneId, headed: false });
    expect(await verifyOwnedSession(dir, bridge.host.socket, bridge.host.session, fake, dir, () => true)).toEqual({ paneId: bridge.record.paneId, headed: false });
    // Another socket, another checkout's suffix, a seat without a record, or a foreign name are never verified.
    expect(await verifyOwnedSession(dir, "indra-ffffffffffff", bridge.host.session, fake, dir)).toBeUndefined();
    expect(await verifyOwnedSession(dir, bridge.host.socket, "chick-ffffffffffff", fake, dir)).toBeUndefined();
    expect(await verifyOwnedSession(dir, seat.host.socket, seat.host.session.replace("seat-002", "seat-003"), fake, dir)).toBeUndefined();
    expect(await verifyOwnedSession(dir, bridge.host.socket, "ui", fake, dir)).toBeUndefined();
    // Verification only reads.
    for (const call of fake.calls) expect(READ_ONLY.has(call.find((arg) => READ_ONLY.has(arg)) ?? call.join(" "))).toBe(true);
  });
});

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
    expect(uiSessionCommand(true, command, "/app")).toEqual(["-L", UI_SOCKET, "attach-session", "-t", "=ui", ";", "set-option", "-t", "=ui:", "status", "off"]);
    expect(uiSessionCommand(false, command, "/app")).toEqual(["-L", UI_SOCKET, "new-session", "-A", "-s", "ui", "-c", "/app", ...command, ";", "set-option", "-t", "=ui:", "status", "off"]);
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
  it("? shows every key in plain words, including how to leave a watched seat and scroll, and Esc, q or ? closes it", async () => {
    const model = await seatPage();
    const footer = await frame(model);
    expect(footer).toContain("a watch · D drive (Ctrl-] back) · t transcript");
    expect(footer).toContain("? help");
    expect(model.key("?", "?")).toBe("none");
    expect(model.overlay).toBe("help");
    const help = await frame(model);
    expect(help).toContain("HELP · Esc, q or ? closes");
    expect(help).toContain("Ctrl-]");
    expect(help).toContain("back to Indra");
    expect(help).toContain("scroll back; q, Esc or scrolling to the bottom returns to live");
    expect(help).toContain("read the seat's session transcript");
    const words = JSON.stringify(HELP_SECTIONS);
    expect(words).not.toMatch(/tmux|Ctrl-b|copy mode|detach/i);
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
    // T still retries rather than opening the transcript.
    model.key("escape");
    expect(model.overlay).toBeUndefined();
    expect(model.page).toBe("seat");
    model.key("t", "T");
    expect(model.overlay).toBeUndefined();
  });
});
