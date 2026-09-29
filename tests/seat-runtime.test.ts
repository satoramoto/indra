import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const runtime = new SeatRuntime(engine, "/work", 60_000, write, create, harness);
    expect(await runtime.message("Legacy", "schema", "legacy-codex", options)).toBe(result);
    expect(create).toHaveBeenLastCalledWith("codex", "/work", 60_000, write, harness);
    expect(message).toHaveBeenLastCalledWith("Legacy", "schema", "legacy-codex", options);
    await runtime.message("Claude", "other-schema", claudeHandle, options);
    expect(create).toHaveBeenLastCalledWith("claude", "/work", 60_000, write, harness);
    expect(message).toHaveBeenLastCalledWith("Claude", "other-schema", claudeHandle, options);
    await runtime.message("New turn", "schema"); expect(create).toHaveBeenLastCalledWith(engine, "/work", 60_000, write, harness);
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
