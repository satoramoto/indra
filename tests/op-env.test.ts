import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { agentEnv, captureOpEnvironment, childEnv, envServiceToken, opEnv, opRead, opVariablesIn, releaseOpEnvironment, ServiceAccountRejectedError, stateRepoToken } from "../src/op-env.js";

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

describe("child environments", () => {
  const reserved = {
    OP_SERVICE_ACCOUNT_TOKEN: "fixture-service",
    OP_SESSION_owner: "fixture-session",
    OP_LOAD_DESKTOP_APP_SETTINGS: "true",
    OP_FUTURE_VARIABLE: "fixture-future",
    INDRA_STATE_GITHUB_TOKEN: "fixture-state",
  };
  const common = { PATH: "/bin", HOME: "/fixture-home", EMPTY: "", UNDEFINED: undefined, OPEN: "kept", OP: "kept" };
  const ordinary = { ...common, INDRA_STATE_GITHUB_TOKEN_SUFFIX: "kept" };
  const credentialNames = { ANTHROPIC_API_KEY: "fixture-only", OPENAI_APIKEY: "fixture-only", DB_PASSWORD: "fixture-only", DB_PASSWD: "fixture-only", clientSecret: "fixture-only", access_token: "fixture-only", MAX_TOKENS: "100" };

  it("copies ordinary values exactly without mutating or forwarding reserved variables", () => {
    const env = { ...ordinary, ...reserved, ...credentialNames };
    const copy = childEnv(env);
    expect(copy).toEqual({ ...ordinary, ...credentialNames });
    expect(env).toEqual({ ...ordinary, ...reserved, ...credentialNames });
    copy.PATH = "/changed";
    expect(env.PATH).toBe("/bin");
  });

  it("applies overrides before filtering and does not mutate either input", () => {
    const overrides = { ...reserved, PATH: "/override", GIT_TERMINAL_PROMPT: "0" };
    expect(childEnv(ordinary, { overrides })).toEqual({ ...ordinary, PATH: "/override", GIT_TERMINAL_PROMPT: "0" });
    expect(overrides).toEqual({ ...reserved, PATH: "/override", GIT_TERMINAL_PROMPT: "0" });
    expect(ordinary.PATH).toBe("/bin");
    expect(childEnv(ordinary, { overrides: credentialNames, stripSecretNames: true })).toEqual(common);
  });

  it("keeps the distinct Codex and Claude policies, including replay and API-key spelling", () => {
    const env = { ...ordinary, ...reserved, ...credentialNames, "API-KEY": "fixture-only", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" };
    expect(agentEnv("codex", env)).toEqual({ ...ordinary, ...credentialNames, "API-KEY": "fixture-only", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" });
    expect(agentEnv("claude", env)).toEqual({ ...common, "API-KEY": "fixture-only", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0" });
    expect(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
    expect(agentEnv("claude", {})).toEqual({ CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0" });
    expect(agentEnv("codex", {})).toEqual({});
  });

  it("keeps reserved credentials out of an actual ordinary child even when overrides contain them", () => {
    const env = childEnv({ ...ordinary, ...reserved }, { overrides: reserved });
    const names = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env, encoding: "utf8" })) as string[];
    for (const name of Object.keys(reserved)) expect(names).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining(["PATH", "HOME", "EMPTY", "OPEN", "OP", "INDRA_STATE_GITHUB_TOKEN_SUFFIX"]));
  });

  it("captures credentials idempotently and routes each only to its exception", () => {
    const env = { ...ordinary, ...reserved, OP_SERVICE_ACCOUNT_TOKEN: " fixture-service ", INDRA_STATE_GITHUB_TOKEN: " fixture-state " };
    captureOpEnvironment(env); captureOpEnvironment(env);
    expect(env).toEqual(ordinary);
    expect(envServiceToken()).toBe("fixture-service"); expect(stateRepoToken()).toBe("fixture-state");
    Object.assign(process.env, reserved);
    for (const name of Object.keys(reserved)) {
      expect(childEnv()).not.toHaveProperty(name);
      expect(agentEnv("codex")).not.toHaveProperty(name);
      expect(agentEnv("claude")).not.toHaveProperty(name);
    }
    const op = opEnv("fixture-staged");
    expect(op).toMatchObject({ OP_SERVICE_ACCOUNT_TOKEN: "fixture-staged", OP_SESSION_owner: "fixture-session", OP_FUTURE_VARIABLE: "fixture-future", OP_LOAD_DESKTOP_APP_SETTINGS: "false" });
    expect(op).not.toHaveProperty("INDRA_STATE_GITHUB_TOKEN");
    expect(stateRepoToken()).toBe("fixture-state");
    releaseOpEnvironment();
    expect(envServiceToken()).toBeUndefined(); expect(stateRepoToken()).toBeUndefined();
    expect(opEnv()).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("identifies every reserved tmux variable without treating unset entries as values", () => {
    const output = [...Object.keys(reserved).map((name) => `${name}=fixture-only`), "-OP_UNSET", "PATH=/bin", "OP=kept", "INDRA_STATE_GITHUB_TOKEN_SUFFIX=kept"].join("\n");
    expect(opVariablesIn(output)).toEqual(Object.keys(reserved));
  });
});

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
