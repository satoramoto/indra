import { dirname, join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runChecked, stderrExcerpt, type Shell, type ShellResult } from "./command-shell.js";
import { ensureProjectCheckout } from "./project-checkout.js";
import { withFileLock } from "./state-commit.js";
import { GITHUB_REPO } from "./local-state.js";
import { homedir } from "node:os";
import { redactSecrets } from "./redact.js";
import type { MergeVerification } from "./ceremony.js";
import { ownedFileMatches, validateGoalReport, type GoalBrief, type GoalReport } from "./goal-contract.js";

/** A sprint GitHub problem whose message is ours and safe to post in the goal thread. */
export class SprintError extends Error { override name = "SprintError"; }

export const sprintBranch = (goalId: string) => `sprint/${goalId}`;
export const revertBranch = (goalId: string) => `revert/${goalId}`;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{40}$/;
// gh supplies the credential for one command; Git's configuration is never changed.
const GH_CREDENTIAL = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string };
export interface ReleaseAttempts {
  version: 1; goalId: string; startedAt: string;
  conflicts: { prUrl: string; headSha: string; baseSha: string; at: string }[];
  merges: { prUrl: string; headSha: string; at: string }[];
  corrections?: { headSha: string; baseSha: string; startedAt: string; finishedAt?: string; resultSha?: string; status: "running" | "pushed" | "blocked"; decisions: string[] }[];
}
export const releaseAttemptsName = (goalId: string) => { retroPath(goalId); return `release-attempts-${goalId}`; };
interface IntegrationRecovery {
  version: 1; github: string; goalId: string; branch: string; prUrl: string; headSha: string; baseSha: string; ownedFiles: string[];
  checkout: string; sharedGitDir: string; phase: "preparing" | "prepared" | "resolved" | "committed" | "pushed" | "cleaned";
  resultSha: string | null; decisions: string[]; failure: string | null;
}
export interface PrRetrospective { url: string; headSha: string; decisions: string | null; followUps: string | null }

export function retroPath(goalId: string): string {
  if (!/^[a-z][a-z0-9-]+$/.test(goalId)) throw new SprintError("Invalid retrospective goal ID.");
  return `docs/retros/${goalId}.md`;
}
export const retroBranch = (goalId: string) => { retroPath(goalId); return `retro/${goalId}`; };
export interface RetroPr {
  url: string; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; mergedSha?: string;
  /** A fresh approval from the review account on this exact head, with no outstanding change requests. */
  reviewed: boolean; checksPassed: boolean;
}
export interface RetroReview {
  summary: string;
  findings: { path: string; line: number; reason: string }[];
}
export interface RetroArchive {
  ensureRetroPr(github: string, goalId: string, markdown: string): Promise<string>;
  inspectRetroPr(github: string, goalId: string, markdown: string, prUrl: string): Promise<RetroPr>;
  reviewRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string, review: (worktree: string) => Promise<RetroReview>): Promise<void>;
  mergeRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string): Promise<MergeResult>;
}

/**
 * The GitHub side of a sprint: its integration branch, the one PR from it into main, merging a PR once CI is green,
 * and a revert PR on main. Every call is safe to repeat: it finds what an earlier call made before making anything.
 */
export class SprintGitHub implements RetroArchive {
  constructor(private readonly shell: Shell, private readonly runtimeDir: string) {}

  /** gh with explicit repositories and URLs, run beside the state checkout so no local repository is involved. */
  private async run(command: string, args: string[], cwd = dirname(this.runtimeDir)): Promise<ShellResult> { return await this.shell.run(command, args, cwd); }
  private async must(command: string, args: string[], cwd = dirname(this.runtimeDir)): Promise<ShellResult> {
    return await runChecked(this.shell, command, args, cwd, (result) => new SprintError(`${command} ${args.slice(0, 2).join(" ")} failed: ${stderrExcerpt(result.stderr)}`));
  }

  async projectContext(github: string): Promise<{ cwd: string; mission: string; retros: GoalBrief["retros"] }> {
    if (!GITHUB_REPO.test(github)) throw new SprintError("Invalid project repository.");
    const cwd = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
    const mission = (await this.must("git", ["show", "origin/main:docs/mission.md"], cwd)).stdout;
    const paths = (await this.must("git", ["ls-tree", "-r", "--name-only", "origin/main", "--", "docs/retros"], cwd)).stdout.trim().split("\n").filter((path) => /^docs\/retros\/[a-z][a-z0-9-]*\.md$/.test(path));
    const rows = await Promise.all(paths.map(async (path) => ({ path, time: Number((await this.must("git", ["log", "-1", "--format=%ct", "origin/main", "--", path], cwd)).stdout.trim()) })));
    rows.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
    const retros = await Promise.all(rows.slice(0, 3).map(async ({ path }) => ({ goalId: path.slice("docs/retros/".length, -3), path, summary: (await this.must("git", ["show", `origin/main:${path}`], cwd)).stdout.trim() })));
    return { cwd, mission, retros };
  }

  /** The report is a claim. Re-read all lane proofs, prospective file boundaries and sprint ancestry. */
  async verifyGoalReport(github: string, ownedFiles: string[], input: GoalReport, baseSha: string): Promise<void> {
    const report = validateGoalReport(input);
    if (!GITHUB_REPO.test(github) || !SHA.test(baseSha) || !report.lanePrs.length || !report.checks.length || report.checks.some((check) => check.exitCode !== 0) || report.neededButUnowned.length) throw new SprintError("Goal report needs successful checks, merged lanes and no unowned work.");
    const cwd = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
    const head = (await this.must("gh", ["api", `repos/${github}/git/ref/heads/${report.sprintBranch}`, "--jq", ".object.sha"])).stdout.trim();
    if (head !== report.headSha) throw new SprintError("Reported sprint head differs from GitHub.");
    await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", report.sprintBranch, baseSha], cwd);
    const files = (await this.must("git", ["diff", "--name-only", "-z", baseSha, head, "--"], cwd)).stdout.split("\0").filter(Boolean);
    if (!files.length || files.some((file) => !ownedFiles.some((pattern) => ownedFileMatches(pattern, file)))) throw new SprintError("Sprint changes exceed the approved goal scope or contain no implementation.");
    for (const lane of report.lanePrs) {
      if (!lane.url.startsWith(`https://github.com/${github}/pull/`)) throw new SprintError("Reported lane belongs to a different repository.");
      const proof = await this.inspectMerge(lane.url);
      const view = JSON.parse((await this.must("gh", ["pr", "view", lane.url, "--json", "baseRefName,isCrossRepository"])).stdout) as { baseRefName?: string; isCrossRepository?: boolean };
      if (proof.state !== "MERGED" || proof.headSha !== lane.headSha || proof.mergedSha !== lane.mergedSha || !proof.reviewed || !proof.checksPassed || view.baseRefName !== report.sprintBranch || view.isCrossRepository !== false) throw new SprintError("Lane report is not supported by current GitHub merge, bot review and CI evidence.");
      await this.must("git", ["merge-base", "--is-ancestor", lane.mergedSha, head], cwd);
      const changed = await this.retroPages<{ filename: string; previous_filename?: string }>(`repos/${github}/pulls/${lane.url.split("/").at(-1)}/files?per_page=100`);
      if (!changed.length || changed.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]).some((file) => !ownedFiles.some((pattern) => ownedFileMatches(pattern, file)))) throw new SprintError("Lane changes exceed approved ownership.");
    }
  }

  /** A new integration head is allowed only inside the already approved boundary. Renames check both paths. */
  async integrationScope(github: string, goalId: string, ownedFiles: string[], prUrl: string, revert = false): Promise<{ headSha: string; baseSha: string; conflicting: boolean }> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    const pr = JSON.parse((await this.must("gh", ["pr", "view", prUrl, "--json", "headRefName,baseRefName,headRefOid,baseRefOid,isCrossRepository,mergeable"])).stdout) as Record<string, unknown>;
    if (pr.baseRefName !== "main" || pr.headRefName !== (revert ? revertBranch(goalId) : sprintBranch(goalId)) || pr.isCrossRepository !== false || !SHA.test(String(pr.headRefOid)) || !SHA.test(String(pr.baseRefOid))) throw new SprintError("Integration does not match the approved goal's project and branches.");
    const files = await this.retroPages<{ filename: string; previous_filename?: string }>(`${endpoint}/files?per_page=100`);
    if (!files.length || files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]).some((file) => !ownedFiles.some((pattern) => ownedFileMatches(pattern, file)))) throw new SprintError("Integration changes exceed the approved goal scope.");
    return { headSha: String(pr.headRefOid), baseSha: String(pr.baseRefOid), conflicting: pr.mergeable === "CONFLICTING" };
  }

  /** A retained correction is resumed only at its pinned identity; uncertain/dirty work is never discarded. */
  async resolveIntegration(github: string, goalId: string, ownedFiles: string[], prUrl: string, headSha: string, baseSha: string,
    resolve: (cwd: string, sharedGitDir: string) => Promise<{ decisions: string[]; blocked: string[] }>, revert = false): Promise<{ headSha: string; decisions: string[] }> {
    this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha) || !SHA.test(baseSha)) throw new SprintError("Invalid integration correction commits.");
    const branch = revert ? revertBranch(goalId) : sprintBranch(goalId);
    const identity = { version: 1 as const, github, goalId, branch, prUrl, headSha, baseSha, ownedFiles };
    const key = createHash("sha256").update(JSON.stringify({ github, goalId, branch, headSha, baseSha })).digest("hex");
    const journal = join(this.runtimeDir, `integration-recovery-${goalId}-${key}.json`);
    return await withFileLock(`${journal}.lock`, async () => {
      const project = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
      await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", branch, baseSha], project);
      const shared = await realpath((await this.must("git", ["rev-parse", "--absolute-git-dir"], project)).stdout.trim());
      const root = join(this.runtimeDir, "worktrees", `integration-fix-${goalId}-${key}`); const cwd = join(root, "checkout");
      const saved = await readFile(journal, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      const record: IntegrationRecovery = saved ? JSON.parse(saved) as IntegrationRecovery : { ...identity, checkout: cwd, sharedGitDir: shared, phase: "preparing", resultSha: null, decisions: [], failure: null };
      if (Object.entries(identity).some(([key, value]) => JSON.stringify(record[key as keyof IntegrationRecovery]) !== JSON.stringify(value)) || record.checkout !== cwd || record.sharedGitDir !== shared || !["preparing", "prepared", "resolved", "committed", "pushed", "cleaned"].includes(record.phase) || (record.resultSha !== null && !SHA.test(record.resultSha)) || !Array.isArray(record.decisions) || record.decisions.some((item) => typeof item !== "string")) throw new SprintError(`Integration recovery identity is uncertain; preserved at ${journal}.`);
      const save = async () => { const temp = `${journal}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, journal); };
      const within = (files: string[]) => files.every((file) => ownedFiles.some((pattern) => ownedFileMatches(pattern, file)));
      const files = async (args: string[]) => (await this.must("git", args, cwd)).stdout.split("\0").filter(Boolean);
      const idle = async () => {
        // The AgentRuntime stops its verified owned tree. Any remaining owner or foreign user prevents reuse/removal.
        // lsof exit 1 with no output means no open files; unreadable/unsupported inspection fails closed.
        const users = await this.run("lsof", ["-nP", "-F", "p", "+D", cwd], project);
        if (users.code !== 1 || users.stdout.trim() || users.stderr.trim()) throw new SprintError("Integration checkout has live processes or its process liveness is uninspectable; no process was signalled.");
      };
      if (!saved) {
        await mkdir(dirname(root), { recursive: true, mode: 0o700 });
        await mkdir(root, { mode: 0o700 }); // Never claim an existing, unjournaled checkout, even on failure.
        await save();
      }
      try {
        if (!(await lstat(root)).isDirectory()) throw new SprintError("Integration recovery root ownership is uncertain.");
        const exists = await lstat(cwd).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
        if (exists && !exists.isDirectory()) throw new SprintError("Integration recovery checkout is not an owned directory.");
        if (!exists && record.phase === "preparing") await this.must("git", ["worktree", "add", "--detach", cwd, headSha], project);
        else if (!exists && record.phase === "pushed" && record.resultSha) record.phase = "cleaned"; // Lost removal response; remote proof is checked below.
        else if (!exists && record.phase !== "cleaned") throw new SprintError("Integration recovery checkout is missing; retained work cannot be assumed safe.");
        if (record.phase !== "cleaned") {
          const common = (await this.must("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).stdout.trim();
          if (await realpath(common) !== shared || (await this.run("git", ["symbolic-ref", "-q", "HEAD"], cwd)).code !== 1) throw new SprintError("Integration recovery checkout ownership or detached identity changed.");
          await idle();
          let head = (await this.must("git", ["rev-parse", "HEAD"], cwd)).stdout.trim();
          if (head !== headSha && !record.resultSha && record.phase !== "resolved") throw new SprintError("Resolver changed the pinned integration history without a host commit intent.");
          if (head === headSha && !record.resultSha) {
            const mergeHead = await this.run("git", ["rev-parse", "--verify", "MERGE_HEAD"], cwd);
            let prepared = mergeHead.code === 0;
            if (prepared && mergeHead.stdout.trim() !== baseSha) throw new SprintError("Retained merge has a different base; preserved for inspection.");
            if (!prepared) {
              if (record.phase !== "preparing" || (await this.must("git", ["status", "--porcelain", "--untracked-files=all"], cwd)).stdout.trim()) throw new SprintError("Retained correction is not a clean prepared merge; no history was reset.");
              const merged = await this.run("git", ["merge", "--no-commit", "--no-ff", baseSha], cwd);
              const conflicts = await files(["diff", "--name-only", "--diff-filter=U", "-z"]);
              if ((merged.code !== 0 && !conflicts.length) || !within(conflicts)) throw new SprintError("Integration conflict needs files outside approved ownership or could not be prepared.");
              prepared = true;
            }
            const conflicts = await files(["diff", "--name-only", "--diff-filter=U", "-z"]);
            if (!within(conflicts)) throw new SprintError("Integration conflict needs files outside approved ownership.");
            const needsResolver = conflicts.length > 0 || record.phase === "prepared";
            if (record.phase === "preparing") { record.phase = "prepared"; await save(); }
            if (needsResolver) {
              const result = await resolve(cwd, shared); record.decisions = result.decisions.map((item) => redactSecrets(item)); await save();
              if (result.blocked.length) throw new SprintError(`Integration correction needs an owner decision: ${redactSecrets(result.blocked.join("; ")).slice(0, 800)}`);
            } else if (!record.decisions.length) record.decisions = ["Merged the observed main commit into the sprint without rebasing."];
            await idle();
            if ((await this.must("git", ["rev-parse", "HEAD"], cwd)).stdout.trim() !== headSha || (await this.must("git", ["rev-parse", "MERGE_HEAD"], cwd)).stdout.trim() !== baseSha) throw new SprintError("Resolver changed the pinned integration history.");
            const unstaged = await files(["diff", "--name-only", "--no-renames", "-z"]);
            const untracked = await files(["ls-files", "--others", "--exclude-standard", "-z"]);
            if (!within([...unstaged, ...untracked])) throw new SprintError("Resolver edited files outside approved ownership.");
            await this.must("git", ["add", "--all"], cwd);
            if ((await files(["diff", "--name-only", "--diff-filter=U", "-z"])).length) throw new SprintError("Integration conflicts remain unresolved.");
            if (!within(await files(["diff", "--cached", "--name-only", "--no-renames", "-z", baseSha]))) throw new SprintError("Corrected integration exceeds approved ownership relative to main.");
            const current = await this.integrationScope(github, goalId, ownedFiles, prUrl, revert);
            if (current.headSha !== headSha || current.baseSha !== baseSha) throw new SprintError("Integration changed during correction; retained work needs reconciliation.");
            record.phase = "resolved"; await save();
            await this.must("git", ["commit", "-m", `Merge main into ${branch} within approved scope`], cwd);
            head = (await this.must("git", ["rev-parse", "HEAD"], cwd)).stdout.trim();
          }
          // Also recovers a crash immediately after commit, before its result SHA was journaled.
          const parents = (await this.must("git", ["rev-list", "--parents", "-n", "1", head], cwd)).stdout.trim().split(" ");
          if (!SHA.test(head) || JSON.stringify(parents) !== JSON.stringify([head, headSha, baseSha]) || (record.resultSha && record.resultSha !== head) || !within(await files(["diff", "--name-only", "--no-renames", "-z", baseSha, head]))) throw new SprintError("Retained correction commit does not match its pinned history and approved scope.");
          if ((await this.must("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], cwd)).stdout.trim()) throw new SprintError("Integration correction has uncommitted or ignored work; retained without cleanup.");
          record.resultSha = head; record.phase = "committed"; await save();
          const current = await this.integrationScope(github, goalId, ownedFiles, prUrl, revert);
          if (![headSha, head].includes(current.headSha) || current.baseSha !== baseSha) throw new SprintError("Integration changed before publication; retained correction needs reconciliation.");
          if (current.headSha !== head) await this.must("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], cwd);
        }
        const resultSha = record.resultSha;
        const remote = (await this.must("gh", ["api", `repos/${github}/git/ref/heads/${branch}`, "--jq", ".object.sha"])).stdout.trim();
        if (!resultSha || remote !== resultSha) throw new SprintError("Corrected integration push is not verified.");
        record.phase = record.phase === "cleaned" ? "cleaned" : "pushed"; await save();
        const marker = `<!-- indra-integration-correction:${resultSha} -->`;
        const body = JSON.parse((await this.must("gh", ["pr", "view", prUrl, "--json", "body"])).stdout).body as unknown;
        if (typeof body !== "string") throw new SprintError("Integration PR body is unreadable.");
        if (!body.includes(marker)) {
          const path = join(root, "body.md"); await writeFile(path, `${body}\n\n## Integration correction\n\n${marker}\nMerged ${baseSha} into ${headSha}, producing ${resultSha}.\n\nDecisions:\n${record.decisions.map((item) => `- ${item}`).join("\n")}\n\nFresh review and CI are required on the new head.\n`, { mode: 0o600 });
          await this.must("gh", ["pr", "edit", prUrl, "--body-file", path]);
        }
        if (record.phase !== "cleaned") {
          await idle();
          if ((await this.must("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], cwd)).stdout.trim() || (await this.must("git", ["rev-parse", "HEAD"], cwd)).stdout.trim() !== resultSha) throw new SprintError("Published correction has new or uncertain work; retained without cleanup.");
          await this.must("git", ["worktree", "remove", cwd], project); // No --force; Git gets the final dirty-work veto.
          record.phase = "cleaned";
        }
        record.failure = null; await save();
        return { headSha: resultSha, decisions: record.decisions };
      } catch (error) {
        record.failure = error instanceof Error ? redactSecrets(error.message).slice(0, 1000) : "Integration correction was not confirmed.";
        await save();
        throw new SprintError(`${record.failure} Recovery retained at ${cwd}; identity and retry journal: ${journal}.`);
      }
    });
  }

  /** Archive only sections read from the actual merged PR, bound to the delivered lane head. */
  async prRetrospective(github: string, goalId: string, url: string, headSha: string): Promise<PrRetrospective> {
    this.retroRepo(github, goalId, url);
    const pr = JSON.parse((await this.must("gh", ["pr", "view", url, "--json", "state,headRefOid,body"])).stdout) as { state?: string; headRefOid?: string; body?: unknown };
    if (pr.state !== "MERGED" || pr.headRefOid !== headSha || typeof pr.body !== "string") throw new SprintError("Lane retrospective source is not the verified merged PR head.");
    const section = (title: RegExp) => {
      const lines = pr.body!.toString().split(/\r?\n/); const start = lines.findIndex((line) => title.test(line));
      if (start < 0) return null;
      const end = lines.findIndex((line, index) => index > start && /^#{1,3}\s/.test(line));
      return redactSecrets(lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim()) || null;
    };
    return { url, headSha, decisions: section(/^#{1,3}\s+Decisions\s*$/i), followUps: section(/^#{1,3}\s+Follow[ -]?ups\s*$/i) };
  }

  /** One independent bot review per immutable integration/revert head, immediately after opening. */
  async reviewIntegration(github: string, goalId: string, prUrl: string, headSha: string, review: (cwd: string) => Promise<unknown>): Promise<void> {
    this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid integration review head.");
    await withFileLock(join(this.runtimeDir, `integration-review-${goalId}.lock`), async () => {
      const endpoint = `repos/${github}/pulls/${prUrl.split("/").at(-1)}`;
      const marker = `<!-- indra-integration-review:${goalId}:${headSha} -->`;
      const delivered = async () => (await this.retroPages<{ user: { login: string }; commit_id: string; body: string; state: string }>(`${endpoint}/reviews?per_page=100`)).some((item) => item.user?.login === "satori-miyamoto" && item.commit_id === headSha && item.body?.trimEnd().endsWith(marker) && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state));
      if (await delivered()) return;
      const before = await this.inspectMerge(prUrl);
      if (before.state !== "OPEN" || before.headSha !== headSha) throw new SprintError("Integration changed before review.");
      const details = JSON.parse((await this.must("gh", ["pr", "view", prUrl, "--json", "baseRefName,isCrossRepository"])).stdout) as { baseRefName?: string; isCrossRepository?: boolean };
      if (details.baseRefName !== "main" || details.isCrossRepository !== false) throw new SprintError("Integration review requires the project's main target.");
      const account = await this.run("env", [`GH_CONFIG_DIR=${join(homedir(), ".config/gh-yahaha-bot")}`, "gh", "api", "user", "--jq", ".login"]);
      if (account.code !== 0 || account.stdout.trim() !== "satori-miyamoto") throw new SprintError("Integration review requires satori-miyamoto.");
      const cwd = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
      await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", `refs/pull/${prUrl.split("/").at(-1)}/head`], cwd);
      const root = join(this.runtimeDir, "worktrees"); await mkdir(root, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(root, `integration-review-${goalId}-`)); const checkout = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", checkout, headSha], cwd);
        const value = await review(checkout) as RetroReview;
        const files = await this.retroPages<{ filename: string }>(`${endpoint}/files?per_page=100`);
        if (typeof value?.summary !== "string" || !Array.isArray(value.findings) || value.findings.some((finding) => !files.some((file) => file.filename === finding.path) || !Number.isSafeInteger(finding.line) || finding.line < 1 || typeof finding.reason !== "string" || !finding.reason.trim())) throw new SprintError("Invalid integration reviewer findings.");
        const current = await this.inspectMerge(prUrl);
        if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Integration changed during review.");
        if (await delivered()) return;
        const file = join(temp, "review.json"); await writeFile(file, JSON.stringify({ commit_id: headSha, event: value.findings.length ? "REQUEST_CHANGES" : "APPROVE", body: `${redactSecrets(value.summary)}\n\n${marker}`, comments: value.findings.map((finding) => ({ path: finding.path, line: finding.line, side: "RIGHT", body: redactSecrets(finding.reason) })) }), { mode: 0o600 });
        await this.run("env", [`GH_CONFIG_DIR=${join(homedir(), ".config/gh-yahaha-bot")}`, "gh", "api", `${endpoint}/reviews`, "--method", "POST", "--input", file]);
        if (!await delivered()) throw new SprintError("Integration review delivery is not confirmed.");
      } finally { if ((await this.run("git", ["worktree", "remove", "--force", checkout], cwd)).code === 0) await rm(temp, { recursive: true, force: true }); }
    });
  }

  /** Creates `sprint/<goal-id>` on GitHub from main's current head unless it exists; returns the branch's head. */
  async ensureBranch(github: string, goalId: string): Promise<string> {
    const head = async () => {
      const found = await this.run("gh", ["api", `repos/${github}/git/ref/heads/${sprintBranch(goalId)}`, "--jq", ".object.sha"]);
      return found.code === 0 && SHA.test(found.stdout.trim()) ? found.stdout.trim() : undefined;
    };
    const existing = await head();
    if (existing) return existing;
    const main = (await this.must("gh", ["api", `repos/${github}/git/ref/heads/main`, "--jq", ".object.sha"])).stdout.trim();
    if (!SHA.test(main)) throw new SprintError(`GitHub returned no commit for main on ${github}.`);
    const created = await this.run("gh", ["api", "-X", "POST", `repos/${github}/git/refs`, "-f", `ref=refs/heads/${sprintBranch(goalId)}`, "-f", `sha=${main}`]);
    if (created.code === 0) return main;
    // Another process may have created it between the check and the POST.
    const raced = await head();
    if (raced) return raced;
    throw new SprintError(`Could not create ${sprintBranch(goalId)} on ${github}: ${stderrExcerpt(created.stderr)}`);
  }

  /** The open PR from `head` into main, opened now if there is none. */
  async openPr(github: string, head: string, title: string, body: string): Promise<string> {
    const found = (await this.must("gh", ["pr", "list", "--repo", github, "--head", head, "--base", "main", "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""])).stdout.trim();
    if (PR_URL.test(found)) return found;
    const created = (await this.must("gh", ["pr", "create", "--repo", github, "--base", "main", "--head", head, "--title", title, "--body", body])).stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!PR_URL.test(created)) throw new SprintError(`gh pr create returned no PR URL for ${head}.`);
    return created;
  }

  /** Observe one PR head with its latest bot verdict and every required check. */
  async inspectMerge(prUrl: string): Promise<RetroPr> {
    if (!PR_URL.test(prUrl)) throw new SprintError("Invalid sprint PR URL.");
    const github = prUrl.split("/").slice(3, 5).join("/"); const number = prUrl.split("/").at(-1)!;
    const read = async () => {
      const response = await this.must("gh", ["pr", "view", prUrl, "--json", "state,mergeCommit,headRefOid,isDraft,author,reviewDecision"]);
      try { return JSON.parse(response.stdout) as { state: RetroPr["state"]; mergeCommit?: { oid: string }; headRefOid: string; isDraft: boolean; author: { login: string }; reviewDecision?: string }; }
      catch { throw new SprintError("Unreadable sprint PR details."); }
    };
    const before = await read();
    if (!SHA.test(before.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(before.state) || !before.author?.login || typeof before.isDraft !== "boolean") throw new SprintError("Unverified sprint PR head or author.");
    const reviews = await this.retroPages<{ id: number; user: { login: string }; state: string; commit_id: string }>(`repos/${github}/pulls/${number}/reviews?per_page=100`);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of reviews.sort((a, b) => a.id - b.id)) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user?.login, review);
    const bot = latest.get("satori-miyamoto");
    const reviewed = !before.isDraft && before.author.login !== "satori-miyamoto" && before.reviewDecision !== "CHANGES_REQUESTED" && ![...latest.values()].some((review) => review.state === "CHANGES_REQUESTED") && bot?.state === "APPROVED" && bot.commit_id === before.headRefOid;
    const checks = await this.run("gh", ["pr", "checks", prUrl, "--json", "name,bucket"]);
    let checksPassed = false;
    try {
      const rows = JSON.parse(checks.stdout) as { name: string; bucket: string }[];
      checksPassed = checks.code === 0 && Array.isArray(rows) && rows.some((row) => row.name === "checks") && rows.every((row) => row.bucket === "pass");
    } catch { /* Missing check evidence is pending. */ }
    if (JSON.stringify(before) !== JSON.stringify(await read())) throw new SprintError("Sprint PR changed during verification.");
    return { url: prUrl, state: before.state, headSha: before.headRefOid, reviewed, checksPassed,
      ...(SHA.test(before.mergeCommit?.oid ?? "") ? { mergedSha: before.mergeCommit!.oid } : {}) };
  }

  /**
   * Read-only preflight for the narrowly supported server-enforced bot gate. A client-side review snapshot
   * cannot prevent a same-head dismissal racing the merge; GitHub must require this particular Code Owner.
   * Undefined means the policy was verified, not that the PR itself is approved or mergeable.
   */
  async serverMergeBlocker(prUrl: string, headSha: string): Promise<string | undefined> {
    const blocked = (reason: string) => `Automatic merge blocked: ${reason} See docs/remodel-contract.md for the required server-side Code Owner policy.`;
    if (!PR_URL.test(prUrl) || !SHA.test(headSha)) return blocked("The PR identity or head is invalid.");
    const github = prUrl.split("/").slice(3, 5).join("/"); const number = prUrl.split("/").at(-1)!;
    if (!GITHUB_REPO.test(github)) return blocked("The PR repository is invalid.");
    type Json = Record<string, unknown>;
    const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
    const require = (condition: unknown, message: string): void => { if (!condition) throw new SprintError(message); };
    const read = async (endpoint: string): Promise<Json> => {
      const result = await this.run("gh", ["api", endpoint, "--method", "GET"]);
      if (result.code !== 0) throw new SprintError("GitHub policy evidence is unavailable; repository administration read access may be required.");
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch { throw new SprintError("GitHub policy evidence is unreadable."); }
      if (!object(parsed)) throw new SprintError("GitHub policy evidence has an unknown shape.");
      return parsed;
    };
    try {
      const pr = await read(`repos/${github}/pulls/${number}`);
      const base = object(pr.base) ? pr.base : {}; const head = object(pr.head) ? pr.head : {};
      const repo = object(base.repo) ? base.repo : {};
      require(pr.state === "open" && pr.draft === false && head.sha === headSha && typeof repo.full_name === "string" && repo.full_name.toLowerCase() === github.toLowerCase(), "The open PR no longer matches the inspected project and head.");
      require(pr.auto_merge === null, "Disable the existing deferred auto-merge request before using the protected merge gate.");
      require(typeof base.ref === "string" && !!base.ref && typeof base.sha === "string" && SHA.test(base.sha), "The target branch and commit are unverified.");
      const protection = await read(`repos/${github}/branches/${encodeURIComponent(base.ref as string)}/protection`);
      const reviews = object(protection.required_pull_request_reviews) ? protection.required_pull_request_reviews : {};
      const admins = object(protection.enforce_admins) ? protection.enforce_admins : {};
      const checks = object(protection.required_status_checks) ? protection.required_status_checks : {};
      require(admins.enabled === true, "The target must enforce branch protection for administrators and bypass-capable roles.");
      require(Number.isSafeInteger(reviews.required_approving_review_count) && Number(reviews.required_approving_review_count) >= 1 && reviews.require_code_owner_reviews === true && reviews.dismiss_stale_reviews === true,
        "The target must require approving Code Owner reviews and dismiss stale approvals.");
      const bypass = reviews.bypass_pull_request_allowances;
      require(bypass === undefined || (object(bypass) && Object.keys(bypass).every((key) => ["users", "teams", "apps"].includes(key)) && ["users", "teams", "apps"].every((key) => Array.isArray(bypass[key]) && bypass[key].length === 0)), "Required reviews must have no bypass allowances.");
      require((Array.isArray(checks.contexts) && checks.contexts.includes("checks")) || (Array.isArray(checks.checks) && checks.checks.some((check) => object(check) && check.context === "checks")), "The target must require the checks CI job.");
      const permission = await read(`repos/${github}/collaborators/satori-miyamoto/permission`);
      const user = object(permission.user) ? permission.user : {}; const rights = object(user.permissions) ? user.permissions : {};
      require(user.login === "satori-miyamoto" && rights.push === true && ["write", "maintain", "admin"].includes(String(permission.permission)), "satori-miyamoto must have write access to be an enforceable Code Owner.");
      // Inspect Git mode as well as bytes: the Contents API can dereference a symlink and present it as a file.
      const tree = await read(`repos/${github}/git/trees/${base.sha}?recursive=1`);
      require(tree.truncated === false && Array.isArray(tree.tree), "The target tree cannot be completely inspected for CODEOWNERS.");
      const owners = (tree.tree as unknown[]).filter((entry) => object(entry) && entry.path === ".github/CODEOWNERS");
      const owner = owners[0];
      require(owners.length === 1 && object(owner) && owner.type === "blob" && owner.mode === "100644" && typeof owner.sha === "string" && SHA.test(owner.sha), "The target must contain a regular .github/CODEOWNERS file.");
      const blob = await read(`repos/${github}/git/blobs/${(owner as Json).sha}`);
      require(blob.sha === (owner as Json).sha && blob.encoding === "base64" && typeof blob.content === "string" && typeof blob.size === "number" && blob.size > 0 && blob.size <= 10_000, "The target CODEOWNERS content cannot be verified.");
      const bytes = Buffer.from(blob.content as string, "base64");
      require(bytes.length === blob.size, "The target CODEOWNERS content is incomplete.");
      const rules = bytes.toString("utf8").split(/\r?\n/).map((line) => line.split("#")[0].trim()).filter(Boolean);
      require(rules.length === 1 && /^\*[ \t]+@satori-miyamoto$/.test(rules[0]), "The only target CODEOWNERS rule must be '* @satori-miyamoto', with no alternative owners or overrides.");
      const errors = await read(`repos/${github}/codeowners/errors?ref=${base.sha}`);
      require(Array.isArray(errors.errors) && errors.errors.length === 0, "GitHub reports invalid or unreadable target CODEOWNERS rules.");
      return undefined;
    } catch (error) {
      return blocked(error instanceof SprintError ? error.message : "GitHub policy verification did not complete.");
    }
  }

  /** Current-head bot approval and green CI gate release; a request alone never proves a merge. */
  async merge(prUrl: string, beforeMutation?: (headSha: string) => Promise<void>): Promise<MergeResult> {
    const before = await this.inspectMerge(prUrl);
    if (!before.reviewed || !before.checksPassed) return { merged: false, reason: `Current-head satori-miyamoto approval and passing CI are required on ${prUrl}` };
    if (before.state === "MERGED" && before.mergedSha) return { merged: true, sha: before.mergedSha };
    if (before.state !== "OPEN") return { merged: false, reason: `${prUrl} is ${before.state.toLowerCase()}` };
    const blocker = await this.serverMergeBlocker(prUrl, before.headSha);
    if (blocker) return { merged: false, reason: blocker };
    await beforeMutation?.(before.headSha);
    // GitHub enforces the Code Owner verdict at mutation time; the SHA precondition pins this attempt.
    // Never arm deferred auto-merge, which can outlive this process and its inspected head.
    try { await this.run("gh", ["pr", "merge", prUrl, "--squash", "--match-head-commit", before.headSha]); }
    catch { /* A lost command response is reconciled from GitHub below. */ }
    const after = await this.inspectMerge(prUrl);
    if (after.state === "MERGED" && after.mergedSha && after.headSha === before.headSha && after.reviewed && after.checksPassed) return { merged: true, sha: after.mergedSha };
    return { merged: false, reason: "Protected merge is not verified; wait for the next workflow event." };
  }

  async mergeVerification(prUrl: string): Promise<MergeVerification | undefined> {
    const proof = await this.inspectMerge(prUrl);
    return proof.state === "MERGED" && proof.mergedSha && proof.reviewed && proof.checksPassed
      ? { headSha: proof.headSha, reviewCommitSha: proof.headSha, reviewer: "satori-miyamoto", checksPassed: true } : undefined;
  }

  private retroRepo(github: string, goalId: string, prUrl?: string): string {
    retroPath(goalId);
    if (!GITHUB_REPO.test(github)) throw new SprintError("Invalid retrospective project.");
    if (prUrl && (!PR_URL.test(prUrl) || !prUrl.startsWith(`https://github.com/${github}/pull/`))) throw new SprintError("Retrospective PR is outside the team's project.");
    return `repos/${github}/pulls${prUrl ? `/${prUrl.split("/").at(-1)}` : ""}`;
  }

  /** Paginate every recovery query; an unreadable response never means 'nothing exists'. */
  private async retroPages<T>(endpoint: string): Promise<T[]> {
    const result = await this.run("gh", ["api", endpoint, "--method", "GET", "--paginate", "--slurp"]);
    if (result.code !== 0) throw new SprintError("Could not read retrospective PR history.");
    try {
      const pages = JSON.parse(result.stdout) as T[][];
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error();
      return pages.flat();
    } catch { throw new SprintError("Invalid retrospective PR history."); }
  }

  private async findRetroPr(github: string, goalId: string): Promise<string | undefined> {
    const endpoint = this.retroRepo(github, goalId);
    const prs = await this.retroPages<{ html_url: string }>(`${endpoint}?state=all&head=${github.split("/")[0]}:${retroBranch(goalId)}&base=main&per_page=100`);
    if (prs.length > 1) throw new SprintError("Multiple retrospective PRs require owner reconciliation.");
    if (!prs.length) return;
    this.retroRepo(github, goalId, prs[0].html_url);
    if (!prs[0].html_url) throw new SprintError("Invalid retrospective PR URL.");
    return prs[0].html_url;
  }

  private async retroCheckout(github: string): Promise<string> {
    const project = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
    const remote = (await this.must("git", ["remote", "get-url", "origin"], project)).stdout.trim();
    if (![ `https://github.com/${github}`, `https://github.com/${github}.git`, `git@github.com:${github}.git`, `ssh://git@github.com/${github}.git` ].includes(remote)) throw new SprintError("Retrospective checkout does not belong to the team's project.");
    return project;
  }

  private async retroTree(project: string, from: string, to: string, path: string, markdown: string): Promise<void> {
    const changed = (await this.must("git", ["diff", "--name-only", "-z", from, to, "--"], project)).stdout;
    const mode = (await this.must("git", ["ls-tree", to, "--", path], project)).stdout;
    const content = await this.must("git", ["show", `${to}:${path}`], project);
    if (changed !== `${path}\0` || !mode.startsWith("100644 blob ") || content.stdout !== markdown) throw new SprintError("Retrospective PR must change only its goal's regular document, with exactly the frozen content.");
  }

  /** Reuses branches and PRs, including closed/merged PRs. Never replaces a rejected archive or force-pushes. */
  async ensureRetroPr(github: string, goalId: string, markdown: string): Promise<string> {
    this.retroRepo(github, goalId);
    if (!markdown.trim()) throw new SprintError("An empty retrospective cannot be archived.");
    return await withFileLock(join(this.runtimeDir, `retro-git-${goalId}.lock`), async () => {
      const found = await this.findRetroPr(github, goalId);
      if (found) return found;
      const project = await this.retroCheckout(github);
      const branch = retroBranch(goalId); const path = retroPath(goalId);
      const remote = await this.run("git", [...GH_CREDENTIAL, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], project);
      if (remote.code !== 0 && remote.code !== 2) throw new SprintError("Could not inspect the retrospective branch.");
      if (remote.code === 0) {
        const sha = remote.stdout.split(/\s/)[0];
        if (!SHA.test(sha)) throw new SprintError("Invalid retrospective branch head.");
        await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", sha], project);
        const base = (await this.must("git", ["merge-base", "origin/main", sha], project)).stdout.trim();
        await this.retroTree(project, base, sha, path, markdown);
      } else {
        const worktrees = join(this.runtimeDir, "worktrees");
        await mkdir(worktrees, { recursive: true, mode: 0o700 });
        const temp = await mkdtemp(join(worktrees, `retro-${goalId}-`));
        const worktree = join(temp, "checkout");
        try {
          await this.must("git", ["worktree", "add", "--detach", worktree, "origin/main"], project);
          // Reject tracked symlinks before touching any document path.
          for (const directory of [join(worktree, "docs"), join(worktree, "docs/retros")]) {
            const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
            if (entry && !entry.isDirectory()) throw new SprintError("Retrospective directories must be real directories.");
            if (!entry) await mkdir(directory);
          }
          await writeFile(join(worktree, path), markdown, { flag: "wx", mode: 0o644 });
          await this.must("git", ["add", "--", path], worktree);
          await this.must("git", ["commit", "--only", "-m", `Archive retrospective for ${goalId}`, "--", path], worktree);
          await this.retroTree(worktree, "HEAD^", "HEAD", path, markdown);
          const pushed = await this.run("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], worktree);
          if (pushed.code !== 0) throw new SprintError("Retrospective push was not confirmed; reconcile the branch on retry.");
        } finally {
          const removed = await this.run("git", ["worktree", "remove", "--force", worktree], project);
          if (removed.code === 0) await rm(temp, { recursive: true, force: true });
        }
      }
      // The body is a file, never document text in command arguments.
      const temp = await mkdtemp(join(this.runtimeDir, "retro-pr-"));
      try {
        const body = join(temp, "body.md");
        await writeFile(body, `Archives the frozen retrospective for ${goalId} in ${path}.\n\nOnly this document may change. Requires a fresh satori-miyamoto review on the current head, passing CI. No further human approval is needed. Process suggestions are owner proposals only.\n`, { mode: 0o600 });
        const created = await this.run("gh", ["pr", "create", "--repo", github, "--base", "main", "--head", branch, "--title", `Archive retrospective for ${goalId}`, "--body-file", body]);
        const recovered = await this.findRetroPr(github, goalId);
        if (recovered) return recovered;
        throw new SprintError(created.code === 0 ? "Retrospective PR is not visible yet; retry reconciliation." : "Retrospective PR creation was not confirmed; retry reconciliation.");
      } finally { await rm(temp, { recursive: true, force: true }); }
    });
  }

  /** Check the exact PR head, every changed path, document bytes, review and CI again, even after a restart. */
  async inspectRetroPr(github: string, goalId: string, markdown: string, prUrl: string): Promise<RetroPr> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    const read = async () => {
      const result = await this.run("gh", ["pr", "view", prUrl, "--json", "state,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,author,mergeCommit,reviewDecision"]);
      if (result.code !== 0) throw new SprintError("Could not inspect the retrospective PR.");
      try { return JSON.parse(result.stdout) as { state: RetroPr["state"]; headRefName: string; baseRefName: string; headRefOid: string; isCrossRepository: boolean; isDraft: boolean; author: { login: string }; mergeCommit?: { oid: string }; reviewDecision?: string }; }
      catch { throw new SprintError("Invalid retrospective PR details."); }
    };
    const pr = await read();
    if (pr.baseRefName !== "main" || pr.headRefName !== retroBranch(goalId) || pr.isCrossRepository !== false || !SHA.test(pr.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || !pr.author?.login) throw new SprintError("Retrospective PR does not match this goal's archive branch and project.");
    const path = retroPath(goalId);
    const files = await this.retroPages<{ filename: string; status: string; previous_filename?: string }>(`${endpoint}/files?per_page=100`);
    if (files.length !== 1 || files[0].filename !== path || !["added", "modified"].includes(files[0].status) || files[0].previous_filename) throw new SprintError("Retrospective PR may change only its goal's document.");
    const project = await this.retroCheckout(github);
    await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", `refs/pull/${prUrl.split("/").at(-1)}/head`], project);
    const mode = (await this.must("git", ["ls-tree", pr.headRefOid, "--", path], project)).stdout;
    const content = (await this.must("git", ["show", `${pr.headRefOid}:${path}`], project)).stdout;
    if (!mode.startsWith("100644 blob ") || content !== markdown) throw new SprintError("Retrospective head differs from the frozen document.");
    if (pr.state === "MERGED") {
      if (!SHA.test(pr.mergeCommit?.oid ?? "")) throw new SprintError("Retrospective merge commit is unverified.");
      await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", pr.mergeCommit!.oid], project);
      await this.must("git", ["merge-base", "--is-ancestor", pr.mergeCommit!.oid, "origin/main"], project);
      await this.retroTree(project, `${pr.mergeCommit!.oid}^`, pr.mergeCommit!.oid, path, markdown);
    }
    const reviews = await this.retroPages<{ id: number; user: { login: string }; state: string; commit_id: string }>(`${endpoint}/reviews?per_page=100`);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of reviews.sort((a, b) => a.id - b.id)) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user?.login, review);
    const approved = latest.get("satori-miyamoto");
    const reviewed = pr.author.login !== "satori-miyamoto" && pr.reviewDecision !== "CHANGES_REQUESTED" && ![...latest.values()].some((review) => review.state === "CHANGES_REQUESTED") && approved?.state === "APPROVED" && approved.commit_id === pr.headRefOid;
    const checks = await this.run("gh", ["pr", "checks", prUrl, "--json", "name,bucket"]);
    let checksPassed = false;
    try {
      const rows = JSON.parse(checks.stdout) as { name: string; bucket: string }[];
      checksPassed = checks.code === 0 && Array.isArray(rows) && rows.some((row) => row.name === "checks") && rows.every((row) => row.bucket === "pass");
    } catch { /* Missing/unreadable CI is pending. */ }
    const after = await read();
    if (JSON.stringify(after) !== JSON.stringify(pr)) throw new SprintError("Retrospective PR changed during verification; retry.");
    return { url: prUrl, state: pr.state, headSha: pr.headRefOid, mergedSha: pr.mergeCommit?.oid, reviewed: reviewed && !pr.isDraft, checksPassed };
  }

  /** A fresh read-only reviewer sees the pinned checkout; the host posts its line comments and verdict. */
  async reviewRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string, review: (worktree: string) => Promise<RetroReview>): Promise<void> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid retrospective review head.");
    await withFileLock(join(this.runtimeDir, `retro-review-${goalId}.lock`), async () => {
      const marker = `<!-- indra-retro-review:${goalId}:${headSha} -->`;
      const reconciled = async () => (await this.retroPages<{ user: { login: string }; commit_id: string; body: string; state: string }>(`${endpoint}/reviews?per_page=100`))
        .some((item) => item.user?.login === "satori-miyamoto" && item.commit_id === headSha && item.body?.trimEnd().endsWith(marker)
          && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state));
      if (await reconciled()) return;
      const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
      if (before.state !== "OPEN" || before.headSha !== headSha) throw new SprintError("Retrospective PR changed before review.");
      const reviewCommand = async (args: string[]) => await this.run("env", [`GH_CONFIG_DIR=${join(homedir(), ".config/gh-yahaha-bot")}`, "gh", ...args]);
      const account = await reviewCommand(["api", "user", "--jq", ".login"]);
      if (account.code !== 0 || account.stdout.trim() !== "satori-miyamoto") throw new SprintError("Retrospective review requires the satori-miyamoto account.");
      const project = await this.retroCheckout(github);
      const worktrees = join(this.runtimeDir, "worktrees");
      await mkdir(worktrees, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(worktrees, `retro-review-${goalId}-`));
      const worktree = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", worktree, headSha], project);
        const result = await review(worktree);
        if (typeof result?.summary !== "string" || !Array.isArray(result.findings) || result.findings.some((item) => item.path !== retroPath(goalId)
          || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > markdown.split("\n").length || typeof item.reason !== "string" || !item.reason.trim())) throw new SprintError("Invalid retrospective review findings.");
        const current = await this.inspectRetroPr(github, goalId, markdown, prUrl);
        if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Retrospective PR changed during review.");
        if (await reconciled()) return;
        const input = join(temp, "review.json");
        await writeFile(input, JSON.stringify({ commit_id: headSha, event: result.findings.length ? "REQUEST_CHANGES" : "APPROVE",
          body: `${redactSecrets(result.summary)}\n\n${marker}`,
          comments: result.findings.map((item) => ({ path: item.path, line: item.line, side: "RIGHT", body: redactSecrets(item.reason) })),
        }), { mode: 0o600 });
        await reviewCommand(["api", endpoint + "/reviews", "--method", "POST", "--input", input]);
        // A lost response is success only when GitHub contains our submitted verdict at this head.
        if (!await reconciled()) throw new SprintError("Retrospective review delivery is not confirmed; retry reconciliation.");
      } finally {
        const removed = await this.run("git", ["worktree", "remove", "--force", worktree], project);
        if (removed.code === 0) await rm(temp, { recursive: true, force: true });
      }
    });
  }

  /** The publication adapter verifies delivery before this exact-head bot/CI gate. */
  async mergeRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string): Promise<MergeResult> {
    const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
    if (before.headSha !== headSha || !before.reviewed || !before.checksPassed) return { merged: false, reason: "The archive needs a current-head review and passing CI." };
    if (before.state === "MERGED" && before.mergedSha) return { merged: true, sha: before.mergedSha };
    if (before.state !== "OPEN") return { merged: false, reason: "The retrospective PR is closed without a merge." };
    const blocker = await this.serverMergeBlocker(prUrl, headSha);
    if (blocker) return { merged: false, reason: blocker };
    try { await this.run("gh", ["pr", "merge", prUrl, "--squash", "--match-head-commit", headSha]); }
    catch { /* Reconcile a lost response without leaving a deferred merge request. */ }
    const after = await this.inspectRetroPr(github, goalId, markdown, prUrl);
    if (after.state === "MERGED" && after.mergedSha && after.headSha === headSha && after.reviewed && after.checksPassed) return { merged: true, sha: after.mergedSha };
    return { merged: false, reason: "Retrospective merge is not verified; wait for the next workflow event." };
  }

  /**
   * Opens a PR on main that reverts `mergedSha`, made in a worktree of Indra's own project clone on branch
   * `revert/<goal-id>`. An open revert PR from an earlier call is returned instead.
   */
  async revertPr(github: string, goalId: string, mergedSha: string, title: string, body: string): Promise<string> {
    const branch = revertBranch(goalId);
    const open = (await this.must("gh", ["pr", "list", "--repo", github, "--head", branch, "--base", "main", "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""])).stdout.trim();
    if (PR_URL.test(open)) return open;
    const project = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
    const worktree = join(this.runtimeDir, "worktrees", `revert-${goalId}`);
    // Leftovers of an attempt that stopped before its PR opened; nothing else uses this branch.
    await this.run("git", ["worktree", "remove", "--force", worktree], project);
    await this.run("git", ["branch", "-D", branch], project);
    await this.run("gh", ["api", "-X", "DELETE", `repos/${github}/git/refs/heads/${branch}`]);
    try {
      await this.must("git", ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/main"], project);
      await this.must("git", ["revert", "--no-edit", mergedSha], worktree);
      await this.must("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], worktree);
      return await this.openPr(github, branch, title, body);
    } finally {
      await this.run("git", ["worktree", "remove", "--force", worktree], project);
    }
  }
}
