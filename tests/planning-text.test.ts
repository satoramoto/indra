import { describe, expect, it } from "vitest";
import type { ImplementationEvidence } from "../src/ceremony.js";
import type { PlanningGoal } from "../src/planning.js";
import { APPROVE_EMOJI, PROPOSE_EMOJI } from "../src/planning-bridge.js";
import { approvalMessage, integrationMessage, prompt, proposalMessage, revertMessage, rootMessage, sprintSummary } from "../src/planning-text.js";

const at = "2026-01-01T00:00:00Z";
const seats = new Map([["seat-003", "Aaron Magner"], ["seat-004", "Corey Henry"]]);
const developers = [{ id: "seat-004", displayName: "Corey Henry" }, { id: "seat-003", displayName: "Aaron Magner" }];
const omissions: NonNullable<ImplementationEvidence["omissions"]> = [
  { outcomeId: "outcome-2", seatId: "seat-004", reason: "Owner chose a smaller release." },
  { outcomeId: "outcome-3", seatId: "seat-999", reason: "Owner deferred this.\nKeep the reason." },
];

function goal(): PlanningGoal {
  return {
    id: "goal-text", teamId: "team-001", seatId: "seat-001", participantSeatIds: [],
    goal: "Keep output stable.\nPreserve **formatting**.", projectRefs: ["test/second", "test/first"],
    stage: "approved", createdAt: at, updatedAt: at, mattermost: { channelId: "channel", rootPostId: "root" },
    brief: { summary: 'Keep "quoted" text.\nSecond line.', decisions: ["Spacing stays.", "Keep seat order."], openQuestions: ["Which outcome?"] },
    proposal: { id: "proposal-text", createdAt: at, summary: "Two steps.\nKeep the order.", risks: ["Not shown in the post."], openQuestions: ["Also not shown."], outcomes: [
      { id: "outcome-2", title: "Second outcome", description: "Touch src/b.ts.\nKeep its newline.", seatId: "seat-004" },
      { id: "outcome-1", title: "First outcome", description: "Touch src/a.ts.", seatId: "seat-003" },
      { id: "outcome-3", title: "Unknown seat", description: "Keep the seat ID.", seatId: "seat-999" },
    ] },
    assignments: [
      { outcomeId: "outcome-1", seatId: "seat-003", status: "merged", prUrl: "https://github.com/test/project/pull/1", updatedAt: at },
      { outcomeId: "outcome-3", seatId: "seat-999", status: "merged", updatedAt: at },
      { outcomeId: "outcome-2", seatId: "seat-004", status: "failed", note: "Checks failed.\nRetry later.", prUrl: "https://github.com/test/project/pull/2", updatedAt: at },
      { outcomeId: "missing-outcome", seatId: "seat-003", status: "failed", updatedAt: at },
      { outcomeId: "queued-outcome", seatId: "seat-004", status: "queued", prUrl: "https://github.com/test/project/pull/3", updatedAt: at },
      { outcomeId: "running-outcome", seatId: "seat-999", status: "running", updatedAt: at },
      { outcomeId: "review-outcome", seatId: "seat-003", status: "in-review", prUrl: "https://github.com/test/project/pull/4", updatedAt: at },
    ],
    integration: { branch: "sprint/goal-text", baseSha: "a".repeat(40), status: "merged", prUrl: "https://github.com/test/project/pull/9", mergedSha: "1234567890abcdef1234567890abcdef12345678" },
  };
}

// Fixed text checked against the original bridge before extracting its renderers.
describe("planning text", () => {
  it("keeps the bridge's public reaction constants", () => {
    expect(PROPOSE_EMOJI).toBe("memo");
    expect(APPROVE_EMOJI).toBe("white_check_mark");
  });

  it("renders the root post without trimming the goal", () => {
    expect(rootMessage("goal-text", "  Keep output stable.\nPreserve **formatting**.\n")).toBe(`**Planning goal goal-text — Chick**
**Stage: planning**
  Keep output stable.
Preserve **formatting**.


Reply here to clarify. React :memo: on this post to request a draft proposal for review.`);
  });

  it("renders proposal order, multiline text and known and unknown seat labels", () => {
    expect(proposalMessage(goal(), seats)).toBe(`**Draft proposal proposal-text — awaiting review**
Two steps.
Keep the order.
- **Second outcome** → Corey Henry (seat-004): Touch src/b.ts.
Keep its newline.
- **First outcome** → Aaron Magner (seat-003): Touch src/a.ts.
- **Unknown seat** → seat-999: Keep the seat ID.

Recorded in indra-state as goal-text. No work has been approved or executed. To approve it, a person reacts :white_check_mark: on this post.`);
  });

  it("renders approval in assignment order with title fallbacks and the sprint branch", () => {
    expect(approvalMessage(goal(), seats)).toBe(`**Proposal proposal-text approved**
- First outcome → Aaron Magner (seat-003)
- Unknown seat → seat-999
- Second outcome → Corey Henry (seat-004)
- missing-outcome → Aaron Magner (seat-003)
- queued-outcome → Corey Henry (seat-004)
- running-outcome → seat-999
- review-outcome → Aaron Magner (seat-003)

Recorded in indra-state as goal-text. Each outcome is queued for its Developer seat. Their PRs target \`sprint/goal-text\`; once every outcome merges, Chick opens one PR from it into main.`);
  });

  it("renders legacy approval without a sprint branch", () => {
    const value = goal();
    delete value.integration;
    value.assignments = [value.assignments![0]];
    expect(approvalMessage(value, seats)).toBe(`**Proposal proposal-text approved**
- First outcome → Aaron Magner (seat-003)

Recorded in indra-state as goal-text. Each outcome is queued for its Developer seat.`);
  });

  it.each([{ assignments: undefined }, { assignments: [] }])("keeps blank lines in approval without assignments (%j)", ({ assignments }) => {
    expect(approvalMessage({ ...goal(), assignments, integration: undefined }, seats)).toBe(`**Proposal proposal-text approved**


Recorded in indra-state as goal-text. Each outcome is queued for its Developer seat.`);
  });

  it("renders the PR body with merged, failed, queued, running and review outcomes", () => {
    expect(sprintSummary(goal(), seats, undefined)).toBe(`Sprint integration for planning goal goal-text.

**Goal:** Keep output stable.
Preserve **formatting**.

**Outcomes**
- **First outcome** → Aaron Magner (seat-003): https://github.com/test/project/pull/1
- **Unknown seat** → seat-999: merged

**Failed or skipped**
- **Second outcome** → Corey Henry (seat-004): failed (Checks failed.
Retry later.) https://github.com/test/project/pull/2
- **missing-outcome** → Aaron Magner (seat-003): failed
- **queued-outcome** → Corey Henry (seat-004): skipped (queued) https://github.com/test/project/pull/3
- **running-outcome** → seat-999: skipped (running)
- **review-outcome** → Aaron Magner (seat-003): skipped (in-review) https://github.com/test/project/pull/4

Merging this PR lands the whole sprint on main; \`planning rollback --goal goal-text\` reverts it as a unit.`);
  });

  it("uses the recorded omission reason before status, note or PR and keeps assignment order", () => {
    expect(sprintSummary(goal(), seats, omissions)).toBe(`Sprint integration for planning goal goal-text.

**Goal:** Keep output stable.
Preserve **formatting**.

**Outcomes**
- **First outcome** → Aaron Magner (seat-003): https://github.com/test/project/pull/1

**Failed or skipped**
- **Unknown seat** → seat-999: omitted by owner (Owner deferred this.
Keep the reason.)
- **Second outcome** → Corey Henry (seat-004): omitted by owner (Owner chose a smaller release.)
- **missing-outcome** → Aaron Magner (seat-003): failed
- **queued-outcome** → Corey Henry (seat-004): skipped (queued) https://github.com/test/project/pull/3
- **running-outcome** → seat-999: skipped (running)
- **review-outcome** → Aaron Magner (seat-003): skipped (in-review) https://github.com/test/project/pull/4

Merging this PR lands the whole sprint on main; \`planning rollback --goal goal-text\` reverts it as a unit.`);
  });

  it("omits the failed section when every assignment merged", () => {
    const value = goal();
    value.assignments = value.assignments!.slice(0, 2);
    expect(sprintSummary(value, seats, undefined)).toBe(`Sprint integration for planning goal goal-text.

**Goal:** Keep output stable.
Preserve **formatting**.

**Outcomes**
- **First outcome** → Aaron Magner (seat-003): https://github.com/test/project/pull/1
- **Unknown seat** → seat-999: merged

Merging this PR lands the whole sprint on main; \`planning rollback --goal goal-text\` reverts it as a unit.`);
  });

  it.each([{ assignments: undefined }, { assignments: [] }])("renders the PR body without assignments (%j)", ({ assignments }) => {
    expect(sprintSummary({ ...goal(), assignments }, seats, undefined)).toBe(`Sprint integration for planning goal goal-text.

**Goal:** Keep output stable.
Preserve **formatting**.

**Outcomes**
- none

Merging this PR lands the whole sprint on main; \`planning rollback --goal goal-text\` reverts it as a unit.`);
  });

  it("keeps the failed section when nothing merged", () => {
    const value = goal();
    value.assignments = [value.assignments![3]];
    expect(sprintSummary(value, seats, undefined)).toBe(`Sprint integration for planning goal goal-text.

**Goal:** Keep output stable.
Preserve **formatting**.

**Outcomes**
- none

**Failed or skipped**
- **missing-outcome** → Aaron Magner (seat-003): failed

Merging this PR lands the whole sprint on main; \`planning rollback --goal goal-text\` reverts it as a unit.`);
  });

  it.each([{ selected: undefined }, { selected: [] }])("renders integration without omissions (%j)", ({ selected }) => {
    expect(integrationMessage(goal(), "https://github.com/test/project/pull/9", selected)).toBe(`**Sprint goal-text is ready: https://github.com/test/project/pull/9**
This PR takes \`sprint/goal-text\` into main. The sprint merges automatically after a fresh satori-miyamoto approval on the current head and green CI. Release then verifies the running build; the retro is posted and archived through the same review and CI gate.`);
  });

  it("renders integration with omissions in their recorded order", () => {
    expect(integrationMessage(goal(), "https://github.com/test/project/pull/9", omissions)).toBe(`**Sprint goal-text is ready: https://github.com/test/project/pull/9**
This PR takes \`sprint/goal-text\` into main. The sprint merges automatically after a fresh satori-miyamoto approval on the current head and green CI. Release then verifies the running build; the retro is posted and archived through the same review and CI gate.

**Owner-authorized omissions**
- outcome-2: Owner chose a smaller release.
- outcome-3: Owner deferred this.
Keep the reason.`);
  });

  it("renders the revert post with the seven-character merge SHA", () => {
    expect(revertMessage(goal(), "https://github.com/test/project/pull/10")).toBe(`**Rollback of sprint goal-text: https://github.com/test/project/pull/10**
This PR on main reverts the sprint's merge commit 1234567. The revert merges automatically after a fresh satori-miyamoto approval on the current head and green CI.`);
  });

  it("renders the clarification prompt with the exact serialized brief and human whitespace", () => {
    expect(prompt(goal(), "  Clarify this.\nKeep the newline.\n", false, developers)).toBe(`You are Chick Corea, the Team Lead seat in Indra. This is planning only.
Outcome: a reply to the human message and an updated durable brief. Acceptance: decisions hold agreed facts only, and openQuestions names what is still unclear.
Afterwards Indra posts your reply in the goal thread and keeps the brief for the next message and the draft.
Return only JSON with keys reply, summary, decisions (agreed facts only), openQuestions.
Constraints: do not edit files, run implementation, deploy, or claim approval. Never put credentials in your output.
Goal: Keep output stable.
Preserve **formatting**.
Projects: test/second, test/first
Current brief: {"summary":"Keep \\"quoted\\" text.\\nSecond line.","decisions":["Spacing stays.","Keep seat order."],"openQuestions":["Which outcome?"]}
Human message:   Clarify this.
Keep the newline.
`);
  });

  it("renders the draft prompt with Developer seats in the supplied order", () => {
    expect(prompt(goal(), "Draft now.", true, developers)).toBe(`You are Chick Corea, the Team Lead seat in Indra. This is planning only.
Outcome: a proposed outcome-based roadmap for this goal. This is a draft for human review.
Acceptance: each outcome is small, focused on one concern, and independently verifiable; its description states its acceptance criteria and targeted tests. Keep outcomes roughly equal in size. In each outcome's description, list every file it will touch, including test files. Outcomes assigned to different seats must not touch the same file. Name each dependency by outcome title and owning seat ID, and state the order in which dependent work must land. For any shared-file wiring, name one owning outcome and seat; list its files only under that owner and make the other outcomes depend on it. Assign every outcome to one of these Developer seats by its seat ID: seat-004 (Corey Henry), seat-003 (Aaron Magner). Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.
Afterwards Indra posts the draft in the goal thread. Nothing starts until a person approves it; then Indra queues each outcome for its Developer seat.
Return only JSON with keys summary, outcomes (title, description and seatId), risks, openQuestions.
Constraints: do not edit files, run implementation, deploy, or claim approval. Never put credentials in your output.
Goal: Keep output stable.
Preserve **formatting**.
Projects: test/second, test/first
Current brief: {"summary":"Keep \\"quoted\\" text.\\nSecond line.","decisions":["Spacing stays.","Keep seat order."],"openQuestions":["Which outcome?"]}
Human message: Draft now.`);
  });

  it("renders the draft prompt's empty seat and project fallbacks", () => {
    const value = { ...goal(), goal: "Goal", projectRefs: [], brief: { summary: "Brief", decisions: [], openQuestions: [] } };
    expect(prompt(value, "", true, [])).toBe(`You are Chick Corea, the Team Lead seat in Indra. This is planning only.
Outcome: a proposed outcome-based roadmap for this goal. This is a draft for human review.
Acceptance: each outcome is small, focused on one concern, and independently verifiable; its description states its acceptance criteria and targeted tests. Keep outcomes roughly equal in size. In each outcome's description, list every file it will touch, including test files. Outcomes assigned to different seats must not touch the same file. Name each dependency by outcome title and owning seat ID, and state the order in which dependent work must land. For any shared-file wiring, name one owning outcome and seat; list its files only under that owner and make the other outcomes depend on it. Assign every outcome to one of these Developer seats by its seat ID: none. Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.
Afterwards Indra posts the draft in the goal thread. Nothing starts until a person approves it; then Indra queues each outcome for its Developer seat.
Return only JSON with keys summary, outcomes (title, description and seatId), risks, openQuestions.
Constraints: do not edit files, run implementation, deploy, or claim approval. Never put credentials in your output.
Goal: Goal
Projects:\u0020
Current brief: {"summary":"Brief","decisions":[],"openQuestions":[]}
Human message: `);
  });
});
