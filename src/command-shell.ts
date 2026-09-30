import { execFile } from "node:child_process";
import { ownedProcesses, TREE_REFRESH_MS } from "./process-tree.js";
import { childEnv } from "./op-env.js";
import { redactSecrets } from "./redact.js";

export interface ShellResult { code: number; stdout: string; stderr: string }
export interface ShellOptions { signal?: AbortSignal; timeoutMs?: number }
export interface Shell { run(command: string, args: string[], cwd: string, options?: ShellOptions): Promise<ShellResult> }

/** Runs once and lets the caller construct its own error for a nonzero exit. */
export async function runChecked(shell: Shell, command: string, args: string[], cwd: string, failure: (result: ShellResult) => Error): Promise<ShellResult> {
  const result = await shell.run(command, args, cwd);
  if (result.code !== 0) throw failure(result);
  return result;
}

/** A short, single-line excerpt of command stderr with anything token-shaped removed. */
export function stderrExcerpt(stderr: string, max = 120): string {
  // Redact before truncating so no partial secret survives the cut.
  const text = redactSecrets(stderr)
    .replace(/\s+/g, " ")
    .trim();
  return (text || "no output").slice(0, max);
}

/** Runs commands without a shell; output is kept in memory only. `envFor` adjusts the (credential-free) child environment. */
export function shellWithEnv(envFor: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv): Shell {
  return { run: async (command, args, cwd, options = {}) => {
    if (options.signal?.aborted) return { code: 1, stdout: "", stderr: "Command cancelled." };
    const timeoutMs = Math.min(options.timeoutMs ?? 2 * 60 * 60_000, 2 * 60 * 60_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { code: 1, stdout: "", stderr: "Invalid command timeout." };
    let cancelled = false;
    let finish!: (result: ShellResult) => void;
    const result = new Promise<ShellResult>((resolve) => { finish = resolve; });
    // execFile's own timeout kills only its immediate child. Track before signalling so grandchildren cannot escape.
    const child = execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 20_000_000, timeout: 0, env: envFor(childEnv()) }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      finish({ code: cancelled ? 1 : code, stdout, stderr });
    });
    const tree = ownedProcesses.track(child.pid);
    let ending: Promise<unknown> | undefined;
    const end = () => ending ??= tree.then(async (run) => { await run.refresh(); return run.end(1000); });
    const abort = () => {
      cancelled = true;
      void end().finally(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } });
    };
    const timer = setTimeout(abort, timeoutMs);
    const refresh = setInterval(() => { void tree.then((run) => run.refresh()); }, TREE_REFRESH_MS);
    refresh.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try { return await result; }
    finally {
      clearTimeout(timer); clearInterval(refresh); options.signal?.removeEventListener("abort", abort);
      await end();
    }
  } };
}

/** Runs commands without a shell; output is kept in memory only. */
export const processShell: Shell = shellWithEnv((env) => env);
