import { createHash } from "node:crypto";
import type { Shell } from "./developer-seat.js";
import type { PlanningStore } from "./planning.js";

/** Stored only in the planning runtime directory, separately from the assignment's step. */
export interface SavedReview {
  id: string;
  findings: string[];
  body: string;
  posted: boolean;
}

export interface DeveloperReviewOptions {
  store: Pick<PlanningStore, "readRuntimeFile" | "saveRuntime">;
  /** The seat's assignment record name; reuse it when resuming the same assignment. */
  recordName: string;
  prUrl: string;
  worktree: string;
  shell: Shell;
  /** Runs a fresh reviewer only when no saved review exists. */
  review: () => Promise<unknown>;
}

/**
 * Saves findings before any comment can be posted. On restart, reconciles the stable
 * marker against every page of PR comments before retrying an uncertain delivery.
 * The seat must await this before advancing to fix/CI, using the returned findings.
 * Like the seat runner, this assumes a single active owner of the assignment.
 */
export async function postReviewOnce(options: DeveloperReviewOptions): Promise<string[]> {
  const { store, recordName, prUrl, worktree, shell, review } = options;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(prUrl);
  if (!match) throw new Error("Review requires a GitHub pull request URL.");
  const id = createHash("sha256").update(JSON.stringify([recordName, prUrl])).digest("hex");
  const name = `developer-review-${id}`;
  const marker = `<!-- indra-review:${id} -->`;
  let saved = await store.readRuntimeFile<SavedReview>(name);
  if (!saved) {
    const response = await review() as { findings?: unknown; summary?: unknown } | undefined;
    if (!Array.isArray(response?.findings) || response.findings.some((item) => typeof item !== "string")) {
      throw new Error("Reviewer session returned invalid findings.");
    }
    const findings = (response.findings as string[]).filter((item) => item.trim());
    const summary = typeof response.summary === "string" && response.summary.trim() ? response.summary.trim() : "done";
    const detail = findings.length ? `Findings:\n${findings.map((item) => `- ${item}`).join("\n")}` : "No findings.";
    saved = { id, findings, body: `**Indra review:** ${summary}\n\n${detail}\n\n${marker}`, posted: false };
    await store.saveRuntime(name, saved);
  }
  if (!saved.posted) {
    const result = await shell.run("gh", ["api", `repos/${match[1]}/${match[2]}/issues/${match[3]}/comments?per_page=100`, "--method", "GET", "--paginate", "--slurp"], worktree);
    if (result.code !== 0) throw new Error("Could not read PR comments to reconcile the review.");
    let pages: unknown;
    try { pages = JSON.parse(result.stdout); }
    catch { throw new Error("GitHub returned invalid PR comments."); }
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page) || page.some((comment) => !comment || typeof comment.body !== "string"))) {
      throw new Error("GitHub returned invalid PR comments.");
    }
    const exists = pages.flat().some((comment: { body: string }) => comment.body.trimEnd().endsWith(`\n\n${marker}`));
    if (!exists) {
      const posted = await shell.run("gh", ["pr", "comment", prUrl, "--body", saved.body], worktree);
      if (posted.code !== 0) throw new Error("Could not post the PR review comment.");
    }
    saved = { ...saved, posted: true };
    await store.saveRuntime(name, saved);
  }
  return [...saved.findings];
}
