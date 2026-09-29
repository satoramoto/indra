import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { GOAL_INPUT_LIMIT, TerminalUiModel } from "../src/terminal-ui.js";
import { TerminalApp } from "../src/terminal-ui-solid.js";
import type { GoalStarter } from "../src/supervisor.js";
import { keyInput } from "../src/key-batch.js";

const names = ["Chick Corea", "George Duke", "Aaron Magner", "Corey Henry", "Jordan Rudess"];
const state: StateSnapshot = {
  teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "external-team", homeChannelId: "o9rogqxy7br1zkrcami681sray", project: { github: "satoramoto/indra" },
    seats: names.map((displayName, index) => ({ id: "seat-00" + (index + 1), displayName, handle: displayName.toLowerCase().replace(" ", ""), mattermostUserId: "user-" + (index + 1), roles: [index === 0 ? "Team Lead" : "Developer"] })),
  }],
  sprints: [{
    id: "sprint-001", teamId: "team-001", status: "draft", phase: "planning", goal: "Define and validate the first one-seat work cycle",
    proposedWork: [{ id: "work-001", title: "Draft the workflow", description: "Describe the handoff." }, { id: "work-002", title: "Review the workflow", description: "Record decisions." }],
    proposedAllocations: [{ seatId: "seat-001", workIds: ["work-001", "work-002"] }],
  }],
};
const goals: GoalStarter = { start: async () => "", approve: async () => { throw new Error("not used"); }, propose: async () => { throw new Error("not used"); } };

/** The goal input on the team page, through the same `keyInput` path `runTerminalUi` uses. */
async function goalInput() {
  const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, undefined, goals);
  await model.refresh();
  const [revision, setRevision] = createSignal(model.revision);
  const applyKey = keyInput(model, setRevision);
  const onKey = (name: string, _ctrl?: boolean, text?: string) => { applyKey(name, text); };
  const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={onKey} />, { width: 200, height: 50 });
  await setup.renderOnce();
  setup.renderer.stdin.emit("data", Buffer.from("n"));
  expect(model.input).toEqual({ value: "" });
  return { model, setup };
}

describe("goal input bursts and pastes", () => {
  it("accepts an unbracketed burst up to the limit in one stdin chunk and keeps responding", async () => {
    const { model, setup } = await goalInput();
    try {
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(200).slice(0, GOAL_INPUT_LIMIT);
      setup.renderer.stdin.emit("data", Buffer.from(text));
      await Promise.resolve();
      await setup.renderOnce();
      expect(model.input?.value).toBe(text);
      expect(setup.captureCharFrame()).toContain("Limit reached");
      // Keys after the burst still reach the model and the screen.
      setup.renderer.stdin.emit("data", Buffer.from("\x7f"));
      await Promise.resolve();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(`${GOAL_INPUT_LIMIT - 1}/${GOAL_INPUT_LIMIT}`);
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.renderOnce();
      expect(model.input).toBeUndefined();
      expect(setup.captureCharFrame()).toContain("n new goal");
    } finally { setup.renderer.destroy(); }
  });

  it("takes a bracketed paste into the goal input as one change, and ignores a paste when no input is open", async () => {
    const { model, setup } = await goalInput();
    try {
      await setup.mockInput.pasteBracketedText("Fix the paste\nfreeze\tnow");
      await Promise.resolve();
      await setup.renderOnce();
      expect(model.input?.value).toBe("Fix the paste freeze now");
      expect(setup.captureCharFrame()).toContain("New planning goal: Fix the paste freeze now▏");
      await setup.mockInput.pasteBracketedText("x".repeat(GOAL_INPUT_LIMIT + 500));
      expect(model.input?.value.length).toBe(GOAL_INPUT_LIMIT);
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(model.input).toBeUndefined();
      // Outside the input a paste changes nothing.
      await setup.mockInput.pasteBracketedText("q");
      expect(model.input).toBeUndefined();
      expect(model.notice).toBeUndefined();
    } finally { setup.renderer.destroy(); }
  });
});
