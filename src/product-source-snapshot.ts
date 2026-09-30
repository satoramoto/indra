import { mkdir, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Shell } from "./command-shell.js";

export interface ProductSnapshot { id: string; status: "prepared" | "ready" | "preserved" | "removed" }
export interface ProductSourceRevision { github: string; sha: string; snapshots: ProductSnapshot[] }
interface Owner { version: 1; teamId: string; seatId: string; runId: string; snapshotId: string; github: string; sha: string }
export class ProductSnapshotError extends Error { override name = "ProductSnapshotError"; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exists = async (path: string) => {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

/** A Product run owns only its journaled, detached source copy, never the shared clone's checkout. */
export class ProductSourceSnapshots {
  constructor(private readonly shell: Shell, private readonly project: string, private readonly teamId: string, private readonly seatId: string) {}
  private paths(source: ProductSourceRevision, runId: string, snapshot: ProductSnapshot) {
    if (!/^[0-9a-f]{40}$/.test(source.sha) || !UUID.test(runId) || !UUID.test(snapshot.id)) throw new ProductSnapshotError("Product source snapshot identity is invalid.");
    const root = `${this.project}.product-snapshots`;
    const directory = join(root, snapshot.id);
    const owner: Owner = { version: 1, teamId: this.teamId, seatId: this.seatId, runId, snapshotId: snapshot.id, github: source.github, sha: source.sha };
    return { root, directory, checkout: join(directory, "checkout"), receipt: join(directory, "owner.json"), owner };
  }
  private async command(cwd: string, args: string[]): Promise<string> {
    const result = await this.shell.run("git", args, cwd);
    if (result.code !== 0) throw new ProductSnapshotError(`Product source snapshot verification failed (git ${args[0]}, exit ${result.code}).`);
    return result.stdout.trim();
  }
  private async owned(source: ProductSourceRevision, runId: string, snapshot: ProductSnapshot) {
    const paths = this.paths(source, runId, snapshot);
    for (const directory of [paths.root, paths.directory]) {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new ProductSnapshotError("Product source snapshot resolves outside its owned location.");
    }
    if (!(await lstat(paths.receipt)).isFile() || JSON.stringify(JSON.parse(await readFile(paths.receipt, "utf8"))) !== JSON.stringify(paths.owner)) throw new ProductSnapshotError("Product source snapshot ownership is unverified; its files were preserved.");
    return paths;
  }
  private async clean(source: ProductSourceRevision, runId: string, snapshot: ProductSnapshot): Promise<string> {
    const paths = await this.owned(source, runId, snapshot);
    const common = await realpath(join(this.project, ".git"));
    if (await realpath(paths.checkout) !== paths.checkout || !(await lstat(join(paths.checkout, ".git"))).isFile()
      || await realpath(await this.command(paths.checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== common
      || await this.command(paths.checkout, ["rev-parse", "--show-toplevel"]) !== paths.checkout
      || await this.command(paths.checkout, ["rev-parse", "HEAD"]) !== source.sha
      || (await this.shell.run("git", ["symbolic-ref", "-q", "HEAD"], paths.checkout)).code !== 1
      || await this.command(paths.checkout, ["status", "--porcelain", "--untracked-files=all", "--ignored"])) throw new ProductSnapshotError("Product source snapshot is not the clean recorded base; its files were preserved.");
    return paths.checkout;
  }
  private async unused(checkout: string): Promise<boolean> {
    // A completed model promise alone does not prove that no process still reads its source copy.
    // Missing lsof, permissions, or any open file all retain the snapshot rather than guessing.
    const result = await this.shell.run("lsof", ["-F", "p", "+D", checkout], this.project);
    return result.code === 1 && !result.stdout.trim() && !result.stderr.trim();
  }
  async prepare(source: ProductSourceRevision, runId: string, snapshot: ProductSnapshot): Promise<string> {
    if (!["prepared", "ready"].includes(snapshot.status)) throw new ProductSnapshotError("Product source snapshot cannot be reused after retirement or a failed run.");
    const paths = this.paths(source, runId, snapshot);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    if (await realpath(paths.root) !== paths.root) throw new ProductSnapshotError("Product source snapshot root is not its managed location.");
    if (!await exists(paths.directory)) {
      await mkdir(paths.directory, { mode: 0o700 });
      await writeFile(paths.receipt, JSON.stringify(paths.owner), { flag: "wx", mode: 0o600 });
    }
    await this.owned(source, runId, snapshot);
    if (await exists(paths.checkout)) {
      await this.clean(source, runId, snapshot);
      if (!await this.unused(paths.checkout)) throw new ProductSnapshotError("Product source snapshot may still be in use; recovery preserved it.");
    } else {
      if (snapshot.status !== "prepared") throw new ProductSnapshotError("Product source snapshot disappeared; recovery preserved its ownership record.");
      await this.command(this.project, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", paths.checkout, source.sha]);
    }
    return this.clean(source, runId, snapshot);
  }
  /** Cleanup is best effort and never forceful. Failed/uncertain runs and even ignored files survive. */
  async retire(source: ProductSourceRevision, runId: string, snapshot: ProductSnapshot): Promise<boolean> {
    if (snapshot.status !== "ready") return false;
    try {
      const checkout = await this.clean(source, runId, snapshot);
      if (!await this.unused(checkout)) return false;
      return (await this.shell.run("git", ["worktree", "remove", checkout], this.project)).code === 0;
    } catch { return false; }
  }
}
