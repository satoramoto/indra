import * as childProcess from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processShell, runChecked, type Shell } from "../src/command-shell.js";

vi.mock("node:child_process", { spy: true });

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(childProcess.execFile).mockReset();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("processShell", () => {
  it.each([0, 7])("preserves literal arguments, cwd and both output streams on exit %s", async (code) => {
    const cwd = await mkdtemp(join(await realpath(tmpdir()), "indra-command-shell-")); roots.push(cwd);
    vi.stubEnv("INDRA_COMMAND_SHELL_TEST", "visible");
    vi.stubEnv("OP_COMMAND_SHELL_TEST", "fixture-only");
    vi.stubEnv("INDRA_STATE_GITHUB_TOKEN", "fixture-only");
    const exec = vi.mocked(childProcess.execFile);
    const args = [String(code), "two words", "*.ts", "$literal", "semi;colon", "café"];
    const script = 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n"); process.stderr.write(" diagnostic\\n"); process.exitCode = Number(process.argv[1]);';
    const result = await processShell.run(process.execPath, ["-e", script, "--", ...args], cwd);
    expect(result).toEqual({ code, stdout: JSON.stringify({ cwd, args }) + "\n", stderr: " diagnostic\n" });
    expect(exec).toHaveBeenCalledTimes(1);
    const options = exec.mock.calls[0][2] as childProcess.ExecFileOptions;
    expect({ cwd: options.cwd, encoding: options.encoding, maxBuffer: options.maxBuffer, timeout: options.timeout }).toEqual({ cwd, encoding: "utf8", maxBuffer: 20_000_000, timeout: 7_200_000 });
    expect(options.env?.INDRA_COMMAND_SHELL_TEST).toBe("visible");
    expect(options.env?.OP_COMMAND_SHELL_TEST).toBeUndefined();
    expect(options.env?.INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    expect(process.env.OP_COMMAND_SHELL_TEST).toBe("fixture-only");
  });

  it.each([
    { code: "ENOENT" },
    { code: null, killed: true, signal: "SIGTERM" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    {},
  ])("maps a subprocess error without a numeric exit to 1: %j", async (details) => {
    vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
      callback(Object.assign(new Error("private diagnostic"), details), "partial stdout\n", "partial stderr\n");
      return {} as childProcess.ChildProcess;
    });
    await expect(processShell.run("command", ["arg"], "/workspace")).resolves.toEqual({ code: 1, stdout: "partial stdout\n", stderr: "partial stderr\n" });
  });
});

describe("runChecked", () => {
  it("runs once with the supplied command, arguments and cwd and returns the untouched result", async () => {
    const result = { code: 0, stdout: " stdout\n", stderr: " stderr\n" };
    const run = vi.fn<Shell["run"]>().mockResolvedValue(result);
    const failure = vi.fn(() => new Error("should not be called"));
    await expect(runChecked({ run }, "git", ["status", "--porcelain"], "/work tree", failure)).resolves.toBe(result);
    expect(run).toHaveBeenCalledExactlyOnceWith("git", ["status", "--porcelain"], "/work tree");
    expect(failure).not.toHaveBeenCalled();
  });

  it.each([1, 128, -1])("throws the caller's error on exit %s without retrying", async (code) => {
    const result = { code, stdout: "stdout", stderr: "stderr" };
    const run = vi.fn<Shell["run"]>().mockResolvedValue(result);
    const error = new RangeError("caller-owned failure");
    const failure = vi.fn(() => error);
    await expect(runChecked({ run }, "git", ["fetch", "origin"], "/workspace", failure)).rejects.toBe(error);
    expect(run).toHaveBeenCalledExactlyOnceWith("git", ["fetch", "origin"], "/workspace");
    expect(failure).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("propagates a rejected shell run without replacing its error or retrying", async () => {
    const error = new Error("shell rejected");
    const run = vi.fn<Shell["run"]>().mockRejectedValue(error);
    const failure = vi.fn(() => new Error("should not be called"));
    await expect(runChecked({ run }, "git", [], "/workspace", failure)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });
});
