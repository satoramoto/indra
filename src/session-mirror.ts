/**
 * A seat's live session shown inside Indra's own screen. The UI mirrors the seat's Indra-owned tmux pane with
 * `capture-pane -e -p` a few times a second while the pane is on screen, and, only while the owner has focused the
 * pane on a seat with a headed run going, forwards their keys to it with `send-keys`. The owner never attaches to the
 * seat's tmux session and never sees a tmux key or status line.
 *
 * Every tmux command names Indra's own seat socket and a pane taken from the ownership record TmuxHost verifies for
 * this checkout and seat (the same check the supervisor uses). Anything unverified is neither read nor written.
 */
import { ansiToLines, type MirrorLine } from "./ansi-lines.js";
import { headedMarkerFile, readHeadedMarker } from "./headed-session.js";
import { redactSecrets } from "./redact.js";
import { defaultAppDir, hostedProcessFor, SystemTmux, TmuxHost, type HostRecord, type TmuxRunner } from "./tmux-host.js";

/** The seat whose session to show: Team Lead seats show Chick's bridge, other seats their own runner. */
export interface MirrorSeat { id: string; roles: string[] }
/** Rows and columns inside the pane, and how many lines the owner scrolled back from live (0 is live). */
export interface MirrorSize { rows: number; width: number; scroll: number }
/** `no-session`: no verified, Indra-owned pane for this seat, so nothing was read. */
export type MirrorFrame =
  | { status: "ok"; lines: MirrorLine[]; headed?: "claude" | "codex" }
  | { status: "no-session" }
  | { status: "error"; message: string };

/** The verified pane the owner is driving. */
export interface DriveTarget { seatId: string; socket: string; paneId: string }
export type DriveResult = { ok: true; target: DriveTarget } | { ok: false; reason: "no-session" | "not-headed" };

/** A key to forward: literal text, or a tmux key name such as `Enter`, `Up` or `C-c`. */
export type TmuxKey = { literal: string } | { key: string };

export interface SessionPort {
  capture(seat: MirrorSeat, size: MirrorSize): Promise<MirrorFrame>;
  /** Verifies the seat's pane and its headed run, then switches the pane's input on. */
  drive(seat: MirrorSeat): Promise<DriveResult>;
  send(target: DriveTarget, keys: TmuxKey[]): Promise<void>;
  paste(target: DriveTarget, text: string): Promise<void>;
  /** Switches the pane's input back off. */
  release(target: DriveTarget): Promise<void>;
}

/** Lines the owner may scroll back through. */
export const MAX_SCROLLBACK = 2000;
/** How long a verified ownership record is reused before it is checked again. */
export const VERIFY_MS = 1000;

const PANE = /^%\d+$/;
const SOCKET = /^indra-[0-9a-f]{12}$/;

/**
 * tmux splits commands at an argument that ends in `;`, dropping the `;`; `\;` at the end keeps it. Text the owner
 * typed or pasted is escaped this way so it always arrives whole and never ends a command.
 */
export function tmuxText(text: string): string {
  return text.endsWith(";") ? text.slice(0, -1) + "\\;" : text;
}

/** The tmux commands that send `keys` to a verified pane, as one tmux invocation (commands joined by `;`). */
export function sendKeysArgs(target: DriveTarget, keys: TmuxKey[]): string[] {
  if (!PANE.test(target.paneId) || !SOCKET.test(target.socket)) throw new Error("Refusing to send keys to a pane Indra has not verified.");
  const commands: string[][] = [];
  for (const key of keys) {
    const last = commands.at(-1);
    if ("literal" in key) {
      if (!key.literal) continue;
      // Consecutive text goes in one literal send.
      if (last && last[3] === "-l") last[5] += key.literal;
      else commands.push(["send-keys", "-t", target.paneId, "-l", "--", key.literal]);
    } else if (last && last[3] !== "-l") last.push(key.key);
    else commands.push(["send-keys", "-t", target.paneId, key.key]);
  }
  for (const command of commands) if (command[3] === "-l") command[5] = tmuxText(command[5]!);
  return ["-L", target.socket, ...commands.flatMap((command, index) => index ? [";", ...command] : command)];
}

export class TmuxSeatSession implements SessionPort {
  private verified = new Map<string, { record: HostRecord; at: number }>();
  private sized = new Map<string, string>();

  constructor(
    private readonly checkout: string,
    private readonly runner: TmuxRunner = new SystemTmux(),
    private readonly appDir = defaultAppDir,
    private readonly alive?: (pid: number) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** The seat's verified ownership record, reused for up to VERIFY_MS so a mirror at several frames a second stays cheap. */
  private async record(seat: MirrorSeat, fresh = false): Promise<HostRecord | undefined> {
    const cached = this.verified.get(seat.id);
    if (!fresh && cached && this.now() - cached.at < VERIFY_MS) return cached.record;
    let host: TmuxHost;
    try { host = new TmuxHost(this.checkout, this.runner, this.appDir, undefined, hostedProcessFor(seat)); }
    catch { return undefined; }
    const record = await host.verifiedRecord().catch(() => undefined);
    if (record) this.verified.set(seat.id, { record, at: this.now() });
    else this.verified.delete(seat.id);
    return record;
  }

  private async headed(record: HostRecord) {
    return await readHeadedMarker(headedMarkerFile(this.checkout, record.readyNonce), this.alive).catch(() => undefined);
  }

  async capture(seat: MirrorSeat, size: MirrorSize): Promise<MirrorFrame> {
    const record = await this.record(seat);
    if (!record) return { status: "no-session" };
    const rows = Math.max(1, Math.floor(size.rows));
    const width = Math.max(10, Math.floor(size.width));
    const scroll = Math.max(0, Math.min(MAX_SCROLLBACK, Math.floor(size.scroll)));
    try {
      // The seat's window is sized to the pane on Indra's own socket, so the headed CLI draws to fit it.
      const wanted = `${width}x${rows}`;
      if (this.sized.get(record.paneId) !== wanted) {
        await this.runner.run(["-L", record.socket, "resize-window", "-t", record.paneId, "-x", String(width), "-y", String(rows)]).catch(() => "");
        this.sized.set(record.paneId, wanted);
      }
      const text = await this.runner.run(["-L", record.socket, "capture-pane", "-p", "-e", "-t", record.paneId, "-S", String(-scroll), "-E", String(rows - 1 - scroll)]);
      const marker = await this.headed(record);
      return { status: "ok", lines: ansiToLines(text, { rows, width }), ...(marker ? { headed: marker.engine } : {}) };
    } catch (error) {
      return { status: "error", message: redactSecrets(error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200) || "capture failed" };
    }
  }

  async drive(seat: MirrorSeat): Promise<DriveResult> {
    const record = await this.record(seat, true);
    if (!record) return { ok: false, reason: "no-session" };
    if (!await this.headed(record)) return { ok: false, reason: "not-headed" };
    await this.runner.run(["-L", record.socket, "select-pane", "-e", "-t", record.paneId]);
    return { ok: true, target: { seatId: seat.id, socket: record.socket, paneId: record.paneId } };
  }

  async send(target: DriveTarget, keys: TmuxKey[]): Promise<void> {
    if (keys.length) await this.runner.run(sendKeysArgs(target, keys));
  }

  async paste(target: DriveTarget, text: string): Promise<void> {
    if (!PANE.test(target.paneId) || !SOCKET.test(target.socket)) throw new Error("Refusing to paste into a pane Indra has not verified.");
    const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    if (!clean) return;
    // A named buffer on Indra's own socket, pasted with bracketed paste when the CLI asked for it, then deleted.
    await this.runner.run(["-L", target.socket, "set-buffer", "-b", "indra-drive", "--", tmuxText(clean), ";", "paste-buffer", "-p", "-d", "-b", "indra-drive", "-t", target.paneId]);
  }

  async release(target: DriveTarget): Promise<void> {
    if (!PANE.test(target.paneId) || !SOCKET.test(target.socket)) return;
    await this.runner.run(["-L", target.socket, "select-pane", "-d", "-t", target.paneId]);
  }
}

const NAMED: Record<string, string> = {
  return: "Enter", enter: "Enter", linefeed: "Enter", escape: "Escape", backspace: "BSpace", delete: "DC", insert: "IC", tab: "Tab",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PPage", pagedown: "NPage",
};

/** The tmux key for one OpenTUI key event, or undefined for a key that has no safe equivalent (it is dropped). */
export function tmuxKey(name: string, sequence?: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): TmuxKey | undefined {
  const lower = name.toLowerCase();
  if (mods.ctrl && /^[a-z]$/.test(lower)) return { key: "C-" + lower };
  if (lower === "tab" && mods.shift) return { key: "BTab" };
  if (NAMED[lower]) return { key: (mods.meta && !["escape"].includes(lower) ? "M-" : "") + NAMED[lower] };
  if (/^f([1-9]|1[0-2])$/.test(lower)) return { key: lower.toUpperCase() };
  if (lower === "space") return { literal: " " };
  if (sequence && !/[\u0000-\u001f\u007f-\u009f]/.test(sequence)) return mods.meta && Array.from(sequence).length === 1 ? { key: "M-" + sequence } : { literal: sequence };
  return undefined;
}

/**
 * Sends forwarded keys in order, in one tmux call per task: a burst of typed characters arrives as one stdin chunk,
 * so it becomes one `send-keys`, and the next batch waits for the previous one.
 */
export class KeyForwarder {
  private queue: TmuxKey[] = [];
  private scheduled = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly send: (keys: TmuxKey[]) => Promise<void>, private readonly failed: (error: unknown) => void = () => {}) {}

  push(key: TmuxKey): void {
    this.queue.push(key);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const keys = this.queue;
      this.queue = [];
      this.chain = this.chain.then(() => this.send(keys)).catch((error: unknown) => this.failed(error));
    });
  }

  /** Resolves once everything pushed so far was sent. */
  async idle(): Promise<void> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await this.chain;
  }
}

export interface MirrorTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const systemTimers: MirrorTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** The fastest the mirror refreshes: 10 frames a second. */
export const MIN_MIRROR_MS = 100;
/** The default: about 7 frames a second. */
export const MIRROR_MS = 150;

/**
 * Captures the shown seat's pane on a bounded timer while started. A tick is skipped while `seat()` is undefined (the
 * pane is hidden) or the previous capture is still running; a frame is delivered only when it differs from the last
 * one, so an idle session redraws nothing; and a result is dropped if the view stopped or the seat changed meanwhile.
 */
export class MirrorPoller {
  private handle: unknown;
  private busy = false;
  private running = false;
  private last?: string;
  readonly intervalMs: number;

  constructor(
    private readonly source: Pick<SessionPort, "capture">,
    private readonly seat: () => MirrorSeat | undefined,
    private readonly size: () => MirrorSize,
    private readonly onFrame: (seatId: string, frame: MirrorFrame) => void,
    intervalMs = MIRROR_MS,
    private readonly timers: MirrorTimers = systemTimers,
  ) { this.intervalMs = Math.max(MIN_MIRROR_MS, intervalMs); }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handle = this.timers.setInterval(() => { void this.tick(); }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }

  async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    const seat = this.seat();
    if (!seat) return;
    const size = this.size();
    this.busy = true;
    try {
      const frame = await this.source.capture(seat, size).catch((error: unknown): MirrorFrame => ({ status: "error", message: redactSecrets(error instanceof Error ? error.message : String(error)) }));
      const key = seat.id + "\u0000" + JSON.stringify(size) + "\u0000" + JSON.stringify(frame);
      if (this.running && this.seat()?.id === seat.id && key !== this.last) { this.last = key; this.onFrame(seat.id, frame); }
    } finally { this.busy = false; }
    // A new seat or size is captured as soon as the previous capture ends rather than on the next tick.
    const next = this.running ? this.seat() : undefined;
    if (next && (next.id !== seat.id || JSON.stringify(this.size()) !== JSON.stringify(size))) await this.tick();
  }
}
