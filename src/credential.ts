import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InventoryError } from "./domain.js";

const execFileAsync = promisify(execFile);
const TOKEN_REF = "op://Agent Rig/Mattermost/access_token";

/** 1Password supplies the existing admin credential only to this process's memory. */
export async function readToken(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("op", ["read", TOKEN_REF], { timeout: 30_000, encoding: "utf8" }));
  } catch {
    throw new InventoryError("1Password CLI could not read the existing credential; check its sign-in and vault access.");
  }
  const token = stdout.trim();
  if (!token) throw new InventoryError("The existing 1Password credential is empty.");
  return token;
}
