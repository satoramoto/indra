import { access, readdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, AgentRuntime } from "../src/codex-runtime.js";
import type { PlanningGoal } from "../src/planning.js";
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
  } };
}
function narrative(snapshot: RetroEvidenceSnapshot): RetroNarrative {
  return { observations: [snapshot.choices.observations.find((item) => item.kind === "went-well")!, snapshot.choices.observations.find((item) => item.kind === "went-poorly")!], ownerProposals: snapshot.choices.ownerProposals.slice(0, 1) };
}
const generation = (): RetroGeneration => ({ sessionId: "fresh-retro-session", status: "succeeded", startedAt: at(50), finishedAt: at(55), wallTimeMs: 5_000, usage: counters(10, 2) });
function run(snapshot = buildRetroSnapshot(input()), response: unknown = narrative(snapshot)): AgentResult {
  return { sessionId: "fresh-retro-session", startedAt: at(50), finishedAt: at(55), usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }, response };
}

describe("bounded retro evidence and numeric accounting", () => {
  it("computes known tables, includes generation usage and preserves the cutoff rather than guessing closure", async () => {
    const snapshot = buildRetroSnapshot(input());
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
    expect(markdown).toContain("Owner proposal (not applied): Consider a pre-review check");
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
    expect(result.generation).toMatchObject({ wallTimeMs: 5_000, usage: { inputTokens: 10, outputTokens: 2 } });
    expect(result.markdown).toContain("| Total |  | 3 | 310 | unknown | 64 | unknown | 62 | unknown | 372 |");
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

  it("runs the default Codex process with an enforced read-only sandbox, no resume and no writable directories", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const draft = draftSprintRetro(input());
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--sandbox", "read-only"]);
    expect(args).not.toContain("resume"); expect(args).not.toContain("--add-dir"); expect(args.join(" ")).not.toContain("network_access=true");
    const snapshot = buildRetroSnapshot(input());
    child.stdout.write([
      { type: "thread.started", thread_id: "new-retro" },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(narrative(snapshot)) } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    child.stdout.end(); child.emit("close", 0);
    expect((await draft).generation.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
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
});
