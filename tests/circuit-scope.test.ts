import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBudget, CircuitOpenError } from "../src/circuit-budget.js";
import { circuitRuntime, circuitShell, withCircuitScope } from "../src/circuit-scope.js";
import type { AgentRuntime } from "../src/codex-runtime.js";
import type { Shell } from "../src/command-shell.js";
const dirs: string[] = [];
async function fixture(policy = {}) {
  const dir = await mkdtemp(join(tmpdir(), "indra-circuit-scope-")); dirs.push(dir);
  await writeFile(join(dir, "circuit-policy.json"), JSON.stringify(policy)); return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const result = () => ({ sessionId: "test", response: {}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), usage: { inputTokens: 2, outputTokens: 1 } });
describe("workflow circuit boundaries", () => {
  it("charges repeated actual calls across recreated runtimes and only reopens after an owner grant", async () => {
    const dir = await fixture({ maxPhaseRetries: 1 });
    const message = vi.fn<AgentRuntime["message"]>().mockResolvedValue(result());
    const run = () => circuitRuntime({ message }, dir, "goal-one", "retro", "review:same-head").message("", "");
    await run(); await run();
    await expect(run()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(message).toHaveBeenCalledTimes(2);
    const budget = new CircuitBudget({ runtimeDir: dir, scopeId: "goal-one" });
    expect((await budget.status()).totals).toMatchObject({ tokens: 6, retries: 1 });
    await expect(budget.assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
    await budget.grant({ phaseRetries: { retro: 1 }, owner: "owner", reason: "one more review attempt" });
    await run(); expect(message).toHaveBeenCalledTimes(3);
    expect((await budget.status()).totals).toMatchObject({ tokens: 9, retries: 2 });
  });
  it("charges a new-head fix as repair while normal independent operations remain free of retry charges", async () => {
    const dir = await fixture({ maxPhaseRetries: 1 });
    const runtime = { message: vi.fn<AgentRuntime["message"]>().mockResolvedValue(result()) };
    await circuitRuntime(runtime, dir, "goal-one", "implement", "worker:a").message("", "");
    await circuitRuntime(runtime, dir, "goal-one", "implement", "worker:b").message("", "");
    await circuitRuntime(runtime, dir, "goal-one", "implement", "fix:head-one", true).message("", "");
    await expect(circuitRuntime(runtime, dir, "goal-one", "implement", "fix:head-two", true).message("", "")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(runtime.message).toHaveBeenCalledTimes(3);
  });
  it("charges concurrent callers sharing an operation independently before either executes", async () => {
    const dir = await fixture({ maxPhaseRetries: 1 });
    const runtime = { message: vi.fn<AgentRuntime["message"]>().mockResolvedValue(result()) };
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => circuitRuntime(runtime, dir, "goal-one", "vetting", "vet:candidate").message("", "")));
    expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true);
    expect(runtime.message.mock.calls.length).toBeLessThanOrEqual(2);
    expect((await new CircuitBudget({ runtimeDir: dir, scopeId: "goal-one" }).status()).totals.retries).toBe(1);
  });
  it("keeps command budgets in their concurrent goal scope and avoids double wrapping", async () => {
    const dir = await fixture({ maxInvocationMs: 100 });
    const seen: number[] = [];
    const shell: Shell = { run: async (_command, _args, _cwd, options) => { seen.push(options!.timeoutMs!); return { code: 0, stdout: "", stderr: "" }; } };
    const protectedShell = circuitShell(shell);
    expect(circuitShell(protectedShell)).toBe(protectedShell);
    await Promise.all(["goal-a", "goal-b"].map((id) => withCircuitScope(dir, id, "implement", () => protectedShell.run("check", [], dir, { timeoutMs: 40 }))));
    expect(seen).toEqual([40, 40]);
    for (const scopeId of ["goal-a", "goal-b"]) expect((await new CircuitBudget({ runtimeDir: dir, scopeId }).status()).reservations).toEqual({});
  });
  it("does not invoke a runtime with unreportable usage again after restart", async () => {
    const dir = await fixture();
    const message = vi.fn<AgentRuntime["message"]>().mockResolvedValue({ ...result(), usage: undefined });
    const run = () => circuitRuntime({ message }, dir, "goal-unknown", "implement", "worker").message("", "");
    await expect(run()).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(run()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(message).toHaveBeenCalledTimes(1);
  });
});
