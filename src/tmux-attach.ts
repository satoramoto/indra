import { spawn } from "node:child_process";
import { childEnv } from "./op-env.js";

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

/** Inspect only the verified target supplied by the runtime reader. Detaching leaves the bridge running. */
export async function attachTmux(target: string, run: TmuxCommand = tmux): Promise<void> {
  const { socket, session } = parseOwnedTmuxTarget(target);
  const exact = "=" + session;
  try {
    const exists = await run(["-L", socket, "has-session", "-t", exact], "ignore");
    if (exists !== 0) throw new Error("The Indra tmux bridge is no longer available. Refresh to check its status.");
    const result = await run(["-L", socket, "attach-session", "-r", "-t", exact], "inherit");
    if (result !== 0) throw new Error("tmux could not attach to the Indra bridge.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("tmux is not installed or is not on PATH.");
    }
    throw error;
  }
}
