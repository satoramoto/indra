import type { Shell } from "./developer-seat.js";
import type { PlanningStore } from "./planning.js";
import { inspectReview, postReviewComment, reviewOnce } from "./review-evidence.js";

export interface LineFinding { path: string; line: number; side: "RIGHT"; body: string }
/** Kept separately from the mutable assignment step, including after worktree cleanup. */
export interface SavedReview {
  id: string; findings: string[]; body: string; posted: boolean;
  headSha: string; verdict: "APPROVE" | "REQUEST_CHANGES"; comments: LineFinding[];
}
export interface DeveloperReviewOptions {
  store: Pick<PlanningStore, "runtimeDir">;
  recordName: string; prUrl: string; worktree: string; shell: Shell;
  /** Always a fresh context. Only host-owned proof for this exact PR/head can skip it. */
  review: () => Promise<unknown>;
  onReview?: (review: SavedReview) => Promise<void>;
}
function finding(text: string): { path: string; line: number; reason: string } {
  const match = /^([^\s:]+):(\d+):\s*(\S.*)$/.exec(text);
  if (!match) throw new Error("Reviewer findings must use path:line: reason for a changed line.");
  return { path: match[1], line: Number(match[2]), reason: match[3] };
}
export async function reviewHead(shell: Shell, prUrl: string, cwd: string): Promise<string> {
  const head = await shell.run("gh", ["pr", "view", prUrl, "--json", "headRefOid", "--jq", ".headRefOid"], cwd);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error("Could not read the PR head for review.");
  return head.stdout.trim();
}

export async function postReviewOnce(options: DeveloperReviewOptions): Promise<string[]> {
  const { store, prUrl, worktree, shell, review } = options;
  const headSha = await reviewHead(shell, prUrl, worktree);
  const evidence = await reviewOnce(store.runtimeDir, prUrl, headSha, async () => {
    const local = await shell.run("git", ["rev-parse", "HEAD"], worktree);
    if (local.code !== 0 || local.stdout.trim() !== headSha) throw new Error("The review worktree does not match the PR head.");
    const result = await review() as { findings?: unknown; summary?: unknown } | undefined;
    if (!Array.isArray(result?.findings) || result.findings.some((item) => typeof item !== "string")) throw new Error("Reviewer session returned invalid findings.");
    return { summary: result.summary, findings: (result.findings as string[]).map((item) => finding(item.trim())) };
  }, async () => { if (await reviewHead(shell, prUrl, worktree) !== headSha) throw new Error("The PR head changed during review."); }, async (proof) => { await postReviewComment(shell, worktree, proof); });
  const saved: SavedReview = { id: evidence.id, headSha, verdict: evidence.verdict, findings: evidence.findings.map((item) => `${item.path}:${item.line}: ${item.reason}`),
    body: evidence.summary, posted: evidence.posted, comments: evidence.findings.map((item) => ({ path: item.path, line: item.line, side: "RIGHT", body: item.reason })) };
  await options.onReview?.(saved);
  return [...saved.findings];
}

export async function requireApprovedReview(shell: Shell, prUrl: string, cwd: string, runtimeDir: string): Promise<string> {
  const head = await reviewHead(shell, prUrl, cwd);
  if (!(await inspectReview(runtimeDir, shell, cwd, prUrl, head)).reviewed) throw new Error("The current PR head requires an approved review with addressed findings.");
  if (await reviewHead(shell, prUrl, cwd) !== head) throw new Error("The PR head changed during review verification.");
  return head;
}
