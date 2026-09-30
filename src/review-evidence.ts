import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shell } from "./command-shell.js";
import { redactSecrets } from "./redact.js";
import { withFileLock } from "./state-commit.js";

export const INDEPENDENT_REVIEWER = "independent-agent" as const;
export const LEGACY_REVIEWER = "satori-miyamoto" as const;
export type Reviewer = typeof INDEPENDENT_REVIEWER | typeof LEGACY_REVIEWER;
export interface ReviewResult { summary: string; findings: { path: string; line: number; reason: string }[] }
export interface ReviewEvidence extends ReviewResult {
  version: 1; id: string; prUrl: string; headSha: string; reviewer: typeof INDEPENDENT_REVIEWER;
  verdict: "APPROVE" | "REQUEST_CHANGES"; at: string; posted: boolean;
}
export interface ReviewRejection { reviewId: number | string; headSha: string; submittedAt: string }
export interface ReviewStatus { reviewed: boolean; reviewer?: Reviewer; rejection?: ReviewRejection }

function identity(prUrl: string, headSha: string): string {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(prUrl) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("Invalid review PR identity or head.");
  return createHash("sha256").update(JSON.stringify([prUrl, headSha])).digest("hex");
}
export const reviewEvidencePath = (runtimeDir: string, prUrl: string, headSha: string) => join(runtimeDir, `review-evidence-${identity(prUrl, headSha)}.json`);
export function validateReviewResult(value: unknown): ReviewResult {
  const result = value as ReviewResult | undefined;
  if (typeof result?.summary !== "string" || !result.summary.trim() || !Array.isArray(result.findings) || result.findings.some((item) => !item
    || typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.includes("\\") || item.path.includes("\0") || item.path.split("/").some((part) => !part || part === "." || part === "..")
    || !Number.isSafeInteger(item.line) || item.line < 1 || typeof item.reason !== "string" || !item.reason.trim())) throw new Error("Invalid independent reviewer findings.");
  return { summary: redactSecrets(result.summary.trim()), findings: result.findings.map((item) => ({ path: item.path, line: item.line, reason: redactSecrets(item.reason.trim()) })) };
}

/** Runtime-owned evidence only. PR comments and model-authored report claims are never read as proof. */
export async function readReviewEvidence(runtimeDir: string, prUrl: string, headSha: string): Promise<ReviewEvidence | undefined> {
  const data = await readFile(reviewEvidencePath(runtimeDir, prUrl, headSha), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (data === undefined) return undefined;
  let value: ReviewEvidence;
  try {
    value = JSON.parse(data) as ReviewEvidence;
    validateReviewResult(value);
    if (value.version !== 1 || value.id !== `agent:${identity(prUrl, headSha)}` || value.prUrl !== prUrl || value.headSha !== headSha || value.reviewer !== INDEPENDENT_REVIEWER
      || value.verdict !== (value.findings.length ? "REQUEST_CHANGES" : "APPROVE") || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.posted !== "boolean") throw new Error();
  } catch { throw new Error("Saved independent review proof is invalid; preserve it and reconcile the exact PR head."); }
  return value;
}
async function save(file: string, evidence: ReviewEvidence): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/** The host invokes a fresh read-only callback, then checks the head before committing its verdict. */
export async function reviewOnce(runtimeDir: string, prUrl: string, headSha: string, review: () => Promise<unknown>, verifyHead: () => Promise<void>, deliver?: (evidence: ReviewEvidence) => Promise<void>): Promise<ReviewEvidence> {
  const file = reviewEvidencePath(runtimeDir, prUrl, headSha);
  return await withFileLock(`${file}.lock`, async () => {
    let evidence = await readReviewEvidence(runtimeDir, prUrl, headSha);
    if (!evidence) {
      await verifyHead();
      const result = validateReviewResult(await review());
      await verifyHead();
      evidence = { version: 1, id: `agent:${identity(prUrl, headSha)}`, prUrl, headSha, reviewer: INDEPENDENT_REVIEWER, ...result, verdict: result.findings.length ? "REQUEST_CHANGES" : "APPROVE", at: new Date().toISOString(), posted: false };
      await save(file, evidence);
    }
    if (!evidence.posted && deliver) {
      try { await deliver(evidence); await save(file, { ...evidence, posted: true }); evidence = { ...evidence, posted: true }; }
      catch { /* A missing comment never invalidates durable review proof or reruns the reviewer. */ }
    }
    return evidence;
  });
}

/** Optional owner-authenticated informational comment, reconciled after a lost response. */
export async function postReviewComment(shell: Shell, cwd: string, evidence: ReviewEvidence): Promise<void> {
  const [, owner, repo, number] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(evidence.prUrl)!;
  const endpoint = `repos/${owner}/${repo}/issues/${number}/comments`;
  const marker = `<!-- indra-review:${evidence.id} -->`;
  const body = `**Independent agent review: ${evidence.verdict}**\nHead: ${evidence.headSha}\n\n${evidence.summary}${evidence.findings.map((item) => `\n- ${item.path}:${item.line}: ${item.reason}`).join("")}\n\n${marker}`;
  const existing = await shell.run("gh", ["api", `${endpoint}?per_page=100`, "--method", "GET", "--paginate", "--slurp"], cwd);
  if (existing.code !== 0) throw new Error("Could not read review comments.");
  const pages: unknown = JSON.parse(existing.stdout);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("Invalid review comments.");
  if (pages.flat().some((item) => item?.body === body)) return;
  const temp = await mkdtemp(join(tmpdir(), "indra-review-comment-"));
  try {
    const input = join(temp, "comment.json"); await writeFile(input, JSON.stringify({ body }), { mode: 0o600 });
    if ((await shell.run("gh", ["api", endpoint, "--method", "POST", "--input", input], cwd)).code !== 0) throw new Error("Review comment delivery is unconfirmed.");
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Historical delivered bot verdicts remain readable only when this head has no local proof. */
export async function inspectReview(runtimeDir: string, shell: Shell, cwd: string, prUrl: string, headSha: string, author?: string, reviewDecision?: string): Promise<ReviewStatus> {
  const local = await readReviewEvidence(runtimeDir, prUrl, headSha);
  if (local) return { reviewed: local.verdict === "APPROVE", reviewer: INDEPENDENT_REVIEWER,
    ...(local.verdict === "REQUEST_CHANGES" ? { rejection: { reviewId: local.id, headSha, submittedAt: local.at } } : {}) };
  const [, owner, repo, number] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(prUrl)!;
  const response = await shell.run("gh", ["api", `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`, "--method", "GET", "--paginate", "--slurp"], cwd);
  if (response.code !== 0) throw new Error("Could not verify historical PR reviews.");
  const pages: unknown = JSON.parse(response.stdout);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("Invalid historical PR reviews.");
  type Legacy = { id: number; user?: { login?: string }; state: string; commit_id: string; submitted_at?: string };
  const latest = new Map<string, Legacy>();
  for (const item of (pages.flat() as Legacy[]).sort((a, b) => a?.id - b?.id)) if (item?.user?.login && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state)) latest.set(item.user.login, item);
  const bot = latest.get(LEGACY_REVIEWER);
  const current = author !== LEGACY_REVIEWER && bot?.commit_id === headSha;
  return { reviewed: current && bot?.state === "APPROVED" && reviewDecision !== "CHANGES_REQUESTED" && ![...latest.values()].some((item) => item.state === "CHANGES_REQUESTED"),
    ...(current ? { reviewer: LEGACY_REVIEWER } : {}),
    ...(current && bot?.state === "CHANGES_REQUESTED" && Number.isSafeInteger(bot.id) && bot.id > 0 && bot.submitted_at && Number.isFinite(Date.parse(bot.submitted_at))
      ? { rejection: { reviewId: bot.id, headSha, submittedAt: bot.submitted_at } } : {}) };
}
