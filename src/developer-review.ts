import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shell } from "./command-shell.js";
import { REVIEW_ACCOUNT, runGh, runGit } from "./git-gh.js";
import type { PlanningStore } from "./planning.js";
import { redactSecrets } from "./redact.js";

export { REVIEW_ACCOUNT } from "./git-gh.js";
export interface LineFinding { path: string; line: number; side: "RIGHT"; body: string }
/** Kept separately from the mutable assignment step, including after worktree cleanup. */
export interface SavedReview {
  id: string; findings: string[]; body: string; posted: boolean;
  headSha: string; verdict: "APPROVE" | "REQUEST_CHANGES"; comments: LineFinding[];
}
export interface DeveloperReviewOptions {
  store: Pick<PlanningStore, "readRuntimeFile" | "saveRuntime">;
  recordName: string; prUrl: string; worktree: string; shell: Shell;
  /** Always a fresh context. Only a saved review of this exact commit can skip it. */
  review: () => Promise<unknown>;
  /** Persist the evidence before delivery or advancing the assignment. */
  onReview?: (review: SavedReview) => Promise<void>;
}

function finding(text: string): LineFinding {
  const match = /^([^\s:]+):(\d+):\s*(\S.*)$/.exec(text);
  if (!match || match[1].startsWith("/") || match[1].split("/").includes("..") || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
    throw new Error("Reviewer findings must use path:line: reason for a changed line.");
  }
  return { path: match[1], line: Number(match[2]), side: "RIGHT", body: match[3] };
}
const endpoint = (prUrl: string) => {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(prUrl);
  if (!match) throw new Error("Review requires a GitHub pull request URL.");
  return `repos/${match[1]}/${match[2]}/pulls/${match[3]}/reviews`;
};

export async function reviewHead(shell: Shell, prUrl: string, cwd: string): Promise<string> {
  const head = await runGh(shell, ["pr", "view", prUrl, "--json", "headRefOid", "--jq", ".headRefOid"], cwd);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error("Could not read the PR head for review.");
  return head.stdout.trim();
}

/** Atomic line comments plus APPROVE/REQUEST_CHANGES, the same verdicts as gh pr review. */
export async function postReviewOnce(options: DeveloperReviewOptions): Promise<string[]> {
  const { store, recordName, prUrl, worktree, shell, review } = options;
  const url = endpoint(prUrl);
  const headSha = await reviewHead(shell, prUrl, worktree);
  const id = createHash("sha256").update(JSON.stringify([recordName, prUrl, headSha])).digest("hex");
  const name = `developer-review-${id}`;
  const marker = `<!-- indra-review:${id} -->`;
  let saved = await store.readRuntimeFile<SavedReview>(name);
  if (!saved) {
    const local = await runGit(shell, ["rev-parse", "HEAD"], worktree);
    if (local.code !== 0 || local.stdout.trim() !== headSha) throw new Error("The review worktree does not match the PR head.");
    const response = await review() as { findings?: unknown; summary?: unknown } | undefined;
    if (!Array.isArray(response?.findings) || response.findings.some((item) => typeof item !== "string")) throw new Error("Reviewer session returned invalid findings.");
    const findings = (response.findings as string[]).map((item) => redactSecrets(item.trim())).filter(Boolean);
    const summary = typeof response.summary === "string" && response.summary.trim() ? redactSecrets(response.summary.trim()) : "done";
    saved = { id, headSha, findings, verdict: findings.length ? "REQUEST_CHANGES" : "APPROVE", comments: findings.map(finding), body: `**Indra review:** ${summary}\n\n${marker}`, posted: false };
    await store.saveRuntime(name, saved);
  }
  await options.onReview?.(saved);
  if (!saved.posted) {
    const account = await runGh(shell, ["api", "user", "--jq", ".login"], worktree, "reviewer");
    if (account.code !== 0 || account.stdout.trim() !== REVIEW_ACCOUNT) throw new Error("The designated review account is unavailable.");
    const reviews = await readReviews(shell, url, worktree);
    const verdict = saved.verdict;
    const exists = reviews.some((item) => item.user?.login === REVIEW_ACCOUNT && item.commit_id === headSha
      && item.state === (verdict === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED") && item.body?.trimEnd().endsWith(`\n\n${marker}`));
    if (!exists) {
      if (await reviewHead(shell, prUrl, worktree) !== headSha) throw new Error("The PR head changed during review.");
      const dir = await mkdtemp(join(tmpdir(), "indra-review-"));
      try {
        const file = join(dir, "review.json");
        await writeFile(file, JSON.stringify({ commit_id: headSha, event: saved.verdict, body: saved.body, comments: saved.comments }), { mode: 0o600 });
        const posted = await runGh(shell, ["api", url, "--method", "POST", "--input", file], worktree, "reviewer");
        if (posted.code !== 0) throw new Error("Could not post the PR review and line findings.");
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    saved = { ...saved, posted: true };
    await store.saveRuntime(name, saved);
  }
  return [...saved.findings];
}

type GitHubReview = { body?: string; state?: string; commit_id?: string; user?: { login?: string } };
async function readReviews(shell: Shell, url: string, cwd: string): Promise<GitHubReview[]> {
  const result = await runGh(shell, ["api", `${url}?per_page=100`, "--method", "GET", "--paginate", "--slurp"], cwd, "reviewer");
  if (result.code !== 0) throw new Error("Could not reconcile PR reviews.");
  let pages: unknown;
  try { pages = JSON.parse(result.stdout); } catch { throw new Error("GitHub returned invalid PR reviews."); }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page) || page.some((item) => !item || typeof item !== "object"))) throw new Error("GitHub returned invalid PR reviews.");
  return pages.flat();
}

/** An old approval, dismissed verdict, or a successful fix session alone cannot authorize a merge. */
export async function requireApprovedReview(shell: Shell, prUrl: string, cwd: string): Promise<string> {
  const head = await reviewHead(shell, prUrl, cwd);
  const reviews = await readReviews(shell, endpoint(prUrl), cwd);
  const verdicts = new Map<string, string | undefined>();
  for (const item of reviews) if (item.user?.login && item.state !== "COMMENTED" && item.state !== "PENDING") verdicts.set(item.user.login, item.state);
  if ([...verdicts.values()].includes("CHANGES_REQUESTED")) throw new Error("The current PR head requires an approved review with addressed findings.");
  const latest = reviews.filter((item) => item.user?.login === REVIEW_ACCOUNT && item.state !== "COMMENTED" && item.state !== "PENDING").at(-1);
  if (latest?.state !== "APPROVED" || latest.commit_id !== head) throw new Error("The current PR head requires an approved review with addressed findings.");
  return head;
}
