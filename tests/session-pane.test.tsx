import { testRender } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ansiToLines, applySgr, color256, lineText } from "../src/ansi-lines.js";
import { KeyForwarder, MIN_MIRROR_MS, MirrorPoller, sendKeysArgs, tmuxKey, TmuxSeatSession, type DriveResult, type MirrorFrame, type MirrorSeat, type MirrorTimers, type SessionPort, type TmuxKey } from "../src/session-mirror.js";
import { SessionDriver } from "../src/session-drive.js";
import { classifyPaneLine, styledLine } from "../src/session-pane.js";
import { shortcutContext, shortcutsFor, shortcutText } from "../src/shortcuts.js";
import { headedMarkerFile } from "../src/headed-session.js";
import { TmuxHost, type TmuxRunner } from "../src/tmux-host.js";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { DOUBLE_ESCAPE_MS, TerminalUiModel } from "../src/terminal-ui.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import type { SeatLive } from "../src/supervisor.js";

describe("mirroring a pane's colours", () => {
  it("parses SGR colours and attributes into styled spans, carrying the style across lines", () => {
    const lines = ansiToLines("\u001b[1;31mred bold\u001b[0m plain \u001b[38;5;33mblue\u001b[48;2;1;2;3m on rgb\n still blue\u001b[39;49m\u001b[7m inv\u001b[27m\n", { rows: 5, width: 80 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([
      { text: "red bold", style: { bold: true, fg: "#CD3131" } },
      { text: " plain ", style: {} },
      { text: "blue", style: { fg: color256(33) } },
      { text: " on rgb", style: { fg: color256(33), bg: "#010203" } },
    ]);
    expect(lines[1]).toEqual([
      { text: " still blue", style: { fg: color256(33), bg: "#010203" } },
      { text: " inv", style: { inverse: true } },
    ]);
    expect(color256(16)).toBe("#000000");
    expect(color256(231)).toBe("#FFFFFF");
    expect(color256(232)).toBe("#080808");
    expect(applySgr({ bold: true, dim: true }, "22")).toEqual({});
    expect(applySgr({ fg: "#000000" }, "")).toEqual({});
  });

  it("drops other escapes and control characters, keeps the rows top first, cuts to width and redacts a line whole", () => {
    const text = "a\u001b]0;title\u0007b\u001b[2Kc\u0008d\ttab\n\u001b[32mtoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789\u001b[0m\n" + "y".repeat(50) + "\nlast row dropped";
    const lines = ansiToLines(text, { rows: 3, width: 20 });
    expect(lines.map(lineText)).toEqual(["abcd  tab", "token=[redacted]", "y".repeat(20)]);
    // A redacted line loses its styling, so no span can carry part of the secret.
    expect(lines[1]).toEqual([{ text: "token=[redacted]", style: {} }]);
    for (const line of lines) expect(lineText(line)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("draws styled spans with their own colours, and colours an unstyled progress line by its mark", () => {
    expect(styledLine([{ text: "x", style: { fg: "#CD3131", bold: true } }, { text: "y", style: {} }])).toEqual([
      { text: "x", style: { fg: "#CD3131", bold: true } }, { text: "y", style: { fg: "#E5E7EB" } },
    ]);
    expect(styledLine([{ text: "12:34 $ ✓ git status", style: {} }])).toEqual([
      { text: "12:34 ", style: { fg: "#6B7280" } }, { text: "$ ✓ git status", style: { fg: "#FDBA74" } },
    ]);
    expect(classifyPaneLine("12:34 ! turn failed").kind).toBe("fail");
    expect(classifyPaneLine("plain").kind).toBe("plain");
  });
});

class FakeTmux implements TmuxRunner {
  calls: string[][] = [];
  pane?: string;
  session?: string;
  identity = "123:456";
  output = "";
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args.includes("display-message")) { if (!this.pane) throw new Error("gone"); return this.identity.split(":")[0]!; }
    if (args.includes("list-panes")) { if (!this.pane) throw new Error("gone"); return `${this.pane}:0`; }
    if (args.includes("list-sessions")) return this.pane ? `${this.session} ${this.identity.split(":")[1]}` : "";
    if (args.includes("new-session")) { this.pane = "%7"; this.session = args[args.indexOf("-s") + 1]; return `${this.session}:%7`; }
    if (args.includes("capture-pane")) return this.output;
    return "";
  }
  named(command: string): string[][] { return this.calls.filter((args) => args.includes(command)); }
}

const lead: MirrorSeat = { id: "seat-001", roles: ["Team Lead"] };
const dev: MirrorSeat = { id: "seat-002", roles: ["Developer"] };

/** A checkout whose Team Lead bridge is hosted in a verified, Indra-owned session. */
async function hosted() {
  const dir = await mkdtemp(join(tmpdir(), "indra-mirror-"));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "cli.js"), "");
  const fake = new FakeTmux();
  const host = new TmuxHost(dir, fake, dir, 15_000, { kind: "bridge" });
  const run = fake.run.bind(fake);
  fake.run = async (args) => {
    const out = await run(args);
    if (args.includes("new-session")) await writeFile(host.readyFile(args[args.indexOf("--ready-nonce") + 1]!), JSON.stringify({ nonce: args[args.indexOf("--ready-nonce") + 1] }));
    return out;
  };
  const record = await host.start();
  fake.calls = [];
  let now = 0;
  const session = new TmuxSeatSession(dir, fake, dir, (pid) => pid === 4242, () => now);
  return { dir, fake, record, session, tick: (ms: number) => { now += ms; } };
}

describe("the seat's session through tmux", () => {
  it("captures a verified pane with colours, sized to the pane, and re-verifies at most once a second", async () => {
    const { fake, record, session, tick } = await hosted();
    fake.output = "\u001b[31mstep 1\u001b[0m\nstep 2\n";
    expect(await session.capture(lead, { rows: 4, width: 40, scroll: 0 })).toEqual({ status: "ok", lines: [[{ text: "step 1", style: { fg: "#CD3131" } }], [{ text: "step 2", style: {} }]] });
    expect(fake.named("resize-window")).toEqual([["-L", record.socket, "resize-window", "-t", record.paneId, "-x", "40", "-y", "4"]]);
    expect(fake.named("capture-pane")).toEqual([["-L", record.socket, "capture-pane", "-p", "-e", "-t", record.paneId, "-S", "0", "-E", "3"]]);
    await session.capture(lead, { rows: 4, width: 40, scroll: 5 });
    expect(fake.named("capture-pane").at(-1)).toEqual(["-L", record.socket, "capture-pane", "-p", "-e", "-t", record.paneId, "-S", "-5", "-E", "-2"]);
    // Same size: no second resize; within a second: no second verification.
    expect(fake.named("resize-window")).toHaveLength(1);
    expect(fake.named("list-panes")).toHaveLength(1);
    tick(1000);
    await session.capture(lead, { rows: 4, width: 40, scroll: 0 });
    expect(fake.named("list-panes")).toHaveLength(2);
    for (const args of fake.calls) expect(args.slice(0, 2)).toEqual(["-L", record.socket]);
  });

  it("reads and writes nothing for a seat without a verified record, and drives only a headed run", async () => {
    const { dir, fake, record, session } = await hosted();
    expect(await session.capture(dev, { rows: 4, width: 40, scroll: 0 })).toEqual({ status: "no-session" });
    expect(await session.drive(dev)).toEqual({ ok: false, reason: "no-session" });
    expect(await session.drive(lead)).toEqual({ ok: false, reason: "not-headed" });
    expect(fake.named("capture-pane")).toEqual([]);
    expect(fake.named("select-pane")).toEqual([]);
    await writeFile(headedMarkerFile(dir, record.readyNonce), JSON.stringify({ pid: 4242, engine: "claude", startedAt: "x" }));
    const driven = await session.drive(lead);
    expect(driven).toEqual({ ok: true, target: { seatId: "seat-001", socket: record.socket, paneId: record.paneId } });
    expect(fake.named("select-pane")).toEqual([["-L", record.socket, "select-pane", "-e", "-t", record.paneId]]);
    const target = (driven as Extract<DriveResult, { ok: true }>).target;
    await session.send(target, [{ literal: "hi;" }, { key: "Enter" }]);
    expect(fake.calls.at(-1)).toEqual(["-L", record.socket, "send-keys", "-t", record.paneId, "-l", "--", "hi\\;", ";", "send-keys", "-t", record.paneId, "Enter"]);
    await session.paste(target, "two\r\nlines;");
    expect(fake.calls.at(-1)).toEqual(["-L", record.socket, "set-buffer", "-b", "indra-drive", "--", "two\nlines\\;", ";", "paste-buffer", "-p", "-d", "-b", "indra-drive", "-t", record.paneId]);
    await session.release(target);
    expect(fake.calls.at(-1)).toEqual(["-L", record.socket, "select-pane", "-d", "-t", record.paneId]);
    // The capture reports the headed engine.
    expect(await session.capture(lead, { rows: 2, width: 20, scroll: 0 })).toMatchObject({ status: "ok", headed: "claude" });
    expect(() => sendKeysArgs({ seatId: "x", socket: "default", paneId: "%1" }, [{ key: "Enter" }])).toThrow("not verified");
  });

  it("maps keys to tmux keys, and batches a burst into one send in order", async () => {
    expect(tmuxKey("a", "a")).toEqual({ literal: "a" });
    expect(tmuxKey("c", "\u0003", { ctrl: true })).toEqual({ key: "C-c" });
    expect(tmuxKey("return", "\r")).toEqual({ key: "Enter" });
    expect(tmuxKey("escape", "\u001b")).toEqual({ key: "Escape" });
    expect(tmuxKey("backspace", "\u007f")).toEqual({ key: "BSpace" });
    expect(tmuxKey("up", "\u001b[A")).toEqual({ key: "Up" });
    expect(tmuxKey("tab", "\u001b[Z", { shift: true })).toEqual({ key: "BTab" });
    expect(tmuxKey("space", " ")).toEqual({ literal: " " });
    expect(tmuxKey("unknown", "\u001b[99~")).toBeUndefined();
    const sent: TmuxKey[][] = [];
    const forwarder = new KeyForwarder(async (keys) => { sent.push(keys); });
    for (const key of [{ literal: "a" }, { literal: "b" }, { key: "Enter" }]) forwarder.push(key);
    await forwarder.idle();
    expect(sent).toEqual([[{ literal: "a" }, { literal: "b" }, { key: "Enter" }]]);
    expect(sendKeysArgs({ seatId: "x", socket: "indra-0123456789ab", paneId: "%1" }, sent[0]!)).toEqual(["-L", "indra-0123456789ab", "send-keys", "-t", "%1", "-l", "--", "ab", ";", "send-keys", "-t", "%1", "Enter"]);
  });
});

describe("bounded refresh", () => {
  it("never polls faster than 10 frames a second, skips while hidden or busy, and delivers only changed frames", async () => {
    let interval: (() => void) | undefined;
    let ms = 0;
    let cleared = 0;
    const timers: MirrorTimers = { setInterval: (run, every) => { interval = run; ms = every; return 1; }, clearInterval: () => { cleared++; } };
    const pending: ((frame: MirrorFrame) => void)[] = [];
    const source = { capture: () => new Promise<MirrorFrame>((resolve) => pending.push(resolve)) };
    let seat: MirrorSeat | undefined = lead;
    const frames: MirrorFrame[] = [];
    const poller = new MirrorPoller(source, () => seat, () => ({ rows: 4, width: 40, scroll: 0 }), (_, frame) => frames.push(frame), 10, timers);
    expect(poller.intervalMs).toBe(MIN_MIRROR_MS);
    poller.start();
    expect(ms).toBe(MIN_MIRROR_MS);
    // Busy: the ticks while the first capture runs are skipped.
    interval!(); interval!();
    expect(pending).toHaveLength(1);
    const same: MirrorFrame = { status: "ok", lines: [[{ text: "x", style: {} }]] };
    pending.shift()!(same);
    await new Promise((resolve) => setTimeout(resolve, 0));
    interval!();
    pending.shift()!(same);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // An unchanged frame is not delivered again.
    expect(frames).toHaveLength(1);
    // Hidden: nothing is captured.
    seat = undefined;
    interval!();
    expect(pending).toHaveLength(0);
    poller.stop();
    expect(cleared).toBe(1);
  });
});

const snapshot: StateSnapshot = {
  teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "t", seats: [
    { id: "seat-001", displayName: "Chick Corea", handle: "chickcorea", mattermostUserId: "u1", roles: ["Team Lead"] },
    { id: "seat-002", displayName: "George Duke", handle: "georgeduke", mattermostUserId: "u2", roles: ["Developer"] },
  ] }],
};

async function seatModel() {
  const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) });
  await model.refresh();
  model.page = "seat";
  model.seatId = "seat-002";
  model.live = { "seat-002": { process: "running", attach: { kind: "tmux", target: "indra-0123456789ab:dev-seat-002-0123456789ab" } } as SeatLive };
  return model;
}

class FakePort implements SessionPort {
  calls: string[] = [];
  headed = true;
  async capture(): Promise<MirrorFrame> { return { status: "ok", lines: [] }; }
  async drive(seat: MirrorSeat): Promise<DriveResult> {
    this.calls.push("drive " + seat.id);
    return this.headed ? { ok: true, target: { seatId: seat.id, socket: "indra-0123456789ab", paneId: "%7" } } : { ok: false, reason: "not-headed" };
  }
  async send(_target: unknown, keys: TmuxKey[]): Promise<void> { this.calls.push("send " + JSON.stringify(keys)); }
  async paste(_target: unknown, text: string): Promise<void> { this.calls.push("paste " + text); }
  async release(): Promise<void> { this.calls.push("release"); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("focus and driving", () => {
  it("forwards keys only while the session pane is focused and driving a headed run", async () => {
    const model = await seatModel();
    const port = new FakePort();
    const driver = new SessionDriver(model, port, () => {});
    // Watching: nothing is forwarded, and keys do their usual thing.
    expect(model.key("x", "x")).toBe("none");
    expect(model.notice).toBe("Seat processes are not managed from this screen.");
    expect(driver.key("x", "x")).toBe(false);
    expect(model.key("i", "i")).toBe("drive");
    // Until the check answers, keys are held back.
    expect(model.key("q", "q")).toBe("none");
    driver.sync();
    await settle();
    expect(model.drivingOn()).toBe(true);
    expect(model.key("q", "q")).toBe("forward");
    expect(driver.key("q", "q")).toBe(true);
    expect(model.key("c", "\u0003", { ctrl: true })).toBe("forward");
    expect(driver.key("c", "\u0003", { ctrl: true })).toBe(true);
    expect(driver.paste("pasted")).toBe(true);
    await settle(); await settle();
    expect(port.calls).toEqual(["drive seat-002", 'send [{"literal":"q"},{"key":"C-c"}]', "paste pasted"]);
    // Tab leaves the pane and moves on; the pane's input goes back off.
    expect(model.key("tab", "\t")).toBe("release");
    driver.sync();
    await settle();
    expect(model.focus).toBe("details");
    expect(port.calls.at(-1)).toBe("release");
    expect(driver.key("q", "q")).toBe(false);
    // A seat with no headed run is watched: focus stays on the pane, nothing is sent.
    port.headed = false;
    expect(model.setFocus("session")).toBe("drive");
    driver.sync();
    await settle();
    expect(model.drivingOn()).toBe(false);
    expect(model.focus).toBe("session");
    expect(model.notice).toContain("not in a headed run");
    expect(port.calls.filter((call) => call.startsWith("send"))).toHaveLength(1);
  });

  it("a single Esc goes to the session; a second within 300 ms stops driving", async () => {
    const model = await seatModel();
    let now = 1000;
    model.now = () => now;
    model.setFocus("session");
    model.driveResult("seat-002", { ok: true });
    expect(model.key("escape")).toBe("forward");
    now += DOUBLE_ESCAPE_MS + 1;
    expect(model.key("escape")).toBe("forward");
    now += 100;
    expect(model.key("escape")).toBe("release");
    expect(model.focus).toBe("details");
    expect(model.driving).toBeUndefined();
    // Esc and another key in between does not count as a double Esc.
    model.setFocus("session");
    model.driveResult("seat-002", { ok: true });
    expect(model.key("escape")).toBe("forward");
    expect(model.key("a", "a")).toBe("forward");
    expect(model.key("escape")).toBe("forward");
  });

  it("Tab and Shift-Tab cycle the seat list, session, details and sprints", async () => {
    const model = await seatModel();
    model.live = {};
    const seen: string[] = [model.focus];
    for (let index = 0; index < 4; index++) { model.key("tab", "\t"); seen.push(model.focus); }
    expect(seen).toEqual(["details", "sprints", "seats", "session", "details"]);
    model.key("tab", "\u001b[Z", { shift: true });
    expect(model.focus).toBe("session");
    // The seat list's arrows switch the seat shown.
    model.focus = "seats";
    model.key("up");
    expect(model.seatId).toBe("seat-001");
  });

  it("clicks focus a region, a seat in the list, or leave the session pane from outside; the wheel scrolls the region under it", async () => {
    const model = await seatModel();
    const [revision, setRevision] = createSignal(model.revision);
    const actions: string[] = [];
    const onFocus = (region: Parameters<TerminalUiModel["focusAt"]>[0], seatId?: string) => { actions.push(model.focusAt(region, seatId)); setRevision(model.revision); };
    const onSessionScroll = (lines: number) => { model.scrollSession(lines); setRevision(model.revision); };
    const port = new FakePort();
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} onFocus={onFocus} onSessionScroll={onSessionScroll} session={port} />, { width: 96, height: 42 });
    try {
      await setup.renderOnce();
      const pane = setup.renderer.root.findDescendantById("session-pane")!;
      const details = setup.renderer.root.findDescendantById("detail-scroll") as ScrollBoxRenderable;
      const list = setup.renderer.root.findDescendantById("seat-list")!;
      await setup.mockMouse.click(pane.x + 5, pane.y + 3);
      expect(model.focus).toBe("session");
      expect(actions).toEqual(["drive"]);
      model.driveResult("seat-002", { ok: true });
      setRevision(model.revision);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("DRIVING George Duke — Esc Esc or Tab to stop");
      expect(setup.captureCharFrame()).toContain("Esc Esc stop driving");
      // A click outside every region (the header) leaves the pane.
      await setup.mockMouse.click(3, 1);
      expect(actions.at(-1)).toBe("release");
      expect(model.focus).toBe("details");
      await setup.mockMouse.click(details.x + 3, details.y + 2);
      expect(model.focus).toBe("details");
      // The seat list: a click on a row shows that seat.
      await setup.mockMouse.click(list.x + 3, list.y + 1);
      expect(model.focus).toBe("seats");
      expect(model.seatId).toBe("seat-001");
      // The wheel over the session pane scrolls it back; over the details, it scrolls them.
      await setup.mockMouse.scroll(pane.x + 5, pane.y + 3, "up");
      expect(model.sessionScroll).toBeGreaterThan(0);
      await setup.mockMouse.scroll(pane.x + 5, pane.y + 3, "down");
      expect(model.sessionScroll).toBe(0);
      model.seatId = "seat-002";
      setRevision(++model.revision);
      await setup.renderOnce();
      // Enough detail to scroll.
      model.sessionResult = { connection: "connected", sessions: [{
        id: "goal-1", teamId: "team-001", seatId: "seat-002", status: "running", engine: "codex", sessionId: "codex-1", goal: "A goal", stage: "clarifying",
        recentActivity: ["one", "two", "three"],
      }, {
        id: "goal-2", teamId: "team-001", seatId: "seat-002", status: "idle", engine: "codex", sessionId: "codex-2", goal: "Another goal", stage: "clarifying",
        recentActivity: ["four", "five", "six"],
      }] };
      setRevision(++model.revision);
      await setup.renderOnce();
      const before = details.scrollTop;
      expect(details.scrollHeight).toBeGreaterThan(details.viewport.height);
      await setup.mockMouse.scroll(details.x + 3, details.y + 2, "down");
      await setup.renderOnce();
      expect(details.scrollTop).toBeGreaterThan(before);
      expect(model.sessionScroll).toBe(0);
    } finally { setup.renderer.destroy(); }
  });
});

describe("the shortcut bar", () => {
  it("shows the keys for each context, and never names tmux", async () => {
    const model = await seatModel();
    const text = () => shortcutText(shortcutsFor(shortcutContext(model)));
    expect(shortcutContext(model)).toBe("seat-details");
    expect(text()).toContain("↑↓ PgUp PgDn scroll · Tab next panel · i drive session");
    model.focus = "seats";
    expect(text()).toContain("↑↓ choose seat");
    model.setFocus("session");
    expect(shortcutContext(model)).toBe("connecting");
    model.driveResult("seat-002", { ok: true });
    expect(shortcutContext(model)).toBe("driving");
    expect(text()).toBe("your keys go to the session · Esc Esc stop driving · Tab next panel · click outside stop driving");
    model.setFocus("details");
    model.focus = "session";
    expect(shortcutContext(model)).toBe("seat-session");
    expect(text()).toContain("Enter drive · ↑↓ PgUp PgDn scroll back · End live · Esc leave");
    model.page = "team";
    expect(text()).toContain("↑↓ choose seat · Enter open seat");
    model.page = "teams";
    expect(text()).toContain("↑↓ choose team · Enter open");
    model.overlay = "help";
    expect(text()).toBe("Esc  q  ? close help");
    model.overlay = "transcript";
    expect(text()).toContain("Esc  q back");
    model.overlay = undefined;
    model.input = { value: "" };
    expect(text()).toBe("Enter start the goal · Esc cancel");
    const every = (["teams", "team", "seat-seats", "seat-session", "seat-details", "seat-sprints", "connecting", "driving", "input", "confirm", "help", "transcript"] as const)
      .map((context) => shortcutText(shortcutsFor(context))).join("\n");
    expect(every).not.toMatch(/tmux|Ctrl-\]|Ctrl-b/);
  });

  it("stays on screen while driving", async () => {
    const model = await seatModel();
    model.setFocus("session");
    model.driveResult("seat-002", { ok: true });
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} session={new FakePort()} />, { width: 96, height: 42 });
    try {
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n");
      expect(lines.slice(-4).join("\n")).toContain("your keys go to the session · Esc Esc stop driving");
    } finally { setup.renderer.destroy(); }
  });
});
