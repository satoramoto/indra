import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SprintError, SprintGitHub, retroPath } from "../src/sprint.js";
import { processShell, type Shell } from "../src/command-shell.js";
import { git } from "./state-checkout.js";
import type { GoalReport } from "../src/goal-contract.js";

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

describe("whole-goal release proof", () => {
  const report: GoalReport = { version: 1, goalId: "goal-one", teamId: "team-one", seatId: "seat-one", sprintBranch: "sprint/goal-one", headSha: "a".repeat(40),
    lanePrs: [{ laneId: "lane-one", url, headSha: "c".repeat(40), mergedSha: "d".repeat(40), reviewer: "satori-miyamoto", ci: "passed" }],
    checks: [{ command: "npm run typecheck", exitCode: 0 }], decisions: [], followUps: [], neededButUnowned: [] };
  it("checks actual branch head, merged lane verdict/CI/base/ancestry and both sides of renamed files", async () => {
    const f = await fixture();
    let remoteHead = report.headSha; let laneFiles = [{ filename: "src/new.ts", previous_filename: "src/old.ts" }]; let ancestor = true;
    const run = vi.fn<Shell["run"]>(async (command, args) => {
      if (command === "git" && args[0] === "diff") return { code: 0, stdout: "src/new.ts\0", stderr: "" };
      if (command === "git" && args[0] === "merge-base") return { code: ancestor ? 0 : 1, stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "pr") return { code: 0, stdout: JSON.stringify({ baseRefName: "sprint/goal-one", isCrossRepository: false }), stderr: "" };
      if (command === "gh" && args[1]?.includes("/files?")) return { code: 0, stdout: JSON.stringify([laneFiles]), stderr: "" };
      if (command === "gh" && args[1]?.includes("git/ref")) return { code: 0, stdout: remoteHead, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const github = new SprintGitHub({ run }, f.runtimeDir);
    const inspect = vi.spyOn(github, "inspectMerge").mockResolvedValue({ url, state: "MERGED", headSha: report.lanePrs[0].headSha, mergedSha: report.lanePrs[0].mergedSha, reviewed: true, checksPassed: true });
    await expect(github.verifyGoalReport("test/project", ["src/**"], report, "b".repeat(40))).resolves.toBeUndefined();
    remoteHead = "e".repeat(40); await expect(github.verifyGoalReport("test/project", ["src/**"], report, "b".repeat(40))).rejects.toThrow("sprint head"); remoteHead = report.headSha;
    inspect.mockResolvedValueOnce({ url, state: "MERGED", headSha: report.lanePrs[0].headSha, mergedSha: report.lanePrs[0].mergedSha, reviewed: false, checksPassed: true });
    await expect(github.verifyGoalReport("test/project", ["src/**"], report, "b".repeat(40))).rejects.toThrow("not supported");
    ancestor = false; await expect(github.verifyGoalReport("test/project", ["src/**"], report, "b".repeat(40))).rejects.toThrow("merge-base"); ancestor = true;
    laneFiles = [{ filename: "src/new.ts", previous_filename: "private/old.ts" }]; await expect(github.verifyGoalReport("test/project", ["src/**"], report, "b".repeat(40))).rejects.toThrow("ownership");
    await expect(github.verifyGoalReport("test/project", ["src/**"], { ...report, checks: [{ command: "check", exitCode: 1 }] }, "b".repeat(40))).rejects.toThrow("successful checks");
  });
  it("reads actual merged PR sections and rejects stale or unmerged retrospective sources", async () => {
    const body = "## Decisions\nKept the boundary\n\n## Follow-ups\nAdd the next feature\n\n## Validation\nchecks passed";
    const run = vi.fn<Shell["run"]>().mockResolvedValue({ code: 0, stdout: JSON.stringify({ state: "MERGED", headRefOid: report.headSha, body }), stderr: "" });
    const github = new SprintGitHub({ run }, "/fixture.runtime");
    expect(await github.prRetrospective("test/project", "goal-one", url, report.headSha)).toEqual({ url, headSha: report.headSha, decisions: "Kept the boundary", followUps: "Add the next feature" });
    await expect(github.prRetrospective("test/project", "goal-one", url, "f".repeat(40))).rejects.toThrow("verified merged PR head");
    run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: report.headSha, body }), stderr: "" });
    await expect(github.prRetrospective("test/project", "goal-one", url, report.headSha)).rejects.toThrow("verified merged PR head");
  });
  it.each(["owned", "dependencies", "unowned", "blocked", "check-failed", "push-failed", "live-owned", "live-foreign", "uninspectable", "ignored", "late-process", "late-ignored", "late-dirty", "late-untracked", "remove-failed"] as const)("preserves a real %s correction until its exact result is safely published and process-free", async (mode) => {
    const f = await fixture();
    await writeFile(join(f.source, "change.ts"), "original\n"); await writeFile(join(f.source, ".gitignore"), ".cache\nnode_modules/\ndist/\ncoverage/\n");
    await mkdir(join(f.source, "vendor/fixture-dependency"), { recursive: true });
    await writeFile(join(f.source, "vendor/fixture-dependency/package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }));
    const packageJson = { name: "correction-fixture", version: "1.0.0", private: true, dependencies: { "fixture-dependency": "file:vendor/fixture-dependency" },
      scripts: { build: `node -e "for (const dir of ['dist', 'coverage']) { require('fs').mkdirSync(dir, { recursive: true }); require('fs').writeFileSync(dir + '/output', 'generated'); }"` } };
    await writeFile(join(f.source, "package.json"), JSON.stringify(packageJson));
    await writeFile(join(f.source, "package-lock.json"), JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true, packages: {
      "": { name: packageJson.name, version: packageJson.version, dependencies: packageJson.dependencies }, "node_modules/fixture-dependency": { resolved: "vendor/fixture-dependency", link: true }, "vendor/fixture-dependency": { version: "1.0.0" },
    } }));
    git(f.source, "add", "."); git(f.source, "commit", "-qm", "Shared base");
    git(f.source, "checkout", "-qb", "sprint/goal-one"); await writeFile(join(f.source, "change.ts"), "goal change\n"); git(f.source, "commit", "-qam", "Goal"); const head = git(f.source, "rev-parse", "HEAD").trim();
    git(f.source, "checkout", "main"); await writeFile(join(f.source, "change.ts"), "main change\n"); git(f.source, "commit", "-qam", "Main"); const base = git(f.source, "rev-parse", "HEAD").trim();
    git(f.source, "push", f.remote, "main", "sprint/goal-one");
    const calls: string[][] = []; let resolved = false; let published = false; let retry = false; let pushAttempts = 0;
    const shell: Shell = { run: async (command, args, cwd) => {
      calls.push([command, ...args]);
      if (command === "lsof") {
        expect(args).toEqual(["-nP", "-F", "p", "+D", expect.stringContaining("integration-fix-goal-one-")]);
        if (!retry && ((resolved && mode.startsWith("live-")) || (published && mode === "late-process"))) return { code: 0, stdout: mode === "live-foreign" ? "p99999\n" : "p12345\n", stderr: "" };
        if (resolved && !retry && mode === "uninspectable") return { code: 1, stdout: "", stderr: "Inspection permission denied" };
        return { code: 1, stdout: "", stderr: "" };
      }
      if (command === "git") {
        if (args.includes("push")) { pushAttempts++; if (mode === "push-failed" && !retry) return { code: 1, stdout: "", stderr: "Fixture push failed" }; }
        if (args[0] === "worktree" && args[1] === "remove" && mode === "remove-failed" && !retry) return { code: 1, stdout: "", stderr: "Fixture cleanup refused" };
        return await processShell.run(command, args, cwd);
      }
      if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefName: "sprint/goal-one", baseRefName: "main", headRefOid: git(f.remote, "rev-parse", "sprint/goal-one").trim(), baseRefOid: base, isCrossRepository: false, mergeable: "CONFLICTING", body: "## Decisions\nOriginal decision" }), stderr: "" };
      if (args[0] === "api" && args[1].includes("/files?")) return { code: 0, stdout: JSON.stringify([[{ filename: "change.ts" }]]), stderr: "" };
      if (args[0] === "api" && args[1].includes("git/ref")) return { code: 0, stdout: git(f.remote, "rev-parse", "sprint/goal-one").trim(), stderr: "" };
      if (args[0] === "pr" && args[1] === "edit") {
        published = true; expect(await readFile(args.at(-1)!, "utf8")).toContain("indra-integration-correction:");
        if (mode === "late-ignored") await writeFile(join(isolated, ".cache"), "Unique ignored evidence\n");
        if (mode === "late-dirty") await writeFile(join(isolated, "change.ts"), "New local work after publication\n");
        if (mode === "late-untracked") await writeFile(join(isolated, "notes.txt"), "Unique untracked evidence\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error("Unexpected correction command");
    } };
    const github = new SprintGitHub(shell, f.runtimeDir); let isolated = "";
    const resolver = vi.fn(async (cwd: string, shared: string) => {
      if (retry) { expect(cwd).toBe(isolated); expect(await readFile(join(cwd, "change.ts"), "utf8")).toBe("partial correction with useful notes\n"); }
      isolated = cwd; expect(shared).toBe(await realpath(join(f.project, ".git")));
      await writeFile(join(cwd, "change.ts"), mode === "owned" || mode === "dependencies" || retry ? "goal and main preserved\n" : "partial correction with useful notes\n"); resolved = true;
      if (["dependencies", "push-failed", "ignored"].includes(mode)) {
        const installed = await processShell.run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(f.root, "npm-cache")], cwd);
        expect(installed.code, installed.stderr).toBe(0);
        const built = await processShell.run("npm", ["run", "build"], cwd); expect(built.code, built.stderr).toBe(0);
        expect(git(cwd, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory").trim().split("\n")).toEqual(["coverage/", "dist/", "node_modules/"]);
      }
      if (mode === "unowned") await writeFile(join(cwd, "README.md"), "Unapproved change to preserve\n");
      if (mode === "ignored") await writeFile(join(cwd, ".cache"), "Unique ignored evidence\n");
      if (!retry && mode === "check-failed") throw new Error("Required check failed with exit 1");
      return { decisions: ["Preserved both changes"], blocked: !retry && mode === "blocked" ? ["An architectural decision is needed"] : [] };
    });
    const correction = () => github.resolveIntegration("test/project", "goal-one", ["change.ts"], url, head, base, resolver);
    const cleanupOnly = ["late-process", "late-ignored", "late-dirty", "late-untracked", "remove-failed"].includes(mode);
    if (mode === "owned" || mode === "dependencies") {
      const result = await correction();
      expect(git(f.remote, "rev-list", "--parents", "-n", "1", result.headSha).trim().split(" ")).toEqual([result.headSha, head, base]);
      expect(git(f.remote, "show", `${result.headSha}:change.ts`)).toBe("goal and main preserved\n");
      await expect(readFile(join(isolated, "change.ts"))).rejects.toThrow();
      expect(calls.at(-1)).toEqual(["git", "worktree", "remove", isolated]);
      expect(calls.filter((args) => args[0] === "lsof")).toHaveLength(3);
    } else {
      const reason = mode === "unowned" ? "outside approved ownership" : mode === "blocked" ? "owner decision" : mode === "check-failed" ? "Required check failed" : mode === "push-failed" ? "Fixture push failed" : ["ignored", "late-ignored"].includes(mode) ? "ignored work" : ["late-dirty", "late-untracked"].includes(mode) ? "uncommitted" : mode === "remove-failed" ? "Fixture cleanup refused" : "process";
      if (cleanupOnly) {
        const result = await correction(); expect(result.headSha).toBe(git(f.remote, "rev-parse", "sprint/goal-one").trim());
        expect(result.decisions.at(-1)).toContain(`Retained published correction checkout at ${isolated}`); expect(result.decisions.at(-1)).toContain(reason);
      } else await expect(correction()).rejects.toThrow(reason);
      expect(await readFile(join(isolated, "change.ts"), "utf8")).toBe(mode === "late-dirty" ? "New local work after publication\n" : "partial correction with useful notes\n");
      if (mode === "unowned") expect(await readFile(join(isolated, "README.md"), "utf8")).toBe("Unapproved change to preserve\n");
      if (["ignored", "late-ignored"].includes(mode)) expect(await readFile(join(isolated, ".cache"), "utf8")).toBe("Unique ignored evidence\n");
      if (mode === "late-untracked") expect(await readFile(join(isolated, "notes.txt"), "utf8")).toBe("Unique untracked evidence\n");
      expect(calls.some((args) => args.includes("remove"))).toBe(mode === "remove-failed");
      const journalName = (await readdir(f.runtimeDir)).find((name) => name.startsWith("integration-recovery-") && name.endsWith(".json"))!;
      const journal = JSON.parse(await readFile(join(f.runtimeDir, journalName), "utf8"));
      expect(journal).toMatchObject({ headSha: head, baseSha: base, checkout: isolated, github: "test/project", ownedFiles: ["change.ts"], failure: cleanupOnly ? null : expect.stringContaining(reason), ...(cleanupOnly ? { phase: "pushed", cleanup: expect.stringContaining(reason) } : {}) });
      if (["ignored", "late-ignored"].includes(mode)) expect(journal.workspace.ignored).toContain(".cache");
      if (["dependencies", "push-failed", "ignored"].includes(mode)) expect(journal.workspace.ignored).toEqual(expect.arrayContaining(["node_modules/", "dist/", "coverage/"]));
      if (mode === "late-untracked") expect(journal.workspace.dirty).toContain("notes.txt");
      if (mode === "late-dirty") expect(journal.workspace.dirty).toContain("change.ts");
      expect(await realpath(git(isolated, "rev-parse", "--git-common-dir").trim())).toBe(await realpath(join(f.project, ".git")));
      if (mode === "blocked") {
        const file = join(f.runtimeDir, journalName); const original = await readFile(file, "utf8");
        await writeFile(file, JSON.stringify({ ...journal, checkout: f.source }));
        await expect(correction()).rejects.toThrow("recovery identity is uncertain");
        expect(resolver).toHaveBeenCalledTimes(1); expect(await readFile(join(isolated, "change.ts"), "utf8")).toBe("partial correction with useful notes\n");
        expect(git(f.source, "status", "--porcelain")).toBe(""); await writeFile(file, original);
      }
      if (!cleanupOnly) expect(git(f.remote, "rev-parse", "sprint/goal-one").trim()).toBe(head);
      if (mode !== "push-failed" && !cleanupOnly) expect(pushAttempts).toBe(0);
      if (["late-ignored", "late-dirty", "late-untracked"].includes(mode)) {
        const result = await correction(); expect(result.headSha).toBe(journal.resultSha);
        expect(result.decisions.at(-1)).toContain(reason); expect(resolver).toHaveBeenCalledTimes(1); expect(pushAttempts).toBe(1);
        expect(JSON.parse(await readFile(join(f.runtimeDir, journalName), "utf8"))).toMatchObject({ phase: "pushed", failure: null, cleanup: expect.stringContaining(reason) });
      } else if (!["unowned", "ignored"].includes(mode)) {
        const preservedHead = git(isolated, "rev-parse", "HEAD").trim(); retry = true;
        const result = await correction();
        expect(result.headSha).toBe(git(f.remote, "rev-parse", "sprint/goal-one").trim());
        if (mode === "push-failed" || cleanupOnly) { expect(resolver).toHaveBeenCalledTimes(1); expect(result.headSha).toBe(preservedHead); }
        else expect(resolver).toHaveBeenCalledTimes(2);
        expect(pushAttempts).toBe(mode === "push-failed" ? 2 : 1);
        expect(JSON.parse(await readFile(join(f.runtimeDir, journalName), "utf8"))).toMatchObject({ phase: "cleaned", resultSha: result.headSha, failure: null, cleanup: null });
        await expect(readFile(join(isolated, "change.ts"))).rejects.toThrow();
      }
    }
    expect(calls.some((args) => args.includes("rebase") || args.includes("--force") || args[0] === "kill")).toBe(false);
  });
  it("posts the fresh integration review on its exact head and reconciles a lost delivery without rerunning the reviewer", async () => {
    const f = await fixture(); await f.github.ensureRetroPr("test/project", goal, content);
    f.shell.loseReview = true;
    const review = vi.fn(async (cwd: string) => {
      expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(f.shell.head());
      return { summary: "Blocking defect", findings: [{ path, line: 1, reason: "Incorrect result" }] };
    });
    await f.github.reviewIntegration("test/project", goal, url, f.shell.head(), review);
    await f.github.reviewIntegration("test/project", goal, url, f.shell.head(), review);
    expect(review).toHaveBeenCalledTimes(1);
    expect(f.shell.reviews).toHaveLength(1);
    expect(f.shell.reviews[0]).toMatchObject({ state: "CHANGES_REQUESTED", commit_id: f.shell.head(), comments: [{ path, line: 1, side: "RIGHT", body: "Incorrect result" }] });
    expect(f.shell.reviews[0].body).toContain("indra-integration-review:");
    expect(f.shell.calls.some((call) => call.args.includes("merge"))).toBe(false);
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
