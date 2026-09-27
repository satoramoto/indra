import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanningChat, Post } from "./planning-bridge.js";

const execFileAsync = promisify(execFile);
const SERVER = "https://mattermost.newegypt.io";
const TYPING_SOCKET = "wss://mattermost.newegypt.io/api/v4/websocket";
const BOT_TOKEN_REF = "op://Agent Rig/Mattermost bot - chickcorea/token";

export async function readChickToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("op", ["read", process.env.INDRA_CHICK_TOKEN_REF ?? BOT_TOKEN_REF], { timeout: 30_000, encoding: "utf8" });
    if (stdout.trim()) return stdout.trim();
  } catch { /* hide secret manager details */ }
  throw new Error("1Password could not supply Chick's bot token. Check item field metadata and desktop authorization.");
}

export class MattermostPlanningChat implements PlanningChat {
  private typingSocket?: WebSocket;
  private typingReady?: Promise<WebSocket>;
  private typingSeq = 1;
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch, private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url)) {}
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

  private async connectTyping(): Promise<WebSocket> {
    if (this.typingSocket?.readyState === WebSocket.OPEN) return this.typingSocket;
    if (this.typingReady) return this.typingReady;
    let socket: WebSocket | undefined;
    const connection = (async () => {
      const opened = this.socketFactory(TYPING_SOCKET);
      socket = opened;
      this.typingSocket = opened;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Mattermost typing socket timed out.")), 2500);
        const open = () => { cleanup(); resolve(); };
        const error = () => { cleanup(); reject(new Error("Mattermost typing socket failed.")); };
        const cleanup = () => { clearTimeout(timer); opened.removeEventListener("open", open); opened.removeEventListener("error", error); };
        opened.addEventListener("open", open); opened.addEventListener("error", error);
      });
      await this.typingFrame(opened, "authentication_challenge", { token: this.token }, 1);
      return opened;
    })();
    const guarded = connection.catch((error: unknown) => {
      if (this.typingSocket === socket) {
        socket?.close();
        this.typingSocket = undefined;
      }
      throw error;
    }).finally(() => { if (this.typingReady === guarded) this.typingReady = undefined; });
    this.typingReady = guarded;
    return this.typingReady;
  }

  private async typingFrame(socket: WebSocket, action: string, data: Record<string, string>, seq: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Mattermost typing acknowledgement timed out.")); }, 2500);
      const message = (event: MessageEvent) => {
        try {
          const reply = JSON.parse(String(event.data)) as { seq_reply?: number; status?: string };
          if (reply.seq_reply !== seq) return;
          cleanup();
          reply.status === "OK" ? resolve() : reject(new Error("Mattermost typing action was rejected."));
        } catch { /* ignore unrelated events */ }
      };
      const abort = () => { cleanup(); reject(new Error("Mattermost typing was cancelled.")); };
      const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", message); signal?.removeEventListener("abort", abort); };
      socket.addEventListener("message", message);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { socket.send(JSON.stringify({ seq, action, data })); }
      catch { cleanup(); reject(new Error("Mattermost typing socket could not send.")); }
    });
  }

  async typing(channelId: string, rootPostId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const socket = await this.connectTyping();
    if (signal.aborted) return;
    await this.typingFrame(socket, "user_typing", { channel_id: channelId, parent_id: rootPostId }, ++this.typingSeq, signal);
  }

  stopTyping(): void {
    this.typingSocket?.close();
    this.typingSocket = undefined;
    this.typingReady = undefined;
    this.typingSeq = 1;
  }
}
