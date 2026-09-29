import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { envServiceToken, opRead, type OpCredential } from "./op-env.js";

/** The 1Password service account that can read the "Agent Rig" vault without desktop authorization. */
export const SERVICE_ACCOUNT_REF = "op://Agent Rig/cvldgk5zipacvawubvsvwmy5xq/credential";

/** Where the control plane leaves the service account token for the processes it hosts: `<state-checkout>.runtime`, never Git. */
export function serviceTokenFile(stateCheckout: string): string {
  return join(`${resolve(stateCheckout)}.runtime`, "op-service-account-token");
}

export interface StageOptions {
  /** Read the token again even when a non-empty one is already staged, e.g. after a seat showed "no credential". */
  force?: boolean;
}

/**
 * Stages the service account token with 0600 permissions for hosted processes, preferring, in order:
 * the owner's `OP_SERVICE_ACCOUNT_TOKEN` (staged without running `op`); a non-empty token already staged, e.g. by
 * the owner's session hook (kept unless `force` is set); and last, `op read` through the desktop (one authorization).
 * The token is never logged or put in arguments.
 */
export async function stageServiceToken(stateCheckout: string, options: StageOptions = {}): Promise<void> {
  let token = envServiceToken();
  if (!token) {
    if (!options.force && await readServiceToken(stateCheckout).catch(() => undefined)) return;
    token = await opRead(SERVICE_ACCOUNT_REF, {}, 120_000).catch(() => undefined);
  }
  if (!token) throw new Error("1Password could not supply the service account token; hosted processes will show no credential. Check desktop authorization and restart them with s.");
  const file = serviceTokenFile(stateCheckout);
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, token, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** The staged service account token, or undefined when the control plane has not staged one. */
export async function readServiceToken(stateCheckout: string): Promise<string | undefined> {
  try { return (await readFile(serviceTokenFile(stateCheckout), "utf8")).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Removes the staged token if it is still `token`, so one that 1Password rejected is staged again; a newer one is kept. */
export async function clearServiceToken(stateCheckout: string, token: string): Promise<void> {
  if (await readServiceToken(stateCheckout).catch(() => undefined) === token) await rm(serviceTokenFile(stateCheckout), { force: true });
}

/**
 * The service account for this process's own `op read`s: the owner's `OP_SERVICE_ACCOUNT_TOKEN`, else the staged
 * token (removed again if 1Password rejects it), else none, which leaves `op` to the desktop.
 */
export async function opCredential(stateCheckout: string): Promise<OpCredential> {
  const fromEnv = envServiceToken();
  if (fromEnv) return { serviceToken: fromEnv };
  const staged = await readServiceToken(stateCheckout).catch(() => undefined);
  return staged ? { serviceToken: staged, rejected: () => clearServiceToken(stateCheckout, staged) } : {};
}
