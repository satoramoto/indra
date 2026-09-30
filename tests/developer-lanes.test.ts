import { accountedFailure } from "./circuit-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

// This integration suite uses real Git and durable invocation accounting.
vi.setConfig({ testTimeout: 20_000 });
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { changedPaths, GitDeveloperLanes, requireLaneFiles, type LaneJournal } from "../src/developer-lanes.js";
import { applyLaneWorker, type GoalAgentSession } from "../src/seat-runtime.js";
import { PlanningStore } from "../src/planning.js";
import { processShell, type Shell } from "../src/command-shell.js";
import type { GoalBrief } from "../src/goal-contract.js";
import type { AgentRuntime, WriteAccess } from "../src/codex-runtime.js";
import { git, stateCheckout } from "./state-checkout.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const lane = { id: "code", branch: "codex/goal-one/code", ownedFiles: ["src/**"], dependsOn: [] };
describe("actual lane file boundaries", () => {
  it("checks both rename and copy paths, including an old name outside the owned scope", () => {
    const paths = changedPaths("R100\0private/old.ts\0src/new.ts\0M\0src/other.ts\0");
    expect(paths).toEqual(["private/old.ts", "src/new.ts", "src/other.ts"]);
    expect(() => requireLaneFiles(paths, lane, ["src/**", "private/**"])).toThrow("Needed but unowned");
    expect(changedPaths("C085\0src/old.ts\0src/copy.ts\0")).toEqual(["src/old.ts", "src/copy.ts"]);
    expect(() => requireLaneFiles(["src/future.ts"], lane, ["src/old.ts"])).toThrow();
    expect(() => requireLaneFiles(["src/future.ts"], lane, ["src/**"])).not.toThrow();
  });
  it.each(["M\0src/file.ts", "R100\0src/old.ts\0", "Z\0src/file.ts\0", "M\0../outside.ts\0"])("fails closed on uncertain diff evidence %j", (input) => {
    expect(() => changedPaths(input)).toThrow();
  });
  it("applies only the worker's single regular file and refuses symlink/traversal destinations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indra-worker-")); dirs.push(dir);
    await mkdir(join(dir, "src")); await writeFile(join(dir, "outside.ts"), "untouched");
    await applyLaneWorker(dir, "src/one.ts", "one");
    expect(await readFile(join(dir, "src/one.ts"), "utf8")).toBe("one");
    await symlink(join(dir, "outside.ts"), join(dir, "src/link.ts"));
    await expect(applyLaneWorker(dir, "src/link.ts", "escaped")).rejects.toThrow("regular file");
    await symlink(join(dir, "src"), join(dir, "shortcut"));
    await expect(applyLaneWorker(dir, "shortcut/one.ts", "escaped")).rejects.toThrow("symbolic link");
    await expect(applyLaneWorker(dir, "../outside.ts", "escaped")).rejects.toThrow();
    await expect(applyLaneWorker(dir, "src/*.ts", "escaped")).rejects.toThrow();
    expect(await readFile(join(dir, "outside.ts"), "utf8")).toBe("untouched");
    await applyLaneWorker(dir, "src/one.ts", null);
    await expect(readFile(join(dir, "src/one.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});


const workerSummary = { summary: "Implemented file", decisions: ["Preserved the public interface"], followUps: [], neededButUnowned: [] };
const workerResult = (file: string) => ({ ...workerSummary, content: `export const ${file.split("/").at(-1)!.slice(0, -3)} = "worker output";\n`, siblingDependencies: [] });
async function handoffFixture(count = 2) {
  const root = await stateCheckout("indra-worker-handoff-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [] });
  const store = new PlanningStore(root); dirs.push(root, store.runtimeDir);
  const project = join(store.runtimeDir, "projects/test/project"); const remote = join(store.runtimeDir, "fixture-remote.git");
  const files = Array.from({ length: count }, (_, index) => `src/${String.fromCharCode(97 + index)}.ts`);
  await mkdir(join(project, "src"), { recursive: true }); git(project, "init", "--quiet", "--initial-branch=main");
  for (const file of files) await writeFile(join(project, file), "original\n");
  git(project, "add", "."); git(project, "commit", "--quiet", "-m", "Fixture source"); const baseSha = git(project, "rev-parse", "HEAD").trim();
  git(project, "branch", "sprint/goal-one"); git(project, "init", "--quiet", "--bare", remote); git(project, "remote", "add", "origin", remote); git(project, "push", "--quiet", "origin", "main", "sprint/goal-one");
  const brief: GoalBrief = { version: 1, goalId: "goal-one", teamId: "team-one", seatId: "seat-003", header: { repo: "test/project", baseBranch: "sprint/goal-one", baseSha, branch: lane.branch, prTarget: "sprint/goal-one" },
    outcomes: [{ number: 1, title: "Deliver", description: "Integrate the assigned source files", reason: "Mission", currentCode: files }], ownedFiles: ["src/**"], exclusions: [{ files: ["private/**"], owner: "Repository owner", reason: "Unapproved scope" }], swarm: "Single-file workers", retros: [], redirects: [], reportFormat: "Exact checks, Decisions, Follow-ups, needed-but-unowned" };
  const plan = { workers: files.map((file) => ({ file, task: "Implement the assigned interface" })), decisions: ["One worker per file"], followUps: [] };
  const calls: { role: string; file?: string; prompt: string; session?: string; write?: WriteAccess }[] = [];
  const responses = new Map<string, unknown>(files.map((file) => [file, workerResult(file)]));
  const leadDrafts: Record<string, string>[] = [];
  let leadHook: ((cwd: string) => Promise<void>) | undefined;
  const shell: Shell = { run: async (command, args, cwd) => {
    if (command === "ps") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args.join(" ") === "remote get-url origin") return { code: 0, stdout: "https://github.com/test/project.git", stderr: "" };
    if (command !== "git") throw new Error(`Unexpected command ${command}`);
    return processShell.run(command, args, cwd);
  } };
  const runtimeFor = (cwd: string, write?: WriteAccess): AgentRuntime => ({ message: async (prompt, _schema, session, options) => {
    options?.onUsage?.({ inputTokens: 1, outputTokens: 1 });
    const role = options!.purpose!; const file = role === "worker" ? /Own exactly ([^ ]+)\. Task:/.exec(prompt)![1] : undefined;
    calls.push({ role, file, prompt, session, write }); let response: unknown = workerSummary;
    if (role === "lead-plan") response = plan;
    if (role === "worker") response = responses.get(file!);
    if (role === "lead") {
      leadDrafts.push(Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(cwd, file), "utf8")]))));
      try { await leadHook?.(cwd); } catch (error) { throw accountedFailure(error instanceof Error ? error.message : "Simulated terminal failure"); }
    }
    return { sessionId: `fresh-${calls.length}`, response, usage: { inputTokens: 1, outputTokens: 1 }, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:00:01Z" };
  } });
  const services = () => new GitDeveloperLanes(store, shell, runtimeFor);
  let journal = services().create(lane, brief);
  let pendingWrite = Promise.resolve();
  const persist = () => { pendingWrite = pendingWrite.then(() => store.saveRuntime("handoff-journal", journal)); return pendingWrite; };
  return { files, responses, calls, leadDrafts, get journal() { return journal; }, persist,
    build: () => services().build(lane, brief, journal, persist),
    reload: async () => { journal = (await store.readRuntimeFile<LaneJournal>("handoff-journal"))!; },
    setLead: (hook: (cwd: string) => Promise<void>) => { leadHook = hook; },
    seedCompleted: async (output: unknown[]) => {
      // The production journal shape at the observed failure: completed plan/workers, no applied content and no lead.
      journal.baseSha = baseSha; journal.gitDir = join(project, ".git");
      await mkdir(join(store.runtimeDir, "worktrees"), { recursive: true }); git(project, "worktree", "add", "--quiet", "--no-track", "-b", lane.branch, journal.worktree, baseSha); journal.prepared = true;
      const completed = (key: string, role: GoalAgentSession["role"], response: unknown): GoalAgentSession => ({ key, role, status: "complete", startedAt: "2026-09-30T00:00:00Z", result: { sessionId: key, response, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:00:01Z" } });
      journal.sessions = [completed("workers:0", "lead-plan", plan), ...files.map((file, index) => completed(`worker:0:${file}`, "worker", output[index]))]; await persist();
    },
  };
}

describe("validated worker handoffs and explicit recovery", () => {
  it.each([false, true])("recovers the five completed legacy workers with fresh contexts only for rejected responses on explicit retry (direct upgrade: %s)", async (directUpgrade) => {
    const f = await handoffFixture(5);
    const legacy = f.files.map((file, index) => ({ ...workerSummary, content: workerResult(file).content, neededButUnowned: index < 4 ? [`${f.files[index + 1]} (owned by its worker)`] : [], decisions: [`Accepted decision from ${file}`] }));
    await f.seedCompleted(legacy); await f.reload();
    if (!directUpgrade) {
      await expect(f.build()).rejects.toThrow("Worker src/a.ts handoff rejected: Needed but unowned files: src/b.ts (owned by its worker)");
      expect(f.journal.workerRejections).toHaveLength(4);
      await f.reload(); await expect(f.build()).rejects.toThrow("Explicit retry");
    }
    expect(f.journal.built).toBe(false); expect(f.calls).toHaveLength(0);
    expect(f.journal.sessions.filter((item) => item.role === "worker").map((item) => item.status)).toEqual(Array(5).fill("complete"));
    for (const file of f.files) expect(await readFile(join(f.journal.worktree, file), "utf8")).toBe("original\n");
    for (let index = 0; index < 4; index++) f.responses.set(f.files[index], { ...workerResult(f.files[index]), siblingDependencies: [{ file: f.files[index + 1], requirement: `Preserve interface ${index + 1}` }] });
    f.journal.attempt++; await f.persist(); await f.reload(); await f.build();
    expect(f.journal.built).toBe(true);
    expect(f.calls.filter((item) => item.role === "worker").map((item) => item.file).sort()).toEqual(f.files.slice(0, 4));
    expect(f.calls.filter((item) => item.role === "lead")).toHaveLength(1); expect(f.calls.some((item) => item.role === "lead-plan")).toBe(false);
    expect(f.calls.every((item) => item.session === undefined)).toBe(true); expect(f.calls.filter((item) => item.role === "worker").every((item) => !item.write)).toBe(true);
    expect(f.calls.find((item) => item.file === "src/a.ts")!.prompt).toContain('"file":"src/b.ts"');
    expect(f.calls.find((item) => item.file === "src/a.ts")!.prompt).toContain("Earlier handoff rejection: Needed but unowned files: src/b.ts (owned by its worker)");
    expect(f.calls.find((item) => item.role === "lead")!.prompt).toContain('"siblingDependencies":[{"file":"src/b.ts","requirement":"Preserve interface 1"}]');
    expect(f.leadDrafts[0]).toEqual(Object.fromEntries(f.files.map((file) => [file, workerResult(file).content])));
    expect(f.journal.summary!.decisions).toContain("Accepted decision from src/e.ts");
    expect(f.journal.workerRejections!.map((item) => item.key).sort()).toEqual(f.files.slice(0, 4).map((file) => `worker:0:${file}`));
    expect(f.journal.sessions.filter((item) => item.role === "worker" && item.key.startsWith("worker:0:")).map((item) => item.result!.response)).toEqual(legacy);
    expect(f.journal.sessions.filter((item) => item.role === "worker" && item.key.startsWith("worker:1:")).length).toBe(4);
  });
  it.each(["unowned", "unassigned", "self", "prose"])("keeps a %s dependency blocked without applying content or looping the same attempt", async (problem) => {
    const f = await handoffFixture(); const file = problem === "unassigned" ? "private/secret.ts" : problem === "self" ? "src/a.ts" : "src/b.ts (owned by its worker)";
    f.responses.set("src/a.ts", { ...workerResult("src/a.ts"), neededButUnowned: problem === "unowned" ? ["private/secret.ts"] : [], siblingDependencies: problem === "unowned" ? [] : [{ file, requirement: "Needed behavior" }] });
    await expect(f.build()).rejects.toThrow(problem === "unowned" ? "Worker src/a.ts handoff rejected: Needed but unowned files: private/secret.ts" : "Worker src/a.ts handoff rejected: Sibling dependency is not assigned to another worker");
    const calls = f.calls.length; await f.reload(); await expect(f.build()).rejects.toThrow("Explicit retry"); expect(f.calls).toHaveLength(calls);
    f.journal.attempt++; await f.persist(); await expect(f.build()).rejects.toThrow("Worker src/a.ts handoff rejected");
    expect(f.calls.filter((item) => item.file === "src/a.ts")).toHaveLength(2); expect(f.calls.filter((item) => item.file === "src/b.ts")).toHaveLength(1);
    expect(f.calls.some((item) => item.role === "lead")).toBe(false); expect(f.journal.workerRejections).toHaveLength(2);
    for (const file of f.files) expect(await readFile(join(f.journal.worktree, file), "utf8")).toBe("original\n");
  });
  it("reuses accepted handoffs without overwriting an interrupted lead's draft on retry", async () => {
    const f = await handoffFixture(); let first = true;
    f.responses.set("src/a.ts", { ...workerResult("src/a.ts"), siblingDependencies: [{ file: "src/b.ts", requirement: "Preserve the sibling API" }] });
    f.setLead(async (cwd) => { if (first) { first = false; await writeFile(join(cwd, "src/a.ts"), "lead refinement to preserve\n"); throw new Error("Interrupted lead"); } });
    await expect(f.build()).rejects.toThrow("Interrupted lead"); await f.reload();
    f.journal.attempt++; await f.persist(); await f.build();
    expect(f.calls.filter((item) => item.role === "worker")).toHaveLength(2); expect(f.calls.filter((item) => item.role === "lead")).toHaveLength(2);
    expect(f.leadDrafts[1]["src/a.ts"]).toBe("lead refinement to preserve\n");
    expect(await readFile(join(f.journal.worktree, "src/a.ts"), "utf8")).toBe("lead refinement to preserve\n");
    expect(f.journal.built).toBe(true); expect(f.journal.workerRejections).toBeUndefined();
  });
});
