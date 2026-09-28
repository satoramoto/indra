import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBuildStamp } from "../src/build-stamp.js";
import { SelfUpdater } from "../src/self-update.js";
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
  return { app, remote, updater: new SelfUpdater(app, npm), npmCalls, merge };
}

describe("self-update", () => {
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

  it("leaves a dirty checkout alone and says why", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    const before = head(app);
    await writeFile(join(app, "code.ts"), "export const version = 99;\n");
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "blocked", message: "the Indra checkout has uncommitted changes" });
    expect(head(app)).toBe(before);
    expect(await readFile(join(app, "code.ts"), "utf8")).toBe("export const version = 99;\n");
    expect(await npmCalls()).toEqual([]);
  });

  it("leaves a checkout on another branch alone", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    git(app, "checkout", "--quiet", "-b", "feature");
    const before = head(app);
    await merge("code.ts", "export const version = 2;\n");
    expect(await updater.check()).toMatchObject({ outcome: "blocked", message: "the Indra checkout is on feature, not main" });
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
    const { app, updater, npmCalls, merge } = await fixture();
    await writeFile(join(app, "fail-build"), "");
    await merge("code.ts", "export const version = 2\n");
    const failed = await updater.check();
    expect(failed.outcome).toBe("failed");
    expect(failed.message).toContain("still running the previous build");
    expect(failed.message).toContain("error TS1005");
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
    expect(execFileSync(process.execPath, [join(app, "dist", "cli.js")], { encoding: "utf8" })).toBe("running build\n");
    expect(await updater.check()).toMatchObject({ outcome: "failed" });
    expect(await npmCalls()).toEqual(["run build"]);
  });

  it("switches dist to the new build atomically, keeps the previous build and prunes older ones", async () => {
    const { app, updater, merge } = await fixture();
    // The first update moves the local real dist/ aside (spawns are held meanwhile); from then on dist is a symlink.
    await merge("code.ts", "export const version = 1.5;\n");
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    // A separate process reads dist/cli.js in a tight loop through three updates and counts misses.
    const stop = join(app, "..", "stop");
    const reader = spawn(process.execPath, ["-e", `
const { readFileSync, existsSync } = require("node:fs");
let reads = 0, misses = 0;
while (!existsSync(${JSON.stringify(stop)})) {
  reads++;
  try { if (!/build/.test(readFileSync(${JSON.stringify(join(app, "dist", "cli.js"))}, "utf8"))) misses++; } catch { misses++; }
}
console.log(JSON.stringify({ reads, misses }));
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
    const { reads, misses } = JSON.parse(output) as { reads: number; misses: number };
    expect(reads).toBeGreaterThan(100);
    expect(misses).toBe(0);
    expect((await lstat(join(app, "dist"))).isSymbolicLink()).toBe(true);
    expect(await readBuildStamp(app)).toMatchObject({ sha: head(app) });
    expect(await readdir(join(app, "builds"))).toHaveLength(2);
    expect(await readdir(app)).not.toContain(expect.stringMatching(/^\.dist-/));
  });

  it("blocks without remembering the commit when npm ci fails, keeps the running build, and retries the install next time", async () => {
    const { app, updater, npmCalls, merge } = await fixture();
    await writeFile(join(app, "fail-ci"), "");
    await merge("package-lock.json", "{\"lockfileVersion\": 3, \"packages\": {}}\n");
    const blocked = await updater.check();
    expect(blocked).toMatchObject({ outcome: "blocked", installFailed: true });
    expect(blocked.message).toMatch(/^dependency install failed: .*ENOSPC/);
    expect(await readBuildStamp(app)).toMatchObject({ id: "running" });
    await rm(join(app, "fail-ci"));
    expect(await updater.check()).toMatchObject({ outcome: "built" });
    expect(await npmCalls()).toEqual(["ci", "ci", "run build"]);
  });
});
