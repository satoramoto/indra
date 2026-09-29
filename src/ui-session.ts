/**
 * `npm start` keeps the terminal UI in Indra's own UI session (socket `indra-ui`, session `ui`), so closing the
 * terminal window leaves Indra running and the next `npm start` brings the same UI back. The owner never types a
 * tmux command. Imported only by the launcher, so it stays small: Node built-ins only.
 *
 * - Inside that session (`$TMUX` names the `indra-ui` socket), or for a non-UI command (`planning …`, `--once`, …),
 *   or without a terminal, the launcher runs the CLI directly, as before.
 * - Otherwise, when the `ui` session exists, it attaches to it; when it does not, it creates it running this
 *   launcher with the same arguments, and attaches. Quitting the UI ends the session, which ends the attached client.
 *
 * Only the `indra-ui` socket is ever addressed; the owner's own tmux server and configuration are never touched.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";

export const UI_SOCKET = "indra-ui";
export const UI_SESSION = "ui";

export type Tmux = (args: string[], stdio: "ignore" | "inherit") => Promise<number>;

/** True for the arguments that open the terminal UI: none, `--ui`, and `--state PATH`. */
export function isUiInvocation(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--ui") continue;
    if (args[index] === "--state" && index + 1 < args.length) { index++; continue; }
    return false;
  }
  return true;
}

/** True when this process runs in a pane of Indra's UI socket (`$TMUX` is `socket-path,pid,session`). */
export function insideUiSession(env: NodeJS.ProcessEnv): boolean {
  const socket = env.TMUX?.split(",")[0];
  return !!socket && basename(socket) === UI_SOCKET;
}

export interface UiSessionFacts { args: readonly string[]; env: NodeJS.ProcessEnv; tty: boolean }
export type UiSessionPlan = { kind: "run" } | { kind: "session" };

/** Whether the launcher runs the CLI here, or goes through the UI session. */
export function uiSessionPlan(facts: UiSessionFacts): UiSessionPlan {
  return !facts.tty || !isUiInvocation(facts.args) || insideUiSession(facts.env) ? { kind: "run" } : { kind: "session" };
}

const exact = `=${UI_SESSION}`;
/**
 * Hides the status bar in the UI session, so nothing on screen names tmux, and switches every tmux key off on Indra's
 * own UI socket (never the owner's server): no prefix key and no root-table bindings, so Ctrl-b and the rest reach
 * Indra, and with tmux's mouse off every click and wheel goes to Indra too.
 */
const hideStatus = [
  ";", "set-option", "-t", `${exact}:`, "status", "off",
  ";", "set-option", "-g", "prefix", "None",
  ";", "set-option", "-g", "prefix2", "None",
  ";", "set-option", "-g", "mouse", "off",
  ";", "unbind-key", "-a", "-T", "root",
];

/**
 * The tmux command that brings the owner to the UI: attach when the session exists, otherwise create it running
 * `command` in `cwd`. `new-session -A` still attaches if another terminal created the session meanwhile.
 */
export function uiSessionCommand(exists: boolean, command: readonly string[], cwd: string): string[] {
  return exists
    ? ["-L", UI_SOCKET, "attach-session", "-t", exact, ...hideStatus]
    : ["-L", UI_SOCKET, "new-session", "-A", "-s", UI_SESSION, "-c", cwd, ...command, ...hideStatus];
}

/**
 * Attaches to, or creates and attaches to, the UI session. Returns the tmux client's exit code, or undefined when
 * tmux is unavailable so the caller runs the UI directly.
 */
export async function enterUiSession(command: readonly string[], cwd: string, tmux: Tmux = systemTmux): Promise<number | undefined> {
  let exists: boolean;
  try { exists = await tmux(["-L", UI_SOCKET, "has-session", "-t", exact], "ignore") === 0; }
  catch { return undefined; }
  return await tmux(uiSessionCommand(exists, command, cwd), "inherit");
}

function systemTmux(args: string[], stdio: "ignore" | "inherit"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { stdio, shell: false });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
