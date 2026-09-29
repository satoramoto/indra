import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildStamp } from "./build-stamp.js";
import { childEnv } from "./op-env.js";
import { appRootOf } from "./reload.js";

export const IN_USE = "builds-in-use";

/** Captured by the loaded CLI, never reconstructed from checkout HEAD or the current dist link. */
export interface RunningBuildReceipt {
  pid: number; build: string; appDir: string; stamp: BuildStamp;
  role: "application" | "bridge"; processStart: string; startedAt: string;
  readyAt?: string; readyNonce?: string;
}
const applications = new Map<string, RunningBuildReceipt>();

function liveStart(output: string): string | undefined {
  const fields = /^(.*?)\s+(\S+)$/.exec(output.trim());
  return fields?.[1] && !/^[ZX]/.test(fields[2]) ? fields[1] : undefined;
}

/** PID alone is insufficient: a leftover receipt must not identify a later process that reused it. */
export async function processStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return new Promise((done) => {
    try {
      execFile("ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="], { encoding: "utf8", timeout: 2000, maxBuffer: 4096, env: { ...childEnv(), LC_ALL: "C" } }, (error, stdout) => done(error ? undefined : liveStart(stdout)));
    } catch { done(undefined); }
  });
}

function currentProcessStart(): string | undefined {
  try { return liveStart(execFileSync("ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "stat="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...childEnv(), LC_ALL: "C" } })); }
  catch { return undefined; }
}

/** Marks the loaded application ready on its first update check, including when updates are paused. */
export function confirmApplicationReady(runtimeDir: string): void {
  const receipt = applications.get(resolve(runtimeDir));
  if (!receipt || receipt.readyAt) return;
  const file = join(runtimeDir, IN_USE, `${process.pid}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const ready = { ...receipt, readyAt: new Date().toISOString() };
    writeFileSync(temporary, JSON.stringify(ready), { mode: 0o600 });
    renameSync(temporary, file);
    applications.set(resolve(runtimeDir), ready);
  } catch { try { rmSync(temporary, { force: true }); } catch { /* readiness stays unavailable */ } }
}

/**
 * Records in `<runtimeDir>/builds-in-use/<pid>.json` the real build directory this process runs from, so pruning
 * keeps it while the process lives. The record is removed on a clean exit; one left by a dead pid is ignored.
 */
export function recordRunningBuild(runtimeDir: string, moduleUrl: string, birth: () => string | undefined = currentProcessStart): void {
  try {
    const build = realpathSync(new URL(".", moduleUrl));
    const file = join(runtimeDir, IN_USE, `${process.pid}.json`);
    mkdirSync(join(runtimeDir, IN_USE), { recursive: true, mode: 0o700 });
    let receipt: RunningBuildReceipt | undefined;
    try {
      const args = process.argv.slice(2);
      const role = args[0] === "planning" && args[1] === "serve" ? "bridge"
        : args.every((arg, index) => arg === "--ui" || arg === "--state" || args[index - 1] === "--state") ? "application" : undefined;
      const stamp = JSON.parse(readFileSync(join(build, "build-stamp.json"), "utf8")) as BuildStamp;
      const start = birth();
      const nonceIndex = args.indexOf("--ready-nonce");
      if (role && start && stamp?.id && /^[0-9a-f]{40}$/.test(stamp.sha)) {
        receipt = { pid: process.pid, build, appDir: realpathSync(appRootOf(moduleUrl)), stamp, role, processStart: start, startedAt: new Date().toISOString(), ...(role === "bridge" && nonceIndex >= 0 ? { readyNonce: args[nonceIndex + 1] } : {}) };
      }
    } catch { /* a pruning record alone never proves release activation */ }
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt ?? { pid: process.pid, build }), { mode: 0o600 });
    renameSync(temporary, file);
    if (receipt?.role === "application") applications.set(resolve(runtimeDir), receipt);
    process.once("exit", () => { try { rmSync(file, { force: true }); } catch { /* best effort */ } });
  } catch { /* best effort: pruning still keeps current, previous and recent builds */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Build paths protected from pruning by a live process, including pruning-only startup records. */
export async function buildsInUse(runtimeDir: string): Promise<Set<string>> {
  const used = new Set<string>();
  for (const entry of await readdir(join(runtimeDir, IN_USE)).catch(() => [] as string[])) {
    try {
      const record = JSON.parse(await readFile(join(runtimeDir, IN_USE, entry), "utf8")) as { pid: number; build: string };
      if (Number.isInteger(record.pid) && alive(record.pid)) used.add(await realpath(record.build).catch(() => record.build));
    } catch { /* unreadable record */ }
  }
  return used;
}
