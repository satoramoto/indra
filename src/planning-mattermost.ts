import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanningChat, Post, Reaction } from "./planning-bridge.js";

const execFileAsync = promisify(execFile);
const SERVER = "https://mattermost.newegypt.io";
/** 1Password reference for a seat's Mattermost bot token, named after the bot's username. */
export const botTokenRef = (username: string) => `op://Agent Rig/Mattermost bot - ${username}/token`;

export interface BotTokenOptions {
  ref?: string;
  /** 1Password service account token; set only in the environment of the `op read` subprocess. */
  serviceToken?: string;
  /** A hosted process has no desktop to prompt: without a service token it fails instead of calling `op`. */
  headless?: boolean;
}

export async function readBotToken(username: string, options: BotTokenOptions = {}): Promise<string> {
  const ref = options.ref ?? botTokenRef(username);
  if (options.headless && !options.serviceToken) throw new Error(`No 1Password service account token is staged for @${username}; start the terminal UI to stage it, then restart this process.`);
  try {
    const env = options.serviceToken ? { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: options.serviceToken } : process.env;
    const { stdout } = await execFileAsync("op", ["read", ref], { timeout: 30_000, encoding: "utf8", env });
    if (stdout.trim()) return stdout.trim();
  } catch { /* hide secret manager details */ }
  throw new Error(`1Password could not supply the bot token for @${username}. Expected item '${ref}'; check it exists and ${options.serviceToken ? "the service account's vault access" : "desktop authorization"}.`);
}

/** Chick's bot username; the planning bridge posts as this bot. */
export const CHICK_USERNAME = "chickcorea";

export async function readChickToken(options: Omit<BotTokenOptions, "ref"> = {}): Promise<string> {
  return await readBotToken(CHICK_USERNAME, { ...options, ref: process.env.INDRA_CHICK_TOKEN_REF ?? botTokenRef(CHICK_USERNAME) });
}

/** Mattermost refused this bot a team, channel or post; the message names the bot and the channel or team. */
export class MattermostAccessError extends Error { override name = "MattermostAccessError"; }

export class MattermostPlanningChat implements PlanningChat {
  /** `username` is the bot this token belongs to; it only names the bot in error messages. */
  constructor(private readonly token: string, private readonly username: string, private readonly request: typeof fetch = fetch) {}
  private async send(path: string, method = "GET", body?: unknown): Promise<Response> {
    const url = new URL(`/api/v4${path}`, SERVER);
    return await this.request(url, { method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  }
  private async call(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.send(path, method, body);
    if (!response.ok) throw new Error(`Mattermost ${method} failed (HTTP ${response.status}).`);
    return await response.json() as unknown;
  }
  /** GET only: true when the member record exists; Mattermost answers 403 or 404 to a non-member. */
  private async isMember(path: string): Promise<boolean> {
    const response = await this.send(path);
    if (response.ok) return true;
    if (response.status === 403 || response.status === 404) return false;
    throw new Error(`Mattermost GET failed (HTTP ${response.status}).`);
  }
  /**
   * Makes this bot a member of its team's Mattermost team and home channel, joining with its own token only when
   * a GET shows it is not one already. A refused join is a MattermostAccessError naming the bot and the channel.
   */
  async ensureHomeMembership(teamId: string, channelId: string): Promise<void> {
    const me = await this.ownUserId();
    const team = encodeURIComponent(teamId); const channel = encodeURIComponent(channelId); const user = encodeURIComponent(me);
    if (!await this.isMember(`/teams/${team}/members/${user}`)) {
      const response = await this.send(`/teams/${team}/members`, "POST", { team_id: teamId, user_id: me });
      if (!response.ok) throw new MattermostAccessError(`@${this.username} can't join the Mattermost team ${teamId} (HTTP ${response.status}): add it to the team.`);
    }
    if (!await this.isMember(`/channels/${channel}/members/${user}`)) {
      const response = await this.send(`/channels/${channel}/members`, "POST", { user_id: me });
      if (!response.ok) throw new MattermostAccessError(`@${this.username} can't join the home channel ${channelId} (HTTP ${response.status}): add it or make the channel public.`);
    }
  }
  async ownUserId(): Promise<string> { return (await this.call("/users/me") as { id: string }).id; }
  /** Mattermost omits `is_bot` for people, so only an explicit `true` marks a bot. */
  async isBot(userId: string): Promise<boolean> {
    const user = await this.call(`/users/${encodeURIComponent(userId)}`) as { id?: string; is_bot?: boolean };
    if (user.id !== userId) throw new Error("Mattermost returned an invalid user.");
    return user.is_bot === true;
  }
  async post(channelId: string, message: string, rootId?: string, deliveryId?: string): Promise<Post> {
    const response = await this.send("/posts", "POST", { channel_id: channelId, message, root_id: rootId ?? "", props: deliveryId ? { indra_delivery_id: deliveryId } : {} });
    if (response.status === 403) throw new MattermostAccessError(`@${this.username} can't post in channel ${channelId} (HTTP 403): add it to the channel or make the channel public.`);
    if (!response.ok) throw new Error(`Mattermost POST failed (HTTP ${response.status}).`);
    return await response.json() as Post;
  }
  /** GET only; Mattermost may answer `null` for a post without reactions. */
  async reactions(postId: string): Promise<Reaction[]> {
    const payload = await this.call(`/posts/${encodeURIComponent(postId)}/reactions`);
    if (payload === null) return [];
    if (!Array.isArray(payload)) throw new Error("Mattermost returned an invalid reaction list.");
    return (payload as Partial<Reaction>[]).filter((item): item is Reaction => typeof item?.user_id === "string" && typeof item.post_id === "string" && typeof item.emoji_name === "string" && typeof item.create_at === "number");
  }
  async since(channelId: string, timestamp: number): Promise<Post[]> {
    const payload = await this.call(`/channels/${encodeURIComponent(channelId)}/posts?since=${timestamp}`) as { order: string[]; posts: Record<string, Post> };
    if (!Array.isArray(payload.order) || !payload.posts) throw new Error("Mattermost returned an invalid post list.");
    return payload.order.map((id) => payload.posts[id]).filter(Boolean);
  }
}
