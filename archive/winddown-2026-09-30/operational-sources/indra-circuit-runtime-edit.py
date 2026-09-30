from pathlib import Path
root=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra')
def edit(name,old,new):
 p=root/name;s=p.read_text();assert old in s,name;s=s.replace(old,new);p.write_text(s)
edit('src/runtime-facts.ts','/** Internal, controlled messages only;', '''/** Publishes monotonic invocation snapshots; callers must terminate the run if the callback throws. */
export function usageReporter(facts: RuntimeFacts, callback?: (usage: TokenUsage) => void): () => void {
  let previous: TokenUsage = {};
  return () => {
    if (!callback) return;
    const current = facts.finish("succeeded").usage;
    if (!current) return;
    const next = { ...previous };
    for (const key of keys) if (current[key] !== undefined) next[key] = Math.max(previous[key] ?? 0, current[key]);
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    previous = next;
    callback({ ...next });
  };
}

/** Internal, controlled messages only;''')
edit('src/live-usage.ts','constructor(readonly path: string, readonly engine: RuntimeEngine, private readonly now = () => Date.now()) { this.facts = new RuntimeFacts(engine); }','constructor(readonly path: string, readonly engine: RuntimeEngine, private readonly now = () => Date.now(), facts?: RuntimeFacts) { this.facts = facts ?? new RuntimeFacts(engine); }')
edit('src/headed-session.ts','import { randomUUID }', 'import { LiveUsageTail } from "./live-usage.js";\nimport { randomUUID }')
edit('src/headed-session.ts','  timeoutMs: number;','  /** Incremental log accounting, using the same collector as final evidence. */\n  facts?: RuntimeFacts;\n  onUsage?: () => void;\n  timeoutMs: number;')
edit('src/headed-session.ts','  let seenStart = false; let previous: string | undefined;', '  let seenStart = false; let previous: string | undefined; let tail: LiveUsageTail | undefined;')
edit('src/headed-session.ts','      const text = await readFile(files.result', '      if (tail) { await tail.read().catch(() => undefined); spec.onUsage?.(); }\n      const text = await readFile(files.result')
edit('src/headed-session.ts','        seenStart = !!log;', '        seenStart = !!log;\n        if (log && spec.facts) { tail = new LiveUsageTail(log, spec.facts.engine, undefined, spec.facts); await tail.read().catch(() => undefined); spec.onUsage?.(); }')
edit('src/codex-runtime.ts','import { join, resolve }', 'import { homedir } from "node:os";\nimport { LiveUsageTail } from "./live-usage.js";\nimport { join, resolve }')
edit('src/codex-runtime.ts','RuntimeStop, jsonObject','RuntimeStop, usageReporter, jsonObject')
edit('src/codex-runtime.ts','export interface MessageOptions { signal?', 'export interface MessageOptions { /** Cumulative usage of this invocation, delivered while it runs. */ onUsage?: (usage: TokenUsage) => void; signal?')
edit('src/codex-runtime.ts','since: number): Promise<string | undefined>', 'since: number, sessionId?: string): Promise<string | undefined>')
edit('src/codex-runtime.ts','payload?: { cwd?: unknown }', 'payload?: { cwd?: unknown; id?: unknown }')
edit('src/codex-runtime.ts','cwds.includes(meta.payload.cwd))', 'cwds.includes(meta.payload.cwd) && (!sessionId || meta.payload.id === sessionId))')
edit('src/codex-runtime.ts','started: async () => (rollout ??= await codexRollout(home, cwds, since)), timeoutMs: options.timeoutMs ?? this.timeoutMs, signal: options.signal,','started: async () => (rollout ??= await codexRollout(home, cwds, since)), facts: evidence, onUsage: usageReporter(evidence, options.onUsage), timeoutMs: Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs), signal: options.signal,')
edit('src/codex-runtime.ts','    let response: unknown; let failed = false;', '    const reportUsage = usageReporter(evidence, options.onUsage);\n    let response: unknown; let failed = false;')
edit('src/codex-runtime.ts','      evidence.observe(event);', '      evidence.observe(event);\n      reportUsage();')
edit('src/codex-runtime.ts','const timeoutMs = options.timeoutMs ?? this.timeoutMs;', 'const timeoutMs = Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs);')
edit('src/codex-runtime.ts','    let stop: RuntimeStop | undefined;', '    let stop: RuntimeStop | undefined;\n    let usageTimer: ReturnType<typeof setInterval> | undefined;\n    let usageRead: Promise<void> | undefined;\n    let pollUsage: (() => Promise<void>) | undefined;')
edit('src/codex-runtime.ts','      ownsProcessGroup = process.platform', '''      if (options.onUsage) {
        const since = Date.now(); let tail: LiveUsageTail | undefined;
        const logHome = env.CODEX_HOME || join(homedir(), ".codex");
        const cwds = [resolve(this.cwd), await realpath(this.cwd).catch(() => resolve(this.cwd))];
        pollUsage = () => usageRead ??= (async () => {
          if (!evidence.sessionId) return;
          if (!tail) {
            const log = await codexRollout(logHome, cwds, since, evidence.sessionId);
            if (log) tail = new LiveUsageTail(log, "codex", undefined, evidence);
          }
          if (tail) await tail.read().catch(() => undefined);
          reportUsage();
        })().catch(() => { stop ??= new RuntimeStop("Codex usage callback failed."); controller.abort(); }).finally(() => { usageRead = undefined; });
        usageTimer = setInterval(() => { void pollUsage!(); }, 250);
        usageTimer.unref?.();
      }
      ownsProcessGroup = process.platform''')
# Avoid awaiting before event handlers are installed: realpath unnecessary canonical cwd matching already includes resolved cwd.
edit('src/codex-runtime.ts','const cwds = [resolve(this.cwd), await realpath(this.cwd).catch(() => resolve(this.cwd))];\n        pollUsage', 'const cwds = [resolve(this.cwd)];\n        pollUsage')
edit('src/codex-runtime.ts','        stream.push(part); if (!stop) progress?.push(part);','        try { stream.push(part); } catch { stop ??= new RuntimeStop("Codex usage callback failed."); controller.abort(); }\n        if (!stop) progress?.push(part);')
edit('src/codex-runtime.ts','      stream.end();\n      if (stop)', '      stream.end();\n      await pollUsage?.();\n      if (stop)')
edit('src/codex-runtime.ts','      stream.end();\n      throw recordedError', '      try { stream.end(); } catch { /* callback already failed */ }\n      throw recordedError')
edit('src/codex-runtime.ts','      clearTimeout(timeout);','      clearInterval(usageTimer);\n      await usageRead;\n      clearTimeout(timeout);')
edit('src/claude-runtime.ts','RuntimeStop, recordedError','RuntimeStop, usageReporter, recordedError')
edit('src/claude-runtime.ts','started: async () => { const path = await transcript(); started = !!path; return path; }, timeoutMs: options.timeoutMs ?? this.timeoutMs, signal: options.signal,','started: async () => { const path = await transcript(); started = !!path; return path; }, facts: evidence, onUsage: usageReporter(evidence, options.onUsage), timeoutMs: Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs), signal: options.signal,')
edit('src/claude-runtime.ts','    const stream = new RuntimeEventStream((event) => { evidence.observe(event);', '    const reportUsage = usageReporter(evidence, options.onUsage);\n    const stream = new RuntimeEventStream((event) => { evidence.observe(event); reportUsage();')
edit('src/claude-runtime.ts','const timeoutMs = options.timeoutMs ?? this.timeoutMs;', 'const timeoutMs = Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs);')
edit('src/claude-runtime.ts','      stream.end();\n      throw recordedError', '      try { stream.end(); } catch { /* callback already failed */ }\n      throw recordedError')
edit('src/claude-runtime.ts','        stream.end();\n        if (error)', '        try { stream.end(); } catch { error ??= new RuntimeStop("Claude usage callback failed."); }\n        if (error)')
edit('src/claude-runtime.ts','else { stream.push(part); progress.push(part); }','else { try { stream.push(part); } catch { cancel("Claude usage callback failed."); } progress.push(part); }')
