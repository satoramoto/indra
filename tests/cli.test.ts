import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseOptions, withRuntimeSignal } from "../src/cli.js";
import { CircuitBudget, CircuitOpenError } from "../src/circuit-budget.js";
import { PlanningStore } from "../src/planning.js";
import { WorkflowInbox } from "../src/remodel-events.js";

let checkout: string;
beforeEach(async () => {
  checkout = join(await mkdtemp(join(tmpdir(), "indra-budget-cli-")), "state");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(PlanningStore.prototype, "read").mockResolvedValue({
    $schema: "schema", schemaVersion: 1, sprints: [],
    teams: [{ id: "team-001", slug: "yahaha", workflowModel: "goals-v1", externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
      { id: "seat-product", displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { username: "product", userId: "product-id" } } },
    ] }],
    planningGoals: [{ id: "goal-budget", teamId: "team-001", workflowModel: "goals-v1", stage: "approved", title: "Budget fixture" }],
  } as unknown as Awaited<ReturnType<PlanningStore["read"]>>);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(join(checkout, ".."), { recursive: true, force: true }); });

const run = (action: string, args: string[] = []) => main(["planning", action, ...args, "--state", checkout]);
const budget = (scopeId = "goal-budget") => new CircuitBudget({ runtimeDir: `${checkout}.runtime`, scopeId, policy: { maxRetries: 1, maxPhaseRetries: 1 } });
const trip = async (ledger: CircuitBudget) => {
  await ledger.chargeRetry("first", "developer:repair");
  await expect(ledger.chargeRetry("second", "developer:repair")).rejects.toBeInstanceOf(CircuitOpenError);
};

describe("budget command parsing", () => {
  it("accepts exact targets and finite increments with named phase allowances", () => {
    expect(parseOptions(["planning", "budget", "--seat", "seat-product"])).toMatchObject({ action: "budget", seatId: "seat-product" });
    expect(parseOptions(["planning", "budget-grant", "--goal", "goal-budget", "--tokens", "100", "--execution-ms", "60000", "--retries", "2", "--phase-retries", "developer:repair=2", "--phase-retries", "retro=1", "--reason", "Corrected the blocker"])).toMatchObject({
      action: "budget-grant", grant: { tokens: 100, executionMs: 60000, retries: 2, phaseRetries: { "developer:repair": 2, retro: 1 }, reason: "Corrected the blocker" },
    });
  });
  it.each(["0", "-1", "Infinity", "NaN", "1.5", "1e3", "9007199254740992"])("rejects invalid grant amount %s", (amount) => {
    expect(() => parseOptions(["planning", "budget-grant", "--goal", "goal-budget", "--tokens", amount, "--reason", "Repair"])).toThrow();
  });
  it.each([
    ["budget"], ["budget", "--goal", "goal-budget", "--seat", "seat-product"],
    ["budget", "--goal", "goal-budget", "--tokens", "2"],
    ["budget-grant", "--goal", "goal-budget", "--reason", "No increment"],
    ["budget-grant", "--goal", "goal-budget", "--tokens", "2"],
    ["budget-grant", "--goal", "goal-budget", "--tokens", "2", "--reason", "   "],
    ["budget-grant", "--goal", "goal-budget", "--tokens", "2", "--tokens", "3", "--reason", "Duplicate"],
    ["budget-grant", "--goal", "goal-budget", "--phase-retries", "retro=0", "--reason", "Zero"],
    ["budget-grant", "--goal", "goal-budget", "--phase-retries", "__proto__=2", "--reason", "Invalid"],
    ["budget-grant", "--goal", "goal-budget", "--phase-retries", "retro=2", "--phase-retries", "retro=1", "--reason", "Duplicate"],
  ])("rejects incomplete or ambiguous command %j", (...args) => expect(() => parseOptions(["planning", ...args])).toThrow());
});

describe("operator budget controls", () => {
  it("shows a goal's durable trip and unknown historical accounting without clearing it", async () => {
    const ledger = budget(); await trip(ledger);
    expect(await run("budget", ["--goal", "goal-budget"])).toBe(0);
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(output).toMatchObject({ scopeId: "goal-budget", adoption: { historicalUsage: "unknown", accounting: "prospective" }, totals: { retries: 1 }, trip: { reason: "automatic repair budget exhausted" } });
    await expect(ledger.assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it.each(["goal", "seat"] as const)("ordinary %s retry cannot reset a trip; a finite owner grant preserves history without scheduling work", async (target) => {
    const args = target === "goal" ? ["--goal", "goal-budget"] : ["--seat", "seat-product"];
    const ledger = budget(target === "goal" ? "goal-budget" : "product-team-001-seat-product");
    await trip(ledger); const before = await ledger.status();
    const publish = vi.spyOn(WorkflowInbox.prototype, "publish");
    expect(await run("retry", args)).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.stringContaining("explicit owner budget grant"));
    expect(await run("budget-grant", [...args, "--retries", "2", "--phase-retries", "developer:repair=2", "--reason", "Fixed the retry cause"])).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    const after = await ledger.status();
    expect(after.trip).toBeUndefined(); expect(after.totals).toEqual(before.totals); expect(after.retries).toEqual(before.retries);
    expect(after.history.slice(0, before.history.length)).toEqual(before.history);
    expect(after.history.at(-1)).toMatchObject({ event: "grant", owner: userInfo().username, reason: "Fixed the retry cause", grant: { retries: 2, phaseRetries: { "developer:repair": 2 } } });
    expect(await run("retry", args)).toBe(0); expect(publish).toHaveBeenCalledTimes(1);
    expect((await ledger.status()).totals.retries).toBe(1);
  });

  it("refuses agent-seat grants and keeps the durable trip", async () => {
    const ledger = budget(); await trip(ledger); vi.stubEnv("INDRA_SEAT_PANE", "1");
    expect(await run("budget-grant", ["--goal", "goal-budget", "--tokens", "100", "--reason", "Agent recovery"])).toBe(1);
    expect((await ledger.status()).history.filter((entry) => entry.event === "grant")).toEqual([]);
    await expect(ledger.assertAvailable()).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it.each([["--goal", "missing"], ["--seat", "missing"]])("rejects unknown scope %j", async (...args) => {
    expect(await run("budget", args)).toBe(1);
  });
});


it.each(["host", "circuit"] as const)("preserves %s cancellation through the production runtime adapter", async (source) => {
  const host = new AbortController(); const circuit = new AbortController();
  let received: AbortSignal | undefined;
  const wrapped = withRuntimeSignal({ message: async (_prompt, _schema, _session, options) => {
    received = options?.signal;
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  } }, host.signal);
  const rejected = expect(wrapped.message("fixture", "schema", undefined, { signal: circuit.signal })).rejects.toThrow("stopped");
  (source === "host" ? host : circuit).abort();
  await rejected; expect(received?.aborted).toBe(true);
});


it("delivers an actual circuit trip through the production host runtime adapter", async () => {
  const host = new AbortController();
  const ledger = new CircuitBudget({ runtimeDir: `${checkout}.runtime`, scopeId: "goal-adapter", policy: { maxInvocationTokens: 10 } });
  let providerSignal: AbortSignal | undefined;
  const runtime = withRuntimeSignal({ message: async (_prompt, _schema, _session, options) => {
    providerSignal = options?.signal;
    expect(options?.requireFinalUsage).toBe(true);
    options?.onUsage?.({ inputTokens: 10, outputTokens: 1 });
    return new Promise((_resolve, reject) => providerSignal?.addEventListener("abort", () => reject(providerSignal?.reason), { once: true }));
  } }, host.signal);
  await expect(ledger.protectRuntime(runtime, { phase: "vetting" }).message("fixture", "schema")).rejects.toBeInstanceOf(CircuitOpenError);
  expect(providerSignal?.aborted).toBe(true); expect(host.signal.aborted).toBe(false);
});
