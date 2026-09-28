import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOptions } from "../src/cli.js";
import { LocalStateRepository, parseState, StateDataError } from "../src/local-state.js";
import { interactiveState, printState } from "../src/state-cli.js";
import { StateInventory } from "../src/state-domain.js";

const fixture = () => ({
  $schema: "./schema/v1/state.schema.json",
  schemaVersion: 1,
  teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha",
    externalIdentities: { mattermost: { teamId: "external-team" } },
    seats: [
      { id: "seat-001", displayName: "Chick Corea", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "external-user-1", username: "chickcorea" } } },
      { id: "seat-002", displayName: "Corey Henry", roles: ["Developer"], externalIdentities: { mattermost: { userId: "external-user-2", username: "coreyhenry" } } },
    ],
  }],
  sprints: [{
    id: "sprint-001", teamId: "team-001", status: "draft", phase: "planning",
    goal: "Agree on a first cycle.",
    proposedWork: [{ id: "work-001", title: "Describe the cycle", description: "Draft a reviewable proposal." }],
    proposedAllocations: [{ seatId: "seat-002", workIds: ["work-001"] }],
  }],
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function checkout(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "indra-state-test-"));
  dirs.push(dir);
  await writeFile(join(dir, "state.json"), JSON.stringify(value));
  return dir;
}

describe("local state checkout", () => {
  it("reads the seed shape into neutral records and clearly labels draft work", async () => {
    const inventory = new StateInventory(new LocalStateRepository(await checkout(fixture())));
    const snapshot = await inventory.current();
    expect(snapshot.teams[0].seats.map((seat) => seat.id)).toEqual(["seat-001", "seat-002"]);
    expect(snapshot.teams[0].seats[1]).toEqual({ id: "seat-002", displayName: "Corey Henry", handle: "coreyhenry", mattermostUserId: "external-user-2", roles: ["Developer"] });
    expect(snapshot.teams[0].mattermostTeamId).toBe("external-team");
    const output: string[] = [];
    printState(snapshot, "now", (line) => output.push(line));
    expect(output.join("\n")).toContain("Yahaha (yahaha) | 2 seats");
    expect(output.join("\n")).toContain("Sprint sprint-001 | status: DRAFT | phase: planning");
    expect(output.join("\n")).toContain("Proposed seat allocations (DRAFT; not approved or running)");
    expect(output.join("\n")).toContain("Corey Henry: work-001");
    expect(output.join("\n")).not.toContain("external-team");
  });

  it("rereads edits to Corey's roles and sprint phase on refresh", async () => {
    const dir = await checkout(fixture());
    const inventory = new StateInventory(new LocalStateRepository(dir));
    const output: string[] = [];
    let prompts = 0;
    await interactiveState(inventory, async () => {
      if (prompts++ === 0) {
        const edited = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as ReturnType<typeof fixture>;
        edited.teams[0].seats[0].roles = ["Developer"];
        edited.teams[0].seats[1].roles = ["Team Lead"];
        edited.sprints[0].phase = "review";
        await writeFile(join(dir, "state.json"), JSON.stringify(edited));
        return "r";
      }
      return "q";
    }, (line) => output.push(line));
    const text = output.join("\n");
    expect(text).toContain("Corey Henry (@coreyhenry) | Role: Developer\n");
    expect(text).toContain("Corey Henry (@coreyhenry) | Role: Team Lead");
    expect(text).toContain("phase: planning");
    expect(text).toContain("phase: review");
  });

  it("reports malformed JSON, unsupported version, shape, and bad references", async () => {
    const dir = await checkout(fixture());
    await writeFile(join(dir, "state.json"), "{bad");
    await expect(new LocalStateRepository(dir).read()).rejects.toThrow(/invalid JSON/);
    const bad = fixture();
    (bad as { schemaVersion: number }).schemaVersion = 2;
    expect(() => parseState(bad)).toThrow("Unsupported schemaVersion '2'");
    const missing = fixture();
    missing.teams[0].seats[1].roles = ["Developer", "Developer"];
    expect(() => parseState(missing)).toThrow("teams[0].seats[1].roles contains duplicate role 'Developer'");
    const badTeam = fixture();
    badTeam.sprints[0].teamId = "missing";
    expect(() => parseState(badTeam)).toThrow("sprints[0].teamId 'missing' does not match a team");
    const badSeat = fixture();
    badSeat.sprints[0].proposedAllocations[0].seatId = "absent";
    expect(() => parseState(badSeat)).toThrow("seatId 'absent' is not in team");
    const badWork = fixture();
    badWork.sprints[0].proposedAllocations[0].workIds = ["missing"];
    expect(() => parseState(badWork)).toThrow("unknown work ID 'missing'");
    const badStatus = fixture();
    badStatus.sprints[0].status = "approved";
    expect(() => parseState(badStatus)).toThrow("status must be 'draft'");
    const unknown = fixture() as ReturnType<typeof fixture> & { secrets?: string };
    unknown.secrets = "no";
    expect(() => parseState(unknown)).toThrow("state.json.secrets is not part of state schema v1");
  });

  it("explains a missing checkout without treating it as an empty team", async () => {
    const repository = new LocalStateRepository("/path/that/does/not/exist");
    const error = await repository.read().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StateDataError);
    expect(String(error)).toContain("Set --state PATH or INDRA_STATE_REPO");
  });

  it("selects state by default and keeps Mattermost opt-in", () => {
    expect(parseOptions([], "/tmp/fixture")).toEqual({ mode: "state", checkout: "/tmp/fixture", once: false });
    expect(parseOptions(["--state", "/tmp/explicit", "--once"], "/tmp/fixture")).toEqual({ mode: "state", checkout: "/tmp/explicit", once: true });
    expect(parseOptions(["--mattermost", "--team", "yahaha"])).toEqual({ mode: "mattermost", slug: "yahaha" });
    expect(() => parseOptions(["--team", "yahaha"])).toThrow("requires --mattermost");
    expect(parseOptions(["--mattermost", "--once"], "/tmp/fixture")).toEqual({ mode: "mattermost", checkout: "/tmp/fixture", once: true });
    expect(parseOptions(["--mattermost", "--state", "/tmp/explicit"], "/tmp/fixture")).toEqual({ mode: "mattermost", checkout: "/tmp/explicit", once: false });
    expect(() => parseOptions(["--mattermost", "--team", "yahaha", "--once"])).toThrow("Usage:");
    expect(() => parseOptions(["--mattermost", "--ui"])).toThrow("Usage:");
  });

  it("accepts an optional nonempty team planning channel", () => {
    const withChannel = fixture();
    Object.assign(withChannel.teams[0].externalIdentities.mattermost, { planningChannelId: "channel-1" });
    expect(() => parseState(withChannel)).not.toThrow();
    Object.assign(withChannel.teams[0].externalIdentities.mattermost, { planningChannelId: " " });
    expect(() => parseState(withChannel)).toThrow("teams[0].externalIdentities.mattermost.planningChannelId must be a nonempty string");
  });

  it("accepts only the Team Lead and Developer roles, one per seat", () => {
    const product = fixture();
    product.teams[0].seats[1].roles = ["Product"];
    expect(() => parseState(product)).toThrow("teams[0].seats[1].roles[0] 'Product' is not a seat role; expected 'Team Lead' or 'Developer'");
    const two = fixture();
    two.teams[0].seats[1].roles = ["Developer", "Team Lead"];
    expect(() => parseState(two)).toThrow("teams[0].seats[1].roles must contain exactly one role");
    const none = fixture();
    none.teams[0].seats[1].roles = [];
    expect(() => parseState(none)).toThrow("teams[0].seats[1].roles must contain exactly one role");
    const noLead = fixture();
    noLead.teams[0].seats[0].roles = ["Developer"];
    expect(() => parseState(noLead)).toThrow("teams[0].seats must contain exactly one 'Team Lead' seat; found 0");
    const twoLeads = fixture();
    twoLeads.teams[0].seats[1].roles = ["Team Lead"];
    expect(() => parseState(twoLeads)).toThrow("teams[0].seats must contain exactly one 'Team Lead' seat; found 2");
  });
});
