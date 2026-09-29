import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { postReviewOnce, requireApprovedReview, type SavedReview } from "../src/developer-review.js";
import type { Shell, ShellResult } from "../src/developer-seat.js";
import { PlanningStore } from "../src/planning.js";

const PR = "https://github.com/satoramoto/indra/pull/9";
const FINDINGS = ["src/example.ts:12: Retry loses the saved result."];
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
type Review = { body: string; user?: { login: string }; state?: string; commit_id?: string };
class FakeGitHub implements Shell {
  pages: Review[][] = [[]];
  posts: { body: string; event: string; commit_id: string; comments: unknown[] }[] = [];
  head = "a".repeat(40);
  localHead?: string;
  account = "satori-miyamoto";
  beforeRead?: () => Promise<void>;
  afterAccept?: () => Promise<void>;
  readResult?: ShellResult;
  run = vi.fn(async (command: string, args: string[], _cwd: string): Promise<ShellResult> => {
    const ok = (stdout = ""): ShellResult => ({ code: 0, stdout, stderr: "" });
    if (command === "git") { expect(args).toEqual(["rev-parse", "HEAD"]); return ok(this.localHead ?? this.head); }
    if (command === "gh") { expect(args.slice(0, 2)).toEqual(["pr", "view"]); return ok(this.head); }
    expect(command).toBe("env");
    expect(args.slice(0, 2)).toEqual([`GH_CONFIG_DIR=${join(homedir(), ".config", "gh-yahaha-bot")}`, "gh"]);
    args = args.slice(2);
    if (args[1] === "user") return ok(this.account);
    if (args.includes("GET")) { await this.beforeRead?.(); return this.readResult ?? ok(JSON.stringify(this.pages)); }
    expect(args).toEqual(["api", expect.stringMatching(/\/pulls\/\d+\/reviews$/), "--method", "POST", "--input", expect.any(String)]);
    const post = JSON.parse(await readFile(args.at(-1)!, "utf8"));
    this.posts.push(post);
    this.pages.at(-1)!.push({ body: post.body, commit_id: post.commit_id, user: { login: this.account }, state: post.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED" });
    await this.afterAccept?.();
    return ok();
  });
}
async function fixture(findings: string[] = FINDINGS) {
  const dir = await mkdtemp(join(tmpdir(), "indra-review-")); dirs.push(dir);
  const store = new PlanningStore(join(dir, "state"));
  const shell = new FakeGitHub();
  const review = vi.fn(async () => ({ findings, summary: "Reviewed" }));
  const options = { store, shell, review, recordName: "seat-seat-003-goal-test-outcome-2", prUrl: PR, worktree: join(dir, "worktree") };
  const restart = () => postReviewOnce({ ...options, store: new PlanningStore(store.checkout) });
  const saved = async () => {
    const files = (await readdir(store.runtimeDir)).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    return JSON.parse(await readFile(join(store.runtimeDir, files[0]), "utf8")) as SavedReview;
  };
  return { options, shell, review, saved, restart };
}

describe("restart-safe PR reviews", () => {
  it("persists line findings and verdict before delivery using the designated account", async () => {
    const { options, shell, saved, review } = await fixture();
    shell.beforeRead = async () => { expect(await saved()).toMatchObject({ findings: FINDINGS, verdict: "REQUEST_CHANGES", posted: false }); };
    expect(await postReviewOnce(options)).toEqual(FINDINGS);
    expect(shell.posts).toEqual([{ body: (await saved()).body, commit_id: shell.head, event: "REQUEST_CHANGES", comments: [{ path: "src/example.ts", line: 12, side: "RIGHT", body: "Retry loses the saved result." }] }]);
    expect((await saved()).posted).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each(["before posting", "command response", "local persistence"])("reconciles a review after interruption at %s without a second reviewer or post", async (point) => {
    const { options, shell, saved, review, restart } = await fixture();
    shell.pages = [Array.from({ length: 100 }, () => ({ body: "unrelated" })), []];
    if (point === "before posting") shell.beforeRead = async () => { throw new Error("interrupted"); };
    if (point === "command response") shell.afterAccept = async () => { throw new Error("interrupted"); };
    if (point === "local persistence") {
      const save = options.store.saveRuntime.bind(options.store);
      vi.spyOn(options.store, "saveRuntime").mockImplementation(async (name, value) => {
        if ((value as SavedReview).posted) throw new Error("interrupted");
        await save(name, value);
      });
    }
    await expect(postReviewOnce(options)).rejects.toThrow("interrupted");
    expect((await saved()).posted).toBe(false);
    shell.beforeRead = shell.afterAccept = undefined;
    review.mockResolvedValue({ findings: [], summary: "Different" });
    expect(await restart()).toEqual(FINDINGS);
    expect(shell.posts).toHaveLength(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect((await saved()).posted).toBe(true);
  });

  it("requires current-head approval, and retains previous findings after a new review", async () => {
    const { options, shell, review } = await fixture();
    await postReviewOnce(options);
    await expect(requireApprovedReview(shell, PR, options.worktree)).rejects.toThrow("approved review");
    shell.head = "b".repeat(40);
    review.mockResolvedValue({ findings: [], summary: "Addressed" });
    await postReviewOnce(options);
    expect(await requireApprovedReview(shell, PR, options.worktree)).toBe(shell.head);
    expect(review).toHaveBeenCalledTimes(2);
    expect(shell.posts.map((item) => item.event)).toEqual(["REQUEST_CHANGES", "APPROVE"]);
    const files = await readdir(options.store.runtimeDir);
    const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(options.store.runtimeDir, file), "utf8"))));
    expect(records.some((record) => record.findings[0] === FINDINGS[0])).toBe(true);
    shell.head = "c".repeat(40);
    await expect(requireApprovedReview(shell, PR, options.worktree)).rejects.toThrow("approved review");
  });

  it("checks the actual account and never posts with an owner login", async () => {
    const { options, shell } = await fixture(); shell.account = "owner";
    await expect(postReviewOnce(options)).rejects.toThrow("designated review account");
    expect(shell.posts).toEqual([]);
  });

  it("does not accept a copied marker from another account or a comment without a verdict", async () => {
    const { options, shell, saved } = await fixture();
    shell.beforeRead = async () => {
      const record = await saved();
      shell.pages = [[{ body: record.body, state: "CHANGES_REQUESTED", commit_id: shell.head, user: { login: "owner" } }, { body: record.body, state: "COMMENTED", commit_id: shell.head, user: { login: "satori-miyamoto" } }]];
    };
    await postReviewOnce(options);
    expect(shell.posts).toHaveLength(1);
  });

  it.each(["missing location", "../file.ts:1: bug", "file.ts:0: bug"])("refuses unpostable findings: %s", async (text) => {
    const { options, shell } = await fixture([text]);
    await expect(postReviewOnce(options)).rejects.toThrow("path:line: reason");
    expect(shell.posts).toEqual([]);
  });

  it("does not review code different from the PR, or post findings if persistence fails", async () => {
    const { options, shell, review } = await fixture();
    shell.localHead = "b".repeat(40);
    await expect(postReviewOnce(options)).rejects.toThrow("does not match");
    expect(review).not.toHaveBeenCalled();
    shell.localHead = undefined;
    vi.spyOn(options.store, "saveRuntime").mockRejectedValue(new Error("storage unavailable"));
    await expect(postReviewOnce(options)).rejects.toThrow("storage unavailable");
    expect(shell.posts).toEqual([]);
  });

  it.each(["bad JSON", "{}", "[null]"])("fails closed on invalid review reconciliation: %s", async (stdout) => {
    const { options, shell } = await fixture(); shell.readResult = { code: 0, stdout, stderr: "" };
    await expect(postReviewOnce(options)).rejects.toThrow("invalid PR reviews");
    expect(shell.posts).toEqual([]);
  });
});
