import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import { claimHeaded, headedAvailable, headedMarkerFile, headedTiming, HELD_LINES, holdConsole, prepareTaskFiles, readHeadedMarker, runHeaded } from "../src/headed-session.js";
import { AgentRunError } from "../src/runtime-facts.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFile: vi.fn() }));
// Real process trees are covered in process-tree.test.ts; here each run's tree tracking is recorded.
const trees = vi.hoisted(() => ({ tracked: [] as (number | undefined)[], ended: 0 }));
vi.mock("../src/process-tree.js", async (original) => ({
  ...await original<typeof import("../src/process-tree.js")>(),
  ownedProcesses: { track: async (pid: number | undefined) => { trees.tracked.push(pid); return { refresh: async () => {}, end: async () => { trees.ended++; return 0; } }; } },
}));

/** The interactive CLI: no pipes; it exits when Indra signals it. */
class Headed extends EventEmitter {
  kill = vi.fn((signal?: NodeJS.Signals) => { setImmediate(() => this.emit("exit", null, signal)); return true; });
}
/** A headless `claude --print` process, for the fallback. */
class Piped extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn(() => true);
}

let dir: string; let schema: string; let config: string;
const timing = { ...headedTiming };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indra-headed-")); schema = join(dir, "schema.json"); config = join(dir, "claude-config");
  await writeFile(schema, JSON.stringify({ type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } }));
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
  Object.assign(headedTiming, { pollMs: 5, startupMs: 60_000, killGraceMs: 50 });
});
afterEach(async () => {
  Object.assign(headedTiming, timing);
  vi.unstubAllEnvs(); vi.mocked(spawn).mockReset();
  await rm(dir, { recursive: true, force: true });
});

const launched = async (calls = 1) => { await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(calls)); };
const call = (index = 0) => vi.mocked(spawn).mock.calls[index] as unknown as [string, string[], { cwd: string; stdio: unknown; env: NodeJS.ProcessEnv }];
const taskFile = async () => { const name = (await readdir(join(dir, ".indra"))).find((file) => file.startsWith("task-"))!; return join(dir, ".indra", name); };
const resultFile = (task: string) => task.replace(/task-(\w+)\.md$/, "result-$1.json");
const failure = (run: Promise<unknown>) => run.then(() => { throw new Error("Expected runtime failure"); }, (error: unknown) => { expect(error).toBeInstanceOf(AgentRunError); return error as AgentRunError; });
async function transcript(id: string, lines: object[]) {
  await mkdir(join(config, "projects", "-tmp-project"), { recursive: true });
  await writeFile(join(config, "projects", "-tmp-project", `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

describe("headedAvailable", () => {
  const tty = { isTTY: true };
  it.each([
    [{ INDRA_SEAT_PANE: "1" }, tty, true],
    [{}, tty, false],
    [{ INDRA_SEAT_PANE: "1", INDRA_HEADLESS: "1" }, tty, false],
    [{ INDRA_SEAT_PANE: "1", INDRA_HEADLESS: "0" }, tty, true],
    [{ INDRA_SEAT_PANE: "1" }, { isTTY: false }, false],
  ])("%j with a terminal %j is %s", (env, stream, expected) => {
    expect(headedAvailable(env, stream, stream)).toBe(expected);
  });

  it("lets only one headed session use the pane at a time", () => {
    const release = claimHeaded();
    expect(release).toBeDefined(); expect(claimHeaded()).toBeUndefined();
    release!();
    const again = claimHeaded(); expect(again).toBeDefined(); again!();
  });
});

describe("headed Claude", () => {
  it("runs the interactive CLI in this terminal on a task file and returns the validated result file with transcript usage", async () => {
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const run = new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, ["Developer"], true).message("Build the widget", schema);
    await launched();
    const [command, args, options] = call();
    expect(command).toBe("claude"); expect(options.stdio).toBe("inherit"); expect(options.cwd).toBe(dir);
    expect(args).not.toContain("--print"); expect(args).not.toContain("--json-schema");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual(["--model", "claude-opus-5-5", "--effort", "medium"]);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    const task = await taskFile();
    expect(args.slice(-2)).toEqual(["--", `Read .indra/${task.split("/").pop()} and do it.`]);
    expect(args.join(" ")).not.toContain("Build the widget");
    const document = await readFile(task, "utf8");
    expect(document).toContain("Build the widget"); expect(document).toContain(`.indra/${resultFile(task).split("/").pop()}`); expect(document).toContain('"required"');
    expect(await readFile(join(dir, ".indra", ".gitignore"), "utf8")).toBe("*\n");
    expect(options.env.CLAUDE_CODE_SANDBOXED).toBe("1"); expect(options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("300000"); expect(options.env.GITHUB_TOKEN).toBeUndefined();
    const id = args[args.indexOf("--session-id") + 1];
    await transcript(id, [
      { type: "user", sessionId: id },
      { type: "assistant", sessionId: id, message: { id: "msg_1", usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 7 } } },
      { type: "assistant", sessionId: id, isSidechain: true, message: { id: "msg_2", usage: { input_tokens: 999, output_tokens: 999 } } },
    ]);
    await writeFile(resultFile(task), JSON.stringify({ summary: "Done" }));
    const result = await run;
    expect(result).toMatchObject({ sessionId: `claude:${id}`, response: { summary: "Done" }, usage: { inputTokens: 35, uncachedInputTokens: 5, outputTokens: 7 }, facts: { engine: "claude", status: "succeeded" } });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect((await readdir(join(dir, ".indra"))).sort()).toEqual([".gitignore"]);
  });

  it("read-only sessions never prompt: dontAsk, sandboxed Bash, and Write allowed for the result file only", async () => {
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const run = new ClaudeRuntime(dir, 60_000, undefined, ["Developer"], true).message("Review", schema);
    await launched();
    const args = call()[1]; const task = await taskFile();
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Read,Glob,Grep,Write");
    expect(args[args.indexOf("--disallowedTools") + 1]).not.toContain("Write");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.permissions.allow).toEqual([`Write(/${resultFile(task)})`, `Edit(/${resultFile(task)})`]);
    expect(settings.sandbox).toMatchObject({ autoAllowBashIfSandboxed: true, network: { allowedDomains: [] } });
    expect(settings.sandbox.filesystem.denyWrite).toContain(dir);
    await transcript(args[args.indexOf("--session-id") + 1], []);
    await writeFile(resultFile(task), JSON.stringify({ summary: "Looks fine" }));
    await expect(run).resolves.toMatchObject({ response: { summary: "Looks fine" } });
  });

  it("rejects a result that does not match the schema and ends the session", async () => {
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const run = failure(new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, undefined, true).message("Build", schema));
    await launched();
    await writeFile(resultFile(await taskFile()), JSON.stringify({ summary: 3 }));
    const error = await run;
    expect(error.message).toBe("Claude wrote a result that does not match the output schema."); expect(error.facts.status).toBe("failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("an owner who quits the CLI before the result exists fails the task", async () => {
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const ended = trees.ended;
    const run = failure(new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, undefined, true).message("Build", schema));
    await launched(); await taskFile();
    child.emit("exit", 0, null);
    expect((await run).message).toBe("Claude session ended without writing its result file.");
    expect(child.kill).not.toHaveBeenCalled();
    // Tools the CLI left running still end with the run.
    expect(trees.ended).toBe(ended + 1);
  });

  it("keeps waiting while the owner drives, then times out honestly and ends the session", async () => {
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const run = failure(new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, undefined, true).message("Build", schema, undefined, { timeoutMs: 120 }));
    await launched();
    const error = await run;
    expect(error.message).toBe("Claude run timed out after 0 min."); expect(error.facts.status).toBe("timed-out");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to headless for the task when the CLI never starts a session", async () => {
    headedTiming.startupMs = 30;
    const headed = new Headed(); const piped = new Piped();
    vi.mocked(spawn).mockReturnValueOnce(headed as unknown as ReturnType<typeof spawn>).mockReturnValueOnce(piped as unknown as ReturnType<typeof spawn>);
    const run = new ClaudeRuntime(dir, 60_000, { extraDirs: [] }, undefined, true).message("Build", schema);
    await launched(2);
    expect(headed.kill).toHaveBeenCalledWith("SIGTERM");
    expect(call(1)[1]).toContain("--print");
    const id = "12345678-1234-4321-8765-123456789abc";
    piped.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id, structured_output: { summary: "Done" } }));
    piped.emit("close", 0);
    await expect(run).resolves.toMatchObject({ sessionId: `claude:${id}`, response: { summary: "Done" } });
  });

  it("stays headless when resuming a session", async () => {
    const piped = new Piped(); vi.mocked(spawn).mockReturnValue(piped as unknown as ReturnType<typeof spawn>);
    const id = "12345678-1234-4321-8765-123456789abc";
    const run = new ClaudeRuntime(dir, 60_000, undefined, undefined, true).message("Again", schema, `claude:${id}`);
    await launched();
    expect(call()[1]).toContain("--print");
    piped.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id, structured_output: { summary: "Done" } }));
    piped.emit("close", 0);
    await run;
  });
});

describe("headed Codex", () => {
  it("runs the interactive CLI with the seat home, the same sandbox and no prompts, and reads the rollout for the session and usage", async () => {
    const home = join(dir, "harness", "seat-004", "codex");
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const run = new CodexRuntime(dir, 60_000, { extraDirs: ["/tmp/git-common"] }, home, "model = \"x\"\n", true).message("Build the widget", schema);
    await launched();
    const [command, args, options] = call();
    expect(command).toBe("codex"); expect(options.stdio).toBe("inherit"); expect(options.env.CODEX_HOME).toBe(home);
    expect(args).not.toContain("exec");
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "--add-dir", "/tmp/git-common", "--ask-for-approval", "never", "check_for_update_on_startup=false"]));
    expect(args).toContain(`projects={${JSON.stringify(dir)}={trust_level="trusted"}}`);
    const task = await taskFile();
    expect(args.slice(-2)).toEqual(["--", `Read .indra/${task.split("/").pop()} and do it.`]);
    const id = "01a0edc4-5423-7bb1-a275-d78d1bc9c520";
    await mkdir(join(home, "sessions", "2026", "09", "29"), { recursive: true });
    await writeFile(join(home, "sessions", "2026", "09", "29", `rollout-2026-09-29T15-24-20-${id}.jsonl`), [
      { type: "session_meta", payload: { id, cwd: dir } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9, reasoning_output_tokens: 2 } } } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(resultFile(task), JSON.stringify({ summary: "Done" }));
    await expect(run).resolves.toMatchObject({ sessionId: id, response: { summary: "Done" }, usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 9, reasoningOutputTokens: 2 }, facts: { engine: "codex", status: "succeeded" } });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("read-only sessions stay headless: the read-only sandbox cannot write a result file", async () => {
    const piped = new Piped(); vi.mocked(spawn).mockReturnValue(piped as unknown as ReturnType<typeof spawn>);
    const run = new CodexRuntime(dir, 60_000, undefined, join(dir, "harness", "seat-004", "codex"), "model = \"x\"\n", true).message("Review", schema);
    await launched();
    expect(call()[1][0]).toBe("exec");
    piped.stdout.write('{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"{\\"summary\\":\\"ok\\"}"}}\n');
    piped.emit("close", 0);
    await expect(run).resolves.toMatchObject({ sessionId: "t1" });
  });
});

describe("the pane during a headed run", () => {
  const sink = () => {
    const lines: string[] = [];
    const out = (level: string) => (...args: unknown[]) => { lines.push(`${level} ${args.join(" ")}`); };
    return { lines, console: { log: out("log"), info: out("info"), warn: out("warn"), error: out("error") } };
  };

  it("holds this process's log lines while the CLI owns the pane and prints them in order once it ends", async () => {
    const child = new Headed(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const out = sink();
    const files = await prepareTaskFiles(dir);
    const marker = join(dir, "runtime", "headed-0123.json");
    let log: string | undefined;
    const run = runHeaded({ label: "Codex", cwd: dir, files, validate: () => true, launch: { command: "codex", args: [], env: {} },
      started: async () => log, timeoutMs: 60_000, marker, console: out.console });
    await launched();
    out.console.log("seat: claimed", 2); out.console.error("seat: warning"); out.console.info("seat: step");
    expect(out.lines).toEqual([]);
    // The marker says a headed run owns the pane, then where its session log is once the CLI started.
    await vi.waitFor(async () => expect(await readHeadedMarker(marker)).toMatchObject({ pid: process.pid, engine: "codex" }));
    expect((await readHeadedMarker(marker))?.log).toBeUndefined();
    log = join(dir, "rollout-x.jsonl");
    await vi.waitFor(async () => expect((await readHeadedMarker(marker))?.log).toBe(log));
    await writeFile(files.result, JSON.stringify({ summary: "Done" }));
    await expect(run).resolves.toEqual({ summary: "Done" });
    expect(out.lines).toEqual(["log seat: claimed 2", "error seat: warning", "info seat: step"]);
    // The console is the process's own again, and the marker is gone.
    out.console.log("after");
    expect(out.lines.at(-1)).toBe("log after");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("keeps at most HELD_LINES held lines, counts the rest, and releases once", () => {
    const out = sink();
    const release = holdConsole(out.console);
    for (let index = 0; index < HELD_LINES + 3; index++) out.console.warn("line", index);
    expect(out.lines).toEqual([]);
    release(); release();
    expect(out.lines).toHaveLength(HELD_LINES + 1);
    expect(out.lines[0]).toBe("warn line 0");
    expect(out.lines.at(-1)).toBe("log (3 more log lines from the headed run were dropped.)");
  });

  it("ignores a marker left by a process that is gone, and names markers only by a ready nonce", async () => {
    const file = headedMarkerFile(dir, "0123abcd-0000-4000-8000-000000000000");
    expect(file).toBe(`${dir}.runtime/headed-0123abcd-0000-4000-8000-000000000000.json`);
    expect(() => headedMarkerFile(dir, "../x")).toThrow();
    await mkdir(`${dir}.runtime`, { recursive: true });
    try {
      await writeFile(file, JSON.stringify({ pid: 99, engine: "claude", startedAt: "t", log: "/x/s.jsonl" }));
      expect(await readHeadedMarker(file, () => true)).toEqual({ pid: 99, engine: "claude", startedAt: "t", log: "/x/s.jsonl" });
      expect(await readHeadedMarker(file, () => false)).toBeUndefined();
    } finally { await rm(`${dir}.runtime`, { recursive: true, force: true }); }
  });
});
