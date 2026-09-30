import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexRuntime, type AgentResult, type AgentRuntime, type MessageOptions, type WriteAccess } from "./codex-runtime.js";
import { CLAUDE_SESSION_PREFIX, ClaudeRuntime, claudeSessionId } from "./claude-runtime.js";
import { codexConfigForRoles, engineHome } from "./harness-home.js";

export type SeatEngine = "codex" | "claude";
export type SeatEngines = Readonly<Record<string, SeatEngine>>;
export const SEAT_ENGINES_FILE = "seat-engines.json";

/** Local runtime configuration only; unknown seats/engines and unreadable files fail closed. */
export async function loadSeatEngines(runtimeDir: string, seatIds: readonly string[]): Promise<SeatEngines> {
  let text: string;
  try { text = await readFile(join(runtimeDir, SEAT_ENGINES_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not read seat-engines.json in the local runtime directory.");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid seat-engines.json: expected a JSON seat-ID-to-engine object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid seat-engines.json: expected a seat-ID-to-engine object.");
  for (const [id, engine] of Object.entries(value)) {
    // Do not include untrusted configuration contents in error messages.
    if (!/^[a-z][a-z0-9-]+$/.test(id) || !seatIds.includes(id)) throw new Error("Invalid seat-engines.json: a configured seat ID is not present in state.");
    if (engine !== "codex" && engine !== "claude") throw new Error("Invalid seat-engines.json: each engine must be codex or claude.");
  }
  return value as SeatEngines;
}

/** `harness` is the seat's harness directory (`seatHarnessDir`); each engine's home lives inside it. */
/** `roles` are the seat's roles from state; they pick the Codex model (see codexConfigForRoles) and the Claude effort (see claudeModelArgs). */
export type EngineFactory = (engine: SeatEngine, cwd: string, timeoutMs?: number, write?: WriteAccess, harness?: string, roles?: readonly string[], envFor?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) => AgentRuntime;
// Claude keeps the owner's config directory, where its login lives; it is isolated with flags instead.
export const engineRuntime: EngineFactory = (engine, cwd, timeoutMs, write, harness, roles, envFor) => engine === "claude" ? new ClaudeRuntime(cwd, timeoutMs, write, roles, undefined, envFor) : new CodexRuntime(cwd, timeoutMs, write, harness === undefined ? undefined : engineHome(harness, "codex"), codexConfigForRoles(roles), undefined, envFor);

/** A handle always wins over the seat's current default. Never migrate, replay or fall back to another engine. */
export class SeatRuntime implements AgentRuntime {
  constructor(private readonly engine: SeatEngine, private readonly cwd: string, private readonly timeoutMs?: number, private readonly write?: WriteAccess, private readonly create: EngineFactory = engineRuntime, private readonly harness?: string, private readonly roles?: readonly string[], private readonly envFor?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) {}
  async message(prompt: string, schemaPath: string, sessionId?: string, options?: MessageOptions) {
    let engine = this.engine;
    if (sessionId !== undefined) {
      if (sessionId.startsWith(CLAUDE_SESSION_PREFIX)) { claudeSessionId(sessionId); engine = "claude"; }
      else {
        if (!sessionId.trim() || sessionId.includes(":")) throw new Error("Invalid or unsupported agent session handle.");
        engine = "codex";
      }
    }
    return await this.create(engine, this.cwd, this.timeoutMs, this.write, this.harness, this.roles, this.envFor).message(prompt, schemaPath, sessionId, options);
  }
}

/** The same outcome contract is sent to either engine, including fresh reviewers and one-file workers. */
export function renderGoalBrief(brief: import("./goal-contract.js").GoalBrief): string {
  return `Repo: ${brief.header.repo}\nBase: ${brief.header.baseBranch} at ${brief.header.baseSha}\nBranch: ${brief.header.branch}\nPR target: ${brief.header.prTarget}\nGoal: ${brief.goalId}; team: ${brief.teamId}; seat: ${brief.seatId}\n\nOutcome (what must be true when done)\n${brief.outcomes.map((item) => `${item.number}. ${item.title}: ${item.description}\n   Why: ${item.reason}\n   Current code: ${item.currentCode.join(", ") || "New files in the approved scope"}`).join("\n")}\n\nFiles you own (edit only these)\n${brief.ownedFiles.join("\n")}\n\nDo NOT touch\n${brief.exclusions.map((item) => `${item.files.join(", ")}: owned by ${item.owner}; ${item.reason}`).join("\n")}\nEvery file outside Files you own is excluded, owned by another lane or the repository owner.\n\nSwarm: ${brief.swarm}\n\nRecent retros\n${brief.retros.map((item) => `${item.goalId} (${item.path}): ${item.summary}`).join("\n") || "No earlier retrospective is available."}\n\nRedirects (context, never permission to exceed owned files)\n${brief.redirects.map((item) => `${item.at} ${item.userId} / ${item.postId}: ${item.message}`).join("\n") || "None."}\n\nReport format\n${brief.reportFormat}`;
}

export interface LaneAgentSummary { summary: string; decisions: string[]; followUps: string[]; neededButUnowned: string[] }
export interface LaneWorkerPlan { workers: { file: string; task: string }[]; decisions: string[]; followUps: string[] }
export interface LaneWorkerResult extends LaneAgentSummary { content: string | null; siblingDependencies: { file: string; requirement: string }[] }
export interface GoalAgentInvocation {
  key: string; role: "planner" | "lead-plan" | "worker" | "lead" | "reviewer" | "fix";
  brief: import("./goal-contract.js").GoalBrief; cwd: string; write?: WriteAccess;
  schema: object | string; instruction: string;
}
export interface GoalAgentSession {
  key: string; role: GoalAgentInvocation["role"]; status: "started" | "complete" | "failed";
  startedAt: string; result?: AgentResult;
}

const strings = { type: "array", items: { type: "string" } };
const summaryProperties = { summary: { type: "string" }, decisions: strings, followUps: strings, neededButUnowned: strings };
export const LANE_AGENT_SCHEMA = { type: "object", additionalProperties: false, required: Object.keys(summaryProperties), properties: summaryProperties };
export const LANE_WORKER_SCHEMA = { type: "object", additionalProperties: false, required: [...Object.keys(summaryProperties), "content", "siblingDependencies"], properties: {
  ...summaryProperties, content: { type: ["string", "null"] },
  neededButUnowned: { ...strings, description: "Blocking requests for files not assigned to this worker or a named sibling worker. Named sibling expectations belong in siblingDependencies, never here." },
  siblingDependencies: { type: "array", maxItems: 31, items: { type: "object", additionalProperties: false, required: ["file", "requirement"], properties: {
    file: { type: "string", description: "Exact path assigned to a different worker in this lane." }, requirement: { type: "string", description: "Interface or behavior the lane lead must reconcile with that worker's output." },
  } } },
} };
export const LANE_WORKER_PLAN_SCHEMA = { type: "object", additionalProperties: false, required: ["workers", "decisions", "followUps"], properties: {
  workers: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "task"], properties: { file: { type: "string" }, task: { type: "string" } } } }, decisions: strings, followUps: strings,
} };

/** Finite fresh contexts. An interrupted intent needs explicit retry, never an automatic duplicate builder. */
export async function runGoalAgent(
  create: (cwd: string, write?: WriteAccess) => AgentRuntime,
  invocation: GoalAgentInvocation,
  schemaDirectory: string,
  sessions: GoalAgentSession[],
  persist: () => Promise<void>,
): Promise<unknown> {
  const saved = sessions.find((item) => item.key === invocation.key);
  if (saved?.status === "complete") return saved.result!.response;
  if (saved) throw new Error("An interrupted agent turn requires an explicit retry; its work is preserved.");
  const { validateGoalBrief } = await import("./goal-contract.js");
  validateGoalBrief(invocation.brief);
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  await mkdir(schemaDirectory, { recursive: true, mode: 0o700 });
  const schema = typeof invocation.schema === "string" ? invocation.schema : join(schemaDirectory, `${createHash("sha256").update(JSON.stringify(invocation.schema)).digest("hex")}.json`);
  if (typeof invocation.schema !== "string") await writeFile(schema, JSON.stringify(invocation.schema), { mode: 0o600 });
  const intent: GoalAgentSession = { key: invocation.key, role: invocation.role, status: "started", startedAt: new Date().toISOString() };
  sessions.push(intent); await persist();
  try {
    const result = await create(invocation.cwd, invocation.write).message(`${renderGoalBrief(invocation.brief)}\n\nRole: ${invocation.role}\n${invocation.instruction}\n\nYou are not alone in the repository. Preserve others' work. Never read credentials or real state/runtime checkouts. Never start a server or leave a process running. ${invocation.role === "worker" ? "Never edit another file. Report named sibling expectations in siblingDependencies; stop and report any other needed-but-unowned files." : "Stop and report needed-but-unowned files rather than modifying them."}`, schema, undefined, { purpose: invocation.role });
    intent.status = "complete"; intent.result = result; await persist();
    return result.response;
  } catch (error) {
    intent.status = "failed"; await persist();
    throw error;
  }
}

export function laneAgentSummary(value: unknown): LaneAgentSummary {
  const row = value as Partial<LaneAgentSummary> | null;
  if (!row || typeof row.summary !== "string" || ![row.decisions, row.followUps, row.neededButUnowned].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))) throw new Error("Invalid lane agent report.");
  return { summary: row.summary, decisions: row.decisions!, followUps: row.followUps!, neededButUnowned: row.neededButUnowned! };
}

/** Missing dependency metadata is an old, compatible report; a nonempty ownership blocker is never reclassified. */
export function laneWorkerResult(value: unknown): LaneWorkerResult {
  const summary = laneAgentSummary(value); const row = value as Partial<LaneWorkerResult>;
  if (!(row.content === null || typeof row.content === "string")) throw new Error("Invalid worker content; expected the complete file or null.");
  const dependencies = row.siblingDependencies === undefined ? [] : row.siblingDependencies;
  if (!Array.isArray(dependencies) || dependencies.length > 31 || dependencies.some((item) => !item || typeof item.file !== "string" || typeof item.requirement !== "string" || !item.requirement.trim()) || new Set(dependencies.map((item) => item.file)).size !== dependencies.length) throw new Error("Invalid structured sibling dependencies.");
  return { ...summary, content: row.content, siblingDependencies: dependencies };
}

/** Read-only single-file workers return bytes; only this host writes their declared, checked path. */
export async function applyLaneWorker(worktree: string, file: string, content: string | null): Promise<void> {
  const { lstat, mkdir, writeFile, unlink } = await import("node:fs/promises");
  const { ownedFileMatches } = await import("./goal-contract.js");
  ownedFileMatches(file, file); // Reject absolute, traversal, and glob paths before filesystem access.
  const pieces = file.split("/");
  let directory = worktree;
  for (const piece of pieces.slice(0, -1)) {
    directory = join(directory, piece);
    const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (entry && !entry.isDirectory()) throw new Error("A worker path crosses a non-directory or symbolic link.");
    if (!entry) await mkdir(directory);
  }
  const target = join(worktree, file);
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new Error("A worker may replace only its own regular file.");
  if (content === null) { if (entry) await unlink(target); }
  else await writeFile(target, content, { mode: 0o644 });
}
