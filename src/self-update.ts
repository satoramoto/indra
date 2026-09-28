import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, lstat, readdir, readFile, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readBuildStamp } from "./build-stamp.js";

/**
 * How one check of the Indra checkout ended. "built" means a new build is in `dist/`; "blocked" means Indra
 * left the checkout alone and `message` says why; "failed" means the pull landed but the build did not, so the
 * running build stays.
 */
export type UpdateOutcome = "up-to-date" | "built" | "blocked" | "failed";
export interface UpdateResult { outcome: UpdateOutcome; message: string; at: string; /** `npm ci` failed: node_modules may be broken, so nothing is restarted until an install succeeds. */ installFailed?: boolean }

/**
 * Keeps the Indra checkout that runs the terminal UI on origin/main. Only fast-forwards a clean `main`, installs
 * dependencies only when package-lock.json changed since the running build, then builds. It never resets, stashes
 * or discards anything.
 */
export class SelfUpdater {
  /** The HEAD whose build failed; not retried until HEAD moves. */
  private failed?: { sha: string; message: string };

  constructor(readonly appDir: string, private readonly npm = "npm", private readonly timeoutMs = 15 * 60_000, private readonly runtimeDir = defaultRuntimeDir(appDir)) {}

  private exec(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { cwd: this.appDir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout.trim()); return; }
        const lines = `${stderr}\n${stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
        reject(new Error(`${command} ${args[0]} failed: ${lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? error.message}`));
      });
    });
  }

  private git(...args: string[]): Promise<string> { return this.exec("git", args); }

  async check(): Promise<UpdateResult> {
    const at = new Date().toISOString();
    const result = (outcome: UpdateOutcome, message: string): UpdateResult => ({ outcome, message, at });
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
    try {
      const branch = await this.git("rev-parse", "--abbrev-ref", "HEAD");
      if (branch !== "main") return result("blocked", `the Indra checkout is on ${branch}, not main`);
      if (await this.git("--no-optional-locks", "status", "--porcelain", "--untracked-files=no")) return result("blocked", "the Indra checkout has uncommitted changes");
      try { await this.git("fetch", "--quiet", "origin", "main"); }
      catch (error) { return result("blocked", `could not fetch origin/main: ${reason(error)}`); }
      const [ahead, behind] = (await this.git("rev-list", "--left-right", "--count", "HEAD...origin/main")).split(/\s+/).map(Number);
      if (ahead > 0 && behind > 0) return result("blocked", "main has diverged from origin/main");
      if (behind > 0) {
        try { await this.git("pull", "--ff-only", "--quiet", "origin", "main"); }
        catch (error) { return result("blocked", `could not fast-forward main: ${reason(error)}`); }
      }
      const head = await this.git("rev-parse", "HEAD");
      const built = await readBuildStamp(this.appDir);
      if (built?.sha === head) return result("up-to-date", `up to date at ${head.slice(0, 7)}`);
      if (this.failed?.sha === head) return result("failed", this.failed.message);
      const lockChanged = !built?.sha || await this.git("diff", "--name-only", built.sha, head, "--", "package-lock.json").then((names) => names !== "", () => true);
      if (lockChanged) {
        // Not remembered as failed: the install is tried again on the next check.
        try { await this.exec(this.npm, ["ci"]); }
        catch (error) { return { ...result("blocked", `dependency install failed: ${reason(error)}`), installFailed: true }; }
      }
      const name = `${head.slice(0, 12)}-${Date.now()}`;
      const out = join(this.appDir, BUILDS, name);
      try {
        await this.exec(this.npm, ["run", "build", "--", "--outDir", out, "--emptyOutDir"]);
        await access(join(out, "cli.js"));
        await access(join(out, "build-stamp.json"));
      } catch (error) {
        await rm(out, { recursive: true, force: true }).catch(() => undefined);
        this.failed = { sha: head, message: `build of ${head.slice(0, 7)} failed; still running the previous build: ${reason(error)}` };
        return result("failed", this.failed.message);
      }
      await switchDist(this.appDir, name, { runtimeDir: this.runtimeDir });
      this.failed = undefined;
      return result("built", `built ${head.slice(0, 7)}`);
    } catch (error) { return result("blocked", `update check failed: ${reason(error)}`); }
  }
}

/** Self-update builds live in `builds/<sha>-<time>/`; `dist` is a symlink to the live one. */
export const BUILDS = "builds";

/** Builds younger than this are never pruned, so a process that just resolved one can still load from it. */
export const PRUNE_GRACE_MS = 10 * 60_000;

/** `<state-checkout>.runtime` for the default state checkout of the Indra checkout at `appDir`. */
export function defaultRuntimeDir(appDir: string, stateEnv = process.env.INDRA_STATE_REPO): string {
  return `${resolve(stateEnv || resolve(appDir, "..", "indra-state"))}.runtime`;
}

const IN_USE = "builds-in-use";

/**
 * Records in `<runtimeDir>/builds-in-use/<pid>.json` the real build directory this process runs from, so pruning
 * keeps it while the process lives. The record is removed on a clean exit; one left by a dead pid is ignored.
 */
export function recordRunningBuild(runtimeDir: string, moduleUrl: string): void {
  try {
    const build = realpathSync(new URL(".", moduleUrl));
    const file = join(runtimeDir, IN_USE, `${process.pid}.json`);
    mkdirSync(join(runtimeDir, IN_USE), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ pid: process.pid, build }), { mode: 0o600 });
    process.once("exit", () => { try { rmSync(file, { force: true }); } catch { /* best effort */ } });
  } catch { /* best effort: pruning still keeps current, previous and recent builds */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function buildsInUse(runtimeDir: string): Promise<Set<string>> {
  const used = new Set<string>();
  for (const entry of await readdir(join(runtimeDir, IN_USE)).catch(() => [] as string[])) {
    try {
      const record = JSON.parse(await readFile(join(runtimeDir, IN_USE, entry), "utf8")) as { pid: number; build: string };
      if (Number.isInteger(record.pid) && alive(record.pid)) used.add(await realpath(record.build).catch(() => record.build));
    } catch { /* unreadable record */ }
  }
  return used;
}

export interface PruneOptions { runtimeDir?: string; graceMs?: number; now?: number }

/**
 * Removes builds that are not `keep`, not recorded as in use by a live process, and older than the grace period.
 */
export async function pruneBuilds(appDir: string, keep: string[], options: PruneOptions = {}): Promise<void> {
  const builds = join(appDir, BUILDS);
  const used = await buildsInUse(options.runtimeDir ?? defaultRuntimeDir(appDir));
  const cutoff = (options.now ?? Date.now()) - (options.graceMs ?? PRUNE_GRACE_MS);
  for (const entry of await readdir(builds)) {
    if (keep.includes(entry)) continue;
    const dir = join(builds, entry);
    const real = await realpath(dir).catch(() => dir);
    if (used.has(real)) continue;
    const info = await stat(dir).catch(() => undefined);
    if (!info || info.mtimeMs > cutoff) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Makes `builds/<name>` the live build in one step: a new symlink is renamed over `dist`, so a reader sees either
 * the old build or the new one, never a missing `dist/cli.js`. Keeps the previous build for rollback and removes
 * older ones that no live process runs from (see `pruneBuilds`). A real `dist/` directory from a local `npm run build` is first moved into `builds/`.
 */
export async function switchDist(appDir: string, name: string, options: PruneOptions = {}): Promise<void> {
  const dist = join(appDir, "dist");
  const builds = join(appDir, BUILDS);
  let previous: string | undefined;
  const current = await lstat(dist).catch(() => undefined);
  if (current?.isSymbolicLink()) previous = basename(await readlink(dist));
  else if (current) {
    // Only on the first self-update after a local build; spawns are held while an update runs.
    previous = `local-${Date.now()}`;
    await rename(dist, join(builds, previous));
  }
  const temporary = join(appDir, `.dist-${randomUUID()}`);
  await symlink(join(BUILDS, name), temporary);
  await rename(temporary, dist);
  await pruneBuilds(appDir, previous ? [name, previous] : [name], options);
}
