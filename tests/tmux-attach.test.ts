import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachTmux } from "../src/tmux-attach.js";

/** A fake `tmux` on PATH that logs its arguments and its whole environment, then succeeds. */
const FAKE_TMUX = `#!/bin/sh
{ printf 'ARGS %s\\n' "$*"; /usr/bin/env; } >> "$FAKE_TMUX_LOG"
exit 0
`;

const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("tmux attach environment", () => {
  it("spawns the real tmux command without any OP_* variable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indra-tmux-attach-"));
    await writeFile(join(dir, "tmux"), FAKE_TMUX);
    await chmod(join(dir, "tmux"), 0o755);
    const log = join(dir, "tmux.log");
    Object.assign(process.env, { PATH: `${dir}:${saved.PATH}`, FAKE_TMUX_LOG: log, OP_SERVICE_ACCOUNT_TOKEN: "ops_owner_secret", OP_SESSION_owner: "desktop-session" });
    await attachTmux("indra-bridge:chick-123");
    const text = await readFile(log, "utf8");
    expect(text.split("\n").filter((line) => line.startsWith("ARGS "))).toEqual([
      "ARGS -L indra-bridge has-session -t =chick-123",
      "ARGS -L indra-bridge attach-session -r -t =chick-123",
    ]);
    expect(text).toContain(`FAKE_TMUX_LOG=${log}`);
    expect(text).not.toMatch(/^OP_/m);
    expect(text).not.toContain("ops_owner_secret");
  });
});
