import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOpEnvironment, childEnv, opEnv, opRead, releaseOpEnvironment, ServiceAccountRejectedError } from "../src/op-env.js";

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

/** Replaces the fake `op` with one that dumps its environment to FAKE_OP_ENV and succeeds. */
async function envDumpingOp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "indra-op-env-dump-"));
  await writeFile(join(dir, "op"), "#!/bin/sh\n/usr/bin/env > \"$FAKE_OP_ENV\"\necho secret-value\n");
  await chmod(join(dir, "op"), 0o755);
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.FAKE_OP_ENV = join(dir, "env.txt");
  return process.env.FAKE_OP_ENV;
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

describe("op desktop app integration", () => {
  const disabled = { OP_BIOMETRIC_UNLOCK_ENABLED: "false", OP_LOAD_DESKTOP_APP_SETTINGS: "false" };

  it("runs a staged service account read with app integration off, and the token reaches only op's token variable", async () => {
    const file = await envDumpingOp();
    expect(await opRead("op://Agent Rig/Item/token", { serviceToken: "ops_staged" })).toBe("secret-value");
    const env = parseEnv(await readFile(file, "utf8"));
    expect(env).toMatchObject({ ...disabled, OP_SERVICE_ACCOUNT_TOKEN: "ops_staged" });
    expect(Object.entries(env).filter(([, value]) => value.includes("ops_staged")).map(([name]) => name)).toEqual(["OP_SERVICE_ACCOUNT_TOKEN"]);
    expect(Object.keys(childEnv()).filter((name) => name.startsWith("OP_"))).toEqual([]);
  });

  it("turns app integration off for the owner's OP_SERVICE_ACCOUNT_TOKEN too, overriding an owner setting that enables it", async () => {
    const file = await envDumpingOp();
    captureOpEnvironment({ OP_SERVICE_ACCOUNT_TOKEN: "ops_owner", OP_BIOMETRIC_UNLOCK_ENABLED: "true" });
    expect(await opRead("op://Agent Rig/Item/token")).toBe("secret-value");
    expect(parseEnv(await readFile(file, "utf8"))).toMatchObject({ ...disabled, OP_SERVICE_ACCOUNT_TOKEN: "ops_owner" });
    expect(opEnv()).toMatchObject(disabled);
    expect(Object.values(childEnv())).not.toContain("ops_owner");
  });

  it("leaves the desktop fallback unchanged when there is no service account", async () => {
    const file = await envDumpingOp();
    captureOpEnvironment({ OP_SESSION_me: "desktop" });
    expect(await opRead("op://Agent Rig/Item/token")).toBe("secret-value");
    const env = parseEnv(await readFile(file, "utf8"));
    expect(env.OP_SESSION_me).toBe("desktop");
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    expect(env.OP_BIOMETRIC_UNLOCK_ENABLED).toBeUndefined();
    expect(env.OP_LOAD_DESKTOP_APP_SETTINGS).toBeUndefined();
  });
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
