import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headedTiming, prepareTaskFiles, runHeaded } from "../src/headed-session.js";
import { endOwned, membersOf, OwnedProcesses, parsePs, reapOrphans, type ProcessRow, type Signaller } from "../src/process-tree.js";

const row = (pid: number, ppid: number, pgid: number, start = `start ${pid}`): ProcessRow => ({ pid, ppid, pgid, start });

describe("process tree membership", () => {
  it("parses ps output and leaves zombies out", () => {
    expect(parsePs("  12     1    12 Ss   Tue Sep 29 10:00:00 2026\n  13    12    12 Z    Tue Sep 29 10:00:01 2026\n")).toEqual([{ pid: 12, ppid: 1, pgid: 12, start: "Tue Sep 29 10:00:00 2026" }]);
  });

  it("takes an owned process with its recorded start time, its descendants and the groups they lead, never itself or init", () => {
    const rows = [
      row(1, 0, 1), row(100, 1, 100), // this hosted process, leading its pane's group
      row(200, 100, 100), // the headed CLI, in the pane's group
      row(201, 200, 100), row(210, 200, 210), row(211, 210, 210), // a tool, and a background job in its own group
      row(212, 1, 210), // a member of that group whose parent already exited
      row(300, 1, 300), row(301, 300, 300), // unrelated
    ];
    const { members, groups } = membersOf(rows, [{ pid: 200, start: "start 200" }], 100);
    expect(members.map((item) => item.pid).sort()).toEqual([200, 201, 210, 211, 212]);
    expect(groups).toEqual([210]);
    // A reused pid (another start time) is not ours, and neither is anything under it.
    expect(membersOf(rows, [{ pid: 200, start: "earlier" }], 100).members).toEqual([]);
    // Owning this process or init by mistake still never signals either, nor this process's group.
    expect(membersOf(rows, [{ pid: 100, start: "start 100" }, { pid: 1, start: "start 1" }], 100)).toEqual({ members: [], groups: [] });
    expect(membersOf([...rows, row(400, 1, 100)], [{ pid: 400, start: "start 400" }], 100)).toEqual({ members: [row(400, 1, 100)], groups: [] });
  });

  it("ends a tree with SIGTERM and SIGKILLs what is left after the grace period", async () => {
    let rows = [row(100, 1, 100), row(200, 100, 100), row(210, 200, 210), row(211, 210, 210)];
    const signals: [number, NodeJS.Signals][] = [];
    // 211 ignores SIGTERM.
    const kill: Signaller = (pid, signal) => { signals.push([pid, signal]); if (pid > 0 && (signal === "SIGKILL" || pid !== 211)) rows = rows.filter((item) => item.pid !== pid); };
    expect(await endOwned([{ pid: 200, start: "start 200" }], { list: async () => rows, kill, self: 100, graceMs: 30, pollMs: 5 })).toBe(3);
    expect(signals.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid).sort()).toEqual([-210, 200, 210, 211].sort());
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([[211, "SIGKILL"]]);
    expect(rows.map((item) => item.pid)).toEqual([100]);
  });
});

describe("orphan reaper", () => {
  let runtime: string;
  beforeEach(async () => { runtime = await mkdtemp(join(tmpdir(), "indra-reap-")); });
  afterEach(async () => { await rm(runtime, { recursive: true, force: true }); });

  it("ends only what a hosted process that is gone recorded, verified by start time, and removes its record", async () => {
    let rows = [
      row(50, 1, 50), // a live hosted process with its own record
      row(60, 50, 50), // its headed CLI
      row(200, 1, 200), row(201, 200, 200), row(210, 1, 210), // left by a dead hosted process (pid 40)
      row(220, 1, 220, "reused"), // the dead process recorded pid 220, now reused by someone else
      row(300, 1, 300), // never recorded
    ];
    await writeFile(join(runtime, "owned-40.json"), JSON.stringify({ owner: { pid: 40, start: "start 40" }, processes: [{ pid: 200, start: "start 200" }, { pid: 210, start: "start 210" }, { pid: 220, start: "start 220" }] }));
    await writeFile(join(runtime, "owned-50.json"), JSON.stringify({ owner: { pid: 50, start: "start 50" }, processes: [{ pid: 60, start: "start 60" }] }));
    // Names another owner than its file: ignored.
    await writeFile(join(runtime, "owned-70.json"), JSON.stringify({ owner: { pid: 71, start: "x" }, processes: [{ pid: 300, start: "start 300" }] }));
    const signalled = new Set<number>();
    const kill: Signaller = (pid) => { signalled.add(pid); rows = rows.filter((item) => item.pid !== pid && item.pgid !== -pid); };
    expect(await reapOrphans(runtime, { list: async () => rows, kill, self: 999, graceMs: 20, pollMs: 5 })).toBe(3);
    expect([...signalled].sort((a, b) => a - b)).toEqual([-210, -200, 200, 201, 210]);
    expect(rows.map((item) => item.pid)).toEqual([50, 60, 220, 300]);
    expect((await readdir(runtime)).sort()).toEqual(["owned-50.json", "owned-70.json"]);
  });
});

/**
 * A fake engine CLI, like Claude Code or Codex running tools: a tool in its own process group, a background job in a
 * group of its own (like `npm run test:watch` started by the Bash tool), and a node child with its own worker. It
 * writes every descendant's pid to `pids`, and writes its result when REPRO_RESULT is set.
 */
const FAKE_CLI = `
const { spawn } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const pids = process.argv[2];
const note = (pid) => appendFileSync(pids, pid + "\\n");
note(spawn("sleep", ["1000"], { stdio: "ignore" }).pid);
spawn("/bin/sh", ["-c", "sleep 1000 & echo $! >> '" + pids + "'; node -e 'setInterval(()=>{},1e9)' & echo $! >> '" + pids + "'; echo $$ >> '" + pids + "'; wait"], { detached: true, stdio: "ignore" });
note(spawn(process.execPath, ["-e", "const c = require('child_process').spawn('sleep', ['1000'], { stdio: 'ignore' }); require('fs').appendFileSync(process.argv[1], c.pid + '\\\\n'); setInterval(() => {}, 1e9)", pids], { stdio: "ignore" }).pid);
if (process.env.REPRO_RESULT) setTimeout(() => writeFileSync(process.env.REPRO_RESULT, JSON.stringify({ summary: "ok" })), 1500);
setInterval(() => {}, 1e9);
`;
/** The CLI's six descendants. */
const DESCENDANTS = 6;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => Promise<boolean> | boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise((done) => setTimeout(done, 50)); }
};

describe("headed runs end their whole process tree", { timeout: 60_000 }, () => {
  let dir: string; let cli: string; let pidsFile: string;
  const timing = { ...headedTiming };
  const survivors: number[] = [];
  const pids = async () => (await readFile(pidsFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "indra-tree-")); cli = join(dir, "fake-cli.cjs"); pidsFile = join(dir, "pids");
    await writeFile(cli, FAKE_CLI);
    Object.assign(headedTiming, { pollMs: 50, killGraceMs: 1000, treeMs: 200 });
  });
  afterEach(async () => {
    Object.assign(headedTiming, timing);
    // Never leave a process behind, even when an assertion failed.
    for (const pid of [...survivors.splice(0), ...await pids()]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (result: boolean, timeoutMs = 60_000, signal?: AbortSignal) => {
    const files = await prepareTaskFiles(dir);
    return runHeaded({
      label: "Claude", cwd: dir, files, validate: () => true, timeoutMs, signal,
      launch: { command: process.execPath, args: [cli, pidsFile], env: { ...process.env, ...(result ? { REPRO_RESULT: files.result } : {}) } },
      started: async () => "/tmp/session.jsonl",
      owned: new OwnedProcesses(),
      console: { log() {}, info() {}, warn() {}, error() {} },
    });
  };

  it("leaves zero survivors when the CLI completes its task", async () => {
    expect(await run(true)).toEqual({ summary: "ok" });
    const started = await pids();
    expect(started).toHaveLength(DESCENDANTS);
    await until(() => started.every((pid) => !alive(pid)), 3000);
  });

  it("leaves zero survivors when the run is stopped", async () => {
    const controller = new AbortController();
    const running = run(false, 60_000, controller.signal).catch((error: unknown) => error);
    await until(async () => (await pids()).length === DESCENDANTS);
    controller.abort();
    expect(await running).toMatchObject({ status: "interrupted" });
    const started = await pids();
    await until(() => started.every((pid) => !alive(pid)), 3000);
  });
});

/** A hosted process: records its runs under `runtime` and runs one headed task with the fake CLI until stopped. */
const HOSTED = (src: string, runtime: string, cli: string, pids: string, work: string) => `
const { ownedProcesses } = await import(${JSON.stringify(join(src, "process-tree.ts"))});
const headed = await import(${JSON.stringify(join(src, "headed-session.ts"))});
Object.assign(headed.headedTiming, { pollMs: 50, treeMs: 200 });
ownedProcesses.useRecord(${JSON.stringify(runtime)});
const files = await headed.prepareTaskFiles(${JSON.stringify(work)});
await headed.runHeaded({
  label: "Claude", cwd: ${JSON.stringify(work)}, files, validate: () => true, timeoutMs: 600000,
  launch: { command: process.execPath, args: [${JSON.stringify(cli)}, ${JSON.stringify(pids)}], env: process.env },
  started: async () => "/tmp/session.jsonl", console: { log() {}, info() {}, warn() {}, error() {} },
}).catch(() => undefined);
`;

describe("hosted process restarts", { timeout: 90_000 }, () => {
  let dir: string; let runtime: string; let pidsFile: string;
  const hosts: number[] = [];
  const pids = async () => (await readFile(pidsFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "indra-hosted-")); runtime = join(dir, "state.runtime"); pidsFile = join(dir, "pids");
    await mkdir(runtime); await mkdir(join(dir, "work"));
    await writeFile(join(dir, "fake-cli.cjs"), FAKE_CLI);
    await writeFile(join(dir, "hosted.mts"), HOSTED(resolve("src"), runtime, join(dir, "fake-cli.cjs"), pidsFile, join(dir, "work")));
  });
  afterEach(async () => {
    for (const pid of [...hosts.splice(0), ...await pids()]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  });

  /** Starts the hosted process and waits until its CLI's whole tree runs and is recorded. */
  const host = async () => {
    // One node process (no tsx wrapper), like `node dist/cli.js seat run` in its pane.
    const child = spawn(process.execPath, ["--import", "tsx", join(dir, "hosted.mts")], { cwd: process.cwd(), stdio: "ignore", detached: true });
    hosts.push(child.pid!);
    await until(async () => (await pids()).length === DESCENDANTS);
    await until(async () => {
      const record = await readFile(join(runtime, `owned-${child.pid}.json`), "utf8").catch(() => "");
      return !!record && (await pids()).every((pid) => record.includes(`"pid":${pid},`));
    });
    return child;
  };

  it("ends the whole tree when the hosted process is stopped (SIGHUP from tmux, or SIGTERM)", async () => {
    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      const child = await host();
      const started = await pids();
      const exited = new Promise((done) => child.once("exit", done));
      process.kill(child.pid!, signal);
      await exited;
      await until(() => started.every((pid) => !alive(pid)), 5000);
      expect(existsSync(join(runtime, `owned-${child.pid}.json`))).toBe(false);
      await rm(pidsFile, { force: true });
    }
  });

  it("reaps what a killed hosted process left, at the next start-up", async () => {
    const child = await host();
    const started = await pids();
    const exited = new Promise((done) => child.once("exit", done));
    process.kill(child.pid!, "SIGKILL");
    await exited;
    await new Promise((done) => setTimeout(done, 300));
    // Before the fix, these are the processes that leaked.
    expect(started.filter(alive).length).toBeGreaterThan(0);
    expect(await reapOrphans(runtime, { graceMs: 1000 })).toBeGreaterThan(0);
    await until(() => started.every((pid) => !alive(pid)), 5000);
    expect(await readdir(runtime)).toEqual([]);
  });
});
