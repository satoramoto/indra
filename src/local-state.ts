import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DraftSprint, ProposedAllocation, ProposedWork, StateRepository, StateSnapshot, StateTeam } from "./state-domain.js";

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
  fields(data, path, ["id", "slug", "displayName", "externalIdentities", "seats"]);
  const identities = record(data.externalIdentities, `${path}.externalIdentities`);
  fields(identities, `${path}.externalIdentities`, ["mattermost"]);
  const mattermost = record(identities.mattermost, `${path}.externalIdentities.mattermost`);
  fields(mattermost, `${path}.externalIdentities.mattermost`, ["teamId"]);
  string(mattermost.teamId, `${path}.externalIdentities.mattermost.teamId`);
  const seats = array(data.seats, `${path}.seats`).map((value, index) => {
    const seatPath = `${path}.seats[${index}]`;
    const seat = record(value, seatPath);
    fields(seat, seatPath, ["id", "displayName", "roles", "externalIdentities"]);
    const identities = record(seat.externalIdentities, `${seatPath}.externalIdentities`);
    fields(identities, `${seatPath}.externalIdentities`, ["mattermost"]);
    const mattermost = record(identities.mattermost, `${seatPath}.externalIdentities.mattermost`);
    fields(mattermost, `${seatPath}.externalIdentities.mattermost`, ["userId", "username"]);
    string(mattermost.userId, `${seatPath}.externalIdentities.mattermost.userId`);
    const roles = strings(seat.roles, `${seatPath}.roles`);
    unique(roles, `${seatPath}.roles`, "role");
    return {
      id: id(seat.id, `${seatPath}.id`),
      displayName: string(seat.displayName, `${seatPath}.displayName`),
      handle: string(mattermost.username, `${seatPath}.externalIdentities.mattermost.username`),
      roles,
    };
  });
  unique(seats.map((seat) => seat.id), `${path}.seats`);
  return {
    id: id(data.id, `${path}.id`),
    slug: id(data.slug, `${path}.slug`),
    displayName: string(data.displayName, `${path}.displayName`),
    seats,
  };
}

function sprint(value: unknown, index: number): DraftSprint {
  const path = `sprints[${index}]`;
  const data = record(value, path);
  fields(data, path, ["id", "teamId", "status", "phase", "goal", "proposedWork", "proposedAllocations"]);
  if (data.status !== "draft") throw new StateDataError(`${path}.status must be 'draft'.`);
  const proposedWork: ProposedWork[] = array(data.proposedWork, `${path}.proposedWork`).map((value, index) => {
    const workPath = `${path}.proposedWork[${index}]`;
    const work = record(value, workPath);
    fields(work, workPath, ["id", "title", "description"]);
    return {
      id: id(work.id, `${workPath}.id`),
      title: string(work.title, `${workPath}.title`),
      description: string(work.description, `${workPath}.description`),
    };
  });
  unique(proposedWork.map((work) => work.id), `${path}.proposedWork`);
  const proposedAllocations: ProposedAllocation[] = array(data.proposedAllocations, `${path}.proposedAllocations`).map((value, index) => {
    const allocationPath = `${path}.proposedAllocations[${index}]`;
    const allocation = record(value, allocationPath);
    fields(allocation, allocationPath, ["seatId", "workIds"]);
    const workIds = array(allocation.workIds, `${allocationPath}.workIds`).map((item, index) => id(item, `${allocationPath}.workIds[${index}]`));
    unique(workIds, `${allocationPath}.workIds`, "work ID");
    return {
      seatId: id(allocation.seatId, `${allocationPath}.seatId`),
      workIds,
    };
  });
  unique(proposedAllocations.map((allocation) => allocation.seatId), `${path}.proposedAllocations`, "seat allocation");
  return {
    id: id(data.id, `${path}.id`),
    teamId: id(data.teamId, `${path}.teamId`),
    status: "draft",
    phase: string(data.phase, `${path}.phase`),
    goal: string(data.goal, `${path}.goal`),
    proposedWork,
    proposedAllocations,
  };
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
  const sprints = array(data.sprints, "sprints").map(sprint);
  unique(teams.map((item) => item.id), "teams");
  unique(teams.map((item) => item.slug), "team slugs", "slug");
  unique(sprints.map((item) => item.id), "sprints");
  const teamsById = new Map(teams.map((item) => [item.id, item]));
  for (let index = 0; index < sprints.length; index++) {
    const item = sprints[index];
    const owner = teamsById.get(item.teamId);
    if (!owner) throw new StateDataError(`sprints[${index}].teamId '${item.teamId}' does not match a team.`);
    const seatIds = new Set(owner.seats.map((seat) => seat.id));
    const workIds = new Set(item.proposedWork.map((work) => work.id));
    for (let allocationIndex = 0; allocationIndex < item.proposedAllocations.length; allocationIndex++) {
      const allocation = item.proposedAllocations[allocationIndex];
      const path = `sprints[${index}].proposedAllocations[${allocationIndex}]`;
      if (!seatIds.has(allocation.seatId)) {
        throw new StateDataError(`${path}.seatId '${allocation.seatId}' is not in team '${owner.id}'.`);
      }
      for (const workId of allocation.workIds) {
        if (!workIds.has(workId)) throw new StateDataError(`${path}.workIds contains unknown work ID '${workId}'.`);
      }
    }
  }
  return { teams, sprints };
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
