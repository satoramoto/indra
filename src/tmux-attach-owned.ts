/**
 * What Indra sets up before the owner watches a seat: only on Indra's own seat socket, and only after the ownership
 * record for that exact session is verified (TmuxHost.verifiedRecord, the same check the supervisor uses).
 *
 * - Server level, on Indra's own socket only (`indra-<hash>`, never the owner's server or ~/.tmux.conf): the return
 *   key detaches, PgUp starts scrolling back, and the mouse wheel scrolls; there is no prefix key and no mouse menu.
 * - Session level, on the verified session only: a status line that says how to get back and how to scroll.
 * - Pane level, on the verified pane only: keyboard input is switched off, so nothing the owner types reaches the
 *   headless run while scrolling works.
 */
import { defaultAppDir, SystemTmux, TmuxHost, type HostedProcess, type TmuxRunner } from "./tmux-host.js";
import { RETURN_KEY_TMUX, WATCH_HINT } from "./watch-keys.js";

/** The seat session's verified pane; undefined when the session is not Indra's own verified one. */
export type OwnedSessionCheck = (socket: string, session: string) => Promise<{ paneId: string } | undefined>;

const SUFFIX = "[0-9a-f]{12}";

/** The hosted process a session name belongs to under TmuxHost's naming, or undefined for any other name. */
export function hostedProcessOfSession(session: string): HostedProcess | undefined {
  if (new RegExp(`^chick-${SUFFIX}$`).test(session)) return { kind: "bridge" };
  const seat = new RegExp(`^dev-([a-z][a-z0-9-]+)-${SUFFIX}$`).exec(session);
  return seat ? { kind: "seat", seatId: seat[1]! } : undefined;
}

/**
 * Verifies that `socket:session` is this checkout's own hosted session with a live ownership record, and returns its
 * pane. Anything else, including a name that merely looks like Indra's, returns undefined.
 */
export async function verifyOwnedSession(checkout: string, socket: string, session: string, runner: TmuxRunner = new SystemTmux(), appDir = defaultAppDir): Promise<{ paneId: string } | undefined> {
  const hosted = hostedProcessOfSession(session);
  if (!hosted) return undefined;
  let host: TmuxHost;
  try { host = new TmuxHost(checkout, runner, appDir, undefined, hosted); } catch { return undefined; }
  if (host.socket !== socket || host.session !== session) return undefined;
  const record = await host.verifiedRecord().catch(() => undefined);
  return record && record.session === session && record.socket === socket ? { paneId: record.paneId } : undefined;
}

/** Default mouse bindings that paste into a pane or open menus with kill, respawn and split. */
export const UNSAFE_MOUSE = ["MouseDown2Pane", "MouseDown3Pane", "M-MouseDown3Pane", "MouseDown3Status", "M-MouseDown3Status", "MouseDown3StatusLeft", "M-MouseDown3StatusLeft"];

/** The tmux commands that prepare a verified seat session for watching; every one names the owned socket. */
export function watchSetup(socket: string, session: string, paneId: string): string[][] {
  if (!/^%\d+$/.test(paneId)) throw new Error("Invalid pane ID for an owned session.");
  const server = (...args: string[]) => ["-L", socket, ...args];
  const target = `=${session}:`;
  return [
    // The watching client is writable (so scrolling works); no prefix and no mouse menus leave it no way to kill,
    // respawn, paste into or split the seat's pane.
    server("set-option", "-g", "prefix", "None"),
    server("set-option", "-g", "prefix2", "None"),
    ...UNSAFE_MOUSE.map((key) => server("unbind-key", "-q", "-n", key)),
    server("bind-key", "-n", RETURN_KEY_TMUX, "detach-client"),
    server("bind-key", "-n", "PPage", "copy-mode", "-eu"),
    server("set-option", "-g", "mouse", "on"),
    server("set-option", "-t", target, "status", "on"),
    server("set-option", "-t", target, "status-style", "bg=colour236,fg=colour252"),
    server("set-option", "-t", target, "status-left", " Indra · watching (read-only) "),
    server("set-option", "-t", target, "status-left-length", "40"),
    server("set-option", "-t", target, "status-right", ` ${WATCH_HINT} `),
    server("set-option", "-t", target, "status-right-length", "120"),
    server("select-pane", "-d", "-t", paneId),
  ];
}
