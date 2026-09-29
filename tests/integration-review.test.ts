import { describe, expect, it, vi } from "vitest";
import { inspectReviewedPr } from "../src/integration-review.js";
import { SprintGitHub } from "../src/sprint.js";
import type { Shell } from "../src/command-shell.js";

const head = "a".repeat(40);
const other = "b".repeat(40);
const url = "https://github.com/test/project/pull/1";
function fixture() {
  const pr = { state: "OPEN", headRefName: "sprint/goal-test", baseRefName: "main", headRefOid: head, isCrossRepository: false, isDraft: false, author: { login: "owner" }, mergeCommit: null as null | { oid: string }, reviewDecision: "" };
  const reviews = [{ id: 1, user: { login: "satori-miyamoto" }, state: "APPROVED", commit_id: head }];
  const checks = { code: 0, stdout: JSON.stringify([{ name: "checks", bucket: "pass" }]), stderr: "" };
  let afterChecks: (() => void) | undefined;
  let atMerge: (() => void) | undefined;
  const run = vi.fn<Shell["run"]>(async (_command, args) => {
    if (args[0] === "api") return { code: 0, stdout: JSON.stringify([reviews]), stderr: "" };
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
    if (args[1] === "checks") { afterChecks?.(); return checks; }
    if (args[1] === "merge") {
      atMerge?.();
      if (args[args.indexOf("--match-head-commit") + 1] === pr.headRefOid) { pr.state = "MERGED"; pr.mergeCommit = { oid: other }; }
      return { code: 1, stdout: "", stderr: "Response lost" };
    }
    throw new Error("Unexpected command");
  });
  const inspect = () => inspectReviewedPr({ run }, "/managed", "test/project", pr.headRefName, url);
  const github = new SprintGitHub({ run }, "/managed/state.runtime");
  const merge = (beforeMerge?: () => Promise<void>) => github.merge("test/project", "sprint/goal-test", url, head, beforeMerge);
  return { pr, reviews, checks, run, inspect, merge, afterChecks: (fn: () => void) => { afterChecks = fn; }, atMerge: (fn: () => void) => { atMerge = fn; } };
}

describe("current-head release review and merge", () => {
  it("honors a revoked authorization after PR verification and before the GitHub write", async () => {
    const f = fixture();
    const policy = vi.fn(async () => { throw new Error("Policy disabled"); });
    await expect(f.merge(policy)).rejects.toThrow("Policy disabled");
    expect(policy).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls.some(([, args]) => args[1] === "checks")).toBe(true);
    expect(f.run.mock.calls.some(([, args]) => args[1] === "merge")).toBe(false);
  });

  it("pins a reviewed head, verifies the merge despite a lost response, and never merges twice", async () => {
    const f = fixture();
    expect(await f.inspect()).toMatchObject({ reviewed: true, checksPassed: true, headSha: head });
    expect(await f.merge()).toEqual({ merged: true, sha: other });
    expect(await f.merge()).toEqual({ merged: true, sha: other });
    expect(f.run.mock.calls.filter(([, args]) => args[1] === "merge")).toEqual([["gh", ["pr", "merge", url, "--squash", "--match-head-commit", head], "/managed"]]);
  });

  it.each(["stale", "dismissed", "changes", "other-reviewer", "self-review", "draft", "required"])("blocks %s review evidence", async (problem) => {
    const f = fixture();
    if (problem === "stale") f.reviews[0].commit_id = other;
    if (problem === "dismissed") f.reviews.push({ ...f.reviews[0], id: 2, state: "DISMISSED" });
    if (problem === "changes") f.reviews.push({ ...f.reviews[0], id: 2, user: { login: "another" }, state: "CHANGES_REQUESTED" });
    if (problem === "other-reviewer") f.reviews[0].user.login = "another";
    if (problem === "self-review") f.pr.author.login = "satori-miyamoto";
    if (problem === "draft") f.pr.isDraft = true;
    if (problem === "required") f.pr.reviewDecision = "REVIEW_REQUIRED";
    expect((await f.inspect()).reviewed).toBe(false);
    expect((await f.merge()).merged).toBe(false);
    expect(f.run.mock.calls.some(([, args]) => args[1] === "merge")).toBe(false);
  });

  it.each(["fail", "pending", "skipping", "cancel", "unknown", "missing", "unreadable", "failed-command"])("blocks %s CI evidence", async (problem) => {
    const f = fixture();
    f.checks.stdout = problem === "unreadable" ? "not JSON" : problem === "missing" ? "[]" : JSON.stringify([{ name: "checks", bucket: problem === "failed-command" ? "pass" : problem }]);
    if (problem === "failed-command") f.checks.code = 1;
    expect((await f.inspect()).checksPassed).toBe(false);
    expect((await f.merge()).merged).toBe(false);
    expect(f.run.mock.calls.some(([, args]) => args[1] === "merge")).toBe(false);
  });

  it("rejects heads changed during verification or immediately before the merge command", async () => {
    const f = fixture(); f.afterChecks(() => { f.pr.headRefOid = other; });
    await expect(f.inspect()).rejects.toThrow("changed during verification");
    const g = fixture(); g.atMerge(() => { g.pr.headRefOid = other; g.reviews[0].commit_id = other; });
    expect((await g.merge()).merged).toBe(false);
    expect(g.pr.state).toBe("OPEN");
  });

  it.each(["branch", "project", "closed"])("refuses a %s mismatch", async (problem) => {
    const f = fixture();
    if (problem === "branch") f.pr.headRefName = "main";
    if (problem === "project") f.pr.isCrossRepository = true;
    if (problem === "closed") f.pr.state = "CLOSED";
    if (problem === "closed") expect((await f.merge()).merged).toBe(false);
    else await expect(f.merge()).rejects.toThrow("expected branch");
    expect(f.run.mock.calls.some(([, args]) => args[1] === "merge")).toBe(false);
  });
});
