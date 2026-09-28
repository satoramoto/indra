import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliChild, launch, RELOAD_EXIT_CODE, type ChildExit } from "../src/launcher.js";

const exits = (...list: ChildExit[]) => {
  let runs = 0;
  return { run: async () => list[runs++], runs: () => runs };
};

describe("launcher", () => {
  it("starts the child again after a reload exit and ends with the child's next exit code", async () => {
    const child = exits({ code: RELOAD_EXIT_CODE, signal: null }, { code: RELOAD_EXIT_CODE, signal: null }, { code: 0, signal: null });
    expect(await launch(child.run)).toBe(0);
    expect(child.runs()).toBe(3);
  });

  it("ends on any other exit without starting the child again", async () => {
    const failed = exits({ code: 2, signal: null }, { code: 0, signal: null });
    expect(await launch(failed.run)).toBe(2);
    expect(failed.runs()).toBe(1);
    const killed = exits({ code: null, signal: "SIGTERM" }, { code: 0, signal: null });
    expect(await launch(killed.run)).toBe(1);
    expect(killed.runs()).toBe(1);
  });

  it("runs a real child with the arguments and the launcher marker, reloading it on the reload code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indra-launcher-"));
    const log = join(dir, "runs.log");
    const cli = join(dir, "cli.mjs");
    // Exits with the reload code twice, then with 3; logs its arguments and the launcher marker each time.
    await writeFile(cli, `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + " " + process.env.INDRA_LAUNCHER + "\\n");
const runs = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
process.exit(runs < 3 ? ${RELOAD_EXIT_CODE} : 3);
`);
    expect(await launch(cliChild(cli, ["--state", "/tmp/state"], []))).toBe(3);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(Array(3).fill("--state /tmp/state 1"));
  });
});
