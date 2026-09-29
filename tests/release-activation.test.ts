import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SprintIntegration } from "../src/planning.js";
import { LocalReleaseActivationReader } from "../src/release-activation.js";
import { IN_USE, switchDist, writeUpdateSettings, type RunningBuildReceipt } from "../src/self-update.js";
import { childEnv } from "../src/op-env.js";
import type { HostRecord } from "../src/tmux-host.js";

describe("release activation", () => {
  let root: string; let appDir: string; let state: string; let runtimeDir: string;
  let before: string; let merged: string; let after: string; let unrelated: string;
  let bridgeProcess: ChildProcess;
  const bridgeStart = "bridge birth"; const appStart = "application birth";
  const probe = async (pid: number) => {
    try { process.kill(pid, 0); } catch { return undefined; }
    return pid === process.pid ? appStart : pid === bridgeProcess.pid ? bridgeStart : undefined;
  };
  let application: RunningBuildReceipt; let bridge: RunningBuildReceipt; let record: HostRecord;
  let host: { verifiedRecord: ReturnType<typeof vi.fn<() => Promise<HostRecord | undefined>>> };
  let reader: LocalReleaseActivationReader;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf8", env: childEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  const integration = (): SprintIntegration => ({ branch: "sprint/goal-release", baseSha: before, status: "merged", mergedSha: merged });
  const stamp = (sha: string) => ({ id: `build-${sha}`, sha, builtAt: new Date().toISOString() });
  const writeReceipt = async (receipt: RunningBuildReceipt) => writeFile(join(runtimeDir, IN_USE, `${receipt.pid}.json`), JSON.stringify(receipt));
  async function build(sha: string): Promise<void> {
    await mkdir(join(appDir, "builds", sha), { recursive: true });
    await writeFile(join(appDir, "builds", sha, "cli.js"), "// built Indra");
    await writeFile(join(appDir, "builds", sha, "build-stamp.json"), JSON.stringify(stamp(sha)));
  }
  async function select(sha: string): Promise<void> {
    await build(sha);
    await switchDist(appDir, sha, { runtimeDir });
  }
  async function start(applicationSha = merged, bridgeSha = applicationSha): Promise<void> {
    const startedAt = new Date().toISOString();
    application = { pid: process.pid, processStart: appStart, appDir, build: join(appDir, "builds", applicationSha), stamp: stamp(applicationSha), role: "application", startedAt };
    bridge = { pid: bridgeProcess.pid!, processStart: bridgeStart, appDir, build: join(appDir, "builds", bridgeSha), stamp: stamp(bridgeSha), role: "bridge", startedAt, readyNonce: record.readyNonce };
    record.build = bridge.stamp.id;
    await writeReceipt(application); await writeReceipt(bridge);
  }
  async function ready(): Promise<void> {
    application.readyAt = new Date().toISOString();
    await writeReceipt(application);
    await writeFile(join(runtimeDir, `host-ready-${record.readyNonce}.json`), JSON.stringify({ nonce: record.readyNonce, pid: bridge.pid, readyAt: new Date().toISOString() }));
  }
  async function launchBridgeProcess(): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["-e", "process.send('started'); setInterval(() => {}, 1000)"], { env: childEnv(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise<void>((done, reject) => { child.once("message", () => done()); child.once("error", reject); });
    return child;
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "indra-release-")));
    appDir = join(root, "app"); await mkdir(appDir);
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-qm", "before"); before = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "integration"); merged = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "descendant"); after = git("rev-parse", "HEAD");
    unrelated = git("commit-tree", "HEAD^{tree}", "-m", "unrelated root");
    // Exercise real liveness without tmux; inject birth lookup because macOS agent sandboxes deny ps.
    bridgeProcess = await launchBridgeProcess();
  });
  afterAll(async () => {
    const exited = new Promise((done) => bridgeProcess.once("exit", done));
    bridgeProcess.kill(); await exited;
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    state = await mkdtemp(join(root, "state-")); runtimeDir = `${state}.runtime`;
    await mkdir(join(runtimeDir, IN_USE), { recursive: true });
    record = { socket: "owned", session: "owned", paneId: "%1", tmuxIdentity: "1:2", readyNonce: randomUUID(), appDir, stateCheckout: state, startedAt: new Date().toISOString() };
    host = { verifiedRecord: vi.fn(async () => record) };
    reader = new LocalReleaseActivationReader(state, { appDir, host, processStart: probe });
    await select(before);
  });
  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });

  it("separates human merge, successful build, dist switch, startup and both processes becoming ready", async () => {
    expect(await reader.read({ ...integration(), status: "pr-open" })).toMatchObject({ status: "update-pending" });
    expect(await reader.read(integration())).toMatchObject({ status: "update-pending" });
    await build(merged);
    expect(await reader.read(integration())).toMatchObject({ status: "update-pending" });
    await select(merged);
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending" });
    await start();
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending" });
    await ready();
    expect(await reader.read(integration())).toMatchObject({ status: "running", evidence: { mergedSha: merged, runningSha: merged, buildSha: merged } });
  });

  it("accepts ready descendants and recovers their evidence in a fresh reader without moving state", async () => {
    await select(after); await start(after); await ready();
    const first = await reader.read(integration());
    expect(first).toMatchObject({ status: "running", runningSha: after, bridgeSha: after, evidence: { mergedSha: merged, runningSha: after, buildSha: after } });
    expect(await new LocalReleaseActivationReader(state, { appDir, host, processStart: probe }).read(integration())).toEqual(first);
    expect(first.evidence).not.toHaveProperty("pid");
    expect(first.evidence).not.toHaveProperty("processStart");
  });

  it("accepts different application and bridge builds when both contain the integration", async () => {
    await select(after); await start(after, merged); await ready();
    expect(await reader.read(integration())).toMatchObject({ status: "running", evidence: { runningSha: after, buildSha: merged } });
  });

  it("rejects a dead process's leftover receipt and recovers after fresh startup and readiness", async () => {
    await select(merged); await start(); await ready();
    const exited = new Promise((done) => bridgeProcess.once("exit", done));
    bridgeProcess.kill(); await exited;
    bridgeProcess = await launchBridgeProcess();
    expect((await reader.read(integration())).status).toBe("reload-pending");
    record.readyNonce = randomUUID();
    await start();
    expect((await reader.read(integration())).status).toBe("reload-pending");
    await ready();
    expect((await reader.read(integration())).status).toBe("running");
  });

  it.each(["application", "bridge"])("keeps release pending while the loaded %s needs its safe restart", async (role) => {
    await select(after); await start(role === "application" ? before : merged, role === "bridge" ? before : merged); await ready();
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending", reason: expect.stringContaining("safe bridge restart") });
  });

  it("rejects unrelated loaded builds even when dist contains the integration", async () => {
    await select(after); await start(unrelated); await ready();
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending" });
  });

  it.each(["application", "bridge"] as const)("rejects a stale %s receipt, including a live PID with the wrong birth", async (role) => {
    await select(merged); await start(); await ready();
    const receipt = role === "application" ? application : bridge;
    await writeReceipt({ ...receipt, processStart: "a previous process with this PID" });
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending", reason: expect.stringMatching(/missing or stale/) });
    await writeReceipt(receipt);
    expect((await reader.read(integration())).status).toBe("running");
    await rm(join(runtimeDir, IN_USE, `${receipt.pid}.json`));
    expect((await new LocalReleaseActivationReader(state, { appDir, host, processStart: probe }).read(integration())).status).toBe("reload-pending");
  });

  it.each(["wrong-pid", "wrong-nonce", "error", "old-time", "missing"])("rejects %s bridge readiness instead of trusting a saved host build", async (kind) => {
    await select(merged); await start(); await ready();
    const file = join(runtimeDir, `host-ready-${record.readyNonce}.json`);
    if (kind === "missing") await rm(file);
    else await writeFile(file, JSON.stringify({ nonce: kind === "wrong-nonce" ? randomUUID() : record.readyNonce,
      pid: kind === "wrong-pid" ? process.pid : bridge.pid, readyAt: kind === "old-time" ? "2000-01-01T00:00:00Z" : new Date().toISOString(), ...(kind === "error" ? { error: "no-channel" } : {}) }));
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending", reason: expect.stringContaining("bridge readiness") });
  });

  it("requires matching owned host, loaded bridge build and startup nonce", async () => {
    await select(merged); await start(); await ready();
    host.verifiedRecord.mockResolvedValue(undefined);
    expect((await reader.read(integration())).status).toBe("reload-pending");
    host.verifiedRecord.mockResolvedValue({ ...record, build: "a different build" });
    expect((await reader.read(integration())).status).toBe("reload-pending");
    host.verifiedRecord.mockResolvedValue({ ...record, readyNonce: randomUUID() });
    expect((await reader.read(integration())).status).toBe("reload-pending");
  });

  it("rejects a different checkout and a pruning-only legacy record", async () => {
    await select(merged); await start(); await ready();
    await writeReceipt({ ...application, appDir: root });
    expect((await reader.read(integration())).status).toBe("reload-pending");
    await writeReceipt({ ...application, build: join(root, "unrelated", "dist") });
    expect((await reader.read(integration())).status).toBe("reload-pending");
    await writeFile(join(runtimeDir, IN_USE, `${application.pid}.json`), JSON.stringify({ pid: application.pid, build: application.build }));
    expect((await reader.read(integration())).status).toBe("reload-pending");
  });

  it("requires local history even for exact commit matches and retries when history returns", async () => {
    await select(merged); await start(); await ready();
    expect((await reader.read(integration())).status).toBe("running");
    const object = join(appDir, ".git", "objects", merged.slice(0, 2), merged.slice(2));
    const bytes = await readFile(object);
    try {
      await rm(object);
      expect(await reader.read(integration())).toMatchObject({ status: "unavailable", reason: expect.stringContaining("ancestry") });
    } finally { await writeFile(object, bytes); }
    expect((await reader.read(integration())).status).toBe("running");
  });

  it("stays pending across a paused restart even when both builds are ready", async () => {
    await select(merged); await start(); await ready();
    await writeUpdateSettings(runtimeDir, { paused: true });
    expect(await new LocalReleaseActivationReader(state, { appDir, host, processStart: probe }).read(integration())).toMatchObject({ status: "update-pending", reason: expect.stringContaining("press U") });
    await writeUpdateSettings(runtimeDir, { paused: false });
    expect((await reader.read(integration())).status).toBe("running");
  });

  it.each([
    [{ outcome: "blocked", installFailed: true }, "Dependency installation failed"],
    [{ outcome: "failed" }, "build failed"],
    [{ outcome: "checking" }, "check has not finished"],
    [{ outcome: "blocked" }, "Self-update is blocked"],
  ])("retains failed or interrupted updates across a reader restart (%j)", async (update, message) => {
    await select(merged); await start(); await ready();
    const file = join(runtimeDir, "self-update-status.json");
    await writeFile(file, JSON.stringify({ appDir, at: new Date().toISOString(), ...update }));
    const restarted = new LocalReleaseActivationReader(state, { appDir, host, processStart: probe });
    expect(await restarted.read(integration())).toMatchObject({ status: "update-pending", reason: expect.stringContaining(message) });
    await writeFile(file, JSON.stringify({ appDir, at: new Date().toISOString(), outcome: "up-to-date" }));
    expect((await restarted.read(integration())).status).toBe("running");
  });

  it("rejects rollback and revert states despite positive descendant ancestry", async () => {
    await select(after); await start(after); await ready();
    await writeUpdateSettings(runtimeDir, { paused: false, rollback: { build: after, sha: after, fromSha: merged } });
    expect(await reader.read(integration())).toMatchObject({ status: "update-pending", reason: expect.stringContaining("rollback") });
    expect((await reader.read({ ...integration(), revertPrUrl: "https://github.com/example/indra/pull/23" })).status).toBe("revert-open");
    expect((await reader.read({ ...integration(), status: "reverted" })).status).toBe("reverted");
  });

  it.each(["self-update.json", "self-update-status.json"])("fails closed on unreadable %s", async (file) => {
    await select(merged); await start(); await ready();
    await writeFile(join(runtimeDir, file), "{");
    expect(await reader.read(integration())).toMatchObject({ status: "unavailable", reason: expect.stringContaining("runtime records") });
  });

  it("does not use readiness from a bridge replaced while ancestry was checked", async () => {
    await select(merged); await start(); await ready();
    host.verifiedRecord.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, readyNonce: randomUUID() });
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending", reason: expect.stringContaining("restarted during") });
  });

  it("rejects processes whose identity lookup becomes unavailable", async () => {
    await select(merged); await start(); await ready();
    const unavailable = new LocalReleaseActivationReader(state, { appDir, host, processStart: async () => undefined });
    expect((await unavailable.read(integration())).status).toBe("reload-pending");
  });

  it("does not complete when update settings change during verification", async () => {
    await select(merged); await start(); await ready();
    host.verifiedRecord.mockResolvedValueOnce(record).mockImplementationOnce(async () => {
      await writeUpdateSettings(runtimeDir, { paused: true }); return record;
    });
    expect(await reader.read(integration())).toMatchObject({ status: "update-pending", reason: expect.stringContaining("changed during") });
  });
});
