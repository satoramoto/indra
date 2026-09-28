import { describe, expect, it, vi } from "vitest";
import { runConsistencyCheck } from "../src/cli.js";
import { compareTeam, type LiveMember } from "../src/consistency.js";
import { MattermostClient, MattermostInventory } from "../src/mattermost.js";
import { StateInventory, type StateSnapshot, type StateTeam } from "../src/state-domain.js";

const team: StateTeam = {
  id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "mm-team",
  seats: [
    { id: "seat-001", displayName: "Chick Corea", handle: "chickcorea", mattermostUserId: "u1", roles: ["Team Lead"] },
    { id: "seat-002", displayName: "George Duke", handle: "georgeduke", mattermostUserId: "u2", roles: ["Developer"] },
    { id: "seat-003", displayName: "Aaron Magner", handle: "aaronmagner", mattermostUserId: "u3", roles: ["Developer"] },
  ],
};

const matching: LiveMember[] = [
  { userId: "u1", username: "chickcorea", position: "Team Lead", isBot: true },
  { userId: "u2", username: "georgeduke", position: "Developer", isBot: true },
  { userId: "u3", username: "aaronmagner", position: " Developer ", isBot: true },
];

describe("Mattermost vs state comparison", () => {
  it("reports nothing when every seat matches", () => {
    expect(compareTeam(team, matching)).toEqual([]);
  });

  it("names the seat and field for each kind of mismatch", () => {
    const live: LiveMember[] = [
      { userId: "u1", username: "chick", position: "Team Lead", isBot: true },
      { userId: "u2", username: "georgeduke", position: "Product", isBot: true },
      { userId: "u9", username: "stray", position: "", isBot: true },
      { userId: "h1", username: "ryan", position: "", isBot: false },
    ];
    const result = compareTeam(team, live);
    expect(result.map((item) => [item.kind, item.seatId, item.field])).toEqual([
      ["username", "seat-001", "externalIdentities.mattermost.username"],
      ["position", "seat-002", "roles"],
      ["missing", "seat-003", "externalIdentities.mattermost.userId"],
      ["unexpected", undefined, "seats"],
      ["unexpected", undefined, "seats"],
    ]);
    expect(result[0].message).toBe("seat-001 (Chick Corea) externalIdentities.mattermost.username: state has 'chickcorea', Mattermost has 'chick'.");
    expect(result[1].message).toBe("seat-002 (George Duke) roles: state has 'Developer', Mattermost profile position is 'Product'.");
    expect(result[2].message).toContain("seat-003 (Aaron Magner) externalIdentities.mattermost.userId: user 'u3'");
    expect(result[3].message).toContain("Bot @stray (u9)");
    expect(result[4].message).toContain("User @ryan (h1)");
  });

  it("reports an empty position as a role mismatch", () => {
    const live = matching.map((member) => member.userId === "u1" ? { ...member, position: "" } : member);
    expect(compareTeam(team, live).map((item) => item.message)).toEqual([
      "seat-001 (Chick Corea) roles: state has 'Team Lead', Mattermost profile position is '(empty)'.",
    ]);
  });

  it("prints the report and exits non-zero only when something differs", async () => {
    const snapshot: StateSnapshot = { teams: [team], sprints: [] };
    const state = new StateInventory({ read: async () => snapshot });
    const lines: string[] = [];
    expect(await runConsistencyCheck(state, { listTeamMembers: async () => matching }, (line) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("Yahaha (yahaha) | matches state");
    lines.length = 0;
    const reader = { listTeamMembers: vi.fn(async () => matching.slice(1)) };
    expect(await runConsistencyCheck(state, reader, (line) => lines.push(line))).toBe(1);
    expect(reader.listTeamMembers).toHaveBeenCalledWith("mm-team");
    expect(lines.join("\n")).toContain("Yahaha (yahaha) | 1 mismatch");
    expect(lines.join("\n")).toContain("seat-001 (Chick Corea) externalIdentities.mattermost.userId");
  });
});

describe("Mattermost team member reader", () => {
  it("reads active members with GET only and skips removed or deactivated accounts", async () => {
    const routes: Record<string, unknown> = {
      "/teams/mm-team/members?page=0&per_page=100": [{ user_id: "u1" }, { user_id: "u2" }, { user_id: "gone", delete_at: 5 }, { user_id: "off" }],
      "/users/u1": { id: "u1", username: "chickcorea", position: "Team Lead", is_bot: true },
      "/users/u2": { id: "u2", username: "ryan", is_bot: false },
      "/users/off": { id: "off", username: "old", delete_at: 9 },
    };
    const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.pathname.replace("/api/v4", "")}${url.search}`;
      if (!(path in routes)) throw new Error(`Unexpected test request: ${path}`);
      return new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = new MattermostInventory(new MattermostClient("https://example.org", "secret", request as typeof fetch));
    expect(await adapter.listTeamMembers("mm-team")).toEqual([
      { userId: "u1", username: "chickcorea", position: "Team Lead", isBot: true },
      { userId: "u2", username: "ryan", position: "", isBot: false },
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
    }
  });
});
