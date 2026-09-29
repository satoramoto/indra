import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { processShell, type Shell } from "./command-shell.js";
import { runGh, runGit, REVIEW_ACCOUNT } from "./git-gh.js";
import { ensureProjectCheckout } from "./project-checkout.js";
import { postReviewOnce } from "./developer-review.js";
import { withFileLock } from "./state-commit.js";
import { requireTeamHome } from "./planning.js";
import type { CeremonyContext } from "./planning-bridge.js";
import { loadSeatEngines, SeatRuntime } from "./seat-runtime.js";
import { seatHarnessDir } from "./harness-home.js";
import { schemaPathOf } from "./reload.js";
import { AgentRunError } from "./runtime-facts.js";

export interface ReviewedPr {
  url: string; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; mergedSha?: string;
  reviewed: boolean; checksPassed: boolean;
  /** Undefined means GitHub has not computed mergeability. */
  conflicting?: boolean;
}
export interface PrReview { id: number; user: { login: string }; state: string; commit_id: string }
export function currentHeadApproved(reviews: PrReview[], head: string, author: string, decision?: string): boolean {
  const latest = new Map<string, PrReview>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (!Number.isSafeInteger(review.id) || !review.user?.login) return false;
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.login, review);
  }
  const approved = latest.get(REVIEW_ACCOUNT);
  return author !== REVIEW_ACCOUNT && !["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(decision ?? "")
    && ![...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")
    && approved?.state === "APPROVED" && approved.commit_id === head;
}
export function passingChecks(result: { code: number; stdout: string }): boolean {
  try {
    const rows: unknown = JSON.parse(result.stdout);
    return result.code === 0 && Array.isArray(rows) && rows.some((row) => row?.name === "checks")
      && rows.every((row) => typeof row?.name === "string" && row.bucket === "pass");
  } catch { return false; }
}

/** Read the head before and after its review and CI. Missing or moving evidence cannot authorize a merge. */
export async function inspectReviewedPr(shell: Shell, cwd: string, github: string, branch: string, url: string): Promise<ReviewedPr> {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(url);
  if (!match || match[1] !== github) throw new Error("The merge PR is outside the team's project.");
  const read = async () => {
    const result = await runGh(shell, ["pr", "view", url, "--json", "state,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,author,mergeCommit,reviewDecision,mergeable"], cwd);
    if (result.code !== 0) throw new Error("Could not inspect the merge PR.");
    let pr: { state: ReviewedPr["state"]; headRefName: string; baseRefName: string; headRefOid: string; isCrossRepository: boolean; isDraft: boolean; author: { login: string }; mergeCommit?: { oid?: string }; reviewDecision?: string; mergeable?: string };
    try { pr = JSON.parse(result.stdout); }
    catch { throw new Error("Could not read the merge PR details."); }
    if (!pr) throw new Error("Could not read the merge PR details.");
    if (pr.baseRefName !== "main" || pr.headRefName !== branch || pr.isCrossRepository !== false || typeof pr.isDraft !== "boolean"
      || !/^[0-9a-f]{40}$/.test(pr.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || !pr.author?.login
      || (pr.state === "MERGED" && !/^[0-9a-f]{40}$/.test(pr.mergeCommit?.oid ?? ""))) throw new Error("The merge PR does not match its expected branch, project and head.");
    return pr;
  };
  const pr = await read();
  const reviews = await runGh(shell, ["api", `repos/${github}/pulls/${match[2]}/reviews?per_page=100`, "--method", "GET", "--paginate", "--slurp"], cwd);
  let reviewed = false;
  try {
    const pages: unknown = JSON.parse(reviews.stdout);
    reviewed = reviews.code === 0 && Array.isArray(pages) && pages.every(Array.isArray)
      && currentHeadApproved(pages.flat(), pr.headRefOid, pr.author.login, pr.reviewDecision) && !pr.isDraft;
  } catch { /* Unknown reviews stay pending. */ }
  const checksPassed = passingChecks(await runGh(shell, ["pr", "checks", url, "--json", "name,bucket"], cwd));
  if (JSON.stringify(await read()) !== JSON.stringify(pr)) throw new Error("The merge PR changed during verification; retry.");
  return { url, state: pr.state, headSha: pr.headRefOid, mergedSha: pr.mergeCommit?.oid, reviewed, checksPassed,
    ...(pr.mergeable === "CONFLICTING" ? { conflicting: true } : pr.mergeable === "MERGEABLE" ? { conflicting: false } : {}) };
}

/** Fresh reviewers use a detached managed checkout and never resume the lead's drafting session. */
export async function reviewIntegration(context: CeremonyContext, pr: ReviewedPr, shell: Shell = processShell): Promise<void> {
  const { store, goal } = context;
  const state = await store.read();
  const { github } = requireTeamHome(state, goal.teamId);
  const project = await ensureProjectCheckout(shell, store.runtimeDir, github);
  await withFileLock(join(store.runtimeDir, `integration-review-${goal.id}.lock`), async () => {
    const fetch = await runGit(shell, ["fetch", "origin", pr.headSha], project, { githubCredential: true });
    if (fetch.code !== 0) throw new Error("Could not fetch the integration review head.");
    const worktrees = join(store.runtimeDir, "worktrees");
    await mkdir(worktrees, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(worktrees, `integration-review-${goal.id}-`));
    const worktree = join(temp, "checkout");
    try {
      const added = await runGit(shell, ["worktree", "add", "--detach", worktree, pr.headSha], project);
      if (added.code !== 0) throw new Error("Could not prepare the integration review checkout.");
      await postReviewOnce({ store, recordName: `integration-${goal.id}`, prUrl: pr.url, worktree, shell, review: async () => {
        const seats = (state.teams as { seats: { id: string }[] }[]).flatMap((team) => team.seats.map((seat) => seat.id));
        const engines = await loadSeatEngines(store.runtimeDir, seats);
        const runtime = new SeatRuntime(engines[goal.seatId] ?? "codex", worktree, undefined, undefined, undefined, seatHarnessDir(store.runtimeDir, goal.seatId));
        try {
          const run = await runtime.message(`You are a fresh reviewer in Indra. Review integration ${pr.url} at HEAD ${pr.headSha} against AGENTS.md and the approved goal: ${goal.goal}. Inspect the diff against origin/main. Flag only real bugs or project-rule violations, with path:line: reason for each finding. You are read-only without network. Do not edit, commit, push, merge or post. Indra will post your line comments and verdict. Never include credentials. Return JSON with summary and findings (strings, empty when none).`, schemaPathOf(import.meta.url, "review.json"), undefined, { purpose: "review" });
          await context.recordRun(run);
          return run.response;
        } catch (error) { if (error instanceof AgentRunError) await context.recordSession(error.facts); throw error; }
      } });
    } finally {
      const removed = await runGit(shell, ["worktree", "remove", "--force", worktree], project);
      if (removed.code === 0) await rm(temp, { recursive: true, force: true });
    }
  });
}
