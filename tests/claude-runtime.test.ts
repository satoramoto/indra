import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_OUTPUT_LIMIT, CLAUDE_STDERR_LIMIT, ClaudeRuntime } from "../src/claude-runtime.js";
import { AgentRunError } from "../src/runtime-facts.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
const id = "12345678-1234-4321-8765-123456789abc";
const handle = `claude:${id}`;
const envelope = (extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id, structured_output: { summary: "Done" }, usage: { input_tokens: 32, output_tokens: 9 }, ...extra });
class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn(() => true);
  input = "";
  constructor() { super(); this.stdin.on("data", (part) => { this.input += String(part); }); }
  close(output = envelope(), code: number | null = 0) { this.stdout.write(output); this.emit("close", code); }
}
let dir: string; let schema: string; let child: Process;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indra-claude-")); schema = join(dir, "schema.json");
  await writeFile(schema, JSON.stringify({ type: "object", required: ["summary"], properties: { summary: { type: "string" } } }));
  child = new Process(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.mocked(spawn).mockReset(); await rm(dir, { recursive: true, force: true }); });
async function launched() { await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1)); }
const args = () => vi.mocked(spawn).mock.calls[0][1] as string[];
const flag = (name: string) => args()[args().indexOf(name) + 1];

describe("Claude runtime", () => {
  it("pipes the prompt, constrains output with the actual schema, and preserves usage, timestamps and qualified IDs", async () => {
    const run = new ClaudeRuntime(dir).message("Task text stays on stdin", schema);
    await launched();
    expect(spawn).toHaveBeenCalledWith("claude", expect.any(Array), expect.objectContaining({ cwd: dir, stdio: ["pipe", "pipe", "pipe"] }));
    expect(child.input).toBe("Task text stays on stdin"); expect(args().join(" ")).not.toContain(child.input);
    expect(args()).toContain("--print"); expect(flag("--output-format")).toBe("stream-json");
    expect(args()).toEqual(expect.arrayContaining(["--verbose", "--include-partial-messages"]));
    expect(JSON.parse(flag("--json-schema"))).toMatchObject({ type: "object", required: ["summary"] });
    expect(args()).not.toContain("--resume"); expect(args()).not.toContain("--continue");
    child.close();
    const result = await run;
    expect(result).toMatchObject({ sessionId: handle, response: { summary: "Done" }, usage: { uncachedInputTokens: 32, outputTokens: 9 }, facts: { engine: "claude", sessionId: handle, status: "succeeded" } });
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it("resumes only the explicit Claude UUID, reapplies the schema, and disables interrupted-turn replay", async () => {
    vi.stubEnv("CLAUDE_CODE_RESUME_INTERRUPTED_TURN", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-must-not-forward");
    vi.stubEnv("OP_SESSION_example", "test-only-op-session");
    const run = new ClaudeRuntime(dir).message("Next", schema, handle);
    await launched(); expect(flag("--resume")).toBe(id); expect(args()).toContain("--json-schema");
    const env = vi.mocked(spawn).mock.calls[0][2]?.env;
    expect(env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("0"); expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OP_SESSION_example");
    child.close(); expect((await run).sessionId).toBe(handle);
  });

  it.each(["codex-session", "claude:", "claude:not-a-uuid"])("refuses a foreign or malformed handle: %s", async (bad) => {
    await expect(new ClaudeRuntime(dir).message("Task", schema, bad)).rejects.toThrow("Invalid Claude session handle");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps planning/review read-only and offline even with permissive host defaults", async () => {
    const run = new ClaudeRuntime(dir).message("Review", schema); await launched();
    expect(flag("--permission-mode")).toBe("plan"); expect(flag("--permission-prompts")).toBe("none");
    expect(flag("--tools")).toBe("Bash,Read,Glob,Grep"); expect(flag("--disallowedTools")).toContain("Edit,Write");
    expect(flag("--setting-sources")).toBe(""); expect(args()).toContain("--strict-mcp-config");
    expect(JSON.parse(flag("--settings"))).toMatchObject({ disableAllHooks: true, sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [], filesystem: { denyWrite: expect.arrayContaining(["/", dir]) }, network: { allowedDomains: [], strictAllowlist: true } } });
    expect(args()).not.toContain("--add-dir");
    child.close(); await run;
  });

  it("fails closed if read-only filesystem boundaries cannot be determined", async () => {
    await writeFile(join(dir, ".git"), "invalid gitdir pointer");
    await expect(new ClaudeRuntime(dir).message("Review", schema)).rejects.toThrow("Could not determine Claude read-only filesystem boundaries");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("grants Developer edits only in the worktree and named extras with mandatory sandboxing", async () => {
    const gitDir = join(dir, "shared.git");
    const run = new ClaudeRuntime(dir, 5000, { extraDirs: [gitDir] }).message("Build", schema); await launched();
    expect(flag("--permission-mode")).toBe("acceptEdits"); expect(flag("--add-dir")).toBe(gitDir);
    const settings = JSON.parse(flag("--settings"));
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [], filesystem: { allowWrite: [gitDir] } });
    expect(settings.permissions).toMatchObject({ disableBypassPermissionsMode: "disable", disableAutoMode: "disable" });
    expect(args().join(" ")).not.toContain("skip-permissions"); expect(args().join(" ")).not.toContain("bypassPermissions");
    child.close(); await run;
  });

  it("reports a missing executable without reflecting process diagnostics", async () => {
    const run = new ClaudeRuntime(dir).message("Task", schema); const check = expect(run).rejects.toThrow("Claude executable not found");
    await launched(); child.emit("error", Object.assign(new Error("private diagnostic"), { code: "ENOENT" })); await check;
  });

  it.each([
    ["malformed JSON", "not JSON private diagnostic", "malformed JSON"],
    ["array envelope", "[]", "malformed JSON"],
    ["error envelope", envelope({ subtype: "error_during_execution", is_error: true, errors: ["private diagnostic"] }), "did not complete successfully"],
    ["missing structured result", JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id, result: '{"summary":"unconstrained"}' }), "no schema-constrained response"],
    ["missing session", envelope({ session_id: undefined }), "session ID"],
    ["invalid session", envelope({ session_id: "--continue" }), "session ID"],
  ])("rejects %s without leaking the output", async (_name, output, message) => {
    const run = new ClaudeRuntime(dir).message("Task", schema); const check = expect(run).rejects.toThrow(message);
    await launched(); child.close(output); await check;
  });

  it("rejects a changed session ID on continuation", async () => {
    const run = new ClaudeRuntime(dir).message("Task", schema, handle); const check = expect(run).rejects.toThrow("mismatched session ID");
    await launched(); child.close(envelope({ session_id: "87654321-1234-4321-8765-123456789abc" })); await check;
  });

  it("withholds all stderr on a nonzero exit", async () => {
    const run = new ClaudeRuntime(dir).message("Task", schema); const check = expect(run).rejects.toThrow(/^Claude run failed \(7\); diagnostics withheld\.$/);
    await launched(); child.stderr.write("password=private-value and an unlabelled credential"); child.close("", 7); await check;
  });

  it("honors the per-turn timeout and kills an unresponsive child after cancellation", async () => {
    const run = new ClaudeRuntime(dir, 60_000).message("Task", schema, undefined, { timeoutMs: 100 });
    const check = expect(run).rejects.toThrow("timed out"); await launched();
    await check; expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"), { timeout: 1500 }); child.emit("close", null);
  });

  it("does not launch an already-aborted turn", async () => {
    await expect(new ClaudeRuntime(dir).message("Task", schema, undefined, { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancels an active turn and removes its abort listener", async () => {
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
    const run = new ClaudeRuntime(dir).message("Task", schema, undefined, { signal: controller.signal }); const check = expect(run).rejects.toThrow("cancelled");
    await launched(); controller.abort(); await check;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM"); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); child.emit("close", null);
  });

  it("does not resolve successfully when terminating a child closes it immediately", async () => {
    const controller = new AbortController();
    child.kill.mockImplementation(() => { child.emit("close", 0); return true; });
    const run = new ClaudeRuntime(dir).message("Task", schema, undefined, { signal: controller.signal }); const check = expect(run).rejects.toThrow("cancelled");
    await launched(); controller.abort(); await check;
  });

  it.skipIf(process.platform === "win32")("escalates for the owned process group even after its parent has exited", async () => {
    vi.useFakeTimers();
    Object.assign(child, { pid: 12345 });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const run = new ClaudeRuntime(dir).message("Task", schema, undefined, { signal: controller.signal }); const check = expect(run).rejects.toThrow("cancelled");
    await launched(); controller.abort(); await check;
    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  });

  it.each(["stdout", "stderr"] as const)("bounds %s without logging a truncated secret", async (stream) => {
    const run = new ClaudeRuntime(dir).message("Task", schema); const check = expect(run).rejects.toThrow(`${stream} exceeded the output limit`);
    await launched(); child[stream].write("x".repeat((stream === "stdout" ? CLAUDE_OUTPUT_LIMIT : CLAUDE_STDERR_LIMIT) + 1)); await check;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM"); child.emit("close", null);
  });

  it("rejects an unreadable or malformed schema before starting a model", async () => {
    await writeFile(schema, "private invalid text");
    await expect(new ClaudeRuntime(dir).message("Task", schema)).rejects.toThrow("schema could not be read as JSON");
    await expect(new ClaudeRuntime(dir).message("Task", join(dir, "missing"))).rejects.toThrow("schema could not be read as JSON");
    expect(spawn).not.toHaveBeenCalled();
  });
});

// Reduced Claude Code 2.1.283 stream-json frames. Assistant output_tokens is a placeholder;
// message_delta usage is cumulative for that API response, and result.usage covers the current turn.
const partial = [
  { type: "system", subtype: "init", session_id: id },
  { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_example", usage: { input_tokens: 32, cache_creation_input_tokens: 8, cache_read_input_tokens: 12, output_tokens: 1 } } } },
  { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 9 } } },
  { type: "assistant", session_id: id, parent_tool_use_id: null, message: { id: "msg_example", content: [{ type: "text", text: "private response" }], usage: { input_tokens: 32, cache_creation_input_tokens: 8, cache_read_input_tokens: 12, output_tokens: 1 } } },
].map((event) => JSON.stringify(event)).join("\n") + "\n";
const failure = (run: Promise<unknown>) => run.then(() => { throw new Error("Expected runtime failure"); }, (error: unknown) => {
  expect(error).toBeInstanceOf(AgentRunError);
  return error as AgentRunError;
});

describe("Claude invocation facts", () => {
  it("deduplicates streaming and final usage while retaining only allowlisted facts", async () => {
    const run = new ClaudeRuntime(dir).message("private prompt", schema); await launched();
    for (let n = 0; n < partial.length; n += 23) child.stdout.write(partial.slice(n, n + 23));
    child.close(envelope({ usage: { input_tokens: 32, cache_creation_input_tokens: 8, cache_read_input_tokens: 12, output_tokens: 9, diagnostic: "private diagnostic" } }));
    const result = await run;
    expect(result.facts?.usage).toEqual({ inputTokens: 52, uncachedInputTokens: 32, cachedInputTokens: 12, cacheWriteInputTokens: 8, outputTokens: 9 });
    expect(result.facts?.startedAt).toBe(result.startedAt); expect(result.facts?.finishedAt).toBe(result.finishedAt);
    expect(JSON.stringify(result.facts)).not.toMatch(/private|content|message|diagnostic/);
  });

  it.each([0, 7])("preserves error-envelope counters when Claude exits with %s", async (code) => {
    const run = failure(new ClaudeRuntime(dir).message("Task", schema)); await launched();
    child.close(envelope({ subtype: "error_max_turns", is_error: true, errors: ["private diagnostic"] }), code);
    const error = await run;
    expect(error.facts).toMatchObject({ engine: "claude", status: "failed", sessionId: handle, usage: { uncachedInputTokens: 32, outputTokens: 9 }, startedAt: expect.any(String), finishedAt: expect.any(String) });
    expect(JSON.stringify(error)).not.toMatch(/private diagnostic|structured_output/);
  });

  it("keeps partial usage after an output truncation and a zeroed crash result", async () => {
    const run = failure(new ClaudeRuntime(dir).message("Task", schema)); await launched();
    child.stdout.write(partial);
    child.close(envelope({ subtype: "error_during_execution", is_error: true, usage: { input_tokens: 0, output_tokens: 0 } }) + '\n{"partial', 1);
    const error = await run;
    expect(error.facts.usage).toEqual({ inputTokens: 52, uncachedInputTokens: 32, cachedInputTokens: 12, cacheWriteInputTokens: 8, outputTokens: 9 });
  });

  it.each(["interrupted", "timed-out"] as const)("records %s with identity and usage received before termination", async (status) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = failure(new ClaudeRuntime(dir).message("Task", schema, undefined, { timeoutMs: 500, signal: controller.signal }));
    await launched(); child.stdout.write(partial);
    if (status === "interrupted") controller.abort(); else await vi.advanceTimersByTimeAsync(500);
    const error = await run;
    expect(error.facts).toMatchObject({ engine: "claude", status, sessionId: handle, usage: { inputTokens: 52, outputTokens: 9 } });
    expect(Date.parse(error.facts.finishedAt)).toBeGreaterThanOrEqual(Date.parse(error.facts.startedAt));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM"); child.emit("close", null);
  });

  it("resumes the same handle but records only current-turn usage, not lifetime model totals", async () => {
    const run = new ClaudeRuntime(dir).message("Continue", schema, handle); await launched();
    child.close(envelope({ usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { "model": { inputTokens: 1000, outputTokens: 500 } } }));
    const result = await run;
    expect(result.facts?.usage).toEqual({ uncachedInputTokens: 10, outputTokens: 3 });
    expect(result.sessionId).toBe(handle); expect(flag("--resume")).toBe(id);
  });

  it("keeps missing usage unknown on success and failed launch", async () => {
    const run = new ClaudeRuntime(dir).message("Task", schema); await launched(); child.close(envelope({ usage: undefined }));
    expect((await run).facts?.usage).toBeUndefined();
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("private process diagnostic"); });
    const error = await failure(new ClaudeRuntime(dir).message("Task", schema));
    expect(error.facts).toMatchObject({ engine: "claude", status: "failed" });
    expect(error.facts.usage).toBeUndefined(); expect(error.facts.sessionId).toBeUndefined();
    expect(error.message).not.toContain("private");
  });

  it("records pre-launch cancellation and schema failures without exposing schema contents", async () => {
    const cancelled = await failure(new ClaudeRuntime(dir).message("Task", schema, handle, { signal: AbortSignal.abort() }));
    expect(cancelled.facts).toMatchObject({ engine: "claude", status: "interrupted", sessionId: handle });
    await writeFile(schema, "private schema text");
    const invalid = await failure(new ClaudeRuntime(dir).message("Task", schema));
    expect(invalid.facts).toMatchObject({ engine: "claude", status: "failed" });
    expect(JSON.stringify(invalid)).not.toContain("private schema text"); expect(spawn).not.toHaveBeenCalled();
  });
});
