import { describe, expect, it, vi } from "vitest";
import { Inventory, InventoryError, type Seat, type Team } from "../src/domain.js";
import { interactive } from "../src/cli.js";
import { MattermostClient, MattermostInventory, roleField, roleValues } from "../src/mattermost.js";

const ROLE = {
  id: "field-1", name: "Role", type: "multiselect",
  attrs: { options: [{ id: "lead", name: "Team Lead" }, { id: "dev", name: "Developer" }] },
};

type Route = unknown | number;

function fakeFetch(routes: Record<string, Route>) {
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace("/api/v4", "")}${url.search}`;
    if (!(path in routes)) throw new Error(`Unexpected test request: ${path}`);
    const result = routes[path];
    return new Response(typeof result === "number" ? null : JSON.stringify(result), {
      status: typeof result === "number" ? result : 200,
      headers: { "content-type": "application/json" },
    });
  });
  return request;
}

const client = (routes: Record<string, Route>) => new MattermostClient("https://example.org", "secret", fakeFetch(routes) as typeof fetch);

describe("Mattermost read adapter", () => {
  it("paginates GET requests and refuses redirects for credentials", async () => {
    const first = Array.from({ length: 100 }, (_, id) => ({ id: String(id) }));
    const request = fakeFetch({
      "/teams?page=0&per_page=100": first,
      "/teams?page=1&per_page=100": [{ id: "100" }],
    });
    const api = new MattermostClient("https://example.org", "secret", request as typeof fetch);
    expect(await api.pages("/teams")).toHaveLength(101);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, init] of request.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
    }
  });

  it("fails when a full page repeats", async () => {
    const page = Array.from({ length: 100 }, (_, id) => ({ id: String(id) }));
    await expect(client({
      "/bots?page=0&per_page=100": { bots: page },
      "/bots?page=1&per_page=100": { bots: page },
    }).pages("/bots", "bots")).rejects.toThrow("did not advance");
  });

  it("sanitizes denied access, redirects and invalid responses", async () => {
    const denied = await client({ "/bots": 403 }).get("/bots").catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(InventoryError);
    expect(String(denied)).toContain("inventory may be incomplete");
    expect(String(denied)).not.toContain("secret");
    await expect(client({ "/bots": 302 }).get("/bots")).rejects.toThrow("HTTP 302");
    await expect(client({ "/bots?page=0&per_page=100": {} }).pages("/bots", "bots")).rejects.toThrow("unexpected inventory response");
    expect(() => new MattermostClient("http://example.org", "secret")).toThrow("HTTPS origin");
  });

  it("resolves multiselect Role options from metadata and both value shapes", () => {
    const field = roleField([ROLE]);
    expect(roleValues({ "field-1": ["lead", "dev"] }, field)).toEqual(["Team Lead", "Developer"]);
    expect(roleValues([{ field_id: "field-1", value: '["dev"]' }], field)).toEqual(["Developer"]);
    expect(roleValues({ "field-1": ["new"] }, field)).toEqual(["Unknown option (new)"]);
    expect(() => roleField([])).toThrow("not visible");
    expect(() => roleValues({ "field-1": "[bad" }, field)).toThrow("malformed");
  });

  it("includes only active member bots and preserves a bot across teams", async () => {
    const api = client({
      "/bots?page=0&per_page=100": { bots: [
        { user_id: "a", username: "alice", display_name: "Alice" },
        { user_id: "b", username: "bob", display_name: "Bob" },
        { user_id: "c", username: "charlie", delete_at: 1 },
      ] },
      "/teams/one/members?page=0&per_page=100": [{ user_id: "a" }, { user_id: "b" }, { user_id: "c" }],
      "/teams/two/members?page=0&per_page=100": [{ user_id: "a" }],
      "/custom_profile_attributes/fields": [ROLE],
      "/users/a/custom_profile_attributes": { "field-1": ["lead", "dev"] },
      "/users/b/custom_profile_attributes": { "field-1": ["dev"] },
    });
    const adapter = new MattermostInventory(api);
    const inventory = new Inventory(adapter, adapter);
    const one: Team = { id: "one", slug: "one", displayName: "One" };
    const two: Team = { id: "two", slug: "two", displayName: "Two" };
    expect((await inventory.seats(one)).map((seat) => [seat.username, seat.roles])).toEqual([
      ["alice", ["Team Lead", "Developer"]], ["bob", ["Developer"]],
    ]);
    expect((await inventory.seats(two)).map((seat) => seat.username)).toEqual(["alice"]);
  });

  it("marks a profile failure as unavailable without claiming an empty Role", async () => {
    const adapter = new MattermostInventory(client({
      "/bots?page=0&per_page=100": { bots: [{ user_id: "a", username: "alice" }] },
      "/teams/one/members?page=0&per_page=100": [{ user_id: "a" }],
      "/custom_profile_attributes/fields": [ROLE],
      "/users/a/custom_profile_attributes": 403,
    }));
    const [seat] = await adapter.listSeats({ id: "one", slug: "one", displayName: "One" });
    expect(seat.roles).toEqual([]);
    expect(seat.roleError).toContain("incomplete");
  });
});

describe("service-neutral inventory and terminal flow", () => {
  it("sorts neutral team and seat records without an API payload", async () => {
    const teams: Team[] = [
      { id: "2", slug: "z", displayName: "Zed" },
      { id: "1", slug: "a", displayName: "Alpha" },
    ];
    const seats: Seat[] = [
      { id: "2", username: "z", displayName: "Zed", roles: [] },
      { id: "1", username: "a", displayName: "Alpha", roles: ["Developer"] },
    ];
    const inventory = new Inventory({ listTeams: async () => teams }, { listSeats: async () => seats });
    expect((await inventory.teams()).map((team) => team.slug)).toEqual(["a", "z"]);
    expect((await inventory.seats(teams[0])).map((seat) => seat.username)).toEqual(["a", "z"]);
  });

  it("navigates and refreshes teams and seats, showing currentness and occupancy", async () => {
    const team: Team = { id: "one", slug: "yahaha", displayName: "Yahaha" };
    let teamCalls = 0;
    let seatCalls = 0;
    const inventory = new Inventory(
      { listTeams: async () => { teamCalls++; return [team]; } },
      { listSeats: async () => { seatCalls++; return []; } },
    );
    const answers = ["1", "r", "b", "q"];
    const output: string[] = [];
    expect(await interactive(inventory, async () => answers.shift() ?? "q", (line) => output.push(line))).toBe(0);
    expect([teamCalls, seatCalls]).toEqual([2, 2]);
    expect(output.some((line) => line.includes("seats refreshed"))).toBe(true);
    expect(output.some((line) => line.includes("not connected yet"))).toBe(true);
  });
});
