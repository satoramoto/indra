import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { CEREMONY_SCHEMA_DEFS, startCeremony } from "../src/ceremony.js";
import { parseState } from "../src/local-state.js";
import { TEAM_SCHEMA_DEFS } from "../src/state-domain.js";

const schema = JSON.parse(await readFile(new URL("../schema/v1/state.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false }); addFormats.default(ajv);
const validate = ajv.compile(schema);
const time = "2026-09-01T00:00:00Z";
function fixture() {
  return { $schema: "./schema/v1/state.schema.json", schemaVersion: 1,
    teams: [{ id: "team-one", slug: "team-one", displayName: "Team", project: { github: "owner/project" }, externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [{ id: "seat-one", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chick" } } }] }],
    sprints: [], planningGoals: [{ id: "goal-one", teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "Goal", projectRefs: ["owner/project"], stage: "clarifying", createdAt: time, updatedAt: time, mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] }, ceremony: startCeremony(time) }],
  };
}
function valid(value: unknown): void {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  expect(() => parseState(value)).not.toThrow();
}

describe("additive ceremony v1 schema contract", () => {
  it("ships the exact shared definitions for the companion indra-state schema", () => {
    for (const [name, definition] of Object.entries(CEREMONY_SCHEMA_DEFS)) expect(schema.$defs[name]).toEqual(definition);
    for (const [name, definition] of Object.entries(TEAM_SCHEMA_DEFS)) expect(schema.$defs[name]).toEqual(definition);
    expect(schema.$defs.planningGoal.properties.ceremony).toEqual({ $ref: "#/$defs/ceremony" });
    expect(schema.properties.schemaVersion).toEqual({ const: 1 });
  });
  it("accepts Product and pending identities, and requires identities for active or retiring seats", () => {
    const value = fixture();
    const pending = { id: "seat-product", displayName: "Product", roles: ["Product"], status: "pending", externalIdentities: { mattermost: { username: "product" } } };
    Object.assign(value.teams[0], { seats: [...value.teams[0].seats, pending], mission: "Owner mission", standingPolicy: { revisions: [{ revision: 1, source: "owner-command", enabled: false, at: time }] } });
    valid(value);
    for (const status of ["active", "retiring", "unknown"]) {
      pending.status = status;
      expect(validate(value)).toBe(false);
      expect(() => parseState(value)).toThrow();
    }
    pending.status = "pending";
    Object.assign(pending, { sessionId: "runtime-only" });
    expect(validate(value)).toBe(false);
  });
  it("requires complete automatic targets with a policy revision and reviewed PR head", () => {
    const validate = ajv.compile({ $defs: schema.$defs, $ref: "#/$defs/ceremonyAutomaticApproval" });
    const proposal = { source: "automatic", policyRevision: 1, at: time, target: { kind: "proposal", goalId: "goal-one", proposalId: "proposal-one", proposalDigest: "a".repeat(64) } };
    const merge = { ...proposal, target: { kind: "integration", goalId: "goal-one", prUrl: "https://github.com/owner/project/pull/1", headSha: "a".repeat(40), reviewedHeadSha: "a".repeat(40), checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto" } };
    expect(validate(proposal)).toBe(true); expect(validate(merge)).toBe(true);
    for (const record of [proposal, merge]) for (const key of ["policyRevision", "target", "at"]) {
      const invalid = structuredClone(record); Reflect.deleteProperty(invalid, key); expect(validate(invalid)).toBe(false);
    }
    for (const key of ["prUrl", "headSha", "reviewedHeadSha", "checksPassed", "reviewApproved", "reviewer"]) {
      const invalid = structuredClone(merge); Reflect.deleteProperty(invalid.target, key); expect(validate(invalid)).toBe(false);
    }
    expect(validate({ ...proposal, policyRevision: 0 })).toBe(false);
    expect(validate({ ...merge, target: { ...merge.target, checksPassed: false } })).toBe(false);
    expect(validate({ ...merge, target: { ...merge.target, kind: "revert" } })).toBe(false);
    const invalid = structuredClone(proposal); Reflect.deleteProperty(invalid.target, "proposalDigest"); expect(validate(invalid)).toBe(false);
  });
  it("accepts existing v1 documents and legacy goals as well as the new optional ceremony", () => {
    valid(fixture());
    const legacy = fixture(); Reflect.deleteProperty(legacy.planningGoals[0], "ceremony"); valid(legacy);
    const older = fixture(); Reflect.deleteProperty(older, "planningGoals"); valid(older);
  });
  it.each(["sessionId", "usage", "processedPostIds", "proposalPostIds", "deliveredStages", "pending"])("rejects runtime bookkeeping %s in state, goals, ceremony and history", (key) => {
    for (const location of ["state", "goal", "ceremony", "entry"] as const) {
      const value = fixture();
      const target = location === "state" ? value : location === "goal" ? value.planningGoals[0] : location === "ceremony" ? value.planningGoals[0].ceremony : value.planningGoals[0].ceremony.history[0];
      Object.assign(target, { [key]: "runtime-only" });
      expect(validate(value)).toBe(false);
      expect(() => parseState(value)).toThrow();
    }
  });
  it("rejects a sixth stage, skipped prefixes, premature closure and unknown native history", () => {
    for (const mutate of [
      (value: ReturnType<typeof fixture>) => { Object.assign(value.planningGoals[0].ceremony, { stage: "closed" }); },
      (value: ReturnType<typeof fixture>) => { Object.assign(value.planningGoals[0].ceremony, { stage: "proposal" }); },
      (value: ReturnType<typeof fixture>) => { value.planningGoals[0].ceremony.history[0].enteredAt = null; },
      (value: ReturnType<typeof fixture>) => { Object.assign(value.planningGoals[0].ceremony, { closure: { closedAt: time, evidence: { kind: "retro-published", path: "docs/retros/goal-one.md", prUrl: "https://github.com/owner/project/pull/1", baseBranch: "main", mergedSha: "a".repeat(40), postId: "retro", publishedAt: time, factsOnly: true, suggestions: "owner-proposals-only" } } }); },
    ]) {
      const value = fixture(); mutate(value);
      expect(validate(value)).toBe(false);
      expect(() => parseState(value)).toThrow();
    }
  });
  it("allows unknown historical entry times only with explicit migration provenance", () => {
    const value = fixture(); value.planningGoals[0].ceremony.migratedAt = time;
    value.planningGoals[0].ceremony.history[0].enteredAt = null;
    valid(value);
  });
  it("rejects a non-human approval and incomplete completion evidence at the schema boundary", () => {
    const proof = (name: string, value: unknown) => ajv.compile({ $defs: schema.$defs, $ref: `#/$defs/${name}` })(value);
    expect(proof("ceremonyHumanApproval", { source: "reaction", userId: "person", postId: "proposal", emoji: "white_check_mark", verifiedHuman: false, at: time })).toBe(false);
    expect(proof("ceremonyHumanApproval", { source: "automatic", at: time })).toBe(false);
    expect(proof("ceremonyImplementation", { kind: "implementation", outcomes: [] })).toBe(false);
    expect(proof("ceremonyRelease", { kind: "release-running", mergedSha: "a".repeat(40) })).toBe(false);
    expect(proof("ceremonyRetro", { kind: "retro-published", path: "docs/retros/goal-one.md" })).toBe(false);
  });
  it("accepts exact release builds and verified ancestry proof, rejecting incomplete or unverified proof", () => {
    const proof = ajv.compile({ $defs: schema.$defs, $ref: "#/$defs/ceremonyRelease" });
    const release = { kind: "release-running", prUrl: "https://github.com/owner/project/pull/2", mergedSha: "a".repeat(40), mergePostId: "merge-post",
      approval: { source: "owner-command", command: "planning merge", at: time }, checksPassed: true, buildSha: "a".repeat(40), runningSha: "a".repeat(40), runningAt: time };
    expect(proof(release)).toBe(true);
    const ancestry = { ancestorSha: release.mergedSha, descendantSha: "b".repeat(40), verified: true };
    const descendant = { ...release, buildSha: ancestry.descendantSha, runningSha: ancestry.descendantSha, ancestry };
    expect(proof(descendant)).toBe(true);
    for (const invalid of [
      { ...ancestry, verified: false },
      { ancestorSha: ancestry.ancestorSha, descendantSha: ancestry.descendantSha },
      { ...ancestry, ancestorSha: "" },
      { ...ancestry, descendantSha: "" },
      { ...ancestry, sessionId: "runtime-only" },
    ]) expect(proof({ ...descendant, ancestry: invalid })).toBe(false);
  });
});
