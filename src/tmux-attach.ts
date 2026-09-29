import { spawn } from "node:child_process";
import { childEnv } from "./op-env.js";
import { attachSetup, driveTeardown, type AttachMode, type OwnedSessionCheck } from "./tmux-attach-owned.js";

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
 *
 * `drive` asks for the pane's input to stay on so the owner types into the live headed CLI. It is honoured only for a
 * session `verify` confirms as Indra's own with a headed run going; otherwise it falls back to watching. Returns what
 * was opened: `drive`, `watch`, or `read-only` (an unverified session, or a setup that failed).
 */
export async function attachTmux(target: string, run: TmuxCommand = tmux, verify?: OwnedSessionCheck, mode: AttachMode = "watch"): Promise<AttachMode | "read-only"> {
  const { socket, session } = parseOwnedTmuxTarget(target);
  const exact = "=" + session;
  try {
    const exists = await run(["-L", socket, "has-session", "-t", exact], "ignore");
    if (exists !== 0) throw new Error("This seat's live view is no longer available. Refresh to check its status.");
    const owned = verify ? await verify(socket, session).catch(() => undefined) : undefined;
    const wanted: AttachMode = mode === "drive" && owned?.headed === true ? "drive" : "watch";
    let prepared = false;
    if (owned) {
      prepared = true;
      for (const args of attachSetup(socket, session, owned.paneId, wanted)) {
        if (await run(args, "ignore") !== 0) { prepared = false; break; }
      }
    }
    // A writable client is used only once the pane is set up: input off to watch (the mouse wheel and PgUp scroll),
    // or input on to drive.
    const result = await run(["-L", socket, "attach-session", ...(prepared ? [] : ["-r"]), "-t", exact], "inherit");
    // Back from driving, or from a drive setup that stopped part-way: the pane's input goes back off.
    if (owned && wanted === "drive") await run(driveTeardown(socket, owned.paneId), "ignore").catch(() => 1);
    if (result !== 0) throw new Error("Could not open this seat's live view.");
    return prepared ? wanted : "read-only";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("The live view needs tmux, which is not installed or is not on PATH.");
    }
    throw error;
  }
}
