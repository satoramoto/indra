import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export interface TmuxRunner { run(args: string[]): Promise<string> }
export interface HostRecord { socket: string; session: string; paneId: string; stateCheckout: string; appDir: string; startedAt: string }

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

  constructor(readonly stateCheckout: string, private readonly runner: TmuxRunner = new SystemTmux(), appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
    this.appDir = resolve(appDir);
    this.cli = join(this.appDir, "dist", "cli.js");
    const suffix = createHash("sha256").update(resolve(stateCheckout)).digest("hex").slice(0, 12);
    this.socket = `indra-${suffix}`;
    this.session = `chick-${suffix}`;
    this.recordFile = join(`${resolve(stateCheckout)}.runtime`, "tmux-host.json");
  }

  async readRecord(): Promise<HostRecord | undefined> {
    try { return JSON.parse(await readFile(this.recordFile, "utf8")) as HostRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async verifiedRecord(): Promise<HostRecord | undefined> {
    const record = await this.readRecord();
    if (!record) return undefined;
    if (record.socket !== this.socket || record.session !== this.session || record.stateCheckout !== resolve(this.stateCheckout) || record.appDir !== this.appDir) throw new Error("Tmux host metadata does not match this checkout.");
    try {
      const paneId = await this.runner.run(["-L", this.socket, "list-panes", "-t", `=${this.session}`, "-F", "#{pane_id}"]);
      return paneId.split("\n").includes(record.paneId) ? record : undefined;
    } catch { return undefined; }
  }

  async start(): Promise<HostRecord> {
    const existing = await this.verifiedRecord();
    if (existing) return existing;
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
    const output = await this.runner.run(["-L", this.socket, "new-session", "-d", "-P", "-F", "#{session_name}:#{pane_id}", "-s", this.session, "-c", this.appDir, process.execPath, "--use-system-ca", this.cli, "planning", "serve", "--state", resolve(this.stateCheckout)]);
    const [name, paneId] = output.split(":");
    if (name !== this.session || !/^%\d+$/.test(paneId ?? "")) throw new Error(`Tmux started but returned an unexpected pane identity; inspect socket ${this.socket} before retrying.`);
    const record: HostRecord = { socket: this.socket, session: this.session, paneId, stateCheckout: resolve(this.stateCheckout), appDir: this.appDir, startedAt: new Date().toISOString() };
    await mkdir(dirname(this.recordFile), { recursive: true, mode: 0o700 });
    const temp = `${this.recordFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temp, this.recordFile);
    if (!await this.verifiedRecord()) throw new Error(`Tmux pane ${paneId} exited before verification; inspect socket ${this.socket} and credentials.`);
    return record;
  }

  attachTarget(record: HostRecord): string {
    if (record.socket !== this.socket || record.session !== this.session) throw new Error("Cannot attach to an unowned tmux target.");
    return `${this.socket}:${this.session}`;
  }
}
