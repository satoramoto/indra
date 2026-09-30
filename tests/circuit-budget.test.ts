import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CircuitBudget, CircuitBusyError, CircuitOpenError, DEFAULT_CIRCUIT_POLICY, protectRuntime, protectShell, validateCircuitPolicy } from "../src/circuit-budget.js";
import type { AgentResult, AgentRuntime, MessageOptions } from "../src/codex-runtime.js";
import type { TokenUsage } from "../src/runtime-facts.js";
import type { Shell } from "../src/command-shell.js";
const directories: string[] = [];
const row = { pid: process.pid, ppid: 1, pgid: process.pid, start: "verified process start" };
const processes = async () => [row];
async function fixture(policy = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "indra-circuit-")); directories.push(runtimeDir);
  const options = { runtimeDir, scopeId: "goal-test", processes, policy, pollMs: 10 };
  return { options, budget: new CircuitBudget(options), runtimeDir };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const result = (usage?: TokenUsage): AgentResult => ({ sessionId: "session", response: {}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), facts: { invocationId: "invocation", engine: "codex", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "succeeded", usage } });
const observed = (options?: MessageOptions) => options as MessageOptions & { onUsage?: (usage: TokenUsage) => void };
const abortingRuntime: AgentRuntime = { message: async (_prompt, _schema, _session, options) => new Promise((_resolve, reject) => {
  options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
}) };

describe("durable circuit budget", () => {
  it("records prospective adoption without inventing historical consumption", async () => {
    const { budget } = await fixture(); const status = await budget.status();
    expect(status.adoption).toMatchObject({ historicalUsage: "unknown", accounting: "prospective" });
    expect(status.policy).toEqual(DEFAULT_CIRCUIT_POLICY);
    expect(status.totals).toEqual({ tokens: 0, executionMs: 0, retries: 0 });
  });
  it("validates finite policy JSON, rejects bad fields, and freezes policy per adopted scope", async () => {
    for (const value of [{ maxTokens: 0 }, { maxTokens: Infinity }, { maxTokens: 1.2 }, { maxRetries: "3" }, { unknown: 1 }]) expect(() => validateCircuitPolicy(value)).toThrow();
    const { budget, runtimeDir } = await fixture();
    await writeFile(join(runtimeDir, "circuit-policy.json"), JSON.stringify({ maxTokens: 123 }));
    expect((await budget.status()).limits.tokens).toBe(123);
    await writeFile(join(runtimeDir, "circuit-policy.json"), "invalid");
    expect((await budget.status()).limits.tokens).toBe(123);
    await expect(new CircuitBudget({ runtimeDir, scopeId: "other" }).status()).rejects.toThrow("policy");
  });
  it("serializes two independent stores, charges retries exactly once, and preserves a trip through restart", async () => {
    const { budget, options } = await fixture({ maxPhaseRetries: 2 }); const other = new CircuitBudget(options);
    await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? budget : other).chargeRetry("repair-1", "implementation")));
    expect((await other.status()).totals.retries).toBe(1);
    await other.chargeRetry("repair-2", "implementation");
    await expect(budget.chargeRetry("repair-3", "implementation")).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(new CircuitBudget(options).begin("model", { phase: "review" })).rejects.toBeInstanceOf(CircuitOpenError);
    expect((await other.status()).totals.retries).toBe(2);
  });
  it("enforces aggregate retries across phases, while polling consumes none", async () => {
    const { budget } = await fixture({ maxRetries: 2 });
    await budget.chargeRetry("fix-1", "build"); await budget.chargeRetry("fix-2", "review");
    await budget.status(); await budget.assertAvailable();
    await expect(budget.chargeRetry("fix-3", "retro")).rejects.toThrow("repair budget");
    expect((await budget.status()).totals.retries).toBe(2);
  });
  it("owner grants add finite limits and preserve old totals, trips and retry keys", async () => {
    const { budget } = await fixture({ maxPhaseRetries: 1 });
    await budget.chargeRetry("fix-1", "review"); await expect(budget.chargeRetry("fix-2", "review")).rejects.toThrow();
    await expect(budget.grant({ tokens: Infinity, owner: "owner", reason: "extend" })).rejects.toThrow();
    const status = await budget.grant({ phaseRetries: { review: 1 }, owner: "owner", reason: "one more fix" });
    expect(status.trip).toBeUndefined(); expect(status.totals.retries).toBe(1);
    expect(status.history.map((entry) => entry.event)).toEqual(["trip", "grant"]);
    await budget.chargeRetry("fix-1", "review"); await budget.chargeRetry("fix-2", "review");
    expect((await budget.status()).totals.retries).toBe(2);
  });
  it("merges monotonic invocation snapshots without counting caches twice and flushes final usage", async () => {
    const { budget } = await fixture();
    const runtime: AgentRuntime = { message: async (_p, _s, _id, options) => {
      observed(options).onUsage?.({ inputTokens: 100, cachedInputTokens: 90, outputTokens: 10 });
      observed(options).onUsage?.({ inputTokens: 100, outputTokens: 10 });
      return result({ inputTokens: 120, outputTokens: 20, cachedInputTokens: 95 });
    } };
    await protectRuntime(budget, runtime, { phase: "build" }).message("", "");
    const status = await budget.status(); expect(status.totals.tokens).toBe(140); expect(status.reservations).toEqual({});
  });
  it("charges reported failed-run usage, and unknown usage conservatively consumes the allowance and trips", async () => {
    const { budget } = await fixture({ maxInvocationTokens: 100 });
    await expect(protectRuntime(budget, { message: async () => { throw Object.assign(new Error("failed"), { facts: { usage: { inputTokens: 20, outputTokens: 10 } } }); } }, { phase: "build" }).message("", "")).rejects.toThrow("failed");
    expect((await budget.status()).totals.tokens).toBe(30);
    await expect(protectRuntime(budget, { message: async () => result({ inputTokens: 10 }) }, { phase: "review" }).message("", "")).rejects.toThrow("complete token usage");
    const status = await budget.status(); expect(status.totals.tokens).toBe(130); expect(status.reservations).toEqual({});
  });
  it("does not silently trust a corrupted ledger", async () => {
    const { budget } = await fixture(); const status = await budget.status();
    await writeFile(budget.path, JSON.stringify({ ...status, totals: {} }));
    await expect(budget.begin("model", { phase: "build" })).rejects.toThrow("Invalid circuit ledger");
  });
  it("admits at most the model concurrency cap across independent stores and rejects before execution", async () => {
    const { budget, options } = await fixture({ maxModelConcurrency: 1 });
    const outcomes = await Promise.allSettled([budget.begin("model", { phase: "build" }), new CircuitBudget(options).begin("model", { phase: "review" })]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((entry) => entry.status === "rejected"); expect(rejected?.reason).toBeInstanceOf(CircuitBusyError);
    const invocation = outcomes.find((entry) => entry.status === "fulfilled")!;
    await budget.usage(invocation.value.id, { inputTokens: 1, outputTokens: 1 }); await budget.finish(invocation.value.id);
    expect((await budget.status()).trip).toBeUndefined();
  });
  it("reserves aggregate token capacity across parallel models", async () => {
    const { budget } = await fixture({ maxTokens: 150, maxInvocationTokens: 100 });
    const first = await budget.begin("model", { phase: "build" }); const second = await budget.begin("model", { phase: "review" });
    expect([first.tokenLimit, second.tokenLimit]).toEqual([100, 50]);
    await expect(budget.begin("model", { phase: "draft" })).rejects.toBeInstanceOf(CircuitBusyError);
  });
  it("cancels a live sibling from a different store when token consumption trips the scope", async () => {
    const { budget, options } = await fixture({ maxInvocationTokens: 100 });
    const sibling = protectRuntime(new CircuitBudget(options), abortingRuntime, { phase: "review" }).message("", "");
    // Attach rejection immediately; the sibling is deliberately alive when another invocation trips.
    const stopped = expect(sibling).rejects.toBeInstanceOf(CircuitOpenError);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(protectRuntime(budget, { message: async () => result({ inputTokens: 100, outputTokens: 1 }) }, { phase: "build" }).message("", "")).rejects.toThrow("token budget");
    await stopped;
    expect((await budget.status()).reservations).toEqual({});
  });
  it("charges simultaneous model and command elapsed time cumulatively, with a sticky execution trip", async () => {
    const { options } = await fixture({ maxExecutionMs: 100, maxInvocationMs: 1000 }); let now = 1000;
    const budget = new CircuitBudget({ ...options, now: () => now });
    const model = await budget.begin("model", { phase: "build" }); await budget.begin("command", { phase: "checks" });
    await budget.usage(model.id, { inputTokens: 1, outputTokens: 1 }); now += 51;
    const status = await budget.status(); expect(status.totals.executionMs).toBe(102); expect(status.trip).toBeDefined();
    await expect(budget.assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
  });
  it("preserves lower caller timeouts and aborts owned command work at the configured deadline", async () => {
    const { budget } = await fixture({ maxInvocationMs: 80 }); let timeout: number | undefined;
    const shell = { run: async (_command: string, _args: string[], _cwd: string, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
      timeout = options?.timeoutMs;
      return new Promise<never>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    } };
    const wrapped = protectShell(budget, shell, { phase: "checks" }) as typeof shell;
    await expect(wrapped.run("test", [], "/", { timeoutMs: 25 })).rejects.toThrow("execution time");
    expect(timeout).toBe(25); expect((await budget.status()).totals.executionMs).toBeGreaterThanOrEqual(25);
  });
  it("does not reclaim a long-running reservation on a heartbeat guess, but verifies PID reuse before conservative recovery", async () => {
    const { options } = await fixture(); let now = 1000; let identity = row.start;
    const budget = new CircuitBudget({ ...options, now: () => now, processes: async () => [{ ...row, start: identity }] });
    const run = await budget.begin("model", { phase: "build" }); now += 500;
    expect((await budget.status()).reservations[run.id]).toBeDefined();
    identity = "different process with reused PID";
    const status = await budget.status(); expect(status.reservations).toEqual({});
    expect(status.totals.tokens).toBe(run.tokenLimit); expect(status.trip?.reason).toContain("owner exited");
  });
  it("process inspection failure never reclaims a reservation", async () => {
    const { options, budget } = await fixture(); const run = await budget.begin("command", { phase: "checks" });
    const unavailable = new CircuitBudget({ ...options, processes: async () => { throw new Error("ps unavailable"); } });
    await expect(unavailable.status()).rejects.toThrow("ps unavailable");
    const saved = JSON.parse(await readFile(budget.path, "utf8")); expect(saved.reservations[run.id]).toBeDefined();
  });
  it("runs successful commands with time accounting but no model-token requirement", async () => {
    const { budget } = await fixture();
    const shell: Shell = { run: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return { code: 0, stdout: "ok", stderr: "" }; } };
    expect((await protectShell(budget, shell, { phase: "checks" }).run("test", [], "/")).code).toBe(0);
    const status = await budget.status(); expect(status.totals.executionMs).toBeGreaterThanOrEqual(10); expect(status.totals.tokens).toBe(0); expect(status.trip).toBeUndefined();
  });
});
