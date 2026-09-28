import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PlanningStore } from "../src/planning.js";
import { MattermostAccessError, MattermostPlanningChat } from "../src/planning-mattermost.js";
import { joinTeamHome } from "../src/cli.js";
import { readyFile } from "../src/tmux-host.js";
import { stateCheckout } from "./state-checkout.js";

const API = "https://mattermost.newegypt.io/api/v4";

/** A Mattermost server that knows one bot (`bot-id`) and which team and channel it belongs to. */
class FakeMattermost {
  requests: { method: string; path: string; body?: unknown }[] = [];
  teamMember = false;
  channelMember = false;
  /** Status for a join POST; anything but 201 refuses it. */
  joinStatus = 201;
  postStatus = 201;
  fetch: typeof fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(API, "");
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    this.requests.push({ method, path, ...(body ? { body } : {}) });
    const reply = (status: number, payload: unknown = {}) => new Response(JSON.stringify(payload), { status });
    if (method === "GET" && path === "/users/me") return reply(200, { id: "bot-id" });
    if (method === "GET" && path === "/teams/mm-team/members/bot-id") return this.teamMember ? reply(200, { user_id: "bot-id" }) : reply(403);
    if (method === "GET" && path === "/channels/home/members/bot-id") return this.channelMember ? reply(200, { user_id: "bot-id" }) : reply(404);
    if (method === "POST" && path === "/teams/mm-team/members") { if (this.joinStatus === 201) this.teamMember = true; return reply(this.joinStatus); }
    if (method === "POST" && path === "/channels/home/members") { if (this.joinStatus === 201) this.channelMember = true; return reply(this.joinStatus); }
    if (method === "POST" && path === "/posts") return reply(this.postStatus, { id: "p1" });
    return reply(500);
  };
  writes() { return this.requests.filter((item) => item.method !== "GET"); }
}

async function homedStore(): Promise<PlanningStore> {
  const seat = (id: string, role: string, username: string) => ({ id, displayName: username, roles: [role], externalIdentities: { mattermost: { userId: `${username}-id`, username } } });
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", project: { github: "satoramoto/indra" }, externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } }, seats: [seat("seat-001", "Team Lead", "chickcorea"), seat("seat-002", "Developer", "george")] }] };
  return new PlanningStore(await stateCheckout("indra-home-", state));
}

describe("bot home channel membership", () => {
  it("only checks with GET when the bot is already in the team and home channel", async () => {
    const mm = new FakeMattermost(); mm.teamMember = true; mm.channelMember = true;
    const store = await homedStore();
    await joinTeamHome(store.checkout, undefined, store, new MattermostPlanningChat("token", "chickcorea", mm.fetch), "chickcorea");
    expect(mm.writes()).toEqual([]);
    expect(mm.requests.map((item) => item.path)).toEqual(["/users/me", "/teams/mm-team/members/bot-id", "/channels/home/members/bot-id"]);
  });

  it("joins its own team and home channel with its own user ID, once", async () => {
    const mm = new FakeMattermost();
    const store = await homedStore();
    const chat = new MattermostPlanningChat("token", "george", mm.fetch);
    await joinTeamHome(store.checkout, undefined, store, chat, "george");
    expect(mm.writes()).toEqual([
      { method: "POST", path: "/teams/mm-team/members", body: { team_id: "mm-team", user_id: "bot-id" } },
      { method: "POST", path: "/channels/home/members", body: { user_id: "bot-id" } },
    ]);
    await joinTeamHome(store.checkout, undefined, store, chat, "george");
    expect(mm.writes()).toHaveLength(2);
  });

  it("reports a refused join by bot and channel, and signals no channel to the tmux host", async () => {
    const mm = new FakeMattermost(); mm.teamMember = true; mm.joinStatus = 403;
    const store = await homedStore();
    const nonce = "00000000-0000-4000-8000-000000000009";
    const failure = joinTeamHome(store.checkout, nonce, store, new MattermostPlanningChat("token", "chickcorea", mm.fetch), "chickcorea", 0);
    await expect(failure).rejects.toBeInstanceOf(MattermostAccessError);
    await expect(failure).rejects.toThrow("@chickcorea can't join the home channel home (HTTP 403): add it or make the channel public.");
    expect(JSON.parse(await readFile(readyFile(store.checkout, nonce), "utf8"))).toMatchObject({ nonce, error: "no-channel", message: expect.stringContaining("@chickcorea can't join the home channel home") });
  });

  it("names the bot when it cannot join the Mattermost team", async () => {
    const mm = new FakeMattermost(); mm.joinStatus = 403;
    await expect(new MattermostPlanningChat("token", "george", mm.fetch).ensureHomeMembership("mm-team", "home")).rejects.toThrow("@george can't join the Mattermost team mm-team (HTTP 403): add it to the team.");
    expect(mm.writes()).toHaveLength(1);
  });

  it("does nothing while state has no home channel", async () => {
    const mm = new FakeMattermost();
    const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "mm-team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick-id", username: "chickcorea" } } }] }] };
    const store = new PlanningStore(await stateCheckout("indra-home-", state));
    await joinTeamHome(store.checkout, undefined, store, new MattermostPlanningChat("token", "chickcorea", mm.fetch), "chickcorea");
    expect(mm.requests).toEqual([]);
  });

  it("turns a 403 on a post into a message naming the bot and channel", async () => {
    const mm = new FakeMattermost(); mm.postStatus = 403;
    const failure = new MattermostPlanningChat("token", "chickcorea", mm.fetch).post("home", "Hello");
    await expect(failure).rejects.toBeInstanceOf(MattermostAccessError);
    await expect(failure).rejects.toThrow("@chickcorea can't post in channel home (HTTP 403): add it to the channel or make the channel public.");
  });
});
