/**
 * Process trees Indra owns: every engine CLI a hosted process starts (headed or headless) and everything that CLI
 * starts in turn, such as `npm test`, vitest workers, `npm run build` or a background `npm run test:watch`.
 *
 * Engine CLIs start their tools in process groups of their own, so ending the CLI alone leaves those tools running,
 * and once the CLI is gone they are re-parented to init and no longer look like Indra's. So each run is tracked from
 * the moment it starts: its members (the CLI, its descendants and the members of process groups they lead) are
 * snapshotted with `ps` while it runs, and when the run ends the whole set is ended, SIGTERM first and SIGKILL after
 * a grace period.
 *
 * A hosted process keeps its tracked sets in `<state-checkout>.runtime/owned-<pid>.json` (runtime metadata, never in
 * Git). When a hosted process dies without ending its runs (a crash, SIGKILL), reapOrphans ends what it recorded.
 *
 * Every signal is checked against a fresh `ps` listing: a process is signalled only when its pid still has the start
 * time Indra recorded for it, or it descends from such a process. Indra never signals its own process or process
 * group, init, or anything it did not record.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "./op-env.js";

export interface ProcessRow { pid: number; ppid: number; pgid: number; start: string }
/** A process identified against pid reuse: its pid and its start time as `ps -o lstart` prints it. */
export interface OwnedProcess { pid: number; start: string }
export type ProcessLister = () => Promise<ProcessRow[]>;
export type Signaller = (pid: number, signal: NodeJS.Signals) => void;
/** How often a running tree's members are snapshotted. */
export const TREE_REFRESH_MS = 2000;

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="];
const psEnv = () => ({ ...childEnv(), LC_ALL: "C" });

/** Parses `ps -A -o pid=,ppid=,pgid=,stat=,lstart=`; zombies are left out, they cannot be signalled. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[4].startsWith("Z")) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[5] });
  }
  return rows;
}

/** Every process on the machine, bounded to 5 s. Rejects when `ps` fails, so nothing is signalled on a guess. */
export const listProcesses: ProcessLister = () => new Promise((resolve, reject) => {
  execFile("ps", PS_ARGS, { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, env: psEnv() }, (error, stdout) => {
    if (error) reject(error); else resolve(parsePs(stdout));
  });
});

/** The same listing, synchronously, for signal handlers that must finish before the process exits. */
export function listProcessesSync(): ProcessRow[] {
  return parsePs(execFileSync("ps", PS_ARGS, { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: psEnv() }));
}

const systemSignal: Signaller = (pid, signal) => { process.kill(pid, signal); };

/**
 * The live processes that belong to `owned`: each owned process still running with its recorded start time, all of
 * their descendants, and every member of a process group one of them leads. Never includes `self`, its process
 * group, or init.
 */
export function membersOf(rows: ProcessRow[], owned: OwnedProcess[], self = process.pid): { members: ProcessRow[]; groups: number[] } {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const selfGroup = byPid.get(self)?.pgid;
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...children.get(row.ppid) ?? [], row]);
  const found = new Map<number, ProcessRow>();
  const visit = (row: ProcessRow) => {
    if (found.has(row.pid) || row.pid <= 1 || row.pid === self) return;
    found.set(row.pid, row);
    for (const child of children.get(row.pid) ?? []) visit(child);
  };
  for (const item of owned) { const row = byPid.get(item.pid); if (row && row.start === item.start) visit(row); }
  // A process group led by one of ours is ours: the kernel does not reuse a pid while its group has members.
  const groups = [...new Set([...found.values()].filter((row) => row.pgid === row.pid && row.pgid !== selfGroup && row.pgid > 1).map((row) => row.pgid))];
  for (const row of rows) if (groups.includes(row.pgid)) visit(row);
  return { members: [...found.values()], groups };
}

const signalAll = (members: ProcessRow[], groups: number[], signal: NodeJS.Signals, kill: Signaller) => {
  for (const group of groups) { try { kill(-group, signal); } catch { /* the group is gone */ } }
  for (const row of members) { try { kill(row.pid, signal); } catch { /* already exited */ } }
};

export interface EndOptions { graceMs?: number; list?: ProcessLister; kill?: Signaller; self?: number; pollMs?: number }

/**
 * Ends every process that belongs to `owned` (see membersOf): SIGTERM to each member and group, then SIGKILL to
 * whatever is still there after `graceMs`. Resolves with the number of processes it signalled.
 */
export async function endOwned(owned: OwnedProcess[], options: EndOptions = {}): Promise<number> {
  if (!owned.length) return 0;
  const list = options.list ?? listProcesses; const kill = options.kill ?? systemSignal;
  const self = options.self ?? process.pid; const graceMs = options.graceMs ?? 3000; const pollMs = options.pollMs ?? 100;
  const first = membersOf(await list(), owned, self);
  if (!first.members.length) return 0;
  signalAll(first.members, first.groups, "SIGTERM", kill);
  const known: OwnedProcess[] = first.members.map(({ pid, start }) => ({ pid, start }));
  const deadline = Date.now() + graceMs;
  let rest = first;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    rest = membersOf(await list(), known, self);
    if (!rest.members.length) return first.members.length;
  }
  signalAll(rest.members, rest.groups, "SIGKILL", kill);
  return first.members.length;
}

/** The same, synchronously and without waiting: SIGTERM now, then SIGKILL at `graceMs` on a timer. For exit handlers. */
export function endOwnedSync(owned: OwnedProcess[], graceMs: number, list: () => ProcessRow[] = listProcessesSync, kill: Signaller = systemSignal, self = process.pid): Promise<void> {
  let first: ReturnType<typeof membersOf>;
  try { first = membersOf(list(), owned, self); } catch { return Promise.resolve(); }
  if (!first.members.length) return Promise.resolve();
  signalAll(first.members, first.groups, "SIGTERM", kill);
  const known = first.members.map(({ pid, start }) => ({ pid, start }));
  return new Promise((resolve) => setTimeout(() => {
    try { const rest = membersOf(list(), known, self); signalAll(rest.members, rest.groups, "SIGKILL", kill); } catch { /* reapOrphans retries later */ }
    resolve();
  }, graceMs));
}

/** What `owned-<pid>.json` holds: the hosted process that owns the runs, and every process it recorded for them. */
export interface OwnedRecord { owner: OwnedProcess; processes: OwnedProcess[] }
const RECORD = /^owned-(\d+)\.json$/;

/** One tracked run: its members are snapshotted while it runs, and all of them end together. */
export interface TrackedRun {
  /** Adds the run's current members to the record; bounded by `ps`'s own 5 s timeout. */
  refresh(): Promise<void>;
  /** Ends the run's whole tree (see endOwned) and forgets it. */
  end(graceMs?: number): Promise<number>;
}

/**
 * The runs of one process. `track` starts tracking a child right after it was spawned; `end` on the returned run
 * ends its tree. With a runtime directory (set by a hosted process), the recorded members are kept on disk for
 * reapOrphans, and SIGHUP or SIGTERM (tmux ending the pane, a restart) end every tracked run before this process exits.
 */
export class OwnedProcesses {
  private readonly runs = new Map<number, Map<number, OwnedProcess>>();
  private runtimeDir?: string;
  private owner?: OwnedProcess;
  private handlers = false;

  constructor(private readonly list: ProcessLister = listProcesses, private readonly kill: Signaller = systemSignal, private readonly self = process.pid) {}

  /** Keeps this process's record under `runtimeDir` and ends every tracked run when this process is told to stop. */
  useRecord(runtimeDir: string | undefined, handleSignals = true): void {
    this.runtimeDir = runtimeDir;
    if (runtimeDir && handleSignals && !this.handlers) {
      this.handlers = true;
      for (const signal of ["SIGHUP", "SIGTERM"] as const) process.on(signal, () => { void this.exitOn(signal); });
    }
  }

  private recordFile(): string | undefined { return this.runtimeDir ? join(this.runtimeDir, `owned-${this.self}.json`) : undefined; }

  /** Every process recorded for the runs still tracked. */
  owned(): OwnedProcess[] { return [...this.runs.values()].flatMap((run) => [...run.values()]); }

  private async save(): Promise<void> {
    const file = this.recordFile();
    if (!file) return;
    const processes = this.owned();
    try {
      if (!processes.length) { rmSync(file, { force: true }); return; }
      this.owner ??= (await this.list()).find((row) => row.pid === this.self);
      if (!this.owner) return;
      mkdirSync(this.runtimeDir!, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ owner: { pid: this.owner.pid, start: this.owner.start }, processes } satisfies OwnedRecord), { mode: 0o600 });
      renameSync(temporary, file);
    } catch { /* best effort: the run still ends its tree in this process */ }
  }

  /** Starts tracking the tree rooted at `pid`, a child this process just spawned. */
  async track(pid: number | undefined): Promise<TrackedRun> {
    const key = pid ?? -1;
    const run = new Map<number, OwnedProcess>();
    let refreshing: Promise<void> | undefined;
    const refresh = (): Promise<void> => refreshing ??= (async () => {
      try {
        const rows = await this.list();
        if (!run.size) {
          const root = rows.find((row) => row.pid === pid && row.ppid === this.self);
          if (!root) return;
          run.set(root.pid, { pid: root.pid, start: root.start });
        }
        for (const row of membersOf(rows, [...run.values()], this.self).members) run.set(row.pid, { pid: row.pid, start: row.start });
        await this.save();
      } catch { /* the next refresh or the end tries again */ } finally { refreshing = undefined; }
    })();
    if (pid !== undefined) { this.runs.set(key, run); await refresh(); }
    return {
      refresh: () => (this.runs.get(key) === run ? refresh() : Promise.resolve()),
      end: async (graceMs?: number) => {
        await refreshing;
        const owned = [...run.values()];
        const ended = await endOwned(owned, { graceMs, list: this.list, kill: this.kill, self: this.self }).catch(() => 0);
        if (this.runs.get(key) === run) this.runs.delete(key);
        await this.save();
        return ended;
      },
    };
  }

  private exiting = false;
  private async exitOn(signal: NodeJS.Signals): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    // The pane may be gone: a write to it must not crash this handler before the runs end.
    process.stdout.on("error", () => undefined); process.stderr.on("error", () => undefined);
    await endOwnedSync(this.owned(), 2000, listProcessesSync, this.kill, this.self);
    this.runs.clear();
    const file = this.recordFile();
    if (file) try { rmSync(file, { force: true }); } catch { /* reapOrphans removes it */ }
    process.exit(128 + (signal === "SIGHUP" ? 1 : 15));
  }
}

/** This process's runs; hosted processes call `ownedProcesses.useRecord(runtimeDir)` once at start. */
export const ownedProcesses = new OwnedProcesses();

/**
 * Ends what hosted processes that are no longer running recorded (see OwnedProcesses), then removes their records.
 * A record whose owner is still running (same pid and start time) is left to that owner. Resolves with the number of
 * processes signalled.
 */
export async function reapOrphans(runtimeDir: string, options: EndOptions = {}): Promise<number> {
  let entries: string[];
  try { entries = readdirSync(runtimeDir).filter((entry) => RECORD.test(entry)); } catch { return 0; }
  if (!entries.length) return 0;
  const list = options.list ?? listProcesses;
  const rows = await list();
  let ended = 0;
  for (const entry of entries) {
    const file = join(runtimeDir, entry);
    let record: OwnedRecord;
    try { record = JSON.parse(readFileSync(file, "utf8")) as OwnedRecord; } catch { continue; }
    const valid = (item: unknown): item is OwnedProcess => !!item && Number.isSafeInteger((item as OwnedProcess).pid) && (item as OwnedProcess).pid > 1 && typeof (item as OwnedProcess).start === "string";
    if (!valid(record?.owner) || String(record.owner.pid) !== RECORD.exec(entry)![1] || !Array.isArray(record.processes)) continue;
    if (rows.some((row) => row.pid === record.owner.pid && row.start === record.owner.start)) continue;
    ended += await endOwned(record.processes.filter(valid), { ...options, list });
    try { rmSync(file, { force: true }); } catch { /* next time */ }
  }
  return ended;
}
