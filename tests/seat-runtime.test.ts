import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadSeatEngines, SEAT_ENGINES_FILE, SeatRuntime, type EngineFactory } from "../src/seat-runtime.js";

const dirs: string[] = [];
async function config(value?: string) {
  const dir = await mkdtemp(join(tmpdir(), "indra-engines-")); dirs.push(dir);
  if (value !== undefined) await writeFile(join(dir, SEAT_ENGINES_FILE), value);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const seats = ["seat-001", "seat-002", "seat-003"];
const claudeHandle = "claude:12345678-1234-4321-8765-123456789abc";

describe("seat engine configuration and routing", () => {
  it("keeps missing configuration and omitted seats on Codex, and supports mixed seats", async () => {
    expect(await loadSeatEngines(await config(), seats)).toEqual({});
    const engines = await loadSeatEngines(await config('{"seat-001":"claude","seat-002":"codex"}'), seats);
    const create = vi.fn<EngineFactory>(() => ({ message: vi.fn().mockResolvedValue({}) }));
    for (const id of seats) await new SeatRuntime(engines[id] ?? "codex", "/work", undefined, undefined, create).message("Task", "schema");
    expect(create.mock.calls.map(([engine]) => engine)).toEqual(["claude", "codex", "codex"]);
  });

  it.each(["null", "[]", "invalid text", '{"seat-001":"other"}', '{"seat-999":"claude"}', '{"../seat-001":"codex"}', '{"seat-001":null}', '{"seats":{"seat-001":"claude"}}'])("fails clearly on invalid configuration: %s", async (value) => {
    await expect(loadSeatEngines(await config(value), seats)).rejects.toThrow("Invalid seat-engines.json");
  });

  it("does not treat an unreadable config as absent", async () => {
    const dir = await config(); await mkdir(join(dir, SEAT_ENGINES_FILE));
    await expect(loadSeatEngines(dir, seats)).rejects.toThrow("Could not read seat-engines.json");
  });

  it.each(["codex", "claude"] as const)("routes saved handles to their original engine even when the configured default is %s", async (engine) => {
    const result = { sessionId: "saved", response: {}, usage: { count: 1 }, startedAt: "start", finishedAt: "finish" };
    const message = vi.fn().mockResolvedValue(result); const create = vi.fn<EngineFactory>(() => ({ message }));
    const write = { extraDirs: ["/shared.git"] }; const options = { signal: new AbortController().signal, timeoutMs: 20_000 };
    const harness = "/state.runtime/harness/seat-001";
    const roles = ["Team Lead"];
    const runtime = new SeatRuntime(engine, "/work", 60_000, write, create, harness, roles);
    expect(await runtime.message("Legacy", "schema", "legacy-codex", options)).toBe(result);
    expect(create).toHaveBeenLastCalledWith("codex", "/work", 60_000, write, harness, roles, undefined);
    expect(message).toHaveBeenLastCalledWith("Legacy", "schema", "legacy-codex", options);
    await runtime.message("Claude", "other-schema", claudeHandle, options);
    expect(create).toHaveBeenLastCalledWith("claude", "/work", 60_000, write, harness, roles, undefined);
    expect(message).toHaveBeenLastCalledWith("Claude", "other-schema", claudeHandle, options);
    await runtime.message("New turn", "schema"); expect(create).toHaveBeenLastCalledWith(engine, "/work", 60_000, write, harness, roles, undefined);
    expect(message).toHaveBeenLastCalledWith("New turn", "schema", undefined, undefined);
  });

  it("never automatically replays or falls back after an engine failure", async () => {
    const message = vi.fn().mockRejectedValue(new Error("run interrupted")); const create = vi.fn<EngineFactory>(() => ({ message }));
    await expect(new SeatRuntime("claude", "/work", undefined, undefined, create).message("Task", "schema")).rejects.toThrow("run interrupted");
    expect(create).toHaveBeenCalledTimes(1); expect(message).toHaveBeenCalledTimes(1);
  });

  it.each(["claude:invalid", "other:session", ""])("rejects invalid persisted handles: %s", async (handle) => {
    const create = vi.fn<EngineFactory>();
    await expect(new SeatRuntime("codex", "/work", undefined, undefined, create).message("Task", "schema", handle)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

import { laneWorkerResult, LANE_WORKER_SCHEMA, renderGoalBrief, runGoalAgent, type GoalAgentSession } from "../src/seat-runtime.js";
import type { GoalBrief } from "../src/goal-contract.js";
const goalBrief: GoalBrief = { version: 1, goalId: "goal-one", teamId: "team-one", seatId: "seat-003", header: { repo: "test/project", baseBranch: "sprint/goal-one", baseSha: "a".repeat(40), branch: "codex/goal-one/code", prTarget: "sprint/goal-one" }, outcomes: [{ number: 1, title: "Fix", description: "Preserve behavior", reason: "Mission", currentCode: ["src/a.ts"] }], ownedFiles: ["src/a.ts"], exclusions: [{ files: ["src/b.ts"], owner: "lane docs", reason: "Exclusive" }], swarm: "Single-file workers", retros: [{ goalId: "goal-old", path: "docs/retros/goal-old.md", summary: "Earlier lesson" }], redirects: [{ postId: "post", userId: "owner", at: "2026-09-01T00:00:00Z", message: "Preserve public API" }], reportFormat: "PR/head, exact commands/exits, Decisions, Follow-ups and needed-but-unowned" };
it("gives both engines the identical standard brief and fresh read-only worker context", async () => {
  const prompts: string[] = [];
  for (const engine of ["codex", "claude"] as const) {
    const create = vi.fn<EngineFactory>(() => ({ message: async (prompt, _schema, session) => {
      prompts.push(prompt); expect(session).toBeUndefined(); return { sessionId: `${engine}-new`, response: { content: "source" }, startedAt: "start", finishedAt: "finish" };
    } }));
    const sessions: GoalAgentSession[] = []; const persist = vi.fn(async () => {}); const directory = await config();
    const runtime = (cwd: string) => new SeatRuntime(engine, cwd, undefined, undefined, create);
    const invocation = { key: "worker:a", role: "worker" as const, brief: goalBrief, cwd: directory, schema: { type: "object", additionalProperties: false, required: ["content"], properties: { content: { type: "string" } } }, instruction: "Own exactly src/a.ts. Return its bytes; no checks, commits or other workers." };
    await runGoalAgent(runtime, invocation, directory, sessions, persist);
    await runGoalAgent(runtime, invocation, directory, sessions, persist);
    expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0][3]).toBeUndefined(); expect(sessions[0].status).toBe("complete");
    expect(persist).toHaveBeenCalledTimes(2);
  }
  expect(prompts[0]).toBe(prompts[1]);
  const text = renderGoalBrief(goalBrief);
  for (const expected of ["Base: sprint/goal-one at", "1. Fix", "Why: Mission", "Current code: src/a.ts", "owned by lane docs", "Single-file workers", "Earlier lesson", "Preserve public API", "exact commands/exits"]) expect(text).toContain(expected);
});
it("does not automatically replay an interrupted agent intent", async () => {
  const directory = await config(); const create = vi.fn();
  const sessions: GoalAgentSession[] = [{ key: "lead", role: "lead", status: "started", startedAt: "2026-09-01T00:00:00Z" }];
  await expect(runGoalAgent(create, { key: "lead", role: "lead", brief: goalBrief, cwd: directory, schema: "schema", instruction: "Recover" }, directory, sessions, async () => {})).rejects.toThrow("explicit retry");
  expect(create).not.toHaveBeenCalled();
});

it("requires structured sibling dependencies from new workers while preserving legacy blockers and accepted reports", () => {
  const legacy = { summary: "File delivered", decisions: [], followUps: [], neededButUnowned: ["private/needed.ts"], content: "source" };
  const validate = new Ajv2020({ strict: false }).compile(LANE_WORKER_SCHEMA);
  expect(validate(legacy)).toBe(false);
  const current = { ...legacy, neededButUnowned: [], siblingDependencies: [{ file: "src/b.ts", requirement: "Preserve the shared API" }] };
  expect(validate(current)).toBe(true); expect(laneWorkerResult(current)).toEqual(current);
  expect(validate({ ...current, siblingDependencies: ["src/b.ts (owned by its worker)"] })).toBe(false);
  expect(laneWorkerResult(legacy)).toEqual({ ...legacy, siblingDependencies: [] });
});
it.each([null, ["src/b.ts"], [{ file: "src/b.ts", requirement: "" }], [{ file: "src/b.ts", requirement: "one" }, { file: "src/b.ts", requirement: "two" }]])("rejects malformed structured worker dependencies %j", (siblingDependencies) => {
  expect(() => laneWorkerResult({ summary: "File", decisions: [], followUps: [], neededButUnowned: [], content: "source", siblingDependencies })).toThrow("Invalid structured sibling dependencies");
});
