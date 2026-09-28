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

export async function readChickToken(options: Omit<BotTokenOptions, "ref"> = {}): Promise<string> {
  return await readBotToken("chickcorea", { ...options, ref: process.env.INDRA_CHICK_TOKEN_REF ?? botTokenRef("chickcorea") });
}

export class MattermostPlanningChat implements PlanningChat {
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch) {}
  private async call(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const url = new URL(`/api/v4${path}`, SERVER);
    const response = await this.request(url, { method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Mattermost ${method} failed (HTTP ${response.status}).`);
    return await response.json() as unknown;
  }
  async ownUserId(): Promise<string> { return (await this.call("/users/me") as { id: string }).id; }
  /** Mattermost omits `is_bot` for people, so only an explicit `true` marks a bot. */
  async isBot(userId: string): Promise<boolean> {
    const user = await this.call(`/users/${encodeURIComponent(userId)}`) as { id?: string; is_bot?: boolean };
    if (user.id !== userId) throw new Error("Mattermost returned an invalid user.");
    return user.is_bot === true;
  }
  async post(channelId: string, message: string, rootId?: string, deliveryId?: string): Promise<Post> {
    return await this.call("/posts", "POST", { channel_id: channelId, message, root_id: rootId ?? "", props: deliveryId ? { indra_delivery_id: deliveryId } : {} }) as Post;
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
