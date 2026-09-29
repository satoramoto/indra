import { execFile } from "node:child_process";
import { childEnv } from "./op-env.js";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readBuildStamp, readStampIn, type BuildStamp } from "./build-stamp.js";
import { buildsInUse, confirmApplicationReady } from "./running-build.js";

export { IN_USE, processStart, recordRunningBuild, type RunningBuildReceipt } from "./running-build.js";

/**
 * How one check of the Indra checkout ended. "built" means a new build is in `dist/`; "blocked" means Indra
 * left the checkout alone and `message` says why; "failed" means the pull landed but the build did not, so the
 * running build stays; "paused" means auto-update is paused, so Indra only looked at origin/main and `message`
 * says what is waiting.
 */
export type UpdateOutcome = "up-to-date" | "built" | "blocked" | "failed" | "paused";
export interface UpdateResult { outcome: UpdateOutcome; message: string; at: string; /** `npm ci` failed: node_modules may be broken, so nothing is restarted until an install succeeds. */ installFailed?: boolean }

/** The owner's auto-update setting, kept in `<runtimeDir>/self-update.json` so it survives reloads and restarts. */
export interface UpdateSettings {
  paused: boolean;
  /** The last rollback: the build it switched `dist` to, that build's SHA and the SHA it rolled back from. */
  rollback?: { build: string; sha: string; fromSha: string };
}

const SETTINGS = "self-update.json";
const UPDATE_STATUS = "self-update-status.json";

/** Runtime-only, deliberately excludes subprocess output and error messages. */
export interface UpdateStatus {
  appDir: string; outcome: UpdateOutcome | "checking"; at: string; installFailed?: boolean;
}

export async function readUpdateStatus(runtimeDir: string): Promise<UpdateStatus | undefined> {
  try {
    const value = JSON.parse(await readFile(join(runtimeDir, UPDATE_STATUS), "utf8")) as UpdateStatus;
    if (!value || typeof value.appDir !== "string" || !["checking", "up-to-date", "built", "blocked", "failed", "paused"].includes(value.outcome) || !Number.isFinite(Date.parse(value.at)) || (value.installFailed !== undefined && typeof value.installFailed !== "boolean")) throw new Error("Invalid update status.");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function readUpdateSettings(runtimeDir: string, strict = false): Promise<UpdateSettings> {
  try {
    const value = JSON.parse(await readFile(join(runtimeDir, SETTINGS), "utf8")) as Partial<UpdateSettings>;
    const rollback = value.rollback;
    if (strict && (typeof value.paused !== "boolean" || (rollback !== undefined && (!rollback || typeof rollback.build !== "string" || typeof rollback.sha !== "string" || typeof rollback.fromSha !== "string")))) throw new Error("Invalid update settings.");
    return {
      paused: value.paused === true,
      ...(rollback && typeof rollback.build === "string" && typeof rollback.sha === "string" && typeof rollback.fromSha === "string" ? { rollback: { build: rollback.build, sha: rollback.sha, fromSha: rollback.fromSha } } : {}),
    };
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { paused: false };
  }
}

export async function writeUpdateSettings(runtimeDir: string, settings: UpdateSettings): Promise<void> {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const temporary = join(runtimeDir, `.${SETTINGS}-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
  await rename(temporary, join(runtimeDir, SETTINGS));
}

/** The build a rollback would switch `dist` to, with the stamps of the running build and of that one. */
export interface RollbackPlan { build: string; from?: BuildStamp; to?: BuildStamp }

const short = (stamp?: BuildStamp) => stamp?.sha.slice(0, 7) || "unknown build";
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

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
      execFile(command, args, { cwd: this.appDir, encoding: "utf8", env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0" }, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout.trim()); return; }
        const lines = `${stderr}\n${stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
        reject(new Error(`${command} ${args[0]} failed: ${lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? error.message}`));
      });
    });
  }

  private git(...args: string[]): Promise<string> { return this.exec("git", args); }

  async check(): Promise<UpdateResult> {
    // Called by the initialized application, including when auto-update is paused.
    confirmApplicationReady(this.runtimeDir);
    await this.saveStatus({ outcome: "checking", at: new Date().toISOString() });
    const result = await this.checkCheckout();
    await this.saveStatus(result);
    return result;
  }

  private async saveStatus(result: Pick<UpdateResult, "at" | "installFailed"> & { outcome: UpdateStatus["outcome"] }): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const temporary = join(this.runtimeDir, `.${UPDATE_STATUS}-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify({ appDir: await realpath(this.appDir), outcome: result.outcome, at: result.at, ...(result.installFailed ? { installFailed: true } : {}) } satisfies UpdateStatus), { mode: 0o600 });
    await rename(temporary, join(this.runtimeDir, UPDATE_STATUS));
  }

  private async checkCheckout(): Promise<UpdateResult> {
    const at = new Date().toISOString();
    const result = (outcome: UpdateOutcome, message: string): UpdateResult => ({ outcome, message, at });
    if (await this.paused()) return this.pausedCheck(at);
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
      // Paused while this build ran: keep the running build; the unused one is pruned later.
      if (await this.paused()) return result("paused", `paused before switching to ${head.slice(0, 7)}; still running the current build`);
      await switchDist(this.appDir, name, { runtimeDir: this.runtimeDir });
      this.failed = undefined;
      return result("built", `built ${head.slice(0, 7)}`);
    } catch (error) { return result("blocked", `update check failed: ${reason(error)}`); }
  }

  /** While paused, a check only fetches and says how many commits wait on origin/main; it never pulls, builds or switches. */
  private async pausedCheck(at: string): Promise<UpdateResult> {
    const done = (message: string): UpdateResult => ({ outcome: "paused", message, at });
    try {
      await this.git("fetch", "--quiet", "origin", "main");
      const behind = Number(await this.git("rev-list", "--count", "HEAD..origin/main"));
      return done(behind ? `${behind} new commit${behind === 1 ? "" : "s"} waiting on origin/main` : "no new commits on origin/main");
    } catch (error) { return done(`could not check origin/main: ${reason(error)}`); }
  }

  async paused(): Promise<boolean> { return (await readUpdateSettings(this.runtimeDir)).paused; }

  async setPaused(paused: boolean): Promise<void> {
    await writeUpdateSettings(this.runtimeDir, { ...await readUpdateSettings(this.runtimeDir), paused });
  }

  /** The previous build `dist` pointed to, if it is still a complete build; undefined when there is none. */
  async rollbackPlan(): Promise<RollbackPlan | undefined> {
    const build = await linkedBuild(this.appDir, PREVIOUS);
    if (!build || build === await linkedBuild(this.appDir, "dist")) return undefined;
    const dir = join(this.appDir, BUILDS, build);
    try { await access(join(dir, "cli.js")); } catch { return undefined; }
    return { build, from: await readBuildStamp(this.appDir), to: await readStampIn(dir) };
  }

  /**
   * Switches `dist` back to the previous build with `switchDist` and pauses auto-update first, so the commit rolled
   * back from is not rebuilt at once. Does nothing when there is no previous build.
   */
  async rollback(): Promise<{ rolledBack: boolean; message: string }> {
    const plan = await this.rollbackPlan();
    if (!plan) return { rolledBack: false, message: "No previous build to roll back to; nothing changed." };
    await writeUpdateSettings(this.runtimeDir, { paused: true, rollback: { build: plan.build, sha: plan.to?.sha ?? "", fromSha: plan.from?.sha ?? "" } });
    await switchDist(this.appDir, plan.build, { runtimeDir: this.runtimeDir });
    return { rolledBack: true, message: `Rolled back to ${short(plan.to)} from ${short(plan.from)}; updates paused (U resumes).` };
  }

  /** The SHAs of the last rollback while `dist` still points to the build it switched to; undefined otherwise. */
  async rolledBack(): Promise<{ sha: string; fromSha: string } | undefined> {
    const { rollback } = await readUpdateSettings(this.runtimeDir);
    return rollback && rollback.build === await linkedBuild(this.appDir, "dist") ? { sha: rollback.sha, fromSha: rollback.fromSha } : undefined;
  }
}

/** The symlink next to `dist` that names the build `dist` pointed to before the last switch: the rollback target. */
export const PREVIOUS = "dist-previous";

/** The `builds/` entry a symlink in the checkout points to; undefined when it is missing or not a symlink. */
async function linkedBuild(appDir: string, link: string): Promise<string | undefined> {
  return readlink(join(appDir, link)).then((target) => basename(target), () => undefined);
}

/** Points the symlink `link` in the checkout at `builds/<build>` in one rename. */
async function linkBuild(appDir: string, link: string, build: string): Promise<void> {
  const temporary = join(appDir, `.dist-${randomUUID()}`);
  await symlink(join(BUILDS, build), temporary);
  await rename(temporary, join(appDir, link));
}

/** Self-update builds live in `builds/<sha>-<time>/`; `dist` is a symlink to the live one. */
export const BUILDS = "builds";

/** Builds younger than this are never pruned, so a process that just resolved one can still load from it. */
export const PRUNE_GRACE_MS = 10 * 60_000;

/** `<state-checkout>.runtime` for the default state checkout of the Indra checkout at `appDir`. */
export function defaultRuntimeDir(appDir: string, stateEnv = process.env.INDRA_STATE_REPO): string {
  return `${resolve(stateEnv || resolve(appDir, "..", "indra-state"))}.runtime`;
}

export interface PruneOptions { runtimeDir?: string; graceMs?: number; now?: number }

/**
 * Removes builds that are not `keep`, not the live build or the rollback target (`dist` and `dist-previous`), not
 * recorded as in use by a live process, and older than the grace period.
 */
export async function pruneBuilds(appDir: string, keep: string[], options: PruneOptions = {}): Promise<void> {
  const builds = join(appDir, BUILDS);
  const used = await buildsInUse(options.runtimeDir ?? defaultRuntimeDir(appDir));
  const cutoff = (options.now ?? Date.now()) - (options.graceMs ?? PRUNE_GRACE_MS);
  const linked = await Promise.all(["dist", PREVIOUS].map((link) => linkedBuild(appDir, link)));
  const kept = [...keep, ...linked.filter((build): build is string => !!build)];
  for (const entry of await readdir(builds)) {
    if (kept.includes(entry)) continue;
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
 * the old build or the new one, never a missing `dist/cli.js`. Keeps the previous build for rollback (named by the
 * `dist-previous` symlink) and removes older ones that no live process runs from (see `pruneBuilds`). A real `dist/`
 * directory from a local `npm run build` is first moved into `builds/`.
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
  await linkBuild(appDir, "dist", name);
  if (previous && previous !== name) await linkBuild(appDir, PREVIOUS, previous);
  await pruneBuilds(appDir, previous ? [name, previous] : [name], options);
}
