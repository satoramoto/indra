import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, AgentRuntime } from "../src/codex-runtime.js";
import { CEREMONY_STAGES } from "../src/ceremony.js";
import type { ImplementationFacts } from "../src/implementation-facts.js";
import { TEAM_LEAD_CODEX_CONFIG, engineHome, seatHarnessDir } from "../src/harness-home.js";
import type { PlanningGoal } from "../src/planning.js";
import { SeatRuntime } from "../src/seat-runtime.js";
import {
  buildRetroSnapshot, draftSprintRetro, renderSprintRetro, retroPrompt, validateRetroNarrative,
  RETRO_LIMITS, RetroGenerationError, type RetroEvidenceSnapshot, type RetroGeneration, type RetroInput, type RetroNarrative,
} from "../src/sprint-retro.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
afterEach(() => vi.mocked(spawn).mockReset());

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, seconds)).toISOString();
const pr = "https://github.com/owner/project/pull/1";
const counters = (input = 100, output = 20) => ({ inputTokens: input, uncachedInputTokens: input - Math.floor(input / 5) - Math.floor(input / 10), cachedInputTokens: Math.floor(input / 5), cacheWriteInputTokens: Math.floor(input / 10), outputTokens: output, reasoningOutputTokens: Math.floor(output / 4) });
function goal(): PlanningGoal {
  return {
    id: "goal-one", teamId: "team-one", seatId: "seat-one", participantSeatIds: ["seat-two"], goal: "Ship the change",
    projectRefs: ["owner/project"], stage: "approved", createdAt: at(0), updatedAt: at(40),
    mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Ship", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-one", createdAt: at(10), summary: "Change", outcomes: [{ id: "outcome-one", title: "Change", description: "Done", seatId: "seat-two" }], risks: [], openQuestions: [] },
    assignments: [{ outcomeId: "outcome-one", seatId: "seat-two", status: "merged", prUrl: pr, updatedAt: at(30) }],
    integration: { branch: "sprint/goal-one", baseSha: "a".repeat(40), status: "merged", prUrl: pr, mergedSha: "b".repeat(40) },
    ceremony: { version: 1, stage: "retro", history: [
      { stage: "planning", enteredAt: at(0) }, { stage: "proposal", enteredAt: at(10) },
      { stage: "implement", enteredAt: at(20), evidence: { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: at(20) } } },
      { stage: "release", enteredAt: at(30), evidence: { kind: "implementation", outcomes: [{ outcomeId: "outcome-one", seatId: "seat-two", prUrl: pr, baseBranch: "sprint/goal-one", mergedSha: "c".repeat(40), checksPassed: true, reviewApproved: true }] } },
      { stage: "retro", enteredAt: at(40), evidence: { kind: "release-running", prUrl: pr, mergedSha: "b".repeat(40), buildSha: "b".repeat(40), runningSha: "b".repeat(40), runningAt: at(39), mergePostId: "merge-post", approval: { source: "owner-command", command: "planning merge", at: at(35) }, checksPassed: true } },
    ] },
  };
}
function input(): RetroInput {
  return { goal: goal(), cutoffAt: at(50), facts: {
    seats: [{ seatId: "seat-two", wallTimeMs: 20_000 }, { seatId: "seat-one", wallTimeMs: 8_000 }],
    sessions: [
      { seatId: "seat-two", sessionId: "developer-session", startedAt: at(20), finishedAt: at(25), usage: counters() },
      { seatId: "seat-one", sessionId: "planning-session", startedAt: at(1), finishedAt: at(9), usage: counters(200, 40) },
    ],
    reviews: [{ outcomeId: "outcome-one", prUrl: pr, findings: ["src/change.ts:4: wrong exit code"] }],
    rounds: [{ outcomeId: "outcome-one", fix: 1, conflict: 2 }],
    failures: [{ at: at(24), outcomeId: "outcome-one", message: "Build failed", retries: 2 }],
  }, implementation: [{ version: 1, goalId: "goal-one", outcomeId: "outcome-one", seatId: "seat-two", attempts: [{ id: "attempt-1", cause: "claim", claimedAt: at(20), terminal: { status: "merged", at: at(29) }, events: [] }] }] };
}
function narrative(snapshot: RetroEvidenceSnapshot): RetroNarrative {
  const phaseReflections = CEREMONY_STAGES.flatMap((phase) => snapshot.choices.phaseReflections.filter((item) => item.phase === phase).slice(0, 1));
  return { observations: [snapshot.choices.observations.find((item) => item.kind === "went-well")!, snapshot.choices.observations.find((item) => item.kind === "went-poorly")!], phaseReflections, ownerProposals: snapshot.choices.ownerProposals.slice(0, 1) };
}
const generation = (): RetroGeneration => ({ sessionId: "fresh-retro-session", status: "succeeded", startedAt: at(50), finishedAt: at(55), wallTimeMs: 5_000, usage: counters(10, 2) });
function run(snapshot = buildRetroSnapshot(input()), response: unknown = narrative(snapshot)): AgentResult {
  return { sessionId: "fresh-retro-session", startedAt: at(50), finishedAt: at(55), usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }, response };
}
const UNRECORDED_RELEASE = { phase: "release", evidenceId: "release-integration-conflicts", kind: "unknown", text: "Integration PR conflict and merge rounds are not recorded." };
const RECORDING_PROPOSAL = { evidenceId: "release-integration-conflicts", kind: "owner-proposal", text: "Consider recording integration PR conflict and merge rounds.", phase: "release" };

describe("bounded retro evidence and numeric accounting", () => {
  it("freezes actual lane sections and recorded integration rounds without filling missing history with zero", async () => {
    const data = input(); const headSha = "a".repeat(40); const baseSha = "b".repeat(40);
    data.lanePrs = [{ url: pr, headSha, decisions: "Preserved the approved boundary", followUps: null }];
    data.releaseAttempts = { version: 1, goalId: data.goal.id, startedAt: at(30), conflicts: [{ prUrl: pr, headSha, baseSha, at: at(31) }, { prUrl: pr, headSha, baseSha, at: at(32) }],
      merges: [{ prUrl: pr, headSha, at: at(33) }, { prUrl: pr, headSha, at: at(34) }, { prUrl: pr, headSha, at: at(60) }] };
    const snapshot = buildRetroSnapshot(data);
    expect(snapshot.phases.find((phase) => phase.phase === "release")!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: "release-integration-conflicts", value: 1 }), expect.objectContaining({ evidenceId: "release-merge-rounds", value: 2 }),
    ]));
    // Recorded rounds replace the "not recorded" reflection and the standing owner proposal.
    expect(snapshot.choices.phaseReflections).toContainEqual({ phase: "release", evidenceId: "release-integration-conflicts", kind: "slowed", text: "The integration PR recorded 1 conflict round(s) and 2 merge attempt(s)." });
    expect(snapshot.choices.phaseReflections).not.toContainEqual(UNRECORDED_RELEASE);
    expect(snapshot.choices.ownerProposals.some((item) => item.evidenceId === "release-integration-conflicts")).toBe(false);
    data.lanePrs[0].decisions = "Changed after cutoff";
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), generation());
    expect(markdown).toContain("Preserved the approved boundary"); expect(markdown).not.toContain("Changed after cutoff"); expect(markdown).toContain("unknown — section absent");
    expect(markdown).toContain("Integration PR merge attempts started | 2");
    const without = buildRetroSnapshot(input());
    expect(without.phases.find((phase) => phase.phase === "release")!.facts.find((fact) => fact.evidenceId === "release-merge-rounds")!.value).toBeNull();
    expect(without.choices.phaseReflections).toContainEqual(UNRECORDED_RELEASE);
    expect(without.choices.ownerProposals).toContainEqual(RECORDING_PROPOSAL);
    data.releaseAttempts.goalId = "goal-wrong"; expect(() => buildRetroSnapshot(data)).toThrow("integration attempt evidence");
  });
  it("reports recorded zero integration conflicts as worked, without the recording proposal", async () => {
    const data = input();
    data.releaseAttempts = { version: 1, goalId: data.goal.id, startedAt: at(30), conflicts: [], merges: [{ prUrl: pr, headSha: "a".repeat(40), at: at(33) }] };
    const snapshot = buildRetroSnapshot(data);
    const recorded = { phase: "release" as const, evidenceId: "release-integration-conflicts", kind: "worked" as const, text: "The integration PR recorded no conflict rounds and 1 merge attempt(s)." };
    expect(snapshot.choices.phaseReflections.filter((item) => item.evidenceId === "release-integration-conflicts")).toEqual([recorded]);
    expect(snapshot.choices.ownerProposals.some((item) => item.evidenceId === "release-integration-conflicts")).toBe(false);
    await expect(validateRetroNarrative(snapshot, narrative(snapshot))).resolves.toBeDefined();
    // A recorded count carries code's judgment; Chick cannot flip it.
    const flipped = narrative(snapshot); flipped.phaseReflections = flipped.phaseReflections.filter((item) => item.phase !== "release").concat({ ...recorded, kind: "slowed" });
    await expect(validateRetroNarrative(snapshot, flipped)).rejects.toThrow("unsupported");
  });
  it("computes known tables, includes generation usage and preserves the cutoff rather than guessing closure", async () => {
    const snapshot = buildRetroSnapshot(input());
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.stages.map((stage) => [stage.stage, stage.elapsedMs])).toEqual([
      ["planning", 10_000], ["proposal", 10_000], ["implement", 10_000], ["release", 10_000], ["retro", 10_000],
    ]);
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), generation());
    expect(markdown).toContain("| seat-one | 8000 | 5000 | 13000 |");
    expect(markdown).toContain("| seat-two | 20000 | 0 | 20000 |");
    expect(markdown).toContain("| Total | 28000 | 5000 | 33000 |");
    expect(markdown).toContain("| Total |  | 3 | 310 | 217 | 62 | 31 | 62 | 15 | 372 |");
    expect(markdown).toContain("| Total recorded |  | 1 | 2 |");
    expect(markdown).toContain(`| retro | ${at(40)} | ${at(50)} | 10000 |`);
    expect(markdown).toContain("eventual closure duration is unknown");
    expect(markdown).toContain("src/change.ts:4: wrong exit code");
    expect(markdown).not.toMatch(/developer-session|planning-session|fresh-retro-session/);
  });

  it("deduplicates resumed invocation deltas and copied records instead of multiplying session totals", () => {
    const data = input(); const first = { ...data.facts.sessions[0], invocationId: "00000000-0000-4000-8000-000000000001" };
    const resume = { ...first, invocationId: "00000000-0000-4000-8000-000000000002", startedAt: at(26), finishedAt: at(29), usage: counters(40, 8) };
    data.facts.sessions = [first, resume, structuredClone(first), structuredClone(resume)];
    const snapshot = buildRetroSnapshot(data);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ invocations: 2, startedAt: at(20), finishedAt: at(29), usage: { inputTokens: 140, outputTokens: 28 } });
    expect(snapshot.seats.find((seat) => seat.seatId === "seat-two")?.wallTimeMs).toBe(20_000);
  });

  it("uses the last legacy Codex cumulative report, but sums separate Claude invocations", () => {
    const data = input(); const first = data.facts.sessions[0];
    data.facts.sessions = [
      { ...first, usage: { input_tokens: 100, output_tokens: 20 } },
      { ...first, startedAt: at(26), finishedAt: at(28), usage: { input_tokens: 140, output_tokens: 28 } },
      { ...first, sessionId: "claude:12345678-1234-4321-8765-123456789abc", usage: { input_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 5 } },
      { ...first, sessionId: "claude:12345678-1234-4321-8765-123456789abc", startedAt: at(26), finishedAt: at(28), usage: { input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 } },
    ];
    expect(buildRetroSnapshot(data).sessions.map((session) => session.usage)).toMatchObject([
      { inputTokens: 140, outputTokens: 13, uncachedInputTokens: 90, cachedInputTokens: 30, cacheWriteInputTokens: 20 },
      { inputTokens: 140, outputTokens: 28 },
    ]);
  });

  it("does not add partial, mixed-basis, reset or conflicting reports as complete totals", () => {
    const data = input(); const first = data.facts.sessions[0];
    for (const reports of [
      [counters(), { outputTokens: 4 }],
      [{ input_tokens: 100, output_tokens: 20 }, { input_tokens: 20, output_tokens: 4 }],
      [{ input_tokens: 100, output_tokens: 20 }, counters(20, 4)],
    ]) {
      data.facts.sessions = reports.map((usage, i) => ({ ...first, startedAt: at(20 + i * 6), finishedAt: at(25 + i * 4), usage }));
      expect(buildRetroSnapshot(data).sessions[0].usage.inputTokens).toBeNull();
    }
    data.facts.sessions = [first, { ...first, usage: counters(999, 999) }];
    expect(buildRetroSnapshot(data).sessions[0].usage.inputTokens).toBeNull();
    expect(buildRetroSnapshot(data).missing.join(" ")).toContain("conflicting copies");
  });

  it("marks missing historical data explicitly without replacing stage times or seat time with zero", async () => {
    const data = input(); data.goal.ceremony!.migratedAt = at(45);
    for (const entry of data.goal.ceremony!.history.slice(1)) entry.enteredAt = null;
    data.facts = { seats: [], sessions: [], reviews: [], rounds: [], failures: [] };
    data.missing = ["Historical attempts were not recorded."];
    const snapshot = buildRetroSnapshot(data);
    expect(snapshot.stages.every((stage) => stage.elapsedMs === null)).toBe(true);
    expect(snapshot.seats.every((seat) => seat.wallTimeMs === null)).toBe(true);
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), generation());
    expect(markdown).toContain("| seat-one | unknown | 5000 | unknown |");
    expect(markdown).toContain("| retro | unknown | " + at(50) + " | unknown |");
    for (const text of ["Historical attempts were not recorded", "review history is unavailable", "Failure/retry history is unavailable", "does not establish zero"]) expect(markdown).toContain(text);
  });

  it.each(["seat-one", "seat-two"])("marks missing session history for %s even when another seat has complete records", async (seatId) => {
    const data = input();
    data.facts.sessions = data.facts.sessions.filter((session) => session.seatId !== seatId);
    const snapshot = buildRetroSnapshot(data);
    const gap = `${seatId}: session history is unavailable; token usage is unknown.`;
    expect(snapshot.missing).toEqual([gap]);
    expect(snapshot.seats.find((seat) => seat.seatId === seatId)?.wallTimeMs).toBe(seatId === "seat-one" ? 8_000 : 20_000);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.choices.observations).toContainEqual({ evidenceId: "missing", kind: "went-poorly", text: "Historical evidence is incomplete; unavailable measurements remain unknown." });
    expect(retroPrompt(snapshot)).toContain(gap);
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), generation());
    expect(markdown).toContain(gap);
    expect(markdown).not.toContain("No gaps identified");
  });

  it("does not let a post-cutoff session fill a seat's missing historical coverage", () => {
    const data = input();
    Object.assign(data.facts.sessions[0], { startedAt: at(51), finishedAt: at(55) });
    const snapshot = buildRetroSnapshot(data);
    expect(snapshot.sessions.map((session) => session.seatId)).toEqual(["seat-one"]);
    expect(snapshot.missing).toContain("seat-two: session history is unavailable; token usage is unknown.");
  });

  it("excludes post-cutoff facts and never prorates unfinished usage", () => {
    const data = input();
    data.facts.sessions[0].finishedAt = at(51);
    data.facts.sessions.push({ ...data.facts.sessions[1], sessionId: "later", startedAt: at(51), finishedAt: at(55) });
    data.facts.failures.push({ at: at(51), message: "after cutoff", retries: 9 });
    const snapshot = buildRetroSnapshot(data);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[1]).toMatchObject({ finishedAt: null, usage: { inputTokens: null, outputTokens: null } });
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.missing.join(" ")).toContain("after the snapshot cutoff");
  });

  it("owns a copy, discards arbitrary metadata and rejects evidence that exceeds either bound", () => {
    const data = input(); Object.assign(data.facts.sessions[0].usage!, { diagnostic: "private diagnostic" });
    const snapshot = buildRetroSnapshot(data); data.facts.rounds[0].fix = 99;
    expect(snapshot.rounds[0].fix).toBe(1);
    expect(retroPrompt(snapshot)).not.toContain("private diagnostic");
    data.facts.sessions = Array.from({ length: RETRO_LIMITS.records + 1 }, () => data.facts.sessions[0]);
    expect(() => buildRetroSnapshot(data)).toThrow("record bound");
    const large = input();
    large.facts.reviews[0].findings = Array.from({ length: 100 }, (_, i) => `${i} ${"words ".repeat(300)}`);
    expect(() => buildRetroSnapshot(large)).toThrow("snapshot exceeds its bound");
  });

  it("requires verified retro entry, chronological evidence and an open goal", () => {
    const data = input(); data.cutoffAt = at(38);
    expect(() => buildRetroSnapshot(data)).toThrow("cutoff precedes");
    data.cutoffAt = at(50); data.goal.integration!.status = "pr-open";
    expect(() => buildRetroSnapshot(data)).toThrow();
    const before = input(); before.goal.ceremony!.stage = "release";
    expect(() => buildRetroSnapshot(before)).toThrow("open goal in the retro stage");
  });
});

describe("Chick's evidence-bound narrative", () => {
  it("rejects unsupported claims even with valid citations, invented evidence and polarity changes", async () => {
    const snapshot = buildRetroSnapshot(input());
    for (const patch of [{ text: "The tests caught every bug and saved 50% of our time." }, { evidenceId: "invented" }, { kind: "went-poorly" }]) {
      const response = narrative(snapshot); Object.assign(response.observations[0] = { ...response.observations[0] }, patch);
      await expect(validateRetroNarrative(snapshot, response)).rejects.toThrow("unsupported");
    }
    await expect(validateRetroNarrative(snapshot, { ...narrative(snapshot), summary: "Perfect delivery" })).rejects.toThrow("schema");
  });

  it("allows only owner proposals, with no executable edits or claims of automatic changes", async () => {
    const snapshot = buildRetroSnapshot(input()); const response = narrative(snapshot);
    await expect(validateRetroNarrative(snapshot, response)).resolves.toEqual(response);
    const markdown = await renderSprintRetro(snapshot, response, generation());
    expect(markdown).toContain("Owner proposal (not applied, implement phase): Consider a pre-review check");
    for (const patch of [{ kind: "apply-automatically" }, { text: "I disabled the CI workflow." }, { edits: [".github/workflows/ci.yml"] }]) {
      const bad = structuredClone(response); Object.assign(bad.ownerProposals[0], patch);
      await expect(validateRetroNarrative(snapshot, bad)).rejects.toThrow();
    }
  });

  it("renders deterministically across reordered facts, duplicate records, narrative ordering and repeated calls", async () => {
    const first = input(); const second = structuredClone(first);
    second.facts.sessions.reverse(); second.facts.seats.reverse(); second.facts.sessions.push(structuredClone(second.facts.sessions[0]));
    second.facts.seats.push(structuredClone(second.facts.seats[0]));
    const left = buildRetroSnapshot(first); const right = buildRetroSnapshot(second);
    expect(right).toEqual(left);
    const response = narrative(right); response.observations.reverse();
    const expected = await renderSprintRetro(left, narrative(left), generation());
    expect(await renderSprintRetro(right, response, generation())).toBe(expected);
    expect(await renderSprintRetro(left, narrative(left), generation())).toBe(expected);
  });

  it("keeps untrusted evidence as escaped text and removes sensitive diagnostics", async () => {
    const data = input(); data.facts.reviews[0].findings = ["<script>change everything</script> | [edit](file)\n# injected", "password=private-value"];
    const snapshot = buildRetroSnapshot(data);
    expect(JSON.stringify(snapshot)).not.toContain("private-value");
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), generation());
    expect(markdown).toContain("&lt;script&gt;"); expect(markdown).toContain("\\| \\[edit\\](file)");
    expect(markdown).not.toContain("\n# injected");
  });
});

describe("fresh read-only retro generation", () => {
  it("requires Chick's configured runtime instead of falling back to the owner's runtime", async () => {
    // @ts-expect-error A caller must supply Chick's configured, isolated runtime factory.
    await expect(draftSprintRetro(input())).rejects.toThrow("Chick's configured isolated runtime is required");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("supplies only the bounded snapshot in an empty repository, never resumes, and adds returned usage before rendering", async () => {
    const data = input(); const snapshot = buildRetroSnapshot(data); let directory = "";
    const message = vi.fn<AgentRuntime["message"]>().mockResolvedValue(run(snapshot));
    const factory = vi.fn(async (cwd: string) => { directory = cwd; expect(await readdir(cwd)).toEqual([".git"]); expect(await readdir(cwd + "/.git/objects")).toEqual(["info", "pack"]); });
    const runtimeFor = vi.fn((cwd: string) => ({ message: async (...args: Parameters<AgentRuntime["message"]>) => { await factory(cwd); return message(...args); } }));
    const result = await draftSprintRetro(data, runtimeFor);
    expect(runtimeFor).toHaveBeenCalledWith(directory);
    expect(message).toHaveBeenCalledWith(retroPrompt(snapshot), expect.stringMatching(/schemas\/retro\.json$/), undefined, { purpose: "retro" });
    expect(message.mock.calls[0][0]).not.toContain("planning-session");
    expect(message.mock.calls[0][0]).toContain("Do not use tools");
    // Codex input includes cached reads, so the fresh session's uncached input is derived (10 - 4); cache writes and reasoning stay unreported.
    expect(result.generation).toMatchObject({ wallTimeMs: 5_000, usage: { inputTokens: 10, uncachedInputTokens: 6, outputTokens: 2 } });
    expect(result.markdown).toContain("| Total |  | 3 | 310 | 216 | 64 | unknown | 62 | unknown | 372 |");
    expect(result.snapshot.cutoffAt).toBe(at(50));
    await expect(access(directory)).rejects.toThrow();
  });

  it("uses returned invocation facts when available instead of counting a cumulative report again", async () => {
    const snapshot = buildRetroSnapshot(input()); const result = Object.assign(run(snapshot), { facts: {
      invocationId: "retro-invocation", engine: "codex", sessionId: "new-session", status: "succeeded", startedAt: at(50), finishedAt: at(57), usage: counters(8, 1), cumulativeUsage: counters(999, 999),
    } });
    const draft = await draftSprintRetro(input(), () => ({ message: async () => result }));
    expect(draft.generation).toMatchObject({ sessionId: "new-session", invocationId: "retro-invocation", wallTimeMs: 7_000, usage: { inputTokens: 8, outputTokens: 1 } });
    expect(draft.markdown).toContain("| Total |  | 3 | 308 | 217 | 61 | 30 | 61 | 15 | 369 |");
  });

  it("runs Chick's configured Codex runtime in its isolated harness with a read-only sandbox and no resume", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "indra-retro-harness-"));
    const harness = seatHarnessDir(runtimeDir, input().goal.seatId);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    try {
      const draft = draftSprintRetro(input(), (cwd) => new SeatRuntime("codex", cwd, undefined, undefined, undefined, harness, ["Team Lead"]));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args.slice(0, 4)).toEqual(["exec", "--json", "--sandbox", "read-only"]);
      expect(args).not.toContain("resume"); expect(args).not.toContain("--add-dir"); expect(args.join(" ")).not.toContain("network_access=true");
      const configuredHome = engineHome(harness, "codex");
      expect(vi.mocked(spawn).mock.calls[0][2]?.env?.CODEX_HOME).toBe(configuredHome);
      expect(await readdir(configuredHome)).toEqual(["auth.json", "config.toml"]);
      expect(await readFile(join(configuredHome, "config.toml"), "utf8")).toBe(TEAM_LEAD_CODEX_CONFIG);
      const snapshot = buildRetroSnapshot(input());
      child.stdout.write([
        { type: "thread.started", thread_id: "new-retro" },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } },
        { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(narrative(snapshot)) } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
      child.stdout.end(); child.emit("close", 0);
      expect((await draft).generation.usage).toMatchObject({ inputTokens: 10, uncachedInputTokens: 6, outputTokens: 2 });
      // The post-run refresh keeps the Team Lead's config rather than resetting it to the Developer default.
      expect(await readFile(join(configuredHome, "config.toml"), "utf8")).toBe(TEAM_LEAD_CODEX_CONFIG);
    } finally { await rm(runtimeDir, { recursive: true, force: true }); }
  });

  it("fails without a document, withholds provider diagnostics, preserves failed usage and removes the cwd", async () => {
    let directory = "";
    const failed = Object.assign(new Error("private provider diagnostics"), { facts: { invocationId: "failed-turn", sessionId: "failed-session", engine: "codex", status: "timed-out", startedAt: at(50), finishedAt: at(52), usage: { inputTokens: 7 } } });
    let error: unknown;
    try { await draftSprintRetro(input(), (cwd) => { directory = cwd; return { message: async () => { throw failed; } }; }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RetroGenerationError);
    expect((error as RetroGenerationError).message).not.toContain("private provider");
    expect((error as RetroGenerationError).generation).toMatchObject({ status: "timed-out", wallTimeMs: 2_000, usage: { inputTokens: 7, outputTokens: null } });
    expect(error).not.toHaveProperty("markdown");
    await expect(access(directory)).rejects.toThrow();
  });

  it("retains generation accounting when unsupported prose is rejected and refuses a reused session", async () => {
    const unsupported = run(undefined, { observations: [{ evidenceId: "release-running", kind: "went-well", text: "Everything was perfect." }], ownerProposals: [] });
    await expect(draftSprintRetro(input(), () => ({ message: async () => unsupported }))).rejects.toMatchObject({ generation: { usage: { inputTokens: 10, outputTokens: 2 } }, message: expect.stringContaining("unsupported narrative") });
    await expect(draftSprintRetro(input(), () => ({ message: async () => ({ ...run(), sessionId: "planning-session" }) }))).rejects.toThrow("fresh session");
  });

  it("labels each failure with a fixed error kind and never a provider diagnostic", async () => {
    const unsupported = run(undefined, { observations: [], phaseReflections: [], ownerProposals: [] });
    await expect(draftSprintRetro(input(), () => ({ message: async () => unsupported }))).rejects.toMatchObject({ kind: "unsupported-narrative" });
    await expect(draftSprintRetro(input(), () => ({ message: async () => ({ ...run(), sessionId: "planning-session" }) }))).rejects.toMatchObject({ kind: "not-fresh" });
    const timedOut = Object.assign(new Error("provider said: secret"), { facts: { sessionId: "failed-session", engine: "codex", status: "timed-out", startedAt: at(50), finishedAt: at(52) } });
    await expect(draftSprintRetro(input(), () => ({ message: async () => { throw timedOut; } }))).rejects.toMatchObject({ kind: "timed-out" });
    await expect(draftSprintRetro(input(), () => ({ message: async () => { throw new Error("invalid schema"); } }))).rejects.toMatchObject({ kind: "runtime-failed" });
  });
});

const CLARIFY_FAILURE = "Chick clarification failed or was interrupted.";
const DRAFT_FAILURE = "Chick proposal draft failed or was interrupted.";
const pr2 = "https://github.com/owner/project/pull/2";
/** Two developer seats, a failed clarification turn and draft, a retried outcome and two failed retro drafts. */
function realistic(): RetroInput {
  const data = input(); const g = data.goal;
  g.participantSeatIds = ["seat-three", "seat-two"]; g.updatedAt = at(5600);
  g.proposal = { ...g.proposal!, createdAt: at(900), outcomes: [
    { id: "outcome-one", title: "Change", description: "Done", seatId: "seat-two" }, { id: "outcome-two", title: "Docs", description: "Done", seatId: "seat-three" },
  ] };
  g.assignments = [{ outcomeId: "outcome-one", seatId: "seat-two", status: "merged", prUrl: pr, updatedAt: at(3100) }, { outcomeId: "outcome-two", seatId: "seat-three", status: "merged", prUrl: pr2, updatedAt: at(4520) }];
  g.ceremony!.history = [
    { stage: "planning", enteredAt: at(0) }, { stage: "proposal", enteredAt: at(600) },
    { stage: "implement", enteredAt: at(1500), evidence: { kind: "approval", proposalId: "proposal-one", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: at(1500) } } },
    { stage: "release", enteredAt: at(5000), evidence: { kind: "implementation", outcomes: [
      { outcomeId: "outcome-one", seatId: "seat-two", prUrl: pr, baseBranch: "sprint/goal-one", mergedSha: "c".repeat(40), checksPassed: true, reviewApproved: true },
      { outcomeId: "outcome-two", seatId: "seat-three", prUrl: pr2, baseBranch: "sprint/goal-one", mergedSha: "d".repeat(40), checksPassed: true, reviewApproved: true },
    ] } },
    { stage: "retro", enteredAt: at(5600), evidence: { kind: "release-running", prUrl: pr, mergedSha: "b".repeat(40), buildSha: "b".repeat(40), runningSha: "b".repeat(40), runningAt: at(5590), mergePostId: "merge-post", approval: { source: "owner-command", command: "planning merge", at: at(5400) }, checksPassed: true } },
  ];
  const chick = (start: number, end: number, sessionId = "chick-planning", usage = counters(10, 2)) => ({ seatId: "seat-one", sessionId, startedAt: at(start), finishedAt: at(end), usage });
  data.cutoffAt = at(5700);
  data.facts = {
    seats: [{ seatId: "seat-one", wallTimeMs: 1_000 }, { seatId: "seat-two", wallTimeMs: 1_490_000 }, { seatId: "seat-three", wallTimeMs: 3_000_000 }],
    sessions: [chick(60, 70), chick(200, 210), chick(300, 320), chick(610, 640), chick(800, 890),
      { seatId: "seat-two", sessionId: "dev-two", startedAt: at(1510), finishedAt: at(1990), usage: counters() },
      { seatId: "seat-three", sessionId: "dev-three", startedAt: at(1520), finishedAt: at(4500), usage: counters() },
      chick(5610, 5611, "retro-fail-1", counters(5, 1)), chick(5640, 5650, "retro-fail-2", counters(6, 2))],
    reviews: [{ outcomeId: "outcome-one", prUrl: pr, findings: ["src/a.ts:1: wrong", "src/a.ts:9: missing test"] }, { outcomeId: "outcome-two", prUrl: pr2, findings: [] }],
    rounds: [{ outcomeId: "outcome-one", fix: 1, conflict: 1 }, { outcomeId: "outcome-two", fix: 0, conflict: 0 }],
    failures: [{ at: at(200), message: CLARIFY_FAILURE, retries: 0 }, { at: at(610), message: DRAFT_FAILURE, retries: 0 }],
  };
  const ledger = (outcomeId: string, seatId: string, attempts: ImplementationFacts["attempts"]): ImplementationFacts => ({ version: 1, goalId: "goal-one", outcomeId, seatId, attempts });
  data.implementation = [
    ledger("outcome-one", "seat-two", [
      { id: "one-1", cause: "claim", claimedAt: at(1510), terminal: { status: "failed", at: at(2000) }, events: [
        { id: "review:1", at: at(1700), kind: "review", verdict: "REQUEST_CHANGES", findings: ["src/a.ts:1: wrong", "src/a.ts:9: missing test"] },
        { id: "fix-1", at: at(1800), kind: "fix", result: "started", round: 1 }, { id: "fix-1-done", at: at(1900), kind: "fix", result: "passed", round: 1 },
      ] },
      { id: "one-2", cause: "retry", claimedAt: at(2100), terminal: { status: "merged", at: at(3100) }, events: [
        { id: "conflict-1", at: at(2500), kind: "conflict", result: "started", round: 1 }, { id: "review:2", at: at(2900), kind: "review", verdict: "APPROVE", findings: [] },
      ] },
    ]),
    ledger("outcome-two", "seat-three", [{ id: "two-1", cause: "claim", claimedAt: at(1520), terminal: { status: "merged", at: at(4520) }, events: [{ id: "review:3", at: at(4400), kind: "review", verdict: "APPROVE", findings: [] }] }]),
  ];
  data.retroAttempts = [{ startedAt: at(5610), errorKind: "runtime-failed", sessionId: "retro-fail-1" }, { startedAt: at(5640), errorKind: "timed-out", sessionId: "retro-fail-2" }];
  return data;
}
const lateGeneration = (): RetroGeneration => ({ ...generation(), startedAt: at(5700), finishedAt: at(5705) });
const phaseValue = (snapshot: RetroEvidenceSnapshot, phase: string, id: string) => snapshot.phases.find((item) => item.phase === phase)!.facts.find((item) => item.evidenceId === id)!.value;

describe("per-phase process reflection", () => {
  it("does not invent historical human-approval timing for automatic releases", () => {
    const data = realistic();
    const release = data.goal.ceremony!.history.find((entry) => entry.stage === "retro")!.evidence;
    delete release.approval; delete release.mergePostId;
    release.mergeVerification = { headSha: "a".repeat(40), reviewCommitSha: "a".repeat(40), reviewer: "satori-miyamoto", checksPassed: true };
    const snapshot = buildRetroSnapshot(data);
    expect(phaseValue(snapshot, "release", "release-approval-to-running")).toBeNull();
    expect(snapshot.choices.phaseReflections.some((item) => item.evidenceId === "release-approval-to-running")).toBe(false);
  });

  it("computes each phase's facts from a realistic recorded fixture", () => {
    const snapshot = buildRetroSnapshot(realistic());
    expect(snapshot.phases.map((phase) => phase.phase)).toEqual(["planning", "proposal", "implement", "release", "retro"]);
    expect(Object.fromEntries(snapshot.phases.flatMap((phase) => phase.facts.map((item) => [item.evidenceId, item.value])))).toEqual({
      "planning-turns": 3, "planning-failures": 1,
      "proposal-drafts": 2, "proposal-draft-failures": 1, "proposal-approval-wait": 600_000,
      "implement-critical-path": 3_000_000, "implement-slowest-seat": "seat-three", "implement-reviews": 3, "implement-findings": 2,
      "implement-fix-rounds": 1, "implement-conflict-rounds": 1, "implement-retries": 1,
      "release-integration-conflicts": null, "release-merge-rounds": null, "release-approval-to-running": 190_000,
      "retro-drafts": 3, "retro-failed-drafts": 2, "retro-first-error": "runtime-failed", "retro-last-error": "timed-out",
    });
    expect(snapshot.phases.find((phase) => phase.phase === "implement")!.seats).toEqual([
      { seatId: "seat-three", outcomes: 1, attempts: 1, wallTimeMs: 3_000_000 }, { seatId: "seat-two", outcomes: 1, attempts: 2, wallTimeMs: 1_490_000 },
    ]);
    expect(snapshot.choices.phaseReflections).toEqual(expect.arrayContaining([
      { phase: "implement", evidenceId: "implement-time", kind: "noted", text: "Implement was the longest recorded phase at 58m 20s." },
      { phase: "planning", evidenceId: "planning-failures", kind: "slowed", text: "Planning recorded 1 failed clarification turn(s) out of 3." },
      { phase: "implement", evidenceId: "implement-slowest-seat", kind: "noted", text: "seat-three was the slowest seat at 50m 00s, the implement critical path." },
      { phase: "retro", evidenceId: "retro-failed-drafts", kind: "slowed", text: "The retro draft failed or was aborted 2 time(s) before this attempt (first: runtime-failed; last: timed-out)." },
      UNRECORDED_RELEASE,
    ]));
    expect(snapshot.choices.ownerProposals).toContainEqual({ evidenceId: "retro-failed-drafts", kind: "owner-proposal", text: "Consider investigating the recorded retro draft failures.", phase: "retro" });
    // Unrecorded integration rounds keep the recording proposal.
    expect(snapshot.choices.ownerProposals).toContainEqual(RECORDING_PROPOSAL);
    // Measured durations carry no code judgment: code offers them only as neutral "noted" facts.
    expect(snapshot.choices.phaseReflections.filter((item) => item.evidenceId === "release-approval-to-running")).toEqual([
      { phase: "release", evidenceId: "release-approval-to-running", kind: "noted", text: "The new build was recorded running 3m 10s after the merge approval (includes CI wait, merge and build)." }]);
    for (const id of ["implement-time", "implement-slowest-seat", "proposal-approval-wait"]) {
      expect(snapshot.choices.phaseReflections.filter((item) => item.evidenceId === id).map((item) => item.kind)).toEqual(["noted"]);
    }
  });

  it("lets Chick judge a noted duration once, but not both ways, and never judge a recorded outcome", async () => {
    const snapshot = buildRetroSnapshot(realistic());
    const noted = snapshot.choices.phaseReflections.find((item) => item.evidenceId === "release-approval-to-running")!;
    const response = narrative(snapshot);
    response.phaseReflections = response.phaseReflections.filter((item) => item.phase !== "release").concat({ ...noted, kind: "slowed" });
    await expect(validateRetroNarrative(snapshot, response)).resolves.toBeDefined();
    response.phaseReflections.push({ ...noted, kind: "worked" });
    await expect(validateRetroNarrative(snapshot, response)).rejects.toThrow("repeated");
    const flipped = narrative(snapshot); const failures = flipped.phaseReflections.findIndex((item) => item.evidenceId === "planning-failures");
    flipped.phaseReflections[failures] = { ...flipped.phaseReflections[failures], kind: "worked" };
    await expect(validateRetroNarrative(snapshot, flipped)).rejects.toThrow("unsupported");
  });

  it("keeps unrecorded phase facts unknown instead of zero, and falls back only to complete review/round tables", () => {
    const data = realistic(); data.implementation = [];
    data.facts.sessions = data.facts.sessions.filter((row) => row.seatId !== "seat-one");
    data.facts.rounds = data.facts.rounds.slice(0, 1);
    const snapshot = buildRetroSnapshot(data);
    for (const id of ["planning-turns", "planning-failures", "proposal-drafts", "proposal-draft-failures"]) expect(phaseValue(snapshot, id.split("-")[0], id)).toBeNull();
    for (const id of ["implement-critical-path", "implement-slowest-seat", "implement-fix-rounds", "implement-conflict-rounds", "implement-retries"]) expect(phaseValue(snapshot, "implement", id)).toBeNull();
    expect(phaseValue(snapshot, "implement", "implement-reviews")).toBe(2);
    expect(phaseValue(snapshot, "implement", "implement-findings")).toBe(2);
    expect(snapshot.missing).toContain("outcome-one: implementation ledger is unavailable; per-seat implement time is unknown.");
    const migrated = realistic(); migrated.goal.ceremony!.migratedAt = at(5600);
    for (const entry of migrated.goal.ceremony!.history.slice(1, 4)) entry.enteredAt = null;
    const legacy = buildRetroSnapshot(migrated);
    expect(phaseValue(legacy, "planning", "planning-turns")).toBeNull();
    expect(legacy.choices.phaseReflections).toContainEqual({ phase: "proposal", evidenceId: "proposal-time", kind: "unknown", text: "Proposal timing was not recorded." });
  });

  it("rejects phase reflections that are unsupported, moved to another phase, invented or missing", async () => {
    const snapshot = buildRetroSnapshot(realistic());
    await expect(validateRetroNarrative(snapshot, narrative(snapshot))).resolves.toBeDefined();
    const planning = narrative(snapshot).phaseReflections.findIndex((item) => item.phase === "planning");
    for (const patch of [{ text: "Planning was flawless and saved a day." }, { phase: "retro" }, { evidenceId: "retro-drafts" }, { evidenceId: "invented" }, { kind: "worked" }]) {
      const bad = narrative(snapshot); Object.assign(bad.phaseReflections[planning] = { ...bad.phaseReflections[planning] }, patch);
      await expect(validateRetroNarrative(snapshot, bad)).rejects.toThrow("unsupported");
    }
    const omitted = narrative(snapshot); omitted.phaseReflections = omitted.phaseReflections.filter((item) => item.phase !== "release");
    await expect(validateRetroNarrative(snapshot, omitted)).rejects.toThrow("omits a phase reflection");
    const moved = narrative(snapshot); moved.ownerProposals = [{ ...moved.ownerProposals[0], phase: "planning" }];
    await expect(validateRetroNarrative(snapshot, moved)).rejects.toThrow("unsupported");
    const repeated = narrative(snapshot); repeated.phaseReflections.push(repeated.phaseReflections[0]);
    await expect(validateRetroNarrative(snapshot, repeated)).rejects.toThrow("repeated");
    // A supported sentence whose evidence belongs to another phase is still refused.
    const crossed = structuredClone(snapshot); const smuggled = { phase: "planning" as const, evidenceId: "retro-drafts", kind: "worked" as const, text: "The retro was drafted on the first recorded attempt." };
    crossed.choices.phaseReflections.push(smuggled);
    const response = narrative(crossed); response.phaseReflections.push(smuggled);
    await expect(validateRetroNarrative(crossed, response)).rejects.toThrow("another phase");
  });

  it("renders a Process phases section with per-phase tables, reflections and phase-tagged proposals", async () => {
    const snapshot = buildRetroSnapshot(realistic());
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), lateGeneration());
    const section = markdown.slice(markdown.indexOf("## Process phases"), markdown.indexOf("## Per-seat wall time"));
    expect(section).toContain(`| implement | ${at(1500)} | ${at(5000)} | 3500000 | 58m 20s | implement-time |`);
    expect(section).toContain(`| retro | ${at(5600)} | ${at(5700)} | 100000 | 1m 40s | retro-time |`);
    for (const text of ["### Planning", "### Proposal", "### Implement", "### Release", "### Retro",
      "| Clarification turns | 3 | planning-turns |", "| Draft waiting for plan approval | 10m 00s | proposal-approval-wait |",
      "| Slowest seat | seat-three | implement-slowest-seat |", "| seat-two | 1 | 2 | 24m 50s |", "| Integration PR conflict rounds | unknown | release-integration-conflicts |",
      "| Failed or aborted draft attempts | 2 | retro-failed-drafts |", "- Noted: Implement was the longest recorded phase at 58m 20s. [implement-time]",
      "| From merge approval to the new build running (includes CI wait, merge and build) | 3m 10s | release-approval-to-running |",
      "- Noted: The new build was recorded running 3m 10s after the merge approval (includes CI wait, merge and build). [release-approval-to-running]",
      "- Slowed or hurt: Planning recorded 1 failed clarification turn(s) out of 3. [planning-failures]"]) expect(section).toContain(text);
    expect(section.indexOf("### Planning")).toBeLessThan(section.indexOf("### Retro"));
    expect(markdown).toContain("- Owner proposal (not applied, implement phase): Consider a pre-review check for the recorded review findings. [review-1]");
    expect(markdown).not.toContain("## Ceremony stage time");
  });

  it("summarises failed retro attempts in one line instead of listing their sessions", async () => {
    const snapshot = buildRetroSnapshot(realistic());
    expect(snapshot.retroAttempts).toEqual({ failed: 2, firstErrorKind: "runtime-failed", lastErrorKind: "timed-out", sessions: 2, usage: expect.objectContaining({ inputTokens: 11, outputTokens: 3 }) });
    expect(snapshot.sessions.find((row) => row.seatId === "seat-one")).toMatchObject({ invocations: 5 });
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), lateGeneration());
    expect(markdown.match(/^\| session-\d+ /gm)).toHaveLength(3);
    expect(markdown).toContain("| retro-generation | seat-one | 1 |");
    expect(markdown).toContain("Failed or aborted retro-generation attempts before this draft: 2 (first error: runtime-failed; last error: timed-out). Their 2 recorded session(s) are summarised here rather than listed, and are not in the totals above; their input + output tokens: 14.");
    const clean = buildRetroSnapshot(input());
    expect(await renderSprintRetro(clean, narrative(clean), generation())).toContain("No failed or aborted retro-generation attempts were recorded before this draft.");
  });

  it("drops only sessions matched to a failed attempt by recorded ID; other lead-seat sessions stay in the table and totals", async () => {
    const data = realistic();
    // A non-retro lead-seat session after retro started and after the first failed attempt.
    data.facts.sessions.push({ seatId: "seat-one", sessionId: "chick-other", startedAt: at(5620), finishedAt: at(5625), usage: counters(7, 1) });
    const snapshot = buildRetroSnapshot(data);
    expect(snapshot.sessions.filter((row) => row.seatId === "seat-one").map((row) => [row.startedAt, row.invocations, row.usage.inputTokens])).toEqual([[at(5620), 1, 7], [at(60), 5, 50]]);
    expect(snapshot.retroAttempts.sessions).toBe(2);
    const markdown = await renderSprintRetro(snapshot, narrative(snapshot), lateGeneration());
    // 5 Chick turns + 2 developer sessions + the other lead-seat session + this generation; 50 + 100 + 100 + 7 + 10 input tokens.
    expect(markdown).toContain("| Total |  | 9 | 267 |");

    const unrecorded = realistic(); unrecorded.retroAttempts![1].sessionId = null;
    const kept = buildRetroSnapshot(unrecorded);
    expect(kept.retroAttempts).toMatchObject({ failed: 2, sessions: 1 });
    expect(kept.sessions.some((row) => row.startedAt === at(5640))).toBe(true);

    const byInvocation = realistic(); byInvocation.retroAttempts![1] = { ...byInvocation.retroAttempts![1], sessionId: null, invocationId: "retro-invocation-2" };
    Object.assign(byInvocation.facts.sessions.find((row) => row.sessionId === "retro-fail-2")!, { invocationId: "retro-invocation-2" });
    const matched = buildRetroSnapshot(byInvocation);
    expect(matched.retroAttempts.sessions).toBe(2);
    expect(matched.sessions.some((row) => row.startedAt === at(5640))).toBe(false);
  });
});
