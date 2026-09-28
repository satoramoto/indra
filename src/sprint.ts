import { dirname, join } from "node:path";
import { stderrExcerpt, type Shell, type ShellResult } from "./developer-seat.js";
import { ensureProjectCheckout } from "./project-checkout.js";

/** A sprint GitHub problem whose message is ours and safe to post in the goal thread. */
export class SprintError extends Error { override name = "SprintError"; }

export const sprintBranch = (goalId: string) => `sprint/${goalId}`;
export const revertBranch = (goalId: string) => `revert/${goalId}`;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{40}$/;
// gh supplies the credential for one command; Git's configuration is never changed.
const GH_CREDENTIAL = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string };

/**
 * The GitHub side of a sprint: its integration branch, the one PR from it into main, merging a PR once CI is green,
 * and a revert PR on main. Every call is safe to repeat: it finds what an earlier call made before making anything.
 */
export class SprintGitHub {
  constructor(private readonly shell: Shell, private readonly runtimeDir: string) {}

  /** gh with explicit repositories and URLs, run beside the state checkout so no local repository is involved. */
  private async run(command: string, args: string[], cwd = dirname(this.runtimeDir)): Promise<ShellResult> { return await this.shell.run(command, args, cwd); }
  private async must(command: string, args: string[], cwd?: string): Promise<ShellResult> {
    const result = await this.run(command, args, cwd);
    if (result.code !== 0) throw new SprintError(`${command} ${args.slice(0, 2).join(" ")} failed: ${stderrExcerpt(result.stderr)}`);
    return result;
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

  private async view(prUrl: string): Promise<{ state: string; sha?: string }> {
    const view = await this.must("gh", ["pr", "view", prUrl, "--json", "state,mergeCommit"]);
    try {
      const parsed = JSON.parse(view.stdout) as { state?: unknown; mergeCommit?: { oid?: unknown } | null };
      const sha = typeof parsed.mergeCommit?.oid === "string" && SHA.test(parsed.mergeCommit.oid) ? parsed.mergeCommit.oid : undefined;
      return { state: typeof parsed.state === "string" ? parsed.state : "UNKNOWN", ...(sha ? { sha } : {}) };
    } catch { throw new SprintError(`gh pr view returned nothing readable for ${prUrl}.`); }
  }

  /**
   * Squash-merges the PR once its CI is green, by URL. The PR's state is the success signal, not gh's exit code;
   * a PR that already merged returns its merge commit without merging again.
   */
  async merge(prUrl: string): Promise<MergeResult> {
    const before = await this.view(prUrl);
    if (before.state === "MERGED" && before.sha) return { merged: true, sha: before.sha };
    if (before.state !== "OPEN") return { merged: false, reason: `${prUrl} is ${before.state.toLowerCase()}` };
    const checks = await this.run("gh", ["pr", "checks", prUrl]);
    if (checks.code !== 0) return { merged: false, reason: `CI on ${prUrl} is not green yet` };
    const merged = await this.run("gh", ["pr", "merge", prUrl, "--squash"]);
    const after = await this.view(prUrl);
    if (after.state === "MERGED" && after.sha) return { merged: true, sha: after.sha };
    return { merged: false, reason: `gh pr merge failed: ${stderrExcerpt(merged.stderr)}` };
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
