import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import { publishBuild } from "../src/build-publish.js";

describe("local builds", () => {
  it("build into a fresh directory and switch a symlinked dist without touching the live build", async () => {
    const root = await mkdtemp(join(tmpdir(), "indra-publish-"));
    await writeFile(join(root, "cli.ts"), "console.log('new build');\n");
    await mkdir(join(root, "builds", "live"), { recursive: true });
    await writeFile(join(root, "builds", "live", "cli.js"), "console.log('running build')\n");
    await writeFile(join(root, "builds", "live", "keep.txt"), "untouched\n");
    await symlink(join("builds", "live"), join(root, "dist"));
    const seen: string[][] = [];
    // Checks the live build after Vite has written its output but before the switch.
    const probe: Plugin = { name: "probe", async writeBundle() { seen.push((await readdir(join(root, "builds", "live"))).sort()); } };

    await build({ root, configFile: false, logLevel: "silent", plugins: [probe, publishBuild()], build: { lib: { entry: "cli.ts", formats: ["es"], fileName: () => "cli.js" } } });

    expect(seen).toEqual([["cli.js", "keep.txt"]]);
    expect(await readFile(join(root, "builds", "live", "cli.js"), "utf8")).toBe("console.log('running build')\n");
    expect((await lstat(join(root, "dist"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "dist"))).toMatch(/^builds\/local-/);
    expect(await readFile(join(root, "dist", "cli.js"), "utf8")).toContain("new build");
    expect((await readdir(join(root, "builds"))).sort()).toContain("live");
  });
});
