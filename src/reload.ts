import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The exit code with which the terminal UI asks the `npm start` launcher to start it again on the current build. */
export const RELOAD_EXIT_CODE = 75;
/** Set in the child's environment by the launcher, so the terminal UI knows a reload exit will be restarted. */
export const LAUNCHER_ENV = "INDRA_LAUNCHER";

/**
 * The Indra checkout a module runs from. Node resolves the `dist` symlink, so a built module's own path is
 * `builds/<build>/x.js` after a self-update, `dist/x.js` after a local `npm run build`, or `src/x.ts` in tests.
 */
export function appRootOf(moduleUrl: string): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  return basename(dirname(dir)) === "builds" ? resolve(dir, "..", "..") : resolve(dir, "..");
}

/** A Codex output schema in the checkout's `schemas/` directory, found from the app root so it works from `builds/<build>/`. */
export function schemaPathOf(moduleUrl: string, name: string): string {
  return resolve(appRootOf(moduleUrl), "schemas", name);
}

/** True when this module is the process's entry point, also when it was started through the `dist` symlink. */
export function isEntry(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}
