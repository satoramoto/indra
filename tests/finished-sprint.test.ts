import { describe, expect, it } from "vitest";
import { isFinishedSprint } from "../src/finished-sprint.js";
import { projectSprint, type SessionSnapshot } from "../src/session-snapshot.js";
import type { PlanningGoal, SprintIntegration } from "../src/planning.js";
import { TerminalUiModel } from "../src/terminal-ui.js";
import { StateInventory } from "../src/state-domain.js";

type Status = NonNullable<PlanningGoal["assignments"]>[number]["status"];
const goal = (statuses: Status[], integration?: Partial<SprintIntegration>) => ({
  id: "g", teamId: "t", seatId: "s", participantSeatIds: [], goal: "x", projectRefs: [], stage: "approved", createdAt: "", updatedAt: "",
  mattermost: { channelId: "c", rootPostId: "r" }, brief: { summary: "", decisions: [], openQuestions: [] },
  proposal: { id: "p", createdAt: "", summary: "", risks: [], openQuestions: [], outcomes: statuses.map((_, i) => ({ id: `o${i}`, title: `o${i}` })) },
  assignments: statuses.map((status, i) => ({ outcomeId: `o${i}`, seatId: "s", status, updatedAt: "" })),
  ...(integration ? { integration: { branch: "sprint/g", baseSha: "abc", status: "collecting", ...integration } } : {}),
}) as unknown as PlanningGoal;
const finished = (statuses: Status[], integration?: Partial<SprintIntegration>) => isFinishedSprint(projectSprint(goal(statuses, integration)));

describe("isFinishedSprint", () => {
  it("finishes a legacy goal only when every assignment merged", () => {
    expect(finished(["merged", "merged", "merged", "merged"])).toBe(true);
    expect(finished(["merged", "failed"])).toBe(false);
    expect(finished(["merged", "running"])).toBe(false);
  });
  it("finishes merged and reverted integrations", () => {
    expect(finished(["merged"], { status: "merged" })).toBe(true);
    expect(finished(["merged"], { status: "reverted" })).toBe(true);
  });
  it("keeps collecting, pr-open and revert-open sprints visible", () => {
    expect(finished(["merged"], { status: "collecting" })).toBe(false);
    expect(finished(["merged"], { status: "pr-open" })).toBe(false);
    expect(finished(["merged"], { status: "merged", revertPrUrl: "https://github.com/o/r/pull/2" })).toBe(false);
  });
});

describe("team sprint list", () => {
  it("drops finished sprints from the team list but keeps them resolvable for the seat", async () => {
    const snapshot = { teams: [{ id: "t", slug: "t", displayName: "T", mattermostTeamId: "m", seats: [{ id: "s", displayName: "S", handle: "s", mattermostUserId: "u", roles: ["Developer"] }] }], sprints: [] };
    const session = (id: string, g: PlanningGoal, sprint?: "merged" | "collecting") => ({ id, teamId: "t", seatId: "s", status: "idle" as const, engine: "codex" as const,
      goal: id, stage: "approved", recentActivity: [], loop: projectSprint(g), ...(sprint ? { sprint } : {}) });
    const sessions: SessionSnapshot["sessions"] = [
      session("done", goal(["merged"], { status: "merged" }), "merged"),
      session("legacy", goal(["merged", "merged"])),
      session("live", goal(["running"], { status: "collecting" }), "collecting"),
    ];
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot as never }), { readSessions: async () => ({ connection: "connected", sessions }) });
    await model.refresh();
    model.teamId = "t";
    expect(model.sprintsForTeam().map((sprint) => sprint.id)).toEqual(["live"]);
    expect(model.sessionsFor("s").map((item) => item.id)).toEqual(["done", "legacy", "live"]);
  });
});
