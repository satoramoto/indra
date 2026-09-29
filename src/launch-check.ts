/**
 * Warns when Indra runs under a launcher macOS will blame for privacy prompts. macOS attributes a process's access to
 * other apps' data to its "responsible" process; for anything started under ttyd that is ttyd, an ad-hoc-signed binary
 * whose answer macOS does not remember, so every hosted process start asks again. A tmux server keeps the responsible
 * process of whoever started it, even after it daemonizes and its parent becomes launchd, so the seats' tmux server
 * carries the blame of the UI that first started it. See docs/running-indra.md.
 *
 * Heuristic, read-only and cheap (one `ps` and one tmux query of Indra's own seat socket):
 * - The UI is under ttyd when ttyd is in its process ancestry, or when the tmux client that created the UI's own tmux
 *   server (`new-session` on the socket named by `$TMUX`) is still alive under ttyd.
 * - The seats' tmux server is trusted when this UI started it (its `start_time` is not before this process's start),
 *   and Indra then records its pid, start time and whether this UI was under ttyd. A later UI trusts a server that
 *   matches that record. A server that predates the UI without a matching record cannot be verified, so it warns.
 * Nothing here kills, attaches to or changes any tmux session or server.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { childEnv } from "./op-env.js";
import type { TmuxRunner } from "./tmux-host.js";

/** `npm start` creates or reattaches Indra's own UI session itself (src/ui-session.ts). */
export const OWNER_START_COMMAND = "npm start";

export interface ProcessEntry { pid: number; ppid: number; args: string }
export type ProcessTable = Map<number, ProcessEntry>;
/** The seats' tmux server: its pid and `start_time` (epoch seconds). */
export interface TmuxServer { pid: number; startedAt: number }
/** What Indra knows about the seats' tmux server it started. Runtime metadata, kept in `<state-checkout>.runtime`. */
export interface ServerLaunchRecord { pid: number; startedAt: number; underTtyd: boolean }

/** Parses `ps -A -o pid=,ppid=,args=`. */
export function parseProcessTable(output: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), args: match[3]!.trim() });
  }
  return table;
}

export async function readProcessTable(): Promise<ProcessTable> {
  return new Promise((done) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...childEnv(), LC_ALL: "C" } },
      (error, stdout) => done(error ? new Map() : parseProcessTable(stdout)));
  });
}

function isTtyd(entry: ProcessEntry): boolean {
  return basename(entry.args.split(/\s+/)[0] ?? "") === "ttyd";
}

/** The ttyd process in `pid`'s ancestry (including `pid` itself), if any. */
export function ttydAncestor(table: ProcessTable, pid: number): ProcessEntry | undefined {
  const seen = new Set<number>();
  for (let entry = table.get(pid); entry && !seen.has(entry.pid); entry = table.get(entry.ppid)) {
    seen.add(entry.pid);
    if (isTtyd(entry)) return entry;
    if (entry.ppid <= 1) break;
  }
  return undefined;
}

/** Whether a tmux client's arguments name the socket `$TMUX` points at (`-L label`, `-S path`, or the default socket). */
function namesSocket(args: string[], socketPath: string): boolean {
  const label = args.indexOf("-L");
  const path = args.indexOf("-S");
  if (label >= 0) return args[label + 1] === basename(socketPath);
  if (path >= 0) return resolve(args[path + 1] ?? "") === resolve(socketPath);
  return basename(socketPath) === "default";
}

/** The ttyd behind the UI: in its ancestry, or behind the live client that created its tmux server (from `$TMUX`). */
export function uiTtyd(table: ProcessTable, uiPid: number, tmuxEnv: string | undefined): ProcessEntry | undefined {
  const direct = ttydAncestor(table, uiPid);
  if (direct || !tmuxEnv) return direct;
  const [socketPath, serverPid] = tmuxEnv.split(",");
  if (!socketPath) return undefined;
  for (const entry of table.values()) {
    const args = entry.args.split(/\s+/);
    if (entry.pid === Number(serverPid) || basename(args[0] ?? "") !== "tmux") continue;
    if (!args.some((arg) => arg === "new-session" || arg === "new") || !namesSocket(args, socketPath)) continue;
    const ttyd = ttydAncestor(table, entry.pid);
    if (ttyd) return ttyd;
  }
  return undefined;
}

export interface LaunchFacts {
  table: ProcessTable;
  uiPid: number;
  /** This UI process's start, epoch seconds. */
  uiStartedAt: number;
  tmuxEnv?: string;
  /** The seats' tmux server socket name, for the message. */
  seatSocket: string;
  server?: TmuxServer;
  record?: ServerLaunchRecord;
}

/**
 * The one-line warning, if any, plus the record to save when this UI started the seats' tmux server.
 * Pure, so tests can pass a fake process table.
 */
export function launchWarning(facts: LaunchFacts): { warning?: string; record?: ServerLaunchRecord } {
  const ttyd = uiTtyd(facts.table, facts.uiPid, facts.tmuxEnv);
  const hint = `Start Indra from your own terminal: ${OWNER_START_COMMAND}`;
  const server = facts.server;
  const ours = server && server.startedAt >= facts.uiStartedAt;
  const record = ours ? { pid: server.pid, startedAt: server.startedAt, underTtyd: !!ttyd } : undefined;
  if (ttyd) return { warning: `Warning: Indra's UI runs under ttyd (pid ${ttyd.pid}); macOS will attribute privacy prompts to ttyd and keep asking. ${hint}`, record };
  if (!server || ours) return { record };
  const known = facts.record && facts.record.pid === server.pid && facts.record.startedAt === server.startedAt ? facts.record : undefined;
  const serverTtyd = ttydAncestor(facts.table, server.pid);
  if (known && !known.underTtyd && !serverTtyd) return {};
  const why = serverTtyd || known?.underTtyd ? "was started under ttyd" : "was started before this UI by a launcher Indra cannot verify";
  return { warning: `Warning: the seats' tmux server (socket ${facts.seatSocket}, pid ${server.pid}) ${why}; macOS will attribute privacy prompts to that process. Stop every seat so it exits, then ${hint.charAt(0).toLowerCase()}${hint.slice(1)}` };
}

export function serverLaunchFile(stateCheckout: string): string {
  return join(`${resolve(stateCheckout)}.runtime`, "seat-tmux-server.json");
}

async function readRecord(file: string): Promise<ServerLaunchRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as ServerLaunchRecord;
    return Number.isInteger(record.pid) && Number.isInteger(record.startedAt) && typeof record.underTtyd === "boolean" ? record : undefined;
  } catch { return undefined; }
}

/** The seats' tmux server on Indra's own socket, or undefined when none runs. A read-only query; it never starts a server. */
export async function seatServer(runner: TmuxRunner, socket: string): Promise<TmuxServer | undefined> {
  try {
    const [pid, startedAt] = (await runner.run(["-L", socket, "display-message", "-p", "#{pid} #{start_time}"])).trim().split(" ").map(Number);
    return Number.isInteger(pid) && Number.isInteger(startedAt) ? { pid: pid!, startedAt: startedAt! } : undefined;
  } catch { return undefined; }
}

/** Checks the running UI and the seats' tmux server; returns the warning line, if any. Best effort: failures warn nothing. */
export async function checkLaunch(stateCheckout: string, runner: TmuxRunner, socket: string): Promise<string | undefined> {
  try {
    const file = serverLaunchFile(stateCheckout);
    const [table, server, record] = await Promise.all([readProcessTable(), seatServer(runner, socket), readRecord(file)]);
    const result = launchWarning({ table, uiPid: process.pid, uiStartedAt: Math.floor(Date.now() / 1000 - process.uptime()), tmuxEnv: process.env.TMUX, seatSocket: socket, server, record });
    if (result.record) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(result.record), { mode: 0o600 });
      await rename(temporary, file);
    }
    return result.warning;
  } catch { return undefined; }
}
