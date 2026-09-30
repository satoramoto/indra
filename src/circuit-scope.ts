import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./state-commit.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntime } from "./codex-runtime.js";
import type { Shell } from "./command-shell.js";
import { CircuitBudget, CircuitOpenError } from "./circuit-budget.js";

interface CircuitScope { budget: CircuitBudget; phase: string }
const current = new AsyncLocalStorage<CircuitScope>();
const wrappedShells = new WeakSet<Shell>();

/** Async-local identity keeps concurrent goals and their subprocess accounting separate. */
export function withCircuitScope<T>(runtimeDir: string, scopeId: string, phase: string, work: () => Promise<T>): Promise<T> {
  return current.run({ budget: new CircuitBudget({ runtimeDir, scopeId }), phase }, work);
}

/** Apply the surrounding goal's allowance to every command, including checks and Git operations. */
export function circuitShell(shell: Shell): Shell {
  if (wrappedShells.has(shell)) return shell;
  const wrapped: Shell = { run: (command, args, cwd, options) => {
    const scope = current.getStore();
    return (scope ? scope.budget.protectShell(shell, { phase: scope.phase }) : shell).run(command, args, cwd, options);
  } };
  wrappedShells.add(wrapped);
  return wrapped;
}

/** Repair identities are charged once even when a durable event is delivered again. */
export function circuitRuntime(runtime: AgentRuntime, runtimeDir: string, scopeId: string, phase: string, operationId: string, retry = false): AgentRuntime {
  const budget = new CircuitBudget({ runtimeDir, scopeId });
  return { message: async (...args) => {
    await budget.assertAvailable();
    // Count actual starts independently of workflow journals: an interrupted or invalid
    // response cannot get a free repair by replaying the same event or head revision.
    const key = createHash("sha256").update(`${scopeId}:${phase}:${operationId}`).digest("hex");
    const path = join(runtimeDir, `circuit-attempt-${key}.json`);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    try {
      await withFileLock(`${path}.lock`, async () => {
        let count = 0;
        try { count = JSON.parse(await readFile(path, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid attempt counter");
        if (retry || count > 0) await budget.chargeRetry(`${key}:${count}`, phase);
        const file = await open(`${path}.tmp`, "w", 0o600);
        try { await file.writeFile(`${count + 1}\n`); await file.sync(); } finally { await file.close(); }
        await rename(`${path}.tmp`, path);
        const directory = await open(runtimeDir, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error;
      throw new CircuitOpenError(scopeId, "invocation attempt accounting unavailable");
    }
    return budget.protectRuntime(runtime, { phase, operationId: key }).message(...args);
  } };
}

export const productCircuitScope = (teamId: string, seatId: string) => `product-${teamId}-${seatId}`;
