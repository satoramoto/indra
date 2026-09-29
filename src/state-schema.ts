/**
 * The indra repository owns the state JSON Schema (`schema/v1/state.schema.json`); the copy in the state
 * checkout follows it. At start-up Indra writes its own copy into the checkout when they differ, commits only
 * that file, and pushes it through the same sync as state.json.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStampIn } from "./build-stamp.js";
import { StateGit, withFileLock, type StateSyncResult } from "./state-commit.js";
import bundledSchema from "../schema/v1/state.schema.json?raw";

/** Where the schema lives, in the indra repository and in the state checkout alike. */
export const STATE_SCHEMA_PATH = "schema/v1/state.schema.json";

export type SchemaSyncOutcome = "unchanged" | "committed" | "dirty" | "error";
export interface SchemaSyncResult {
  outcome: SchemaSyncOutcome;
  /** One line for the screen. */
  message: string;
  /** The sync that pushed the commit, when there was one. */
  sync?: StateSyncResult;
}

export interface SchemaSyncOptions {
  /** The schema to install; the one bundled into this build by default. */
  schema?: string;
  /** The commit this build was made from, for the commit message; read from the build stamp by default. */
  sha?: string;
  /** Where the state lock lives; `<checkout>.runtime` by default. */
  runtimeDir?: string;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Makes the state checkout's schema match this build's. Does nothing when they already match. Refuses, without
 * writing anything, when the checkout has uncommitted changes to tracked files or the schema, or an unfinished
 * rebase or merge: those are someone's hand edits, and Indra never commits them. Holds the state lock that every
 * state write and sync holds. Never throws.
 */
export async function syncStateSchema(checkout: string, options: SchemaSyncOptions = {}): Promise<SchemaSyncResult> {
  const schema = options.schema ?? bundledSchema;
  const file = join(checkout, STATE_SCHEMA_PATH);
  const git = new StateGit(checkout, STATE_SCHEMA_PATH);
  try {
    const sha = options.sha ?? (await readStampIn(dirname(fileURLToPath(import.meta.url))))?.sha ?? "";
    const message = `Update state schema from Indra${sha ? ` ${sha.slice(0, 7)}` : ""}`;
    return await withFileLock(join(options.runtimeDir ?? `${checkout}.runtime`, "state.lock"), async (): Promise<SchemaSyncResult> => {
      const before = await readFile(file, "utf8").catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
      if (before === schema) return { outcome: "unchanged", message: "The state checkout's schema matches this build." };
      if (await git.dirty() || await git.busy()) {
        return { outcome: "dirty", message: `The state checkout has uncommitted changes or an unfinished rebase or merge, so Indra did not update ${STATE_SCHEMA_PATH}; commit or discard them, then restart Indra.` };
      }
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, schema, { flag: "wx" });
      await rename(temp, file);
      try {
        await git.add();
        await git.commit(message);
      } catch (error) {
        if (before === undefined) await rm(file, { force: true });
        else await writeFile(file, before);
        await git.unstage();
        throw error;
      }
      // The same sync as state.json: fetch, fast-forward or rebase, push; never force.
      const sync = await new StateGit(checkout).sync();
      return { outcome: "committed", message: `Committed "${message}" in the state checkout. ${sync.message}`, sync };
    });
  } catch (error) {
    return { outcome: "error", message: `Could not update the state schema: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` };
  }
}
