import { execFile } from "node:child_process";
import { childEnv } from "./op-env.js";
import { redactSecrets } from "./redact.js";

export interface ShellResult { code: number; stdout: string; stderr: string }
export interface Shell { run(command: string, args: string[], cwd: string): Promise<ShellResult> }

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

/** Runs commands without a shell; output is kept in memory only. */
export const processShell: Shell = {
  run: (command, args, cwd) => new Promise((done) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 20_000_000, timeout: 2 * 60 * 60_000, env: childEnv() }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout, stderr });
    });
  }),
};
