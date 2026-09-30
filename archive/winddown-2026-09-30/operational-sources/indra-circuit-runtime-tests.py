from pathlib import Path
r=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra')
p=r/'tests/codex-runtime.test.ts';s=p.read_text();s+='''

describe("live Codex budget accounting", () => {
  it("publishes monotonic invocation deltas before completion, including resumed baselines", async () => {
    const onUsage = vi.fn();
    const run = new CodexRuntime("/workspace").message("Continue", "/schema.json", id, { previousSessionUsage: { inputTokens: 60, outputTokens: 4 }, onUsage });
    child.stdout.write(usage + "\\n");
    expect(onUsage).toHaveBeenLastCalledWith({ inputTokens: 40, outputTokens: 5 });
    child.stdout.write(usage.replace('"input_tokens":100', '"input_tokens":80') + "\\n");
    expect(onUsage).toHaveBeenCalledTimes(1);
    child.close(answer + usage);
    await run;
  });

  it("cancels safely when a usage observer throws", async () => {
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json", undefined, { onUsage: () => { throw new Error("private observer diagnostic"); } }));
    child.stdout.write(started + usage + "\\n");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.close("", null);
    const error = await run;
    expect(error.message).toBe("Codex usage callback failed.");
    expect(error.facts.usage?.inputTokens).toBe(100);
  });

  it.each([false, true])("tails exact-session rollout while headless (resumed=%s), before turn.completed", async (resumed) => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "indra-live-codex-"));
    const onUsage = vi.fn(); const controller = new AbortController();
    try {
      const run = failure(new CodexRuntime(home, 60_000, undefined, home, undefined, false).message("Task", "/schema.json", resumed ? id : undefined,
        { signal: controller.signal, onUsage, ...(resumed ? { previousSessionUsage: { inputTokens: 60, outputTokens: 4 } } : {}) }));
      await vi.waitFor(() => expect(child.input).toBe("Task"));
      child.stdout.write(started);
      await mkdir(join(home, "sessions"));
      await writeFile(join(home, "sessions", "rollout-current.jsonl"), [
        { type: "session_meta", payload: { id, cwd: home } },
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } } } },
      ].map(JSON.stringify).join("\\n") + "\\n");
      await vi.waitFor(() => expect(onUsage).toHaveBeenCalled(), { timeout: 2000 });
      expect(onUsage.mock.lastCall?.[0]).toMatchObject({ inputTokens: resumed ? 40 : 100, outputTokens: resumed ? 5 : 9 });
      controller.abort(); child.close("", null);
      expect((await run).facts.status).toBe("interrupted");
      const calls = onUsage.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(onUsage).toHaveBeenCalledTimes(calls);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
''';s=s.replace('.map(JSON.stringify)', '.map((value) => JSON.stringify(value))');p.write_text(s)
p=r/'tests/claude-runtime.test.ts';s=p.read_text();s+='''

it("publishes Claude stream usage before the result and terminates on observer failure", async () => {
  const onUsage = vi.fn(() => { throw new Error("private observer diagnostic"); });
  const run = failure(new ClaudeRuntime(dir).message("Task", schema, undefined, { onUsage }));
  await launched();
  child.stdout.write(JSON.stringify({ type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_start", message: { id: "budget-message", usage: { input_tokens: 32, cache_creation_input_tokens: 8, cache_read_input_tokens: 12 } } } }) + "\\n");
  expect(onUsage).toHaveBeenLastCalledWith({ inputTokens: 52, uncachedInputTokens: 32, cachedInputTokens: 12, cacheWriteInputTokens: 8 });
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.close("", null);
  const error = await run;
  expect(error.message).toBe("Claude usage callback failed.");
  expect(error.facts.usage?.inputTokens).toBe(52);
});
''';p.write_text(s)
p=r/'tests/headed-session.test.ts';s=p.read_text();s+='''

it.each(["codex", "claude"] as const)("enforces live usage callbacks in headed %s and cleans task files", async (engine) => {
  const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const onUsage = vi.fn(() => { throw new Error("budget reached"); });
  const home = join(dir, "codex-home");
  const runtime = engine === "codex" ? new CodexRuntime(dir, 60_000, { extraDirs: [] }, home, undefined, true) : new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, undefined, true);
  const run = failure(runtime.message("Build", schema, undefined, { onUsage }));
  await launched();
  if (engine === "claude") {
    const args = call()[1]; const id = args[args.indexOf("--session-id") + 1];
    await transcript(id, [{ type: "assistant", sessionId: id, message: { id: "msg-budget", usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 7 } } }]);
  } else {
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "rollout-budget.jsonl"), [
      { type: "session_meta", payload: { id: "budget-session", cwd: dir } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 35, output_tokens: 7 } } } },
    ].map((value) => JSON.stringify(value)).join("\\n") + "\\n");
  }
  const error = await run;
  expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 35, outputTokens: 7 }));
  expect(error.facts.usage).toMatchObject({ inputTokens: 35, outputTokens: 7 });
  expect(child.kill).toHaveBeenCalled();
  expect((await readdir(join(dir, ".indra"))).filter((file) => /^(task|result)-/.test(file))).toEqual([]);
});
''';p.write_text(s)
p=r/'tests/command-shell.test.ts';s=p.read_text().replace('mkdtemp, realpath, rm','mkdtemp, readFile, realpath, rm');s+='''

it.each(["abort", "timeout"])("ends a command's detached grandchild on %s", async (reason) => {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), "indra-command-tree-")); roots.push(cwd);
  const marker = join(cwd, "grandchild.pid");
  const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const middle = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const script = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const run = processShell.run(process.execPath, ["-e", script], cwd, { signal: controller.signal, timeoutMs: reason === "timeout" ? 700 : 5000 });
  let pid = 0;
  try {
    await vi.waitFor(async () => { pid = Number(await readFile(marker, "utf8")); expect(pid).toBeGreaterThan(1); });
    if (reason === "abort") controller.abort();
    expect((await run).code).toBe(1);
    const { listProcesses } = await import("../src/process-tree.js");
    await vi.waitFor(async () => expect((await listProcesses()).some((row) => row.pid === pid)).toBe(false));
  } finally { controller.abort(); if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already ended */ } }
});

it("never launches a command when already cancelled", async () => {
  const controller = new AbortController(); controller.abort();
  const before = vi.mocked(childProcess.execFile).mock.calls.length;
  expect((await processShell.run("unused", [], "/", { signal: controller.signal })).code).toBe(1);
  expect(vi.mocked(childProcess.execFile).mock.calls.length).toBe(before);
});
''';p.write_text(s)
