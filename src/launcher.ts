import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * `npm start` runs this small launcher. It runs the CLI as a child with the terminal inherited and starts it
 * again, on whatever build is in `dist/` then, when the child exits with RELOAD_EXIT_CODE. Any other exit ends it.
 * It always starts `dist/cli.js`, so a reload follows the `dist` symlink to the newest build.
 * It imports only the small helpers it shares with the CLI, so it rarely needs to change. Nothing else may import
 * this file: the build would move it into a shared chunk and the entry check below would never match.
 */
import { appRootOf, isEntry, LAUNCHER_ENV, RELOAD_EXIT_CODE } from "./reload.js";
import { enterUiSession, insideUiSession, uiSessionPlan } from "./ui-session.js";

export { LAUNCHER_ENV, RELOAD_EXIT_CODE };

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

export async function launch(run: () => Promise<ChildExit>): Promise<number> {
  while (true) {
    const { code, signal } = await run();
    if (code === RELOAD_EXIT_CODE) continue;
    return code ?? (signal ? 1 : 0);
  }
}

/** Runs one CLI child with the terminal inherited; SIGTERM and SIGHUP sent to the launcher are passed on. */
export function cliChild(cli: string, args: string[], nodeArgs = ["--experimental-ffi", "--use-system-ca"]): () => Promise<ChildExit> {
  return () => new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { stdio: "inherit", env: { ...process.env, [LAUNCHER_ENV]: "1" } });
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    const done = (exit: ChildExit) => { process.off("SIGTERM", forward); process.off("SIGHUP", forward); resolve(exit); };
    child.on("error", () => done({ code: 1, signal: null }));
    child.on("exit", (code, signal) => done({ code, signal }));
  });
}

/** Keeps a failed UI's last words on screen inside the UI session, which would otherwise close with the pane. */
function waitForEnter(code: number): Promise<void> {
  process.stdout.write(`\nIndra exited with code ${code}. Press Enter to close.\n`);
  return new Promise((resolve) => { process.stdin.once("data", () => { process.stdin.pause(); resolve(); }); process.stdin.resume(); });
}

if (isEntry(import.meta.url)) {
  const root = appRootOf(import.meta.url);
  const args = process.argv.slice(2);
  const facts = { args, env: process.env, tty: !!process.stdin.isTTY && !!process.stdout.isTTY };
  // Outside Indra's UI session, `npm start` creates it, or reattaches to the UI already running there.
  const entered = uiSessionPlan(facts).kind === "session"
    ? await enterUiSession([process.execPath, join(root, "dist", "launcher.js"), ...args], process.cwd())
    : undefined;
  if (entered !== undefined) process.exitCode = entered;
  else {
    // Ctrl-C reaches the child directly from the terminal; the launcher waits for the child's exit instead.
    process.on("SIGINT", () => {});
    const code = await launch(cliChild(join(root, "dist", "cli.js"), args));
    if (code !== 0 && facts.tty && insideUiSession(process.env)) await waitForEnter(code);
    process.exitCode = code;
  }
}
