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

if (isEntry(import.meta.url)) {
  // Ctrl-C reaches the child directly from the terminal; the launcher waits for the child's exit instead.
  process.on("SIGINT", () => {});
  process.exitCode = await launch(cliChild(join(appRootOf(import.meta.url), "dist", "cli.js"), process.argv.slice(2)));
}
