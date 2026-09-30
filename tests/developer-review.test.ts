import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postReviewOnce, requireApprovedReview } from "../src/developer-review.js";
import { readReviewEvidence } from "../src/review-evidence.js";
import type { Shell, ShellResult } from "../src/developer-seat.js";
import { PlanningStore } from "../src/planning.js";

const PR = "https://github.com/satoramoto/indra/pull/9";
const FINDINGS = ["src/example.ts:12: Retry loses the saved result."];
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
class FakeGitHub implements Shell {
  comments: { body: string }[] = []; posts: { body: string }[] = [];
  head = "a".repeat(40); localHead?: string;
  beforeRead?: () => Promise<void>; afterAccept?: () => Promise<void>; failPost = false;
  run = vi.fn(async (command: string, args: string[], _cwd: string): Promise<ShellResult> => {
    const ok = (stdout = ""): ShellResult => ({ code: 0, stdout, stderr: "" });
    if (command === "git") { expect(args).toEqual(["rev-parse", "HEAD"]); return ok(this.localHead ?? this.head); }
    expect(command).toBe("gh");
    if (args[0] === "pr") return ok(this.head);
    if (args[1].includes("/reviews?")) return ok("[[]]");
    if (args.includes("GET")) { await this.beforeRead?.(); return ok(JSON.stringify([this.comments])); }
    expect(args).toEqual(["api", "repos/satoramoto/indra/issues/9/comments", "--method", "POST", "--input", expect.any(String)]);
    if (this.failPost) return { code: 1, stdout: "", stderr: "" };
    const post = JSON.parse(await readFile(args.at(-1)!, "utf8")); this.posts.push(post); this.comments.push(post);
    await this.afterAccept?.(); return ok();
  });
}
async function fixture(findings: string[] = FINDINGS) {
  const dir = await mkdtemp(join(tmpdir(), "indra-review-")); dirs.push(dir);
  const store = new PlanningStore(join(dir, "state")); const shell = new FakeGitHub();
  const review = vi.fn(async () => ({ findings, summary: "Reviewed" }));
  const options = { store, shell, review, recordName: "seat-goal-outcome", prUrl: PR, worktree: join(dir, "worktree") };
  return { options, shell, review, saved: () => readReviewEvidence(store.runtimeDir, PR, shell.head),
    restart: () => postReviewOnce({ ...options, store: new PlanningStore(store.checkout) }),
    approved: () => requireApprovedReview(shell, PR, options.worktree, store.runtimeDir) };
}

describe("restart-safe independent PR reviews", () => {
  it("persists findings before informational comment delivery with ordinary gh", async () => {
    const f = await fixture();
    f.shell.beforeRead = async () => { expect(await f.saved()).toMatchObject({ verdict: "REQUEST_CHANGES", posted: false }); };
    expect(await postReviewOnce(f.options)).toEqual(FINDINGS);
    expect(f.shell.posts).toHaveLength(1); expect(f.shell.posts[0].body).toContain(FINDINGS[0]);
    expect(f.shell.posts[0].body).toContain(f.shell.head); expect((await f.saved())!.posted).toBe(true);
  });

  it.each(["before posting", "lost response"])("reconciles %s without a second reviewer or comment", async (point) => {
    const f = await fixture();
    if (point === "before posting") f.shell.beforeRead = async () => { throw new Error("interrupted"); };
    else f.shell.afterAccept = async () => { throw new Error("interrupted"); };
    expect(await postReviewOnce(f.options)).toEqual(FINDINGS); expect((await f.saved())!.posted).toBe(false);
    f.shell.beforeRead = f.shell.afterAccept = undefined; f.review.mockResolvedValue({ findings: [], summary: "Different" });
    expect(await f.restart()).toEqual(FINDINGS); expect(f.review).toHaveBeenCalledTimes(1); expect(f.shell.posts).toHaveLength(1);
  });

  it("retains exact-head approval when the comment is unavailable, and requires review for a new head", async () => {
    const f = await fixture([]); f.shell.failPost = true;
    await postReviewOnce(f.options); expect(await f.approved()).toBe(f.shell.head);
    await f.restart(); expect(f.review).toHaveBeenCalledTimes(1);
    f.shell.head = "b".repeat(40); await expect(f.approved()).rejects.toThrow("approved review");
    await f.restart(); expect(await f.approved()).toBe(f.shell.head); expect(f.review).toHaveBeenCalledTimes(2);
  });

  it("does not rerun stored rejection until code changes", async () => {
    const f = await fixture(); await postReviewOnce(f.options); await expect(f.approved()).rejects.toThrow("approved review");
    f.review.mockResolvedValue({ findings: [], summary: "Addressed" }); await f.restart();
    await expect(f.approved()).rejects.toThrow("approved review"); expect(f.review).toHaveBeenCalledTimes(1);
    f.shell.head = "b".repeat(40); await f.restart(); expect(await f.approved()).toBe(f.shell.head);
  });

  it.each(["missing location", "../file.ts:1: bug", "file.ts:0: bug"])("refuses malformed findings: %s", async (text) => {
    const f = await fixture([text]); await expect(postReviewOnce(f.options)).rejects.toThrow(); expect(f.shell.posts).toEqual([]); expect(await f.saved()).toBeUndefined();
  });

  it("does not approve a mismatched checkout or a head changed by the review callback", async () => {
    const f = await fixture([]); f.shell.localHead = "b".repeat(40);
    await expect(postReviewOnce(f.options)).rejects.toThrow("does not match"); expect(f.review).not.toHaveBeenCalled();
    f.shell.localHead = undefined; f.review.mockImplementation(async () => { f.shell.head = "b".repeat(40); return { findings: [], summary: "Reviewed" }; });
    await expect(postReviewOnce(f.options)).rejects.toThrow("changed during review"); expect(f.shell.posts).toEqual([]);
  });
});
