import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand, type Command, type CommandOptions, type Shell, type ShellResult } from "./command-shell.js";
import { childEnv, STATE_TOKEN_VARIABLE, stateRepoToken } from "./op-env.js";

export const REVIEW_ACCOUNT = "satori-miyamoto";
export type GhAccount = "owner" | "reviewer";
export interface GitOptions {
  /** Use git's -C form; Shell callers normally supply their working directory separately. */
  checkout?: string;
  /** Use gh's credential helper for this process only, without changing Git configuration. */
  githubCredential?: boolean;
}

const GH_CREDENTIAL_CONFIG = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export function gitCommand(args: string[], options: GitOptions = {}): Command {
  return { command: "git", args: [...(options.checkout === undefined ? [] : ["-C", options.checkout]), ...(options.githubCredential ? GH_CREDENTIAL_CONFIG : []), ...args] };
}

/** The owner's ambient gh login is the default; only review operations select the review account. */
export function ghCommand(args: string[], account: GhAccount = "owner"): Command {
  return account === "reviewer"
    ? { command: "env", args: [`GH_CONFIG_DIR=${join(homedir(), ".config", "gh-yahaha-bot")}`, "gh", ...args] }
    : { command: "gh", args: [...args] };
}

export function runGit(shell: Shell, args: string[], cwd: string, options: GitOptions = {}): Promise<ShellResult> {
  const command = gitCommand(args, options);
  return shell.run(command.command, command.args, cwd);
}

export function runGh(shell: Shell, args: string[], cwd: string, account: GhAccount = "owner"): Promise<ShellResult> {
  const command = ghCommand(args, account);
  return shell.run(command.command, command.args, cwd);
}

/** Noninteractive Git policy used by state sync, schema sync and self-update. */
export const gitEnv = (): NodeJS.ProcessEnv => childEnv(process.env, { overrides: { GIT_TERMINAL_PROMPT: "0" } });

/** Exit 1 means "not an ancestor"; launch errors, timeouts and every other exit leave ancestry unknown. */
export async function gitIsAncestor(ancestor: string, commit: string, options: CommandOptions & Pick<GitOptions, "checkout">): Promise<boolean | undefined> {
  const { checkout, ...execution } = options;
  const { error } = await execCommand(gitCommand(["merge-base", "--is-ancestor", ancestor, commit], { checkout }), execution);
  return !error ? true : error.code === 1 ? false : undefined;
}

/**
 * Replaces credential helpers for one state fetch/push. The helper reads the token from its own environment,
 * never stores it, and answers only for https://github.com/satoramoto/indra-state(.git), even after a redirect.
 */
const TOKEN_HELPER = "!f() { test \"$1\" = get || { cat >/dev/null; exit 0; }; p=; h=; u=; "
  + "while IFS= read -r line; do case \"$line\" in protocol=*) p=\"${line#protocol=}\";; host=*) h=\"${line#host=}\";; path=*) u=\"${line#path=}\";; esac; done; "
  + "test \"$p\" = https && test \"$h\" = github.com || exit 0; "
  + "case \"$u\" in satoramoto/indra-state|satoramoto/indra-state.git) ;; *) exit 0;; esac; "
  + `echo username=x-access-token; echo "password=$${STATE_TOKEN_VARIABLE}"; }; f`;

export const STATE_CREDENTIAL_CONFIG = ["-c", "credential.helper=", "-c", `credential.helper=${TOKEN_HELPER}`, "-c", "credential.useHttpPath=true"];

/** Only StateGit uses this route; the token is returned solely for exact redaction of a failed command. */
export function stateGitCommand(checkout: string, args: string[]): Command & { env: NodeJS.ProcessEnv; token?: string } {
  const token = stateRepoToken();
  if (!token || (args[0] !== "fetch" && args[0] !== "push")) return { ...gitCommand(args, { checkout }), env: gitEnv() };
  return { ...gitCommand([...STATE_CREDENTIAL_CONFIG, ...args], { checkout }), env: { ...gitEnv(), [STATE_TOKEN_VARIABLE]: token }, token };
}
