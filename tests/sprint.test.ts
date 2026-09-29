import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SprintError, SprintGitHub, retroPath } from "../src/sprint.js";
import { processShell, type Shell } from "../src/command-shell.js";
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
  reviews: { id: number; user: { login: string }; state: string; commit_id: string; body?: string; comments?: unknown[] }[] = [];
  reviewer = "satori-miyamoto";
  loseReview = false;
  refuseReview = false;
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
    if (command === "env") {
      expect(args[0]).toMatch(/^GH_CONFIG_DIR=.*\/\.config\/gh-yahaha-bot$/);
      expect(args[1]).toBe("gh");
      args = args.slice(2);
      if (args[0] === "api" && args[1] === "user") return ok(this.reviewer);
      if (args[0] === "api" && args[1].endsWith("/reviews") && args.includes("POST")) {
        if (this.refuseReview) return ok("", 1);
        const review = JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8"));
        this.reviews.push({ id: this.reviews.length + 1, user: { login: this.reviewer }, state: review.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", ...review });
        return ok("", this.loseReview ? 1 : 0);
      }
      throw new Error("Unexpected reviewer command");
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
    if (args.includes("--disable-auto")) return ok();
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

describe("sprint checked commands", () => {
  it.each([
    [" \n permission\t denied \n", "permission denied"],
    [" \t\n", "no output"],
    ["x".repeat(121), "x".repeat(120)],
    [`${"x".repeat(100)} ${"ab12".repeat(10)}`, `${"x".repeat(100)} [redacted]`],
  ])("keeps the SprintError stderr excerpt contract (%j)", async (stderr, excerpt) => {
    const run = vi.fn<Shell["run"]>().mockResolvedValue({ code: 17, stdout: "private stdout", stderr });
    const github = new SprintGitHub({ run }, "/managed/state.runtime");
    const opened = github.openPr("test/project", "sprint/goal-test", "Title", "Body");
    await expect(opened).rejects.toBeInstanceOf(SprintError);
    await expect(opened).rejects.toMatchObject({ name: "SprintError", message: `gh pr list failed: ${excerpt}` });
    expect(run).toHaveBeenCalledExactlyOnceWith("gh", ["pr", "list", "--repo", "test/project", "--head", "sprint/goal-test", "--base", "main", "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""], "/managed");
  });

  it("propagates a shell rejection without converting it to a SprintError", async () => {
    const error = new Error("shell rejected");
    const run = vi.fn<Shell["run"]>().mockRejectedValue(error);
    const github = new SprintGitHub({ run }, "/managed/state.runtime");
    await expect(github.openPr("test/project", "sprint/goal-test", "Title", "Body")).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("retrospective-only GitHub archival", () => {
  it.each([false, true])("posts the fresh review's line comments and verdict, recovering lost responses (findings: %s)", async (findings) => {
    const { github, shell, runtimeDir } = await fixture();
    await github.ensureRetroPr("test/project", goal, content);
    shell.checks[0].bucket = "pending"; shell.loseReview = true;
    const review = vi.fn(async (cwd: string) => {
      expect(cwd.startsWith(join(runtimeDir, "worktrees"))).toBe(true);
      expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(shell.head());
      expect(await readFile(join(cwd, path), "utf8")).toBe(content);
      return { summary: "Reviewed the frozen archive", findings: findings ? [{ path, line: 3, reason: "Missing recorded evidence." }] : [] };
    });
    await github.reviewRetroPr("test/project", goal, content, url, shell.head(), review);
    await new SprintGitHub(shell, runtimeDir).reviewRetroPr("test/project", goal, content, url, shell.head(), review);
    expect(review).toHaveBeenCalledTimes(1);
    expect(shell.reviews).toHaveLength(1);
    expect(shell.reviews[0]).toMatchObject({ commit_id: shell.head(), user: { login: "satori-miyamoto" }, state: findings ? "CHANGES_REQUESTED" : "APPROVED",
      comments: findings ? [{ path, line: 3, side: "RIGHT", body: "Missing recorded evidence." }] : [] });
    expect((await github.inspectRetroPr("test/project", goal, content, url)).reviewed).toBe(!findings);
    expect(shell.calls.filter((call) => call.command === "env").every((call) => call.args.includes("user") || call.args.some((arg) => arg.endsWith("/reviews")))).toBe(true);
  });

  it("fails closed on the wrong review account or an unconfirmed verdict", async () => {
    const { github, shell } = await fixture(); await github.ensureRetroPr("test/project", goal, content);
    const review = vi.fn(async () => ({ summary: "Reviewed", findings: [] }));
    shell.reviewer = "owner";
    await expect(github.reviewRetroPr("test/project", goal, content, url, shell.head(), review)).rejects.toThrow("satori-miyamoto");
    expect(review).not.toHaveBeenCalled();
    shell.reviewer = "satori-miyamoto"; shell.refuseReview = true;
    await expect(github.reviewRetroPr("test/project", goal, content, url, shell.head(), review)).rejects.toThrow("not confirmed");
    expect((await github.inspectRetroPr("test/project", goal, content, url)).reviewed).toBe(false);
  });

  it("does not post a stale review when the PR head changes during the reviewer run", async () => {
    const { github, shell, source, remote } = await fixture(); await github.ensureRetroPr("test/project", goal, content);
    const head = shell.head();
    await expect(github.reviewRetroPr("test/project", goal, content, url, head, async () => {
      git(source, "fetch", "--quiet", remote, `retro/${goal}`); git(source, "checkout", "--quiet", "--detach", "FETCH_HEAD");
      git(source, "commit", "--allow-empty", "-qm", "New head"); git(source, "push", "--quiet", remote, `HEAD:refs/heads/retro/${goal}`);
      git(remote, "update-ref", "refs/pull/1/head", shell.head());
      return { summary: "Reviewed", findings: [] };
    })).rejects.toThrow("changed during review");
    expect(shell.reviews).toHaveLength(0);
  });

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
    expect(shell.calls.filter((call) => call.args[1] === "merge" && !call.args.includes("--disable-auto"))).toHaveLength(1);
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
    expect(shell.calls.some((call) => call.args[1] === "merge" && !call.args.includes("--disable-auto"))).toBe(false);
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


describe("integration and revert automatic merge gate", () => {
  class Gate implements Shell {
    calls: string[][] = []; state = "OPEN"; head = "a".repeat(40); reviewHead = this.head; reviewer = "satori-miyamoto"; verdict = "APPROVED"; checks = [{ name: "checks", bucket: "pass" }]; outstanding = false; pending = false; lostResponse = false; cancelCode = 0;
    async run(_command: string, args: string[]) {
      this.calls.push(args);
      let stdout = "";
      if (args[1] === "view") stdout = JSON.stringify({ state: this.state, headRefOid: this.head, mergeCommit: this.state === "MERGED" ? { oid: "b".repeat(40) } : null, isDraft: false, author: { login: "owner" }, reviewDecision: "" });
      if (args[1]?.includes("/reviews?")) stdout = JSON.stringify([[{ id: 1, user: { login: this.reviewer }, state: this.verdict, commit_id: this.reviewHead }, ...(this.outstanding ? [{ id: 2, user: { login: "other-reviewer" }, state: "CHANGES_REQUESTED", commit_id: this.head }] : [])]]);
      if (args[1] === "checks") stdout = JSON.stringify(this.checks);
      if (args.includes("--disable-auto")) return { code: this.cancelCode, stdout: "", stderr: "Cancellation failed" };
      if (args[1] === "merge" && args.includes("--auto")) {
        if (!this.pending) this.state = "MERGED";
        if (this.lostResponse) throw new Error("Lost auto-merge response");
      }
      return { code: 0, stdout, stderr: "" };
    }
  }
  it.each(["stale", "other-reviewer", "dismissed", "outstanding", "empty-ci", "failed-ci"])("refuses %s proof before requesting any merge", async (problem) => {
    const shell = new Gate();
    if (problem === "stale") shell.reviewHead = "c".repeat(40);
    if (problem === "other-reviewer") shell.reviewer = "owner";
    if (problem === "dismissed") shell.verdict = "DISMISSED";
    if (problem === "outstanding") shell.outstanding = true;
    if (problem === "empty-ci") shell.checks = [];
    if (problem === "failed-ci") shell.checks[0].bucket = "fail";
    expect((await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").merge(url)).merged).toBe(false);
    expect(shell.calls.some((args) => args[1] === "merge")).toBe(false);
  });
  it("binds the reviewed head and verifies the resulting merge", async () => {
    const shell = new Gate();
    expect(await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").merge(url)).toEqual({ merged: true, sha: "b".repeat(40) });
    expect(shell.calls).toContainEqual(["pr", "merge", url, "--auto", "--squash", "--match-head-commit", shell.head]);
  });
  it("cancels even when the auto request response is lost, and reports a failed cancellation", async () => {
    const shell = new Gate(); shell.pending = true; shell.lostResponse = true;
    const github = new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime");
    await expect(github.merge(url)).rejects.toThrow("Lost auto-merge response");
    expect(shell.calls).toContainEqual(["pr", "merge", url, "--disable-auto"]);
    shell.lostResponse = false; shell.cancelCode = 1;
    await expect(github.merge(url)).rejects.toThrow("Cancellation failed");
  });
  it("does not mistake an accepted auto request for a merge and disarms the pending request", async () => {
    const shell = new Gate(); shell.pending = true;
    expect((await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").merge(url)).merged).toBe(false);
    expect(shell.calls).toContainEqual(["pr", "merge", url, "--disable-auto"]);
    expect(shell.state).toBe("OPEN");
  });
});
