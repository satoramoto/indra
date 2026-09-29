import { spawn } from "node:child_process";
import { childEnv } from "./op-env.js";
import { watchSetup, type OwnedSessionCheck } from "./tmux-attach-owned.js";

export function parseOwnedTmuxTarget(target: string): { socket: string; session: string } {
  const match = /^([a-z0-9-]+):([a-z0-9-]+)$/.exec(target);
  if (!match) throw new Error("The runtime did not provide a valid Indra tmux target.");
  return { socket: match[1], session: match[2] };
}

export type TmuxCommand = (args: string[], stdio: "ignore" | "inherit") => Promise<number>;

function tmux(args: string[], stdio: "ignore" | "inherit"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { stdio, shell: false, env: childEnv() });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Inspect only the verified target supplied by the runtime reader. Detaching leaves the bridge running.
 *
 * With `verify`, a session it confirms as Indra's own gets the watch setup (tmux-attach-owned.ts): the return key,
 * scrolling, a status line, and its pane's input switched off, so the owner watches without being able to type into
 * the run. Without `verify`, or when any of that fails, the client attaches read-only and nothing is changed.
 */
export async function attachTmux(target: string, run: TmuxCommand = tmux, verify?: OwnedSessionCheck): Promise<void> {
  const { socket, session } = parseOwnedTmuxTarget(target);
  const exact = "=" + session;
  try {
    const exists = await run(["-L", socket, "has-session", "-t", exact], "ignore");
    if (exists !== 0) throw new Error("This seat's live view is no longer available. Refresh to check its status.");
    const owned = verify ? await verify(socket, session).catch(() => undefined) : undefined;
    let inputOff = false;
    if (owned) {
      inputOff = true;
      for (const args of watchSetup(socket, session, owned.paneId)) {
        if (await run(args, "ignore") !== 0) { inputOff = false; break; }
      }
    }
    // A writable client is used only once the pane ignores input; it lets the mouse wheel and PgUp scroll.
    const result = await run(["-L", socket, "attach-session", ...(inputOff ? [] : ["-r"]), "-t", exact], "inherit");
    if (result !== 0) throw new Error("Could not open this seat's live view.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("The live view needs tmux, which is not installed or is not on PATH.");
    }
    throw error;
  }
}
