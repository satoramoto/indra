import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processTree from "../src/process-tree.js";
import { CircuitBudget, CircuitBusyError, CircuitOpenError, DEFAULT_CIRCUIT_POLICY, protectRuntime, protectShell, validateCircuitPolicy } from "../src/circuit-budget.js";
import type { AgentResult, AgentRuntime, MessageOptions } from "../src/codex-runtime.js";
import { AgentRunError, RuntimeFacts, type TokenUsage } from "../src/runtime-facts.js";
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
const result = (usage?: TokenUsage): AgentResult => ({ sessionId: "session", response: {}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), facts: { invocationId: "invocation", engine: "codex", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "succeeded", usageComplete: true, usage } });
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
    await expect(protectRuntime(budget, { message: async () => { throw Object.assign(new Error("failed"), { facts: { usageComplete: true, usage: { inputTokens: 20, outputTokens: 10 } } }); } }, { phase: "build" }).message("", "")).rejects.toThrow("failed");
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
    await budget.usage(invocation.value.id, { inputTokens: 1, outputTokens: 1 }); await budget.finish(invocation.value.id, true);
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
    expect(timeout).toBeLessThanOrEqual(25); expect((await budget.status()).totals.executionMs).toBeGreaterThanOrEqual(25);
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
  it("queues a fifth normal model until capacity is released without consuming retries", async () => {
    const { budget, options } = await fixture({ maxModelConcurrency: 1, maxInvocationMs: 2000 });
    const occupying = await budget.begin("model", { phase: "build" }); let started = false;
    const pending = protectRuntime(new CircuitBudget(options), { message: async () => { started = true; return result({ inputTokens: 1, outputTokens: 1 }); } }, { phase: "review" }).message("", "");
    await new Promise((resolve) => setTimeout(resolve, 30)); expect(started).toBe(false);
    await budget.usage(occupying.id, { inputTokens: 1, outputTokens: 1 }); await budget.finish(occupying.id, true);
    await pending; expect(started).toBe(true); expect((await budget.status()).totals.retries).toBe(0);
  });
  it("cancels admission wait before any model starts and preserves caller usage callbacks", async () => {
    const { budget } = await fixture({ maxModelConcurrency: 1 });
    const occupying = await budget.begin("model", { phase: "build" }); let started = false;
    const controller = new AbortController();
    const runtime = protectRuntime(budget, { message: async () => { started = true; return result({ inputTokens: 1, outputTokens: 1 }); } }, { phase: "review" });
    const pending = runtime.message("", "", undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("owner cancelled");
    await new Promise((resolve) => setTimeout(resolve, 25)); controller.abort(new Error("owner cancelled")); await rejected;
    expect(started).toBe(false); expect(Object.keys((await budget.status()).reservations)).toEqual([occupying.id]);
    await budget.usage(occupying.id, { inputTokens: 1, outputTokens: 1 }); await budget.finish(occupying.id, true);
    const reports: TokenUsage[] = [];
    await runtime.message("", "", undefined, { onUsage: (usage: TokenUsage) => reports.push(usage) } as MessageOptions);
    expect(reports).toEqual([{ inputTokens: 1, outputTokens: 1 }]);
  });
  it("storage failure marker stays closed across restart until a durable explicit grant", async () => {
    const { budget, options } = await fixture(); await budget.status();
    await writeFile(`${budget.path}.tripped`, "ledger persistence failed\n");
    await expect(new CircuitBudget(options).assertAvailable()).rejects.toThrow("persistence failed");
    const status = await budget.grant({ tokens: 1, owner: "owner", reason: "storage repaired and inspected" });
    expect(status.history.map((entry) => entry.event)).toEqual(["trip", "grant"]);
    await new CircuitBudget(options).assertAvailable();
    await expect(readFile(`${budget.path}.tripped`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses owner grants while siblings are still executing", async () => {
    const { budget } = await fixture(); await budget.begin("command", { phase: "checks" });
    await expect(budget.grant({ executionMs: 1, owner: "owner", reason: "extend" })).rejects.toThrow("active invocations");
    expect((await budget.status()).history).toEqual([]);
  });

  it("fails closed when usage regresses instead of treating the reset as free tokens", async () => {
    const { budget } = await fixture({ maxInvocationTokens: 100 });
    const run = await budget.begin("model", { phase: "build" });
    await budget.usage(run.id, { inputTokens: 20, outputTokens: 10 });
    await expect(budget.usage(run.id, { inputTokens: 1, outputTokens: 1 })).rejects.toThrow("became unknown");
    expect((await budget.status()).totals.tokens).toBe(100);
  });
  it("exposes corrupted accounting as a circuit error before the provider can start", async () => {
    const { budget } = await fixture(); await budget.status(); await writeFile(budget.path, "corrupt");
    let invoked = false;
    const runtime = protectRuntime(budget, { message: async () => { invoked = true; return result(); } }, { phase: "build" });
    await expect(runtime.message("", "")).rejects.toBeInstanceOf(CircuitOpenError); expect(invoked).toBe(false);
  });

  it("accepts normalized invocation usage from a legacy result without facts", async () => {
    const { budget } = await fixture();
    const runtime: AgentRuntime = { message: async () => ({ ...result(), facts: undefined, usage: { inputTokens: 40, outputTokens: 3, cachedInputTokens: 30 } }) };
    await protectRuntime(budget, runtime, { phase: "build" }).message("", "");
    expect((await budget.status()).totals.tokens).toBe(43);
  });
  it("does not mistake raw provider or session usage for normalized invocation usage", async () => {
    const { budget } = await fixture({ maxInvocationTokens: 100 });
    const runtime: AgentRuntime = { message: async () => ({ ...result(), facts: undefined, usage: { input_tokens: 40, output_tokens: 3 } }) };
    await expect(protectRuntime(budget, runtime, { phase: "build" }).message("", "")).rejects.toThrow("complete token usage");
    expect((await budget.status()).totals.tokens).toBe(100);
  });
  it("uses authoritative facts before compatibility usage and does not fill unknown facts from it", async () => {
    const { budget } = await fixture({ maxInvocationTokens: 100 });
    const runtime: AgentRuntime = { message: async () => ({ ...result({ inputTokens: 20, outputTokens: 2 }), usage: { inputTokens: 90, outputTokens: 9 } }) };
    await protectRuntime(budget, runtime, { phase: "build" }).message("", "");
    expect((await budget.status()).totals.tokens).toBe(22);
    const partial: AgentRuntime = { message: async () => ({ ...result({ inputTokens: 10 }), usage: { inputTokens: 10, outputTokens: 5 } }) };
    await expect(protectRuntime(budget, partial, { phase: "review" }).message("", "")).rejects.toThrow("complete token usage");
    expect((await budget.status()).totals.tokens).toBe(122);
  });

});


it.each(["codex", "claude"] as const)("charges unknown final usage after an earlier complete-looking %s live snapshot", async (engine) => {
  const { budget } = await fixture({ maxInvocationTokens: 100 });
  const runtime: AgentRuntime = { message: async (_prompt, _schema, _session, options) => {
    const facts = new RuntimeFacts(engine);
    if (engine === "codex") facts.observeLog({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 20, output_tokens: 5 } } } });
    else {
      facts.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m", usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } });
      facts.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 5 } } });
    }
    options?.onUsage?.(facts.finish("interrupted").usage!);
    throw new AgentRunError("Provider interrupted during later work", facts.finish("interrupted"));
  } };
  await expect(protectRuntime(budget, runtime, { phase: "implement" }).message("", "")).rejects.toThrow("complete token usage");
  const status = await budget.status();
  expect(status.totals.tokens).toBe(100); expect(status.reservations).toEqual({}); expect(status.trip).toBeDefined();
});

it("requires terminal provenance even when a successful facts envelope has both counters", async () => {
  const { budget } = await fixture({ maxInvocationTokens: 100 });
  const sample = result({ inputTokens: 20, outputTokens: 5 }); delete sample.facts!.usageComplete;
  await expect(protectRuntime(budget, { message: async () => sample }, { phase: "implement" }).message("", "")).rejects.toThrow("complete token usage");
  expect((await budget.status()).totals.tokens).toBe(100);
});

it("persists an explicit accounting stop through retry and restart until an owner grant", async () => {
  const { budget, options } = await fixture();
  await budget.stop("invocation attempt accounting unavailable");
  await expect(new CircuitBudget(options).assertAvailable()).rejects.toThrow("attempt accounting unavailable");
  await expect(budget.chargeRetry("again", "implement")).rejects.toBeInstanceOf(CircuitOpenError);
  const recovered = await budget.grant({ retries: 1, owner: "owner", reason: "Repaired attempt journal" });
  expect(recovered.history.map((entry) => entry.event)).toEqual(["trip", "grant"]);
  await budget.assertAvailable();
});


it("caches only this live process identity while rechecking foreign reservations", async () => {
  const { runtimeDir } = await fixture();
  const list = vi.spyOn(processTree, "listProcesses").mockResolvedValue([row]);
  try {
    const own = new CircuitBudget({ runtimeDir, scopeId: "goal-self-cache" });
    const run = await own.begin("command", { phase: "implement" });
    await own.status(); await own.assertAvailable(); await own.finish(run.id);
    expect(list).toHaveBeenCalledTimes(1);
    const another = await own.begin("command", { phase: "implement" });
    const saved = JSON.parse(await readFile(own.path, "utf8"));
    const foreign = { ...row, pid: process.pid + 100_000, start: "foreign owner" };
    saved.reservations[another.id].owner = { pid: foreign.pid, start: foreign.start };
    await writeFile(own.path, JSON.stringify(saved)); list.mockResolvedValue([row, foreign]);
    await own.status(); await own.status(); expect(list).toHaveBeenCalledTimes(3);
    list.mockResolvedValue([row]);
    expect((await own.status()).trip?.reason).toContain("owner exited");
  } finally { list.mockRestore(); }
});


it("keeps a transient mid-command accounting failure closed after process inspection recovers", async () => {
  const { options } = await fixture();
  let reads = 0; let failed = false;
  const budget = new CircuitBudget({ ...options, processes: async () => {
    reads++;
    if (reads === 2) { failed = true; throw new Error("Transient process inspection failure"); }
    return [row];
  } });
  const shell: Shell = { run: async (_command, _args, _cwd, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  }) };
  await expect(protectShell(budget, shell, { phase: "implement" }).run("fixture", [], "/")).rejects.toBeInstanceOf(CircuitOpenError);
  expect(failed).toBe(true);
  const status = await budget.status();
  expect(status.reservations).toEqual({}); expect(status.trip?.reason).toBe("budget accounting unavailable");
  await expect(new CircuitBudget(options).assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
});

it("can persist an accounting stop even while foreign-owner inspection is unavailable", async () => {
  const { options, budget } = await fixture(); await budget.begin("command", { phase: "implement" });
  const unavailable = new CircuitBudget({ ...options, processes: async () => { throw new Error("ps remains unavailable"); } });
  await unavailable.stop("budget accounting unavailable");
  await expect(budget.assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
});


it.each(["failure", "success"] as const)("preserves bounded provider facts when a circuit overrides a %s", async (outcome) => {
  const { budget } = await fixture({ maxInvocationTokens: 100 });
  const at = new Date().toISOString();
  const facts = { invocationId: "observed", engine: "codex" as const, sessionId: "session",
    startedAt: at, finishedAt: at, status: outcome === "failure" ? "timed-out" as const : "succeeded" as const,
    usage: { inputTokens: 5 }, cumulativeUsage: { inputTokens: 12 } };
  const runtime: AgentRuntime = { message: async () => {
    const contaminated = { ...facts, diagnostic: "private provider diagnostic", usage: { ...facts.usage, prompt: "private prompt" } };
    if (outcome === "failure") throw Object.assign(new Error("private provider diagnostic"), { facts: contaminated });
    return { ...result(), facts: contaminated, response: "private provider response" };
  } };
  const error = await protectRuntime(budget, runtime, { phase: "proposal" }).message("", "").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CircuitOpenError);
  expect((error as CircuitOpenError).facts).toEqual(facts);
  expect(JSON.stringify(error)).not.toContain("private");
  expect((await budget.status()).totals.tokens).toBe(100);
  await expect(budget.assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
});
