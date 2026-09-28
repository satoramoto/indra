import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postReviewOnce, type SavedReview } from "../src/developer-review.js";
import type { Shell, ShellResult } from "../src/developer-seat.js";
import { PlanningStore } from "../src/planning.js";

const PR = "https://github.com/satoramoto/indra/pull/9";
const FINDINGS = ["src/example.ts:12: Retry loses the saved result."];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeGitHub implements Shell {
  pages: { body: string }[][] = [[]];
  posts: string[] = [];
  beforeRead?: () => Promise<void>;
  afterAccept?: () => Promise<void>;
  readResult?: ShellResult;
  run = vi.fn(async (command: string, args: string[], _cwd: string): Promise<ShellResult> => {
    expect(command).toBe("gh");
    if (args[0] === "api") {
      expect(args).toEqual(["api", expect.stringMatching(/^repos\/satoramoto\/indra\/issues\/\d+\/comments\?per_page=100$/), "--method", "GET", "--paginate", "--slurp"]);
      await this.beforeRead?.();
      return this.readResult ?? { code: 0, stdout: JSON.stringify(this.pages), stderr: "" };
    }
    expect(args.slice(0, 2)).toEqual(["pr", "comment"]);
    expect(args[3]).toBe("--body");
    const body = args[4];
    this.posts.push(body);
    this.pages.at(-1)!.push({ body });
    await this.afterAccept?.();
    return { code: 0, stdout: "", stderr: "" };
  });
}

async function fixture(findings: string[] = FINDINGS) {
  const dir = await mkdtemp(join(tmpdir(), "indra-review-"));
  dirs.push(dir);
  const checkout = join(dir, "state");
  const store = new PlanningStore(checkout);
  const shell = new FakeGitHub();
  const review = vi.fn(async () => ({ findings, summary: "Reviewed" }));
  const options = { store, shell, review, recordName: "seat-seat-003-goal-test-outcome-2", prUrl: PR, worktree: join(dir, "worktree") };
  const restart = () => postReviewOnce({ ...options, store: new PlanningStore(checkout) });
  const saved = async () => {
    const files = await readdir(store.runtimeDir);
    expect(files).toHaveLength(1);
    return JSON.parse(await readFile(join(store.runtimeDir, files[0]), "utf8")) as SavedReview;
  };
  return { options, shell, review, saved, restart };
}

describe("restart-safe review comments", () => {
  it("persists findings before any GitHub operation and posts their stable marker", async () => {
    const { options, shell, saved, review } = await fixture();
    shell.beforeRead = async () => {
      expect(await saved()).toMatchObject({ findings: FINDINGS, posted: false });
    };
    expect(await postReviewOnce(options)).toEqual(FINDINGS);
    const record = await saved();
    expect(record.posted).toBe(true);
    expect(shell.posts).toEqual([`**Indra review:** Reviewed\n\nFindings:\n- ${FINDINGS[0]}\n\n<!-- indra-review:${record.id} -->`]);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("resumes an interruption before posting without running another reviewer", async () => {
    const { options, shell, saved, review, restart } = await fixture();
    shell.beforeRead = async () => { throw new Error("interrupted"); };
    await expect(postReviewOnce(options)).rejects.toThrow("interrupted");
    const before = await saved();
    expect(before).toMatchObject({ findings: FINDINGS, posted: false });
    expect(shell.posts).toEqual([]);
    shell.beforeRead = undefined;
    review.mockResolvedValue({ findings: ["different review"], summary: "Different" });
    expect(await restart()).toEqual(FINDINGS);
    expect(shell.posts).toEqual([before.body]);
    expect(await saved()).toEqual({ ...before, posted: true });
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each(["command response", "local persistence"])("reconciles an accepted comment after interruption before %s", async (point) => {
    const { options, shell, saved, review, restart } = await fixture();
    // The matching comment is on page two, after a full page of unrelated discussion.
    shell.pages = [Array.from({ length: 100 }, () => ({ body: "Unrelated discussion" })), []];
    if (point === "command response") {
      shell.afterAccept = async () => { throw new Error("interrupted"); };
    } else {
      const save = options.store.saveRuntime.bind(options.store);
      vi.spyOn(options.store, "saveRuntime").mockImplementation(async (name, value) => {
        if ((value as SavedReview).posted) throw new Error("interrupted");
        await save(name, value);
      });
    }
    await expect(postReviewOnce(options)).rejects.toThrow("interrupted");
    const before = await saved();
    expect(before.posted).toBe(false);
    expect(shell.posts).toEqual([before.body]);
    shell.afterAccept = undefined;
    review.mockResolvedValue({ findings: [], summary: "Different" });
    expect(await restart()).toEqual(FINDINGS);
    expect(shell.posts).toEqual([before.body]);
    expect(await saved()).toEqual({ ...before, posted: true });
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each([[], [" ", "\n"]])("preserves empty findings across restart (%j)", async (...findings) => {
    const { options, shell, saved, review, restart } = await fixture(findings);
    expect(await postReviewOnce(options)).toEqual([]);
    expect(await saved()).toMatchObject({ findings: [], posted: true });
    expect(shell.posts[0]).toContain("\n\nNo findings.\n\n");
    const calls = shell.run.mock.calls.length;
    expect(await restart()).toEqual([]);
    expect(shell.run).toHaveBeenCalledTimes(calls);
    expect(shell.posts).toHaveLength(1);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("does not confuse unrelated reviews or quoted markers with this review", async () => {
    const { options, shell, saved } = await fixture();
    shell.beforeRead = async () => {
      const record = await saved();
      shell.pages = [[
        { body: record.body.replace(record.id, "another-review") },
        { body: record.body.split("\n").map((line) => `> ${line}`).join("\n") },
        { body: "**Indra review:** Reviewed\n\nNo findings." },
        { body: "Unrelated discussion" },
      ]];
    };
    expect(await postReviewOnce(options)).toEqual(FINDINGS);
    expect(shell.posts).toEqual([(await saved()).body]);
    expect(shell.pages[0]).toHaveLength(5);
  });

  it("scopes saved reviews to the assignment and PR", async () => {
    const { options, shell, review } = await fixture();
    await postReviewOnce(options);
    await postReviewOnce({ ...options, recordName: "another-assignment" });
    await postReviewOnce({ ...options, prUrl: "https://github.com/satoramoto/indra/pull/10" });
    expect(review).toHaveBeenCalledTimes(3);
    expect(new Set(shell.posts).size).toBe(3);
  });

  it("never posts when saving the findings fails", async () => {
    const { options, shell } = await fixture();
    vi.spyOn(options.store, "saveRuntime").mockRejectedValue(new Error("storage unavailable"));
    await expect(postReviewOnce(options)).rejects.toThrow("storage unavailable");
    expect(shell.run).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1, stdout: "", stderr: "private upstream details" },
    { code: 0, stdout: "invalid JSON", stderr: "" },
    { code: 0, stdout: '{"unexpected":"response"}', stderr: "" },
    { code: 0, stdout: '[[{"body":null}]]', stderr: "" },
  ])("refuses to post when comment reconciliation is unavailable (%j)", async (result) => {
    const { options, shell, saved, review, restart } = await fixture();
    shell.readResult = result;
    await expect(postReviewOnce(options)).rejects.toThrow(/Could not read PR comments|GitHub returned invalid PR comments/);
    expect(shell.posts).toEqual([]);
    expect((await saved()).posted).toBe(false);
    shell.readResult = undefined;
    expect(await restart()).toEqual(FINDINGS);
    expect(shell.posts).toHaveLength(1);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid reviewer findings before saving or posting", async () => {
    const { options, shell } = await fixture();
    const save = vi.spyOn(options.store, "saveRuntime");
    await expect(postReviewOnce({ ...options, review: async () => ({ findings: [42] }) })).rejects.toThrow("invalid findings");
    expect(save).not.toHaveBeenCalled();
    expect(shell.run).not.toHaveBeenCalled();
  });
});
