/**
 * The indra repository owns the state JSON Schema (`schema/v1/state.schema.json`); the copy in the state
 * checkout follows it. At start-up Indra writes its own copy into the checkout when they differ, commits only
 * that file (its subject records the build's full commit), and pushes it through the same sync as state.json.
 * It never replaces a schema written by a build it does not include, so a rollback does not downgrade it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStampIn } from "./build-stamp.js";
import { childEnv } from "./op-env.js";
import { appRootOf } from "./reload.js";
import { StateGit, withFileLock, type StateSyncResult } from "./state-commit.js";
import bundledSchema from "../schema/v1/state.schema.json?raw";

/** Where the schema lives, in the indra repository and in the state checkout alike. */
export const STATE_SCHEMA_PATH = "schema/v1/state.schema.json";

export type SchemaSyncOutcome = "unchanged" | "committed" | "dirty" | "skipped" | "error";
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
  /** The Indra checkout whose history says which builds this one includes; the app root by default. */
  appDir?: string;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** The subject of Indra's schema commits, followed by the full commit of the build that wrote them. */
const COMMIT_SUBJECT = "Update state schema from Indra";

/** Whether `ancestor` is an ancestor of (or equal to) `commit` in the Indra checkout `appDir`; undefined when git cannot tell. */
function isAncestor(appDir: string, ancestor: string, commit: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", appDir, "merge-base", "--is-ancestor", ancestor, commit], { timeout: 10_000, env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0" } }, (error) => {
      if (!error) resolve(true);
      else resolve((error as { code?: unknown }).code === 1 ? false : undefined);
    });
  });
}

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
    const message = `${COMMIT_SUBJECT}${sha ? ` ${sha}` : ""}`;
    const appDir = options.appDir ?? appRootOf(import.meta.url);
    return await withFileLock(join(options.runtimeDir ?? `${checkout}.runtime`, "state.lock"), async (): Promise<SchemaSyncResult> => {
      const before = await readFile(file, "utf8").catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
      if (before === schema) return { outcome: "unchanged", message: "The state checkout's schema matches this build." };
      if (await git.dirty() || await git.busy()) {
        return { outcome: "dirty", message: `The state checkout has uncommitted changes or an unfinished rebase or merge, so Indra did not update ${STATE_SCHEMA_PATH}; commit or discard them, then restart Indra.` };
      }
      // Never downgrade: a schema written by an Indra build this one does not include (a newer build, or one
      // whose ancestry cannot be established here) is left alone.
      const recorded = new RegExp(`^${COMMIT_SUBJECT} ([0-9a-f]{40})$`).exec(await git.lastSubject())?.[1];
      if (recorded) {
        const includes = sha ? await isAncestor(appDir, recorded, sha) : undefined;
        if (includes === false) return { outcome: "skipped", message: `The state checkout's schema was written by Indra ${recorded.slice(0, 7)}, which this build (${sha.slice(0, 7)}) does not include; Indra left it alone.` };
        if (includes === undefined) return { outcome: "skipped", message: `Could not tell whether this build includes Indra ${recorded.slice(0, 7)}, which wrote the state checkout's schema; Indra left it alone.` };
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
