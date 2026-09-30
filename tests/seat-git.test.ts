import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellWithEnv } from "../src/command-shell.js";
import { SeatRuntime } from "../src/seat-runtime.js";
import { withSeatGit } from "../src/seat-git.js";

const seat = { displayName: "Jordan Rudess", username: "jordan" };

describe("seat git settings", () => {
  it("add unsigned config and the persona identity after existing entries", () => {
    const env = withSeatGit({ PATH: "/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "true" }, seat);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "5", GIT_CONFIG_KEY_0: "core.editor",
      GIT_CONFIG_KEY_1: "commit.gpgsign", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "tag.gpgsign", GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "user.name", GIT_CONFIG_VALUE_3: "Jordan Rudess", GIT_CONFIG_KEY_4: "user.email", GIT_CONFIG_VALUE_4: "jordan@yahaha.invalid",
      GIT_AUTHOR_NAME: "Jordan Rudess", GIT_AUTHOR_EMAIL: "jordan@yahaha.invalid", GIT_COMMITTER_NAME: "Jordan Rudess", GIT_COMMITTER_EMAIL: "jordan@yahaha.invalid",
    });
  });

  it("reach the engine a seat run creates", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const runtime = new SeatRuntime("claude", "/w", 1, undefined, (_e, _c, _t, _w, _h, _r, envFor) => {
      seen = envFor?.({ PATH: "/bin" });
      return { message: async () => { throw new Error("stop"); } } as never;
    }, undefined, undefined, (env) => withSeatGit(env, seat));
    await expect(runtime.message("p", "s")).rejects.toThrow("stop");
    expect(seen).toMatchObject({ GIT_CONFIG_VALUE_0: "false", GIT_AUTHOR_NAME: "Jordan Rudess" });
  });

  it("commit unsigned as the seat despite a global config forcing signing, leaving that config unchanged", async () => {
    const home = await mkdtemp(join(tmpdir(), "seat-git-"));
    try {
      const gitconfig = "[user]\n\tname = Owner\n\temail = owner@example.com\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[gpg \"ssh\"]\n\tprogram = /nonexistent/signer\n";
      await writeFile(join(home, ".gitconfig"), gitconfig);
      const repo = join(home, "repo");
      const base = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
      execFileSync("git", ["init", "-q", repo], { env: base });
      const owner = { run: (args: string[]) => execFileSync("git", args, { cwd: repo, env: base, stdio: "pipe" }) };
      expect(() => owner.run(["commit", "-q", "--allow-empty", "-m", "owner"])).toThrow();
      const shell = shellWithEnv((env) => withSeatGit({ ...env, ...base }, seat));
      const commit = await shell.run("git", ["commit", "-q", "--allow-empty", "-m", "seat"], repo);
      expect(commit.code).toBe(0);
      const log = await shell.run("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%G?"], repo);
      expect(log.stdout.trim()).toBe("Jordan Rudess <jordan@yahaha.invalid>|Jordan Rudess <jordan@yahaha.invalid>|N");
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(gitconfig);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
