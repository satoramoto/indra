import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { changedPaths, requireLaneFiles } from "../src/developer-lanes.js";
import { applyLaneWorker } from "../src/seat-runtime.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const lane = { id: "code", branch: "codex/goal-one/code", ownedFiles: ["src/**"], dependsOn: [] };
describe("actual lane file boundaries", () => {
  it("checks both rename and copy paths, including an old name outside the owned scope", () => {
    const paths = changedPaths("R100\0private/old.ts\0src/new.ts\0M\0src/other.ts\0");
    expect(paths).toEqual(["private/old.ts", "src/new.ts", "src/other.ts"]);
    expect(() => requireLaneFiles(paths, lane, ["src/**", "private/**"])).toThrow("Needed but unowned");
    expect(changedPaths("C085\0src/old.ts\0src/copy.ts\0")).toEqual(["src/old.ts", "src/copy.ts"]);
    expect(() => requireLaneFiles(["src/future.ts"], lane, ["src/old.ts"])).toThrow();
    expect(() => requireLaneFiles(["src/future.ts"], lane, ["src/**"])).not.toThrow();
  });
  it.each(["M\0src/file.ts", "R100\0src/old.ts\0", "Z\0src/file.ts\0", "M\0../outside.ts\0"])("fails closed on uncertain diff evidence %j", (input) => {
    expect(() => changedPaths(input)).toThrow();
  });
  it("applies only the worker's single regular file and refuses symlink/traversal destinations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indra-worker-")); dirs.push(dir);
    await mkdir(join(dir, "src")); await writeFile(join(dir, "outside.ts"), "untouched");
    await applyLaneWorker(dir, "src/one.ts", "one");
    expect(await readFile(join(dir, "src/one.ts"), "utf8")).toBe("one");
    await symlink(join(dir, "outside.ts"), join(dir, "src/link.ts"));
    await expect(applyLaneWorker(dir, "src/link.ts", "escaped")).rejects.toThrow("regular file");
    await symlink(join(dir, "src"), join(dir, "shortcut"));
    await expect(applyLaneWorker(dir, "shortcut/one.ts", "escaped")).rejects.toThrow("symbolic link");
    await expect(applyLaneWorker(dir, "../outside.ts", "escaped")).rejects.toThrow();
    await expect(applyLaneWorker(dir, "src/*.ts", "escaped")).rejects.toThrow();
    expect(await readFile(join(dir, "outside.ts"), "utf8")).toBe("untouched");
    await applyLaneWorker(dir, "src/one.ts", null);
    await expect(readFile(join(dir, "src/one.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
