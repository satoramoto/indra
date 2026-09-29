import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SprintGitHub, retroPath } from "../src/sprint.js";
import { processShell, type Shell } from "../src/developer-seat.js";
import { git } from "./state-checkout.js";

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const goal = "goal-retro";
const path = retroPath(goal);
const content = "# Retrospective\n\nRecorded facts. Owner proposals only.\n";
const url = "https://github.com/test/project/pull/1";

class GitHub implements Shell {
  calls: { command: string; args: string[]; cwd: string }[] = [];
  state?: "OPEN" | "CLOSED" | "MERGED";
  checks = [{ name: "checks", bucket: "pass" }];
  reviews: { id: number; user: { login: string }; state: string; commit_id: string }[] = [];
  files = [{ filename: path, status: "added" }];
  extraPage = false;
  losePush = false;
  loseCreate = false;
  author = "owner";
  crossRepository = false;
  headBranch = `retro/${goal}`;
  baseBranch = "main";
  remoteUrl = "https://github.com/test/project.git";
  mutateBeforeMerge?: () => Promise<void>;
  constructor(readonly remote: string) {}
  head() { return git(this.remote, "rev-parse", `refs/heads/retro/${goal}`).trim(); }
  async run(command: string, args: string[], cwd: string) {
    this.calls.push({ command, args, cwd });
    const ok = (stdout = "", code = 0) => ({ code, stdout, stderr: "" });
    if (command === "git") {
      if (args.join(" ") === "remote get-url origin") return ok(this.remoteUrl);
      const result = await processShell.run(command, args, cwd);
      if (args.includes("push") && this.losePush) { this.losePush = false; return ok("", 1); }
      return result;
    }
    if (command !== "gh") throw new Error("Unexpected command");
    if (args[0] === "api") {
      if (args[1].includes("/files?")) return ok(JSON.stringify([this.files, ...(this.extraPage ? [[{ filename: "AGENTS.md", status: "modified" }]] : [])]));
      if (args[1].includes("/reviews?")) return ok(JSON.stringify([this.reviews]));
      if (args[1].includes("?state=all")) return ok(JSON.stringify([this.state ? [{ html_url: url }] : []]));
    }
    if (args[0] === "pr" && args[1] === "create") {
      expect(await readFile(args[args.indexOf("--body-file") + 1], "utf8")).toContain(path);
      this.state = "OPEN";
      git(this.remote, "update-ref", "refs/pull/1/head", this.head());
      return ok(url, this.loseCreate ? 1 : 0);
    }
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({
      state: this.state, headRefName: this.headBranch, baseRefName: this.baseBranch, headRefOid: this.head(), isCrossRepository: this.crossRepository,
      isDraft: false, author: { login: this.author }, mergeCommit: this.state === "MERGED" ? { oid: this.head() } : null, reviewDecision: "",
    }));
    if (args[0] === "pr" && args[1] === "checks") return ok(JSON.stringify(this.checks));
    if (args[0] === "pr" && args[1] === "merge") {
      await this.mutateBeforeMerge?.();
      if (args[args.indexOf("--match-head-commit") + 1] !== this.head()) return ok("", 1);
      git(this.remote, "update-ref", "refs/heads/main", this.head()); this.state = "MERGED";
      return ok("", 1); // The merge succeeded despite a lost response.
    }
    throw new Error(`Unexpected fake GitHub operation: ${args.slice(0, 2).join(" ")}`);
  }
  approve() { this.reviews.push({ id: this.reviews.length + 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: this.head() }); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "indra-retro-git-")); roots.push(root);
  const source = join(root, "source"); await mkdir(source);
  git(source, "init", "-q", "--initial-branch=main");
  await writeFile(join(source, "README.md"), "Project\n"); git(source, "add", "."); git(source, "commit", "-qm", "Initial project");
  const remote = join(root, "remote.git"); git(root, "clone", "--quiet", "--bare", source, remote);
  const runtimeDir = join(root, "state.runtime"); const project = join(runtimeDir, "projects/test/project");
  await mkdir(join(runtimeDir, "projects/test"), { recursive: true }); git(root, "clone", "--quiet", remote, project);
  const shell = new GitHub(remote); const github = new SprintGitHub(shell, runtimeDir);
  return { root, source, remote, runtimeDir, project, shell, github };
}

describe("retrospective-only GitHub archival", () => {
  it("commits precisely the frozen document in the managed project and recovers branch/PR publication", async () => {
    const { github, shell, project, remote, runtimeDir } = await fixture();
    shell.losePush = true;
    await expect(github.ensureRetroPr("test/project", goal, content)).rejects.toThrow("push was not confirmed");
    const original = shell.head(); shell.loseCreate = true;
    expect(await github.ensureRetroPr("test/project", goal, content)).toBe(url);
    expect(await new SprintGitHub(shell, runtimeDir).ensureRetroPr("test/project", goal, content)).toBe(url);
    expect(shell.head()).toBe(original);
    expect(git(remote, "show", `${original}:${path}`)).toBe(content);
    expect(git(remote, "diff", "--name-only", `${original}^`, original).trim()).toBe(path);
    expect(git(project, "status", "--porcelain")).toBe("");
    expect(shell.calls.filter((call) => call.args.includes("commit"))).toHaveLength(1);
    expect(shell.calls.filter((call) => call.args[0] === "pr" && call.args[1] === "create")).toHaveLength(1);
    expect(shell.calls.filter((call) => call.command === "git").every((call) => call.cwd.startsWith(runtimeDir))).toBe(true);
  });

  it("requires current-head independent review and CI, then verifies a merge whose response was lost", async () => {
    const { github, shell } = await fixture();
    await github.ensureRetroPr("test/project", goal, content);
    expect((await github.inspectRetroPr("test/project", goal, content, url)).reviewed).toBe(false);
    expect((await github.mergeRetroPr("test/project", goal, content, url, shell.head())).merged).toBe(false);
    shell.approve(); shell.checks[0].bucket = "fail";
    expect((await github.mergeRetroPr("test/project", goal, content, url, shell.head())).merged).toBe(false);
    shell.checks[0].bucket = "pass";
    expect(await github.mergeRetroPr("test/project", goal, content, url, shell.head())).toEqual({ merged: true, sha: shell.head() });
    expect(await github.ensureRetroPr("test/project", goal, content)).toBe(url);
    expect(await github.mergeRetroPr("test/project", goal, content, url, shell.head())).toEqual({ merged: true, sha: shell.head() });
    expect(shell.calls.filter((call) => call.args[1] === "merge")).toHaveLength(1);
  });

  it.each(["stale", "author", "findings", "dismissed", "missing-ci", "skipped-ci"])("blocks archival with %s evidence", async (problem) => {
    const { github, shell } = await fixture();
    await github.ensureRetroPr("test/project", goal, content); shell.approve();
    if (problem === "stale") shell.reviews[0].commit_id = "f".repeat(40);
    if (problem === "author") shell.author = "satori-miyamoto";
    if (problem === "findings") shell.reviews.push({ id: 2, user: { login: "another-reviewer" }, state: "CHANGES_REQUESTED", commit_id: shell.head() });
    if (problem === "dismissed") shell.reviews[0].state = "DISMISSED";
    if (problem === "missing-ci") shell.checks = [];
    if (problem === "skipped-ci") shell.checks[0].bucket = "skipping";
    expect((await github.mergeRetroPr("test/project", goal, content, url, shell.head())).merged).toBe(false);
    expect(shell.calls.some((call) => call.args[1] === "merge")).toBe(false);
  });

  it("leaves a closed-unmerged PR for the owner instead of creating its replacement", async () => {
    const { github, shell } = await fixture(); await github.ensureRetroPr("test/project", goal, content);
    shell.state = "CLOSED"; shell.approve();
    expect(await github.ensureRetroPr("test/project", goal, content)).toBe(url);
    expect((await github.mergeRetroPr("test/project", goal, content, url, shell.head())).merged).toBe(false);
    expect(shell.calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
  });

  it.each(["extra-page", "other-goal", "rename", "wrong-bytes", "wrong-base", "fork"])("rejects %s instead of permitting a broad main PR", async (problem) => {
    const { github, shell } = await fixture(); await github.ensureRetroPr("test/project", goal, content);
    if (problem === "extra-page") shell.extraPage = true;
    if (problem === "other-goal") shell.files[0].filename = "docs/retros/goal-other.md";
    if (problem === "rename") shell.files[0].status = "renamed";
    if (problem === "wrong-base") shell.baseBranch = "sprint/goal-retro";
    if (problem === "fork") shell.crossRepository = true;
    await expect(github.inspectRetroPr("test/project", goal, problem === "wrong-bytes" ? "Changed\n" : content, url)).rejects.toThrow();
  });

  it("rejects symlink directories without writing outside its managed worktree", async () => {
    const { source, remote, github, root } = await fixture();
    const outside = join(root, "outside"); await mkdir(outside);
    await symlink(outside, join(source, "docs")); git(source, "add", "docs"); git(source, "commit", "-qm", "Linked docs"); git(source, "push", "--quiet", remote, "main");
    await expect(github.ensureRetroPr("test/project", goal, content)).rejects.toThrow("real directories");
    await expect(readFile(join(outside, "retros", `${goal}.md`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins merge authorization to the inspected head when another commit races the merge", async () => {
    const { github, shell, source, remote } = await fixture(); await github.ensureRetroPr("test/project", goal, content); shell.approve();
    shell.mutateBeforeMerge = async () => {
      git(source, "fetch", "--quiet", remote, `retro/${goal}`); git(source, "checkout", "--quiet", "--detach", "FETCH_HEAD");
      git(source, "commit", "--allow-empty", "-qm", "Head changed"); git(source, "push", "--quiet", remote, `HEAD:refs/heads/retro/${goal}`);
      git(remote, "update-ref", "refs/pull/1/head", shell.head());
    };
    expect((await github.mergeRetroPr("test/project", goal, content, url, shell.head())).merged).toBe(false);
    expect(shell.state).toBe("OPEN");
  });

  it("rejects path traversal and foreign project URLs before any external operation", async () => {
    const { github, shell } = await fixture();
    await expect(github.ensureRetroPr("test/project", "../../escape", content)).rejects.toThrow("goal ID");
    await expect(github.inspectRetroPr("test/project", goal, content, "https://github.com/other/repo/pull/1")).rejects.toThrow("outside");
    expect(shell.calls).toHaveLength(0);
  });
});
