import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Written into `dist/` by every successful build (see vite.config.ts); a new `id` means new code to reload. */
export interface BuildStamp { id: string; sha: string; builtAt: string }

export const stampFile = (appDir: string) => join(appDir, "dist", "build-stamp.json");

/** The stamp of the build now in `dist/`, or undefined while there is none (or it is being rewritten). */
export async function readBuildStamp(appDir: string): Promise<BuildStamp | undefined> {
  try {
    const stamp = JSON.parse(await readFile(stampFile(appDir), "utf8")) as Partial<BuildStamp>;
    return typeof stamp.id === "string" && stamp.id ? { id: stamp.id, sha: typeof stamp.sha === "string" ? stamp.sha : "", builtAt: typeof stamp.builtAt === "string" ? stamp.builtAt : "" } : undefined;
  } catch { return undefined; }
}
