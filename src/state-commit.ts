import { execFile, spawn } from "node:child_process";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** A state write that could not be committed, or a checkout Indra must not commit in. */
export class StateCommitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateCommitError";
  }
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // Unknown holder (lock just created): wait for it.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Moves a dead holder's lock aside; restores it if a live holder replaced it in the meantime. */
async function breakStale(file: string, holder: string): Promise<void> {
  const aside = `${file}.${randomUUID()}.stale`;
  try { await rename(file, aside); }
  catch (error) { if (code(error) === "ENOENT") return; throw error; }
  const moved = await readFile(aside, "utf8").catch(() => holder);
  if (moved !== holder) await link(aside, file).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}

/**
 * Runs `work` while holding an exclusive lock file shared by every Indra process on this machine.
 * A lock left by a process that no longer exists is broken; a live holder is waited for.
 */
export async function withFileLock<T>(file: string, work: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const token = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await writeFile(file, token, { flag: "wx", mode: 0o600 }); break; }
    catch (error) { if (code(error) !== "EEXIST") throw error; }
    const holder = await readFile(file, "utf8").catch(() => undefined);
    if (holder !== undefined && !alive(Number(holder.split(" ")[0]))) { await breakStale(file, holder); continue; }
    if (Date.now() > deadline) throw new StateCommitError(`Timed out waiting for the state lock ${file} (held by process ${holder?.split(" ")[0] ?? "unknown"}).`);
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
  }
  try { return await work(); }
  finally { if ((await readFile(file, "utf8").catch(() => undefined)) === token) await unlink(file).catch(() => undefined); }
}

/** Git operations on the state checkout. Only `state.json` is ever committed. */
export class StateGit {
  constructor(readonly checkout: string, readonly path = "state.json") {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", ["-C", this.checkout, ...args], { encoding: "utf8", env: gitEnv(), timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) reject(new StateCommitError(`git ${args[0]} failed in ${this.checkout}: ${(stderr || error.message).trim()}`, { cause: error }));
        else resolve(stdout);
      });
    });
  }

  /** True when the file differs from HEAD in the index or the working tree, or is untracked. */
  async dirty(): Promise<boolean> {
    return (await this.run(["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--", this.path])).trim() !== "";
  }

  async assertClean(): Promise<void> {
    if (await this.dirty()) throw new StateCommitError(`${this.path} in ${this.checkout} has changes that are not committed. Indra commits its own state changes and will not commit these; commit or discard them, then retry.`);
  }

  /** Commits only the state file, whatever else is staged. */
  async commit(message: string): Promise<void> {
    await this.run(["commit", "--quiet", "--only", "-m", message, "--", this.path]);
  }

  async unstage(): Promise<void> {
    await this.run(["reset", "--quiet", "--", this.path]).catch(() => undefined);
  }

  /** Best effort: runs detached, never awaited, and its failure is ignored. */
  pushInBackground(): void {
    try {
      const child = spawn("git", ["-C", this.checkout, "push", "--quiet"], { detached: true, stdio: "ignore", env: gitEnv() });
      child.on("error", () => undefined);
      child.unref();
    } catch { /* Pushing never fails a write. */ }
  }
}
