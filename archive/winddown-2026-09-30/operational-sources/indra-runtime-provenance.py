from pathlib import Path
r=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra')
p=r/'src/runtime-facts.ts';s=p.read_text();s=s.replace('  usage?: TokenUsage;\n  /** Codex', '  usage?: TokenUsage;\n  /** True only after a provider terminal receipt proves the invocation\'s final counters. */\n  usageComplete?: boolean;\n  /** Codex')
s=s.replace('  private activeMessage?: string;', '''  private activeMessage?: string;
  private terminalUsage = false;
  private streamTerminal = false;
  private endedClaudeMessage = false;
  private invalidUsage = false;
  logObserved = false;
  get usageRegressed(): boolean { return this.invalidUsage; }
  invalidateUsage(): void { this.invalidUsage = true; }
  private codexUsage(report: TokenUsage | undefined): void {
    if (report && ["inputTokens", "outputTokens"].some((key) => {
      const field = key as "inputTokens" | "outputTokens";
      return report[field] !== undefined && this.cumulative?.[field] !== undefined && report[field]! < this.cumulative[field]!;
    })) this.invalidUsage = true;
    this.cumulative = mergeCodexUsage(this.cumulative, report);
  }''')
s=s.replace('''      // Each report supersedes the preceding snapshot, including a provider counter reset.
      if (event.type === "turn.completed" || event.type === "turn.failed") this.cumulative = mergeCodexUsage(this.cumulative, normalizeUsage("codex", event.usage));''','''      if (event.type === "turn.started") { this.terminalUsage = false; this.streamTerminal = false; }
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        const report = normalizeUsage("codex", event.usage);
        this.codexUsage(report);
        this.streamTerminal = true;
        this.terminalUsage = report?.inputTokens !== undefined && report.outputTokens !== undefined;
      }''')
s=s.replace('    if (event.type === "result") this.resultUsage = mergeClaudeUsage(this.resultUsage, normalizeUsage("claude", event.usage));','''    if (event.type === "result") {
      const report = normalizeUsage("claude", event.usage);
      this.resultUsage = mergeClaudeUsage(this.resultUsage, report);
      this.terminalUsage = report?.inputTokens !== undefined && report.outputTokens !== undefined;
    }''')
s=s.replace('''    if (!jsonObject(entry)) return;
    if (this.engine === "codex") {
      if (entry.type === "session_meta"''','''    if (!jsonObject(entry)) return;
    this.logObserved = true;
    if (this.engine === "codex") {
      // The stdout terminal snapshot is newer than any concurrently finishing rollout-tail read.
      if (this.streamTerminal) return;
      if (entry.type === "event_msg" && jsonObject(entry.payload) && entry.payload.type === "task_started") this.terminalUsage = false;
      if (entry.type === "event_msg" && jsonObject(entry.payload) && entry.payload.type === "task_complete") this.terminalUsage = true;
      if (entry.type === "session_meta"''')
s=s.replace('this.cumulative = mergeCodexUsage(this.cumulative, normalizeUsage("codex", entry.payload.info.total_token_usage));', 'this.codexUsage(normalizeUsage("codex", entry.payload.info.total_token_usage));')
s=s.replace('    if (entry.type === "assistant" && jsonObject(entry.message)) this.message(entry.message.id, entry.message.usage, true);','''    if (entry.type === "user") { this.terminalUsage = false; this.endedClaudeMessage = false; }
    if (entry.type === "assistant" && jsonObject(entry.message)) {
      this.terminalUsage = false;
      const report = normalizeUsage("claude", entry.message.usage);
      this.endedClaudeMessage = entry.message.stop_reason === "end_turn" && report?.inputTokens !== undefined && report.outputTokens !== undefined;
      this.message(entry.message.id, entry.message.usage, true);
    }
    if (entry.type === "system" && entry.subtype === "turn_duration") this.terminalUsage = this.endedClaudeMessage;''')
s=s.replace('      ...(usage ? { usage } : {}), ...(this.cumulative', '      ...(usage ? { usage } : {}), ...(this.terminalUsage && !this.invalidUsage && usage?.inputTokens !== undefined && usage.outputTokens !== undefined ? { usageComplete: true } : {}), ...(this.cumulative')
s=s.replace('    if (!callback) return;\n    const current', '    if (!callback) return;\n    if (facts.usageRegressed) throw new RuntimeStop("Provider token accounting regressed; final usage is unknown.");\n    const current')
p.write_text(s)
p=r/'src/live-usage.ts';s=p.read_text();s=s.replace('  async read(): Promise<TokenUsage | undefined> {','''  /** Resume accounting starts after the existing log prefix, which belongs to earlier invocations. */
  async seekEnd(): Promise<void> {
    const file = await open(this.path, "r");
    try { this.offset = (await file.stat()).size; this.pending = Buffer.alloc(0); } finally { await file.close(); }
  }

  async read(): Promise<TokenUsage | undefined> {''');p.write_text(s)
p=r/'src/codex-runtime.ts';s=p.read_text().replace('export interface MessageOptions { /**', 'export interface MessageOptions { /** Wait for provider terminal accounting before ending a headed run. */ requireFinalUsage?: boolean; /**')
s=s.replace('facts: evidence, onUsage: usageReporter(evidence, options.onUsage), timeoutMs:', 'facts: evidence, requireFinalUsage: options.requireFinalUsage, onUsage: usageReporter(evidence, options.onUsage), timeoutMs:')
s=s.replace('      await readLog(rollout, evidence);', '      if (!evidence.logObserved) await readLog(rollout, evidence);')
s=s.replace('      const sandbox = sandboxArgs(this.write);', '''      let liveTail: LiveUsageTail | undefined;
      if (options.onUsage && sessionId) {
        const cwds = [resolve(this.cwd), await realpath(this.cwd).catch(() => resolve(this.cwd))];
        const existing = await codexRollout(env.CODEX_HOME || join(homedir(), ".codex"), cwds, 0, sessionId);
        if (existing) { liveTail = new LiveUsageTail(existing, "codex", undefined, evidence); await liveTail.seekEnd(); }
      }
      const sandbox = sandboxArgs(this.write);''')
s=s.replace('const since = Date.now(); let tail: LiveUsageTail | undefined;', 'const since = Date.now(); let tail = liveTail;')
s=s.replace('})().catch(() => { stop ??= new RuntimeStop("Codex usage callback failed.");', '})().catch(() => { evidence.invalidateUsage(); stop ??= new RuntimeStop("Codex usage callback failed.");')
s=s.replace('try { stream.push(part); } catch { stop ??= new RuntimeStop("Codex usage callback failed.");', 'try { stream.push(part); } catch { evidence.invalidateUsage(); stop ??= new RuntimeStop("Codex usage callback failed.");')
p.write_text(s)
p=r/'src/claude-runtime.ts';s=p.read_text().replace('facts: evidence, onUsage: usageReporter(evidence, options.onUsage), timeoutMs:', 'facts: evidence, requireFinalUsage: options.requireFinalUsage, onUsage: usageReporter(evidence, options.onUsage), timeoutMs:')
s=s.replace('      await readLog(await transcript(), evidence);', '      if (!evidence.logObserved) await readLog(await transcript(), evidence);').replace('if (started) await readLog(await claudeTranscript(id), evidence);', 'if (started && !evidence.logObserved) await readLog(await claudeTranscript(id), evidence);').replace('      else evidence.sessionId = undefined;', '      else if (!started) evidence.sessionId = undefined;');p.write_text(s)
p=r/'src/headed-session.ts';s=p.read_text().replace('  facts?: RuntimeFacts;', '  facts?: RuntimeFacts;\n  requireFinalUsage?: boolean;')
s=s.replace('then ends this session. Do not stage,', 'waits for the provider to finish the turn, then ends this session. After writing the file, finish your turn with a brief confirmation and do no further work. Do not stage,')
s=s.replace('''      if (text !== undefined && (text === previous || !running)) return parsed(text, spec);''','''      if (text !== undefined && (text === previous || !running)) {
        const result = parsed(text, spec);
        if (!spec.requireFinalUsage || spec.facts?.finish("succeeded").usageComplete === true) return result;
      }''')
s=s.replace('        throw new RuntimeStop(`${label} session ended without writing its result file.`);', '        throw new RuntimeStop(text !== undefined && spec.requireFinalUsage ? `${label} session ended without complete terminal usage.` : `${label} session ended without writing its result file.`);')
s=s.replace('    process.removeListener("SIGINT", ignoreInterrupt);', '    await tail?.read().catch(() => undefined);\n    process.removeListener("SIGINT", ignoreInterrupt);')
p.write_text(s)
