import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneTailPoller, sanitizePaneText, TmuxPaneTail, type PaneTail, type PaneTailSeat, type PaneTailSource, type PaneTailTimers } from "../src/pane-tail.js";
import { classifyPaneLine, PANE_LINE_COLOR, PaneTailPanel, paneTailLines } from "../src/pane-tail-panel.js";
import { formatProgressLine } from "../src/codex-progress.js";
import { RGBA } from "@opentui/core";
import { TmuxHost, type TmuxRunner } from "../src/tmux-host.js";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel } from "../src/terminal-ui.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";

const READ_ONLY = new Set(["display-message", "list-sessions", "list-panes", "capture-pane", "new-session"]);

class FakeTmux implements TmuxRunner {
  calls: string[][] = [];
  pane?: string;
  session?: string;
  identity = "123:456";
  output = "";
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args.includes("display-message")) { if (!this.pane) throw new Error("gone"); return this.identity.split(":")[0]; }
    if (args.includes("list-panes")) { if (!this.pane) throw new Error("gone"); return `${this.pane}:0`; }
    if (args.includes("list-sessions")) return this.pane ? `${this.session} ${this.identity.split(":")[1]}` : "";
    if (args.includes("new-session")) { this.pane = "%7"; this.session = args[args.indexOf("-s") + 1]; return `${this.session}:%7`; }
    if (args.includes("capture-pane")) return this.output;
    throw new Error("unexpected tmux call " + args.join(" "));
  }
  captures(): string[][] { return this.calls.filter((args) => args.includes("capture-pane")); }
}

const lead: PaneTailSeat = { id: "seat-001", roles: ["Team Lead"] };
const dev: PaneTailSeat = { id: "seat-002", roles: ["Developer"] };
const when = new Date(2026, 8, 28, 12, 34, 56);

/** A checkout whose Team Lead bridge is hosted in a verified, Indra-owned session. */
async function hosted() {
  const dir = await mkdtemp(join(tmpdir(), "indra-pane-"));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "cli.js"), "");
  const fake = new FakeTmux();
  const host = new TmuxHost(dir, fake, dir, 15_000, { kind: "bridge" });
  const run = fake.run.bind(fake);
  fake.run = async (args) => {
    const out = await run(args);
    if (args.includes("new-session")) await writeFile(host.readyFile(args[args.indexOf("--ready-nonce") + 1]), JSON.stringify({ nonce: args[args.indexOf("--ready-nonce") + 1] }));
    return out;
  };
  const record = await host.start();
  fake.calls = [];
  return { dir, fake, record, tail: new TmuxPaneTail(dir, fake, dir) };
}

describe("pane tail", () => {
  it("strips escapes and control characters, redacts, keeps the last lines and cuts them to width", () => {
    const text = "old\n\u001b[1;32mgreen\u001b[0m \u001b]0;title\u0007done\u0007\r\nbell\u0008 x\ttab\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" + "y".repeat(50) + "\n\n  \n";
    const lines = sanitizePaneText(text, { lines: 4, width: 20 });
    expect(lines).toEqual(["green done", "bell x  tab", "token=[redacted]", "y".repeat(19) + "…"]);
    for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("redacts before truncating so a cut never shows part of a secret", () => {
    const [line] = sanitizePaneText("key ghp_abcdefghijklmnopqrstuvwxyz0123456789", { lines: 1, width: 10 });
    expect(line).toBe("key [reda…");
    expect(line).not.toContain("ghp_");
  });

  it("reads a verified owned pane with capture-pane -p only", async () => {
    const { fake, record, tail } = await hosted();
    fake.output = "\u001b[31mstep 1\u001b[0m\nstep 2 Bearer abc.def\n";
    expect(await tail.capture(lead, { lines: 8, width: 40 })).toEqual({ status: "ok", lines: ["step 1", "step 2 Bearer [redacted]"] });
    expect(fake.captures()).toEqual([["-L", record.socket, "capture-pane", "-p", "-J", "-t", record.paneId, "-S", "-8"]]);
    for (const args of fake.calls) expect(READ_ONLY.has(args[2])).toBe(true);
  });

  it("says no session and captures nothing without a verified ownership record", async () => {
    const { fake, tail } = await hosted();
    // A Developer seat has no record of its own here.
    expect(await tail.capture(dev, { lines: 8, width: 40 })).toEqual({ status: "no-session" });
    // A stale record: the tmux server or session is no longer the one Indra started.
    fake.identity = "999:456";
    expect(await tail.capture(lead, { lines: 8, width: 40 })).toEqual({ status: "no-session" });
    expect(await tail.capture({ id: "Bad Seat", roles: ["Developer"] }, { lines: 8, width: 40 })).toEqual({ status: "no-session" });
    expect(fake.captures()).toEqual([]);
    for (const args of fake.calls) expect(READ_ONLY.has(args[2])).toBe(true);
  });

  it("skips a tick while the previous capture runs, and drops results after stop or a seat change", async () => {
    let interval: (() => void) | undefined;
    let cleared = 0;
    const timers: PaneTailTimers = { setInterval: (run) => { interval = run; return 1; }, clearInterval: () => { cleared++; } };
    const pending: ((tail: PaneTail) => void)[] = [];
    const seen: string[] = [];
    const source: PaneTailSource = { capture: (seat) => new Promise((resolve) => { seen.push(seat.id); pending.push(resolve); }) };
    let seat: PaneTailSeat = lead;
    const results: [string, PaneTail][] = [];
    const poller = new PaneTailPoller(source, () => seat, () => ({ lines: 8, width: 40 }), (id, tail) => results.push([id, tail]), 1000, timers);
    poller.start();
    interval!(); interval!();
    expect(seen).toEqual(["seat-001"]);
    pending.shift()!({ status: "ok", lines: ["a"] });
    await Promise.resolve(); await Promise.resolve();
    expect(results).toEqual([["seat-001", { status: "ok", lines: ["a"] }]]);
    interval!();
    seat = dev;
    pending.shift()!({ status: "ok", lines: ["stale"] });
    await Promise.resolve(); await Promise.resolve();
    expect(results).toHaveLength(1);
    interval!();
    poller.stop();
    expect(cleared).toBe(1);
    pending.shift()!({ status: "ok", lines: ["late"] });
    await Promise.resolve(); await Promise.resolve();
    expect(results).toHaveLength(1);
    await poller.tick();
    expect(seen).toEqual(["seat-001", "seat-001", "seat-002"]);
  });

  it("classifies progress lines by their mark, and leaves everything else plain", () => {
    const kinds = [
      "12:34 # review",
      "12:34 ~ Running type checks",
      "12:34 › The change adds the five problems",
      "12:34 $ ✓ sed -n '1,160p' tests/state-check.test.ts",
      "12:34 $ ✓ git log --oneline",
      "12:34 $ … gh pr view 42",
      "12:34 $ ✓ cd /work/repo && GH_PAGER= git status",
      "12:34 $ ✓ github-cli --version",
      "12:34 $ ✗1 npm test",
      "12:34 » ✓ github.get_pr",
      "12:34 » ✗ github.get_pr",
      "12:34 ± add src/a.ts, update src/b.ts",
      "12:34 ± ✗ update src/b.ts",
      "12:34 · turn done (in 1, out 2)",
      "12:34 ! turn failed: stream disconnected",
      "23:44:50 [review] agent: an old-format line",
      "plain runner output",
      "12:34 ? unknown mark",
      "",
    ].map((line) => classifyPaneLine(line).kind);
    expect(kinds).toEqual(["purpose", "thinking", "agent", "command", "git", "git", "git", "command", "fail", "tool", "fail", "files", "fail", "info", "fail", "plain", "plain", "plain", "plain"]);
    expect(classifyPaneLine("12:34 $ ✓ git status")).toEqual({ time: "12:34", kind: "git", text: "$ ✓ git status" });
    expect(classifyPaneLine("runner started")).toEqual({ kind: "plain", text: "runner started" });
  });

  it("colours each kind of line and dims the time in the panel", async () => {
    const source: PaneTailSource = { capture: async () => ({ status: "ok", lines: sanitizePaneText([
      formatProgressLine("# review", when), formatProgressLine("~ Checking the schema", when), formatProgressLine("› Looks good", when),
      formatProgressLine("$ ✓ npm run typecheck", when), formatProgressLine("$ ✓ git diff --stat", when), formatProgressLine("± update src/a.ts", when),
      formatProgressLine(`$ ✗2 sed -n '1,160p' ${"tests/very/long/path/".repeat(4)}file.ts`, when), "plain output",
    ].join("\n"), { lines: 10, width: 40 }) }) };
    const seat = () => ({ ...lead, displayName: "Chick Corea" });
    const setup = await testRender(() => <PaneTailPanel source={source} seat={seat} width={() => 40} lines={() => 10} />, { width: 44, height: 12 });
    try {
      await setup.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const colourOf = (text: string) => { const span = spans.find((candidate) => candidate.text.includes(text)); expect(span, text).toBeDefined(); return span!.fg; };
      const expectColour = (text: string, colour: string) => expect(colourOf(text).equals(RGBA.fromHex(colour)), text).toBe(true);
      expectColour("# review", PANE_LINE_COLOR.purpose);
      expectColour("~ Checking the schema", PANE_LINE_COLOR.thinking);
      expectColour("› Looks good", PANE_LINE_COLOR.agent);
      expectColour("$ ✓ npm run typecheck", PANE_LINE_COLOR.command);
      expectColour("$ ✓ git diff --stat", PANE_LINE_COLOR.git);
      expectColour("± update src/a.ts", PANE_LINE_COLOR.files);
      expectColour("$ ✗2 sed -n", PANE_LINE_COLOR.fail);
      expectColour("plain output", PANE_LINE_COLOR.plain);
      expectColour("12:34", PANE_LINE_COLOR.time);
      // The failed command's exit code survives the cut to the panel width.
      expect(setup.captureCharFrame()).toMatch(/12:34 \$ ✗2 sed -n '1,160p' tests\/very\/\S*…/);
      expect(setup.captureCharFrame()).not.toMatch(/\[(?:review|build)\]/);
    } finally { setup.renderer.destroy(); }
  });

  it("fits between 8 and 15 lines", () => {
    expect([paneTailLines(10), paneTailLines(30), paneTailLines(60)]).toEqual([8, 9, 15]);
  });

  it("shows the selected seat's pane while its detail is open and stops capturing when it closes", async () => {
    const snapshot: StateSnapshot = {
      teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "t", seats: [
        { id: "seat-001", displayName: "Chick Corea", handle: "chickcorea", mattermostUserId: "u1", roles: ["Team Lead"] },
        { id: "seat-002", displayName: "George Duke", handle: "georgeduke", mattermostUserId: "u2", roles: ["Developer"] },
      ] }],
      sprints: [],
    };
    const calls: string[] = [];
    const source: PaneTailSource = { capture: async (seat) => { calls.push(seat.id); return seat.id === "seat-001" ? { status: "ok", lines: ["Chick is planning", "second line"] } : { status: "no-session" }; } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) });
    await model.refresh();
    const [revision, setRevision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} paneTail={source} />, { width: 80, height: 30 });
    try {
      model.page = "teams";
      model.revision++;
      setRevision(model.revision);
      await setup.renderOnce();
      expect(calls).toEqual([]);
      model.page = "seat";
      model.seatId = "seat-001";
      model.revision++;
      setRevision(model.revision);
      await setup.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      expect(frame).toContain("LIVE PANE · Chick Corea");
      expect(frame).toContain("Chick is planning");
      model.seatId = "seat-002";
      model.revision++;
      setRevision(model.revision);
      await setup.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      expect(frame).toContain("LIVE PANE · George Duke");
      expect(frame).toContain("no session");
      expect(frame).not.toContain("Chick is planning");
      model.page = "teams";
      model.revision++;
      setRevision(model.revision);
      await setup.renderOnce();
      const count = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(calls.length).toBe(count);
    } finally { setup.renderer.destroy(); }
  });
});
