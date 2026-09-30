import { accountedFailure } from "./circuit-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// These integration cases exercise durable accounting plus real Git/process supervision.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeveloperSeat, type Shell } from "../src/developer-seat.js";
import { DeveloperGoal, developerGoalJournalName } from "../src/developer-goal.js";
import { changedPaths, type LaneJournal } from "../src/developer-lanes.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import { goalRuntimeFilename, type GoalBrief, type GoalRuntimeRecord, type LanePlan, type WorkflowEvent } from "../src/goal-contract.js";
import { processShell } from "../src/command-shell.js";
import type { AgentRuntime, WriteAccess } from "../src/codex-runtime.js";
import { stateCheckout } from "./state-checkout.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
vi.setConfig({ testTimeout: 60_000 });
const at = "2026-09-01T00:00:00Z";
const goalId = "goal-whole";
const repo = "test/project";
const sprint = `sprint/${goalId}`;
const seatId = "seat-003";
const ready = { version: 1 as const, consumers: { planning: 1 as const, developer: 1 as const, release: 1 as const, retro: 1 as const, tui: 1 as const } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const event = (kind: "startup" | "retry" = "startup"): WorkflowEvent => kind === "startup" ? { kind, teamId: "team-one", at } : { kind, id: `retry-${Date.now()}`, teamId: "team-one", goalId, reason: "Explicit recovery", at };
const summary = { summary: "Implemented owned outcome", decisions: ["Host owns Git and checks"], followUps: [], neededButUnowned: [] };
interface Pull { url: string; branch: string; base: string; head: string; merged: boolean; mergedSha: string | null; comments: { body: string }[]; reviews: { id: number; user: { login: string }; state: string; commit_id: string; body: string }[] }

class LocalGitHub implements Shell {
  bodies: string[] = [];
  prs = new Map<string, Pull>(); calls: { command: string; args: string[]; cwd: string }[] = [];
  ci = "pending"; failLog = "tests/a.test.ts: expected 2, got 1";
  tamperBase = false; tamperHead = false; loseCreate = false;
  localChecks: "typecheck" | "tests" | null = null; keepLocalFailure = false;
  constructor(readonly project: string) {}
  async run(command: string, args: string[], cwd: string) {
    this.calls.push({ command, args, cwd });
    const ok = (stdout = "", code = 0) => ({ code, stdout, stderr: "" });
    if (command === "ps") return ok();
    if (command === "npm" || (command === "env" && args[0] === "NODE_OPTIONS=--experimental-ffi")) {
      // Exercise production check handling with real failing/passing subprocesses and the agents' actual source edits.
      if (this.localChecks && command === "npm" && args.join(" ") === "run typecheck") return processShell.run(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "--noEmit", "--skipLibCheck", "src/a.ts"], cwd);
      if (this.localChecks && command === "env") return processShell.run(process.execPath, ["--test", ...args.slice(4)], cwd);
      return ok("fixture checks completed");
    }
    if (command === "git") {
      if (args.join(" ") === "remote get-url origin") return ok(`https://github.com/${repo}.git`);
      return processShell.run(command, ["-c", "commit.gpgsign=false", ...args], cwd);
    }
    if (command === "env") { command = args[1]; args = args.slice(2); }
    if (command !== "gh") throw new Error(`Unexpected fixture command ${command}`);
    if (args[0] === "run") return ok(this.failLog);
    if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([...this.prs.values()].filter((pr) => pr.branch === args[args.indexOf("--head") + 1]).map(({ url }) => ({ url }))));
    if (args[0] === "pr" && args[1] === "create") {
      this.bodies.push(await readFile(args[args.indexOf("--body-file") + 1], "utf8"));
      const branch = args[args.indexOf("--head") + 1]; const url = `https://github.com/${repo}/pull/${this.prs.size + 1}`;
      const head = git(this.project, "rev-parse", branch); const base = git(this.project, "rev-parse", sprint);
      this.prs.set(url, { url, branch, head, base, merged: false, mergedSha: null, comments: [], reviews: [] });
      if (this.loseCreate) { this.loseCreate = false; throw new Error("Lost create response"); }
      return ok(url);
    }
    if (args[0] === "api" && args[1] === "user") return ok("satori-miyamoto");
    let pr: Pull | undefined;
    if (args[0] === "pr") pr = this.prs.get(args[2]);
    if (args[0] === "api") { const number = /\/(?:pulls|issues)\/(\d+)/.exec(args[1])?.[1]; pr = this.prs.get(`https://github.com/${repo}/pull/${number}`); }
    if (!pr) throw new Error(`No fixture PR for ${args.join(" ")}`);
    pr.head = git(this.project, "rev-parse", pr.branch);
    if (args[0] === "pr" && args[1] === "edit") { this.bodies.push(await readFile(args[args.indexOf("--body-file") + 1], "utf8")); return ok(); }
    if (args[0] === "pr" && args[1] === "checks") return ok(JSON.stringify([{ name: "checks", bucket: this.ci, link: `https://github.com/${repo}/actions/runs/8/job/9` }]), this.ci === "pass" ? 0 : this.ci === "pending" ? 8 : 1);
    if (args[0] === "pr" && args[1] === "merge") {
      expect(args).toEqual(["pr", "merge", pr.url, "--squash", "--match-head-commit", pr.head]);
      git(this.project, "switch", sprint); git(this.project, "merge", "--squash", pr.branch); git(this.project, "commit", "-m", `Merge ${pr.branch}`);
      pr.mergedSha = git(this.project, "rev-parse", "HEAD"); pr.merged = true;
      git(this.project, "push", "origin", sprint); git(this.project, "switch", "main"); return ok();
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("--jq")) return ok(pr.head);
      return ok(JSON.stringify({ state: pr.merged ? "MERGED" : "OPEN", headRefOid: pr.head, isDraft: false, author: { login: "owner" }, mergeCommit: pr.mergedSha ? { oid: pr.mergedSha } : null, reviewDecision: "" }));
    }
    if (args[0] === "api" && args[1].includes("/comments")) {
      if (args.includes("POST")) { pr.comments.push(JSON.parse(await readFile(args.at(-1)!, "utf8"))); return ok(); }
      return ok(JSON.stringify([pr.comments]));
    }
    if (args[1].includes("/reviews") && args.includes("POST")) {
      const input = JSON.parse(await readFile(args.at(-1)!, "utf8"));
      pr.reviews.push({ id: pr.reviews.length + 1, user: { login: "satori-miyamoto" }, state: input.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: input.commit_id, body: input.body }); return ok();
    }
    if (args[1].includes("/reviews")) return ok(JSON.stringify([pr.reviews]));
    const diff = execFileSync("git", ["diff", "--name-status", "-z", "-M", `${pr.base}...${pr.head}`, "--"], { cwd: this.project, encoding: "utf8" });
    const files = changedPaths(diff).map((filename) => ({ filename }));
    if (args[1].includes("/files?")) return ok(JSON.stringify([files]));
    return ok(JSON.stringify({ html_url: pr.url, number: Number(pr.url.split("/").at(-1)), state: pr.merged ? "closed" : "open", merged: pr.merged, draft: false, merge_commit_sha: pr.mergedSha, changed_files: files.length, mergeable: true,
      base: { ref: this.tamperBase ? "main" : sprint, sha: pr.base, repo: { full_name: repo } }, head: { ref: pr.branch, sha: this.tamperHead ? "e".repeat(40) : pr.head, repo: { full_name: repo } } }));
  }
}

async function fixture(lanes = 1) {
  const storeRoot = await stateCheckout("indra-whole-goal-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [] }); roots.push(storeRoot, `${storeRoot}.runtime`);
  const store = new PlanningStore(storeRoot, undefined, ready);
  const project = join(store.runtimeDir, "projects/test/project"); const remote = join(store.runtimeDir, "fixture-remote.git");
  await mkdir(join(project, "src"), { recursive: true }); await mkdir(join(project, "tests"));
  git(project, "init", "--initial-branch=main"); git(project, "config", "user.name", "Fixture"); git(project, "config", "user.email", "fixture@example.test"); git(project, "config", "commit.gpgsign", "false");
  await writeFile(join(project, "src/a.ts"), "export const value = 1;\n"); await writeFile(join(project, "src/b.ts"), "export const other = 1;\n");
  await writeFile(join(project, "tests/a.test.ts"), "// original a test\n"); await writeFile(join(project, "tests/b.test.ts"), "// original b test\n");
  git(project, "add", "."); git(project, "commit", "-m", "Fixture source"); const baseSha = git(project, "rev-parse", "HEAD");
  git(project, "branch", sprint); git(project, "init", "--bare", remote); git(project, "remote", "add", "origin", remote); git(project, "push", "origin", "main", sprint);
  const outcomes = [{ number: 1, title: "Implement", description: "Deliver the requested source change with regression coverage", reason: "Mission", currentCode: ["src/a.ts"] }];
  const goal: PlanningGoal = { workflowModel: "goals-v1", id: goalId, teamId: "team-one", seatId: "seat-001", participantSeatIds: [], goal: "Implement", projectRefs: [repo], stage: "approved", createdAt: at, updatedAt: at, mattermost: { channelId: "home", rootPostId: "proposal-root" }, brief: { summary: "Implement", decisions: [], openQuestions: [] }, ownedFiles: ["src/**", "tests/**"], goalProposal: { version: 1, goalId, proposalId: "proposal-one", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "Implement", outcomes, ownedFiles: ["src/**", "tests/**"], risks: [], rationale: "Mission", basedOnRetros: [] }, goalAssignment: { seatId, status: "assigned", updatedAt: at }, integration: { branch: sprint, baseSha, status: "collecting" }, ceremony: { version: 1, stage: "implement", history: [
    { stage: "planning", enteredAt: at }, { stage: "proposal", enteredAt: at }, { stage: "implement", enteredAt: at, evidence: { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-root", approval: { source: "owner-command", command: "planning approve", at } } },
  ] } };
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-one", slug: "fixture", displayName: "Fixture", workflowModel: "goals-v1", project: { github: repo }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
    { id: "seat-001", displayName: "Lead", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "lead", username: "lead" } } },
    { id: "seat-002", displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { userId: "product", username: "product" } } },
    { id: seatId, displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer", username: "developer" } } },
  ] }], planningGoals: [goal] };
  await writeFile(join(storeRoot, "state.json"), JSON.stringify(state)); git(storeRoot, "add", "state.json"); git(storeRoot, "commit", "-m", "Approved fixture goal");
  await mkdir(join(storeRoot, "schema/v1"), { recursive: true }); await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(storeRoot, "schema/v1/state.schema.json"));
  const brief: GoalBrief = { version: 1, goalId, teamId: "team-one", seatId, header: { repo, baseBranch: "main", baseSha, branch: sprint, prTarget: "main" }, outcomes, ownedFiles: goal.ownedFiles!, exclusions: [{ files: ["docs/**"], owner: "Other goal", reason: "Out of scope" }], swarm: "Use single-file workers", retros: [], redirects: [], reportFormat: "PR URL, immutable head, exact checks/exits, Decisions, Follow-ups, needed-but-unowned" };
  const record: GoalRuntimeRecord = { version: 1, goalId, teamId: "team-one", assignment: goal.goalAssignment!, brief, plan: null, lanes: [], report: null, events: [], handledEventIds: [], redirects: [], failure: null, updatedAt: at };
  await store.saveRuntime(goalRuntimeFilename(goalId), record);
  const plan: LanePlan = { version: 1, goalId, contractLaneId: lanes > 1 ? "contract" : null, lanes: lanes > 1 ? [
    { id: "contract", branch: `codex/${goalId}/contract`, ownedFiles: ["src/a.ts", "tests/a.test.ts"], dependsOn: [] },
    { id: "second", branch: `codex/${goalId}/second`, ownedFiles: ["src/b.ts", "tests/b.test.ts"], dependsOn: ["contract"] },
  ] : [{ id: "code", branch: `codex/${goalId}/code`, ownedFiles: ["src/**", "tests/**"], dependsOn: [] }] };
  const shell = new LocalGitHub(project);
  const calls: { role: string; write?: WriteAccess; cwd: string; prompt: string; session?: string }[] = [];
  let findings = false; let failLead = false; let failFix = false; let failWorkers = false;
  let workerFiles: string[] | undefined;
  let workerHook: ((file: string) => Promise<void>) | undefined;
  const fixDrafts: string[] = [];
  const workerDecisions = ["Worker preserved source compatibility"];
  const workerFollowUps = ["Worker suggests a separate migration"];
  const planDecisions = ["Lead plan isolates one source file"];
  const planFollowUps = ["Lead plan leaves a documented follow-up"];
  const runtimeFor = (cwd: string, write?: WriteAccess): AgentRuntime => ({ message: async (prompt, _schema, session, options) => {
    options?.onUsage?.({ inputTokens: 1, outputTokens: 1 });
    const role = options!.purpose!; calls.push({ role, write, cwd, prompt, session });
    const second = prompt.includes(`Branch: codex/${goalId}/second`); const file = second ? "b" : "a";
    let response: unknown = summary;
    if (role === "planner") response = plan;
    if (role === "lead-plan" && failWorkers) { failWorkers = false; throw accountedFailure("Planning failed with terminal usage"); }
    if (role === "lead-plan") response = { workers: (workerFiles ?? [`src/${file}.ts`]).map((path) => ({ file: path, task: "Implement source" })), decisions: planDecisions, followUps: planFollowUps };
    if (role === "worker") {
      const path = /Own exactly ([^ ]+)\. Task:/.exec(prompt)![1]; try { await workerHook?.(path); } catch (error) { throw accountedFailure(error instanceof Error ? error.message : "Simulated terminal worker failure"); }
      response = { ...summary, decisions: workerDecisions, followUps: workerFollowUps, content: shell.localChecks === "typecheck" ? 'export const value: number = "broken";\n' : `export const ${second ? "other" : "value"} = 2;\n` };
    }
    if (role === "lead") {
      if (failLead) { failLead = false; await writeFile(join(cwd, `src/${file}.ts`), "export const value = 7;\n"); throw accountedFailure("Interrupted lead"); }
      await writeFile(join(cwd, `tests/${file}.test.ts`), shell.localChecks ? 'import { strict as assert } from "node:assert";\nimport test from "node:test";\nimport { value } from "../src/a.ts";\ntest("value is recovered", () => assert.equal(value, 3));\n' : "// regression coverage fixture\n");
    }
    if (role === "fix") {
      fixDrafts.push(await readFile(join(cwd, `src/${file}.ts`), "utf8"));
      await writeFile(join(cwd, `src/${file}.ts`), shell.keepLocalFailure ? (shell.localChecks === "typecheck" ? 'export const value: number = "still broken";\n' : "export const value = 4;\n") : "export const value = 3;\n");
      if (failFix) { failFix = false; throw accountedFailure("Interrupted fix"); }
      shell.ci = "pass";
    }
    if (role === "reviewer") { response = { findings: findings ? [`src/${file}.ts:1: Exact bug requiring regression`] : [], summary: "Reviewed" }; findings = false; }
    return { sessionId: `session-${calls.length}`, response, usage: { inputTokens: 1, outputTokens: 1 }, startedAt: at, finishedAt: at };
  } });
  const runner = () => new DeveloperSeat(store, { id: seatId, displayName: "Developer", username: "developer", roles: ["Developer"] }, { post: vi.fn() }, shell, runtimeFor);
  const current = () => store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename(goalId));
  const ciEvent = async (name = "ci-one"): Promise<Extract<WorkflowEvent, { kind: "ci" }>> => { const lane = (await current())!.lanes.find((item) => item.status !== "merged")!; return { kind: "ci", id: name, teamId: "team-one", goalId, laneId: lane.id, prUrl: lane.prUrl!, headSha: lane.headSha!, state: "passed", at }; };
  return { store, shell, calls, runner, current, ciEvent, plan, brief, runtimeFor, fixDrafts, workerDecisions, workerFollowUps, planDecisions, planFollowUps,
    failWorkerPlanning: () => { failWorkers = true; },
    setWorkers: (files: string[], hook: (file: string) => Promise<void>) => { workerFiles = files; workerHook = hook; }, failFix: () => { failFix = true; }, setFindings: () => { findings = true; }, failLead: () => { failLead = true; } };
}

describe("finite production Developer goal orchestration", () => {
  it("charges only the retried planner when workers and lead have not run before", async () => {
    const f = await fixture();
    await writeFile(join(f.store.runtimeDir, "circuit-policy.json"), JSON.stringify({ maxPhaseRetries: 1 }));
    f.failWorkerPlanning();
    await f.runner().turn(event());
    expect((await f.current())!.failure).not.toBeNull();
    await f.runner().turn(event("retry"));
    expect((await f.current())!.failure).toBeNull();
    expect(f.calls.map((call) => call.role)).toEqual(["planner", "lead-plan", "lead-plan", "worker", "lead", "reviewer"]);
  });
  it("persists a token trip from the real goal runner and rejects ordinary retry without starting more work", async () => {
    const f = await fixture();
    await writeFile(join(f.store.runtimeDir, "circuit-policy.json"), JSON.stringify({ maxTokens: 1 }));
    await f.runner().turn(event());
    expect((await f.current())!.failure).toMatchObject({ retryable: false, message: expect.stringContaining("Circuit open") });
    expect(f.calls).toHaveLength(1);
    await expect(f.runner().turn(event("retry"))).rejects.toThrow("Circuit open");
    expect(f.calls).toHaveLength(1);
  });
  it("executes actual one-file workers/leads and fresh reviews before CI, then reports only an observed merged sprint", async () => {
    const f = await fixture(); const first = await f.runner().turn(event());
    expect(first.report).toBeNull(); expect((await f.current())!.failure).toBeNull();
    expect(f.calls.map((call) => call.role)).toEqual(["planner", "lead-plan", "worker", "lead", "reviewer"]);
    expect(f.calls.filter((call) => ["worker", "reviewer", "planner", "lead-plan"].includes(call.role)).every((call) => !call.write)).toBe(true);
    expect(f.calls.every((call) => call.session === undefined && call.prompt.includes("Outcome (what must be true when done)"))).toBe(true);
    expect(f.shell.prs.size).toBe(1); expect([...f.shell.prs.values()][0].comments[0].body).toContain("Independent agent review: APPROVE");
    expect([...f.shell.prs.values()][0].reviews).toEqual([]);
    expect(f.shell.calls.some((call) => call.args.some((arg) => arg.startsWith("GH_CONFIG_DIR=")) || call.args.some((arg) => arg.includes("/protection") || arg.includes("CODEOWNERS")))).toBe(false);
    expect(f.shell.calls.some((call) => call.args.includes("--watch") || call.args.includes("--auto"))).toBe(false);
    const pending = await f.runner().turn(await f.ciEvent("untrusted-pass"));
    expect(pending.report).toBeNull(); expect(f.shell.calls.some((call) => call.args[0] === "pr" && call.args[1] === "merge")).toBe(false);
    f.shell.ci = "pass"; const done = await f.runner().turn(await f.ciEvent());
    expect(done.report?.lanePrs).toHaveLength(1); expect(done.report?.checks.map((check) => check.exitCode)).toEqual([0, 0, 0]);
    expect(done.report?.lanePrs[0].reviewer).toBe("independent-agent"); expect((await f.store.read()).planningGoals![0].goalAssignment!.status).toBe("reported");
    expect(done.events.some((item) => item.kind === "developer-report")).toBe(true);
    const before = f.calls.length; const replay = await f.runner().turn({ kind: "approval", id: "replay-report", teamId: "team-one", goalId, at });
    expect(replay.report).toEqual(done.report); expect(f.calls).toHaveLength(before);
    expect(f.shell.calls.some((call) => call.command === "ps")).toBe(true);
    expect(f.shell.calls.filter((call) => call.command === "git" && call.args.slice(0, 2).join(" ") === "worktree remove").every((call) => !call.args.includes("--force"))).toBe(true);
  });
  it.each(["typecheck", "tests"] as const)("repairs an actual initial %s failure once, validates the changed head and reports without owner retry", async (check) => {
    const f = await fixture(); f.shell.localChecks = check;
    const done = await f.runner().turn(event());
    expect((await f.current())!.failure).toBeNull(); expect(done.report).not.toBeNull();
    expect(f.calls.map((call) => call.role)).toEqual(["planner", "lead-plan", "worker", "lead", "fix", "reviewer"]);
    const journal = (await f.store.readRuntimeFile<{ lanes: Record<string, LaneJournal> }>(developerGoalJournalName(goalId)))!.lanes.code;
    const failed = journal.checks.filter((item) => item.exitCode !== 0); expect(failed).toHaveLength(1);
    expect(failed[0].diagnostic).toContain(check === "typecheck" ? "TS2322" : "2 !== 3");
    expect(f.calls.find((call) => call.role === "fix")!.prompt).toContain(`${failed[0].command} exited ${failed[0].exitCode}:\n${failed[0].diagnostic}`);
    expect(f.calls.find((call) => call.role === "fix")!.prompt).toContain("fails without the fix");
    expect(journal.fixAttempts!.map((attempt) => attempt.status)).toEqual(["complete"]);
    expect((await f.current())!.lanes[0].fixRounds).toBe(1);
    expect(failed[0].headSha).not.toBe(done.report!.lanePrs[0].headSha);
    expect(done.report!.checks.map((item) => item.exitCode)).toEqual([0, 0, 0]);
    expect(f.shell.prs.size).toBe(1); expect([...f.shell.prs.values()][0].merged).toBe(true);
    const replay = await f.runner().turn({ kind: "approval", id: "local-check-replay", teamId: "team-one", goalId, at });
    expect(replay.report).toEqual(done.report); expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(1);
  });
  it("recovers a published automatic fix after its journal write without duplicating the fix or PR", async () => {
    const f = await fixture(); f.shell.localChecks = "tests";
    const save = f.store.saveRuntime.bind(f.store); let interrupted = false;
    const saves = vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      await save(name, value);
      if (!interrupted && name === developerGoalJournalName(goalId) && (value as { lanes: Record<string, LaneJournal> }).lanes.code?.prUrl) {
        interrupted = true; throw new Error("Interrupted after published journal write");
      }
    });
    await expect(f.runner().turn(event())).rejects.toThrow("Interrupted after published journal write"); saves.mockRestore();
    expect((await f.current())!.lanes[0].prUrl).toBeNull(); expect(f.shell.prs.size).toBe(1);
    const done = await f.runner().turn(event());
    expect((await f.current())!.failure).toBeNull(); expect(done.report?.lanePrs[0].url).toBe([...f.shell.prs.keys()][0]);
    expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(1); expect(f.shell.prs.size).toBe(1);
  });
  it("bounds persistent local failure across event replay and restart after the fix journal was saved", async () => {
    const f = await fixture(); f.shell.localChecks = "tests"; f.shell.keepLocalFailure = true;
    expect((await f.runner().turn(event())).report).toBeNull();
    expect((await f.current())!.failure).not.toBeNull(); expect(f.shell.prs.size).toBe(0);
    const journal = (await f.store.readRuntimeFile<{ lanes: Record<string, LaneJournal> }>(developerGoalJournalName(goalId)))!.lanes.code;
    const failed = journal.checks.filter((item) => item.exitCode !== 0);
    expect(failed).toHaveLength(2); expect(new Set(failed.map((item) => item.headSha)).size).toBe(2);
    expect(journal.fixAttempts!.map((attempt) => attempt.status)).toEqual(["failed"]);
    const before = f.calls.length; const checks = f.shell.calls.filter((call) => call.command === "env" && call.args[0] === "NODE_OPTIONS=--experimental-ffi").length;
    await f.runner().turn(event());
    await f.runner().turn({ kind: "approval", id: "failed-check-replay", teamId: "team-one", goalId, at });
    expect(f.calls).toHaveLength(before);
    // Model a crash after the fix/check journal write but before the public failure write.
    const record = (await f.current())!; record.failure = null; await f.store.saveRuntime(goalRuntimeFilename(goalId), record);
    expect((await f.runner().turn(event())).report).toBeNull();
    expect((await f.current())!.failure).not.toBeNull(); expect((await f.current())!.lanes[0].fixRounds).toBe(1);
    expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(1);
    expect(f.shell.calls.filter((call) => call.command === "env" && call.args[0] === "NODE_OPTIONS=--experimental-ffi")).toHaveLength(checks);
    expect(f.shell.prs.size).toBe(0);
  });
  it.each(["dependencies", "signal", "abort"])("does not turn a %s failure into an automatic code fix", async (failure) => {
    const f = await fixture(); const run = f.shell.run.bind(f.shell);
    vi.spyOn(f.shell, "run").mockImplementation(async (command, args, cwd) => {
      if (command === "npm" && args.join(" ") === (failure === "dependencies" ? "ci" : "run typecheck")) {
        if (failure === "abort") throw Object.assign(new Error("Check aborted"), { name: "AbortError" });
        return { code: failure === "signal" ? 130 : 1, stdout: "", stderr: "Check could not run" };
      }
      return run(command, args, cwd);
    });
    expect((await f.runner().turn(event())).report).toBeNull();
    expect((await f.current())!.failure).not.toBeNull(); expect(f.shell.prs.size).toBe(0);
    await f.runner().turn(event()); expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(0);
  });
  it("lands a declared contract before creating dependent isolated lanes from its merged sprint base", async () => {
    const f = await fixture(2); await f.runner().turn(event());
    expect(f.calls.filter((call) => call.role === "lead")).toHaveLength(1);
    f.shell.ci = "pass"; const merged = await f.runner().turn(await f.ciEvent());
    expect(merged.report).toBeNull(); expect((await f.current())!.lanes.map((lane) => lane.status)).toEqual(["merged", "queued"]);
    const mergeEvent = merged.events.find((item) => item.kind === "merge")!;
    const done = await f.runner().turn(mergeEvent);
    expect((await f.current())!.failure).toBeNull(); expect(done.report?.lanePrs).toHaveLength(2);
    const lead = f.calls.filter((call) => call.role === "lead"); expect(lead).toHaveLength(2); expect(lead[0].cwd).not.toBe(lead[1].cwd);
    expect(lead[1].prompt).toContain(`at ${merged.events.find((item) => item.kind === "merge")!.mergedSha}`);
  });
  it("dispatches one targeted fix for concrete review findings and re-reviews its changed head", async () => {
    const f = await fixture(); f.setFindings(); await f.runner().turn(event());
    expect((await f.current())!.failure).toBeNull();
    const fixes = f.calls.filter((call) => call.role === "fix"); expect(fixes).toHaveLength(1);
    expect(fixes[0].prompt).toContain("Exact bug requiring regression"); expect(fixes[0].prompt).toContain("fails without the fix");
    expect(f.calls.filter((call) => call.role === "reviewer")).toHaveLength(2);
    const done = await f.runner().turn(await f.ciEvent()); expect(done.report).not.toBeNull();
    expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(1);
  });
  it("explicitly retries an interrupted targeted fix with a fresh context and preserved draft", async () => {
    const f = await fixture(); f.setFindings(); f.failFix(); await f.runner().turn(event());
    expect((await f.current())!.failure).not.toBeNull(); expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(1);
    await f.runner().turn(event()); expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(1);
    await f.runner().turn(event("retry"));
    expect((await f.current())!.failure).toBeNull(); expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(2);
    expect(f.fixDrafts[1]).toBe("export const value = 3;\n");
    const journal = await f.store.readRuntimeFile<{ lanes: Record<string, LaneJournal> }>(developerGoalJournalName(goalId));
    expect(journal!.lanes.code.fixAttempts!.map((attempt) => attempt.status)).toEqual(["failed", "complete"]);
    expect(new Set(journal!.lanes.code.fixAttempts!.map((attempt) => attempt.key)).size).toBe(1);
    const done = await f.runner().turn(await f.ciEvent()); expect(done.report).not.toBeNull();
    await f.runner().turn(event("retry")); expect(f.calls.filter((call) => call.role === "fix")).toHaveLength(2);
  });
  it("settles every started worker before a failed turn releases its journal and goal lock", async () => {
    const f = await fixture(); let release!: () => void; let started!: () => void; let persisted!: () => void; let drained!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const siblingStarted = new Promise<void>((resolve) => { started = resolve; });
    const failedWorkerPersisted = new Promise<void>((resolve) => { persisted = resolve; });
    const siblingPersisted = new Promise<void>((resolve) => { drained = resolve; });
    // A fails only after both worker-start writes have settled, so its failure is the only pending writer.
    f.setWorkers(["src/a.ts", "src/b.ts"], async (file) => { if (file === "src/a.ts") { await siblingStarted; throw new Error("Failed worker"); } started(); await gate; });
    const save = f.store.saveRuntime.bind(f.store); let failedJournalSaved = false; let siblingJournalSaved = false; let failedPersistComplete = false; let writesAfterFailure = 0;
    const saves = vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      if (failedPersistComplete) writesAfterFailure++;
      const failedWorker = name === developerGoalJournalName(goalId) && (value as { lanes: Record<string, LaneJournal> }).lanes.code?.sessions.some((session) => session.key === "worker:0:src/a.ts" && session.status === "failed");
      const completedSibling = name === developerGoalJournalName(goalId) && (value as { lanes: Record<string, LaneJournal> }).lanes.code?.sessions.some((session) => session.key === "worker:0:src/b.ts" && session.status === "complete");
      await save(name, value);
      if (completedSibling) siblingJournalSaved = true;
      if (siblingJournalSaved && name === goalRuntimeFilename(goalId)) drained();
      if (failedWorker) failedJournalSaved = true;
      if (failedJournalSaved && name === goalRuntimeFilename(goalId) && !failedPersistComplete) { failedPersistComplete = true; persisted(); }
    });
    let settled = false; const turn = f.runner().turn(event()).finally(() => { settled = true; });
    await failedWorkerPersisted;
    // The completed failure-persist promise now unwinds without further I/O; drain its rejection continuations.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
      expect(writesAfterFailure).toBe(0); // A failed turn must not start finalizing while B still owns its context.
      expect((await f.current())!.failure).toBeNull();
    } finally { release(); await Promise.all([turn, siblingPersisted]); }
    expect((await f.current())!.failure).not.toBeNull();
    const journal = await f.store.readRuntimeFile<{ lanes: Record<string, LaneJournal> }>(developerGoalJournalName(goalId));
    expect(Object.fromEntries(journal!.lanes.code.sessions.filter((session) => session.role === "worker").map((session) => [session.key, session.status]))).toEqual({ "worker:0:src/a.ts": "failed", "worker:0:src/b.ts": "complete" });
    const writes = saves.mock.calls.length; await new Promise<void>((resolve) => setImmediate(resolve)); expect(saves).toHaveBeenCalledTimes(writes);
  });
  it("uses exact observed CI failure logs for a fix instead of believing an event's passing claim", async () => {
    const f = await fixture(); await f.runner().turn(event()); f.shell.ci = "fail";
    await f.runner().turn(await f.ciEvent());
    expect(f.calls.find((call) => call.role === "fix")!.prompt).toContain(f.shell.failLog);
    expect((await f.current())!.report).toBeNull();
    const done = await f.runner().turn(await f.ciEvent("ci-after-fix")); expect(done.report).not.toBeNull();
  });
  it.each(["base", "head"])("preserves work and reports no success for invalid %s evidence", async (problem) => {
    const f = await fixture(); await f.runner().turn(event()); f.shell.ci = "pass";
    if (problem === "base") f.shell.tamperBase = true;
    if (problem === "head") f.shell.tamperHead = true;
    const result = await f.runner().turn(await f.ciEvent());
    expect(result.report).toBeNull(); expect((await f.current())!.failure).not.toBeNull();
    expect([...f.shell.prs.values()][0].merged).toBe(false);
  });
  it("ignores stale or forged completion events and deduplicates accepted events across restart", async () => {
    const f = await fixture(); await f.runner().turn(event());
    const valid = await f.ciEvent(); const calls = f.shell.calls.length;
    await f.runner().turn({ ...valid, headSha: "f".repeat(40) });
    await f.runner().turn({ kind: "agent-completed", id: "forged", teamId: "team-one", goalId, laneId: "code", agentId: "not-ours", status: "succeeded", headSha: valid.headSha, report: null, at });
    expect(f.shell.calls).toHaveLength(calls);
    await f.runner().turn(valid); const after = f.shell.calls.length; await f.runner().turn(valid); expect(f.shell.calls).toHaveLength(after);
  });
  it("reserves integration conflicts for Scheduler and ignores lane events after reporting", async () => {
    const f = await fixture(); await f.runner().turn(event()); const pending = await f.ciEvent();
    const conflict: Extract<WorkflowEvent, { kind: "conflict" }> = { kind: "conflict", id: "integration-conflict", teamId: "team-one", goalId, laneId: "integration", prUrl: pending.prUrl, headSha: pending.headSha, baseSha: f.brief.header.baseSha, at };
    const before = (await f.current())!; const commands = f.shell.calls.length; const agents = f.calls.length;
    expect(await f.runner().turn(conflict)).toEqual({ events: [], report: null });
    expect(f.shell.calls).toHaveLength(commands); expect(f.calls).toHaveLength(agents); expect(await f.current()).toEqual(before);
    f.shell.ci = "pass"; const done = await f.runner().turn(pending); expect(done.report).not.toBeNull();
    const finished = (await f.current())!; const commandsAfter = f.shell.calls.length;
    expect(await f.runner().turn({ ...conflict, laneId: "code", id: "late-lane-conflict" })).toEqual({ events: [], report: null });
    expect(await f.runner().turn(conflict)).toEqual({ events: [], report: null });
    expect(f.shell.calls).toHaveLength(commandsAfter); expect(await f.current()).toEqual(finished);
  });
  it("rejects a planner claiming the Scheduler's integration lane", async () => {
    const f = await fixture(); f.plan.lanes[0].id = "integration"; f.plan.lanes[0].branch = `codex/${goalId}/integration`;
    expect((await f.runner().turn(event())).report).toBeNull();
    expect((await f.current())!.failure!.message).toContain("integration belongs to the Scheduler");
    expect(f.calls.map((call) => call.role)).toEqual(["planner"]); expect(f.shell.prs.size).toBe(0);
  });
  it("recovers a lost PR creation response without opening or building another lane", async () => {
    const f = await fixture(); f.shell.loseCreate = true; await f.runner().turn(event());
    expect((await f.current())!.failure).not.toBeNull(); expect(f.shell.prs.size).toBe(1);
    await f.runner().turn(event("retry"));
    expect((await f.current())!.failure).toBeNull(); expect(f.shell.prs.size).toBe(1); expect(f.calls.filter((call) => call.role === "lead")).toHaveLength(1);
  });
  it("keeps failed contexts and worker draft changes, requiring an explicit fresh recovery turn", async () => {
    const f = await fixture(); f.failLead(); await f.runner().turn(event());
    expect((await f.current())!.failure).not.toBeNull(); const count = f.calls.length;
    await f.runner().turn(event()); expect(f.calls).toHaveLength(count);
    await f.runner().turn(event("retry")); expect((await f.current())!.failure).toBeNull();
    expect(f.calls.filter((call) => call.role === "worker")).toHaveLength(1);
    expect(f.calls.filter((call) => call.role === "lead")).toHaveLength(2);
    const body = f.shell.bodies.at(-1)!;
    for (const value of [...f.workerDecisions, ...f.workerFollowUps, ...f.planDecisions, ...f.planFollowUps]) expect(body.split(value)).toHaveLength(2);
    const pr = [...f.shell.prs.values()][0]; expect(git(f.shell.project, "show", `${pr.head}:src/a.ts`)).toBe("export const value = 7;");
    f.shell.ci = "pass"; const done = await f.runner().turn(await f.ciEvent()); expect(done.report).not.toBeNull();
    expect(done.report!.decisions).toEqual([...f.planDecisions, ...f.workerDecisions, ...summary.decisions]);
    expect(done.report!.followUps).toEqual([...f.planFollowUps, ...f.workerFollowUps]);
  });
  it("rejects a brief that expands approved ownership before running any agent", async () => {
    const f = await fixture(); const record = (await f.current())!; record.brief!.ownedFiles = ["src/**", "tests/**", "extra/**"]; await f.store.saveRuntime(goalRuntimeFilename(goalId), record);
    await expect(f.runner().turn(event())).rejects.toThrow("differs from the approved"); expect(f.calls).toHaveLength(0);
  });
  it("refuses a forged saved report on replay instead of treating schema validity as delivery proof", async () => {
    const f = await fixture(); await f.runner().turn(event()); f.shell.ci = "pass";
    const done = await f.runner().turn(await f.ciEvent()); expect(done.report).not.toBeNull();
    const record = (await f.current())!; record.report!.headSha = "f".repeat(40); await f.store.saveRuntime(goalRuntimeFilename(goalId), record);
    await expect(f.runner().turn({ kind: "approval", id: "report-check", teamId: "team-one", goalId, at })).rejects.toThrow("verified sprint head");
  });
  it("does no work for another seat or unrelated event", async () => {
    const f = await fixture(); const runner = new DeveloperGoal(f.store, "seat-other", f.shell, f.runtimeFor);
    expect(await runner.turn(event())).toEqual({ events: [], report: null });
    expect(await f.runner().turn({ kind: "queue-changed", id: "queue", teamId: "team-one", at })).toEqual({ events: [], report: null });
    expect(f.calls).toHaveLength(0);
  });
});
