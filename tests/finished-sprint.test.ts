import { describe, expect, it } from "vitest";
import { isFinishedSprint } from "../src/finished-sprint.js";
import { projectSprint } from "../src/session-snapshot.js";
import type { PlanningGoal } from "../src/planning.js";

type Status = NonNullable<PlanningGoal["assignments"]>[number]["status"];
const goal = (statuses: Status[], integration?: NonNullable<PlanningGoal["integration"]>["status"]) => ({
  id: "g", teamId: "t", seatId: "s", participantSeatIds: [], goal: "x", projectRefs: [], stage: "approved", createdAt: "", updatedAt: "",
  mattermost: { channelId: "c", rootPostId: "r" }, brief: { summary: "", decisions: [], openQuestions: [] },
  proposal: { id: "p", createdAt: "", summary: "", risks: [], openQuestions: [], outcomes: statuses.map((_, i) => ({ id: `o${i}`, title: `o${i}` })) },
  assignments: statuses.map((status, i) => ({ outcomeId: `o${i}`, seatId: "s", status, updatedAt: "" })),
  ...(integration ? { integration: { branch: "sprint/g", baseSha: "abc", status: integration } } : {}),
}) as unknown as PlanningGoal;

describe("isFinishedSprint", () => {
  it("treats a legacy goal with every assignment merged or failed as finished", () => {
    expect(isFinishedSprint(projectSprint(goal(["merged", "merged", "failed", "merged"])))).toBe(true);
    expect(isFinishedSprint(projectSprint(goal(["merged", "running"])))).toBe(false);
  });
  it("treats merged and reverted integrations as finished", () => {
    expect(isFinishedSprint(projectSprint(goal(["merged"], "merged")))).toBe(true);
    expect(isFinishedSprint(projectSprint(goal(["merged"], "reverted")))).toBe(true);
  });
  it("keeps a collecting sprint visible even when its assignments all merged", () => {
    expect(isFinishedSprint(projectSprint(goal(["merged"], "collecting")))).toBe(false);
    expect(isFinishedSprint(projectSprint(goal(["merged"], "pr-open")))).toBe(false);
  });
});
