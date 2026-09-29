/**
 * Indra-owned, per-seat harness homes under `<state-checkout>.runtime/harness/<seat-id>/<engine>/`.
 * A seat's engine runs on its built-in defaults plus the project's own AGENTS.md: none of the owner's personal
 * instructions, skills, MCP servers, hooks, plugins, agent definitions or profiles. The home holds only what the
 * engine needs to authenticate, and the sessions the engine writes there.
 */
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
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

/** The owner's seat allocation per role: planning carries the heavy reasoning, implementation runs cheap. */
export const TEAM_LEAD_CODEX_MODEL = "gpt-6-astra";
export const TEAM_LEAD_CODEX_REASONING_EFFORT = "max";
export const PRODUCT_CODEX_MODEL = "gpt-6-astra";
export const PRODUCT_CODEX_REASONING_EFFORT = "medium";
export const DEVELOPER_CODEX_MODEL = "gpt-6-sol";
export const DEVELOPER_CODEX_REASONING_EFFORT = "medium";

/** A whole harness `config.toml`: model and reasoning effort only. No instructions, MCP servers, hooks, skills, plugins or profiles. */
const codexConfig = (model: string, effort: string) => `model = "${model}"\nmodel_reasoning_effort = "${effort}"\n`;
export const TEAM_LEAD_CODEX_CONFIG = codexConfig(TEAM_LEAD_CODEX_MODEL, TEAM_LEAD_CODEX_REASONING_EFFORT);
export const PRODUCT_CODEX_CONFIG = codexConfig(PRODUCT_CODEX_MODEL, PRODUCT_CODEX_REASONING_EFFORT);
export const DEVELOPER_CODEX_CONFIG = codexConfig(DEVELOPER_CODEX_MODEL, DEVELOPER_CODEX_REASONING_EFFORT);

/** The harness `config.toml` for a seat's roles as recorded in state; an unknown or missing role gets the Developer settings. */
export function codexConfigForRoles(roles: readonly string[] | undefined): string {
  if (roles?.includes("Team Lead")) return TEAM_LEAD_CODEX_CONFIG;
  if (roles?.includes("Product")) return PRODUCT_CODEX_CONFIG;
  return DEVELOPER_CODEX_CONFIG;
}

/** Writes `content` to `path` through a temp file and a rename, so no reader sees a partial file; skipped when already identical. */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  if (await readFile(path, "utf8").catch(() => undefined) === content) return;
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try { await writeFile(temp, content, { mode }); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

const nonEmpty = (value: unknown) => typeof value === "string" && value.length > 0;

/**
 * Reads a Codex `auth.json` (0.156.1 `AuthDotJson`) and returns only whether it holds a usable login (a `tokens`
 * object with a refresh token, or an API key) and its `last_refresh` time. Contents never leave this function.
 */
async function loginInfo(path: string): Promise<{ usable: boolean; refreshedAt: number | undefined }> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { return { usable: false, refreshedAt: undefined }; }
  if (!parsed || typeof parsed !== "object") return { usable: false, refreshedAt: undefined };
  const login = parsed as { tokens?: { refresh_token?: unknown } | null; OPENAI_API_KEY?: unknown; last_refresh?: unknown };
  const usable = (!!login.tokens && typeof login.tokens === "object" && nonEmpty(login.tokens.refresh_token)) || nonEmpty(login.OPENAI_API_KEY);
  const time = typeof login.last_refresh === "string" ? Date.parse(login.last_refresh) : NaN;
  return { usable, refreshedAt: Number.isNaN(time) ? undefined : time };
}

/**
 * Codex 0.156 writes `auth.json` in place (open with truncate), which follows our symlink, so a refresh reaches the
 * owner's login. Defensively, if a regular file ever appears at the seat's `auth.json` (a logout and login, or a future
 * temp-and-rename writer), it may hold a newer, rotated token: when it is a usable login strictly newer by `last_refresh`,
 * it atomically replaces the owner's `auth.json` by rename; an invalid, empty or not-newer one is discarded. The caller then restores the symlink. Never logs contents.
 */
export async function promoteSeatAuth(home: string, auth = ownerCodexAuth()): Promise<"promoted" | "discarded" | "none"> {
  const seat = join(home, "auth.json");
  const info = await lstat(seat).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info?.isFile()) return "none";
  // Promote only a usable login strictly newer by `last_refresh`. Discard only a file proven invalid or not newer;
  // if promotion itself fails, the file stays for the next call to retry.
  const seatLogin = await loginInfo(seat);
  const ownerAt = (await loginInfo(auth)).refreshedAt ?? -Infinity;
  if (!seatLogin.usable || seatLogin.refreshedAt === undefined || seatLogin.refreshedAt <= ownerAt) { await unlink(seat); return "discarded"; }
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
export async function ensureCodexHome(home: string, config: string, auth = ownerCodexAuth()): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const dir of [join(home, "..", ".."), join(home, ".."), home]) await chmod(dir, 0o700);
  await writeFileAtomic(join(home, "config.toml"), config);
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
