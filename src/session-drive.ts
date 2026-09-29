import { KeyForwarder, tmuxKey, type DriveTarget, type SessionPort } from "./session-mirror.js";
import type { KeyMods, TerminalUiModel } from "./terminal-ui.js";

/**
 * Keeps a seat pane's input in line with the terminal UI: on only while the owner has focused the session pane of a
 * seat with a headed run going (the model's `driving` is `on`), off as soon as they leave it, switch seats or quit.
 * Keys and pastes reach the pane only while that holds.
 */
export class SessionDriver {
  private target?: DriveTarget;
  private forwarder?: KeyForwarder;
  private checking = false;

  constructor(private readonly model: TerminalUiModel, private readonly port: SessionPort, private readonly publish: () => void) {}

  /** Call after anything that may change the model's focus or driving state. */
  sync(): void {
    const want = this.model.driving;
    if (this.target && (!this.model.drivingOn() || want?.seatId !== this.target.seatId)) this.release();
    if (want?.state !== "checking" || this.checking) return;
    const seat = this.model.seat;
    if (!seat || seat.id !== want.seatId) return;
    this.checking = true;
    void this.port.drive(seat).catch(() => ({ ok: false as const, reason: "no-session" as const })).then((result) => {
      this.checking = false;
      const kept = this.model.driveResult(want.seatId, result.ok ? { ok: true } : result);
      if (result.ok && kept) {
        this.target = result.target;
        const target = result.target;
        this.forwarder = new KeyForwarder((keys) => this.port.send(target, keys), (error) => this.lost(error));
      } else if (result.ok) void this.port.release(result.target).catch(() => {});
      this.publish();
      this.sync();
    });
  }

  /** Forwards one key, only while driving. Returns whether it was forwarded. */
  key(name: string, text: string | undefined, mods: KeyMods = {}): boolean {
    if (!this.target || !this.forwarder || !this.model.drivingOn()) return false;
    const key = tmuxKey(name, text, mods);
    if (!key) return false;
    this.forwarder.push(key);
    return true;
  }

  /** Pastes into the driven session, only while driving. */
  paste(text: string): boolean {
    const target = this.target;
    if (!target || !this.forwarder || !this.model.drivingOn()) return false;
    const forwarder = this.forwarder;
    void forwarder.idle().then(() => this.port.paste(target, text)).catch((error: unknown) => this.lost(error));
    return true;
  }

  /** Switches the pane's input back off, after the keys already typed reach it. */
  release(): Promise<void> {
    const target = this.target;
    const forwarder = this.forwarder;
    this.target = undefined;
    this.forwarder = undefined;
    if (!target) return Promise.resolve();
    return (forwarder ? forwarder.idle() : Promise.resolve()).then(() => this.port.release(target)).catch(() => {});
  }

  private lost(error: unknown): void {
    this.model.notice = "Stopped driving: the session did not take the keys (" + (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 120) + ").";
    this.model.setFocus("details");
    this.publish();
    this.sync();
  }
}
