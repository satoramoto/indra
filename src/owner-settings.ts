import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnerSettingsPort } from "./autonomy-ports.js";
import { PlanningStore, type PlanningDocument } from "./planning.js";
import type { TeamRecord } from "./state-domain.js";
import { StateGit, withFileLock } from "./state-commit.js";
import { approvalPolicy, POLICY_FILE, readPolicyDocument, validatePolicyDocument,
  type PolicyDocument, type PolicyScope } from "./auto-policy.js";

export type OwnerScopeChoice = { kind: "mission" } | { kind: "problem"; goalId: string };
type SettingsPatch = Parameters<OwnerSettingsPort["updateOwnerSettings"]>[1];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown owner setting.");
}
function settingsTeam(state: PlanningDocument, teamId: string): TeamRecord {
  const team = (state.teams as TeamRecord[]).find((item) => item.id === teamId);
  if (!team) throw new Error("Unknown owner settings team.");
  return team;
}
function selectedScope(state: PlanningDocument, team: TeamRecord, choice: OwnerScopeChoice): PolicyScope {
  fields(choice, choice.kind === "mission" ? ["kind"] : ["kind", "goalId"]);
  if (choice.kind === "mission") {
    if (!team.mission?.trim()) throw new Error("Set the team mission before choosing mission-wide scope.");
    return { kind: "mission", mission: team.mission };
  }
  if (choice.kind !== "problem") throw new Error("Choose mission-wide or named-problem scope explicitly.");
  const goal = state.planningGoals?.find((item) => item.id === choice.goalId && item.teamId === team.id);
  if (!goal?.ceremony || goal.ceremony.closure) throw new Error("Choose an open problem on this team by its goal ID.");
  return { kind: "problem", goalId: goal.id, problem: goal.goal };
}

/** Settings are owner capabilities, not commands accepted from a role name, agent reply, or Mattermost post. */
export class OwnerSettingsCommands implements OwnerSettingsPort {
  constructor(private readonly store: PlanningStore) {}

  private async snapshot(): Promise<{ state: PlanningDocument; document: PolicyDocument }> {
    return await withFileLock(join(this.store.runtimeDir, "state.lock"), async () => ({ state: await this.store.read(), document: await readPolicyDocument(this.store.checkout) }));
  }
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    return await withFileLock(join(this.store.runtimeDir, "owner-settings.lock"), work);
  }
  /** Monotonic even for two owner commands in one millisecond or a clock moving backwards. */
  private timestamp(state: PlanningDocument, document: PolicyDocument, team: TeamRecord, supplied?: string): string {
    if (supplied !== undefined) return supplied;
    const times = [team.standingPolicy?.revisions.at(-1)?.at,
      ...document.policies.filter((item) => item.teamId === team.id).flatMap((item) => item.grants.map((grant) => grant.at)),
      ...(state.planningGoals ?? []).filter((goal) => goal.teamId === team.id).flatMap((goal) => (goal.automaticApprovals ?? []).map((approval) => approval.at)),
    ].filter((at): at is string => !!at).map((at) => Date.parse(at) + 1);
    return new Date(Math.max(Date.now(), ...times)).toISOString();
  }

  /** Commit only autonomy.json under the same Git/state lock as PlanningStore. An interrupted preparation cannot enable. */
  private async save(document: PolicyDocument): Promise<void> {
    validatePolicyDocument(document);
    const git = new StateGit(this.store.checkout, POLICY_FILE);
    await withFileLock(join(this.store.runtimeDir, "state.lock"), async () => {
      const previous = await readPolicyDocument(this.store.checkout);
      for (const old of previous.policies) {
        const next = document.policies.find((item) => item.teamId === old.teamId);
        if (!next || next.id !== old.id || next.grants.length < old.grants.length || next.grants.length > old.grants.length + 1
          || old.grants.some((grant, index) => !same(grant, next.grants[index]))) throw new Error("Owner policy identity and grant history are immutable.");
      }
      if (same(previous, document)) return;
      const file = join(this.store.checkout, POLICY_FILE);
      const before = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temp, file);
        if (before === undefined) await git.add();
        await git.commit("Update owner autonomy policy");
      } catch {
        if (before === undefined) await rm(file, { force: true });
        else await writeFile(file, before, { mode: 0o600 });
        await git.unstage();
        throw new Error("Could not commit owner autonomy settings; the policy file was restored.");
      } finally { await rm(temp, { force: true }); }
    });
    git.pushInBackground();
  }

  /** Choosing a different scope switches off first; it never grants permission to enable itself. */
  async chooseScope(teamId: string, choice: OwnerScopeChoice): Promise<void> {
    const requested = structuredClone(choice);
    await this.serialized(async () => {
      const { state, document } = await this.snapshot();
      const team = settingsTeam(state, teamId);
      const scope = selectedScope(state, team, requested);
      let policy = document.policies.find((item) => item.teamId === teamId);
      if (policy && same(policy.scope, scope)) return;
      await this.store.updateOwnerSettings(teamId, { autoMode: false });
      if (policy) policy.scope = scope;
      else { policy = { id: `policy-${randomUUID()}`, teamId, scope, grants: [] }; document.policies.push(policy); }
      await this.save(document);
    });
  }

  /** Final automation composition calls this only after its adapters are available and the owner confirms enabling. */
  async enable(teamId: string): Promise<void> { await this.updateOwnerSettings(teamId, { autoMode: true }); }
  async disable(teamId: string): Promise<void> { await this.updateOwnerSettings(teamId, { autoMode: false }); }

  async updateOwnerSettings(teamId: string, patch: SettingsPatch, at?: string): Promise<void> {
    fields(patch, ["mission", "autoMode"]);
    if (at !== undefined && (!/^\d{4}-\d\d-\d\dT/.test(at) || !Number.isFinite(Date.parse(at)))) throw new Error("Invalid owner settings timestamp.");
    if (patch.mission !== undefined && (typeof patch.mission !== "string" || !patch.mission.trim())) throw new Error("The owner mission must not be empty.");
    if (patch.autoMode !== undefined && typeof patch.autoMode !== "boolean") throw new Error("Auto mode must be on or off.");
    if (patch.mission !== undefined && patch.autoMode === true) throw new Error("Save the mission and choose its scope before enabling auto mode.");
    const requested = structuredClone(patch);
    await this.serialized(async () => {
      // Off must remain available even if the companion file is missing, dirty or unreadable.
      if (requested.autoMode === false && requested.mission === undefined) {
        await this.store.updateOwnerSettings(teamId, { autoMode: false }, at);
        return;
      }
      let { state, document } = await this.snapshot();
      let team = settingsTeam(state, teamId);
      if (requested.autoMode !== true) {
        // A changed mission invalidates the old scope before any later gate can execute it.
        const missionChanged = requested.mission !== undefined && requested.mission !== team.mission;
        await this.store.updateOwnerSettings(teamId, { ...requested, ...(missionChanged ? { autoMode: false } : {}) }, at);
        return;
      }
      const policy = document.policies.find((item) => item.teamId === teamId);
      if (!policy) throw new Error("Choose mission-wide or named-problem scope before enabling auto mode.");
      const choice: OwnerScopeChoice = policy.scope.kind === "mission" ? { kind: "mission" } : { kind: "problem", goalId: policy.scope.goalId };
      if (!same(selectedScope(state, team, choice), policy.scope)) throw new Error("The mission or named problem changed; choose its scope again before enabling.");
      const setting = team.standingPolicy?.revisions.at(-1);
      const current = setting && approvalPolicy(document, team, setting.revision);
      if (current && same(current.scope, policy.scope)) return;
      if (setting?.enabled) {
        // An old boolean-only setting is not a scoped grant. Revoke it before replacing it.
        await this.store.updateOwnerSettings(teamId, { autoMode: false });
        ({ state, document } = await this.snapshot()); team = settingsTeam(state, teamId);
      }
      const configured = document.policies.find((item) => item.teamId === teamId)!;
      const revision = (team.standingPolicy?.revisions.at(-1)?.revision ?? 0) + 1;
      const enabledAt = this.timestamp(state, document, team, at);
      configured.grants.push({ revision, at: enabledAt, scope: structuredClone(configured.scope) });
      // Prepare the immutable scope while off. Only a successful state commit of this exact revision/time activates it.
      await this.save(document);
      await this.store.updateOwnerSettings(teamId, { autoMode: true }, enabledAt);
    });
  }
}

/** Only the owner/TUI factory gets this writer. The final auto-mode adapter owns its separate enable control. */
export function createOwnerControls({ store }: { store: PlanningStore }): { settings: OwnerSettingsPort } {
  const commands = new OwnerSettingsCommands(store);
  return { settings: { updateOwnerSettings: (teamId, patch, at) => commands.updateOwnerSettings(teamId, patch, at) } };
}

/** Terminal-only entry point; never register this parser as an agent tool or chat command. */
export async function runOwnerSettingsCommand(store: PlanningStore, teamId: string, args: readonly string[]): Promise<string> {
  const commands = new OwnerSettingsCommands(store);
  if (args.length === 2 && args[0] === "scope" && args[1] === "mission") {
    await commands.chooseScope(teamId, { kind: "mission" }); return "Mission-wide scope saved.";
  }
  if (args.length === 3 && args[0] === "scope" && args[1] === "problem") {
    await commands.chooseScope(teamId, { kind: "problem", goalId: args[2] }); return "Named-problem scope saved.";
  }
  if (args.length === 2 && args[0] === "auto" && ["on", "off"].includes(args[1])) {
    await commands.updateOwnerSettings(teamId, { autoMode: args[1] === "on" });
    return args[1] === "on" ? "Auto mode enabled under the selected owner scope." : "Auto mode off. Approval history and authorized work are preserved.";
  }
  if (args.length === 2 && args[0] === "mission") {
    await commands.updateOwnerSettings(teamId, { mission: args[1] }); return "Team mission saved.";
  }
  throw new Error("Owner settings command: scope mission | scope problem <goal-id> | auto on | auto off | mission <text>.");
}

// Source-checkout owner command. The filename check also prevents execution when bundled into dist/cli.js.
if (process.argv[1] && basename(process.argv[1]) === "owner-settings.ts" && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateFlag, checkout, teamFlag, teamId, ...args] = process.argv.slice(2);
  try {
    if (stateFlag !== "--state" || !checkout || teamFlag !== "--team" || !teamId) throw new Error("Use --state <indra-state-checkout> --team <team-id> before the owner settings command.");
    process.stdout.write(`${await runOwnerSettingsCommand(new PlanningStore(resolve(checkout)), teamId, args)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Owner settings command failed."}\n`);
    process.exitCode = 1;
  }
}
