import { describe, expect, it } from "vitest";
import type { ImplementationEvidence } from "../src/ceremony.js";
import { proposalDigest } from "../src/ceremony.js";
import type { PlanningGoal } from "../src/planning.js";
import { APPROVE_EMOJI, PROPOSE_EMOJI } from "../src/planning-bridge.js";
import { approvalGateText, approvalMessage, integrationMessage, nextSprintText, prompt, proposalMessage, revertMessage, rootMessage, sprintSummary, type NextSprintTextInput } from "../src/planning-text.js";

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

Recorded in indra-state as goal-text. No work has been approved or executed. To approve it, a person reacts :white_check_mark: on this post. The owner may also use planning approve. With auto mode off, one of these human approvals is required. With auto mode on, Indra may approve under the owner's current standing policy only after the proposal checks pass; it records the approval as automatic. Turning auto mode off stops at the next approval gate.`);
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
This PR takes \`sprint/goal-text\` into main. With auto mode off, a person reacts :white_check_mark: on this post or the owner presses M in Chick's detail. With auto mode on, Indra may merge under the owner's current standing policy only after a fresh review of the current head and green CI are verified; it records the approval as automatic. Turning auto mode off stops at the next approval gate.`);
  });

  it("renders integration with omissions in their recorded order", () => {
    expect(integrationMessage(goal(), "https://github.com/test/project/pull/9", omissions)).toBe(`**Sprint goal-text is ready: https://github.com/test/project/pull/9**
This PR takes \`sprint/goal-text\` into main. This partial integration requires human merge approval even with auto mode on: a person reacts :white_check_mark: on this post or the owner presses M in Chick's detail, after a fresh review of the current head and green CI are verified.

**Owner-authorized omissions**
- outcome-2: Owner chose a smaller release.
- outcome-3: Owner deferred this.
Keep the reason.`);
  });

  it("renders the revert post with the seven-character merge SHA", () => {
    expect(revertMessage(goal(), "https://github.com/test/project/pull/10")).toBe(`**Rollback of sprint goal-text: https://github.com/test/project/pull/10**
This PR on main reverts the sprint's merge commit 1234567. To merge the revert once its CI is green, a person reacts :white_check_mark: on this post (or the owner presses M in Chick's detail).`);
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
Outcome: a proposed outcome-based roadmap for this goal. This is a draft for human review, awaiting the plan approval gate.
Acceptance: each outcome is small, focused on one concern, and independently verifiable; its description states its acceptance criteria and targeted tests. Keep outcomes roughly equal in size. In each outcome's description, list every file it will touch, including test files. Outcomes assigned to different seats must not touch the same file. Name each dependency by outcome title and owning seat ID, and state the order in which dependent work must land. For any shared-file wiring, name one owning outcome and seat; list its files only under that owner and make the other outcomes depend on it. Assign every outcome to one of these Developer seats by its seat ID: seat-004 (Corey Henry), seat-003 (Aaron Magner). Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.
Afterwards Indra posts the draft in the goal thread. With auto mode off: Nothing starts until a person approves it through a verified human reaction or the owner's planning approve command; then Indra queues each outcome for its Developer seat. With auto mode on, Indra may approve under the owner's current standing policy after all proposal checks pass, recording automatic provenance. You never grant approval. Cite the selected backlog tickets, the value this sprint would deliver and the latest available frozen retrospective when supplied; unavailable evidence stays unknown.
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
Outcome: a proposed outcome-based roadmap for this goal. This is a draft for human review, awaiting the plan approval gate.
Acceptance: each outcome is small, focused on one concern, and independently verifiable; its description states its acceptance criteria and targeted tests. Keep outcomes roughly equal in size. In each outcome's description, list every file it will touch, including test files. Outcomes assigned to different seats must not touch the same file. Name each dependency by outcome title and owning seat ID, and state the order in which dependent work must land. For any shared-file wiring, name one owning outcome and seat; list its files only under that owner and make the other outcomes depend on it. Assign every outcome to one of these Developer seats by its seat ID: none. Give each seat at most one outcome; only when there are more outcomes than seats may a seat take more, spread as evenly as possible.
Afterwards Indra posts the draft in the goal thread. With auto mode off: Nothing starts until a person approves it through a verified human reaction or the owner's planning approve command; then Indra queues each outcome for its Developer seat. With auto mode on, Indra may approve under the owner's current standing policy after all proposal checks pass, recording automatic provenance. You never grant approval. Cite the selected backlog tickets, the value this sprint would deliver and the latest available frozen retrospective when supplied; unavailable evidence stays unknown.
Return only JSON with keys summary, outcomes (title, description and seatId), risks, openQuestions.
Constraints: do not edit files, run implementation, deploy, or claim approval. Never put credentials in your output.
Goal: Goal
Projects:\u0020
Current brief: {"summary":"Brief","decisions":[],"openQuestions":[]}
Human message: `);
  });

  it("reports recorded automatic approval rather than claiming a human approved", () => {
    const value = goal();
    value.ceremony = { version: 1, stage: "implement", history: [
      { stage: "planning", enteredAt: at }, { stage: "proposal", enteredAt: at },
      { stage: "implement", enteredAt: at, evidence: { kind: "automatic-approval", proposalId: value.proposal!.id, proposalPostId: "proposal-post", approval: {
        source: "automatic", policyRevision: 4, at, target: { kind: "proposal", goalId: value.id, proposalId: value.proposal!.id, proposalDigest: proposalDigest(value.proposal!) },
      } } },
    ] };
    expect(approvalMessage(value, seats)).toContain("Approved automatically under the owner's standing policy revision 4.");
    expect(approvalMessage(value, seats)).not.toContain("Approved by a verified human");
    value.ceremony.history[2] = { stage: "implement", enteredAt: at, evidence: { kind: "approval", proposalId: value.proposal!.id, proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at } } };
    expect(approvalMessage(value, seats)).toContain("Approved by the owner's planning approve command.");
    expect(approvalMessage(value, seats)).not.toContain("Approved automatically");
  });

  it("describes checked automatic gates while keeping reverts under human approval", () => {
    expect(approvalGateText("proposal")).toContain("only after the proposal checks pass");
    expect(approvalGateText("integration")).toContain("fresh review of the current head and green CI");
    expect(approvalGateText("retro")).toContain("running release and the frozen retrospective archive");
    for (const kind of ["proposal", "integration", "retro"] as const) expect(approvalGateText(kind)).toContain("Turning auto mode off stops at the next approval gate");
    expect(revertMessage(goal(), "https://github.com/test/project/pull/10")).toContain("a person reacts");
    expect(revertMessage(goal(), "https://github.com/test/project/pull/10")).not.toContain("automatic");
  });

  it("retains ticket acceptance, research and honest prospective value in the published proposal", () => {
    const authors = { createdAt: at, updatedAt: at, createdBySeatId: "seat-lead", updatedBySeatId: "seat-lead" };
    const text = nextSprintText({ closedGoalId: "goal-previous", mission: "Owner steers by value", github: "test/project",
      candidate: { id: "candidate-next", title: "Improve onboarding", summary: "Make joining simpler", value: "Less setup time", rank: 1, status: "candidate", ticketIds: ["ticket-setup"], ...authors },
      tickets: [{ id: "ticket-setup", title: "Setup", description: "Acceptance: onboard a seat", value: "Visible progress", status: "open", dependsOn: ["ticket-prior"], research: [{ url: "https://example.test/research", finding: "A recorded finding" }], ...authors }],
    });
    const value = { ...goal(), goal: text, source: { candidateId: "candidate-next", ticketIds: ["ticket-setup"] } };
    const post = proposalMessage(value, seats);
    for (const citation of ["candidate-next", "ticket-setup", "Acceptance: onboard a seat", "Value this sprint would deliver: Less setup time", "ticket-prior", "https://example.test/research", "No verified frozen retrospective is available"]) expect(post).toContain(citation);
    expect(post).not.toContain("has delivered");
  });

  it.each([false, true])("bounds long citations while retaining sources and the complete approval gate (retro: %s)", (hasRetro) => {
    const authors = { createdAt: at, updatedAt: at, createdBySeatId: "seat-lead", updatedBySeatId: "seat-lead" };
    const tickets: NextSprintTextInput["tickets"] = Array.from({ length: 25 }, (_, index) => ({
      id: `ticket-${index}`, title: `Ticket ${index}`, description: "Acceptance: " + "🎹界".repeat(10_000), value: "Less setup time", status: "open", ...authors,
      research: [{ url: `https://example.test/research/${index}`, finding: "Long finding ".repeat(5_000) + "Final research fact" }],
    }));
    const retro: NextSprintTextInput["retro"] = hasRetro ? { goalId: "goal-previous", evidence: {
      kind: "retro-published", path: "docs/retros/goal-previous.md", prUrl: "https://github.com/test/project/pull/3", baseBranch: "main", mergedSha: "a".repeat(40), postId: "retro-post", publishedAt: at, factsOnly: true, suggestions: "owner-proposals-only",
    }, ownerProposals: [{ text: "Suggestion ".repeat(5_000), evidenceId: "release-rounds" }] } : undefined;
    const text = nextSprintText({ closedGoalId: "goal-previous", mission: "Owner steers by value", github: "test/project", retro, tickets,
      candidate: { id: "candidate-next", title: "Improve onboarding", summary: "Make joining simpler", value: "Less setup time", rank: 1, status: "candidate", ticketIds: tickets.map((ticket) => ticket.id), ...authors },
    });
    const value = { ...goal(), goal: text, source: { candidateId: "candidate-next", ticketIds: tickets.map((ticket) => ticket.id) } };
    // The space calculation must include a substantial draft as well as the appended basis.
    value.proposal!.summary = "Draft detail ".repeat(700);
    const post = proposalMessage(value, seats);
    expect(post.length).toBeLessThanOrEqual(15_000);
    expect(Buffer.from(post, "utf8").toString("utf8")).toBe(post);
    for (const ticket of tickets) expect(post).toContain(ticket.id);
    expect(post).toContain("Value this sprint would deliver: Less setup time");
    expect(post).toContain("candidate-next");
    expect(post).toContain("Basis excerpt; full ticket details and research are recorded with this goal in indra-state.");
    expect(post).toContain(value.proposal!.summary);
    for (const outcome of value.proposal!.outcomes) expect(post).toContain(outcome.description);
    expect(post).toContain(approvalGateText("proposal"));
    expect(post.match(/To approve it/g)).toHaveLength(1);
    expect(text).toContain(tickets.at(-1)!.research![0].finding);
    expect(prompt(value, "Draft", true, developers)).toContain("Final research fact");
    if (retro) expect(post).toContain(`https://github.com/test/project/blob/${retro.evidence.mergedSha}/${retro.evidence.path}`);
    else {
      expect(post).toContain("No verified frozen retrospective is available");
      expect(post).not.toContain("docs/retros/");
    }
  });

  it.each(["", "x"])("keeps one bounded approval post even when the draft itself is oversized (%j)", (padding) => {
    const value = { ...goal(), source: { candidateId: "candidate-next", ticketIds: ["ticket-next"] } };
    value.goal = "Candidate candidate-next, ticket-next. Value: easier setup. No verified frozen retrospective is available.";
    value.proposal!.outcomes[0].description = padding + "🎹".repeat(20_000);
    const post = proposalMessage(value, seats);
    expect(post.length).toBeLessThanOrEqual(15_000);
    expect(Buffer.from(post, "utf8").toString("utf8")).toBe(post);
    expect(post).toContain(value.goal);
    expect(post).toContain("Proposal excerpt; read the full recorded proposal in indra-state before approving.");
    expect(post).toContain(approvalGateText("proposal"));
    expect(value.proposal!.outcomes[0].description).toHaveLength(40_000 + padding.length);
  });
});
