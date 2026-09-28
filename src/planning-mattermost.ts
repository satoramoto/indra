import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanningChat, Post } from "./planning-bridge.js";

const execFileAsync = promisify(execFile);
const SERVER = "https://mattermost.newegypt.io";
/** 1Password reference for a seat's Mattermost bot token, named after the bot's username. */
export const botTokenRef = (username: string) => `op://Agent Rig/Mattermost bot - ${username}/access_token`;

export async function readBotToken(username: string, ref = botTokenRef(username)): Promise<string> {
  try {
    const { stdout } = await execFileAsync("op", ["read", ref], { timeout: 30_000, encoding: "utf8" });
    if (stdout.trim()) return stdout.trim();
  } catch { /* hide secret manager details */ }
  throw new Error(`1Password could not supply the bot token for @${username}. Expected item '${ref}'; check it exists and desktop authorization.`);
}

export async function readChickToken(): Promise<string> {
  return await readBotToken("chickcorea", process.env.INDRA_CHICK_TOKEN_REF ?? botTokenRef("chickcorea"));
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
  async post(channelId: string, message: string, rootId?: string, deliveryId?: string): Promise<Post> {
    return await this.call("/posts", "POST", { channel_id: channelId, message, root_id: rootId ?? "", props: deliveryId ? { indra_delivery_id: deliveryId } : {} }) as Post;
  }
  async since(channelId: string, timestamp: number): Promise<Post[]> {
    const payload = await this.call(`/channels/${encodeURIComponent(channelId)}/posts?since=${timestamp}`) as { order: string[]; posts: Record<string, Post> };
    if (!Array.isArray(payload.order) || !payload.posts) throw new Error("Mattermost returned an invalid post list.");
    return payload.order.map((id) => payload.posts[id]).filter(Boolean);
  }
}
