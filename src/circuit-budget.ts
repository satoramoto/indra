import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentResult, AgentRuntime, MessageOptions } from "./codex-runtime.js";
import type { Shell, ShellResult } from "./command-shell.js";
import { listProcesses, type OwnedProcess, type ProcessLister } from "./process-tree.js";
import type { TokenUsage } from "./runtime-facts.js";
import { withFileLock } from "./state-commit.js";

export interface CircuitPolicy {
  maxTokens: number;
  maxInvocationTokens: number;
  maxExecutionMs: number;
  maxInvocationMs: number;
  maxRetries: number;
  maxPhaseRetries: number;
  maxModelConcurrency: number;
}
export const DEFAULT_CIRCUIT_POLICY: Readonly<CircuitPolicy> = Object.freeze({
  maxTokens: 5_000_000, maxInvocationTokens: 1_000_000,
  maxExecutionMs: 2 * 60 * 60_000, maxInvocationMs: 30 * 60_000,
  maxRetries: 10, maxPhaseRetries: 3, maxModelConcurrency: 4,
});
export class CircuitOpenError extends Error {
  constructor(readonly scopeId: string, readonly reason: string) {
    super(`Circuit open for ${scopeId}: ${reason}. An explicit owner budget grant is required.`);
    this.name = "CircuitOpenError";
  }
}
export const isCircuitOpen = (error: unknown): error is CircuitOpenError => error instanceof CircuitOpenError;
export class CircuitBusyError extends Error {
  constructor() { super("Circuit model concurrency is full; no invocation started."); this.name = "CircuitBusyError"; }
}
export interface CircuitContext { phase: string; operationId?: string }
export interface CircuitGrant {
  tokens?: number; executionMs?: number; retries?: number; phaseRetries?: Record<string, number>;
  reason: string; owner: string;
}
interface Reservation {
  id: string; kind: "model" | "command"; phase: string; operationId?: string;
  owner: OwnedProcess; startedAt: number; accountedAt: number; timeoutMs: number;
  tokenLimit: number; tokens: number; inputTokens?: number; outputTokens?: number;
}
export interface CircuitLedger {
  version: 1; scopeId: string; policy: CircuitPolicy;
  adoption: { at: string; historicalUsage: "unknown"; accounting: "prospective" };
  totals: { tokens: number; executionMs: number; retries: number };
  limits: { tokens: number; executionMs: number; retries: number; phaseRetries: Record<string, number> };
  retries: Record<string, { phase: string; at: string }>;
  reservations: Record<string, Reservation>;
  trip?: { at: string; reason: string };
  history: Array<{ at: string; event: "trip" | "grant"; reason: string; owner?: string; grant?: CircuitGrant }>;
}
export interface CircuitBudgetOptions {
  runtimeDir: string; scopeId: string; policy?: Partial<CircuitPolicy>;
  /** Clock and process source are injectable for deterministic recovery tests. */
  now?: () => number; processes?: ProcessLister; pollMs?: number;
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const iso = (now: number) => new Date(now).toISOString();
const label = (value: string) => typeof value === "string" && !["constructor", "prototype", "__proto__"].includes(value) && /^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]{0,255}$/.test(value);

export function validateCircuitPolicy(value: unknown): CircuitPolicy {
  if (!object(value) || Object.keys(value).some((key) => !(key in DEFAULT_CIRCUIT_POLICY))) throw new Error("Invalid circuit policy keys.");
  const result = { ...DEFAULT_CIRCUIT_POLICY, ...value };
  if (!Object.values(result).every(positive)) throw new Error("Circuit policy limits must be positive finite safe integers.");
  return result as CircuitPolicy;
}

/** Runtime-only accounting shared by every lane/process for one explicit goal or Product scope. */
export class CircuitBudget {
  readonly scopeId: string;
  readonly path: string;
  private readonly now: () => number;
  private readonly processes: ProcessLister;
  readonly pollMs: number;
  constructor(private readonly options: CircuitBudgetOptions) {
    if (!label(options.scopeId)) throw new Error("Circuit scope must be an explicit stable identifier.");
    this.scopeId = options.scopeId;
    this.path = join(options.runtimeDir, `circuit-${createHash("sha256").update(options.scopeId).digest("hex")}.json`);
    this.now = options.now ?? Date.now;
    this.processes = options.processes ?? listProcesses;
    this.pollMs = options.pollMs ?? 250;
    if (!positive(this.pollMs)) throw new Error("Invalid circuit polling interval.");
    if (options.policy) validateCircuitPolicy(options.policy);
  }

  private async initial(): Promise<CircuitLedger> {
    let configuration: unknown = {};
    try { configuration = JSON.parse(await readFile(join(this.options.runtimeDir, "circuit-policy.json"), "utf8")); }
    catch (error) { if (!missing(error)) throw new Error("Circuit policy is unreadable or invalid; refusing work."); }
    const policy = validateCircuitPolicy({ ...validateCircuitPolicy(configuration), ...this.options.policy });
    return { version: 1, scopeId: this.scopeId, policy,
      adoption: { at: iso(this.now()), historicalUsage: "unknown", accounting: "prospective" },
      totals: { tokens: 0, executionMs: 0, retries: 0 },
      limits: { tokens: policy.maxTokens, executionMs: policy.maxExecutionMs, retries: policy.maxRetries, phaseRetries: {} },
      retries: {}, reservations: {}, history: [] };
  }

  private validate(value: unknown): asserts value is CircuitLedger {
    if (!object(value) || value.version !== 1 || value.scopeId !== this.scopeId || !object(value.totals) || !object(value.limits)
      || ![value.totals.tokens, value.totals.executionMs, value.totals.retries].every(nonnegative) || !positive(value.limits.tokens) || !positive(value.limits.executionMs)
      || !positive(value.limits.retries) || !object(value.limits.phaseRetries) || !Object.values(value.limits.phaseRetries).every(positive)
      || !object(value.retries) || !object(value.reservations) || !Array.isArray(value.history)
      || !object(value.adoption) || value.adoption.historicalUsage !== "unknown" || value.adoption.accounting !== "prospective") throw new Error("Invalid circuit ledger; refusing work.");
    validateCircuitPolicy(value.policy);
    for (const reservation of Object.values(value.reservations)) {
      if (!object(reservation) || !object(reservation.owner) || !positive(reservation.owner.pid) || typeof reservation.owner.start !== "string"
        || !nonnegative(reservation.startedAt) || !nonnegative(reservation.accountedAt) || !positive(reservation.timeoutMs)
        || !nonnegative(reservation.tokenLimit) || !nonnegative(reservation.tokens)
        || !["model", "command"].includes(String(reservation.kind))) throw new Error("Invalid circuit reservation; refusing work.");
    }
  }

  private trip(ledger: CircuitLedger, reason: string): void {
    if (ledger.trip) return;
    ledger.trip = { at: iso(this.now()), reason };
    ledger.history.push({ ...ledger.trip, event: "trip" });
  }
  private assert(ledger: CircuitLedger): void {
    if (ledger.trip) throw new CircuitOpenError(this.scopeId, ledger.trip.reason);
  }
  private account(ledger: CircuitLedger): void {
    const now = this.now();
    for (const run of Object.values(ledger.reservations)) {
      ledger.totals.executionMs += Math.max(0, now - run.accountedAt);
      run.accountedAt = Math.max(now, run.accountedAt);
      if (now - run.startedAt >= run.timeoutMs) this.trip(ledger, "invocation execution time exhausted");
    }
    if (ledger.totals.executionMs >= ledger.limits.executionMs) this.trip(ledger, "cumulative execution time exhausted");
    if (ledger.totals.tokens >= ledger.limits.tokens) this.trip(ledger, "aggregate token budget exhausted");
  }
  private async reap(ledger: CircuitLedger): Promise<void> {
    if (!Object.keys(ledger.reservations).length) return;
    const rows = await this.processes(); // Failure refuses work; it never guesses that an owner died.
    for (const run of Object.values(ledger.reservations)) {
      if (rows.some((row) => row.pid === run.owner.pid && row.start === run.owner.start)) continue;
      ledger.totals.tokens += Math.max(0, run.tokenLimit - run.tokens);
      delete ledger.reservations[run.id];
      this.trip(ledger, "invocation owner exited with unknown final consumption");
    }
  }
  private async persist(ledger: CircuitLedger): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(ledger)}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.path);
    } catch {
      // A separate sticky marker makes a partial storage failure visible to other live wrappers/restarts.
      await writeFile(`${this.path}.tripped`, "ledger persistence failed\n", { flag: "wx", mode: 0o600 }).catch(() => undefined);
      throw new CircuitOpenError(this.scopeId, "ledger persistence failed");
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async transaction<T>(work: (ledger: CircuitLedger) => T | Promise<T>, recovery = false): Promise<T> {
    await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    return withFileLock(`${this.path}.lock`, async () => {
      let ledger: CircuitLedger;
      try { const value: unknown = JSON.parse(await readFile(this.path, "utf8")); this.validate(value); ledger = value; }
      catch (error) { if (!missing(error)) throw error; ledger = await this.initial(); }
      try { await readFile(`${this.path}.tripped`); this.trip(ledger, "ledger persistence failed"); }
      catch (error) { if (!missing(error)) throw error; }
      this.account(ledger);
      await this.reap(ledger);
      let result: T | undefined; let failure: unknown;
      try { result = await work(ledger); } catch (error) { failure = error; }
      await this.persist(ledger);
      if (recovery && !ledger.trip) await unlink(`${this.path}.tripped`).catch((error) => { if (!missing(error)) throw error; });
      if (failure) throw failure;
      return result as T;
    }, 5000);
  }

  status(): Promise<CircuitLedger> { return this.transaction((ledger) => structuredClone(ledger)); }
  assertAvailable(): Promise<void> { return this.transaction((ledger) => this.assert(ledger)); }

  /** Charge actual automatic repair starts only; polling and ordinary planned calls do not consume this counter. */
  chargeRetry(operationId: string, phase: string): Promise<void> {
    if (!label(operationId) || !label(phase)) throw new Error("Retries require stable operation and phase identifiers.");
    return this.transaction((ledger) => {
      this.assert(ledger);
      if (ledger.retries[operationId]) {
        if (ledger.retries[operationId].phase !== phase) throw new Error("Retry identifier reused across phases.");
        return;
      }
      const phaseCount = Object.values(ledger.retries).filter((retry) => retry.phase === phase).length;
      if (ledger.totals.retries >= ledger.limits.retries || phaseCount >= (ledger.limits.phaseRetries[phase] ?? ledger.policy.maxPhaseRetries)) {
        this.trip(ledger, "automatic repair budget exhausted"); this.assert(ledger);
      }
      ledger.retries[operationId] = { phase, at: iso(this.now()) };
      ledger.totals.retries++;
    });
  }

  /** Owner-facing API only. Every finite increment and the old trip remain in history; totals never reset. */
  async grant(grant: CircuitGrant): Promise<CircuitLedger> {
    if (!grant.owner?.trim() || !grant.reason?.trim()) throw new Error("A budget grant requires an owner and reason.");
    const amounts = [grant.tokens, grant.executionMs, grant.retries, ...Object.values(grant.phaseRetries ?? {})].filter((amount) => amount !== undefined);
    if (!amounts.length || !amounts.every(positive) || Object.keys(grant.phaseRetries ?? {}).some((phase) => !label(phase))) throw new Error("Grants must add positive finite safe integers.");
    return this.transaction((ledger) => {
      if (Object.keys(ledger.reservations).length) throw new Error("Wait for active invocations to stop before granting more budget.");
      const limits = structuredClone(ledger.limits);
      limits.tokens += grant.tokens ?? 0; limits.executionMs += grant.executionMs ?? 0; limits.retries += grant.retries ?? 0;
      for (const [phase, amount] of Object.entries(grant.phaseRetries ?? {})) limits.phaseRetries[phase] = (limits.phaseRetries[phase] ?? ledger.policy.maxPhaseRetries) + amount;
      if (![limits.tokens, limits.executionMs, limits.retries, ...Object.values(limits.phaseRetries)].every(positive)) throw new Error("Budget grant overflows safe limits.");
      ledger.limits = limits;
      ledger.history.push({ at: iso(this.now()), event: "grant", reason: grant.reason, owner: grant.owner, grant: structuredClone(grant) });
      delete ledger.trip;
      this.account(ledger);
      return structuredClone(ledger);
    }, true);
  }

  async begin(kind: "model" | "command", context: CircuitContext, requestedTimeoutMs?: number): Promise<Reservation> {
    if (!label(context.phase) || (context.operationId !== undefined && !label(context.operationId))) throw new Error("Invocation requires a stable phase and operation identifier.");
    if (requestedTimeoutMs !== undefined && !positive(requestedTimeoutMs)) throw new Error("Invocation timeout must be finite and positive.");
    const owner = (await this.processes()).find((row) => row.pid === process.pid);
    if (!owner) throw new Error("Cannot verify circuit invocation process identity.");
    return this.transaction((ledger) => {
      this.assert(ledger);
      const active = Object.values(ledger.reservations);
      if (kind === "model" && active.filter((run) => run.kind === "model").length >= ledger.policy.maxModelConcurrency) throw new CircuitBusyError();
      const remainingTokens = ledger.limits.tokens - ledger.totals.tokens - active.reduce((sum, run) => sum + Math.max(0, run.tokenLimit - run.tokens), 0);
      if (kind === "model" && remainingTokens <= 0) throw new CircuitBusyError();
      const run: Reservation = { id: randomUUID(), kind, ...context, owner: { pid: owner.pid, start: owner.start },
        startedAt: this.now(), accountedAt: this.now(), tokens: 0,
        timeoutMs: Math.max(1, Math.min(requestedTimeoutMs ?? ledger.policy.maxInvocationMs, ledger.policy.maxInvocationMs,
          Math.floor((ledger.limits.executionMs - ledger.totals.executionMs) / (active.length + 1)))),
        tokenLimit: kind === "model" ? Math.min(ledger.policy.maxInvocationTokens, remainingTokens) : 0 };
      ledger.reservations[run.id] = run;
      return structuredClone(run);
    });
  }
  usage(id: string, usage: TokenUsage): Promise<void> {
    return this.transaction((ledger) => {
      const run = ledger.reservations[id];
      if (!run) throw new Error("Unknown circuit invocation.");
      // Snapshots are monotonic within one invocation. Cache counters are already inside inputTokens.
      if (nonnegative(usage.inputTokens)) run.inputTokens = Math.max(run.inputTokens ?? 0, usage.inputTokens);
      if (nonnegative(usage.outputTokens)) run.outputTokens = Math.max(run.outputTokens ?? 0, usage.outputTokens);
      const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
      ledger.totals.tokens += Math.max(0, tokens - run.tokens); run.tokens = Math.max(run.tokens, tokens);
      if (run.tokens >= run.tokenLimit) this.trip(ledger, "invocation token budget exhausted");
      this.account(ledger); this.assert(ledger);
    });
  }
  finish(id: string): Promise<void> {
    return this.transaction((ledger) => {
      const run = ledger.reservations[id];
      if (!run) throw new Error("Unknown circuit invocation.");
      if (run.kind === "model" && (run.inputTokens === undefined || run.outputTokens === undefined)) {
        ledger.totals.tokens += Math.max(0, run.tokenLimit - run.tokens);
        this.trip(ledger, "model finished without complete token usage");
      }
      delete ledger.reservations[id]; this.account(ledger); this.assert(ledger);
    });
  }
  protectRuntime(runtime: AgentRuntime, context: CircuitContext): AgentRuntime { return protectRuntime(this, runtime, context); }
  protectShell(shell: Shell, context: CircuitContext): Shell { return protectShell(this, shell, context); }
}

type ObservedOptions = MessageOptions & { onUsage?: (usage: TokenUsage) => void };
type BoundedShell = { run(command: string, args: string[], cwd: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ShellResult> };

/** One bounded lifetime, including queued durable usage updates; no fire-and-forget ledger writes. */
async function protectedRun<T>(budget: CircuitBudget, kind: "model" | "command", context: CircuitContext,
  options: { signal?: AbortSignal; timeoutMs?: number }, execute: (options: ObservedOptions) => Promise<T>): Promise<T> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Invocation aborted.");
  const admission = await budget.status();
  const deadline = Date.now() + Math.min(options.timeoutMs ?? admission.policy.maxInvocationMs, admission.policy.maxInvocationMs);
  let reservation: Reservation;
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Invocation aborted.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CircuitBusyError();
    try { reservation = await budget.begin(kind, context, Math.min(options.timeoutMs ?? admission.policy.maxInvocationMs, remaining)); break; }
    catch (error) {
      if (!(error instanceof CircuitBusyError)) throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, Math.min(budget.pollMs, remaining));
        const abort = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(options.signal?.reason ?? new Error("Invocation aborted.")); };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();
  let queued = Promise.resolve(); let failure: unknown; let polling: Promise<void> | undefined;
  const stop = (error: unknown) => { failure ??= error; controller.abort(error); };
  const onUsage = (usage: TokenUsage) => {
    queued = queued.then(() => budget.usage(reservation.id, usage)).catch(stop);
  };
  const poll = setInterval(() => {
    if (polling) return;
    polling = budget.assertAvailable().catch(stop).finally(() => { polling = undefined; });
  }, budget.pollMs);
  poll.unref();
  let value: T | undefined; let executionError: unknown;
  try { value = await execute({ ...options, signal: controller.signal, timeoutMs: reservation.timeoutMs, onUsage }); }
  catch (error) { executionError = error; }
  finally {
    clearInterval(poll); options.signal?.removeEventListener("abort", forwardAbort);
    await queued;
    await polling;
    try { await budget.finish(reservation.id); } catch (error) { stop(error); }
  }
  if (failure) throw failure;
  if (executionError) throw executionError;
  return value as T;
}
export function protectRuntime(budget: CircuitBudget, runtime: AgentRuntime, context: CircuitContext): AgentRuntime {
  return { message: (prompt, schemaPath, sessionId, options: ObservedOptions = {}) =>
    protectedRun<AgentResult>(budget, "model", context, options, async (bounded) => {
      const report = (usage: TokenUsage) => { bounded.onUsage?.(usage); options.onUsage?.(usage); };
      try {
        const result = await runtime.message(prompt, schemaPath, sessionId, { ...options, ...bounded, onUsage: report } as ObservedOptions);
        if (result.facts?.usage) report(result.facts.usage);
        return result;
      } catch (error) {
        const facts = (error as { facts?: { usage?: TokenUsage } })?.facts;
        if (facts?.usage) report(facts.usage);
        throw error;
      }
    }) };
}
export function protectShell(budget: CircuitBudget, shell: Shell, context: CircuitContext): Shell {
  return { run: (command, args, cwd, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    protectedRun(budget, "command", context, options, (bounded) => (shell as BoundedShell).run(command, args, cwd, bounded)) } as BoundedShell;
}
