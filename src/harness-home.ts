/**
 * Indra-owned, per-seat harness homes under `<state-checkout>.runtime/harness/<seat-id>/<engine>/`.
 * A seat's engine runs on its built-in defaults plus the project's own AGENTS.md: none of the owner's personal
 * instructions, skills, MCP servers, hooks, plugins, agent definitions or profiles. The home holds only what the
 * engine needs to authenticate, and the sessions the engine writes there.
 */
import { chmod, lstat, mkdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SeatEngine } from "./seat-runtime.js";

const SEAT_ID = /^[a-z][a-z0-9-]+$/;

/** The per-seat harness directory, `<runtimeDir>/harness/<seat-id>`; engines each get a subdirectory. */
export function seatHarnessDir(runtimeDir: string, seatId: string): string {
  if (!SEAT_ID.test(seatId)) throw new Error("Invalid seat ID for a harness home.");
  return join(runtimeDir, "harness", seatId);
}

/** The engine's home inside a seat's harness directory. */
export function engineHome(seatHarness: string, engine: SeatEngine): string { return join(seatHarness, engine); }

/** The owner's Codex login: `$CODEX_HOME/auth.json`, or `~/.codex/auth.json`. Referenced by a link, never copied. */
export function ownerCodexAuth(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

/** The owner's seat allocation: the model and reasoning effort every Codex seat runs with, so sprints stay comparable. */
export const CODEX_MODEL = "gpt-6-astra";
export const CODEX_REASONING_EFFORT = "max";

/** The whole harness `config.toml`: model and reasoning effort only. No instructions, MCP servers, hooks, skills, plugins or profiles. */
export const CODEX_CONFIG = `model = "${CODEX_MODEL}"\nmodel_reasoning_effort = "${CODEX_REASONING_EFFORT}"\n`;

/**
 * Creates the Codex home idempotently: 0700 directories, a minimal `config.toml` (rewritten every time, so a home
 * from an earlier run gets the current content and nothing accumulates in it), and `auth.json` as a symlink to the owner's login, so token refreshes write through to it.
 * Anything else already at `auth.json` is replaced by the link.
 */
export async function ensureCodexHome(home: string, auth = ownerCodexAuth()): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const dir of [join(home, "..", ".."), join(home, ".."), home]) await chmod(dir, 0o700);
  await writeFile(join(home, "config.toml"), CODEX_CONFIG, { mode: 0o600 });
  const link = join(home, "auth.json");
  let current: string | undefined;
  try { current = (await lstat(link)).isSymbolicLink() ? await readlink(link) : ""; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (current !== auth) {
    if (current !== undefined) await unlink(link);
    try { await symlink(auth, link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readlink(link).catch(() => "") !== auth) throw error; }
  }
  return home;
}
