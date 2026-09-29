import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opRead, releaseOpEnvironment, ServiceAccountRejectedError } from "../src/op-env.js";

/** A fake `op` on PATH that fails with whatever FAKE_OP_ERROR says. */
const FAKE_OP = `#!/bin/sh
printf '%s\\n' "$FAKE_OP_ERROR" >&2
exit 1
`;

const saved = { ...process.env };

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "indra-op-env-"));
  await writeFile(join(dir, "op"), FAKE_OP);
  await chmod(join(dir, "op"), 0o755);
  process.env.PATH = `${dir}:${saved.PATH}`;
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
});

afterEach(() => {
  releaseOpEnvironment();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

async function readWith(stderr: string) {
  process.env.FAKE_OP_ERROR = stderr;
  let removed = 0;
  const outcome = await opRead("op://Agent Rig/Item/token", { serviceToken: "ops_staged", rejected: async () => { removed++; } })
    .then((value) => ({ value }), (error: unknown) => ({ error }));
  return { outcome, removed };
}

describe("op auth-failure matching", () => {
  it("removes the staged token when op rejects the token itself", async () => {
    for (const stderr of [
      "[ERROR] 2026/09/28 12:00:00 (401) Unauthorized: invalid bearer token",
      // Recorded from op 2.34.0 with a malformed service account token.
      "[ERROR] 2026/09/28 23:02:09 could not read secret 'op://NoVault/NoItem/token': error initializing client: Validation: (failed to session.DecodeSACredentials), Server: (failed to DecodeSACredentials), illegal base64 data at input byte 12",
    ]) {
      const { outcome, removed } = await readWith(stderr);
      expect("error" in outcome && outcome.error).toBeInstanceOf(ServiceAccountRejectedError);
      expect(removed).toBe(1);
    }
  });

  it("keeps the staged token when an unrelated op error only mentions authentication", async () => {
    for (const stderr of [
      "[ERROR] 2026/09/28 12:00:00 could not read secret 'op://Agent Rig/Item/token': error initializing client: authenticating with the server: Post \"https://my.1password.com/api/v3/auth/start\": dial tcp: lookup my.1password.com: no such host",
      "[ERROR] 2026/09/28 12:00:00 authentication with the 1Password app timed out",
      "[ERROR] 2026/09/28 12:00:00 could not read secret 'op://Agent Rig/Item/token': \"Item\" isn't an item in the \"Agent Rig\" vault. Specify the item with its UUID, name, or domain.",
    ]) {
      const { outcome, removed } = await readWith(stderr);
      expect(outcome).toEqual({ value: undefined });
      expect(removed).toBe(0);
    }
  });
});
