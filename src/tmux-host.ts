import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export interface TmuxRunner { run(args: string[]): Promise<string> }
export interface HostRecord { socket: string; session: string; paneId: string; tmuxIdentity: string; readyNonce: string; stateCheckout: string; appDir: string; startedAt: string }

export class SystemTmux implements TmuxRunner {
  async run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("tmux", args, { encoding: "utf8", timeout: 15_000 });
    return stdout.trim();
  }
}

export class TmuxHost {
  readonly appDir: string;
  readonly cli: string;
  readonly socket: string;
  readonly session: string;
  readonly recordFile: string;
  readonly runtimeDir: string;

  constructor(readonly stateCheckout: string, private readonly runner: TmuxRunner = new SystemTmux(), appDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."), private readonly readinessTimeoutMs = 15_000) {
    this.appDir = resolve(appDir);
    this.cli = join(this.appDir, "dist", "cli.js");
    const suffix = createHash("sha256").update(resolve(stateCheckout)).digest("hex").slice(0, 12);
    this.socket = `indra-${suffix}`;
    this.session = `chick-${suffix}`;
    this.runtimeDir = `${resolve(stateCheckout)}.runtime`;
    this.recordFile = join(this.runtimeDir, "tmux-host.json");
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
      const identity = await this.runner.run(["-L", this.socket, "display-message", "-p", "-t", `=${this.session}`, "-F", "#{pid}:#{session_created}"]);
      const panes = await this.runner.run(["-L", this.socket, "list-panes", "-t", `=${this.session}`, "-F", "#{pane_id}:#{pane_dead}"]);
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
      try { await this.runner.run(["-L", this.socket, "has-session", "-t", `=${this.session}`]); }
      catch { /* no owned named session exists */ }
      // A session without our matching record could belong to another process.
      const collision = await this.runner.run(["-L", this.socket, "list-sessions", "-F", "#{session_name}"]).catch(() => "");
      if (collision.split("\n").includes(this.session)) throw new Error("The tmux session name exists without an ownership record; refusing to attach or replace it.");
    }
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const readyNonce = randomUUID();
    const output = await this.runner.run(["-L", this.socket, "new-session", "-d", "-P", "-F", "#{session_name}:#{pane_id}", "-s", this.session, "-c", this.appDir, process.execPath, "--use-system-ca", this.cli, "planning", "serve", "--state", resolve(this.stateCheckout), "--ready-nonce", readyNonce]);
    const [name, paneId] = output.split(":");
    if (name !== this.session || !/^%\d+$/.test(paneId ?? "")) throw new Error(`Tmux started but returned an unexpected pane identity; inspect socket ${this.socket} before retrying.`);
    const tmuxIdentity = await this.runner.run(["-L", this.socket, "display-message", "-p", "-t", `=${this.session}`, "-F", "#{pid}:#{session_created}"]);
    if (!/^\d+:\d+$/.test(tmuxIdentity)) throw new Error("Tmux did not return a stable server and session identity.");
    const record: HostRecord = { socket: this.socket, session: this.session, paneId, tmuxIdentity, readyNonce, stateCheckout: resolve(this.stateCheckout), appDir: this.appDir, startedAt: new Date().toISOString() };
    await mkdir(dirname(this.recordFile), { recursive: true, mode: 0o700 });
    const temp = `${this.recordFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temp, this.recordFile);
    if (!await this.verifiedRecord()) throw new Error(`Tmux pane ${paneId} exited before verification; inspect socket ${this.socket} and credentials.`);
    await this.waitReady(record);
    return record;
  }

  readyFile(nonce: string): string { return join(this.runtimeDir, `host-ready-${nonce}.json`); }

  async isReady(record: HostRecord): Promise<boolean> {
    try {
      const ready = JSON.parse(await readFile(this.readyFile(record.readyNonce), "utf8")) as { nonce?: string };
      return ready.nonce === record.readyNonce;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async waitReady(record: HostRecord): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isReady(record) && await this.verifiedRecord()) return;
      if (!await this.verifiedRecord()) throw new Error("Hosted bridge exited before readiness; inspect credentials and state checkout.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Hosted bridge did not become ready within 15 seconds; inspect credentials and state checkout.");
  }

  attachTarget(record: HostRecord): string {
    if (record.socket !== this.socket || record.session !== this.session) throw new Error("Cannot attach to an unowned tmux target.");
    return `${this.socket}:${this.session}`;
  }
}
