from pathlib import Path
r=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra')
p=r/'src/circuit-budget.ts';s=p.read_text();s=s.replace('const positive = (value:', '''// This process cannot die and reuse its own PID while this module is executing. Never cache foreign owners.
let verifiedSelf: OwnedProcess | undefined;
let verifyingSelf: Promise<OwnedProcess> | undefined;
async function ownIdentity(): Promise<OwnedProcess> {
  if (verifiedSelf) return verifiedSelf;
  return verifyingSelf ??= listProcesses().then((rows) => {
    const owner = rows.find((row) => row.pid === process.pid);
    if (!owner) throw new Error("Cannot verify circuit invocation process identity.");
    return verifiedSelf = { pid: owner.pid, start: owner.start };
  }).finally(() => { verifyingSelf = undefined; });
}
const positive = (value:''')
s=s.replace('''    if (!Object.keys(ledger.reservations).length) return;
    const rows = await this.processes(); // Failure refuses work; it never guesses that an owner died.
    for (const run of Object.values(ledger.reservations)) {''','''    const candidates = Object.values(ledger.reservations).filter((run) => this.options.processes !== undefined
      || !verifiedSelf || run.owner.pid !== verifiedSelf.pid || run.owner.start !== verifiedSelf.start);
    if (!candidates.length) return;
    const rows = await this.processes(); // Failure refuses work; it never guesses that a foreign owner died.
    for (const run of candidates) {''')
s=s.replace('  assertAvailable(): Promise<void> { return this.transaction((ledger) => this.assert(ledger)); }','''  assertAvailable(): Promise<void> { return this.transaction((ledger) => this.assert(ledger)); }
  /** Persist a workflow accounting failure so ordinary retry cannot reopen it. Reasons are controlled host messages. */
  stop(reason: string): Promise<void> {
    if (!reason.trim() || reason.length > 500) throw new Error("A circuit stop requires a bounded reason.");
    return this.transaction((ledger) => { this.trip(ledger, reason); });
  }''')
s=s.replace('    const owner = (await this.processes()).find((row) => row.pid === process.pid);','    const owner = this.options.processes === undefined ? await ownIdentity() : (await this.processes()).find((row) => row.pid === process.pid);')
s=s.replace('  finish(id: string): Promise<void>', '  finish(id: string, finalUsageKnown = false): Promise<void>')
s=s.replace('if (run.kind === "model" && (run.inputTokens === undefined || run.outputTokens === undefined))', 'if (run.kind === "model" && (!finalUsageKnown || run.inputTokens === undefined || run.outputTokens === undefined))')
s=s.replace('execute: (options: ObservedOptions) => Promise<T>', 'execute: (options: ObservedOptions, finalUsageKnown: () => void) => Promise<T>')
s=s.replace('  let value: T | undefined; let executionError: unknown;', '  let value: T | undefined; let executionError: unknown; let finalUsageKnown = false;')
s=s.replace('timeoutMs: reservation.timeoutMs, onUsage }); }', 'timeoutMs: reservation.timeoutMs, onUsage }, () => { finalUsageKnown = true; }); }')
s=s.replace('await budget.finish(reservation.id);', 'await budget.finish(reservation.id, finalUsageKnown);')
s=s.replace('context, options, async (bounded) => {', 'context, options, async (bounded, complete) => {')
s=s.replace('{ ...options, ...bounded, onUsage: report } as ObservedOptions', '{ ...options, ...bounded, onUsage: report, requireFinalUsage: true } as ObservedOptions')
s=s.replace('        if (finalUsage) report(finalUsage);\n        return result;', '        if (finalUsage) report(finalUsage);\n        if (result.facts?.usageComplete === true || (!result.facts && fallback)) complete();\n        return result;')
s=s.replace('const facts = (error as { facts?: { usage?: TokenUsage } })?.facts;', 'const facts = (error as { facts?: { usage?: TokenUsage; usageComplete?: boolean } })?.facts;')
s=s.replace('        if (facts?.usage) report(facts.usage);\n        throw error;', '        if (facts?.usage) report(facts.usage);\n        if (facts?.usageComplete === true) complete();\n        throw error;')
p.write_text(s)
p=r/'tests/circuit-budget.test.ts';s=p.read_text().replace('status: "succeeded", usage }', 'status: "succeeded", usageComplete: true, usage }').replace('{ facts: { usage: { inputTokens: 20, outputTokens: 10 } } }', '{ facts: { usageComplete: true, usage: { inputTokens: 20, outputTokens: 10 } } }')
s=s.replace('budget.finish(invocation.value.id)', 'budget.finish(invocation.value.id, true)').replace('budget.finish(occupying.id)', 'budget.finish(occupying.id, true)');p.write_text(s)
