import { randomUUID } from "node:crypto";
import { link, lstat, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maintainDeveloperSeat, retainSeatRecord, seatRecordName } from "../src/developer-maintenance.js";
import type { SeatTaskRecord, Shell } from "../src/developer-seat.js";
import { PlanningStore, type PlanningAssignment, type PlanningDocument } from "../src/planning.js";
import { git, stateCheckout } from "./state-checkout.js";

const PR = "https://github.com/satoramoto/indra/pull/9";
const BRANCH = "seat-002/goal-abc-outcome-1";
const NAME = seatRecordName("seat-002", "goal-abc", "outcome-1");
const SESSION = { role: "developer" as const, sessionId: "session-1", startedAt: "t0", finishedAt: "t1", usage: { tokens: 10 } };
const mergedPR = () => ({
  html_url: PR, number: 9, state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z",
  base: { ref: "sprint/goal-abc", repo: { full_name: "satoramoto/indra" } },
  head: { ref: BRANCH, repo: { full_name: "satoramoto/indra" } },
});

async function fixture(status: PlanningAssignment["status"] = "failed") {
  const seat = (id: string, role: string) => ({ id, displayName: id, roles: [role], externalIdentities: { mattermost: { userId: id, username: id } } });
  const state: PlanningDocument = {
    $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [],
    teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", project: { github: "satoramoto/indra" }, externalIdentities: { mattermost: { teamId: "team" } }, seats: [seat("seat-001", "Team Lead"), seat("seat-002", "Developer"), seat("seat-003", "Developer")] }],
    planningGoals: [{
      id: "goal-abc", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Build it", projectRefs: [], stage: "approved",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mattermost: { channelId: "channel", rootPostId: "root" },
      brief: { summary: "Build it", decisions: [], openQuestions: [] },
      proposal: { id: "proposal-1", createdAt: "2026-01-01T00:00:00Z", summary: "Plan", risks: [], openQuestions: [], outcomes: [{ id: "outcome-1", title: "First", description: "Do it", seatId: "seat-002" }] },
      integration: { branch: "sprint/goal-abc", baseSha: "a".repeat(40), status: "collecting" },
      assignments: [{ outcomeId: "outcome-1", seatId: "seat-002", status, prUrl: PR, updatedAt: "2026-01-01T00:00:00Z", ...(status === "failed" ? { note: "ci: interrupted" } : {}) }],
    }],
  };
  const store = new PlanningStore(await stateCheckout("indra-maintenance-", state));
  // Match normal persisted formatting so a no-op barrier cannot create a formatting-only commit.
  await store.update(() => {}, "Normalize fixture");
  const record: SeatTaskRecord = { goalId: "goal-abc", outcomeId: "outcome-1", branch: BRANCH, worktree: join(store.runtimeDir, "worktrees", "goal-abc-outcome-1"), gitDir: join(store.runtimeDir, "projects", "satoramoto", "indra", ".git"), step: "ci", prUrl: PR, sessions: [SESSION] };
  await store.saveRuntime(NAME, record);
  const run = vi.fn<Shell["run"]>().mockResolvedValue({ code: 0, stdout: JSON.stringify(mergedPR()), stderr: "" });
  const log = vi.fn<(line: string) => void>();
  const maintain = () => maintainDeveloperSeat(store, "seat-002", { run }, log);
  const assignment = async () => (await store.read()).planningGoals![0].assignments![0];
  const archive = async (value: unknown = record, name = `${NAME}-retained-${randomUUID()}`) => {
    await store.saveRuntime(name, value as object); return join(store.runtimeDir, `${name}.json`);
  };
  return { store, record, run, log, maintain, assignment, archive };
}

describe("developer maintenance", () => {
  it("reconciles a verified merged PR without a checkout, commits valid state, clears the note, and is idempotent", async () => {
    const { store, record, run, maintain, assignment, archive } = await fixture();
    const files = await Promise.all([archive(), archive(), archive({ ...record, sessions: [] })]);
    await expect(lstat(record.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    const before = git(store.checkout, "rev-parse", "HEAD");
    expect(await maintain()).toBe(true);
    expect(await assignment()).toMatchObject({ status: "merged", prUrl: PR });
    expect((await assignment()).note).toBeUndefined();
    expect(git(store.checkout, "rev-parse", "HEAD")).not.toBe(before);
    const durable = JSON.parse(git(store.checkout, "show", "HEAD:state.json"));
    expect(durable.planningGoals[0].assignments[0]).toEqual(await assignment());
    expect(git(store.checkout, "status", "--porcelain")).toBe("");
    expect(run.mock.calls).toEqual([["gh", ["api", "repos/satoramoto/indra/pulls/9", "--method", "GET"], store.checkout]]);
    for (const file of files) await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.readRuntimeFile(NAME)).toEqual(record); // canonical session history survives
    const after = git(store.checkout, "rev-parse", "HEAD");
    expect(await maintain()).toBe(false);
    expect(git(store.checkout, "rev-parse", "HEAD")).toBe(after);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["open", "closed-unmerged", "repository", "head-repository", "base", "head", "url", "number", "merged-at", "malformed", "github-error", "throws"])("preserves failed work for %s GitHub evidence", async (kind) => {
    const { store, record, run, maintain, assignment, archive } = await fixture();
    const saved = await archive();
    const response = mergedPR();
    if (kind === "open") { response.state = "open"; response.merged = false; }
    if (kind === "closed-unmerged") response.merged = false;
    if (kind === "repository") response.base.repo.full_name = "foreign/project";
    if (kind === "head-repository") response.head.repo.full_name = "fork/indra";
    if (kind === "base") response.base.ref = "main";
    if (kind === "head") response.head.ref = `${BRANCH}-other`;
    if (kind === "url") response.html_url = "https://github.com/satoramoto/indra/pull/10";
    if (kind === "number") response.number = 10;
    if (kind === "merged-at") response.merged_at = "unknown";
    run.mockResolvedValue({ code: kind === "github-error" ? 1 : 0, stdout: kind === "malformed" ? "invalid JSON" : JSON.stringify(response), stderr: "private command detail" });
    if (kind === "throws") run.mockRejectedValue(new Error("private command detail"));
    const before = git(store.checkout, "rev-parse", "HEAD");
    expect(await maintain()).toBe(false);
    expect(await assignment()).toMatchObject({ status: "failed", note: "ci: interrupted" });
    expect(git(store.checkout, "rev-parse", "HEAD")).toBe(before);
    expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(record);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["foreign-url", "no-project", "unowned", "unknown", "retained-pr", "missing", "symlink"])("requires an owned current attempt and configured PR for %s records", async (kind) => {
    const { store, record, run, maintain, assignment, archive } = await fixture();
    if (kind === "foreign-url") await store.update((state) => { state.planningGoals![0].assignments![0].prUrl = "https://github.com/foreign/project/pull/9"; }, "Change PR");
    if (kind === "no-project") await store.update((state) => { delete (state.teams[0] as { project?: object }).project; }, "Remove project");
    if (kind === "unowned") await store.saveRuntime(NAME, { ...record, branch: "seat-003/goal-abc-outcome-1" });
    if (kind === "unknown") await store.saveRuntime(NAME, { ...record, extraRecoveryData: true });
    if (kind === "retained-pr") await store.saveRuntime(NAME, { ...record, prUrl: "https://github.com/satoramoto/indra/pull/10", retainedPrUrl: PR });
    if (kind === "missing") await rm(join(store.runtimeDir, `${NAME}.json`));
    if (kind === "symlink") {
      const target = await archive();
      await rm(join(store.runtimeDir, `${NAME}.json`));
      await symlink(target, join(store.runtimeDir, `${NAME}.json`));
    }
    expect(await maintain()).toBe(false);
    expect((await assignment()).status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("can verify an unambiguous archived attempt when the primary is missing", async () => {
    const { store, record, run, maintain, assignment, archive } = await fixture();
    const suffix = `-attempt-${randomUUID()}`;
    const archived = await archive({ ...record, branch: `${BRANCH}${suffix}`, worktree: `${record.worktree}${suffix}` });
    await rm(join(store.runtimeDir, `${NAME}.json`));
    const response = mergedPR(); response.head.ref += suffix;
    run.mockResolvedValue({ code: 0, stdout: JSON.stringify(response), stderr: "" });
    expect(await maintain()).toBe(true);
    expect((await assignment()).status).toBe("merged");
    expect(JSON.parse(await readFile(archived, "utf8")).sessions).toEqual([SESSION]);
  });

  it("preserves ambiguous archived attempts", async () => {
    const { store, record, run, maintain, archive } = await fixture();
    await archive();
    const suffix = `-attempt-${randomUUID()}`;
    await archive({ ...record, branch: `${BRANCH}${suffix}`, worktree: `${record.worktree}${suffix}` });
    await rm(join(store.runtimeDir, `${NAME}.json`));
    expect(await maintain()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["status", "timestamp", "pr", "seat", "repository", "proposal", "integration", "runtime"])("refuses stale GitHub results after concurrent %s replacement", async (kind) => {
    const { store, record, run, maintain, assignment, archive } = await fixture();
    const saved = await archive();
    run.mockImplementation(async () => {
      if (kind === "runtime") await store.saveRuntime(NAME, { ...record, sessions: [] });
      else await store.update((state) => {
        const goal = state.planningGoals![0]; const target = goal.assignments![0];
        if (kind === "status") target.status = "queued";
        if (kind === "timestamp") target.updatedAt = "2026-01-03T00:00:00Z";
        if (kind === "pr") target.prUrl = "https://github.com/satoramoto/indra/pull/10";
        if (kind === "seat") target.seatId = "seat-003";
        if (kind === "repository") (state.teams[0] as { project: { github: string } }).project.github = "other/project";
        if (kind === "proposal") goal.proposal!.id = "proposal-2";
        if (kind === "integration") delete goal.integration;
      }, "Concurrent replacement");
      return { code: 0, stdout: JSON.stringify(mergedPR()), stderr: "" };
    });
    await maintain();
    expect((await assignment()).status).toBe(kind === "status" ? "queued" : "failed");
    expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(record);
  });

  it("deduplicates accumulated equivalent archives but keeps unique and unmerged recovery metadata", async () => {
    const { store, record, run, maintain, archive } = await fixture();
    const response = mergedPR(); response.merged = false;
    run.mockResolvedValue({ code: 0, stdout: JSON.stringify(response), stderr: "" });
    for (let index = 0; index < 8; index++) await archive(index % 2 ? { ...record } : Object.fromEntries(Object.entries(record).reverse()));
    const unique = await archive({ ...record, sessions: [{ ...SESSION, usage: { tokens: 11 } }] });
    const otherPR = await archive({ ...record, prUrl: "https://github.com/satoramoto/indra/pull/8" });
    await maintain();
    const archives = (await readdir(store.runtimeDir)).filter((file) => file.includes("-retained-"));
    expect(archives).toHaveLength(3);
    expect(JSON.parse(await readFile(unique, "utf8")).sessions[0].usage).toEqual({ tokens: 11 });
    expect(JSON.parse(await readFile(otherPR, "utf8")).prUrl).toContain("/8");
    const after = git(store.checkout, "rev-parse", "HEAD");
    await maintain();
    expect((await readdir(store.runtimeDir)).filter((file) => file.includes("-retained-"))).toEqual(archives);
    expect(git(store.checkout, "rev-parse", "HEAD")).toBe(after);
  });

  it.each(["queued", "running", "in-review"] as const)("does not touch active %s recovery records", async (status) => {
    const { record, run, maintain, archive } = await fixture(status);
    const files = [await archive(), await archive()];
    await maintain();
    for (const file of files) expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
    expect(run).not.toHaveBeenCalled();
  });

  it("prunes only superseded archives after durable merge, preserving unknown, foreign, symlinked and unique records and all work", async () => {
    const { store, record, run, maintain, archive } = await fixture("merged");
    const obsolete = await archive();
    await store.saveRuntime(NAME, { ...record, step: "done", sessions: [SESSION, { ...SESSION, sessionId: "session-2" }] });
    const preserved = [
      await archive({ ...record, unique: true }), await archive({ ...record, unique: true }),
      await archive({ ...record, outcomeId: "outcome-2" }), await archive({ ...record, branch: "seat-003/goal-abc-outcome-1" }),
      await archive({ ...record, worktree: "/foreign/path" }), await archive({ ...record, gitDir: "/foreign/.git" }),
      await archive({ ...record, sessions: [{ ...SESSION, extra: true }] }),
      await archive({ ...record, sessions: [{ ...SESSION, sessionId: "unique" }] }),
      await archive({ ...record, findings: ["unique finding"] }),
      await archive({ ...record, prUrl: "https://github.com/satoramoto/indra/pull/8" }),
      await archive(record, `${NAME}-retained-unknown-name`),
    ];
    const linked = join(store.runtimeDir, `${NAME}-retained-${randomUUID()}.json`);
    const linkTarget = join(store.checkout, "foreign-runtime.json");
    await writeFile(linkTarget, JSON.stringify(record));
    await symlink(linkTarget, linked);
    const hardlinked = await archive();
    await link(hardlinked, join(store.runtimeDir, "foreign-hardlink.json"));
    preserved.push(hardlinked);
    const malformed = await archive(); await writeFile(malformed, "not json"); preserved.push(malformed);
    const contents = await Promise.all(preserved.map((file) => readFile(file, "utf8")));
    git(store.checkout, "branch", BRANCH);
    git(store.checkout, "worktree", "add", "--quiet", record.worktree, BRANCH);
    await writeFile(join(record.worktree, "unfinished.txt"), "uncommitted work");
    await maintain();
    await expect(lstat(obsolete)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(linked, "utf8"))).toEqual(record);
    expect(await Promise.all(preserved.map((file) => readFile(file, "utf8")))).toEqual(contents);
    expect(git(store.checkout, "show-ref", "--verify", `refs/heads/${BRANCH}`)).toContain(BRANCH);
    expect(git(record.worktree, "branch", "--show-current").trim()).toBe(BRANCH);
    expect(await readFile(join(record.worktree, "unfinished.txt"), "utf8")).toBe("uncommitted work");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a symlinked runtime directory", async () => {
    const { store, record, maintain, archive } = await fixture("merged");
    const file = await archive();
    const actual = `${store.runtimeDir}-actual`;
    await rename(store.runtimeDir, actual);
    await symlink(actual, store.runtimeDir);
    await maintain();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
  });

  it("does not add another identical archive when repeatedly retaining an unrecognized record", async () => {
    const { store } = await fixture();
    const unknown = { recovery: "unique metadata", sessions: [{ unexpected: true }] };
    await retainSeatRecord(store, NAME, unknown);
    await retainSeatRecord(store, NAME, { sessions: unknown.sessions, recovery: unknown.recovery });
    expect((await readdir(store.runtimeDir)).filter((file) => file.includes("-retained-"))).toHaveLength(1);
  });

  it.each(["before-write", "commit", "after-commit"])("preserves archives when persistence fails %s and retries safely", async (failure) => {
    const { store, record, maintain, assignment, archive } = await fixture();
    const files = [await archive(), await archive()];
    const update = store.update.bind(store);
    const spy = vi.spyOn(store, "update");
    if (failure === "before-write") spy.mockRejectedValueOnce(new Error("write unavailable"));
    if (failure === "after-commit") spy.mockImplementationOnce(async (...args) => { await update(...args); throw new Error("post-commit cleanup failed"); });
    const hook = join(store.checkout, ".git", "hooks", "pre-commit");
    if (failure === "commit") await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await maintain();
    expect((await assignment()).status).toBe(failure === "after-commit" ? "merged" : "failed");
    for (const file of files) expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
    expect(JSON.parse(git(store.checkout, "show", "HEAD:state.json")).planningGoals[0].assignments[0]).toEqual(await assignment());
    spy.mockRestore();
    if (failure === "commit") await rm(hook);
    await maintain();
    expect((await assignment()).status).toBe("merged");
    for (const file of files) await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not prune a merged-looking state that is not durably committed", async () => {
    const { store, record, maintain, archive } = await fixture();
    const file = await archive();
    const state = await store.read(); state.planningGoals![0].assignments![0].status = "merged";
    await writeFile(join(store.checkout, "state.json"), JSON.stringify(state));
    await maintain();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
    expect(JSON.parse(git(store.checkout, "show", "HEAD:state.json")).planningGoals[0].assignments[0].status).toBe("failed");
  });

  it("rechecks assignment state under the cleanup lock", async () => {
    const { store, record, maintain, archive } = await fixture("merged");
    const file = await archive();
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementationOnce(async (...args) => {
      await update((state) => { state.planningGoals![0].assignments![0].status = "queued"; }, "Concurrent retry");
      await update(...args);
    });
    await maintain();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
  });
});
