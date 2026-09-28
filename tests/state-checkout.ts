import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test repositories ignore the machine's Git configuration (signing, hooks, identity).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Indra Test", GIT_AUTHOR_EMAIL: "indra@example.test",
  GIT_COMMITTER_NAME: "Indra Test", GIT_COMMITTER_EMAIL: "indra@example.test",
});

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A temporary indra-state Git checkout whose state.json is committed. */
export async function stateCheckout(prefix: string, state: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", "state.json");
  git(dir, "commit", "--quiet", "-m", "Initial state");
  return dir;
}
