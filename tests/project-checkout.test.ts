import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./state-checkout.js";
import { processShell, type Shell } from "../src/developer-seat.js";
import { ensureProjectCheckout, ProjectCheckoutError, projectCheckoutPath } from "../src/project-checkout.js";

/** A GitHub stand-in: a local bare repository with `main`, plus a working copy that pushes to it. No network. */
async function remote() {
  const root = await mkdtemp(join(tmpdir(), "indra-project-"));
  const work = join(root, "work"); const bare = join(root, "bare.git");
  await mkdir(work);
  git(work, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(work, "README.md"), "one\n");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "One");
  git(root, "clone", "--quiet", "--bare", work, bare);
  git(work, "remote", "add", "origin", bare);
  const commit = async (text: string) => {
    await writeFile(join(work, "README.md"), text);
    git(work, "commit", "--quiet", "-am", text);
    git(work, "push", "--quiet", "origin", "main");
    return git(work, "rev-parse", "HEAD").trim();
  };
  return { runtimeDir: join(root, "state.runtime"), bare, commit, head: git(work, "rev-parse", "HEAD").trim() };
}

/** Runs real Git, with `gh repo clone OWNER/REPO DIR` answered by cloning the local bare repository. */
function localGh(bare: string, fail = false) {
  const calls: string[] = [];
  const shell: Shell = {
    run: async (command, args, cwd) => {
      calls.push(`${command} ${args.slice(0, 3).join(" ")}`);
      if (command === "gh") return fail ? { code: 1, stdout: "", stderr: "not found" } : await processShell.run("git", ["clone", "--quiet", bare, args[3]], cwd);
      return await processShell.run(command, args, cwd);
    },
  };
  return { shell, calls };
}

describe("project checkout", () => {
  it("clones a missing project with gh under the runtime directory, then fetches origin main before each use", async () => {
    const { runtimeDir, bare, commit, head } = await remote();
    const { shell, calls } = localGh(bare);
    const dir = await ensureProjectCheckout(shell, runtimeDir, "satoramoto/indra");
    expect(dir).toBe(join(runtimeDir, "projects", "satoramoto", "indra"));
    expect(git(dir, "rev-parse", "origin/main").trim()).toBe(head);
    expect(calls).toEqual(["gh repo clone satoramoto/indra", "git -c credential.helper= -c"]);
    const next = await commit("two\n");
    expect(await ensureProjectCheckout(shell, runtimeDir, "satoramoto/indra")).toBe(dir);
    expect(git(dir, "rev-parse", "origin/main").trim()).toBe(next);
    expect(calls.filter((call) => call.startsWith("gh"))).toHaveLength(1);
    expect(await readdir(join(runtimeDir, "projects", "satoramoto"))).toEqual(["indra"]);
  });

  it("leaves nothing behind when the clone fails, and refuses a directory that is not a checkout", async () => {
    const { runtimeDir, bare } = await remote();
    await expect(ensureProjectCheckout(localGh(bare, true).shell, runtimeDir, "satoramoto/indra")).rejects.toThrow(new ProjectCheckoutError("gh repo clone satoramoto/indra failed (exit 1)."));
    expect(await readdir(join(runtimeDir, "projects", "satoramoto"))).toEqual([]);
    await mkdir(join(runtimeDir, "projects", "satoramoto", "indra"));
    await expect(ensureProjectCheckout(localGh(bare).shell, runtimeDir, "satoramoto/indra")).rejects.toThrow("is not a Git checkout");
  });

  it("only accepts owner/repo, so a project can never point outside the runtime directory", () => {
    expect(projectCheckoutPath("/state.runtime", "satoramoto/indra")).toBe("/state.runtime/projects/satoramoto/indra");
    for (const github of ["../indra", "satoramoto/..", "/etc/passwd", "a/b/c"]) expect(() => projectCheckoutPath("/state.runtime", github)).toThrow(ProjectCheckoutError);
  });
});
