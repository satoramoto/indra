// Run as a separate process by tests/state-commit.test.ts: `tsx state-writer.ts CHECKOUT LABEL COUNT`.
import { PlanningStore } from "../../src/planning.js";

const [checkout, label, count] = process.argv.slice(2);
const store = new PlanningStore(checkout);
for (let index = 0; index < Number(count); index++) {
  const id = `goal-${label}-${index}`;
  const now = new Date().toISOString();
  await store.update((state) => {
    state.planningGoals = [...(state.planningGoals ?? []), { id, teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Goal", projectRefs: [], stage: "clarifying", createdAt: now, updatedAt: now, mattermost: { channelId: "channel", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] } }];
  }, `Start planning goal ${id}`);
}
