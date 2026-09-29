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

function policyEvidence(endpoint: string, head: string, protectedTarget = true) {
  const base = "b".repeat(40); const blob = "c".repeat(40); const owners = "* @satori-miyamoto\n";
  const prefix = "repos/test/project";
  if (endpoint === `${prefix}/pulls/1`) return { state: "open", draft: false, auto_merge: null, head: { sha: head }, base: { ref: "main", sha: base, repo: { full_name: "test/project" } } };
  if (endpoint === `${prefix}/branches/main/protection`) return { enforce_admins: { enabled: true }, required_status_checks: { contexts: ["checks"] },
    required_pull_request_reviews: protectedTarget ? { required_approving_review_count: 1, require_code_owner_reviews: true, dismiss_stale_reviews: true, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } } : null };
  if (endpoint === `${prefix}/collaborators/satori-miyamoto/permission`) return { permission: "write", user: { login: "satori-miyamoto", permissions: { push: true } } };
  if (endpoint === `${prefix}/git/trees/${base}?recursive=1`) return { truncated: false, tree: [{ path: ".github/CODEOWNERS", type: "blob", mode: "100644", sha: blob }] };
  if (endpoint === `${prefix}/git/blobs/${blob}`) return { sha: blob, encoding: "base64", content: Buffer.from(owners).toString("base64"), size: Buffer.byteLength(owners) };
  if (endpoint === `${prefix}/codeowners/errors?ref=${base}`) return { errors: [] };
  return undefined;
}

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
  protectedTarget = true;
  policyUnavailable = false;
  autoArmed = false;
  serverRejected = false;
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
      if (this.policyUnavailable) return ok("", 1);
      const policy = policyEvidence(args[1], this.head(), this.protectedTarget);
      if (policy) return ok(JSON.stringify(policy));
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
    if (args.includes("--disable-auto")) { this.autoArmed = false; return ok(); }
    if (args[0] === "pr" && args[1] === "merge") {
      if (args.includes("--auto")) this.autoArmed = true;
      await this.mutateBeforeMerge?.();
      if (args[args.indexOf("--match-head-commit") + 1] !== this.head()) return ok("", 1);
      const bot = this.reviews.filter((review) => review.user.login === "satori-miyamoto" && ["APPROVED", "DISMISSED", "CHANGES_REQUESTED"].includes(review.state)).at(-1);
      if (this.protectedTarget && bot?.state !== "APPROVED") { this.serverRejected = true; return ok("", 1); }
      git(this.remote, "update-ref", "refs/heads/main", this.head()); this.state = "MERGED"; this.autoArmed = false;
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
    expect(shell.calls.find((call) => call.args[1] === "merge")?.args).toEqual(["pr", "merge", url, "--squash", "--match-head-commit", shell.head()]);
    expect(shell.autoArmed).toBe(false);
  });

  it.each(["unprotected", "unreadable"])("never attempts an archival merge on an %s target", async (problem) => {
    const { github, shell } = await fixture(); await github.ensureRetroPr("test/project", goal, content); shell.approve();
    shell.protectedTarget = problem !== "unprotected"; shell.policyUnavailable = problem === "unreadable";
    expect(await github.mergeRetroPr("test/project", goal, content, url, shell.head())).toMatchObject({ merged: false, reason: expect.stringContaining("Automatic merge blocked:") });
    expect(shell.calls.some((call) => call.args[1] === "merge")).toBe(false);
    expect(shell.state).toBe("OPEN");
  });

  it.each(["DISMISSED", "CHANGES_REQUESTED"])("relies on the server to reject a same-head archival %s racing the mutation", async (verdict) => {
    const { github, shell, remote } = await fixture(); await github.ensureRetroPr("test/project", goal, content); shell.approve();
    const head = shell.head(); const main = git(remote, "rev-parse", "main").trim();
    shell.mutateBeforeMerge = async () => { shell.reviews.push({ id: 2, user: { login: "satori-miyamoto" }, state: verdict, commit_id: head }); };
    expect((await github.mergeRetroPr("test/project", goal, content, url, head)).merged).toBe(false);
    expect(shell.serverRejected).toBe(true); expect(shell.state).toBe("OPEN"); expect(shell.head()).toBe(head);
    expect(git(remote, "rev-parse", "main").trim()).toBe(main); expect(shell.autoArmed).toBe(false);
    expect(shell.calls.filter((call) => call.args[1] === "merge").map((call) => call.args)).toEqual([["pr", "merge", url, "--squash", "--match-head-commit", head]]);
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

describe("server-enforced bot review policy", () => {
  const head = "a".repeat(40); const base = "b".repeat(40); const blobSha = "c".repeat(40);
  const prefix = "repos/test/project";
  const protectionPath = `${prefix}/branches/main/protection`;
  const permissionPath = `${prefix}/collaborators/satori-miyamoto/permission`;
  const treePath = `${prefix}/git/trees/${base}?recursive=1`;
  const blobPath = `${prefix}/git/blobs/${blobSha}`;
  const errorsPath = `${prefix}/codeowners/errors?ref=${base}`;
  const reviews = () => ({ required_approving_review_count: 1, require_code_owner_reviews: true, dismiss_stale_reviews: true,
    bypass_pull_request_allowances: { users: [], teams: [], apps: [] } });
  const protection = () => ({ enforce_admins: { enabled: true }, required_pull_request_reviews: reviews(), required_status_checks: { contexts: ["checks"] } });
  const permission = () => ({ permission: "write", user: { login: "satori-miyamoto", permissions: { push: true } } });
  const owner = () => ({ path: ".github/CODEOWNERS", type: "blob", mode: "100644", sha: blobSha });
  const blob = (content = "* @satori-miyamoto\n") => ({ sha: blobSha, encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
  class Policy implements Shell {
    calls: string[][] = [];
    replies = new Map<string, { code: number; stdout: string; stderr: string }>();
    constructor(branch = "main") {
      this.set(`${prefix}/pulls/1`, { state: "open", draft: false, auto_merge: null, head: { sha: head }, base: { ref: branch, sha: base, repo: { full_name: "test/project" } } });
      this.set(`${prefix}/branches/${encodeURIComponent(branch)}/protection`, protection());
      this.set(permissionPath, permission()); this.set(treePath, { truncated: false, tree: [owner()] });
      this.set(blobPath, blob()); this.set(errorsPath, { errors: [] });
    }
    set(endpoint: string, value: unknown) { this.replies.set(endpoint, { code: 0, stdout: JSON.stringify(value), stderr: "" }); }
    async run(command: string, args: string[]) {
      expect(command).toBe("gh"); expect(args[0]).toBe("api"); expect(args.slice(2)).toEqual(["--method", "GET"]);
      this.calls.push(args);
      return this.replies.get(args[1]) ?? { code: 1, stdout: "", stderr: "unavailable" };
    }
  }
  it.each(["main", "sprint/goal-retro"])("verifies the sole writable bot Code Owner at the immutable %s base using reads only", async (branch) => {
    const shell = new Policy(branch);
    expect(await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").serverMergeBlocker(url, head)).toBeUndefined();
    expect(shell.calls.map((args) => args[1])).toEqual([`${prefix}/pulls/1`, `${prefix}/branches/${encodeURIComponent(branch)}/protection`, permissionPath, treePath, blobPath, errorsPath]);
  });
  it.each([
    ["absent review protection", protectionPath, { ...protection(), required_pull_request_reviews: null }],
    ["generic review count without a named Code Owner", protectionPath, { ...protection(), required_pull_request_reviews: { ...reviews(), require_code_owner_reviews: false } }],
    ["no required approval", protectionPath, { ...protection(), required_pull_request_reviews: { ...reviews(), required_approving_review_count: 0 } }],
    ["stale approvals retained", protectionPath, { ...protection(), required_pull_request_reviews: { ...reviews(), dismiss_stale_reviews: false } }],
    ["administrator bypass", protectionPath, { ...protection(), enforce_admins: { enabled: false } }],
    ["review bypass", protectionPath, { ...protection(), required_pull_request_reviews: { ...reviews(), bypass_pull_request_allowances: { users: [{ login: "owner" }], teams: [], apps: [] } } }],
    ["unknown bypass shape", protectionPath, { ...protection(), required_pull_request_reviews: { ...reviews(), bypass_pull_request_allowances: null } }],
    ["no required CI", protectionPath, { ...protection(), required_status_checks: { contexts: [] } }],
    ["read-only bot", permissionPath, { permission: "read", user: { login: "satori-miyamoto", permissions: { push: false } } }],
    ["unverified write permission", permissionPath, { ...permission(), user: { login: "satori-miyamoto" } }],
    ["wrong account", permissionPath, { ...permission(), user: { login: "owner", permissions: { push: true } } }],
    ["missing CODEOWNERS", treePath, { truncated: false, tree: [] }],
    ["truncated tree", treePath, { truncated: true, tree: [owner()] }],
    ["symlink CODEOWNERS", treePath, { truncated: false, tree: [{ ...owner(), mode: "120000" }] }],
    ["alternate owner", blobPath, blob("* @satori-miyamoto @owner\n")],
    ["partial ownership", blobPath, blob("src/** @satori-miyamoto\n")],
    ["ownership override", blobPath, blob("* @satori-miyamoto\ndocs/** @owner\n")],
    ["incomplete owner bytes", blobPath, { ...blob(), size: 500 }],
    ["GitHub rejects the rule", errorsPath, { errors: [{ message: "Owner cannot be resolved" }] }],
  ])("fails closed for %s", async (_problem, endpoint, value) => {
    const shell = new Policy(); shell.set(endpoint as string, value);
    const blocker = await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").serverMergeBlocker(url, head);
    expect(blocker).toMatch(/^Automatic merge blocked:/); expect(blocker).toContain("docs/remodel-contract.md");
  });
  it.each(["forbidden", "unreadable", "unknown"])("keeps %s policy evidence blocked without leaking response text", async (problem) => {
    const shell = new Policy(); shell.replies.set(protectionPath, { code: problem === "forbidden" ? 1 : 0, stdout: problem === "unknown" ? "[]" : "private response", stderr: "private stderr" });
    const blocker = await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").serverMergeBlocker(url, head);
    expect(blocker).toMatch(/^Automatic merge blocked:/); expect(blocker).not.toContain("private");
  });
  it.each(["changed head", "foreign target", "already armed"])("rejects %s before inspecting policy", async (problem) => {
    const shell = new Policy(); shell.set(`${prefix}/pulls/1`, { state: "open", draft: false,
      auto_merge: problem === "already armed" ? { enabled_by: { login: "owner" } } : null,
      head: { sha: problem === "changed head" ? "d".repeat(40) : head },
      base: { ref: "main", sha: base, repo: { full_name: problem === "foreign target" ? "other/project" : "test/project" } } });
    expect(await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").serverMergeBlocker(url, head)).toMatch(/^Automatic merge blocked:/);
    expect(shell.calls).toHaveLength(1);
  });
});


describe("integration and revert automatic merge gate", () => {
  class Gate implements Shell {
    calls: string[][] = []; state = "OPEN"; head = "a".repeat(40); reviewHead = this.head; reviewer = "satori-miyamoto"; verdict = "APPROVED"; checks = [{ name: "checks", bucket: "pass" }]; outstanding = false; pending = false; lostResponse = false;
    protectedTarget = true; policyUnavailable = false; autoArmed = false; serverRejected = false; mutateBeforeMerge?: () => void;
    async run(_command: string, args: string[]) {
      this.calls.push(args);
      let stdout = "";
      if (args[0] === "api" && !args[1].includes("/reviews?")) {
        const policy = policyEvidence(args[1], this.head, this.protectedTarget);
        return { code: this.policyUnavailable ? 1 : 0, stdout: this.policyUnavailable ? "" : JSON.stringify(policy), stderr: "" };
      }
      if (args[1] === "view") stdout = JSON.stringify({ state: this.state, headRefOid: this.head, mergeCommit: this.state === "MERGED" ? { oid: "b".repeat(40) } : null, isDraft: false, author: { login: "owner" }, reviewDecision: "" });
      if (args[1]?.includes("/reviews?")) stdout = JSON.stringify([[{ id: 1, user: { login: this.reviewer }, state: this.verdict, commit_id: this.reviewHead }, ...(this.outstanding ? [{ id: 2, user: { login: "other-reviewer" }, state: "CHANGES_REQUESTED", commit_id: this.head }] : [])]]);
      if (args[1] === "checks") stdout = JSON.stringify(this.checks);
      if (args.includes("--disable-auto")) { this.autoArmed = false; return { code: 0, stdout, stderr: "" }; }
      if (args[1] === "merge") {
        if (args.includes("--auto")) this.autoArmed = true;
        this.mutateBeforeMerge?.();
        const blocked = args[args.indexOf("--match-head-commit") + 1] !== this.head || (this.protectedTarget && (this.verdict !== "APPROVED" || this.outstanding));
        if (blocked) { this.serverRejected = true; return { code: 1, stdout: "", stderr: "Required approval or head precondition failed" }; }
        if (!this.pending) { this.state = "MERGED"; this.autoArmed = false; }
        if (this.lostResponse) throw new Error("Lost merge response");
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
    expect(shell.calls.filter((args) => args[1] === "merge")).toEqual([["pr", "merge", url, "--squash", "--match-head-commit", shell.head]]);
    expect(shell.autoArmed).toBe(false);
  });
  it.each(["unprotected", "unreadable"])("does not attempt a merge on an %s target even with current approval and CI", async (problem) => {
    const shell = new Gate(); shell.protectedTarget = problem !== "unprotected"; shell.policyUnavailable = problem === "unreadable";
    expect(await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").merge(url)).toMatchObject({ merged: false, reason: expect.stringContaining("Automatic merge blocked:") });
    expect(shell.state).toBe("OPEN"); expect(shell.calls.some((args) => args[1] === "merge")).toBe(false);
  });
  it.each(["DISMISSED", "CHANGES_REQUESTED"])("lets the server block same-head %s after client inspection", async (verdict) => {
    const shell = new Gate(); const head = shell.head; shell.mutateBeforeMerge = () => { shell.verdict = verdict; };
    expect((await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").merge(url)).merged).toBe(false);
    expect(shell.serverRejected).toBe(true); expect(shell.head).toBe(head); expect(shell.state).toBe("OPEN"); expect(shell.autoArmed).toBe(false);
    expect(shell.calls.filter((args) => args[1] === "merge")).toEqual([["pr", "merge", url, "--squash", "--match-head-commit", head]]);
  });
  it.each([false, true])("reconciles a lost immediate merge response without arming a future merge (pending: %s)", async (pending) => {
    const shell = new Gate(); shell.pending = pending; shell.lostResponse = true;
    expect((await new SprintGitHub(shell, "/tmp/indra-contract-gate.runtime").merge(url)).merged).toBe(!pending);
    expect(shell.state).toBe(pending ? "OPEN" : "MERGED"); expect(shell.autoArmed).toBe(false);
    expect(shell.calls.filter((args) => args[1] === "merge")).toEqual([["pr", "merge", url, "--squash", "--match-head-commit", shell.head]]);
  });
});
