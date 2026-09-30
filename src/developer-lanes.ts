import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentRuntime, WriteAccess } from "./codex-runtime.js";
import type { Shell, ShellResult } from "./command-shell.js";
import { assertOwnedFilesWithin, ownedFileMatches, validateGoalBrief, type GoalBrief, type GoalLane, type GoalReport, type GoalReviewer } from "./goal-contract.js";
import { postReviewOnce, type SavedReview } from "./developer-review.js";
import type { PlanningStore } from "./planning.js";
import { ensureProjectCheckout } from "./project-checkout.js";
import { SprintGitHub } from "./sprint.js";
import { schemaPathOf } from "./reload.js";
import { redactSecrets } from "./redact.js";
import { applyLaneWorker, laneAgentSummary, laneWorkerResult, LANE_AGENT_SCHEMA, LANE_WORKER_PLAN_SCHEMA, LANE_WORKER_SCHEMA, runGoalAgent, type GoalAgentSession, type LaneAgentSummary, type LaneWorkerPlan, type LaneWorkerResult } from "./seat-runtime.js";

export interface LaneCheck { command: string; exitCode: number; headSha: string; diagnostic: string }
export interface LaneJournal {
  id: string; branch: string; worktree: string; baseSha: string; gitDir: string; prepared: boolean;
  sessions: GoalAgentSession[]; attempt: number; built: boolean; summary: LaneAgentSummary | null;
  workerRejections?: { key: string; file: string; reason: string; at: string }[];
  checks: LaneCheck[]; prUrl: string | null; headSha: string | null; mergedSha: string | null;
  fixes: string[]; fixAttempts?: { key: string; attempt: number; status: "started" | "failed" | "complete" }[]; review: SavedReview | null; reviewWorktrees: Record<string, string>; cleaned: boolean;
}
export interface LaneObservation {
  url: string; headSha: string; baseSha: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedSha: string | null;
  reviewed: boolean; reviewer?: GoalReviewer; ci: "pending" | "passed" | "failed"; ciFailure: string; conflict: boolean; files: string[];
}
export interface DeveloperLaneServices {
  plan(brief: GoalBrief, sessions: GoalAgentSession[], persist: () => Promise<void>): Promise<unknown>;
  create(lane: GoalLane, brief: GoalBrief): LaneJournal;
  build(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, persist: () => Promise<void>): Promise<void>;
  publish(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, persist: () => Promise<void>): Promise<string>;
  observe(lane: GoalLane, brief: GoalBrief, journal: LaneJournal): Promise<LaneObservation>;
  review(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, observation: LaneObservation, persist: () => Promise<void>): Promise<void>;
  fix(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, problem: string, key: string, conflictBase: string | null, persist: () => Promise<void>, retry?: boolean): Promise<void>;
  merge(url: string): Promise<{ merged: true; sha: string } | { merged: false; reason: string }>;
  finish(brief: GoalBrief, lanes: { lane: GoalLane; journal: LaneJournal }[]): Promise<{ headSha: string; checks: GoalReport["checks"]; followUps: string[] }>;
}

export class LaneError extends Error { override name = "LaneError"; }
export class LaneValidationError extends LaneError {
  constructor(readonly check: LaneCheck) { super(`Check failed: ${check.command} (exit ${check.exitCode}). ${check.diagnostic}`); }
}
const SHA = /^[0-9a-f]{40}$/;
const credential = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const commandText = (command: string, args: string[]) => [command, ...args].map(quote).join(" ");

/** `--name-status -z` includes both old and new paths for renames/copies. */
export function changedPaths(output: string): string[] {
  if (!output) return [];
  const parts = output.split("\0");
  if (parts.pop() !== "") throw new LaneError("Unterminated changed-file evidence.");
  const paths: string[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!/^(?:[AMDTUXB]|[RC]\d+)$/.test(status)) throw new LaneError("Unknown changed-file status.");
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const path = parts[index++];
      if (!path) throw new LaneError("Incomplete changed-file evidence.");
      ownedFileMatches("**", path); paths.push(path);
    }
  }
  return [...new Set(paths)];
}
export function requireLaneFiles(paths: readonly string[], lane: GoalLane, approved: readonly string[]): void {
  assertOwnedFilesWithin(lane.ownedFiles, approved);
  for (const path of paths) if (!lane.ownedFiles.some((pattern) => ownedFileMatches(pattern, path)) || !approved.some((pattern) => ownedFileMatches(pattern, path))) throw new LaneError(`Needed but unowned file: ${path}`);
}
export function laneBrief(goal: GoalBrief, lane: GoalLane, others: readonly GoalLane[], baseSha: string): GoalBrief {
  return validateGoalBrief({ ...goal, header: { ...goal.header, baseBranch: `sprint/${goal.goalId}`, baseSha, branch: lane.branch, prTarget: `sprint/${goal.goalId}` }, ownedFiles: lane.ownedFiles,
    exclusions: [...goal.exclusions, ...others.filter((item) => item.id !== lane.id).map((item) => ({ files: item.ownedFiles, owner: `lane ${item.id}`, reason: "Exclusive sibling-lane ownership" }))],
    swarm: "A lead may request read-only single-file workers. Each worker owns exactly one literal file, returns its content, and runs no checks, commits, pushes, servers or other workers. The host applies validated content and runs checks." });
}

/** All effects are finite and awaited. No watch, sleep, detached process, rebase, force push or unprotected merge. */
export class GitDeveloperLanes implements DeveloperLaneServices {
  constructor(private readonly store: PlanningStore, private readonly shell: Shell, private readonly runtimeFor: (cwd: string, write?: WriteAccess) => AgentRuntime) {}
  private async run(command: string, args: string[], cwd: string): Promise<ShellResult> { return this.shell.run(command, args, cwd); }
  private async must(command: string, args: string[], cwd: string): Promise<string> {
    const result = await this.run(command, args, cwd);
    if (result.code !== 0) throw new LaneError(`${commandText(command, args.slice(0, 2))} failed (exit ${result.code}).`);
    return result.stdout;
  }
  private async project(brief: GoalBrief): Promise<string> {
    const project = await ensureProjectCheckout(this.shell, this.store.runtimeDir, brief.header.repo, `sprint/${brief.goalId}`);
    const remote = (await this.must("git", ["remote", "get-url", "origin"], project)).trim();
    if (![ `https://github.com/${brief.header.repo}`, `https://github.com/${brief.header.repo}.git`, `git@github.com:${brief.header.repo}.git`, `ssh://git@github.com/${brief.header.repo}.git` ].includes(remote)) throw new LaneError("Project origin differs from the approved team repository.");
    return project;
  }
  private async ownedDirectory(path: string, expectedName: RegExp): Promise<void> {
    const root = join(this.store.runtimeDir, "worktrees");
    if (dirname(path) !== root || !expectedName.test(basename(path)) || !(await lstat(path)).isDirectory()
      || await realpath(path) !== join(await realpath(root), basename(path))) throw new LaneError("Worktree path is not owned by this lane.");
  }
  private async noProcesses(path: string, project: string): Promise<void> {
    const ps = await this.must("ps", ["-eo", "pid=,ppid=,args="], project);
    if (ps.split("\n").some((line) => line.includes(path))) throw new LaneError("A lane process may still be running; retain its worktree until ownership and shutdown are verified.");
  }
  private async head(project: string, ref: string): Promise<string> {
    const sha = (await this.must("git", ["rev-parse", "--verify", ref], project)).trim();
    if (!SHA.test(sha)) throw new LaneError("Git returned an invalid immutable commit.");
    return sha;
  }
  private async agent(journal: { sessions: GoalAgentSession[] }, persist: () => Promise<void>, options: Parameters<typeof runGoalAgent>[1]): Promise<unknown> {
    return runGoalAgent(this.runtimeFor, options, join(this.store.runtimeDir, "goal-agent-schemas"), journal.sessions, persist);
  }
  async plan(brief: GoalBrief, sessions: GoalAgentSession[], persist: () => Promise<void>): Promise<unknown> {
    const project = await this.project(brief);
    // Read the immutable initial sprint tree, not a user's checkout or a mutable lane.
    const directory = join(this.store.runtimeDir, "worktrees", `plan-${brief.goalId}-${hash(brief.header.baseSha).slice(0, 12)}`);
    if (!await exists(directory)) {
      await mkdir(join(this.store.runtimeDir, "worktrees"), { recursive: true, mode: 0o700 });
      await this.must("git", ["worktree", "add", "--detach", directory, brief.header.baseSha], project);
    }
    await this.ownedDirectory(directory, new RegExp(`^plan-${brief.goalId}-[0-9a-f]{12}$`));
    if ((await this.run("git", ["symbolic-ref", "--quiet", "HEAD"], directory)).code !== 1) throw new LaneError("Planning checkout is not detached.");
    const common = (await this.must("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], directory)).trim();
    if (await realpath(common) !== await realpath(join(project, ".git")) || await this.head(directory, "HEAD") !== brief.header.baseSha || (await this.must("git", ["status", "--porcelain", "--untracked-files=all"], directory)).trim()) throw new LaneError("The planning checkout is not the clean approved base.");
    if (sessions.some((session) => session.role === "planner" && session.status === "started")) throw new LaneError("Interrupted planning context requires explicit retry.");
    const key = sessions.find((session) => session.role === "planner" && session.status === "complete")?.key ?? `plan:${sessions.length}`;
    const result = await this.agent({ sessions }, persist, { key, role: "planner", brief, cwd: directory, schema: schemaPathOf(import.meta.url, "lane-plan.json"), instruction: `Return a LanePlan for this entire approved goal. Read AGENTS.md and current code. Every lane branch must be codex/${brief.goalId}/<lane-id>. Split independent work by files, using a shared contract lane only when necessary. The plan must cover the goal and stay inside its exact approved ownedFiles. Do not edit, run checks, commit, push or create PRs.` });
    await this.noProcesses(directory, project);
    await this.must("git", ["worktree", "remove", directory], project);
    return result;
  }
  create(lane: GoalLane, brief: GoalBrief): LaneJournal {
    return { id: lane.id, branch: lane.branch, worktree: join(this.store.runtimeDir, "worktrees", `${brief.goalId}-${lane.id}-${randomUUID()}`), baseSha: "", gitDir: "", prepared: false, sessions: [], attempt: 0, built: false, summary: null, checks: [], prUrl: null, headSha: null, mergedSha: null, fixes: [], review: null, reviewWorktrees: {}, cleaned: false };
  }
  private async verifyWorkspace(journal: LaneJournal, project: string): Promise<void> {
    const identity = /^codex\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(journal.branch);
    if (!identity || identity[2] !== journal.id) throw new LaneError("Lane branch identity is invalid.");
    await this.ownedDirectory(journal.worktree, new RegExp(`^${identity[1]}-${journal.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
    const common = (await this.must("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], journal.worktree)).trim();
    const top = (await this.must("git", ["rev-parse", "--show-toplevel"], journal.worktree)).trim();
    const branch = (await this.must("git", ["symbolic-ref", "--quiet", "HEAD"], journal.worktree)).trim();
    if (await realpath(common) !== await realpath(join(project, ".git")) || await realpath(top) !== await realpath(journal.worktree) || branch !== `refs/heads/${journal.branch}` || await realpath(common) !== await realpath(journal.gitDir)) throw new LaneError("The lane does not own this worktree and Git branch.");
  }
  private async paths(journal: LaneJournal): Promise<string[]> {
    const tracked = changedPaths(await this.must("git", ["diff", "--name-status", "-z", "-M", journal.baseSha, "--"], journal.worktree));
    const untracked = (await this.must("git", ["ls-files", "--others", "--exclude-standard", "-z"], journal.worktree)).split("\0").filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  }
  async build(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, persist: () => Promise<void>): Promise<void> {
    const project = await this.project(brief);
    if (!journal.prepared) {
      if (!journal.baseSha) {
        journal.baseSha = await this.head(project, `refs/remotes/origin/sprint/${brief.goalId}`);
        journal.gitDir = await realpath(join(project, ".git")); await persist();
      }
      if (!await exists(journal.worktree)) await this.must("git", ["worktree", "add", "--no-track", "-b", lane.branch, journal.worktree, journal.baseSha], project);
      await this.verifyWorkspace(journal, project); journal.prepared = true; await persist();
    }
    await this.verifyWorkspace(journal, project);
    await this.noProcesses(journal.worktree, project);
    if (journal.built) return;
    const scoped = { ...brief, header: { ...brief.header, baseSha: journal.baseSha } };
    const completedPlan = journal.sessions.find((session) => session.role === "lead-plan" && session.status === "complete");
    const leadStarted = journal.sessions.some((session) => session.role === "lead");
    const plan = await this.agent(journal, persist, { key: completedPlan?.key ?? `workers:${journal.attempt}`, role: "lead-plan", brief: scoped, cwd: journal.worktree, schema: LANE_WORKER_PLAN_SCHEMA,
      instruction: "You lead this lane. Return a plan of independent single-file worker tasks (zero is allowed when work cannot usefully split). Each worker file is a literal repository-relative owned path, once only. The lead owns remaining work and integration. Read only: do not edit, run checks, commit or push." }) as LaneWorkerPlan;
    if (!plan || !Array.isArray(plan.workers) || plan.workers.length > 32 || new Set(plan.workers.map((item) => item.file)).size !== plan.workers.length || ![plan.decisions, plan.followUps].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))) throw new LaneError("Invalid single-file worker plan.");
    for (const worker of plan.workers) {
      if (typeof worker.file !== "string" || typeof worker.task !== "string" || !worker.task.trim()) throw new LaneError("Invalid worker ownership.");
      requireLaneFiles([worker.file], lane, brief.ownedFiles);
    }
    const results = await Promise.allSettled(plan.workers.map(async (worker) => {
      const workerBrief = { ...scoped, ownedFiles: [worker.file], exclusions: [...scoped.exclusions, ...plan.workers.filter((other) => other.file !== worker.file).map((other) => ({ files: [other.file], owner: `worker ${other.file}`, reason: "One file per worker" }))] };
      const siblings = plan.workers.filter((other) => other.file !== worker.file);
      const validate = (value: unknown) => {
        const response = laneWorkerResult(value);
        if (response.neededButUnowned.length) throw new LaneError(`Needed but unowned files: ${response.neededButUnowned.join(", ")}`);
        for (const dependency of response.siblingDependencies) if (!siblings.some((other) => other.file === dependency.file)) throw new LaneError(`Sibling dependency is not assigned to another worker: ${dependency.file}`);
        return response;
      };
      const reject = async (key: string, error: unknown) => {
        const reason = redactSecrets(error instanceof Error ? error.message : "Invalid worker handoff.").slice(0, 1000);
        if (!journal.workerRejections?.some((item) => item.key === key)) { (journal.workerRejections ??= []).push({ key, file: worker.file, reason, at: new Date().toISOString() }); await persist(); }
        return new LaneError(`Worker ${worker.file} handoff rejected: ${reason} Explicit retry is required for a fresh response.`);
      };
      let completedWorker: GoalAgentSession | undefined;
      for (const session of [...journal.sessions].reverse().filter((item) => item.role === "worker" && item.status === "complete" && /^worker:\d+:/.test(item.key) && item.key.replace(/^worker:\d+:/, "") === worker.file)) {
        if (journal.workerRejections?.some((item) => item.key === session.key)) continue;
        try { validate(session.result?.response); completedWorker = session; break; }
        catch (error) { await reject(session.key, error); }
      }
      if (leadStarted && !completedWorker) throw new LaneError(`Interrupted lead is missing accepted worker provenance for ${worker.file}; its draft is preserved.`);
      const key = completedWorker?.key ?? `worker:${journal.attempt}:${worker.file}`;
      const rejection = journal.workerRejections?.find((item) => item.key === key);
      if (rejection) throw await reject(key, new LaneError(rejection.reason));
      const priorRejection = [...(journal.workerRejections ?? [])].reverse().find((item) => item.file === worker.file);
      const value = await this.agent(journal, persist, { key, role: "worker", brief: workerBrief, cwd: journal.worktree, schema: LANE_WORKER_SCHEMA,
        instruction: `Own exactly ${worker.file}. Task: ${worker.task}. Your actual runtime is read-only. Return the complete final file in content (null to delete), with decisions/followUps/neededButUnowned and siblingDependencies. Named sibling assignments: ${JSON.stringify(siblings)}. Earlier handoff rejection: ${priorRejection?.reason ?? "None"}. For an interface or behavior expected from a named sibling, return {file, requirement} in siblingDependencies using its exact file path; the lead reconciles all worker outputs together. This does not grant permission to edit that file. Use neededButUnowned only for blocking requests outside these named assignments. Do not wait for siblings. Never edit another file or run checks, commits, pushes, servers or other workers. Do not claim delivery or merge; the host validates/applies this one file.` });
      let response: LaneWorkerResult;
      try { response = validate(value); } catch (error) { throw await reject(key, error); }
      return { file: worker.file, response };
    }));
    // Never release the goal lock while a started sibling can still finish or persist its result.
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const workers = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    // A prior lead may have refined these files before interruption; replay provenance, not stale contents.
    if (!leadStarted) for (const worker of workers) await applyLaneWorker(journal.worktree, worker.file, worker.response.content);
    requireLaneFiles(await this.paths(journal), lane, brief.ownedFiles);
    const response = await this.agent(journal, persist, { key: `lead:${journal.attempt}`, role: "lead", brief: scoped, cwd: journal.worktree, write: { extraDirs: [journal.gitDir] }, schema: LANE_AGENT_SCHEMA,
      instruction: `Finish this lane's owned outcomes and integrate the workers' existing changes. Reconcile these structured worker dependencies inside the lane's owned scope: ${JSON.stringify(workers.map((worker) => ({ file: worker.file, siblingDependencies: worker.response.siblingDependencies })))}. Preserve any draft changes from interrupted earlier turns; do not discard or overwrite them blindly. You are the lead, with exclusive ownership only of the listed files. Add meaningful regression tests for changed behavior. Do not run checks, commit, push, create/merge PRs or spawn workers: the host runs the final targeted checks once and owns Git/PR operations. Return summary, all decisions/followUps and any neededButUnowned files. Stop every process you start.` });
    const summary = laneAgentSummary(response);
    journal.summary = { ...summary, decisions: [...plan.decisions, ...workers.flatMap((item) => item.response.decisions), ...summary.decisions], followUps: [...plan.followUps, ...workers.flatMap((item) => item.response.followUps), ...summary.followUps] };
    requireLaneFiles(await this.paths(journal), lane, brief.ownedFiles);
    if (summary.neededButUnowned.length) throw new LaneError(`Needed but unowned files: ${summary.neededButUnowned.join(", ")}`);
    journal.built = true; await persist();
  }
  private async check(journal: LaneJournal, command: string, args: string[], headSha: string, persist: () => Promise<void>, repairable = false): Promise<void> {
    const text = commandText(command, args);
    const saved = journal.checks.find((item) => item.headSha === headSha && item.command === text);
    let check: LaneCheck;
    if (saved) check = saved;
    else {
      const result = await this.run(command, args, journal.worktree);
      check = { command: text, exitCode: result.code, headSha, diagnostic: redactSecrets(`${result.stdout}\n${result.stderr}`).slice(-20_000) };
      journal.checks.push(check); await persist();
    }
    if (check.exitCode !== 0) {
      if (repairable && check.exitCode > 0 && check.exitCode < 128) throw new LaneValidationError(check);
      throw new LaneError(`Check failed: ${text} (exit ${check.exitCode}). ${check.diagnostic}`);
    }
  }
  async publish(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, persist: () => Promise<void>): Promise<string> {
    const project = await this.project(brief); await this.verifyWorkspace(journal, project);
    const paths = await this.paths(journal); requireLaneFiles(paths, lane, brief.ownedFiles);
    if (!paths.length) throw new LaneError("Lane produced no owned changes.");
    if ((await this.must("git", ["status", "--porcelain", "--untracked-files=all"], journal.worktree)).trim()) {
      await this.must("git", ["add", "--", ...paths], journal.worktree);
      requireLaneFiles(changedPaths(await this.must("git", ["diff", "--cached", "--name-status", "-z", "-M"], journal.worktree)), lane, brief.ownedFiles);
      await this.must("git", ["commit", "-m", `${brief.goalId}: ${lane.id}`], journal.worktree);
    }
    const head = await this.head(journal.worktree, "HEAD");
    await this.check(journal, "npm", ["ci"], head, persist);
    await this.check(journal, "npm", ["run", "typecheck"], head, persist, true);
    const tests = (await Promise.all(paths.filter((path) => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)).map(async (path) => await exists(join(journal.worktree, path)) ? path : null))).filter((path): path is string => path !== null).sort();
    if (tests.length) await this.check(journal, "env", ["NODE_OPTIONS=--experimental-ffi", "npx", "vitest", "run", ...tests], head, persist, true);
    if (await this.head(journal.worktree, "HEAD") !== head || (await this.must("git", ["status", "--porcelain", "--untracked-files=all"], journal.worktree)).trim()) throw new LaneError("Checks changed the lane checkout; no unverified head may be pushed.");
    journal.headSha = head; await persist();
    await this.must("git", [...credential, "push", "-u", "origin", `HEAD:refs/heads/${lane.branch}`], journal.worktree);
    const bodyFile = join(this.store.runtimeDir, `lane-pr-${brief.goalId}-${lane.id}.md`);
    const summary = journal.summary!;
    await writeFile(bodyFile, `${redactSecrets(summary.summary)}\n\n## Decisions\n${summary.decisions.map((item) => `- ${redactSecrets(item)}`).join("\n") || "No additional decisions."}\n\n## Follow-ups\n${summary.followUps.map((item) => `- ${redactSecrets(item)}`).join("\n") || "None."}\n\n## Validation\n${journal.checks.filter((check) => check.headSha === head).map((check) => `- ${check.command}: exit ${check.exitCode}`).join("\n")}\n\nOwned files: ${lane.ownedFiles.join(", ")}\nGoal: ${brief.goalId}; lane: ${lane.id}; head: ${head}\n`, { mode: 0o600 });
    const found = JSON.parse(await this.must("gh", ["pr", "list", "--repo", brief.header.repo, "--head", lane.branch, "--base", `sprint/${brief.goalId}`, "--state", "all", "--json", "url"], project)) as { url: string }[];
    if (!Array.isArray(found) || found.length > 1) throw new LaneError("Ambiguous lane PR recovery.");
    let url = found[0]?.url;
    if (!url) url = (await this.must("gh", ["pr", "create", "--repo", brief.header.repo, "--head", lane.branch, "--base", `sprint/${brief.goalId}`, "--title", `${brief.goalId}: ${lane.id}`, "--body-file", bodyFile], project)).trim();
    else await this.must("gh", ["pr", "edit", url, "--body-file", bodyFile], project);
    if (!url.startsWith(`https://github.com/${brief.header.repo}/pull/`) || !/\/pull\/[1-9]\d*$/.test(url)) throw new LaneError("Unverified lane PR URL.");
    journal.prUrl = url; await persist(); return url;
  }
  async observe(lane: GoalLane, brief: GoalBrief, journal: LaneJournal): Promise<LaneObservation> {
    const project = await this.project(brief); const url = journal.prUrl;
    if (!url || !url.startsWith(`https://github.com/${brief.header.repo}/pull/`) || !/\/pull\/[1-9]\d*$/.test(url)) throw new LaneError("Lane PR identity is invalid.");
    const endpoint = `repos/${brief.header.repo}/pulls/${url.split("/").at(-1)}`;
    type PR = { html_url: string; number: number; state: string; merged: boolean; draft: boolean; merge_commit_sha: string | null; changed_files: number; mergeable: boolean | null; base: { ref: string; sha: string; repo: { full_name: string } }; head: { ref: string; sha: string; repo: { full_name: string } } };
    const read = async () => JSON.parse(await this.must("gh", ["api", endpoint, "--method", "GET"], project)) as PR;
    const pr = await read();
    if (pr.html_url !== url || pr.head?.ref !== lane.branch || pr.base?.ref !== `sprint/${brief.goalId}` || pr.base?.repo?.full_name.toLowerCase() !== brief.header.repo.toLowerCase() || pr.head?.repo?.full_name.toLowerCase() !== brief.header.repo.toLowerCase() || !SHA.test(pr.head.sha) || !SHA.test(pr.base.sha) || pr.draft || !["open", "closed"].includes(pr.state)) throw new LaneError("Actual PR project, branch, target or head differs from the lane.");
    if (journal.headSha && pr.head.sha !== journal.headSha) throw new LaneError("Lane PR head changed outside its recorded lead turn.");
    const pages = JSON.parse(await this.must("gh", ["api", `${endpoint}/files?per_page=100`, "--method", "GET", "--paginate", "--slurp"], project)) as { filename: string; previous_filename?: string }[][];
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new LaneError("Unreadable PR file evidence.");
    const files = pages.flat();
    if (files.length !== pr.changed_files || files.length > 3000) throw new LaneError("Incomplete PR changed-file evidence.");
    const paths = [...new Set(files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))]; requireLaneFiles(paths, lane, brief.ownedFiles);
    await this.must("git", [...credential, "fetch", "origin", pr.head.sha, pr.base.sha], project);
    const gitPaths = changedPaths(await this.must("git", ["diff", "--name-status", "-z", "-M", `${pr.base.sha}...${pr.head.sha}`, "--"], project));
    requireLaneFiles(gitPaths, lane, brief.ownedFiles);
    if (JSON.stringify([...gitPaths].sort()) !== JSON.stringify([...paths].sort())) throw new LaneError("Git and GitHub disagree about lane changed files.");
    const proof = await new SprintGitHub(this.shell, this.store.runtimeDir).inspectMerge(url);
    const checks = await this.run("gh", ["pr", "checks", url, "--json", "name,bucket,link"], project);
    let rows: { name: string; bucket: string; link: string }[];
    try { rows = JSON.parse(checks.stdout); } catch { throw new LaneError("Unreadable CI event evidence."); }
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.name !== "string" || !["pass", "fail", "pending", "skipping", "cancel"].includes(row.bucket))) throw new LaneError("Unknown CI evidence.");
    let ciFailure = "";
    for (const check of rows.filter((row) => row.bucket === "fail" || row.bucket === "cancel")) {
      const run = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/([1-9]\d*)(?:\/|$)/.exec(check.link);
      if (!run || !check.link.startsWith(`https://github.com/${brief.header.repo}/actions/`)) throw new LaneError("Failed CI has no verified run identity.");
      const log = await this.must("gh", ["run", "view", run[1], "--repo", brief.header.repo, "--log-failed"], project);
      ciFailure += `${check.name} (${check.link}):\n${redactSecrets(log).slice(-20_000)}\n`;
    }
    const after = await read();
    if (after.head.sha !== pr.head.sha || after.base.sha !== pr.base.sha || after.state !== pr.state || proof.headSha !== pr.head.sha) throw new LaneError("PR changed while its event was being verified.");
    const state = pr.merged ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";
    if (state === "MERGED" && (!SHA.test(pr.merge_commit_sha ?? "") || proof.mergedSha !== pr.merge_commit_sha)) throw new LaneError("Merged PR commit is not verified.");
    return { url, headSha: pr.head.sha, baseSha: pr.base.sha, state, mergedSha: pr.merge_commit_sha, reviewed: proof.reviewed, reviewer: proof.reviewer, ci: proof.checksPassed ? "passed" : ciFailure ? "failed" : "pending", ciFailure, conflict: pr.mergeable === false, files: paths };
  }
  async review(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, observation: LaneObservation, persist: () => Promise<void>): Promise<void> {
    const project = await this.project(brief);
    const head = observation.headSha;
    journal.reviewWorktrees[head] ??= join(this.store.runtimeDir, "worktrees", `review-${brief.goalId}-${lane.id}-${randomUUID()}`); await persist();
    const worktree = journal.reviewWorktrees[head];
    if (!await exists(worktree)) await this.must("git", ["worktree", "add", "--detach", worktree, head], project);
    await this.ownedDirectory(worktree, new RegExp(`^review-${brief.goalId}-${lane.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
    if ((await this.run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree)).code !== 1) throw new LaneError("Reviewer checkout is not detached.");
    if (await this.head(worktree, "HEAD") !== head || await realpath((await this.must("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)).trim()) !== await realpath(join(project, ".git")) || (await this.must("git", ["status", "--porcelain", "--untracked-files=all"], worktree)).trim()) throw new LaneError("Reviewer checkout is not the clean immutable PR head.");
    await postReviewOnce({ store: this.store, recordName: `goal-${brief.goalId}-lane-${lane.id}`, prUrl: observation.url, worktree, shell: this.shell,
      review: () => this.agent(journal, persist, { key: `review:${head}:${journal.attempt}`, role: "reviewer", brief, cwd: worktree, schema: schemaPathOf(import.meta.url, "review.json"), instruction: `You are the fresh read-only reviewer of ${observation.url} at ${head}, independent of the writer. Review its actual diff against ${observation.baseSha}. Flag only AGENTS.md review checks and correctness/regression gaps. Prior findings: ${JSON.stringify(journal.review?.findings ?? [])}. Run no tests or builds. Do not edit, commit, push, merge or post; the host records your line findings and APPROVE/REQUEST_CHANGES verdict as independent-agent and publishes an informational PR comment. Return findings as path:line: reason on changed lines, plus summary.` }),
      onReview: async (review) => { journal.review = review; await persist(); },
    });
    await this.noProcesses(worktree, project);
    await this.must("git", ["worktree", "remove", worktree], project);
  }
  async fix(lane: GoalLane, brief: GoalBrief, journal: LaneJournal, problem: string, key: string, conflictBase: string | null, persist: () => Promise<void>, retry = false): Promise<void> {
    const project = await this.project(brief); await this.verifyWorkspace(journal, project);
    if (journal.fixes.includes(key) && (!retry || journal.fixAttempts?.some((attempt) => attempt.key === key && attempt.status === "complete"))) throw new LaneError("This exact problem already received its targeted fix; only an incomplete attempt may be explicitly retried.");
    if (!journal.fixes.includes(key)) journal.fixes.push(key);
    journal.attempt++;
    const attempt = { key, attempt: journal.attempt, status: "started" as "started" | "failed" | "complete" };
    (journal.fixAttempts ??= []).push(attempt); await persist();
    try {
      if (conflictBase) {
        if (!SHA.test(conflictBase)) throw new LaneError("Invalid conflict base.");
        await this.must("git", [...credential, "fetch", "origin", conflictBase], project);
        // A failed merge is left in progress for this one conflict agent; never reset, rebase or discard work.
        await this.run("git", ["merge", "--no-edit", conflictBase], journal.worktree);
      }
      const response = await this.agent(journal, persist, { key: `fix:${key}:${journal.attempt}`, role: "fix", brief, cwd: journal.worktree, write: { extraDirs: [journal.gitDir] }, schema: LANE_AGENT_SCHEMA,
        instruction: `Resolve exactly this accepted problem:\n${redactSecrets(problem)}\n${conflictBase ? `A merge of sprint base ${conflictBase} is in progress. Resolve it and commit that merge; never rebase or force push.` : "Add a regression test that fails without the fix."} Preserve all other edits and owned boundaries. Run no checks, push, PR creation or merge; the host validates and runs the targeted checks once. Return summary, decisions, followUps and neededButUnowned.` });
      const summary = laneAgentSummary(response);
      if (summary.neededButUnowned.length) throw new LaneError(`Needed but unowned files: ${summary.neededButUnowned.join(", ")}`);
      if (conflictBase) {
        await this.must("git", ["merge-base", "--is-ancestor", conflictBase, "HEAD"], journal.worktree);
        journal.baseSha = conflictBase;
      }
      requireLaneFiles(await this.paths(journal), lane, brief.ownedFiles);
      journal.summary = { summary: summary.summary, decisions: [...journal.summary!.decisions, ...summary.decisions], followUps: [...journal.summary!.followUps, ...summary.followUps], neededButUnowned: [] };
      journal.headSha = null; journal.review = null; await persist();
      await this.publish(lane, brief, journal, persist);
      attempt.status = "complete"; await persist();
    } catch (error) {
      attempt.status = "failed"; await persist(); throw error;
    }
  }
  merge(url: string) { return new SprintGitHub(this.shell, this.store.runtimeDir).merge(url); }
  async finish(brief: GoalBrief, lanes: { lane: GoalLane; journal: LaneJournal }[]): Promise<{ headSha: string; checks: GoalReport["checks"]; followUps: string[] }> {
    const project = await this.project(brief); const headSha = await this.head(project, `refs/remotes/origin/sprint/${brief.goalId}`);
    const checks: GoalReport["checks"] = []; const followUps: string[] = [];
    for (const { lane, journal } of lanes) {
      const proof = await this.observe(lane, brief, journal);
      if (proof.state !== "MERGED" || proof.headSha !== journal.headSha || proof.mergedSha !== journal.mergedSha || !proof.reviewed || proof.ci !== "passed") throw new LaneError("Every lane must have independently verified current-head merge, bot review and CI evidence.");
      await this.must("git", ["merge-base", "--is-ancestor", proof.mergedSha!, headSha], project);
      checks.push(...journal.checks.filter((check) => check.headSha === journal.headSha).map(({ command, exitCode }) => ({ command, exitCode })));
      await this.noProcesses(journal.worktree, project);
      if (journal.cleaned || !await exists(journal.worktree)) { journal.cleaned = true; continue; }
      await this.verifyWorkspace(journal, project);
      const dirty = (await this.must("git", ["status", "--porcelain", "--untracked-files=all"], journal.worktree)).trim();
      const ignored = (await this.must("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], journal.worktree)).split("\0").filter(Boolean);
      if (dirty || ignored.some((path) => path !== "node_modules/")) { followUps.push(`Preserved lane ${lane.id} checkout with local or unknown ignored files.`); continue; }
      await this.must("git", ["diff", "--quiet", proof.mergedSha!, "HEAD", "--", ...proof.files], journal.worktree);
      const removed = await this.run("git", ["worktree", "remove", journal.worktree], project);
      if (removed.code === 0) journal.cleaned = true;
      else followUps.push(`Preserved lane ${lane.id} checkout because Git refused clean removal.`);
    }
    return { headSha, checks, followUps };
  }
}
