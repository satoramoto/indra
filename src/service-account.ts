import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
/** The 1Password service account that can read the "Agent Rig" vault without desktop authorization. */
export const SERVICE_ACCOUNT_REF = "op://Agent Rig/cvldgk5zipacvawubvsvwmy5xq/credential";

/** Where the control plane leaves the service account token for the processes it hosts: `<state-checkout>.runtime`, never Git. */
export function serviceTokenFile(stateCheckout: string): string {
  return join(`${resolve(stateCheckout)}.runtime`, "op-service-account-token");
}

/**
 * Reads the service account token once through the normal `op` CLI (at most one desktop authorization)
 * and writes it with 0600 permissions for hosted processes. The token is never logged or put in arguments.
 */
export async function stageServiceToken(stateCheckout: string): Promise<void> {
  let token = "";
  try {
    ({ stdout: token } = await execFileAsync("op", ["read", SERVICE_ACCOUNT_REF], { timeout: 120_000, encoding: "utf8" }));
  } catch { /* hide secret manager details */ }
  token = token.trim();
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
