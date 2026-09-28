import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GITHUB_REPO } from "./local-state.js";
import { withFileLock } from "./state-commit.js";
import type { Shell } from "./developer-seat.js";

/** A project checkout problem whose message is ours and safe to record in state and the goal thread. */
export class ProjectCheckoutError extends Error { override name = "ProjectCheckoutError"; }

/** Indra's own clone of a team's GitHub project: `<state-checkout>.runtime/projects/<owner>/<repo>`. */
export function projectCheckoutPath(runtimeDir: string, github: string): string {
  if (!GITHUB_REPO.test(github)) throw new ProjectCheckoutError(`'${github}' is not a GitHub repository as 'owner/repo'.`);
  const [owner, repo] = github.split("/");
  return join(runtimeDir, "projects", owner, repo);
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * Makes sure Indra's clone of `github` exists and has the latest `origin/main`, and returns its path.
 * A missing clone is made with `gh repo clone` into a temporary directory and moved into place, so an
 * interrupted clone never leaves a half-made checkout. One lock per project covers every Indra process.
 */
export async function ensureProjectCheckout(shell: Shell, runtimeDir: string, github: string, base = "main"): Promise<string> {
  // A sprint's branch is fetched alongside main, so `origin/<base>` is current too.
  const branches = base === "main" ? ["main"] : ["main", base];
  const dir = projectCheckoutPath(runtimeDir, github);
  return await withFileLock(`${dir}.lock`, async () => {
    if (!(await exists(join(dir, ".git")))) {
      if (await exists(dir)) throw new ProjectCheckoutError(`${dir} exists but is not a Git checkout; remove it so Indra can clone ${github} again.`);
      await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
      const temp = `${dir}.${randomUUID()}.clone`;
      const cloned = await shell.run("gh", ["repo", "clone", github, temp], dirname(dir));
      if (cloned.code !== 0) {
        await rm(temp, { recursive: true, force: true });
        throw new ProjectCheckoutError(`gh repo clone ${github} failed (exit ${cloned.code}).`);
      }
      await rename(temp, dir);
    }
    // gh supplies the credential for this one command; Git's configuration is never changed.
    const fetched = await shell.run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "origin", ...branches], dir);
    if (fetched.code !== 0) throw new ProjectCheckoutError(`git fetch origin ${branches.join(" ")} failed in the ${github} checkout (exit ${fetched.code}).`);
    return dir;
  }, 30 * 60_000); // Another seat may be cloning a large project.
}
