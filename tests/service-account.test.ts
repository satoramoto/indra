import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedToken } from "../src/cli.js";
import { botTokenRef, readBotToken, readChickToken } from "../src/planning-mattermost.js";
import { readServiceToken, SERVICE_ACCOUNT_REF, serviceTokenFile, stageServiceToken } from "../src/service-account.js";
import { readyFile } from "../src/tmux-host.js";

/**
 * A fake `op` on PATH. The service account ref needs "desktop authorization" (FAKE_OP_DESKTOP=allow);
 * a bot token item answers only when the service account token is in `op`'s own environment.
 * Every call is logged as `<args>|<OP_SERVICE_ACCOUNT_TOKEN or none>`.
 */
const FAKE_OP = `#!/bin/sh
printf '%s|%s\\n' "$*" "\${OP_SERVICE_ACCOUNT_TOKEN:-none}" >> "$FAKE_OP_LOG"
[ "$1" = read ] || exit 2
case "$2" in
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

  it("fails a hosted process with no staged token as no credential, without calling op", async () => {
    const checkout = join(dir, "indra-state");
    const nonce = "00000000-0000-4000-8000-000000000002";
    await expect(hostedToken(checkout, nonce, (options) => readBotToken("george", options), 0)).rejects.toThrow("No 1Password service account token is staged for @george");
    expect(JSON.parse(await readFile(readyFile(checkout, nonce), "utf8"))).toMatchObject({ nonce, error: "no-credential" });
    expect(await calls()).toEqual([]);
  });
});
