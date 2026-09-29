import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { loadSeatPersonas, withPersonaChat, withPersonaRuntime } from "../src/seat-persona.js";
import type { AgentRuntime } from "../src/codex-runtime.js";
import type { PlanningChat } from "../src/planning-bridge.js";

// Persona tests own decoration/identity contracts, not Developer or Product workflow sequencing.
const profiles = JSON.parse(await readFile(new URL("../personas/yahaha.json", import.meta.url), "utf8")) as Record<string, { voice: string; background: string; funFact: string; postPrefix: string }>;
const ids = ["seat-001", "seat-002", "seat-003", "seat-004", "seat-005"];
describe("shared persona profiles", () => {
  it("loads all five stable identities without coupling their roles to a runner", async () => {
    expect(Object.keys(profiles).sort()).toEqual(ids);
    expect(await loadSeatPersonas()).toEqual(profiles);
    for (const profile of Object.values(profiles)) for (const value of Object.values(profile)) expect(value.trim()).not.toBe("");
    expect(new Set(Object.values(profiles).map((profile) => profile.voice)).size).toBe(5);
  });
  it.each(ids)("adds only %s's persona without changing engine/session/options or task instructions", async (id) => {
    const message = vi.fn<AgentRuntime["message"]>(async () => ({ sessionId: "session", startedAt: "2026-09-01T00:00:00Z", finishedAt: "2026-09-01T00:00:01Z", response: {} }));
    const runtime = withPersonaRuntime({ message }, profiles[id]);
    await runtime.message("Keep the exact goal and file ownership.", "goal-brief.json", "session", { timeoutMs: 123 });
    const [prompt, schema, session, options] = message.mock.calls[0];
    expect(prompt).toContain("Keep the exact goal and file ownership.");
    for (const field of [profiles[id].voice, profiles[id].background, profiles[id].funFact]) expect(prompt).toContain(field);
    for (const other of ids.filter((item) => item !== id)) expect(prompt).not.toContain(profiles[other].voice);
    expect([schema, session, options]).toEqual(["goal-brief.json", "session", { timeoutMs: 123 }]);
  });
  it.each(ids)("preserves %s's own-post delivery identity and factual content", async (id) => {
    const post = vi.fn<PlanningChat["post"]>(async (channel_id, message, root_id = "", delivery) => ({ id: "post", user_id: id, channel_id, root_id, message, create_at: 1, props: { indra_delivery_id: delivery } }));
    const chat = withPersonaChat({ post } as unknown as PlanningChat, profiles[id]);
    const result = await chat.post("home", "Approved goal is queued.", "root", "delivery");
    expect(post).toHaveBeenCalledWith("home", `${profiles[id].postPrefix}\n\nApproved goal is queued.`, "root", "delivery");
    expect(result).toMatchObject({ user_id: id, channel_id: "home", root_id: "root", props: { indra_delivery_id: "delivery" } });
  });
  it("leaves unknown identities undecorated", () => {
    const runtime = { message: vi.fn() }; const chat = { post: vi.fn() } as unknown as PlanningChat;
    expect(withPersonaRuntime(runtime, undefined)).toBe(runtime);
    expect(withPersonaChat(chat, undefined)).toBe(chat);
  });
});
