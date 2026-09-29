import { InventoryError } from "./domain.js";
import { opRead, ServiceAccountRejectedError, type OpCredential } from "./op-env.js";

const TOKEN_REF = "op://Agent Rig/Mattermost/access_token";

/** 1Password supplies the existing admin credential only to this process's memory, through the service account when there is one. */
export async function readToken(credential: OpCredential = {}): Promise<string> {
  let token: string | undefined;
  try { token = await opRead(TOKEN_REF, credential); }
  catch (error) { throw new InventoryError(error instanceof ServiceAccountRejectedError ? error.message : "1Password CLI could not read the existing credential."); }
  if (token === undefined) throw new InventoryError("1Password CLI could not read the existing credential; check its sign-in and vault access.");
  return token;
}
