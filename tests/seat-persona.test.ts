import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSeatPersonas, personaPost, personaPrompt, SEAT_PERSONAS_FILE, withPersonaChat, withPersonaRuntime, type SeatPersona } from "../src/seat-persona.js";
import { PlanningBridge, type Post } from "../src/planning-bridge.js";
import { PlanningStore } from "../src/planning.js";
import { stateCheckout } from "./state-checkout.js";

const profile: SeatPersona = { voice: "Warm, curious and concise.", background: "A keyboard player who enjoys collaboration.", funFact: "The piano has 88 keys." };
const dirs: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), "indra-persona-")); dirs.push(dir); await mkdir(join(dir, "personas")); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("repository seat personas", () => {
  it.each(["src/seat-persona.ts", "dist/cli.js", "builds/abc123/cli.js"])("loads profiles from the application root for %s", async (path) => {
    const dir = await root(); const content = { "seat-001": { ...profile, postPrefix: "Let's find the next phrase." } };
    // The literal path belongs to the dependent persona outcome, independently of the loader's constant.
    await writeFile(join(dir, "personas", "yahaha.json"), JSON.stringify(content));
    expect(await loadSeatPersonas(pathToFileURL(join(dir, path)).href)).toEqual(content);
  });

  it("preserves behavior and object identity when profiles are missing", async () => {
    expect(await loadSeatPersonas(pathToFileURL(join(await root(), "src/seat-persona.ts")).href)).toEqual({});
    const runtime = { message: vi.fn() }; const chat = { post: vi.fn() };
    expect(withPersonaRuntime(runtime)).toBe(runtime); expect(withPersonaChat(chat)).toBe(chat);
    expect(personaPrompt("Exact prompt")).toBe("Exact prompt"); expect(personaPost("Exact post")).toBe("Exact post");
  });

  it.each(["null", "[]", "malformed", '{"seat-001":{"voice":"Hello"}}', JSON.stringify({ "seat-001": { ...profile, funFact: "" } }), JSON.stringify({ "seat-001": { ...profile, token: "private" } }), JSON.stringify({ "seat-001": { ...profile, postPrefix: null } }), JSON.stringify({ "seat-001": { ...profile, postPrefix: "" } })])("rejects malformed profiles without echoing their contents", async (value) => {
    const dir = await root(); await writeFile(join(dir, SEAT_PERSONAS_FILE), value);
    await expect(loadSeatPersonas(pathToFileURL(join(dir, "src/seat-persona.ts")).href)).rejects.toThrow("Invalid personas/yahaha.json");
  });

  it("distinguishes unreadable profiles from missing profiles", async () => {
    const dir = await root(); await mkdir(join(dir, SEAT_PERSONAS_FILE));
    await expect(loadSeatPersonas(pathToFileURL(join(dir, "src/seat-persona.ts")).href)).rejects.toThrow("Could not read");
  });

  it("decorates prompts while forwarding schema, handle, cancellation, timeout and result unchanged", async () => {
    const result = { sessionId: "original", response: {}, usage: { value: 1 }, startedAt: "start", finishedAt: "finish" };
    const runtime = { message: vi.fn().mockResolvedValue(result) }; const options = { signal: new AbortController().signal, timeoutMs: 42 };
    const prompt = "Do not merge. Work requires a person's approval. Return only JSON.";
    expect(await withPersonaRuntime(runtime, profile).message(prompt, "schema", "saved", options)).toBe(result);
    expect(runtime.message).toHaveBeenCalledWith(personaPrompt(prompt, profile), "schema", "saved", options);
    expect(personaPrompt(prompt, profile)).toMatch(/^Do not merge\. Work requires a person's approval\. Return only JSON\./);
    for (const field of Object.values(profile)) expect(personaPrompt(prompt, profile)).toContain(field);
  });

  it("forwards exact channel, root and delivery IDs and binds every original chat method", async () => {
    class Chat {
      private readonly own = "bot";
      post = vi.fn().mockResolvedValue({ id: "posted" });
      ownUserId() { return Promise.resolve(this.own); }
      since = vi.fn().mockResolvedValue([]);
      reactions = vi.fn().mockResolvedValue([]);
      isBot = vi.fn().mockResolvedValue(false);
      ensureHomeMembership = vi.fn().mockResolvedValue(undefined);
    }
    const chat = new Chat(); const decorated = withPersonaChat(chat, profile);
    const message = "No work has been approved or executed. A person reacts :white_check_mark: on this post.";
    expect(await decorated.post("channel", message, "root", "delivery")).toEqual({ id: "posted" });
    expect(chat.post).toHaveBeenCalledWith("channel", personaPost(message, profile), "root", "delivery");
    expect(personaPost(message, profile)).toMatch(/^No work has been approved or executed\./);
    expect(await decorated.ownUserId()).toBe("bot");
    await decorated.since("channel", 123); expect(chat.since).toHaveBeenCalledWith("channel", 123);
    await decorated.reactions("proposal"); expect(chat.reactions).toHaveBeenCalledWith("proposal");
    await decorated.isBot("person"); expect(chat.isBot).toHaveBeenCalledWith("person");
    await decorated.ensureHomeMembership("team", "home"); expect(chat.ensureHomeMembership).toHaveBeenCalledWith("team", "home");
  });

  it("uses the optional authored post prefix without changing authorization text or delivery arguments", async () => {
    const content = { ...profile, postPrefix: "One useful step at a time." };
    const post = vi.fn().mockResolvedValue({ id: "delivered" });
    const message = "No work has been approved or executed. A person reacts :white_check_mark: on this post.";
    await withPersonaChat({ post }, content).post("home", message, "root", "delivery");
    expect(post).toHaveBeenCalledWith("home", `${content.postPrefix}\n\n${message}`, "root", "delivery");
  });

  it("recovers a pending delivery by its original marker after a post succeeded but the connection failed", async () => {
    const seat = { id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } };
    const checkout = await stateCheckout("indra-persona-delivery-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", project: { github: "satoramoto/indra" }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [seat] }], sprints: [] });
    dirs.push(checkout, `${checkout}.runtime`);
    const store = new PlanningStore(checkout); const posts: Post[] = [];
    const chat = {
      ownUserId: async () => "chick", reactions: async () => [], isBot: async () => false,
      since: async () => posts,
      post: vi.fn(async (channel: string, message: string, root = "", delivery?: string) => {
        const post: Post = { id: `post-${posts.length}`, channel_id: channel, message, root_id: root, user_id: "chick", create_at: Date.now(), props: { indra_delivery_id: delivery } };
        posts.push(post);
        if (delivery && root) throw new Error("Response lost after server accepted delivery");
        return post;
      }),
    };
    const runtime = { message: vi.fn().mockResolvedValue({ sessionId: "original", usage: { inputTokens: 1, outputTokens: 1 }, response: { summary: "Brief", reply: "What matters?", decisions: [], openQuestions: [] }, startedAt: "start", finishedAt: "finish" }) };
    const bridge = new PlanningBridge(store, withPersonaChat(chat, { ...profile, postPrefix: "First phrase." }), withPersonaRuntime(runtime, profile));
    await expect(bridge.start("Plan a feature", [])).rejects.toThrow("Response lost");
    const goal = (await store.read()).planningGoals![0];
    expect((await store.runtime(goal.id)).pending).toBeDefined();
    await new PlanningBridge(store, withPersonaChat(chat, { ...profile, postPrefix: "A changed phrase." }), withPersonaRuntime(runtime, profile)).poll();
    expect(chat.post).toHaveBeenCalledTimes(2); expect(runtime.message).toHaveBeenCalledTimes(1);
    expect((await store.runtime(goal.id)).pending).toBeUndefined();
    expect(posts[1].props?.indra_delivery_id).toBeDefined(); expect(posts[1].root_id).toBe(posts[0].id);
  });
});
