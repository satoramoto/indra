import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SEAT_ROLES } from "./state-domain.js";
import type { StateRepository, StateSnapshot, StateTeam } from "./state-domain.js";
import { validatePlanningDocument, type PlanningDocument } from "./planning.js";

export class StateDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDataError";
  }
}

type Fields = Record<string, unknown>;

function record(value: unknown, path: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StateDataError(`${path} must be an object.`);
  }
  return value as Fields;
}

function fields(data: Fields, path: string, allowed: string[]): void {
  const extra = Object.keys(data).find((key) => !allowed.includes(key));
  if (extra) throw new StateDataError(`${path}.${extra} is not part of state schema v1.`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StateDataError(`${path} must be a nonempty string.`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[a-z][a-z0-9-]+$/.test(result)) {
    throw new StateDataError(`${path} must be a lowercase ID using letters, digits, or hyphens.`);
  }
  return result;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new StateDataError(`${path} must be an array.`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function unique(ids: string[], path: string, label = "ID"): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new StateDataError(`${path} contains duplicate ${label} '${id}'.`);
    seen.add(id);
  }
}

function team(value: unknown, index: number): StateTeam {
  const path = `teams[${index}]`;
  const data = record(value, path);
  fields(data, path, ["id", "slug", "displayName", "project", "externalIdentities", "seats", "workflowModel"]);
  if (data.workflowModel !== undefined && data.workflowModel !== "goals-v1") throw new StateDataError(`${path}.workflowModel is unsupported.`);
  const project = data.project === undefined ? undefined : teamProject(data.project, `${path}.project`);
  const identities = record(data.externalIdentities, `${path}.externalIdentities`);
  fields(identities, `${path}.externalIdentities`, ["mattermost"]);
  const mattermost = record(identities.mattermost, `${path}.externalIdentities.mattermost`);
  fields(mattermost, `${path}.externalIdentities.mattermost`, ["teamId", "homeChannelId"]);
  const homeChannelId = mattermost.homeChannelId === undefined ? undefined : string(mattermost.homeChannelId, `${path}.externalIdentities.mattermost.homeChannelId`);
  const seats = array(data.seats, `${path}.seats`).map((value, index) => {
    const seatPath = `${path}.seats[${index}]`;
    const seat = record(value, seatPath);
    fields(seat, seatPath, ["id", "displayName", "roles", "externalIdentities"]);
    const identities = record(seat.externalIdentities, `${seatPath}.externalIdentities`);
    fields(identities, `${seatPath}.externalIdentities`, ["mattermost"]);
    const mattermost = record(identities.mattermost, `${seatPath}.externalIdentities.mattermost`);
    fields(mattermost, `${seatPath}.externalIdentities.mattermost`, ["userId", "username"]);
    const userId = string(mattermost.userId, `${seatPath}.externalIdentities.mattermost.userId`);
    const roles = strings(seat.roles, `${seatPath}.roles`);
    unique(roles, `${seatPath}.roles`, "role");
    if (roles.length !== 1) {
      throw new StateDataError(`${seatPath}.roles must contain exactly one role: ${SEAT_ROLES.map((role) => `'${role}'`).join(" or ")}.`);
    }
    if (!(SEAT_ROLES as readonly string[]).includes(roles[0])) {
      throw new StateDataError(`${seatPath}.roles[0] '${roles[0]}' is not a seat role; expected ${SEAT_ROLES.map((role) => `'${role}'`).join(" or ")}.`);
    }
    return {
      id: id(seat.id, `${seatPath}.id`),
      displayName: string(seat.displayName, `${seatPath}.displayName`),
      handle: string(mattermost.username, `${seatPath}.externalIdentities.mattermost.username`),
      mattermostUserId: userId,
      roles,
    };
  });
  unique(seats.map((seat) => seat.id), `${path}.seats`);
  const leads = seats.filter((seat) => seat.roles[0] === "Team Lead").length;
  if (leads !== 1) {
    throw new StateDataError(`${path}.seats must contain exactly one 'Team Lead' seat; found ${leads}.`);
  }
  const products = seats.filter((seat) => seat.roles[0] === "Product").length;
  if (data.workflowModel === "goals-v1") {
    if (products !== 1 || !seats.some((seat) => seat.roles[0] === "Developer")) throw new StateDataError(`${path}.seats requires exactly one Product and at least one Developer for goals-v1.`);
  } else if (products) throw new StateDataError(`${path}.workflowModel must be goals-v1 before a Product seat is enabled.`);
  return {
    ...(data.workflowModel === "goals-v1" ? { workflowModel: "goals-v1" as const } : {}),
    id: id(data.id, `${path}.id`),
    slug: id(data.slug, `${path}.slug`),
    displayName: string(data.displayName, `${path}.displayName`),
    mattermostTeamId: string(mattermost.teamId, `${path}.externalIdentities.mattermost.teamId`),
    ...(homeChannelId ? { homeChannelId } : {}),
    ...(project ? { project } : {}),
    seats,
  };
}

/** GitHub `owner/repo`: letters, digits, `-`, `_` and `.`, never a `.` or `..` segment (it becomes a local path). */
export const GITHUB_REPO = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

function teamProject(value: unknown, path: string): { github: string } {
  const data = record(value, path);
  fields(data, path, ["github"]);
  const github = string(data.github, `${path}.github`);
  if (!GITHUB_REPO.test(github)) throw new StateDataError(`${path}.github must be a GitHub repository as 'owner/repo'.`);
  return { github };
}

/** Validates the version 1 record shape and references before exposing neutral records. */
export function parseState(raw: unknown): StateSnapshot {
  const data = record(raw, "state.json");
  fields(data, "state.json", ["$schema", "schemaVersion", "teams", "sprints", "planningGoals"]);
  if (data.$schema !== "./schema/v1/state.schema.json") {
    throw new StateDataError("$schema must reference ./schema/v1/state.schema.json.");
  }
  if (data.schemaVersion !== 1) {
    throw new StateDataError(`Unsupported schemaVersion '${String(data.schemaVersion)}'; expected 1.`);
  }
  const teams = array(data.teams, "teams").map(team);
  // Retired draft sprints: ignored, and emptied at start-up (`PlanningStore.retireLegacySprints`); older builds require the key.
  if (data.sprints !== undefined) array(data.sprints, "sprints");
  unique(teams.map((item) => item.id), "teams");
  unique(teams.map((item) => item.slug), "team slugs", "slug");
  try { validatePlanningDocument(data as unknown as PlanningDocument); }
  catch (error) { throw new StateDataError(error instanceof Error ? error.message : "Invalid planning goals."); }
  return { teams };
}

export class LocalStateRepository implements StateRepository {
  constructor(private readonly checkout: string) {}

  async read(): Promise<StateSnapshot> {
    const file = join(this.checkout, "state.json");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "read error";
      throw new StateDataError(`Cannot read ${file} (${code}). Set --state PATH or INDRA_STATE_REPO to a checkout containing state.json.`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch (error) {
      const match = error instanceof Error ? /position (\d+).*line (\d+) column (\d+)/.exec(error.message) : null;
      const location = match ? ` at line ${match[2]}, column ${match[3]}` : "";
      throw new StateDataError(`${file} contains invalid JSON${location}.`);
    }
    return parseState(raw);
  }
}
