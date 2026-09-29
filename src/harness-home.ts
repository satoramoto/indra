/**
 * Indra-owned, per-seat harness homes under `<state-checkout>.runtime/harness/<seat-id>/<engine>/`.
 * A seat's engine runs on its built-in defaults plus the project's own AGENTS.md: none of the owner's personal
 * instructions, skills, MCP servers, hooks, plugins, agent definitions or profiles. The home holds only what the
 * engine needs to authenticate, and the sessions the engine writes there.
 */
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Writes `content` to `path` through a temp file and a rename, so no reader sees a partial file; skipped when already identical. */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  if (await readFile(path, "utf8").catch(() => undefined) === content) return;
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try { await writeFile(temp, content, { mode }); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

/** When a login was last refreshed: the later of its `last_refresh` field and the file's mtime. Contents never leave this function. */
async function refreshedAt(path: string): Promise<number> {
  const mtime = (await stat(path)).mtimeMs;
  try {
    const parsed = Date.parse(String((JSON.parse(await readFile(path, "utf8")) as { last_refresh?: unknown }).last_refresh));
    return Number.isNaN(parsed) ? mtime : Math.max(parsed, mtime);
  } catch { return mtime; }
}

/**
 * Codex 0.156 writes `auth.json` in place (open with truncate), which follows our symlink, so a refresh reaches the
 * owner's login. Defensively, if a regular file ever appears at the seat's `auth.json` (a logout and login, or a future
 * temp-and-rename writer), it may hold a newer, rotated token: when it is newer than the owner's, it atomically replaces
 * the owner's `auth.json` by rename; an older one is discarded. The caller then restores the symlink. Never logs contents.
 */
export async function promoteSeatAuth(home: string, auth = ownerCodexAuth()): Promise<"promoted" | "discarded" | "none"> {
  const seat = join(home, "auth.json");
  const info = await lstat(seat).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info?.isFile()) return "none";
  const ownerAt = await refreshedAt(auth).catch(() => -Infinity);
  if (await refreshedAt(seat) <= ownerAt) { await unlink(seat); return "discarded"; }
  await mkdir(dirname(auth), { recursive: true, mode: 0o700 });
  await chmod(seat, 0o600);
  try { await rename(seat, auth); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const temp = `${auth}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try { await copyFile(seat, temp); await chmod(temp, 0o600); await rename(temp, auth); }
    catch (inner) { await unlink(temp).catch(() => undefined); throw inner; }
    await unlink(seat);
  }
  return "promoted";
}

/**
 * Creates the Codex home idempotently: 0700 directories, a minimal `config.toml` (written atomically and only when it
 * differs, so concurrent runs never read a partial file), and `auth.json` as a symlink to the owner's login, so token
 * refreshes write through to it. A regular file at `auth.json` is first promoted (see promoteSeatAuth); anything else
 * there is replaced by the link. Codex runs call it before and after each run.
 */
export async function ensureCodexHome(home: string, auth = ownerCodexAuth()): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const dir of [join(home, "..", ".."), join(home, ".."), home]) await chmod(dir, 0o700);
  await writeFileAtomic(join(home, "config.toml"), CODEX_CONFIG);
  await promoteSeatAuth(home, auth);
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
