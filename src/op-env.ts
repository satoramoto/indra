/**
 * 1Password CLI variables (`OP_SERVICE_ACCOUNT_TOKEN`, `OP_SESSION_*` and the rest of `OP_*`) belong to `op` alone.
 * The CLI moves them out of `process.env` at start-up, so no child process inherits them by accident; only the
 * `op` invocations get them back, through `opEnv`. Agents, tmux, git, gh and npm run with `childEnv`.
 *
 * `INDRA_STATE_GITHUB_TOKEN` is captured the same way, but belongs to the state repository's `git fetch` and
 * `git push` alone (see `stateRepoToken` and `src/state-commit.ts`); `op` does not get it either.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OP_VARIABLE = /^OP_/;
/** The token the owner may supply for fetching from and pushing to the state repository. */
export const STATE_TOKEN_VARIABLE = "INDRA_STATE_GITHUB_TOKEN";
/** Every variable no child process inherits by default. */
const CAPTURED_VARIABLE = new RegExp(`^(?:OP_|${STATE_TOKEN_VARIABLE}$)`);
let captured: Record<string, string> = {};

/** Moves every `OP_*` variable and `INDRA_STATE_GITHUB_TOKEN` out of `env` into this module's memory. Safe to call more than once. */
export function captureOpEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!CAPTURED_VARIABLE.test(name)) continue;
    if (value !== undefined) captured[name] = value;
    delete env[name];
  }
}

/** Forgets the captured variables; for tests. */
export function releaseOpEnvironment(): void { captured = {}; }

/** The service account token the owner supplied as `OP_SERVICE_ACCOUNT_TOKEN` when starting Indra, if any. */
export function envServiceToken(): string | undefined {
  return captured.OP_SERVICE_ACCOUNT_TOKEN?.trim() || undefined;
}

/** The GitHub token the owner supplied as `INDRA_STATE_GITHUB_TOKEN` when starting Indra, if any; only state-repository git uses it. */
export function stateRepoToken(): string | undefined {
  return captured[STATE_TOKEN_VARIABLE]?.trim() || undefined;
}

/** A copy of `env` without any `OP_*` variable or the state repository token, for every child process that is not `op`. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CAPTURED_VARIABLE.test(name)));
}

/** The environment of an `op` invocation: the captured `OP_*` variables, with `serviceToken` taking precedence. */
export function opEnv(serviceToken?: string): NodeJS.ProcessEnv {
  const opVariables = Object.fromEntries(Object.entries(captured).filter(([name]) => OP_VARIABLE.test(name)));
  return { ...childEnv(), ...opVariables, ...(serviceToken ? { OP_SERVICE_ACCOUNT_TOKEN: serviceToken } : {}) };
}

/** Which service account an `op` invocation uses; without `serviceToken`, the owner's `OP_SERVICE_ACCOUNT_TOKEN` or the desktop. */
export interface OpCredential {
  serviceToken?: string;
  /** Called when 1Password rejects `serviceToken`, e.g. after rotation: removes the staged copy so it is staged again. */
  rejected?: () => Promise<void>;
}

/** 1Password refused the service account token itself, rather than the item. The message never holds the token. */
export class ServiceAccountRejectedError extends Error { override name = "ServiceAccountRejectedError"; }

const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|invalid bearer token|authenticat|token (?:is )?(?:invalid|expired|revoked)/i;

/**
 * Runs `op read REF` with the service account (or, with none, the desktop) and returns the trimmed value, or
 * undefined when `op` fails for any reason but a rejected service account token, which throws.
 * Neither the token nor `op`'s output is ever logged or put in the error.
 */
export async function opRead(ref: string, credential: OpCredential = {}, timeoutMs = 30_000): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("op", ["read", ref], { timeout: timeoutMs, encoding: "utf8", env: opEnv(credential.serviceToken) });
    return stdout.trim() || undefined;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!AUTH_FAILURE.test(stderr)) return undefined;
    if (credential.serviceToken && credential.rejected) {
      await credential.rejected().catch(() => undefined);
      throw new ServiceAccountRejectedError("1Password rejected the staged service account token (it may have been rotated). Indra removed it; the next start or seat restart stages a new one.");
    }
    if (credential.serviceToken || envServiceToken()) throw new ServiceAccountRejectedError("1Password rejected the service account token (it may have been rotated). Start Indra with the current OP_SERVICE_ACCOUNT_TOKEN.");
    return undefined;
  }
}

/** Names of captured variables (`OP_*`, the state repository token) set in `tmux show-environment -g` output, so a hosted pane can unset them. */
export function opVariablesIn(showEnvironment: string): string[] {
  return showEnvironment.split("\n").map((line) => /^(\w+)=/.exec(line)?.[1]).filter((name): name is string => !!name && CAPTURED_VARIABLE.test(name));
}
