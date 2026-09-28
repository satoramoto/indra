import type { LiveMember, TeamMemberReader } from "./consistency.js";
import { InventoryError, type Seat, type SeatReader, type Team, type TeamReader } from "./domain.js";

const PAGE_SIZE = 100;
type RecordValue = Record<string, unknown>;

const CERTIFICATE_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function certificateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (object(current) && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string" && CERTIFICATE_ERROR_CODES.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value) || !value.every(object)) {
    throw new InventoryError("Mattermost returned an unexpected inventory response.");
  }
  return value;
}

interface RoleField extends RecordValue {
  id: string;
}

/** Decode the existing custom profile metadata; no field or option IDs are embedded in the app. */
export function roleField(metadata: unknown): RoleField {
  const fields = object(metadata) ? metadata.fields : metadata;
  if (!Array.isArray(fields)) {
    throw new InventoryError("Mattermost returned unexpected custom profile field metadata.");
  }
  const matches = fields.filter((field): field is RoleField =>
    object(field) && typeof field.id === "string" &&
    typeof field.name === "string" && field.name.toLowerCase() === "role",
  );
  if (matches.length !== 1) {
    throw new InventoryError("A unique custom profile field named Role is not visible to this credential.");
  }
  return matches[0];
}

function roleOptions(field: RoleField): Map<string, string> {
  const attrs = object(field.attrs) ? field.attrs : {};
  let options = attrs.options;
  if (typeof options === "string") {
    try {
      options = JSON.parse(options) as unknown;
    } catch {
      options = undefined;
    }
  }
  if (!Array.isArray(options)) {
    throw new InventoryError("Role field options are unavailable in Mattermost metadata.");
  }
  const result = new Map<string, string>();
  for (const option of options) {
    if (object(option)) {
      const id = text(option.id);
      const name = text(option.name) ?? text(option.value);
      if (id && name) result.set(id, name);
    }
  }
  return result;
}

export function roleValues(payload: unknown, field: RoleField): string[] {
  let raw: unknown;
  if (object(payload)) {
    raw = payload[field.id] ?? [];
  } else if (Array.isArray(payload)) {
    raw = payload.find((item) => object(item) && item.field_id === field.id);
    raw = object(raw) ? raw.value ?? [] : [];
  } else {
    throw new InventoryError("Mattermost returned unexpected Role values.");
  }
  if (typeof raw === "string") {
    if (raw.startsWith("[")) {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        throw new InventoryError("Mattermost returned malformed Role values.");
      }
    } else {
      raw = raw ? [raw] : [];
    }
  }
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    throw new InventoryError("Mattermost returned unexpected Role values.");
  }
  const options = roleOptions(field);
  return raw.map((id) => options.get(id) ?? `Unknown option (${id})`);
}

/** Transport is deliberately GET-only and never follows a bearer-token redirect. */
export class MattermostClient {
  private readonly origin: string;

  constructor(server: string, private readonly token: string, private readonly request: typeof fetch = fetch) {
    let url: URL;
    try {
      url = new URL(server);
    } catch {
      throw new InventoryError("Mattermost server must be an HTTPS origin.");
    }
    if (url.protocol !== "https:" || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      throw new InventoryError("Mattermost server must be an HTTPS origin.");
    }
    this.origin = url.origin;
  }

  async get(path: string, params?: Record<string, number>): Promise<unknown> {
    const url = new URL(`/api/v4${path}`, this.origin);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (certificateError(error)) {
        throw new InventoryError("Mattermost TLS certificate verification failed. Check system trust and launch with npm start or npm run dev.");
      }
      throw new InventoryError("Mattermost read failed; check connectivity and server response.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new InventoryError(`Mattermost denied read access (HTTP ${response.status}); inventory may be incomplete for this credential.`);
    }
    if (!response.ok) {
      throw new InventoryError(`Mattermost read failed (HTTP ${response.status}).`);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new InventoryError("Mattermost read failed; check connectivity and server response.");
    }
  }

  async pages(path: string, objectKey?: string): Promise<RecordValue[]> {
    const found: RecordValue[] = [];
    let previousIds: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const payload = await this.get(path, { page, per_page: PAGE_SIZE });
      const items = records(objectKey && object(payload) ? payload[objectKey] : payload);
      const ids = JSON.stringify(items.map((item) => item.id ?? item.user_id ?? ""));
      if (items.length === PAGE_SIZE && ids === previousIds) {
        throw new InventoryError("Mattermost inventory pagination did not advance.");
      }
      found.push(...items);
      if (items.length < PAGE_SIZE) return found;
      previousIds = ids;
    }
    throw new InventoryError("Mattermost inventory exceeded the pagination limit.");
  }
}

/** One service adapter satisfies the narrow domain ports. */
export class MattermostInventory implements TeamReader, SeatReader, TeamMemberReader {
  constructor(private readonly api: MattermostClient) {}

  /** Active team members, bots and people alike; deactivated accounts count as absent. */
  async listTeamMembers(teamId: string): Promise<LiveMember[]> {
    const members = await this.api.pages(`/teams/${encodeURIComponent(teamId)}/members`);
    const ids = [...new Set(members.filter((member) => !member.delete_at).map((member) => text(member.user_id)).filter((id): id is string => !!id))];
    const result: LiveMember[] = [];
    for (const id of ids) {
      const user = await this.api.get(`/users/${encodeURIComponent(id)}`);
      if (!object(user)) throw new InventoryError("Mattermost returned an unexpected user record.");
      if (user.delete_at) continue;
      const username = text(user.username);
      if (!username) throw new InventoryError("Mattermost returned an unexpected user record.");
      result.push({ userId: id, username, position: typeof user.position === "string" ? user.position : "", isBot: user.is_bot === true });
    }
    return result;
  }

  async listTeams(): Promise<Team[]> {
    return (await this.api.pages("/teams")).map((item) => {
      const id = text(item.id);
      const slug = text(item.name);
      if (!id || !slug) throw new InventoryError("Mattermost returned an unexpected team record.");
      return { id, slug, displayName: text(item.display_name) ?? slug };
    });
  }

  async listSeats(team: Team): Promise<Seat[]> {
    if (!team.id) throw new InventoryError("Selected team has no ID in the Mattermost response.");
    const bots = await this.api.pages("/bots", "bots");
    const members = await this.api.pages(`/teams/${encodeURIComponent(team.id)}/members`);
    const memberIds = new Set(members.filter((member) => !member.delete_at).map((member) => text(member.user_id)).filter((id): id is string => !!id));
    const field = roleField(await this.api.get("/custom_profile_attributes/fields"));
    const seats: Seat[] = [];
    for (const bot of bots) {
      const id = text(bot.user_id);
      if (!id || !memberIds.has(id) || bot.delete_at) continue;
      const username = text(bot.username) ?? id;
      const seat: Seat = { id, username, displayName: text(bot.display_name) ?? username, roles: [] };
      try {
        seat.roles = roleValues(await this.api.get(`/users/${encodeURIComponent(id)}/custom_profile_attributes`), field);
      } catch (error) {
        if (!(error instanceof InventoryError)) throw error;
        seat.roleError = error.message;
      }
      seats.push(seat);
    }
    return seats;
  }
}
