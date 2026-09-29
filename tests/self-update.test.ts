import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readBuildStamp } from "../src/build-stamp.js";
import { recordRunningBuild as recordLoadedBuild } from "../src/running-build.js";
import { IN_USE, processStart, pruneBuilds, readUpdateStatus, recordRunningBuild, SelfUpdater, switchDist } from "../src/self-update.js";
import { git } from "./state-checkout.js";

const head = (dir: string, ref = "HEAD") => git(dir, "rev-parse", ref).trim();

/**
 * An Indra checkout (`app`) cloned from a bare remote, a second clone (`upstream`) standing in for PRs merged on
 * GitHub, and a fake npm that logs its arguments and, for `run build`, writes a build stamp unless `fail-build` exists.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "indra-update-"));
  const remote = join(root, "remote.git");
  const upstream = join(root, "upstream");
  const app = join(root, "app");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", upstream]);
  await writeFile(join(upstream, ".gitignore"), "dist/\n");
  await writeFile(join(upstream, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
  await writeFile(join(upstream, "code.ts"), "export const version = 1;\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "--quiet", "-m", "Initial");
  git(upstream, "remote", "add", "origin", remote);
  git(upstream, "push", "--quiet", "-u", "origin", "main");
  execFileSync("git", ["clone", "--quiet", remote, app]);
  const log = join(root, "npm.log");
  const npm = join(root, "npm");
  // Like Vite and npm, it empties its output directory first and writes it file by file.
  await writeFile(npm, `#!/bin/sh
echo "$1\${2:+ $2}" >> '${log}'
if [ "$1" = "ci" ]; then
  rm -rf node_modules; mkdir node_modules
  if [ -f fail-ci ]; then echo "npm error code ENOSPC" >&2; exit 1; fi
  echo ok > node_modules/installed
fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  out=dist
  if [ "$4" = "--outDir" ]; then out="$5"; fi
  rm -rf "$out"; mkdir -p "$out"
  echo "// half written" > "$out/cli.js"
  if [ -f fail-build ]; then echo "src/code.ts: error TS1005: ';' expected." >&2; exit 1; fi
  sleep 0.05
  echo "console.log('new build')" > "$out/cli.js"
  sha=$(git rev-parse HEAD)
  printf '{"id":"%s-%s","sha":"%s","builtAt":"now"}' "$sha" "$$" "$sha" > "$out/build-stamp.json"
fi
`, { mode: 0o755 });
  // The running build is of the current HEAD, from a local `npm run build` into a real dist/ directory.
  await mkdir(join(app, "dist"));
  await writeFile(join(app, "dist", "cli.js"), "console.log('running build')\n");
  await writeFile(join(app, "dist", "build-stamp.json"), JSON.stringify({ id: "running", sha: head(app), builtAt: "then" }));
  const npmCalls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  /** Merges a commit on the remote. */
  const merge = async (file: string, content: string) => {
    await writeFile(join(upstream, file), content);
    git(upstream, "commit", "--quiet", "-am", `Change ${file}`);
    git(upstream, "push", "--quiet");
  };
  const runtime = join(root, "state.runtime");
  return { app, remote, runtime, npm, updater: new SelfUpdater(app, npm, undefined, runtime, 0), npmCalls, merge };
}

describe("self-update", () => {
  it("never runs two checks at once: a check requested while one runs gets its result and spawns nothing", async () => {
    const { updater, merge, npmCalls } = await fixture();
    await merge("code.ts", "export const version = 2;\n");
    const [first, second, third] = await Promise.all([updater.check(), updater.check(), updater.check()]);
    expect(first).toMatchObject({ outcome: "built" });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect((await npmCalls()).filter((line) => line === "run build")).toHaveLength(1);
    // Once it ends, the next check runs on its own.
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date" });
  });

  it("captures the loaded application at startup, confirms readiness on a paused check, and never changes that evidence when dist switches", async () => {
    const { app, runtime, updater, merge } = await fixture();
    const args = process.argv;
    try {
      process.argv = [process.execPath, join(app, "dist", "cli.js"), "--state", join(runtime, "..", "state")];
      recordLoadedBuild(runtime, pathToFileURL(join(app, "dist", "cli.js")).href, () => "application birth");
    } finally { process.argv = args; }
    const file = join(runtime, IN_USE, `${process.pid}.json`);
    const receipt = async () => JSON.parse(await readFile(file, "utf8"));
    const original = head(app);
    const started = await receipt();
    expect(started).toMatchObject({ pid: process.pid, build: await realpath(join(app, "dist")), appDir: await realpath(app), role: "application", stamp: { id: "running", sha: original }, processStart: "application birth" });
    expect(started.readyAt).toBeUndefined();
    expect((await lstat(join(runtime, IN_USE))).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    // The recorder and updater share readiness state even though they are imported from different modules.
    await updater.setPaused(true);
    expect(await updater.check()).toMatchObject({ outcome: "paused" });
    const ready = await receipt();
    expect(ready).toEqual({ ...started, readyAt: expect.any(String) });
    expect(Date.parse(ready.readyAt)).toBeGreaterThanOrEqual(Date.parse(ready.startedAt));
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(runtime, IN_USE))).toEqual([`${process.pid}.json`]);
    await updater.setPaused(false);
    await merge("code.ts", "export const version = 2;\n");
    await updater.check();
    expect(await receipt()).toEqual(ready);
    expect((await readBuildStamp(app))?.sha).not.toBe(original);
    expect(await readUpdateStatus(runtime)).toMatchObject({ outcome: "built" });
  });

  it("records the loaded bridge and its host nonce without claiming readiness before a successful poll", async () => {
    const { app, runtime, updater } = await fixture();
    const args = process.argv;
    try {
      process.argv = [process.execPath, join(app, "dist", "cli.js"), "planning", "serve", "--ready-nonce", "11111111-2222-3333-4444-555555555555"];
      recordRunningBuild(runtime, pathToFileURL(join(app, "dist", "cli.js")).href, () => "bridge birth");
    } finally { process.argv = args; }
    await updater.check();
    const receipt = JSON.parse(await readFile(join(runtime, IN_USE, `${process.pid}.json`), "utf8"));
    expect(receipt).toMatchObject({ role: "bridge", readyNonce: "11111111-2222-3333-4444-555555555555", stamp: { sha: head(app) } });
    expect(receipt.readyAt).toBeUndefined();
  });

  it("keeps a pruning-only record when process identity is unavailable", async () => {
    const { app, runtime, updater } = await fixture();
    const args = process.argv;
    try {
      process.argv = [process.execPath, join(app, "dist", "cli.js")];
      recordRunningBuild(runtime, pathToFileURL(join(app, "dist", "cli.js")).href, () => undefined);
    } finally { process.argv = args; }
    await updater.check();
    expect(JSON.parse(await readFile(join(runtime, IN_USE, `${process.pid}.json`), "utf8"))).toEqual({ pid: process.pid, build: await realpath(join(app, "dist")) });
    expect(await processStart(-1)).toBeUndefined();
    await expect(processStart(Number.MAX_SAFE_INTEGER)).resolves.toBeUndefined();
  });

  it("fast-forwards a clean main and builds, without npm ci when package-lock.json is unchanged", async () => {
    const { app, remote, updater, npmCalls, merge } = await fixture();
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date" });
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    expect(head(app)).toBe(head(remote, "main"));
    expect(await npmCalls()).toEqual(["run build"]);
    expect(await readBuildStamp(app)).toMatchObject({ sha: head(app) });
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date" });
    expect(await npmCalls()).toEqual(["run build"]);
  });

  it("runs npm ci before the build when package-lock.json changed", async () => {
    const { updater, npmCalls, merge } = await fixture();
    await merge("package-lock.json", "{\"lockfileVersion\": 3, \"packages\": {}}\n");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    expect(await npmCalls()).toEqual(["ci", "run build"]);
  });

  it("builds local HEAD of a dirty checkout without the uncommitted edit, and skips the fetch", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    const before = head(app);
    await writeFile(join(app, "code.ts"), "export const version = 99;\n");
    await writeFile(join(app, "fail-build"), "");
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date", branch: "main", sha: before });
    await writeFile(join(app, "local.txt"), "committed\n");
    git(app, "add", "local.txt");
    git(app, "commit", "--quiet", "-m", "Local work");
    expect(await updater.check()).toMatchObject({ outcome: "built", branch: "main", sha: head(app) });
    expect(git(app, "rev-parse", "HEAD~1").trim()).toBe(before);
    expect(await readFile(join(app, "code.ts"), "utf8")).toBe("export const version = 99;\n");
    expect(await readBuildStamp(app)).toMatchObject({ sha: head(app) });
    expect(await npmCalls()).toEqual(["run build"]);
  });

  it("builds each local commit once", async () => {
    const { app, updater, npmCalls } = await fixture();
    await writeFile(join(app, "code.ts"), "export const version = 5;\n");
    git(app, "commit", "--quiet", "-am", "Local change");
    expect(await updater.check()).toMatchObject({ outcome: "built", sha: head(app) });
    expect(await readBuildStamp(app)).toMatchObject({ sha: head(app) });
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date" });
    expect(await npmCalls()).toEqual(["run build"]);
  });

  it("runs npm ci in the checkout when a local commit changes package-lock.json", async () => {
    const { app, updater, npmCalls } = await fixture();
    await writeFile(join(app, "package-lock.json"), "{\"lockfileVersion\": 3, \"packages\": {}}\n");
    git(app, "commit", "--quiet", "-am", "Lock change");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    expect(await npmCalls()).toEqual(["ci", "run build"]);
    expect(await readFile(join(app, "node_modules", "installed"), "utf8")).toBe("ok\n");
  });

  it("does not build a local commit while paused", async () => {
    const { app, updater, npmCalls } = await fixture();
    await updater.setPaused(true);
    await writeFile(join(app, "code.ts"), "export const version = 5;\n");
    git(app, "commit", "--quiet", "-am", "Local change");
    expect(await updater.check()).toMatchObject({ outcome: "paused" });
    expect(await npmCalls()).toEqual([]);
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
  });

  it("fetches only when the fetch interval is due", async () => {
    const { app, runtime, npm, merge } = await fixture();
    const updater = new SelfUpdater(app, npm, undefined, runtime, 60_000);
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date" });
    const before = head(app);
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "up-to-date" });
    expect(head(app)).toBe(before);
  });

  it("follows origin/main on main", async () => {
    const { app, updater, merge } = await fixture();
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "built", following: "origin/main" });
    expect(await readFile(join(app, "code.ts"), "utf8")).toBe("export const version = 2;\n");
  });

  it("follows another branch's upstream and ignores origin/main", async () => {
    const { app, remote, updater, merge } = await fixture();
    const other = join(app, "..", "other");
    execFileSync("git", ["clone", "--quiet", remote, other]);
    git(other, "checkout", "--quiet", "-b", "hotfix");
    git(other, "push", "--quiet", "-u", "origin", "hotfix");
    git(app, "fetch", "--quiet", "origin");
    git(app, "checkout", "--quiet", "--track", "origin/hotfix");
    await merge("code.ts", "export const version = 2;\n");
    await writeFile(join(other, "code.ts"), "export const version = 3;\n");
    git(other, "commit", "--quiet", "-am", "Hotfix");
    git(other, "push", "--quiet");
    expect(await updater.check()).toMatchObject({ outcome: "built", following: "origin/hotfix" });
    expect(head(app)).toBe(head(other));
    expect(await readFile(join(app, "code.ts"), "utf8")).toBe("export const version = 3;\n");
  });

  it("leaves a branch with no upstream alone", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    git(app, "checkout", "--quiet", "-b", "feature");
    const before = head(app);
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "blocked", message: "not following a branch: feature has no upstream on origin" });
    expect(head(app)).toBe(before);
    expect(await npmCalls()).toEqual([]);
  });

  it("leaves a detached HEAD alone", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    git(app, "checkout", "--quiet", "--detach");
    const before = head(app);
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "blocked", message: "not following a branch: the Indra checkout has a detached HEAD" });
    expect(head(app)).toBe(before);
    expect(await npmCalls()).toEqual([]);
  });

  it("leaves a main that has diverged from origin/main alone, keeping the local commit", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    await writeFile(join(app, "local.txt"), "mine\n");
    git(app, "add", "local.txt");
    git(app, "commit", "--quiet", "-m", "Local work");
    const local = head(app);
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "blocked", message: "main has diverged from origin/main" });
    expect(head(app)).toBe(local);
    expect(await npmCalls()).toEqual([]);
  });

  it("keeps the old build when the new one fails, shows the error, and does not rebuild the same commit", async () => {
    const { app, runtime, updater, npmCalls, merge } = await fixture();
    await writeFile(join(app, "fail-build"), "");
    git(app, "add", "fail-build");
    git(app, "commit", "--quiet", "-m", "Break the build");
    const failed = await updater.check();
    expect(failed.outcome).toBe("failed");
    expect(failed.message).toContain("still running the previous build");
    expect(failed.message).toContain("error TS1005");
    expect(await readUpdateStatus(runtime)).toMatchObject({ outcome: "failed" });
    expect(await readUpdateStatus(runtime)).not.toHaveProperty("message");
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
    expect(execFileSync(process.execPath, [join(app, "dist", "cli.js")], { encoding: "utf8" })).toBe("running build\n");
    expect(await updater.check()).toMatchObject({ outcome: "failed" });
    expect(await npmCalls()).toEqual(["run build"]);
  });

  it("switches dist to the new build atomically, and keeps builds inside the grace period while a reader runs", async () => {
    const { app, updater, merge } = await fixture();
    // The first update moves the local real dist/ aside (spawns are held meanwhile); from then on dist is a symlink.
    await merge("code.ts", "export const version = 1.5;\n");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    // Resolve the current dist link, then read that immutable build. Count every lookup/read failure.
    const stop = join(app, "..", "stop");
    const reader = spawn(process.execPath, ["-e", `
const { readFileSync, readlinkSync, existsSync } = require("node:fs");
const { join } = require("node:path");
let reads = 0, misses = 0;
const errors = [];
while (!existsSync(${JSON.stringify(stop)})) {
  reads++;
  try { if (!/build/.test(readFileSync(join(${JSON.stringify(app)}, readlinkSync(${JSON.stringify(join(app, "dist"))}), "cli.js"), "utf8"))) { misses++; if (errors.length < 5) errors.push("incomplete build"); } } catch (error) { misses++; if (errors.length < 5) errors.push(error.code + ":" + error.syscall); }
}
console.log(JSON.stringify({ reads, misses, errors }));
`], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    reader.stdout.on("data", (chunk) => { output += chunk; });
    const exited = new Promise((done) => reader.on("exit", done));
    for (const version of [2, 3, 4]) {
      await merge("code.ts", `export const version = ${version};\n`);
      expect(await updater.check()).toMatchObject({ outcome: "built" });
    }
    await writeFile(stop, "");
    await exited;
    const { reads, misses, errors } = JSON.parse(output) as { reads: number; misses: number; errors: string[] };
    expect(reads).toBeGreaterThan(100);
    expect(misses, JSON.stringify(errors)).toBe(0);
    expect((await lstat(join(app, "dist"))).isSymbolicLink()).toBe(true);
    expect(await readBuildStamp(app)).toMatchObject({ sha: head(app) });
    // Every build is inside the grace period, so none was pruned while the reader ran.
    expect(await readdir(join(app, "builds"))).toHaveLength(5);
    expect(await readdir(app)).not.toContain(expect.stringMatching(/^\.dist-/));
  });

  it("prunes only old builds that are not current, previous, or recorded by a live process", async () => {
    const app = await mkdtemp(join(tmpdir(), "indra-prune-"));
    const runtime = join(app, "state.runtime");
    for (const name of ["old", "used", "stale-record", "fresh", "previous", "current"]) await mkdir(join(app, "builds", name), { recursive: true });
    const hour = 60 * 60_000;
    for (const name of ["old", "used", "stale-record", "previous", "current"]) await utimes(join(app, "builds", name), new Date(Date.now() - hour), new Date(Date.now() - hour));
    await mkdir(join(runtime, "builds-in-use"), { recursive: true });
    await writeFile(join(runtime, "builds-in-use", "1.json"), JSON.stringify({ pid: process.pid, build: join(app, "builds", "used") }));
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((done) => dead.on("exit", done));
    await writeFile(join(runtime, "builds-in-use", "2.json"), JSON.stringify({ pid: dead.pid, build: join(app, "builds", "stale-record") }));
    await pruneBuilds(app, ["current", "previous"], { runtimeDir: runtime });
    expect((await readdir(join(app, "builds"))).sort()).toEqual(["current", "fresh", "previous", "used"]);
  });

  it("keeps the pause setting across restarts and neither pulls, builds nor switches while paused", async () => {
    const { app, runtime, npm, updater, npmCalls, merge } = await fixture();
    const before = head(app);
    await updater.setPaused(true);
    // A new updater stands in for Indra after a reload or restart: the setting lives in the runtime directory.
    const restarted = new SelfUpdater(app, npm, undefined, runtime);
    expect(await restarted.paused()).toBe(true);
    await merge("code.ts", "export const version = 2;\n");
    expect(await restarted.check()).toMatchObject({ outcome: "paused", message: "1 new commit waiting on origin/main" });
    expect(await readUpdateStatus(runtime)).toMatchObject({ outcome: "paused" });
    expect(head(app)).toBe(before);
    expect(await npmCalls()).toEqual([]);
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
    await restarted.setPaused(false);
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    expect(await readBuildStamp(app)).toMatchObject({ sha: head(app) });
  });

  it("rolls back to the previous build atomically and pauses, so the next check does not rebuild", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    const good = head(app);
    await merge("code.ts", "export const version = 3;\n");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    const bad = head(app);
    expect(await updater.rolledBack()).toBeUndefined();
    const plan = await updater.rollbackPlan();
    expect(plan).toMatchObject({ from: { sha: bad }, to: { sha: good } });
    expect(await updater.rollback()).toMatchObject({ rolledBack: true, message: `Rolled back to ${good.slice(0, 7)} from ${bad.slice(0, 7)}; updates paused (U resumes).` });
    expect((await lstat(join(app, "dist"))).isSymbolicLink()).toBe(true);
    expect(await readBuildStamp(app)).toMatchObject({ sha: good });
    expect(await updater.paused()).toBe(true);
    expect(await updater.rolledBack()).toEqual({ sha: good, fromSha: bad });
    // The bad commit is not rebuilt while paused.
    expect(await updater.check()).toMatchObject({ outcome: "paused" });
    expect(await readBuildStamp(app)).toMatchObject({ sha: good });
    expect(await npmCalls()).toEqual(["run build", "run build"]);
    // The build rolled back from is now the rollback target, so a second R undoes the rollback.
    expect(await updater.rollbackPlan()).toMatchObject({ from: { sha: good }, to: { sha: bad } });
  });

  it("does nothing on rollback when there is no previous build", async () => {
    const { app, updater } = await fixture();
    expect(await updater.rollbackPlan()).toBeUndefined();
    expect(await updater.rollback()).toEqual({ rolledBack: false, message: "No previous build to roll back to; nothing changed." });
    expect((await lstat(join(app, "dist"))).isDirectory()).toBe(true);
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
    expect(await updater.paused()).toBe(false);
    expect(await updater.rolledBack()).toBeUndefined();
  });

  it("never prunes the rollback target, even when a caller does not name it", async () => {
    const app = await mkdtemp(join(tmpdir(), "indra-prune-"));
    const runtime = join(app, "state.runtime");
    const hour = 60 * 60_000;
    const names = ["first", "second", "third"];
    for (const name of names) {
      await mkdir(join(app, "builds", name), { recursive: true });
      await writeFile(join(app, "builds", name, "cli.js"), "");
    }
    await switchDist(app, "first", { runtimeDir: runtime });
    await switchDist(app, "second", { runtimeDir: runtime });
    expect(await readlink(join(app, "dist-previous"))).toBe(join("builds", "first"));
    // All builds are now past the grace period and none is named by the caller: only the live build and the rollback target stay.
    for (const name of names) await utimes(join(app, "builds", name), new Date(Date.now() - hour), new Date(Date.now() - hour));
    await pruneBuilds(app, [], { runtimeDir: runtime });
    expect((await readdir(join(app, "builds"))).sort()).toEqual(["first", "second"]);
    expect(await new SelfUpdater(app, "npm", undefined, runtime).rollbackPlan()).toMatchObject({ build: "first" });
  });

  it("blocks without remembering the commit when npm ci fails, keeps the running build, and retries the install next time", async () => {
    const { app, runtime, updater, npmCalls, merge } = await fixture();
    await writeFile(join(app, "fail-ci"), "");
    await merge("package-lock.json", "{\"lockfileVersion\": 3, \"packages\": {}}\n");
    const blocked = await updater.check();
    expect(blocked).toMatchObject({ outcome: "blocked", installFailed: true });
    expect(blocked.message).toMatch(/^dependency install failed: .*ENOSPC/);
    expect(await readUpdateStatus(runtime)).toMatchObject({ outcome: "blocked", installFailed: true });
    expect(await readUpdateStatus(runtime)).not.toHaveProperty("message");
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
    await rm(join(app, "fail-ci"));
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    expect(await readUpdateStatus(runtime)).toMatchObject({ outcome: "built" });
    expect(await readUpdateStatus(runtime)).not.toHaveProperty("installFailed");
    expect(await npmCalls()).toEqual(["ci", "ci", "run build"]);
  });
});
