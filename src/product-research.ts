import { execCommand, type Shell } from "./command-shell.js";
import { runGh, runGit } from "./git-gh.js";
import { requireTeamHome, type PlanningDocument } from "./planning.js";
import { ensureProjectCheckout } from "./project-checkout.js";
import { redactSecrets } from "./redact.js";

export interface ResearchSource { url: string; text: string }
export interface ProductResearch { cwd: string; sources: ResearchSource[] }
export type ResearchReader = (state: PlanningDocument, teamId: string) => Promise<ProductResearch>;
export const MAX_RESEARCH_SOURCES = 12;
export const MAX_SOURCE_CHARS = 12_000;

/** Preparation uses the shared child environment, short commands and bounded output. No agent chooses a command. */
export const researchShell: Shell = {
  async run(command, args, cwd) {
    const result = await execCommand({ command, args }, { cwd, timeout: 20_000, maxBuffer: 1_000_000 });
    return { code: result.error ? 1 : 0, stdout: result.stdout, stderr: "" };
  },
};

/** Source contents are untrusted text. Redact before truncation and never persist raw command results. */
export function researchSource(url: string, text: string): ResearchSource | undefined {
  const parsed = new URL(url);
  const withoutRevision = url.replace(/\/[a-f0-9]{40}\//g, "/revision/");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || redactSecrets(withoutRevision) !== withoutRevision) throw new Error("Invalid research source URL.");
  const safe = redactSecrets(text).trim().slice(0, MAX_SOURCE_CHARS);
  return safe ? { url, text: safe } : undefined;
}

/**
 * Research is collected by trusted readers. Models remain in the existing offline, read-only seat sandbox.
 * GitHub reads use the owner's existing gh login; no Mattermost or 1Password credential reaches the model.
 */
export function productResearchReader(runtimeDir: string, shell: Shell = researchShell): ResearchReader {
  return async (state, teamId) => {
    const { github } = requireTeamHome(state, teamId);
    const cwd = await ensureProjectCheckout(shell, runtimeDir, github);
    const commit = await runGit(shell, ["rev-parse", "origin/main"], cwd);
    const sha = commit.stdout.trim();
    if (commit.code !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Cannot read the team's project revision for research.");
    const sources: ResearchSource[] = [];
    const add = (url: string, text: string) => { const source = researchSource(url, text); if (source) sources.push(source); };
    const retros = (state.planningGoals ?? []).filter((goal) => goal.teamId === teamId && goal.ceremony?.closure?.evidence.kind === "retro-published")
      .sort((a, b) => b.ceremony!.closure!.closedAt.localeCompare(a.ceremony!.closure!.closedAt)).slice(0, 2);
    const paths = ["README.md", "docs/state-repo.md", ...retros.map((goal) => `docs/retros/${goal.id}.md`)];
    for (const path of paths) {
      const result = await runGit(shell, ["show", `${sha}:${path}`], cwd);
      if (result.code === 0) add(`https://github.com/${github}/blob/${sha}/${path}`, result.stdout);
    }
    // An unavailable issue list does not turn missing data into evidence; committed sources can still be used.
    const issues = await runGh(shell, ["api", "--method", "GET", `repos/${github}/issues?state=open&sort=updated&per_page=20`], cwd);
    if (issues.code === 0) {
      let values: unknown;
      try { values = JSON.parse(issues.stdout); } catch { /* Ignore an invalid response, never its contents in logs. */ }
      if (Array.isArray(values)) for (const issue of values) {
        if (sources.length >= MAX_RESEARCH_SOURCES) break;
        if (!issue || typeof issue !== "object" || issue.pull_request || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.title !== "string" || (issue.body !== null && typeof issue.body !== "string")) continue;
        add(`https://github.com/${github}/issues/${issue.number}`, `${issue.title}\n${issue.body ?? ""}`);
      }
    }
    if (!sources.length) throw new Error("No cited project research is available yet.");
    return { cwd, sources };
  };
}
