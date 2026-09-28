import { redactSecrets } from "./redact.js";
import { defaultAppDir, hostedProcessFor, SystemTmux, TmuxHost, type TmuxRunner } from "./tmux-host.js";

/** The seat whose hosted process to read: Team Lead seats read Chick's bridge, other seats their own runner. */
export interface PaneTailSeat { id: string; roles: string[] }
export interface PaneTailSize { lines: number; width: number }
/** `no-session`: no verified, Indra-owned tmux pane for this seat, so nothing was read. */
export type PaneTail = { status: "ok"; lines: string[] } | { status: "no-session" } | { status: "error"; message: string };
export interface PaneTailSource { capture(seat: PaneTailSeat, size: PaneTailSize): Promise<PaneTail> }

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, and two-byte escapes.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u009d[^\u0007\u009c]*[\u0007\u009c]?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]/g;

function truncate(line: string, width: number): string {
  const chars = Array.from(line);
  return chars.length <= width ? line : chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

/**
 * Makes captured pane text safe to draw: strips terminal escapes and control characters, redacts anything
 * token-shaped, drops trailing blank lines, and keeps the last `lines` lines cut to `width` characters.
 * Redaction runs before truncation so a cut can never expose part of a secret.
 */
export function sanitizePaneText(text: string, size: PaneTailSize): string[] {
  const width = Math.max(1, Math.floor(size.width));
  const count = Math.max(0, Math.floor(size.lines));
  const plain = text
    .replace(ESCAPES, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
  const lines = redactSecrets(plain).split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return count ? lines.slice(-count).map((line) => truncate(line, width)) : [];
}

/**
 * Reads the tail of a seat's Indra-owned tmux pane with `capture-pane -p` only. The pane is read only after
 * TmuxHost verifies the ownership record for this checkout and seat, the same check the supervisor uses; with no
 * verified record it reads nothing and reports `no-session`.
 */
export class TmuxPaneTail implements PaneTailSource {
  constructor(private readonly checkout: string, private readonly runner: TmuxRunner = new SystemTmux(), private readonly appDir = defaultAppDir) {}

  async capture(seat: PaneTailSeat, size: PaneTailSize): Promise<PaneTail> {
    let host: TmuxHost;
    try { host = new TmuxHost(this.checkout, this.runner, this.appDir, undefined, hostedProcessFor(seat)); }
    catch { return { status: "no-session" }; }
    const record = await host.verifiedRecord().catch(() => undefined);
    if (!record) return { status: "no-session" };
    const history = Math.max(1, Math.floor(size.lines));
    try {
      // -J joins wrapped lines; -S reaches a little into history in case the visible pane is mostly blank.
      const text = await this.runner.run(["-L", record.socket, "capture-pane", "-p", "-J", "-t", record.paneId, "-S", `-${history}`]);
      return { status: "ok", lines: sanitizePaneText(text, size) };
    } catch (error) {
      return { status: "error", message: sanitizePaneText(error instanceof Error ? error.message : String(error), { lines: 1, width: size.width })[0] ?? "capture failed" };
    }
  }
}

export interface PaneTailTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const systemTimers: PaneTailTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Captures the selected seat's pane about once a second while started. A tick is skipped while the previous
 * capture is still running, and a result is dropped if the view stopped or the seat changed meanwhile.
 */
export class PaneTailPoller {
  private handle: unknown;
  private busy = false;
  private running = false;

  constructor(
    private readonly source: PaneTailSource,
    private readonly seat: () => PaneTailSeat | undefined,
    private readonly size: () => PaneTailSize,
    private readonly onResult: (seatId: string, tail: PaneTail) => void,
    private readonly intervalMs = 1000,
    private readonly timers: PaneTailTimers = systemTimers,
  ) {}

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
    this.busy = true;
    try {
      const tail = await this.source.capture(seat, this.size()).catch((error: unknown): PaneTail => ({ status: "error", message: redactSecrets(error instanceof Error ? error.message : String(error)) }));
      if (this.running && this.seat()?.id === seat.id) this.onResult(seat.id, tail);
    } finally { this.busy = false; }
  }
}
