import * as childProcess from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Shell, type ShellResult } from "../src/command-shell.js";
import { gitEnv, gitIsAncestor, REVIEW_ACCOUNT, runGh, runGit, stateGitCommand } from "../src/git-gh.js";
import { captureOpEnvironment, releaseOpEnvironment } from "../src/op-env.js";

vi.mock("node:child_process", { spy: true });
afterEach(() => { vi.mocked(childProcess.execFile).mockReset(); vi.unstubAllEnvs(); releaseOpEnvironment(); });

describe("git and gh commands", () => {
  it.each([0, 1, 128])("preserves arguments, cwd and the result without checking exit %s", async (code) => {
    const result: ShellResult = { code, stdout: " output\n", stderr: " diagnostic\n" };
    const run = vi.fn<Shell["run"]>().mockResolvedValue(result);
    const args = ["show", "two words", "$literal", "semi;colon", "*.ts"];
    await expect(runGit({ run }, args, "/work tree")).resolves.toBe(result);
    expect(run).toHaveBeenLastCalledWith("git", args, "/work tree");
    await expect(runGh({ run }, args, "/work tree")).resolves.toBe(result);
    expect(run).toHaveBeenLastCalledWith("gh", args, "/work tree");
    await expect(runGh({ run }, args, "/work tree", "reviewer")).resolves.toBe(result);
    expect(run).toHaveBeenLastCalledWith("env", [`GH_CONFIG_DIR=${join(homedir(), ".config", "gh-yahaha-bot")}`, "gh", ...args], "/work tree");
    expect(run).toHaveBeenCalledTimes(3);
    expect(REVIEW_ACCOUNT).toBe("satori-miyamoto");
  });

  it("adds only the requested checkout and GitHub credential options before the original arguments", async () => {
    const run = vi.fn<Shell["run"]>().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const args = ["fetch", "origin", "main", "sprint/goal-one"];
    await runGit({ run }, args, "/work", { checkout: "/another work tree", githubCredential: true });
    expect(run).toHaveBeenCalledExactlyOnceWith("git", ["-C", "/another work tree", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "origin", "main", "sprint/goal-one"], "/work");
    expect(args).toEqual(["fetch", "origin", "main", "sprint/goal-one"]);
  });

  it("propagates shell rejections unchanged without a retry", async () => {
    const error = new Error("runner unavailable");
    const run = vi.fn<Shell["run"]>().mockRejectedValue(error);
    await expect(runGit({ run }, ["status"], "/work")).rejects.toBe(error);
    await expect(runGh({ run }, ["api", "user"], "/work", "reviewer")).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("git ancestry", () => {
  it.each([
    [null, true],
    [{ code: 1 }, false],
    [{ code: 128 }, undefined],
    [{ code: "ENOENT" }, undefined],
    [{ code: "1" }, undefined],
    [{ code: null, killed: true, signal: "SIGTERM" }, undefined],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, undefined],
  ])("distinguishes %j as %s", async (error, expected) => {
    vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      (args[3] as Function)(error, "", "");
      return {} as childProcess.ChildProcess;
    });
    const options = { checkout: "/app", timeout: 10_000, env: gitEnv() };
    await expect(gitIsAncestor("ancestor", "commit", options)).resolves.toBe(expected);
    expect(childProcess.execFile).toHaveBeenCalledExactlyOnceWith("git", ["-C", "/app", "merge-base", "--is-ancestor", "ancestor", "commit"], { encoding: "utf8", timeout: 10_000, env: options.env }, expect.any(Function));
  });
});

describe("state git credential routing", () => {
  it("adds a captured state credential only to state fetch/push, never to ordinary Git or other state commands", () => {
    captureOpEnvironment({ INDRA_STATE_GITHUB_TOKEN: "state-fixture", OP_SERVICE_ACCOUNT_TOKEN: "op-fixture" });
    vi.stubEnv("OP_LATE_VARIABLE", "late-fixture");
    vi.stubEnv("INDRA_STATE_GITHUB_TOKEN", "late-fixture");
    vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
    for (const subcommand of ["fetch", "push", "commit", "status", "log", "rebase"]) {
      const command = stateGitCommand("/state checkout", [subcommand, "--quiet"]);
      const authenticated = subcommand === "fetch" || subcommand === "push";
      expect(command.command).toBe("git");
      expect(command.args.slice(0, 2)).toEqual(["-C", "/state checkout"]);
      expect(command.args.slice(-2)).toEqual([subcommand, "--quiet"]);
      expect(command.args.some((arg) => arg.startsWith("credential.helper="))).toBe(authenticated);
      expect(command.env.INDRA_STATE_GITHUB_TOKEN).toBe(authenticated ? "state-fixture" : undefined);
      expect(command.token).toBe(authenticated ? "state-fixture" : undefined);
      expect(command.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(Object.keys(command.env).some((key) => key.startsWith("OP_"))).toBe(false);
      expect(command.args.join(" ")).not.toMatch(/state-fixture|op-fixture|late-fixture/);
    }
    expect(gitEnv().INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    releaseOpEnvironment();
    const ambient = stateGitCommand("/state", ["fetch", "--quiet"]);
    expect(ambient.args).toEqual(["-C", "/state", "fetch", "--quiet"]);
    expect(ambient.env.INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
  });
});
