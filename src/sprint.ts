import { dirname, join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runChecked, stderrExcerpt, type Shell, type ShellResult } from "./command-shell.js";
import { ensureProjectCheckout } from "./project-checkout.js";
import { withFileLock } from "./state-commit.js";
import { GITHUB_REPO } from "./local-state.js";
import { redactSecrets } from "./redact.js";
import type { MergeVerification } from "./ceremony.js";
import { inspectReview, postReviewComment, reviewOnce, type ReviewRejection, type Reviewer } from "./review-evidence.js";
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
  workspace?: { dirty: string; ignored: string[] }; cleanup?: string | null;
}
export interface PrRetrospective { url: string; headSha: string; decisions: string | null; followUps: string | null }

export function retroPath(goalId: string): string {
  if (!/^[a-z][a-z0-9-]+$/.test(goalId)) throw new SprintError("Invalid retrospective goal ID.");
  return `docs/retros/${goalId}.md`;
}
export const retroBranch = (goalId: string) => { retroPath(goalId); return `retro/${goalId}`; };
export interface RetroPr {
  url: string; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; mergedSha?: string;
  /** Host-verified independent approval on this exact head, or historical delivered bot evidence. */
  reviewed: boolean; checksPassed: boolean; reviewer?: Reviewer;
  /** Validated local or historical delivered verdict rejects this exact open head. */
  rejection?: RetroRejection;
}
export type RetroRejection = ReviewRejection;
export interface RetroReview {
  summary: string;
  findings: { path: string; line: number; reason: string }[];
}
export interface RetroArchive {
  ensureRetroPr(github: string, goalId: string, markdown: string): Promise<string>;
  inspectRetroPr(github: string, goalId: string, markdown: string, prUrl: string): Promise<RetroPr>;
  /** Optional for historical adapters; updates the same PR from verified rejected bytes by a guarded fast-forward. */
  correctRetroPr?(github: string, goalId: string, previous: string, markdown: string, prUrl: string, rejection: RetroRejection): Promise<string>;
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
      if (proof.state !== "MERGED" || proof.headSha !== lane.headSha || proof.mergedSha !== lane.mergedSha || !proof.reviewed || proof.reviewer !== lane.reviewer || !proof.checksPassed || view.baseRefName !== report.sprintBranch || view.isCrossRepository !== false) throw new SprintError("Lane report is not supported by current GitHub merge, independent review and CI evidence.");
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
      const files = async (args: string[], directory = cwd) => (await this.must("git", args, directory)).stdout.split("\0").filter(Boolean);
      const verifyCheckout = async () => {
        if (!(await lstat(cwd)).isDirectory()) throw new SprintError("Integration recovery checkout is not an owned directory.");
        const common = (await this.must("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).stdout.trim();
        if (await realpath(common) !== shared || (await this.run("git", ["symbolic-ref", "-q", "HEAD"], cwd)).code !== 1) throw new SprintError("Integration recovery checkout ownership or detached identity changed.");
      };
      const verifyCommit = async (head: string, directory = cwd) => {
        const parents = (await this.must("git", ["rev-list", "--parents", "-n", "1", head], directory)).stdout.trim().split(" ");
        if (!SHA.test(head) || JSON.stringify(parents) !== JSON.stringify([head, headSha, baseSha]) || (record.resultSha && record.resultSha !== head) || !within(await files(["diff", "--name-only", "--no-renames", "-z", baseSha, head], directory))) throw new SprintError("Retained correction commit does not match its pinned history and approved scope.");
      };
      const inspectWorkspace = async () => {
        const dirty = (await this.must("git", ["status", "--porcelain", "--untracked-files=all"], cwd)).stdout;
        const ignored = await files(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
        record.workspace = { dirty, ignored }; await save();
        // These exact ignored root directories are regenerable check output; all other local artifacts remain protected.
        if (dirty.trim() || ignored.some((path) => !["node_modules/", "dist/", "coverage/"].includes(path))) throw new SprintError("Integration correction has uncommitted or unknown ignored work; retained without cleanup.");
      };
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
        if (!exists && record.phase === "preparing") await this.must("git", ["worktree", "add", "--detach", cwd, headSha], project);
        else if (!exists && record.phase === "pushed" && record.resultSha) { record.phase = "cleaned"; record.cleanup = null; } // Lost removal response; remote proof is checked below.
        else if (!exists && record.phase !== "cleaned") throw new SprintError("Integration recovery checkout is missing; retained work cannot be assumed safe.");
        if (record.phase !== "cleaned" && record.phase !== "pushed") {
          await verifyCheckout();
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
          await verifyCommit(head);
          await inspectWorkspace();
          record.resultSha = head; record.phase = "committed"; await save();
          const current = await this.integrationScope(github, goalId, ownedFiles, prUrl, revert);
          if (![headSha, head].includes(current.headSha) || current.baseSha !== baseSha) throw new SprintError("Integration changed before publication; retained correction needs reconciliation.");
          if (current.headSha !== head) await this.must("git", [...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], cwd);
        }
        const resultSha = record.resultSha;
        // A published correction can be verified from the shared repository even when its retained checkout is busy or dirty.
        if (resultSha && (record.phase === "pushed" || record.phase === "cleaned")) await verifyCommit(resultSha, project);
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
          try {
            await verifyCheckout(); await idle(); await inspectWorkspace();
            if ((await this.must("git", ["rev-parse", "HEAD"], cwd)).stdout.trim() !== resultSha) throw new SprintError("Published correction has new or uncertain work; retained without cleanup.");
            await this.must("git", ["worktree", "remove", cwd], project); // No --force; Git gets the final dirty-work veto.
            record.phase = "cleaned"; record.cleanup = null;
          } catch (error) {
            // Publication and its PR record are already verified. Cleanup cannot turn delivery into a failed correction.
            record.cleanup = error instanceof Error ? redactSecrets(error.message).slice(0, 1000) : "Integration checkout cleanup was not confirmed.";
          }
        }
        record.failure = null; await save();
        return { headSha: resultSha, decisions: [...record.decisions, ...(record.cleanup ? [`Retained published correction checkout at ${cwd}: ${record.cleanup}`] : [])] };
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

  /** A fresh read-only callback creates durable exact-head proof before optional comment delivery. */
  async reviewIntegration(github: string, goalId: string, prUrl: string, headSha: string, review: (cwd: string) => Promise<unknown>): Promise<void> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid integration review head.");
    const verify = async () => {
      const current = await this.inspectMerge(prUrl);
      if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Integration changed during review.");
    };
    const before = await this.inspectMerge(prUrl);
    if (before.headSha !== headSha || before.state !== "OPEN") throw new SprintError("Integration changed before review.");
    // Historical approvals/rejections are readable; a rejected immutable head cannot silently get a new verdict.
    if (before.reviewer === "satori-miyamoto" && (before.reviewed || before.rejection)) return;
    await reviewOnce(this.runtimeDir, prUrl, headSha, async () => {
      const details = JSON.parse((await this.must("gh", ["pr", "view", prUrl, "--json", "baseRefName,isCrossRepository"])).stdout) as { baseRefName?: string; isCrossRepository?: boolean };
      if (details.baseRefName !== "main" || details.isCrossRepository !== false) throw new SprintError("Integration review requires the project's main target.");
      const cwd = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
      await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", `refs/pull/${prUrl.split("/").at(-1)}/head`], cwd);
      const root = join(this.runtimeDir, "worktrees"); await mkdir(root, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(root, `integration-review-${goalId}-`)); const checkout = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", checkout, headSha], cwd);
        const value = await review(checkout) as RetroReview;
        const files = await this.retroPages<{ filename: string }>(`${endpoint}/files?per_page=100`);
        if (typeof value?.summary !== "string" || !Array.isArray(value.findings) || value.findings.some((finding) => !finding || !files.some((file) => file.filename === finding.path))) throw new SprintError("Invalid integration reviewer findings.");
        return value;
      } finally { if ((await this.run("git", ["worktree", "remove", "--force", checkout], cwd)).code === 0) await rm(temp, { recursive: true, force: true }); }
    }, verify, async (proof) => { await postReviewComment(this.shell, dirname(this.runtimeDir), proof); });
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
    const read = async () => {
      const response = await this.must("gh", ["pr", "view", prUrl, "--json", "state,mergeCommit,headRefOid,isDraft,author,reviewDecision"]);
      try { return JSON.parse(response.stdout) as { state: RetroPr["state"]; mergeCommit?: { oid: string }; headRefOid: string; isDraft: boolean; author: { login: string }; reviewDecision?: string }; }
      catch { throw new SprintError("Unreadable sprint PR details."); }
    };
    const before = await read();
    if (!SHA.test(before.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(before.state) || !before.author?.login || typeof before.isDraft !== "boolean") throw new SprintError("Unverified sprint PR head or author.");
    const review = await inspectReview(this.runtimeDir, this.shell, dirname(this.runtimeDir), prUrl, before.headRefOid, before.author.login, before.reviewDecision);
    const checks = await this.run("gh", ["pr", "checks", prUrl, "--json", "name,bucket"]);
    let checksPassed = false;
    try {
      const rows = JSON.parse(checks.stdout) as { name: string; bucket: string }[];
      checksPassed = checks.code === 0 && Array.isArray(rows) && rows.some((row) => row?.name === "checks") && rows.every((row) => typeof row?.name === "string" && !!row.name && row.bucket === "pass");
    } catch { /* Missing check evidence is pending. */ }
    if (JSON.stringify(before) !== JSON.stringify(await read())) throw new SprintError("Sprint PR changed during verification.");
    return { url: prUrl, state: before.state, headSha: before.headRefOid, reviewed: !before.isDraft && review.reviewed, reviewer: review.reviewer, checksPassed,
      ...(before.state === "OPEN" && !before.isDraft && review.rejection ? { rejection: review.rejection } : {}),
      ...(SHA.test(before.mergeCommit?.oid ?? "") ? { mergedSha: before.mergeCommit!.oid } : {}) };
  }

  /** Current-head independent approval and green CI gate release; a request alone never proves a merge. */
  async merge(prUrl: string, beforeMutation?: (headSha: string) => Promise<void>): Promise<MergeResult> {
    const before = await this.inspectMerge(prUrl);
    if (!before.reviewed || !before.checksPassed) return { merged: false, reason: `Current-head independent approval and passing CI are required on ${prUrl}` };
    if (before.state === "MERGED" && before.mergedSha) return { merged: true, sha: before.mergedSha };
    if (before.state !== "OPEN") return { merged: false, reason: `${prUrl} is ${before.state.toLowerCase()}` };
    await beforeMutation?.(before.headSha);
    // The host has verified its exact-head proof and CI; the SHA precondition pins this attempt.
    // Never arm deferred auto-merge, which can outlive this process and its inspected head.
    try { await this.run("gh", ["pr", "merge", prUrl, "--squash", "--match-head-commit", before.headSha]); }
    catch { /* A lost command response is reconciled from GitHub below. */ }
    const after = await this.inspectMerge(prUrl);
    if (after.state === "MERGED" && after.mergedSha && after.headSha === before.headSha && after.reviewed && after.checksPassed) return { merged: true, sha: after.mergedSha };
    return { merged: false, reason: "Merge is not verified; wait for the next workflow event." };
  }

  async mergeVerification(prUrl: string): Promise<MergeVerification | undefined> {
    const proof = await this.inspectMerge(prUrl);
    return proof.state === "MERGED" && proof.mergedSha && proof.reviewed && proof.checksPassed
      ? { headSha: proof.headSha, reviewCommitSha: proof.headSha, reviewer: proof.reviewer!, checksPassed: true } : undefined;
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
        await writeFile(body, `Archives the frozen retrospective for ${goalId} in ${path}.\n\nOnly this document may change. Requires a fresh independent review on the current head, passing CI. No further human approval is needed. Process suggestions are owner proposals only.\n`, { mode: 0o600 });
        const created = await this.run("gh", ["pr", "create", "--repo", github, "--base", "main", "--head", branch, "--title", `Archive retrospective for ${goalId}`, "--body-file", body]);
        const recovered = await this.findRetroPr(github, goalId);
        if (recovered) return recovered;
        throw new SprintError(created.code === 0 ? "Retrospective PR is not visible yet; retry reconciliation." : "Retrospective PR creation was not confirmed; retry reconciliation.");
      } finally { await rm(temp, { recursive: true, force: true }); }
    });
  }

  /** Retain the exact correction commit before pushing; replay reconciles only that commit, never arbitrary matching bytes. */
  async correctRetroPr(github: string, goalId: string, previous: string, markdown: string, prUrl: string, rejection: RetroRejection): Promise<string> {
    this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(rejection.headSha) || !(typeof rejection.reviewId === "number" ? Number.isSafeInteger(rejection.reviewId) && rejection.reviewId > 0 : /^agent:[0-9a-f]{64}$/.test(rejection.reviewId)) || !Number.isFinite(Date.parse(rejection.submittedAt))
      || !markdown.trim() || markdown === previous) throw new SprintError("A correction needs a verified rejection and changed frozen content.");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const identity = { version: 1, github, goalId, prUrl, rejection, previous: hash(previous), markdown: hash(markdown) };
    const key = hash(JSON.stringify(identity)); const file = join(this.runtimeDir, `retro-correction-${goalId}-${key}.json`);
    return await withFileLock(join(this.runtimeDir, `retro-git-${goalId}.lock`), async () => {
      const project = await this.retroCheckout(github); const branch = retroBranch(goalId); const path = retroPath(goalId);
      const saved = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      const record = saved ? JSON.parse(saved) as typeof identity & { resultSha: string | null } : { ...identity, resultSha: null as string | null };
      if (Object.entries(identity).some(([key, value]) => JSON.stringify(record[key as keyof typeof identity]) !== JSON.stringify(value))
        || (record.resultSha !== null && !SHA.test(record.resultSha))) throw new SprintError("Retrospective correction journal identity is unverified.");
      const verifyCommit = async (head: string) => {
        const parents = (await this.must("git", ["rev-list", "--parents", "-n", "1", head], project)).stdout.trim().split(" ");
        if (JSON.stringify(parents) !== JSON.stringify([head, rejection.headSha]) || (await this.must("git", ["show", `${rejection.headSha}:${path}`], project)).stdout !== previous) throw new SprintError("Correction ancestry or superseded bytes changed.");
        await this.retroTree(project, rejection.headSha, head, path, markdown);
      };
      const head = await this.retroDetails(prUrl);
      if (record.resultSha && head.headRefOid === record.resultSha) {
        const published = await this.inspectRetroPr(github, goalId, markdown, prUrl);
        await verifyCommit(record.resultSha);
        if (published.headSha !== record.resultSha || published.state === "CLOSED") throw new SprintError("The corrected archive changed or closed before reconciliation.");
        return record.resultSha;
      }
      if (head.headRefOid !== rejection.headSha) throw new SprintError("The archive head moved outside this correction; preserve both revisions and reconcile it.");
      const verifyRejected = async () => {
        const proof = await this.inspectRetroPr(github, goalId, previous, prUrl);
        if (proof.state !== "OPEN" || proof.headSha !== rejection.headSha || JSON.stringify(proof.rejection) !== JSON.stringify(rejection)) throw new SprintError("Correction requires the same verified review rejection on the open archive head.");
      };
      await verifyRejected();
      // A command-local guard must not hide a configured or default repository hook.
      const configured = await this.run("git", ["config", "--get", "core.hooksPath"], project);
      if (configured.code !== 1) throw new SprintError("An existing hooks configuration requires owner reconciliation before archival correction.");
      const hookPath = (await this.must("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], project)).stdout.trim();
      const hook = await lstat(hookPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (hook) throw new SprintError("An existing pre-push hook requires owner reconciliation before archival correction.");
      const worktrees = join(this.runtimeDir, "worktrees"); await mkdir(worktrees, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(worktrees, `retro-correction-${goalId}-`)); const worktree = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", worktree, record.resultSha ?? rejection.headSha], project);
        if (!record.resultSha) {
          const document = join(worktree, path);
          if (!(await lstat(document)).isFile() || await readFile(document, "utf8") !== previous) throw new SprintError("The correction checkout does not contain the expected regular document.");
          await writeFile(document, markdown);
          await this.must("git", ["add", "--", path], worktree);
          await this.must("git", ["commit", "--only", "-m", `Correct retrospective for ${goalId}`, "--", path], worktree);
          record.resultSha = (await this.must("git", ["rev-parse", "HEAD"], worktree)).stdout.trim();
          await verifyCommit(record.resultSha);
          const pending = `${file}.${process.pid}.tmp`; await writeFile(pending, JSON.stringify(record), { mode: 0o600 }); await rename(pending, file);
        } else await verifyCommit(record.resultSha);
        await verifyRejected();
        const hooks = join(temp, "hooks"); await mkdir(hooks, { mode: 0o700 });
        // Git supplies its advertised remote SHA to pre-push, then checks that same SHA under the remote ref lock.
        // This is a normal non-forced push, with an extra expected-old-head condition and no shared config mutation.
        await writeFile(join(hooks, "pre-push"), `#!/bin/sh\nread -r local_ref local_sha remote_ref remote_sha || exit 1\n[ "$local_sha" = "${record.resultSha}" ] && [ "$remote_ref" = "refs/heads/${branch}" ] && [ "$remote_sha" = "${rejection.headSha}" ] || exit 1\nif read -r extra; then exit 1; fi\n`, { mode: 0o700 });
        try { await this.run("git", ["-c", `core.hooksPath=${hooks}`, ...GH_CREDENTIAL, "push", "origin", `HEAD:refs/heads/${branch}`], worktree); }
        catch { /* A lost push response is reconciled against the journaled commit below. */ }
        const after = await this.inspectRetroPr(github, goalId, markdown, prUrl);
        if (after.headSha !== record.resultSha || after.state === "CLOSED") throw new SprintError("The correction push is unconfirmed or the archive head moved; retry reconciliation.");
        await verifyCommit(after.headSha);
        return after.headSha;
      } finally {
        // Unknown hook output or uncommitted work remains recoverable; never force-remove it.
        const removed = await this.run("git", ["worktree", "remove", worktree], project);
        if (removed.code === 0) await rm(temp, { recursive: true, force: true });
      }
    });
  }

  private async retroDetails(prUrl: string) {
    const result = await this.run("gh", ["pr", "view", prUrl, "--json", "state,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,author,mergeCommit,reviewDecision"]);
    if (result.code !== 0) throw new SprintError("Could not inspect the retrospective PR.");
    try { return JSON.parse(result.stdout) as { state: RetroPr["state"]; headRefName: string; baseRefName: string; headRefOid: string; isCrossRepository: boolean; isDraft: boolean; author: { login: string }; mergeCommit?: { oid: string }; reviewDecision?: string }; }
    catch { throw new SprintError("Invalid retrospective PR details."); }
  }

  /** Check the exact PR head, every changed path, document bytes, review and CI again, even after a restart. */
  async inspectRetroPr(github: string, goalId: string, markdown: string, prUrl: string): Promise<RetroPr> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    const read = async () => await this.retroDetails(prUrl);
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
    const review = await inspectReview(this.runtimeDir, this.shell, dirname(this.runtimeDir), prUrl, pr.headRefOid, pr.author.login, pr.reviewDecision);
    const checks = await this.run("gh", ["pr", "checks", prUrl, "--json", "name,bucket"]);
    let checksPassed = false;
    try {
      const rows = JSON.parse(checks.stdout) as { name: string; bucket: string }[];
      checksPassed = checks.code === 0 && Array.isArray(rows) && rows.some((row) => row?.name === "checks") && rows.every((row) => typeof row?.name === "string" && !!row.name && row.bucket === "pass");
    } catch { /* Missing/unreadable CI is pending. */ }
    const after = await read();
    if (JSON.stringify(after) !== JSON.stringify(pr)) throw new SprintError("Retrospective PR changed during verification; retry.");
    return { url: prUrl, state: pr.state, headSha: pr.headRefOid, mergedSha: pr.mergeCommit?.oid, reviewed: review.reviewed && !pr.isDraft, reviewer: review.reviewer, checksPassed,
      ...(pr.state === "OPEN" && !pr.isDraft && review.rejection ? { rejection: review.rejection } : {}) };
  }

  /** A fresh read-only reviewer sees the pinned checkout; the host owns the resulting proof. */
  async reviewRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string, review: (worktree: string) => Promise<RetroReview>): Promise<void> {
    this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid retrospective review head.");
    const verify = async () => {
      const current = await this.inspectRetroPr(github, goalId, markdown, prUrl);
      if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Retrospective PR changed during review.");
    };
    const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
    if (before.headSha !== headSha || before.state !== "OPEN") throw new SprintError("Retrospective PR changed before review.");
    if (before.reviewer === "satori-miyamoto" && (before.reviewed || before.rejection)) return;
    await reviewOnce(this.runtimeDir, prUrl, headSha, async () => {
      const project = await this.retroCheckout(github);
      const worktrees = join(this.runtimeDir, "worktrees"); await mkdir(worktrees, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(worktrees, `retro-review-${goalId}-`)); const worktree = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", worktree, headSha], project);
        const result = await review(worktree);
        if (typeof result?.summary !== "string" || !Array.isArray(result.findings) || result.findings.some((item) => !item || item.path !== retroPath(goalId)
          || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > markdown.split("\n").length || typeof item.reason !== "string" || !item.reason.trim())) throw new SprintError("Invalid retrospective review findings.");
        return result;
      } finally {
        if ((await this.run("git", ["worktree", "remove", "--force", worktree], project)).code === 0) await rm(temp, { recursive: true, force: true });
      }
    }, verify, async (proof) => { await postReviewComment(this.shell, dirname(this.runtimeDir), proof); });
  }

  /** The publication adapter verifies delivery before this exact-head review/CI gate. */
  async mergeRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string): Promise<MergeResult> {
    const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
    if (before.headSha !== headSha || !before.reviewed || !before.checksPassed) return { merged: false, reason: "The archive needs a current-head review and passing CI." };
    if (before.state === "MERGED" && before.mergedSha) return { merged: true, sha: before.mergedSha };
    if (before.state !== "OPEN") return { merged: false, reason: "The retrospective PR is closed without a merge." };
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
