import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PROMPT_LIMIT_BYTES, CodexRuntime } from "../src/codex-runtime.js";
import { AgentRunError } from "../src/runtime-facts.js";
import { ensureCodexHome } from "../src/harness-home.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("../src/codex-progress.js", () => ({ codexProgress: () => ({ push: vi.fn(), end: vi.fn() }) }));
vi.mock("../src/harness-home.js", () => ({ DEVELOPER_CODEX_CONFIG: "developer config", ensureCodexHome: vi.fn(async (home: string) => home) }));

// Reduced codex-cli 0.156.1 exec --json capture shapes; thread usage is cumulative.
const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const started = `{"type":"thread.started","thread_id":"${id}"}\n{"type":"turn.started"}\n`;
const answer = '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"{\\"ok\\":true}"}}\n';
const usage = '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":9}}';
class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
  input = "";
  constructor() { super(); this.stdin.on("data", (part) => { this.input += String(part); }); }
  close(output = started + answer + usage, code: number | null = 0) { this.stdout.write(output); this.emit("close", code); }
}
let child: Process;
beforeEach(() => {
  child = new Process();
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    options?.signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
      child.emit("error", Object.assign(new Error("private abort diagnostic"), { name: "AbortError" }));
    }, { once: true });
    return child as unknown as ReturnType<typeof spawn>;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.mocked(spawn).mockReset(); vi.mocked(ensureCodexHome).mockClear(); });
const args = () => vi.mocked(spawn).mock.calls[0][1] as string[];
const failure = (run: Promise<unknown>) => run.then(() => { throw new Error("Expected runtime failure"); }, (error: unknown) => {
  expect(error).toBeInstanceOf(AgentRunError);
  return error as AgentRunError;
});

describe("Codex invocation facts", () => {
  it("pipes prompts and records successful JSONL usage, engine, session and invocation times", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
    const run = new CodexRuntime("/workspace").message("Prompt stays on stdin", "/schema.json");
    expect(child.input).toBe("Prompt stays on stdin"); expect(args()).not.toContain(child.input);
    expect(args()).toEqual(["exec", "--json", "--sandbox", "read-only", "--output-schema", "/schema.json", "-"]);
    vi.setSystemTime(new Date("2026-09-28T10:00:02Z")); child.close();
    const result = await run;
    expect(result).toMatchObject({ sessionId: id, response: { ok: true }, startedAt: "2026-09-28T10:00:00.000Z", finishedAt: "2026-09-28T10:00:02.000Z", facts: { engine: "codex", status: "succeeded", sessionId: id, usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 9 } } });
    expect(result.usage).toEqual(result.facts?.usage);
    expect(JSON.stringify(result.facts)).not.toContain(child.input);
  });

  it("preserves explicit resume arguments and subtracts the persisted cumulative baseline", async () => {
    const run = new CodexRuntime("/workspace", 60_000, { extraDirs: ["/git-dir"] }).message("Continue", "/schema.json", id, { previousSessionUsage: { inputTokens: 60, outputTokens: 4 } });
    expect(args()).toEqual(["exec", "resume", id, "--json", "-c", 'sandbox_mode="read-only"', "-"]);
    child.close(answer + usage + "\n" + usage);
    const result = await run;
    expect(result.facts).toMatchObject({ sessionId: id, usage: { inputTokens: 40, outputTokens: 5 }, cumulativeUsage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 9 } });
    expect(result.facts?.usage).not.toHaveProperty("cachedInputTokens");
  });

  it("keeps a resumed total available when its prior baseline was never recorded", async () => {
    const run = new CodexRuntime("/workspace").message("Continue", "/schema.json", id);
    child.close(answer + usage);
    const result = await run;
    expect(result.facts?.cumulativeUsage?.inputTokens).toBe(100);
    expect(result.facts?.usage).toBeUndefined();
  });

  it("retains workspace-write, named extras, isolated home and OP-free child environment", async () => {
    vi.stubEnv("OP_SESSION_test", "fixture-only");
    const run = new CodexRuntime("/workspace", 60_000, { extraDirs: ["/git-dir"] }, "/seat-home").message("Build", "/schema.json");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(args()).toEqual(["exec", "--json", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", "/git-dir", "--output-schema", "/schema.json", "-"]);
    expect(vi.mocked(spawn).mock.calls[0][2]?.env).toMatchObject({ CODEX_HOME: "/seat-home" });
    expect(vi.mocked(spawn).mock.calls[0][2]?.env).not.toHaveProperty("OP_SESSION_test");
    child.close(); await run;
    expect(ensureCodexHome).toHaveBeenCalledTimes(2);
  });

  it.each([7, null])("preserves usage on exit %s without echoing stderr or a final response", async (code) => {
    const run = failure(new CodexRuntime("/workspace").message("Private prompt", "/schema.json"));
    child.stderr.write("private diagnostic"); child.close(started + answer + usage, code);
    const error = await run;
    expect(error.facts).toMatchObject({ engine: "codex", status: code === null ? "interrupted" : "failed", sessionId: id, usage: { inputTokens: 100, outputTokens: 9 } });
    expect(String(error)).not.toContain("private diagnostic");
    expect(JSON.stringify(error)).not.toMatch(/Private prompt|response|diagnostic/);
  });

  it("retains reports before malformed/truncated output and rejects a failed turn even on exit zero", async () => {
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json"));
    child.close(started + answer + usage + '\n{"type":"turn.failed","error":{"message":"private diagnostic"}}\n{"partial');
    const error = await run;
    expect(error.facts.usage?.inputTokens).toBe(100); expect(error.facts.status).toBe("failed");
    expect(error.message).toContain("did not complete successfully");
  });

  it("records a timeout after partial events and a complete final line without a newline", async () => {
    vi.useFakeTimers();
    const run = failure(new CodexRuntime("/workspace", 60_000).message("Task", "/schema.json", undefined, { timeoutMs: 100 }));
    child.stdout.write(started + usage);
    await vi.advanceTimersByTimeAsync(100);
    child.close("", null);
    const error = await run;
    expect(error.message).toContain("timed out");
    expect(error.facts).toMatchObject({ status: "timed-out", sessionId: id, usage: { inputTokens: 100, outputTokens: 9 } });
    expect(Date.parse(error.facts.finishedAt) - Date.parse(error.facts.startedAt)).toBe(100);
  });

  it("records active cancellation and removes the caller's abort listener", async () => {
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json", undefined, { signal: controller.signal }));
    child.stdout.write(started); controller.abort(); child.close("", null);
    const error = await run;
    expect(error.facts).toMatchObject({ status: "interrupted", sessionId: id });
    expect(error.facts.usage).toBeUndefined(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["interrupted", "timed-out", "stdin-error", "process-error"] as const)("drains buffered and shutdown usage before recording %s", async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController(); let settled = false;
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json", undefined, { timeoutMs: 500, signal: controller.signal }));
    void run.then(() => { settled = true; });
    child.stdout.write(started + usage.slice(0, 40));
    if (reason === "interrupted") controller.abort();
    else if (reason === "timed-out") await vi.advanceTimersByTimeAsync(500);
    else if (reason === "stdin-error") child.stdin.emit("error", new Error("private stdin diagnostic"));
    else child.emit("error", new Error("private process diagnostic"));
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    // Complete a frame buffered before shutdown, then repeat the cumulative report without a newline.
    child.close(usage.slice(40) + "\n" + usage);
    const error = await run;
    expect(error.facts).toMatchObject({ engine: "codex", status: reason.endsWith("error") ? "failed" : reason, sessionId: id, usage: { inputTokens: 100, outputTokens: 9 }, finishedAt: new Date().toISOString() });
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it("escalates a timeout and drains output before recording the forced exit", async () => {
    vi.useFakeTimers();
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json", undefined, { timeoutMs: 100 }));
    child.stdout.write(started);
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.close(usage, null);
    const error = await run;
    expect(error.facts).toMatchObject({ status: "timed-out", usage: { inputTokens: 100, outputTokens: 9 } });
    expect(Date.parse(error.facts.finishedAt) - Date.parse(error.facts.startedAt)).toBe(1100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")("drains inherited pipes when a Codex launcher's native child ignores termination", async () => {
    const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
    const native = `process.on("SIGTERM", () => process.stdout.write(${JSON.stringify(usage)})); process.stdout.write(${JSON.stringify(started)}); setInterval(() => {}, 1000);`;
    const launcher = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(native)}], { stdio: "inherit" }); process.on("SIGTERM", () => child.kill("SIGTERM")); child.on("exit", () => process.exit(0));`;
    let runner: ReturnType<typeof spawn> | undefined;
    let ready!: () => void;
    const startedChild = new Promise<void>((resolve) => { ready = resolve; });
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => {
      // Always isolate the fixture for cleanup, including when testing a regression in the runtime's options.
      runner = realSpawn(process.execPath, ["-e", launcher], { ...options, detached: true });
      let output = "";
      runner.stdout?.on("data", (part) => { output += String(part); if (output.includes('"type":"turn.started"')) ready(); });
      return runner;
    });
    const controller = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("Codex fixture pipes did not close")), 5000); });
    const run = failure(new CodexRuntime(process.cwd()).message("Task", "/schema.json", undefined, { signal: controller.signal }));
    try {
      await Promise.race([startedChild, deadline]);
      expect(vi.mocked(spawn).mock.calls[0][2]?.detached).toBe(true);
      controller.abort();
      const error = await Promise.race([run, deadline]);
      expect(error.facts).toMatchObject({ status: "interrupted", sessionId: id, usage: { inputTokens: 100, outputTokens: 9 } });
    } finally {
      clearTimeout(watchdog); controller.abort();
      if (runner?.pid) { try { process.kill(-runner.pid, "SIGKILL"); } catch { /* already exited */ } }
    }
  }, 10_000);

  it.skipIf(process.platform === "win32")("escalates for the owned Codex process group even after the launcher closes", async () => {
    vi.useFakeTimers();
    Object.assign(child, { pid: 12345 });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json", undefined, { signal: controller.signal }));
    controller.abort(); child.close("", null); await run;
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  });

  it("continues enforcing the stdout limit during cancellation", async () => {
    const controller = new AbortController();
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json", undefined, { signal: controller.signal }));
    child.stdout.write(started + usage + "\n"); controller.abort();
    child.stdout.write("x".repeat(10_000_001));
    child.close(usage.replace('"input_tokens":100', '"input_tokens":200'), null);
    expect((await run).facts).toMatchObject({ status: "interrupted", usage: { inputTokens: 100, outputTokens: 9 } });
  });

  it("refuses an oversized prompt before launching a process", async () => {
    const error = await failure(new CodexRuntime("/workspace").message("x".repeat(AGENT_PROMPT_LIMIT_BYTES + 1), "/schema.json"));
    expect(spawn).not.toHaveBeenCalled();
    expect(error.message).toContain("byte limit");
  });

  it("records an already-aborted invocation without launching a process", async () => {
    const error = await failure(new CodexRuntime("/workspace").message("Task", "/schema.json", id, { signal: AbortSignal.abort() }));
    expect(spawn).not.toHaveBeenCalled();
    expect(error.facts).toMatchObject({ status: "interrupted", engine: "codex", sessionId: id });
  });

  it.each(["stdout", "stderr"] as const)("keeps earlier evidence when %s exceeds its limit", async (stream) => {
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json"));
    child.stdout.write(started + usage + "\n");
    child[stream].write("x".repeat(stream === "stdout" ? 10_000_001 : 100_001));
    child.close("", null);
    const error = await run;
    expect(error.message).toContain(`${stream} exceeded`); expect(error.facts.usage?.inputTokens).toBe(100);
  });

  it("records spawn errors without leaking paths, prompts or process diagnostics", async () => {
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json"));
    child.emit("error", Object.assign(new Error("private diagnostic"), { code: "ENOENT" }));
    child.close("", -2);
    const error = await run;
    expect(error.message).toContain("executable not found"); expect(error.message).not.toContain("private");
    expect(error.facts.status).toBe("failed"); expect(error.facts.sessionId).toBeUndefined();
  });

  it("records synchronous start failures and missing final-response failures", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("private diagnostic"); });
    const failed = await failure(new CodexRuntime("/workspace").message("Task", "/schema.json"));
    expect(failed.facts.status).toBe("failed"); expect(failed.message).not.toContain("private");
    const run = failure(new CodexRuntime("/workspace").message("Task", "/schema.json"));
    child.close(started + usage);
    const error = await run;
    expect(error.message).toContain("no session id or final response"); expect(error.facts.usage?.inputTokens).toBe(100);
  });
});
