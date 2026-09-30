from pathlib import Path
r=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra')
p=r/'tests/circuit-budget.test.ts';s=p.read_text().replace('import type { TokenUsage }', 'import { AgentRunError, RuntimeFacts, type TokenUsage }');s+='''

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
''';p.write_text(s)
p=r/'tests/headed-session.test.ts';s=p.read_text().replace('mkdir, mkdtemp, readdir, readFile, rm, writeFile', 'appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile');s+='''

it.each(["codex", "claude"] as const)("keeps headed %s visible until its terminal usage receipt follows the result file", async (engine) => {
  const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const home = join(dir, "harness", "seat-004", "codex");
  const runtime = engine === "codex" ? new CodexRuntime(dir, 60_000, { extraDirs: [] }, home, undefined, true) : new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, undefined, true);
  let finished = false;
  const run = runtime.message("Build", schema, undefined, { requireFinalUsage: true, onUsage: () => {} });
  void run.then(() => { finished = true; });
  await launched();
  let log: string; let ending: object[];
  if (engine === "codex") {
    await mkdir(join(home, "sessions"), { recursive: true }); log = join(home, "sessions", "rollout-terminal.jsonl");
    await writeFile(log, [
      { type: "session_meta", payload: { id: "terminal-session", cwd: dir } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 35, output_tokens: 7 } } } },
    ].map((value) => JSON.stringify(value)).join("\\n") + "\\n");
    ending = [{ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 37, output_tokens: 10 } } } }, { type: "event_msg", payload: { type: "task_complete" } }];
  } else {
    const args = call()[1]; const id = args[args.indexOf("--session-id") + 1];
    await transcript(id, [{ type: "assistant", sessionId: id, message: { id: "tool", stop_reason: "tool_use", usage: { input_tokens: 35, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 } } }]);
    log = join(config, "projects", "-tmp-project", `${id}.jsonl`);
    ending = [{ type: "assistant", sessionId: id, message: { id: "final", stop_reason: "end_turn", usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 } } }, { type: "system", subtype: "turn_duration", sessionId: id }];
  }
  await writeFile(resultFile(await taskFile()), JSON.stringify({ summary: "Done" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(finished).toBe(false); expect(child.kill).not.toHaveBeenCalled();
  await appendFile(log, ending.map((value) => JSON.stringify(value)).join("\\n") + "\\n");
  expect((await run).facts).toMatchObject({ usageComplete: true, usage: { inputTokens: 37, outputTokens: 10 } });
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

it("does not mistake a headed result file and stale counters for terminal usage", async () => {
  const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const run = failure(new ClaudeRuntime(dir, 200, { extraDirs: [] }, undefined, true).message("Build", schema, undefined, { requireFinalUsage: true, onUsage: () => {} }));
  await launched();
  const args = call()[1]; const id = args[args.indexOf("--session-id") + 1];
  await transcript(id, [{ type: "assistant", sessionId: id, message: { id: "tool", stop_reason: "tool_use", usage: { input_tokens: 35, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 } } }]);
  await writeFile(resultFile(await taskFile()), JSON.stringify({ summary: "Done" }));
  const error = await run;
  expect(error.facts.status).toBe("timed-out"); expect(error.facts.usageComplete).not.toBe(true);
});
''';p.write_text(s)
p=r/'tests/codex-runtime.test.ts';s=p.read_text();s+='''

it("skips resumed historical log prefixes and keeps the stdout terminal snapshot authoritative", async () => {
  const { mkdtemp, mkdir, writeFile, appendFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const home = await realpath(await mkdtemp(join(tmpdir(), "indra-resume-prefix-")));
  await mkdir(join(home, "sessions")); const log = join(home, "sessions", `rollout-${id}.jsonl`);
  const count = (input: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: 4 } } } }) + "\\n";
  await writeFile(log, JSON.stringify({ type: "session_meta", payload: { id, cwd: home } }) + "\\n" + count(100) + count(40) + count(60));
  const onUsage = vi.fn();
  try {
    const run = new CodexRuntime(home, 60_000, undefined, home, undefined, false).message("Continue", "/schema.json", id, { onUsage, previousSessionUsage: { inputTokens: 60, outputTokens: 4 } });
    await vi.waitFor(() => expect(child.input).toBe("Continue"));
    await appendFile(log, count(80));
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 20 })));
    child.close(answer + usage);
    const result = await run;
    expect(result.facts).toMatchObject({ usageComplete: true, usage: { inputTokens: 40, outputTokens: 5 } });
  } finally { child.close("", null); await rm(home, { recursive: true, force: true }); }
});
''';p.write_text(s)
p=r/'src/cli.ts';s=p.read_text().replace('import { CircuitBudget, CircuitOpenError, type CircuitGrant }', 'import { circuitShell } from "./circuit-scope.js";\nimport { CircuitBudget, CircuitOpenError, type CircuitGrant }')
s=s.replace('new SprintGitHub(processShell, store.runtimeDir).mergeVerification(goal.integration.prUrl).catch(() => undefined)', 'new SprintGitHub(circuitShell(processShell), store.runtimeDir).mergeVerification(goal.integration.prUrl).catch((error) => { if (error instanceof CircuitOpenError) throw error; return undefined; })')
s=s.replace('/** All model and posting paths use', '''/** Preserve the circuit/caller stop signal as well as the lifetime of the owning host. */
export function withRuntimeSignal(runtime: AgentRuntime, signal: AbortSignal): AgentRuntime {
  return { message: (prompt, schema, sessionId, options) => runtime.message(prompt, schema, sessionId, {
    ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
  }) };
}

/** All model and posting paths use''')
s=s.replace('const bounded = (runtime: AgentRuntime): AgentRuntime => ({ message: (prompt, schema, sessionId, messageOptions) => runtime.message(prompt, schema, sessionId, { ...messageOptions, signal: messageOptions?.signal ? AbortSignal.any([signals.signal, messageOptions.signal]) : signals.signal }) });', 'const bounded = (runtime: AgentRuntime): AgentRuntime => withRuntimeSignal(runtime, signals.signal);')
p.write_text(s)
p=r/'tests/cli.test.ts';s=p.read_text().replace('main, parseOptions }', 'main, parseOptions, withRuntimeSignal }');s+='''

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
''';p.write_text(s)
