import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { rankCandidateSprints, validateCandidateMembership } from "./candidate-sprints.js";
import { gitCommand, gitEnv } from "./git-gh.js";
import { parseState } from "./local-state.js";
import { PlanningStore, type PlanningDocument } from "./planning.js";
import { StateCommitError, StateGit, withFileLock } from "./state-commit.js";
import { INITIAL_TEAM_MISSION, isActiveSeat, type BacklogTicket, type SprintCandidate, type TeamRecord } from "./state-domain.js";
import backlogSchema from "../schemas/backlog.json?raw";

export interface TicketInput {
  id: string; title: string; problem: string; value: string; acceptanceCriteria: string[];
  status: BacklogTicket["status"]; dependsOn: string[]; research: { url: string; finding: string }[];
}
export interface CandidateInput {
  id: string; title: string; summary: string; value: string; rank: number; status: SprintCandidate["status"];
  ticketIds: string[]; goalId: string | null; retrospectiveGoalId: string | null;
}
export interface BacklogEdit {
  expectedRevision: string;
  ticketChanges: { action: "create" | "update"; ticket: TicketInput }[];
  candidateChanges: { action: "create" | "update"; candidate: CandidateInput }[];
}
export interface BacklogSnapshot {
  teamId: string; mission?: string; revision: string; tickets: BacklogTicket[]; candidates: SprintCandidate[];
}

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const validateEdit = ajv.compile(JSON.parse(backlogSchema));

/** Reject unknown fields (including owner settings and claimed authorship), without echoing untrusted input. */
export function parseBacklogEdit(value: unknown): BacklogEdit {
  if (!validateEdit(value)) throw new Error("Invalid backlog edit; only ticket and candidate changes are allowed.");
  const edit = structuredClone(value) as BacklogEdit;
  for (const { ticket } of edit.ticketChanges) for (const evidence of ticket.research) {
    try {
      const url = new URL(evidence.url);
      if (!url.hostname || url.username || url.password) throw new Error();
    } catch { throw new Error("Invalid backlog edit; research requires an HTTP(S) URL without embedded credentials."); }
  }
  return edit;
}

function teamIn(state: PlanningDocument, teamId: string): TeamRecord {
  const team = (state.teams as TeamRecord[]).find((item) => item.id === teamId);
  if (!team) throw new Error("Unknown backlog team.");
  return team;
}

/** Acceptance criteria are kept with the problem in v1's durable description field. */
export function ticketDescription(ticket: Pick<TicketInput, "problem" | "acceptanceCriteria">): string {
  return `${ticket.problem.trim()}\n\nAcceptance criteria:\n${ticket.acceptanceCriteria.map((item, index) => `${index + 1}. ${item.trim()}`).join("\n")}`;
}

function validateDependencies(tickets: BacklogTicket[]): void {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const visited = new Set<string>(); const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("Backlog ticket dependencies contain a cycle.");
    if (visited.has(id)) return;
    const ticket = byId.get(id);
    if (!ticket) throw new Error("Backlog dependency references an unknown ticket.");
    visiting.add(id);
    const dependencies = ticket.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length) throw new Error("Duplicate backlog dependency.");
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const ticket of tickets) visit(ticket.id);
}

function applyChanges<T extends { id: string; createdAt: string; createdBySeatId: string }>(
  records: T[], changes: { action: "create" | "update"; record: T }[],
): T[] {
  const result = [...records]; const changed = new Set<string>();
  for (const { action, record } of changes) {
    if (changed.has(record.id)) throw new Error("Duplicate identity in backlog edit.");
    changed.add(record.id);
    const index = result.findIndex((item) => item.id === record.id);
    if (action === "create") {
      if (index !== -1) throw new Error("Backlog identity already exists.");
      result.push(record);
    } else {
      if (index === -1) throw new Error("Cannot update an unknown backlog identity.");
      result[index] = { ...record, createdAt: result[index].createdAt, createdBySeatId: result[index].createdBySeatId };
    }
  }
  return result;
}

/** Independently usable by Product and the Team Lead; no runtime loop or approval actions live here. */
export class BacklogStore {
  constructor(readonly store: PlanningStore) {}

  /**
   * Installs only the owner's specified initial mission. There is no caller-supplied setting to apply.
   * The owner settings port is unconditional, so check absence under the state lock and use the store's
   * commit-intent protocol for recovery. An owner edit before or after this transaction always wins.
   */
  async initializeMission(teamId: string): Promise<boolean> {
    await this.store.update(() => {}, "Recover state before mission initialization");
    const git = new StateGit(this.store.checkout);
    const file = join(this.store.checkout, "state.json");
    const replace = async (content: string) => {
      const temp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, content, { flag: "wx", mode: 0o600 }); await rename(temp, file); }
      finally { await rm(temp, { force: true }); }
    };
    const changed = await withFileLock(join(this.store.runtimeDir, "state.lock"), async () => {
      await git.assertClean();
      const before = await readFile(file, "utf8");
      const state = JSON.parse(before) as PlanningDocument;
      parseState(state);
      const team = teamIn(state, teamId);
      if (team.mission !== undefined) return false;
      team.mission = INITIAL_TEAM_MISSION;
      parseState(state);
      const schema = JSON.parse(await readFile(join(this.store.checkout, "schema/v1/state.schema.json"), "utf8"));
      const stateAjv = new Ajv2020({ strict: false }); addFormats.default(stateAjv);
      if (!stateAjv.compile(schema)(state)) throw new Error("The checkout's v1 schema does not accept the initial mission.");
      const after = `${JSON.stringify(state, null, 2)}\n`;
      const message = "Initialize the team mission";
      const intent = join(this.store.runtimeDir, "state-commit.json");
      await this.store.saveRuntime("state-commit", { sha256: createHash("sha256").update(after).digest("hex"), message });
      try { await replace(after); await git.commit(message); }
      catch (error) {
        await replace(before); await git.unstage(); await rm(intent, { force: true });
        throw new StateCommitError("Could not initialize the team mission; state.json was rolled back.", { cause: error });
      }
      await rm(intent, { force: true });
      return true;
    });
    if (changed) git.pushInBackground();
    return changed;
  }

  /** A Git commit is the revision, so changing settings and then changing them back still invalidates an edit. */
  private revision(): string {
    try {
      const command = gitCommand(["rev-parse", "HEAD"], { checkout: this.store.checkout });
      const revision = execFileSync(command.command, command.args, {
        encoding: "utf8", env: gitEnv(), timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (/^[0-9a-f]{40}$/.test(revision)) return revision;
    } catch { /* Never include command output in an input-validation error. */ }
    throw new Error("Cannot read the backlog state revision.");
  }

  /** Reads records and their revision under the same lock used by state writes and sync. */
  async read(teamId: string): Promise<BacklogSnapshot> {
    return withFileLock(join(this.store.runtimeDir, "state.lock"), async () => {
      const team = teamIn(await this.store.read(), teamId);
      return { teamId: team.id, mission: team.mission, revision: this.revision(),
        tickets: team.backlog ?? [], candidates: rankCandidateSprints(team.sprintCandidates ?? []) };
    });
  }

  /** One locked state commit, or no change at all. IDs are never reused or deleted; retire records by status. */
  async apply(teamId: string, seatId: string, value: unknown): Promise<BacklogSnapshot> {
    const edit = parseBacklogEdit(value);
    await this.store.update((state) => {
      if (this.revision() !== edit.expectedRevision) throw new Error("Stale backlog edit; reload before grooming again.");
      const team = teamIn(state, teamId);
      const seat = team.seats.find((item) => item.id === seatId);
      if (!seat || !isActiveSeat(seat) || !seat.roles.some((role) => role === "Product" || role === "Team Lead")) {
        throw new Error("Backlog grooming requires an active Product or Team Lead seat on the team.");
      }
      const at = new Date().toISOString();
      const authors = { createdAt: at, updatedAt: at, createdBySeatId: seatId, updatedBySeatId: seatId };
      const tickets = applyChanges(team.backlog ?? [], edit.ticketChanges.map(({ action, ticket }) => ({ action, record: {
        id: ticket.id, title: ticket.title, description: ticketDescription(ticket), value: ticket.value, status: ticket.status,
        dependsOn: ticket.dependsOn, research: ticket.research, ...authors,
      } })));
      const candidates = applyChanges(team.sprintCandidates ?? [], edit.candidateChanges.map(({ action, candidate }) => {
        const { goalId, retrospectiveGoalId, ...fields } = candidate;
        const previous = team.sprintCandidates?.find((item) => item.id === candidate.id);
        if (previous?.goalId && previous.goalId !== goalId) throw new Error("A candidate sprint's goal link cannot be replaced or removed.");
        return { action, record: { ...fields, ...(goalId ? { goalId } : {}), ...(retrospectiveGoalId ? { retrospectiveGoalId } : {}), ...authors } };
      }));
      validateDependencies(tickets);
      validateCandidateMembership(tickets, candidates);
      if (edit.ticketChanges.length) team.backlog = tickets;
      if (edit.candidateChanges.length) team.sprintCandidates = candidates;
    }, "Groom team backlog and candidate sprints");
    return this.read(teamId);
  }
}
