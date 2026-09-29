import { dirname, join } from "node:path";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { runChecked, stderrExcerpt, type Shell, type ShellResult } from "./command-shell.js";
import { ensureProjectCheckout } from "./project-checkout.js";
import { withFileLock } from "./state-commit.js";
import { GITHUB_REPO } from "./local-state.js";
import { homedir } from "node:os";
import { redactSecrets } from "./redact.js";
import type { MergeVerification } from "./ceremony.js";

/** A sprint GitHub problem whose message is ours and safe to post in the goal thread. */
export class SprintError extends Error { override name = "SprintError"; }

export const sprintBranch = (goalId: string) => `sprint/${goalId}`;
export const revertBranch = (goalId: string) => `revert/${goalId}`;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{40}$/;
// gh supplies the credential for one command; Git's configuration is never changed.
const GH_CREDENTIAL = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string };

export function retroPath(goalId: string): string {
  if (!/^[a-z][a-z0-9-]+$/.test(goalId)) throw new SprintError("Invalid retrospective goal ID.");
  return `docs/retros/${goalId}.md`;
}
export const retroBranch = (goalId: string) => { retroPath(goalId); return `retro/${goalId}`; };
export interface RetroPr {
  url: string; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; mergedSha?: string;
  /** A fresh approval from the review account on this exact head, with no outstanding change requests. */
  reviewed: boolean; checksPassed: boolean;
}
export interface RetroReview {
  summary: string;
  findings: { path: string; line: number; reason: string }[];
}
export interface RetroArchive {
  ensureRetroPr(github: string, goalId: string, markdown: string): Promise<string>;
  inspectRetroPr(github: string, goalId: string, markdown: string, prUrl: string): Promise<RetroPr>;
  reviewRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string, review: (worktree: string) => Promise<RetroReview>): Promise<void>;
  mergeRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string): Promise<MergeResult>;
}

/**
 * The GitHub side of a sprint: its integration branch, the one PR from it into main, merging a PR once CI is green,
 * and a revert PR on main. Every call is safe to repeat: it finds what an earlier call made before making anything.
 */
export class SprintGitHub implements RetroArchive {
  constructor(private readonly shell: Shell, private readonly runtimeDir: string) {}

  /** gh with explicit repositories and URLs, run beside the state checkout so no local repository is involved. */
  private async run(command: string, args: string[], cwd = dirname(this.runtimeDir)): Promise<ShellResult> { return await this.shell.run(command, args, cwd); }
  private async must(command: string, args: string[], cwd = dirname(this.runtimeDir)): Promise<ShellResult> {
    return await runChecked(this.shell, command, args, cwd, (result) => new SprintError(`${command} ${args.slice(0, 2).join(" ")} failed: ${stderrExcerpt(result.stderr)}`));
  }

  /** Creates `sprint/<goal-id>` on GitHub from main's current head unless it exists; returns the branch's head. */
  async ensureBranch(github: string, goalId: string): Promise<string> {
    const head = async () => {
      const found = await this.run("gh", ["api", `repos/${github}/git/ref/heads/${sprintBranch(goalId)}`, "--jq", ".object.sha"]);
      return found.code === 0 && SHA.test(found.stdout.trim()) ? found.stdout.trim() : undefined;
    };
    const existing = await head();
    if (existing) return existing;
    const main = (await this.must("gh", ["api", `repos/${github}/git/ref/heads/main`, "--jq", ".object.sha"])).stdout.trim();
    if (!SHA.test(main)) throw new SprintError(`GitHub returned no commit for main on ${github}.`);
    const created = await this.run("gh", ["api", "-X", "POST", `repos/${github}/git/refs`, "-f", `ref=refs/heads/${sprintBranch(goalId)}`, "-f", `sha=${main}`]);
    if (created.code === 0) return main;
    // Another process may have created it between the check and the POST.
    const raced = await head();
    if (raced) return raced;
    throw new SprintError(`Could not create ${sprintBranch(goalId)} on ${github}: ${stderrExcerpt(created.stderr)}`);
  }

  /** The open PR from `head` into main, opened now if there is none. */
  async openPr(github: string, head: string, title: string, body: string): Promise<string> {
    const found = (await this.must("gh", ["pr", "list", "--repo", github, "--head", head, "--base", "main", "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""])).stdout.trim();
    if (PR_URL.test(found)) return found;
    const created = (await this.must("gh", ["pr", "create", "--repo", github, "--base", "main", "--head", head, "--title", title, "--body", body])).stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!PR_URL.test(created)) throw new SprintError(`gh pr create returned no PR URL for ${head}.`);
    return created;
  }

  /** Observe one PR head with its latest bot verdict and every required check. */
  async inspectMerge(prUrl: string): Promise<RetroPr> {
    if (!PR_URL.test(prUrl)) throw new SprintError("Invalid sprint PR URL.");
    const github = prUrl.split("/").slice(3, 5).join("/"); const number = prUrl.split("/").at(-1)!;
    const read = async () => {
      const response = await this.must("gh", ["pr", "view", prUrl, "--json", "state,mergeCommit,headRefOid,isDraft,author,reviewDecision"]);
      try { return JSON.parse(response.stdout) as { state: RetroPr["state"]; mergeCommit?: { oid: string }; headRefOid: string; isDraft: boolean; author: { login: string }; reviewDecision?: string }; }
      catch { throw new SprintError("Unreadable sprint PR details."); }
    };
    const before = await read();
    if (!SHA.test(before.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(before.state) || !before.author?.login || typeof before.isDraft !== "boolean") throw new SprintError("Unverified sprint PR head or author.");
    const reviews = await this.retroPages<{ id: number; user: { login: string }; state: string; commit_id: string }>(`repos/${github}/pulls/${number}/reviews?per_page=100`);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of reviews.sort((a, b) => a.id - b.id)) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user?.login, review);
    const bot = latest.get("satori-miyamoto");
    const reviewed = !before.isDraft && before.author.login !== "satori-miyamoto" && before.reviewDecision !== "CHANGES_REQUESTED" && ![...latest.values()].some((review) => review.state === "CHANGES_REQUESTED") && bot?.state === "APPROVED" && bot.commit_id === before.headRefOid;
    const checks = await this.run("gh", ["pr", "checks", prUrl, "--json", "name,bucket"]);
    let checksPassed = false;
    try {
      const rows = JSON.parse(checks.stdout) as { name: string; bucket: string }[];
      checksPassed = checks.code === 0 && Array.isArray(rows) && rows.some((row) => row.name === "checks") && rows.every((row) => row.bucket === "pass");
    } catch { /* Missing check evidence is pending. */ }
    if (JSON.stringify(before) !== JSON.stringify(await read())) throw new SprintError("Sprint PR changed during verification.");
    return { url: prUrl, state: before.state, headSha: before.headRefOid, reviewed, checksPassed,
      ...(SHA.test(before.mergeCommit?.oid ?? "") ? { mergedSha: before.mergeCommit!.oid } : {}) };
  }

  /** Current-head bot approval and green CI gate release; a request alone never proves a merge. */
  async merge(prUrl: string): Promise<MergeResult> {
    const before = await this.inspectMerge(prUrl);
    if (!before.reviewed || !before.checksPassed) return { merged: false, reason: `Current-head satori-miyamoto approval and passing CI are required on ${prUrl}` };
    if (before.state === "MERGED" && before.mergedSha) return { merged: true, sha: before.mergedSha };
    if (before.state !== "OPEN") return { merged: false, reason: `${prUrl} is ${before.state.toLowerCase()}` };
    let verified = false;
    try {
      await this.run("gh", ["pr", "merge", prUrl, "--auto", "--squash", "--match-head-commit", before.headSha]);
      const after = await this.inspectMerge(prUrl);
      if (after.state === "MERGED" && after.mergedSha && after.headSha === before.headSha && after.reviewed && after.checksPassed) {
        verified = true; return { merged: true, sha: after.mergedSha };
      }
    } finally {
      // Also cancel after a lost command response; an unverified future head must not remain armed.
      if (!verified) await this.must("gh", ["pr", "merge", prUrl, "--disable-auto"]);
    }
    return { merged: false, reason: "Auto-merge requested but no reviewed merge verified; wait for the next workflow event." };
  }

  async mergeVerification(prUrl: string): Promise<MergeVerification | undefined> {
    const proof = await this.inspectMerge(prUrl);
    return proof.state === "MERGED" && proof.mergedSha && proof.reviewed && proof.checksPassed
      ? { headSha: proof.headSha, reviewCommitSha: proof.headSha, reviewer: "satori-miyamoto", checksPassed: true } : undefined;
  }

  private retroRepo(github: string, goalId: string, prUrl?: string): string {
    retroPath(goalId);
    if (!GITHUB_REPO.test(github)) throw new SprintError("Invalid retrospective project.");
    if (prUrl && (!PR_URL.test(prUrl) || !prUrl.startsWith(`https://github.com/${github}/pull/`))) throw new SprintError("Retrospective PR is outside the team's project.");
    return `repos/${github}/pulls${prUrl ? `/${prUrl.split("/").at(-1)}` : ""}`;
  }

  /** Paginate every recovery query; an unreadable response never means 'nothing exists'. */
  private async retroPages<T>(endpoint: string): Promise<T[]> {
    const result = await this.run("gh", ["api", endpoint, "--method", "GET", "--paginate", "--slurp"]);
    if (result.code !== 0) throw new SprintError("Could not read retrospective PR history.");
    try {
      const pages = JSON.parse(result.stdout) as T[][];
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error();
      return pages.flat();
    } catch { throw new SprintError("Invalid retrospective PR history."); }
  }

  private async findRetroPr(github: string, goalId: string): Promise<string | undefined> {
    const endpoint = this.retroRepo(github, goalId);
    const prs = await this.retroPages<{ html_url: string }>(`${endpoint}?state=all&head=${github.split("/")[0]}:${retroBranch(goalId)}&base=main&per_page=100`);
    if (prs.length > 1) throw new SprintError("Multiple retrospective PRs require owner reconciliation.");
    if (!prs.length) return;
    this.retroRepo(github, goalId, prs[0].html_url);
    if (!prs[0].html_url) throw new SprintError("Invalid retrospective PR URL.");
    return prs[0].html_url;
  }

  private async retroCheckout(github: string): Promise<string> {
    const project = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
    const remote = (await this.must("git", ["remote", "get-url", "origin"], project)).stdout.trim();
    if (![ `https://github.com/${github}`, `https://github.com/${github}.git`, `git@github.com:${github}.git`, `ssh://git@github.com/${github}.git` ].includes(remote)) throw new SprintError("Retrospective checkout does not belong to the team's project.");
    return project;
  }

  private async retroTree(project: string, from: string, to: string, path: string, markdown: string): Promise<void> {
    const changed = (await this.must("git", ["diff", "--name-only", "-z", from, to, "--"], project)).stdout;
    const mode = (await this.must("git", ["ls-tree", to, "--", path], project)).stdout;
    const content = await this.must("git", ["show", `${to}:${path}`], project);
    if (changed !== `${path}\0` || !mode.startsWith("100644 blob ") || content.stdout !== markdown) throw new SprintError("Retrospective PR must change only its goal's regular document, with exactly the frozen content.");
  }

  /** Reuses branches and PRs, including closed/merged PRs. Never replaces a rejected archive or force-pushes. */
  async ensureRetroPr(github: string, goalId: string, markdown: string): Promise<string> {
    this.retroRepo(github, goalId);
    if (!markdown.trim()) throw new SprintError("An empty retrospective cannot be archived.");
    return await withFileLock(join(this.runtimeDir, `retro-git-${goalId}.lock`), async () => {
      const found = await this.findRetroPr(github, goalId);
      if (found) return found;
      const project = await this.retroCheckout(github);
      const branch = retroBranch(goalId); const path = retroPath(goalId);
      const remote = await this.run("git", [...GH_CREDENTIAL, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], project);
      if (remote.code !== 0 && remote.code !== 2) throw new SprintError("Could not inspect the retrospective branch.");
      if (remote.code === 0) {
        const sha = remote.stdout.split(/\s/)[0];
        if (!SHA.test(sha)) throw new SprintError("Invalid retrospective branch head.");
        await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", sha], project);
        const base = (await this.must("git", ["merge-base", "origin/main", sha], project)).stdout.trim();
        await this.retroTree(project, base, sha, path, markdown);
      } else {
        const worktrees = join(this.runtimeDir, "worktrees");
        await mkdir(worktrees, { recursive: true, mode: 0o700 });
        const temp = await mkdtemp(join(worktrees, `retro-${goalId}-`));
        const worktree = join(temp, "checkout");
        try {
          await this.must("git", ["worktree", "add", "--detach", worktree, "origin/main"], project);
          // Reject tracked symlinks before touching any document path.
          for (const directory of [join(worktree, "docs"), join(worktree, "docs/retros")]) {
            const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
            if (entry && !entry.isDirectory()) throw new SprintError("Retrospective directories must be real directories.");
            if (!entry) await mkdir(directory);
          }
          await writeFile(join(worktree, path), markdown, { flag: "wx", mode: 0o644 });
          await this.must("git", ["add", "--", path], worktree);
          await this.must("git", ["commit", "--only", "-m", `Archive retrospective for ${goalId}`, "--", path], worktree);
          await this.retroTree(worktree, "HEAD^", "HEAD", path, markdown);
          const pushed = await this.run("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], worktree);
          if (pushed.code !== 0) throw new SprintError("Retrospective push was not confirmed; reconcile the branch on retry.");
        } finally {
          const removed = await this.run("git", ["worktree", "remove", "--force", worktree], project);
          if (removed.code === 0) await rm(temp, { recursive: true, force: true });
        }
      }
      // The body is a file, never document text in command arguments.
      const temp = await mkdtemp(join(this.runtimeDir, "retro-pr-"));
      try {
        const body = join(temp, "body.md");
        await writeFile(body, `Archives the frozen retrospective for ${goalId} in ${path}.\n\nOnly this document may change. Requires a fresh satori-miyamoto review on the current head, passing CI. No further human approval is needed. Process suggestions are owner proposals only.\n`, { mode: 0o600 });
        const created = await this.run("gh", ["pr", "create", "--repo", github, "--base", "main", "--head", branch, "--title", `Archive retrospective for ${goalId}`, "--body-file", body]);
        const recovered = await this.findRetroPr(github, goalId);
        if (recovered) return recovered;
        throw new SprintError(created.code === 0 ? "Retrospective PR is not visible yet; retry reconciliation." : "Retrospective PR creation was not confirmed; retry reconciliation.");
      } finally { await rm(temp, { recursive: true, force: true }); }
    });
  }

  /** Check the exact PR head, every changed path, document bytes, review and CI again, even after a restart. */
  async inspectRetroPr(github: string, goalId: string, markdown: string, prUrl: string): Promise<RetroPr> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    const read = async () => {
      const result = await this.run("gh", ["pr", "view", prUrl, "--json", "state,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,author,mergeCommit,reviewDecision"]);
      if (result.code !== 0) throw new SprintError("Could not inspect the retrospective PR.");
      try { return JSON.parse(result.stdout) as { state: RetroPr["state"]; headRefName: string; baseRefName: string; headRefOid: string; isCrossRepository: boolean; isDraft: boolean; author: { login: string }; mergeCommit?: { oid: string }; reviewDecision?: string }; }
      catch { throw new SprintError("Invalid retrospective PR details."); }
    };
    const pr = await read();
    if (pr.baseRefName !== "main" || pr.headRefName !== retroBranch(goalId) || pr.isCrossRepository !== false || !SHA.test(pr.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || !pr.author?.login) throw new SprintError("Retrospective PR does not match this goal's archive branch and project.");
    const path = retroPath(goalId);
    const files = await this.retroPages<{ filename: string; status: string; previous_filename?: string }>(`${endpoint}/files?per_page=100`);
    if (files.length !== 1 || files[0].filename !== path || !["added", "modified"].includes(files[0].status) || files[0].previous_filename) throw new SprintError("Retrospective PR may change only its goal's document.");
    const project = await this.retroCheckout(github);
    await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", `refs/pull/${prUrl.split("/").at(-1)}/head`], project);
    const mode = (await this.must("git", ["ls-tree", pr.headRefOid, "--", path], project)).stdout;
    const content = (await this.must("git", ["show", `${pr.headRefOid}:${path}`], project)).stdout;
    if (!mode.startsWith("100644 blob ") || content !== markdown) throw new SprintError("Retrospective head differs from the frozen document.");
    if (pr.state === "MERGED") {
      if (!SHA.test(pr.mergeCommit?.oid ?? "")) throw new SprintError("Retrospective merge commit is unverified.");
      await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", pr.mergeCommit!.oid], project);
      await this.must("git", ["merge-base", "--is-ancestor", pr.mergeCommit!.oid, "origin/main"], project);
      await this.retroTree(project, `${pr.mergeCommit!.oid}^`, pr.mergeCommit!.oid, path, markdown);
    }
    const reviews = await this.retroPages<{ id: number; user: { login: string }; state: string; commit_id: string }>(`${endpoint}/reviews?per_page=100`);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of reviews.sort((a, b) => a.id - b.id)) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user?.login, review);
    const approved = latest.get("satori-miyamoto");
    const reviewed = pr.author.login !== "satori-miyamoto" && pr.reviewDecision !== "CHANGES_REQUESTED" && ![...latest.values()].some((review) => review.state === "CHANGES_REQUESTED") && approved?.state === "APPROVED" && approved.commit_id === pr.headRefOid;
    const checks = await this.run("gh", ["pr", "checks", prUrl, "--json", "name,bucket"]);
    let checksPassed = false;
    try {
      const rows = JSON.parse(checks.stdout) as { name: string; bucket: string }[];
      checksPassed = checks.code === 0 && Array.isArray(rows) && rows.some((row) => row.name === "checks") && rows.every((row) => row.bucket === "pass");
    } catch { /* Missing/unreadable CI is pending. */ }
    const after = await read();
    if (JSON.stringify(after) !== JSON.stringify(pr)) throw new SprintError("Retrospective PR changed during verification; retry.");
    return { url: prUrl, state: pr.state, headSha: pr.headRefOid, mergedSha: pr.mergeCommit?.oid, reviewed: reviewed && !pr.isDraft, checksPassed };
  }

  /** A fresh read-only reviewer sees the pinned checkout; the host posts its line comments and verdict. */
  async reviewRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string, review: (worktree: string) => Promise<RetroReview>): Promise<void> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid retrospective review head.");
    await withFileLock(join(this.runtimeDir, `retro-review-${goalId}.lock`), async () => {
      const marker = `<!-- indra-retro-review:${goalId}:${headSha} -->`;
      const reconciled = async () => (await this.retroPages<{ user: { login: string }; commit_id: string; body: string; state: string }>(`${endpoint}/reviews?per_page=100`))
        .some((item) => item.user?.login === "satori-miyamoto" && item.commit_id === headSha && item.body?.trimEnd().endsWith(marker)
          && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state));
      if (await reconciled()) return;
      const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
      if (before.state !== "OPEN" || before.headSha !== headSha) throw new SprintError("Retrospective PR changed before review.");
      const reviewCommand = async (args: string[]) => await this.run("env", [`GH_CONFIG_DIR=${join(homedir(), ".config/gh-yahaha-bot")}`, "gh", ...args]);
      const account = await reviewCommand(["api", "user", "--jq", ".login"]);
      if (account.code !== 0 || account.stdout.trim() !== "satori-miyamoto") throw new SprintError("Retrospective review requires the satori-miyamoto account.");
      const project = await this.retroCheckout(github);
      const worktrees = join(this.runtimeDir, "worktrees");
      await mkdir(worktrees, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(worktrees, `retro-review-${goalId}-`));
      const worktree = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", worktree, headSha], project);
        const result = await review(worktree);
        if (typeof result?.summary !== "string" || !Array.isArray(result.findings) || result.findings.some((item) => item.path !== retroPath(goalId)
          || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > markdown.split("\n").length || typeof item.reason !== "string" || !item.reason.trim())) throw new SprintError("Invalid retrospective review findings.");
        const current = await this.inspectRetroPr(github, goalId, markdown, prUrl);
        if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Retrospective PR changed during review.");
        if (await reconciled()) return;
        const input = join(temp, "review.json");
        await writeFile(input, JSON.stringify({ commit_id: headSha, event: result.findings.length ? "REQUEST_CHANGES" : "APPROVE",
          body: `${redactSecrets(result.summary)}\n\n${marker}`,
          comments: result.findings.map((item) => ({ path: item.path, line: item.line, side: "RIGHT", body: redactSecrets(item.reason) })),
        }), { mode: 0o600 });
        await reviewCommand(["api", endpoint + "/reviews", "--method", "POST", "--input", input]);
        // A lost response is success only when GitHub contains our submitted verdict at this head.
        if (!await reconciled()) throw new SprintError("Retrospective review delivery is not confirmed; retry reconciliation.");
      } finally {
        const removed = await this.run("git", ["worktree", "remove", "--force", worktree], project);
        if (removed.code === 0) await rm(temp, { recursive: true, force: true });
      }
    });
  }

  /** The publication adapter verifies delivery before this exact-head bot/CI gate. */
  async mergeRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string): Promise<MergeResult> {
    const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
    if (before.headSha !== headSha || !before.reviewed || !before.checksPassed) return { merged: false, reason: "The archive needs a current-head review and passing CI." };
    if (before.state === "MERGED" && before.mergedSha) return { merged: true, sha: before.mergedSha };
    if (before.state !== "OPEN") return { merged: false, reason: "The retrospective PR is closed without a merge." };
    let verified = false;
    try {
      await this.run("gh", ["pr", "merge", prUrl, "--auto", "--squash", "--match-head-commit", headSha]);
      const after = await this.inspectRetroPr(github, goalId, markdown, prUrl);
      if (after.state === "MERGED" && after.mergedSha && after.headSha === headSha && after.reviewed && after.checksPassed) {
        verified = true; return { merged: true, sha: after.mergedSha };
      }
    } finally { if (!verified) await this.must("gh", ["pr", "merge", prUrl, "--disable-auto"]); }
    return { merged: false, reason: "Retrospective merge is not verified; wait for the next workflow event." };
  }

  /**
   * Opens a PR on main that reverts `mergedSha`, made in a worktree of Indra's own project clone on branch
   * `revert/<goal-id>`. An open revert PR from an earlier call is returned instead.
   */
  async revertPr(github: string, goalId: string, mergedSha: string, title: string, body: string): Promise<string> {
    const branch = revertBranch(goalId);
    const open = (await this.must("gh", ["pr", "list", "--repo", github, "--head", branch, "--base", "main", "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""])).stdout.trim();
    if (PR_URL.test(open)) return open;
    const project = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
    const worktree = join(this.runtimeDir, "worktrees", `revert-${goalId}`);
    // Leftovers of an attempt that stopped before its PR opened; nothing else uses this branch.
    await this.run("git", ["worktree", "remove", "--force", worktree], project);
    await this.run("git", ["branch", "-D", branch], project);
    await this.run("gh", ["api", "-X", "DELETE", `repos/${github}/git/refs/heads/${branch}`]);
    try {
      await this.must("git", ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/main"], project);
      await this.must("git", ["revert", "--no-edit", mergedSha], worktree);
      await this.must("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], worktree);
      return await this.openPr(github, branch, title, body);
    } finally {
      await this.run("git", ["worktree", "remove", "--force", worktree], project);
    }
  }
}
