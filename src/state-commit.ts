import { execFile, spawn } from "node:child_process";
import { childEnv, STATE_TOKEN_VARIABLE, stateRepoToken } from "./op-env.js";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

/** How a sync of the state checkout ended; only "synced" means it is level with its upstream. */
export type StateSyncOutcome = "synced" | "skipped" | "dirty" | "offline" | "conflict" | "push-failed" | "error";
export interface StateSyncResult {
  outcome: StateSyncOutcome;
  /** One line for the screen. */
  message: string;
  /** True when state.json in the checkout changed. */
  changed: boolean;
  at: string;
}

/** A state write that could not be committed, or a checkout Indra must not commit in. */
export class StateCommitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateCommitError";
  }
}

const gitEnv = () => ({ ...childEnv(), GIT_TERMINAL_PROMPT: "0" });

/**
 * Replaces the machine's credential helpers, for this one git process, with one that answers from the process's
 * own environment. The token itself never appears in arguments, remotes or git config; only the variable name does.
 * The helper ignores `store` and `erase`, so the token is never saved anywhere. It answers only a request for
 * `https://github.com/satoramoto/indra-state(.git)` (`useHttpPath` makes git always send the path); for any other
 * protocol, host or repository, for example after a changed origin or a redirect, it says nothing.
 */
const TOKEN_HELPER = "!f() { test \"$1\" = get || { cat >/dev/null; exit 0; }; p=; h=; u=; "
  + "while IFS= read -r line; do case \"$line\" in protocol=*) p=\"${line#protocol=}\";; host=*) h=\"${line#host=}\";; path=*) u=\"${line#path=}\";; esac; done; "
  + "test \"$p\" = https && test \"$h\" = github.com || exit 0; "
  + "case \"$u\" in satoramoto/indra-state|satoramoto/indra-state.git) ;; *) exit 0;; esac; "
  + `echo username=x-access-token; echo "password=$${STATE_TOKEN_VARIABLE}"; }; f`;

/** The `-c` options that make one git process authenticate with the state token, and only to the state repository. */
export const STATE_CREDENTIAL_CONFIG = ["-c", "credential.helper=", "-c", `credential.helper=${TOKEN_HELPER}`, "-c", "credential.useHttpPath=true"];

/**
 * The git arguments and environment for one command in the state checkout. Fetches and pushes authenticate with
 * the owner's `INDRA_STATE_GITHUB_TOKEN` when it was supplied; every other command, and every command without
 * the token, runs as before with the ambient credentials.
 */
function gitInvocation(checkout: string, args: string[]): { args: string[]; env: NodeJS.ProcessEnv; token?: string } {
  const token = stateRepoToken();
  if (!token || (args[0] !== "fetch" && args[0] !== "push")) return { args: ["-C", checkout, ...args], env: gitEnv() };
  return { args: ["-C", checkout, ...STATE_CREDENTIAL_CONFIG, ...args], env: { ...gitEnv(), [STATE_TOKEN_VARIABLE]: token }, token };
}

/** `text` with every occurrence of `token` removed, for messages that might echo what git saw. */
const withoutToken = (text: string, token?: string) => (token ? text.split(token).join("[redacted]") : text);

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

/** Git operations on the state checkout. Only `path` (`state.json` unless given) is ever committed. */
export class StateGit {
  constructor(readonly checkout: string, readonly path = "state.json") {}

  private run(args: string[]): Promise<string> {
    const invocation = gitInvocation(this.checkout, args);
    return new Promise((resolve, reject) => {
      execFile("git", invocation.args, { encoding: "utf8", env: invocation.env, timeout: 60_000 }, (error, stdout, stderr) => {
        // The cause is left out when a token was in play: its message repeats the command and git's output.
        if (error) reject(new StateCommitError(withoutToken(`git ${args[0]} failed in ${this.checkout}: ${(stderr || error.message).trim()}`, invocation.token), invocation.token ? undefined : { cause: error }));
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

  /** The subject of the last commit that changed the file, or "" when none did. */
  async lastSubject(): Promise<string> {
    return (await this.run(["log", "-1", "--format=%s", "--", this.path])).trim();
  }

  /** Stages the file, so a file git does not track yet can be committed with `commit`. */
  async add(): Promise<void> {
    await this.run(["add", "--", this.path]);
  }

  async unstage(): Promise<void> {
    await this.run(["reset", "--quiet", "--", this.path]).catch(() => undefined);
  }

  /**
   * Brings the checkout up to date with its upstream branch; the caller holds the state lock.
   * Fetches, then fast-forwards, or rebases local commits onto the upstream, then pushes what is
   * still unpushed. It never force-pushes and never drops a commit: a conflict aborts the rebase and
   * leaves the checkout exactly as it was, and every problem becomes the result instead of an error.
   */
  async sync(): Promise<StateSyncResult> {
    const at = new Date().toISOString();
    const result = (outcome: StateSyncOutcome, message: string, changed = false): StateSyncResult => ({ outcome, message, changed, at });
    const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
    try {
      const upstream = (await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
      if (!upstream) return result("skipped", "The state checkout's branch has no upstream to sync with.");
      if (await this.busy()) return result("dirty", "The state checkout has uncommitted changes or an unfinished rebase or merge; commit or discard them to resume syncing.");
      try { await this.run(["fetch", "--quiet"]); }
      catch (error) { return result("offline", `Could not fetch ${upstream}: ${detail(error)}`); }
      const before = (await this.run(["rev-parse", "HEAD"])).trim();
      const counts = async () => (await this.run(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).trim().split(/\s+/).map(Number);
      const [ahead, behind] = await counts();
      if (behind > 0 && ahead === 0) await this.run(["merge", "--ff-only", "--quiet", upstream]);
      else if (behind > 0) {
        try { await this.run(["rebase", "--quiet", "--no-autostash", upstream]); }
        catch (error) {
          await this.run(["rebase", "--abort"]).catch(() => undefined);
          const now = (await this.run(["rev-parse", "HEAD"]).catch(() => "")).trim();
          const note = now === before && !(await this.busy()) ? "the checkout is unchanged" : "the rebase could not be undone; inspect the checkout";
          return result("conflict", `Local state commits conflict with ${upstream}; ${note}. Resolve it in the checkout. (${detail(error)})`);
        }
      }
      const changed = behind > 0 && await this.differs(before, "HEAD");
      const pulled = behind > 0 ? `Pulled ${behind} commit${behind === 1 ? "" : "s"} from ${upstream}` : `Up to date with ${upstream}`;
      const [unpushed] = await counts();
      if (unpushed === 0) return result("synced", `${pulled}.`, changed);
      try { await this.run(["push", "--quiet"]); }
      catch (error) { return result("push-failed", `${pulled}; could not push ${unpushed} local commit${unpushed === 1 ? "" : "s"}: ${detail(error)}`, changed); }
      return result("synced", `${pulled}; pushed ${unpushed} local commit${unpushed === 1 ? "" : "s"}.`, changed);
    } catch (error) { return result("error", `State sync failed: ${detail(error)}`); }
  }

  /** True when a tracked file has uncommitted changes, or a rebase or merge is in progress. */
  async busy(): Promise<boolean> {
    if ((await this.run(["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"])).trim() !== "") return true;
    for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
      const path = (await this.run(["rev-parse", "--git-path", name])).trim();
      if (await stat(isAbsolute(path) ? path : join(this.checkout, path)).then(() => true, () => false)) return true;
    }
    return false;
  }

  private async differs(from: string, to: string): Promise<boolean> {
    return (await this.run(["diff", "--name-only", from, to, "--", this.path])).trim() !== "";
  }

  /** Best effort: runs detached, never awaited, and its failure is ignored. */
  pushInBackground(): void {
    try {
      const invocation = gitInvocation(this.checkout, ["push", "--quiet"]);
      const child = spawn("git", invocation.args, { detached: true, stdio: "ignore", env: invocation.env });
      child.on("error", () => undefined);
      child.unref();
    } catch { /* Pushing never fails a write. */ }
  }
}
