import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export interface TmuxRunner { run(args: string[]): Promise<string> }
export interface HostRecord { socket: string; session: string; paneId: string; tmuxIdentity: string; readyNonce: string; stateCheckout: string; appDir: string; startedAt: string }
/** What an Indra-owned tmux session runs: Chick's planning bridge, or one Developer seat's runner. */
export type HostedProcess = { kind: "bridge" } | { kind: "seat"; seatId: string };
export type Readiness = "ready" | "no-credential";

/** The Indra checkout this code runs from (the parent of `dist/` or `src/`). */
export const defaultAppDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The hosted process could not read its bot credential and exited. */
export class NoCredentialError extends Error { override name = "NoCredentialError"; }

export class SystemTmux implements TmuxRunner {
  async run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("tmux", args, { encoding: "utf8", timeout: 15_000 });
    return stdout.trim();
  }
}

export function readyFile(stateCheckout: string, nonce: string): string { return join(`${resolve(stateCheckout)}.runtime`, `host-ready-${nonce}.json`); }

/** Written once by the hosted process: after its first successful step, or when its credential is missing. */
export async function signalReady(stateCheckout: string, nonce: string, error?: "no-credential"): Promise<void> {
  const file = readyFile(stateCheckout, nonce);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ nonce, pid: process.pid, readyAt: new Date().toISOString(), ...(error ? { error } : {}) }), { flag: "wx", mode: 0o600 });
}

export class TmuxHost {
  readonly appDir: string;
  readonly cli: string;
  readonly socket: string;
  readonly session: string;
  readonly recordFile: string;
  readonly runtimeDir: string;

  constructor(readonly stateCheckout: string, private readonly runner: TmuxRunner = new SystemTmux(), appDir = defaultAppDir, private readonly readinessTimeoutMs = 15_000, readonly hosted: HostedProcess = { kind: "bridge" }) {
    this.appDir = resolve(appDir);
    this.cli = join(this.appDir, "dist", "cli.js");
    const suffix = createHash("sha256").update(resolve(stateCheckout)).digest("hex").slice(0, 12);
    if (hosted.kind === "seat" && !/^[a-z][a-z0-9-]+$/.test(hosted.seatId)) throw new Error("Invalid seat ID for tmux hosting.");
    this.socket = `indra-${suffix}`;
    this.session = hosted.kind === "bridge" ? `chick-${suffix}` : `dev-${hosted.seatId}-${suffix}`;
    this.runtimeDir = `${resolve(stateCheckout)}.runtime`;
    this.recordFile = join(this.runtimeDir, hosted.kind === "bridge" ? "tmux-host.json" : `tmux-seat-${hosted.seatId}.json`);
  }

  private command(readyNonce: string): string[] {
    const state = resolve(this.stateCheckout);
    return this.hosted.kind === "bridge"
      ? ["planning", "serve", "--state", state, "--ready-nonce", readyNonce]
      : ["seat", "run", "--seat", this.hosted.seatId, "--state", state, "--ready-nonce", readyNonce];
  }

  async readRecord(): Promise<HostRecord | undefined> {
    try { return JSON.parse(await readFile(this.recordFile, "utf8")) as HostRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async verifiedRecord(): Promise<HostRecord | undefined> {
    const record = await this.readRecord();
    if (!record) return undefined;
    if (record.socket !== this.socket || record.session !== this.session || record.stateCheckout !== resolve(this.stateCheckout) || record.appDir !== this.appDir || !/^[a-f0-9-]{36}$/.test(record.readyNonce) || !/^\d+:\d+$/.test(record.tmuxIdentity) || !/^%\d+$/.test(record.paneId)) throw new Error("Tmux host metadata does not match this checkout.");
    try {
      const identity = await this.identity();
      const panes = await this.runner.run(["-L", this.socket, "list-panes", "-t", this.target(), "-F", "#{pane_id}:#{pane_dead}"]);
      return identity === record.tmuxIdentity && panes.split("\n").includes(`${record.paneId}:0`) ? record : undefined;
    } catch { return undefined; }
  }

  async start(): Promise<HostRecord> {
    const existing = await this.verifiedRecord();
    if (existing) { await this.waitReady(existing); return existing; }
    try { await access(this.cli); }
    catch { throw new Error(`Built CLI is missing at ${this.cli}; run npm run build first.`); }
    const previous = await this.readRecord();
    if (!previous) {
      // A session without our matching record could belong to another process.
      const collision = await this.runner.run(["-L", this.socket, "list-sessions", "-F", "#{session_name}"]).catch(() => "");
      if (collision.split("\n").includes(this.session)) throw new Error("The tmux session name exists without an ownership record; refusing to attach or replace it.");
    }
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const readyNonce = randomUUID();
    const output = await this.runner.run(["-L", this.socket, "new-session", "-d", "-P", "-F", "#{session_name}:#{pane_id}", "-s", this.session, "-c", this.appDir, process.execPath, "--experimental-ffi", "--use-system-ca", this.cli, ...this.command(readyNonce)]);
    const [name, paneId] = output.split(":");
    if (name !== this.session || !/^%\d+$/.test(paneId ?? "")) throw new Error(`Tmux started but returned an unexpected pane identity; inspect socket ${this.socket} before retrying.`);
    const tmuxIdentity = await this.identity().catch(() => undefined);
    if (!tmuxIdentity) {
      // Never leave a session we just created without an ownership record.
      await this.runner.run(["-L", this.socket, "kill-session", "-t", this.target()]).catch(() => undefined);
      throw new Error("Tmux did not return a stable server and session identity.");
    }
    const record: HostRecord = { socket: this.socket, session: this.session, paneId, tmuxIdentity, readyNonce, stateCheckout: resolve(this.stateCheckout), appDir: this.appDir, startedAt: new Date().toISOString() };
    await mkdir(dirname(this.recordFile), { recursive: true, mode: 0o700 });
    const temp = `${this.recordFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temp, this.recordFile);
    if (!await this.verifiedRecord()) {
      if (await this.readiness(record) === "no-credential") throw new NoCredentialError("The hosted process has no bot credential.");
      throw new Error(`Tmux pane ${paneId} exited before verification; inspect socket ${this.socket} and credentials.`);
    }
    await this.waitReady(record);
    return record;
  }

  /** Stops only this host's own verified session. Returns false when there was nothing verified to stop. */
  async stop(): Promise<boolean> {
    const record = await this.verifiedRecord();
    if (!record) return false;
    await this.runner.run(["-L", this.socket, "kill-session", "-t", this.target()]);
    return true;
  }

  /** Exact-name target. The trailing colon makes tmux resolve the session's current window and pane, which tmux 3.6a needs for pane and format lookups. */
  private target(): string { return `=${this.session}:`; }

  /** Server pid plus the exact session's creation time, or undefined when tmux cannot give both. */
  private async identity(): Promise<string | undefined> {
    const pid = (await this.runner.run(["-L", this.socket, "display-message", "-p", "#{pid}"])).trim();
    const sessions = await this.runner.run(["-L", this.socket, "list-sessions", "-F", "#{session_name} #{session_created}"]);
    const created = sessions.split("\n").map((line) => line.trim().split(" ")).find(([name]) => name === this.session)?.[1];
    const identity = `${pid}:${created ?? ""}`;
    return /^\d+:\d+$/.test(identity) ? identity : undefined;
  }

  readyFile(nonce: string): string { return readyFile(this.stateCheckout, nonce); }

  async readiness(record: HostRecord): Promise<Readiness | undefined> {
    try {
      const ready = JSON.parse(await readFile(this.readyFile(record.readyNonce), "utf8")) as { nonce?: string; error?: string };
      if (ready.nonce !== record.readyNonce) return undefined;
      return ready.error === "no-credential" ? "no-credential" : "ready";
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async isReady(record: HostRecord): Promise<boolean> { return await this.readiness(record) === "ready"; }

  private async waitReady(record: HostRecord): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      const readiness = await this.readiness(record);
      if (readiness === "no-credential") throw new NoCredentialError("The hosted process has no bot credential.");
      if (readiness === "ready" && await this.verifiedRecord()) return;
      if (!await this.verifiedRecord()) throw new Error("Hosted process exited before readiness; inspect credentials and state checkout.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Hosted process did not become ready within 15 seconds; inspect credentials and state checkout.");
  }

  attachTarget(record: HostRecord): string {
    if (record.socket !== this.socket || record.session !== this.session) throw new Error("Cannot attach to an unowned tmux target.");
    return `${this.socket}:${this.session}`;
  }
}
