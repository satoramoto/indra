import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexRuntime, type AgentRuntime, type MessageOptions, type WriteAccess } from "./codex-runtime.js";
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
