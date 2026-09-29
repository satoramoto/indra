import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { captureOpEnvironment, childEnv, opEnv, opVariablesIn, releaseOpEnvironment, ServiceAccountRejectedError } from "../src/op-env.js";
import { readToken } from "../src/credential.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedToken } from "../src/cli.js";
import { processShell } from "../src/developer-seat.js";
import { botTokenRef, readBotToken, readChickToken } from "../src/planning-mattermost.js";
import { opCredential, readServiceToken, SERVICE_ACCOUNT_REF, serviceTokenFile, stageServiceToken } from "../src/service-account.js";
import { readyFile } from "../src/tmux-host.js";

/**
 * A fake `op` on PATH. The service account ref needs "desktop authorization" (FAKE_OP_DESKTOP=allow);
 * a bot token item answers only when the service account token is in `op`'s own environment.
 * Every call is logged as `<args>|<OP_SERVICE_ACCOUNT_TOKEN or none>`.
 */
const FAKE_OP = `#!/bin/sh
printf '%s|%s\\n' "$*" "\${OP_SERVICE_ACCOUNT_TOKEN:-none}" >> "$FAKE_OP_LOG"
[ "$1" = read ] || exit 2
[ "\${OP_SERVICE_ACCOUNT_TOKEN:-}" = ops_rotated ] && { echo "[ERROR] (401) Unauthorized: invalid bearer token" >&2; exit 1; }
case "$2" in
  "op://Agent Rig/Mattermost/access_token") [ "$OP_SERVICE_ACCOUNT_TOKEN" = ops_service_secret ] || exit 1; echo "admin-secret" ;;
  "${SERVICE_ACCOUNT_REF}") [ "$FAKE_OP_DESKTOP" = allow ] || exit 1; echo "ops_service_secret" ;;
  "op://Agent Rig/Mattermost bot - "*/token) [ "$OP_SERVICE_ACCOUNT_TOKEN" = ops_service_secret ] || exit 1; name="\${2#op://Agent Rig/Mattermost bot - }"; echo "bot-secret-\${name%/token}" ;;
  *) exit 1 ;;
esac
`;

let dir: string;
let log: string;
const saved = { ...process.env };
const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indra-op-"));
  await writeFile(join(dir, "op"), FAKE_OP);
  await chmod(join(dir, "op"), 0o755);
  log = join(dir, "op.log");
  Object.assign(process.env, { PATH: `${dir}:${saved.PATH}`, FAKE_OP_LOG: log, FAKE_OP_DESKTOP: "allow" });
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  delete process.env.INDRA_CHICK_TOKEN_REF;
});

afterEach(() => {
  releaseOpEnvironment();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("1Password service account handoff", () => {
  it("reads bot tokens from the item's token field", () => {
    expect(botTokenRef("george")).toBe("op://Agent Rig/Mattermost bot - george/token");
  });

  it("stages the service account token once, 0600, in the runtime directory and never in arguments", async () => {
    const checkout = join(dir, "indra-state");
    await stageServiceToken(checkout);
    const file = serviceTokenFile(checkout);
    expect(file).toBe(join(`${checkout}.runtime`, "op-service-account-token"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readServiceToken(checkout)).toBe("ops_service_secret");
    expect(await calls()).toEqual([`read ${SERVICE_ACCOUNT_REF}|none`]);
  });

  it("reports a clear error when the control plane cannot read the service account token", async () => {
    process.env.FAKE_OP_DESKTOP = "deny";
    const checkout = join(dir, "indra-state");
    await expect(stageServiceToken(checkout)).rejects.toThrow("could not supply the service account token");
    expect(await readServiceToken(checkout)).toBeUndefined();
  });

  it("hands the staged token to a hosted process's op read only, headlessly", async () => {
    const checkout = join(dir, "indra-state");
    await stageServiceToken(checkout);
    const nonce = "00000000-0000-4000-8000-000000000001";
    expect(await hostedToken(checkout, nonce, (options) => readBotToken("george", options), 0)).toBe("bot-secret-george");
    expect(await hostedToken(checkout, nonce, readChickToken, 0)).toBe("bot-secret-chickcorea");
    expect((await calls()).slice(1)).toEqual([
      "read op://Agent Rig/Mattermost bot - george/token|ops_service_secret",
      "read op://Agent Rig/Mattermost bot - chickcorea/token|ops_service_secret",
    ]);
    expect(process.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    await expect(readFile(readyFile(checkout, nonce))).rejects.toThrow();
  });

  it("keeps a non-empty staged token instead of asking the desktop again, and re-stages a missing, empty or forced one", async () => {
    const checkout = join(dir, "indra-state");
    await stageServiceToken(checkout);
    await stageServiceToken(checkout);
    expect(await calls()).toHaveLength(1);
    await rm(serviceTokenFile(checkout));
    await stageServiceToken(checkout);
    expect(await calls()).toHaveLength(2);
    await writeFile(serviceTokenFile(checkout), "  \n");
    await stageServiceToken(checkout);
    expect(await calls()).toHaveLength(3);
    await stageServiceToken(checkout, { force: true });
    expect(await calls()).toHaveLength(4);
    expect(await readServiceToken(checkout)).toBe("ops_service_secret");
  });

  it("stages the owner's OP_SERVICE_ACCOUNT_TOKEN without running op, and every op read then uses the service account", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_service_secret";
    process.env.OP_SESSION_owner = "desktop-session";
    process.env.FAKE_OP_DESKTOP = "deny";
    captureOpEnvironment();
    expect(process.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    expect(process.env.OP_SESSION_owner).toBeUndefined();
    const checkout = join(dir, "indra-state");
    await stageServiceToken(checkout, { force: true });
    expect(await calls()).toEqual([]);
    expect((await stat(serviceTokenFile(checkout))).mode & 0o777).toBe(0o600);
    expect(await readServiceToken(checkout)).toBe("ops_service_secret");
    // A CLI command without a staged token (e.g. run by hand) still reads through the service account.
    expect(await readBotToken("george")).toBe("bot-secret-george");
    expect(await calls()).toEqual(["read op://Agent Rig/Mattermost bot - george/token|ops_service_secret"]);
  });

  it("uses a token staged outside Indra (no env, no desktop) for staging and the UI's own op reads", async () => {
    process.env.FAKE_OP_DESKTOP = "deny";
    const checkout = join(dir, "indra-state");
    await mkdir(`${checkout}.runtime`, { recursive: true });
    await writeFile(serviceTokenFile(checkout), "ops_service_secret\n", { mode: 0o600 });
    await stageServiceToken(checkout);
    expect(await calls()).toEqual([]);
    expect(await hostedToken(checkout, undefined, (options) => readBotToken("george", options), 0)).toBe("bot-secret-george");
    expect(await readToken(await opCredential(checkout))).toBe("admin-secret");
    expect(await calls()).toEqual([
      "read op://Agent Rig/Mattermost bot - george/token|ops_service_secret",
      "read op://Agent Rig/Mattermost/access_token|ops_service_secret",
    ]);
  });

  it("prefers the owner's OP_SERVICE_ACCOUNT_TOKEN over a staged token", async () => {
    const checkout = join(dir, "indra-state");
    await mkdir(`${checkout}.runtime`, { recursive: true });
    await writeFile(serviceTokenFile(checkout), "ops_rotated", { mode: 0o600 });
    captureOpEnvironment({ OP_SERVICE_ACCOUNT_TOKEN: "ops_service_secret" });
    expect(await readToken(await opCredential(checkout))).toBe("admin-secret");
    await stageServiceToken(checkout);
    expect(await readServiceToken(checkout)).toBe("ops_service_secret");
  });

  it("removes a staged token 1Password rejects, says so, and stages a new one next time", async () => {
    const checkout = join(dir, "indra-state");
    await mkdir(`${checkout}.runtime`, { recursive: true });
    await writeFile(serviceTokenFile(checkout), "ops_rotated", { mode: 0o600 });
    const error = await hostedToken(checkout, undefined, (options) => readBotToken("george", options), 0).then(() => new Error("resolved"), (caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(ServiceAccountRejectedError);
    expect(error.message).toContain("rejected the staged service account token");
    expect(error.message).not.toContain("ops_rotated");
    expect(await readServiceToken(checkout)).toBeUndefined();
    await stageServiceToken(checkout);
    expect(await readServiceToken(checkout)).toBe("ops_service_secret");
  });

  it("strips OP_* variables from child environments and gives them back only to op", () => {
    const env = { PATH: "/bin", OP_SERVICE_ACCOUNT_TOKEN: "ops_x", OP_SESSION_me: "s", HOME: "/h" };
    captureOpEnvironment(env);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
    process.env.OP_SESSION_leak = "leak";
    expect(Object.keys(childEnv()).filter((name) => name.startsWith("OP_"))).toEqual([]);
    expect(opEnv()).toMatchObject({ OP_SERVICE_ACCOUNT_TOKEN: "ops_x", OP_SESSION_me: "s" });
    expect(opEnv("ops_staged").OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_staged");
    expect(opEnv().OP_SESSION_leak).toBeUndefined();
    expect(opVariablesIn("HOME=/h\nOP_SERVICE_ACCOUNT_TOKEN=ops_x\n-OP_SESSION_gone\nOP_SESSION_me=s")).toEqual(["OP_SERVICE_ACCOUNT_TOKEN", "OP_SESSION_me"]);
  });

  it("runs seat commands (git, gh, npm) without any OP_* variable", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_service_secret";
    process.env.OP_SESSION_owner = "desktop-session";
    const { code, stdout } = await processShell.run("/usr/bin/env", [], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("FAKE_OP_LOG=");
    expect(stdout).not.toMatch(/^OP_/m);
  });

  it("fails a hosted process with no staged token as no credential, without calling op", async () => {
    const checkout = join(dir, "indra-state");
    const nonce = "00000000-0000-4000-8000-000000000002";
    await expect(hostedToken(checkout, nonce, (options) => readBotToken("george", options), 0)).rejects.toThrow("No 1Password service account token is staged for @george");
    expect(JSON.parse(await readFile(readyFile(checkout, nonce), "utf8"))).toMatchObject({ nonce, error: "no-credential" });
    expect(await calls()).toEqual([]);
  });
});
