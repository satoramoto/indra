import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { childEnv } from "./op-env.js";
import { redactSecrets } from "./redact.js";

export interface ShellResult { code: number; stdout: string; stderr: string }
export interface Shell { run(command: string, args: string[], cwd: string): Promise<ShellResult> }

export interface Command { command: string; args: string[] }
/** An explicit env is already prepared by the caller, including any narrowly scoped credential routing. */
export type CommandOptions = Pick<ExecFileOptions, "cwd" | "timeout" | "maxBuffer" | "env">;
export interface CommandResult { error: ExecFileException | null; stdout: string; stderr: string }

/** Raw exit details stay available for callers that distinguish an exit from a launch, timeout or buffer error. */
export function execCommand(command: Command, options: CommandOptions): Promise<CommandResult> {
  return new Promise((done) => {
    execFile(command.command, command.args, { ...options, encoding: "utf8", env: options.env ?? childEnv() }, (error, stdout, stderr) => {
      done({ error, stdout, stderr });
    });
  });
}

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
  run: async (command, args, cwd) => {
    const { error, stdout, stderr } = await execCommand({ command, args }, { cwd, maxBuffer: 20_000_000, timeout: 2 * 60 * 60_000 });
    const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
    return { code, stdout, stderr };
  },
};
