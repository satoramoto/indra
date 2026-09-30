import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SeatTaskRecord, Shell } from "./developer-seat.js";
import { teamProject, type PlanningAssignment, type PlanningGoal, type PlanningStore } from "./planning.js";
import { ImplementationRecorder } from "./implementation-facts.js";
import { projectCheckoutPath } from "./project-checkout.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STEPS = ["worktree", "build", "review", "fix", "ci", "done"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const seatRecordName = (seatId: string, goalId: string, outcomeId: string) => `seat-${seatId}-${goalId}-${outcomeId}`;

/** Identity checks do not require a checkout: merged PRs often outlive their worktrees. */
export function ownsSeatRecord(runtimeDir: string, seatId: string, goalId: string, outcomeId: string, value: unknown): value is SeatTaskRecord {
  if (!object(value) || value.goalId !== goalId || value.outcomeId !== outcomeId || typeof value.branch !== "string") return false;
  const branch = `${seatId}/${goalId}-${outcomeId}`;
  if (!value.branch.startsWith(branch)) return false;
  const suffix = value.branch.slice(branch.length);
  return (!suffix || (suffix.startsWith("-attempt-") && UUID.test(suffix.slice(9))))
    && value.worktree === join(runtimeDir, "worktrees", `${goalId}-${outcomeId}${suffix}`)
    && STEPS.includes(value.step as string) && Array.isArray(value.sessions);
}

interface RecordFile { path: string; text: string; value: unknown; dev: number; ino: number; mtimeMs: number; ctimeMs: number }

/** Never follow a symlink or remove a hard-linked/otherwise uncertain runtime record. */
function readRecord(path: string): RecordFile | undefined {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return;
    const text = readFileSync(fd, "utf8");
    return { path, text, value: JSON.parse(text), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function unchanged(file: RecordFile): boolean {
  const now = readRecord(file.path);
  return !!now && now.dev === file.dev && now.ino === file.ino && now.mtimeMs === file.mtimeMs && now.ctimeMs === file.ctimeMs && now.text === file.text;
}

function records(store: PlanningStore, name: string): { primary?: RecordFile; primaryExists: boolean; archives: RecordFile[] } {
  try {
    if (!lstatSync(store.runtimeDir).isDirectory()) return { primaryExists: true, archives: [] };
    const files = readdirSync(store.runtimeDir).sort();
    const prefix = `${name}-retained-`;
    const archives = files.filter((file) => file.startsWith(prefix) && file.endsWith(".json") && UUID.test(file.slice(prefix.length, -5)))
      .flatMap((file) => { const record = readRecord(join(store.runtimeDir, file)); return record ? [record] : []; });
    return { primary: readRecord(join(store.runtimeDir, `${name}.json`)), primaryExists: files.includes(`${name}.json`), archives };
  } catch (error) { return { primaryExists: (error as NodeJS.ErrnoException).code !== "ENOENT", archives: [] }; }
}

/** Repeated attempts need only one identical archive, including metadata we cannot interpret. */
export async function retainSeatRecord(store: PlanningStore, name: string, value: object): Promise<void> {
  if (records(store, name).archives.some((file) => isDeepStrictEqual(file.value, value))) return;
  await store.saveRuntime(`${name}-retained-${randomUUID()}`, value);
}

/** Unknown fields may carry unique recovery data. They are never eligible for retirement. */
function knownRecord(store: PlanningStore, seatId: string, goal: PlanningGoal, assignment: PlanningAssignment, github: string, value: unknown): value is SeatTaskRecord {
  if (!ownsSeatRecord(store.runtimeDir, seatId, goal.id, assignment.outcomeId, value)) return false;
  const keys = ["goalId", "outcomeId", "step", "branch", "worktree", "gitDir", "prUrl", "retainedPrUrl", "findings", "conflictRounds", "reviewFixRounds", "attemptId", "sessions"];
  if (Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (value.gitDir !== undefined && value.gitDir !== join(projectCheckoutPath(store.runtimeDir, github), ".git")) return false;
  if ([value.prUrl, value.retainedPrUrl].some((url) => url !== undefined && typeof url !== "string")) return false;
  if (value.findings !== undefined && (!Array.isArray(value.findings) || value.findings.some((item) => typeof item !== "string"))) return false;
  if (value.attemptId !== undefined && (typeof value.attemptId !== "string" || !UUID.test(value.attemptId))) return false;
  if (value.reviewFixRounds !== undefined && (!Number.isInteger(value.reviewFixRounds) || value.reviewFixRounds < 0)) return false;
  if (value.conflictRounds !== undefined && (!Number.isInteger(value.conflictRounds) || value.conflictRounds < 0)) return false;
  return value.sessions.every((session) => object(session) && Object.keys(session).every((key) => ["role", "sessionId", "startedAt", "finishedAt", "usage"].includes(key))
    && ["developer", "reviewer", "fix"].includes(session.role) && [session.sessionId, session.startedAt, session.finishedAt].every((text) => typeof text === "string"));
}

/** The primary history must retain every piece of the archive's information. */
function superseded(archive: SeatTaskRecord, primary: SeatTaskRecord): boolean {
  return ["goalId", "outcomeId", "branch", "worktree", "prUrl", "gitDir", "retainedPrUrl", "findings", "attemptId"].every((key) => {
    const field = key as keyof SeatTaskRecord;
    return archive[field] === undefined || isDeepStrictEqual(archive[field], primary[field]);
  }) && (archive.reviewFixRounds ?? 0) <= (primary.reviewFixRounds ?? 0)
    && (archive.conflictRounds ?? 0) <= (primary.conflictRounds ?? 0)
    && archive.sessions.every((session, index) => isDeepStrictEqual(session, primary.sessions[index]));
}

function verifiedMerged(value: unknown, github: string, prUrl: string, number: number, base: string, branch: string): boolean {
  if (!object(value) || !object(value.base) || !object(value.head)) return false;
  const repo = (ref: Record<string, unknown>) => object(ref.repo) && ref.repo.full_name === github;
  return value.html_url === prUrl && value.number === number && value.state === "closed" && value.merged === true
    && typeof value.merged_at === "string" && !Number.isNaN(Date.parse(value.merged_at))
    && repo(value.base) && repo(value.head) && value.base.ref === base && value.head.ref === branch;
}

/**
 * Read-only GitHub reconciliation and local metadata retirement, never work execution or Git cleanup.
 * The runner owns this pass; verified merged results consume its tick even if persistence must retry.
 */
export async function maintainDeveloperSeat(store: PlanningStore, seatId: string, shell: Shell, log: (line: string) => void = () => {}): Promise<boolean> {
  let handled = false;
  const state = await store.read();
  for (const goal of state.planningGoals ?? []) {
    if (goal.workflowModel === "goals-v1" || goal.ceremony?.closure || goal.stage !== "approved") continue;
    const github = teamProject(state, goal.teamId);
    if (!github || !/^[\w.-]+\/[\w.-]+$/.test(github)) continue;
    for (const assignment of goal.assignments ?? []) {
      if (assignment.seatId !== seatId || !["failed", "merged"].includes(assignment.status)) continue;
      const name = seatRecordName(seatId, goal.id, assignment.outcomeId);
      const saved = records(store, name);
      const known = (file: RecordFile) => knownRecord(store, seatId, goal, assignment, github, file.value);
      const archives = saved.archives.filter(known);
      const primary = saved.primary && known(saved.primary) ? saved.primary : undefined;
      let expected = structuredClone(goal);
      const matches = (current: PlanningGoal | undefined, repository: string | undefined) => repository === github && isDeepStrictEqual(current, expected);
      try {
        const facts = new ImplementationRecorder(store, seatId, goal.id, assignment.outcomeId);
        // Persist interpreted facts before any archive can be retired, even after release or worktree removal.
        for (const file of [...archives, ...(primary ? [primary] : [])]) await facts.retain(file.value as SeatTaskRecord);
        if (primary) {
          const id = await facts.recover(primary.value as SeatTaskRecord);
          await facts.finish(id, assignment.status as "failed" | "merged", assignment.updatedAt);
        }
        if (assignment.status === "failed" && assignment.prUrl) {
          // An existing but unusable primary is not permission to revive a different attempt.
          const candidates = primary ? [primary] : saved.primaryExists ? [] : archives;
          const matching = candidates.filter((file) => (file.value as SeatTaskRecord).prUrl === assignment.prUrl);
          const record = matching[0];
          const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(assignment.prUrl);
          if (record && url?.[1] === github && matching.every((file) => (file.value as SeatTaskRecord).branch === (record.value as SeatTaskRecord).branch)) {
            const result = await shell.run("gh", ["api", `repos/${github}/pulls/${url[2]}`, "--method", "GET"], store.checkout);
            if (result.code === 0 && verifiedMerged(JSON.parse(result.stdout), github, assignment.prUrl, Number(url[2]), goal.integration?.branch ?? "", (record.value as SeatTaskRecord).branch)) {
              // Even a refused/pending persistence attempt must not fall through to execution this tick.
              handled = true;
              let changed = false;
              await store.update((current) => {
                const targetGoal = current.planningGoals?.find((item) => item.id === goal.id);
                if (!matches(targetGoal, teamProject(current, goal.teamId)) || !unchanged(record)) return;
                // Also refuse a new/replaced primary while the GitHub read was in flight.
                const now = records(store, name);
                if (saved.primary ? !unchanged(saved.primary) : now.primaryExists) return;
                const target = targetGoal!.assignments!.find((item) => item.outcomeId === assignment.outcomeId)!;
                target.status = "merged";
                target.updatedAt = new Date().toISOString();
                delete target.note;
                expected = structuredClone(targetGoal!);
                changed = true;
              }, `Seat ${seatId} reconciles ${goal.id}/${assignment.outcomeId}: merged`);
              if (changed) {
                const id = await facts.recover(record.value as SeatTaskRecord);
                await facts.event(id, { kind: "merge", result: "recovered", prUrl: assignment.prUrl }, `reconciled:${assignment.prUrl}`);
              }
              if (changed) log(`Reconciled ${goal.id}/${assignment.outcomeId} as merged.`);
            }
          }
        }
        if (!archives.length) continue;
        // update is a durability barrier: it recovers pending commits and refuses dirty state.
        // Synchronous file checks/removals stay inside its lock, excluding assignment replacement.
        await store.update((current) => {
          const targetGoal = current.planningGoals?.find((item) => item.id === goal.id);
          if (!matches(targetGoal, teamProject(current, goal.teamId))) return;
          const target = targetGoal!.assignments!.find((item) => item.outcomeId === assignment.outcomeId)!;
          const keep: RecordFile[] = [];
          for (const file of archives) {
            if (!unchanged(file)) continue;
            const value = file.value as SeatTaskRecord;
            const duplicate = keep.some((other) => unchanged(other) && isDeepStrictEqual(other.value, value));
            const obsolete = target.status === "merged" && primary && unchanged(primary) && value.prUrl === target.prUrl && !!value.prUrl
              && (primary.value as SeatTaskRecord).prUrl === target.prUrl && superseded(value, primary.value as SeatTaskRecord);
            if (duplicate || obsolete) unlinkSync(file.path);
            else keep.push(file);
          }
        }, `Seat ${seatId} checks finalized ${goal.id}/${assignment.outcomeId}`);
      } catch {
        // No raw command output or runtime content enters logs; retry safely on the next tick.
        log(`Could not maintain ${goal.id}/${assignment.outcomeId}; recovery metadata preserved.`);
      }
    }
  }
  return handled;
}
