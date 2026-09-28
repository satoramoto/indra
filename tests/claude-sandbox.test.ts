import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudePermissionArgs } from "../src/claude-runtime.js";
import type { WriteAccess } from "../src/codex-runtime.js";

const exec = promisify(execFile);
const srt = join(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))), "cli.js");
const probe = fileURLToPath(new URL("./fixtures/claude-sandbox-probe.ts", import.meta.url));
const files = ["append.txt", "delete.txt", "overwrite.txt", "read.txt", "rename.txt"];
const cleanup: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "indra-sandbox-"))); cleanup.push(root);
  const cwd = join(root, "seat"); const common = join(root, "main", ".git"); const gitDir = join(common, "worktrees", "seat");
  const tempBase = join(root, "temporary"); const temp = join(tempBase, `claude-${process.getuid?.() ?? 0}`);
  await Promise.all([cwd, gitDir, temp].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(cwd, ".git"), `gitdir: ${relative(cwd, gitDir)}\n`);
  await writeFile(join(gitDir, "commondir"), "../..\n");
  await writeFile(join(gitDir, "gitdir"), join(cwd, ".git"));
  const alias = join(root, "aliases", "seat"); await mkdir(dirname(alias)); await symlink(cwd, alias);
  const deniedDir = join(cwd, "private-info"); await mkdir(deniedDir); await writeFile(join(deniedDir, "secret"), "unreadable fixture");
  vi.stubEnv("CLAUDE_CODE_TMPDIR", tempBase);
  const paths = [join(cwd, "probe"), join(common, "probe"), join(temp, "probe")];
  // The SRT temp grant and Claude's short-path fallback are independent of the worktree.
  for (const parent of ["/tmp/claude", `/tmp/claude-${process.getuid?.() ?? 0}`]) {
    await mkdir(parent, { recursive: true });
    const path = await mkdtemp(join(parent, "indra-probe-")); cleanup.push(path); paths.push(path);
  }
  for (const dir of paths) {
    await mkdir(dir, { recursive: true });
    await Promise.all(files.map((file) => writeFile(join(dir, file), "original")));
  }
  return { root, cwd, alias, common, temp, paths, deniedDir };
}

async function runSandbox(setup: Awaited<ReturnType<typeof fixture>>, write?: WriteAccess, denyWriteOverride?: string[]) {
  const args = await claudePermissionArgs(setup.alias, write);
  const { sandbox } = JSON.parse(args[args.indexOf("--settings") + 1]);
  const settings = join(setup.root, "sandbox.json");
  // Claude adds these roots before handing the settings to SRT. Exercise the
  // real OS sandbox, not a reimplementation of its allow/deny decision.
  await writeFile(settings, JSON.stringify({
    filesystem: { denyRead: [setup.deniedDir], ...sandbox.filesystem,
      allowWrite: [setup.cwd, setup.common, setup.temp, `/tmp/claude-${process.getuid?.() ?? 0}`, ...(sandbox.filesystem.allowWrite ?? [])],
      denyWrite: denyWriteOverride ?? sandbox.filesystem.denyWrite ?? [] },
    network: { allowedDomains: [], deniedDomains: [] },
  }));
  const paths = [...setup.paths, ...(!write && !denyWriteOverride ? [join(setup.alias, "probe")] : [])];
  const result = await exec(process.execPath, [srt, "--settings", settings, "--", process.execPath, probe, join(setup.deniedDir, "secret"), ...paths], { cwd: setup.cwd, timeout: 20_000 });
  return { ...JSON.parse(result.stdout), sandbox };
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("Claude filesystem permissions in the OS sandbox", () => {
  it("keeps worktree, linked Git metadata and temporary files readable but immutable, including symlink access", async () => {
    const setup = await fixture(); const { results, sandbox, protectedRead } = await runSandbox(setup);
    // Keep the list of implicit home/temp grants aligned with the real SRT.
    expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(getDefaultWritePaths().filter((path) => !path.startsWith("/dev/"))));
    expect(results).toHaveLength(setup.paths.length + 1);
    expect(["EACCES", "EPERM", "ENOENT"]).toContain(protectedRead);
    for (const result of results) {
      expect(result.read).toBe("original");
      for (const operation of ["create", "overwrite", "append", "rename", "delete", "mkdir"]) expect(["EACCES", "EPERM", "EROFS"]).toContain(result[operation]);
    }
    for (const dir of setup.paths) {
      expect((await readdir(dir)).sort()).toEqual(files);
      for (const file of files) expect(await readFile(join(dir, file), "utf8")).toBe("original");
    }
  }, 30_000);

  it("still lets Developer commands write inside their granted roots", async () => {
    const setup = await fixture();
    const { results } = await runSandbox(setup, { extraDirs: [setup.common] });
    for (const result of results) {
      expect(result.read).toBe("original");
      for (const operation of ["create", "overwrite", "append", "rename", "delete", "mkdir"]) expect(result[operation]).toBe("allowed");
    }
    for (const dir of setup.paths) expect(await readFile(join(dir, "created.txt"), "utf8")).toBe("created");
  }, 30_000);

  it.skipIf(process.platform !== "linux")("reproduces the old root-only denial allowing writes on Linux/WSL2", async () => {
    const setup = await fixture(); const { results } = await runSandbox(setup, undefined, ["/"]);
    expect(results[0].create).toBe("allowed");
    expect(await readFile(join(setup.paths[0], "created.txt"), "utf8")).toBe("created");
  }, 30_000);
});
