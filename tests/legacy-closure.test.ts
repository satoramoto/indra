import { describe, expect, it, vi } from "vitest";
import { closeLegacyGoals } from "../src/legacy-closure.js";
import { REMODEL_CLOSURE_GOALS, closeRemodelGoal, migrateLegacyCeremony, advanceCeremony, validateCeremony, validateCeremonyMutation } from "../src/ceremony.js";
import type { PlanningGoal, PlanningStore } from "../src/planning.js";
const at = "2026-09-01T00:00:00Z";
function stuck(id: keyof typeof REMODEL_CLOSURE_GOALS): PlanningGoal {
  const stage = REMODEL_CLOSURE_GOALS[id];
  const goal: PlanningGoal = { id, teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "Historical goal", projectRefs: ["owner/project"], stage: "approved", createdAt: at, updatedAt: at, mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-one", createdAt: at, summary: "Proposal", outcomes: [{ id: "outcome-one", seatId: "seat-dev", title: "Outcome", description: "Do it" }], risks: [], openQuestions: [] },
    assignments: [{ outcomeId: "outcome-one", seatId: "seat-dev", status: stage === "implement" ? "running" : "merged", updatedAt: at, ...(stage === "implement" ? {} : { prUrl: "https://github.com/owner/project/pull/1" }) }],
    integration: { branch: `sprint/${id}`, baseSha: "a".repeat(40), status: stage === "implement" ? "collecting" : "merged", ...(stage === "implement" ? {} : { prUrl: "https://github.com/owner/project/pull/2", mergedSha: "b".repeat(40) }) },
  };
  const migration = migrateLegacyCeremony(goal, at, true);
  if (migration.status !== "ready") throw new Error(migration.reason);
  goal.ceremony = migration.ceremony;
  if (stage === "retro") goal.ceremony = advanceCeremony(goal, { to: "retro", at, evidence: { kind: "release-running", prUrl: goal.integration!.prUrl!, mergedSha: "b".repeat(40), mergeVerification: { headSha: "a".repeat(40), reviewCommitSha: "a".repeat(40), reviewer: "satori-miyamoto", checksPassed: true }, checksPassed: true, buildSha: "b".repeat(40), runningSha: "b".repeat(40), runningAt: at } });
  return goal;
}
describe("remodel closure contract", () => {
  it("ships a no-op startup entry point that does not even read state", async () => {
    const read = vi.fn(() => { throw new Error("Must not read live state"); });
    expect(await closeLegacyGoals({ read } as unknown as PlanningStore)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(Object.keys(REMODEL_CLOSURE_GOALS) as (keyof typeof REMODEL_CLOSURE_GOALS)[])("closes only %s at its recorded stage without inventing history", (id) => {
    const goal = stuck(id); const history = structuredClone(goal.ceremony!.history);
    const closed = { ...goal, ceremony: closeRemodelGoal(goal, at) };
    expect(closed.ceremony.history).toEqual(history);
    expect(closed.ceremony.stage).toBe(REMODEL_CLOSURE_GOALS[id]);
    expect(closed.ceremony.closure?.evidence).toMatchObject({ kind: "remodel-closure", goalId: id, observed: { planningStage: "approved" } });
    expect(() => validateCeremonyMutation(goal, closed)).not.toThrow();
    expect(() => validateCeremony(closed)).not.toThrow();
    const forged = structuredClone(closed);
    if (forged.ceremony.closure!.evidence.kind !== "remodel-closure") throw new Error("Wrong evidence");
    forged.ceremony.closure!.evidence.observed.assignments = [];
    expect(() => validateCeremony(forged)).toThrow("observed");
  });
  it("refuses unknown goals and changes to workflow facts during closure", () => {
    const goal = stuck("goal-2b118e79");
    expect(() => closeRemodelGoal({ ...goal, id: "goal-other" }, at)).toThrow("six remodel");
    const closed = { ...goal, ceremony: closeRemodelGoal(goal, at), assignments: [] };
    expect(() => validateCeremonyMutation(goal, closed)).toThrow("observed workflow");
  });
});
