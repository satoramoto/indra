import { execFile } from "node:child_process";
import { readBuildStamp } from "./build-stamp.js";

/**
 * How one check of the Indra checkout ended. "built" means a new build is in `dist/`; "blocked" means Indra
 * left the checkout alone and `message` says why; "failed" means the pull landed but the build did not, so the
 * running build stays.
 */
export type UpdateOutcome = "up-to-date" | "built" | "blocked" | "failed";
export interface UpdateResult { outcome: UpdateOutcome; message: string; at: string }

/**
 * Keeps the Indra checkout that runs the terminal UI on origin/main. Only fast-forwards a clean `main`, installs
 * dependencies only when package-lock.json changed since the running build, then builds. It never resets, stashes
 * or discards anything.
 */
export class SelfUpdater {
  /** The HEAD whose build failed; not retried until HEAD moves. */
  private failed?: { sha: string; message: string };

  constructor(readonly appDir: string, private readonly npm = "npm", private readonly timeoutMs = 15 * 60_000) {}

  private exec(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { cwd: this.appDir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout.trim()); return; }
        const lines = `${stderr}\n${stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
        reject(new Error(`${command} ${args[0]} failed: ${lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? error.message}`));
      });
    });
  }

  private git(...args: string[]): Promise<string> { return this.exec("git", args); }

  async check(): Promise<UpdateResult> {
    const at = new Date().toISOString();
    const result = (outcome: UpdateOutcome, message: string): UpdateResult => ({ outcome, message, at });
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
    try {
      const branch = await this.git("rev-parse", "--abbrev-ref", "HEAD");
      if (branch !== "main") return result("blocked", `the Indra checkout is on ${branch}, not main`);
      if (await this.git("--no-optional-locks", "status", "--porcelain", "--untracked-files=no")) return result("blocked", "the Indra checkout has uncommitted changes");
      try { await this.git("fetch", "--quiet", "origin", "main"); }
      catch (error) { return result("blocked", `could not fetch origin/main: ${reason(error)}`); }
      const [ahead, behind] = (await this.git("rev-list", "--left-right", "--count", "HEAD...origin/main")).split(/\s+/).map(Number);
      if (ahead > 0 && behind > 0) return result("blocked", "main has diverged from origin/main");
      if (behind > 0) {
        try { await this.git("pull", "--ff-only", "--quiet", "origin", "main"); }
        catch (error) { return result("blocked", `could not fast-forward main: ${reason(error)}`); }
      }
      const head = await this.git("rev-parse", "HEAD");
      const built = await readBuildStamp(this.appDir);
      if (built?.sha === head) return result("up-to-date", `up to date at ${head.slice(0, 7)}`);
      if (this.failed?.sha === head) return result("failed", this.failed.message);
      try {
        const lockChanged = !built?.sha || await this.git("diff", "--name-only", built.sha, head, "--", "package-lock.json").then((names) => names !== "", () => true);
        if (lockChanged) await this.exec(this.npm, ["ci"]);
        await this.exec(this.npm, ["run", "build"]);
      } catch (error) {
        this.failed = { sha: head, message: `build of ${head.slice(0, 7)} failed; still running the previous build: ${reason(error)}` };
        return result("failed", this.failed.message);
      }
      this.failed = undefined;
      return result("built", `built ${head.slice(0, 7)}`);
    } catch (error) { return result("blocked", `update check failed: ${reason(error)}`); }
  }
}
