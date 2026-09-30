import { testRender } from "@opentui/solid";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel, type TerminalSession } from "../src/terminal-ui.js";
import { openLink, TerminalApp } from "../src/terminal-ui-solid.js";
import { HUB_GRID, occupancy, seatInfo, sprintLinks } from "../src/hub-view.js";
import type { SeatLive, SeatProcessPort } from "../src/supervisor.js";
import type { CeremonyStage } from "../src/session-snapshot.js";
import { CEREMONY_STAGES, LocalSessionReader } from "../src/session-snapshot.js";
import {
  compactionNote, contextText, formatElapsed, formatTokens, freshInputTokens, mattermostChannelUrl, mattermostPostUrl, openableUrl, parseUsage, pipelineSteps, prLabel,
  sumUsage, totalTokens, usageLine, workTokens,
} from "../src/hub-format.js";
import { normalizeUsage } from "../src/runtime-facts.js";
import { allGlyphs, faded, GLYPH, PALETTE, PULSE_MS } from "../src/hub-style.js";
import { HelpOverlay } from "../src/help-overlay.js";
import { assignmentFacts, readProductFacts, seatHarness } from "../src/hub-facts.js";
import { ansi256Rgb, paint, STAGE_COLOR } from "../src/hub-paint.js";
import type { ImplementationFacts } from "../src/implementation-facts.js";
import type { SeatTaskRecord } from "../src/developer-seat.js";
import type { RuntimeRecord } from "../src/planning.js";
import { productRuntimeFilename, type ProductProposal, type ProductRuntimeRecord } from "../src/goal-contract.js";
import { productJournalFilename } from "../src/product-proposals.js";

const states = (steps: ReturnType<typeof pipelineSteps>) => steps.map((step) => step.state).join(" ");

describe("pipeline icons", () => {
  it("lights each stage as the assignment advances and pulses only the current one", () => {
    expect(states(pipelineSteps({ status: "queued" }))).toBe("pending pending pending pending pending");
    expect(states(pipelineSteps({ status: "running" }))).toBe("active pending pending pending pending");
    expect(states(pipelineSteps({ status: "running", step: "worktree" }))).toBe("active pending pending pending pending");
    expect(states(pipelineSteps({ status: "in-review", step: "review" }))).toBe("done active pending pending pending");
    expect(states(pipelineSteps({ status: "in review" }))).toBe("done active pending pending pending");
    expect(states(pipelineSteps({ status: "in-review", step: "fix", fixRounds: 1 }))).toBe("done done active pending pending");
    // CI after an approval that needed no fix: the fix stage is skipped, not done.
    expect(states(pipelineSteps({ status: "in-review", step: "ci", fixRounds: 0 }))).toBe("done done skipped active pending");
    expect(states(pipelineSteps({ status: "in-review", step: "ci", fixRounds: 2 }))).toBe("done done done active pending");
    expect(states(pipelineSteps({ status: "in-review", step: "done", fixRounds: 1 }))).toBe("done done done done active");
    expect(states(pipelineSteps({ status: "merged" }))).toBe("done done done done done");
    expect(states(pipelineSteps({ status: "merged", step: "done", fixRounds: 0 }))).toBe("done done skipped done done");
    expect(states(pipelineSteps({ status: "failed", step: "ci", fixRounds: 1 }))).toBe("done done done failed pending");
    expect(states(pipelineSteps({ status: "failed" }))).toBe("failed pending pending pending pending");
    expect(pipelineSteps({ status: "running" }).map((step) => step.stage)).toEqual(["build", "review", "fix", "ci", "merge"]);
  });
});

describe("token and time formatting", () => {
  it("formats counts compactly and keeps unknown counters unknown", () => {
    expect([0, 950, 1000, 1234, 12_345, 123_456, 250_000, 1_250_000, 12_500_000, 100_000_000, 3_100_000_000].map(formatTokens))
      .toEqual(["0", "950", "1k", "1.23k", "12.3k", "123k", "250k", "1.25M", "12.5M", "100M", "3.1B"]);
    expect(formatTokens(undefined)).toBe("–");
    expect(formatTokens(-1)).toBe("–");
  });

  it("sums recorded usage, counts cached input once and ignores provider junk", () => {
    const codex = parseUsage({ inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 20_000, provider: "x", nested: { a: 1 } });
    const claude = parseUsage({ inputTokens: 250_000, uncachedInputTokens: 50_000, cachedInputTokens: 200_000, cacheWriteInputTokens: 0, outputTokens: 30_000 });
    expect(codex).toEqual({ inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 20_000 });
    expect(parseUsage("12")).toBeUndefined();
    expect(parseUsage({ inputTokens: -3, outputTokens: 1.5 })).toBeUndefined();
    const total = sumUsage([codex, undefined, claude]);
    expect(total).toEqual({ inputTokens: 1_250_000, cachedInputTokens: 1_000_000, uncachedInputTokens: 50_000, cacheWriteInputTokens: 0, outputTokens: 50_000 });
    expect(totalTokens(total)).toBe(1_300_000);
    expect(totalTokens({ uncachedInputTokens: 10, cachedInputTokens: 5, outputTokens: 1 })).toBe(16);
    expect(totalTokens(undefined)).toBeUndefined();
    expect(usageLine(total)).toBe("work 300k · out 50k · cache 1M");
    expect(usageLine(undefined)).toBe("no tokens recorded yet");
    expect(sumUsage([undefined])).toBeUndefined();
  });

  it("counts fresh work as uncached input plus output for both engines, with cache re-reads apart", () => {
    // Codex reports input including cached input: fresh input is input − cached.
    const codex = normalizeUsage("codex", { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 20_000, reasoning_output_tokens: 5_000 });
    expect([freshInputTokens(codex), workTokens(codex), codex?.cachedInputTokens]).toEqual([100_000, 120_000, 900_000]);
    expect(usageLine(codex)).toBe("work 120k · out 20k · cache 900k");
    // Claude: input_tokens + cache_creation_input_tokens is fresh; cache_read_input_tokens is the re-read.
    const claude = normalizeUsage("claude", { input_tokens: 3_000, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 500_000, output_tokens: 7_000 });
    expect([freshInputTokens(claude), workTokens(claude), claude?.cachedInputTokens]).toEqual([43_000, 50_000, 500_000]);
    // A Claude report missing a component has no inclusive input; the fresh parts still count.
    expect(freshInputTokens({ uncachedInputTokens: 3_000, cacheWriteInputTokens: 40_000, cachedInputTokens: 500_000 })).toBe(43_000);
    expect(workTokens(undefined)).toBeUndefined();
    expect(workTokens({ cachedInputTokens: 5 })).toBeUndefined();
  });

  it("shows the live context window against the cap, and a compaction only while it is recent", () => {
    expect(contextText(182_000, 300_000)).toBe("ctx 182k/300k");
    expect(contextText(undefined, 300_000)).toBeUndefined();
    expect(compactionNote(ago(2), NOW)).toBe("compacted 2m ago");
    expect(compactionNote(ago(6), NOW)).toBeUndefined();
    expect(compactionNote(undefined, NOW)).toBeUndefined();
  });

  it("formats elapsed runtime", () => {
    expect([0, 45_000, 12 * 60_000, (2 * 60 + 5) * 60_000, (3 * 24 + 4) * 3_600_000].map(formatElapsed)).toEqual(["0s", "45s", "12m", "2h05m", "3d04h"]);
    expect(formatElapsed(undefined)).toBe("–");
  });
});

describe("links", () => {
  const post = "o9rogqxy7br1zkrcami681sray";
  it("builds Mattermost permalinks only from recorded IDs and the team slug", () => {
    expect(mattermostPostUrl("yahaha", post)).toBe(`https://mattermost.newegypt.io/yahaha/pl/${post}`);
    expect(mattermostChannelUrl("yahaha", post)).toBe(`https://mattermost.newegypt.io/yahaha/channels/${post}`);
    for (const [team, id] of [["yahaha", "root"], ["yahaha", undefined], [undefined, post], ["Yah aha", post], ["yahaha", post + "/../x"]]) expect(mattermostPostUrl(team, id)).toBeUndefined();
    const team = { id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "t", seats: [] };
    const session = { mattermost: { channelId: post, rootPostId: post, proposalPostId: "p".repeat(26) } } as TerminalSession;
    expect(sprintLinks(team, session)).toEqual({ thread: `https://mattermost.newegypt.io/yahaha/pl/${post}`, proposal: `https://mattermost.newegypt.io/yahaha/pl/${"p".repeat(26)}` });
    expect(sprintLinks(team, undefined)).toEqual({});
  });

  it("labels GitHub PRs and opens only links Indra builds, without a shell", () => {
    expect(prLabel("https://github.com/satoramoto/indra/pull/102")).toBe("#102");
    expect(prLabel("https://github.com/satoramoto/indra/pull/102", true)).toBe("satoramoto/indra#102");
    expect(prLabel("https://example.com/pull/1")).toBeUndefined();
    const run = vi.fn();
    expect(openLink("https://github.com/o/r/pull/2", run, "darwin")).toBe("https://github.com/o/r/pull/2");
    expect(run).toHaveBeenLastCalledWith("open", ["https://github.com/o/r/pull/2"]);
    openLink(`https://mattermost.newegypt.io/yahaha/pl/${post}`, run, "linux");
    expect(run).toHaveBeenLastCalledWith("xdg-open", [`https://mattermost.newegypt.io/yahaha/pl/${post}`]);
    for (const url of ["https://evil.example/pull/1", "file:///etc/passwd", "https://github.com/o/r/pull/2; rm -rf /", "https://mattermost.newegypt.io.evil/x", "https://mattermost.newegypt.io/a b", "-a Calculator"]) {
      expect(openableUrl(url), url).toBeUndefined();
      expect(openLink(url, run)).toBeUndefined();
    }
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("recorded facts", () => {
  it("reads the harness, model and effort each seat's roles get", () => {
    expect(seatHarness("codex", ["Team Lead"])).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "max" });
    expect(seatHarness("codex", ["Developer"])).toEqual({ engine: "codex", model: "gpt-6-sol", effort: "medium" });
    expect(seatHarness("claude", ["Team Lead"])).toEqual({ engine: "claude", model: "claude-opus-5-5", effort: "max" });
    expect(seatHarness("claude", undefined)).toEqual({ engine: "claude", model: "claude-opus-5-5", effort: "medium" });
  });

  it("projects step, CI, cost and elapsed time from the task record and ledger", () => {
    const session = (id: string, usage: object) => ({ id: "session:" + id, at: "2026-01-01T00:10:00Z", kind: "session" as const, role: "developer" as const,
      session: { invocationId: id, engine: "claude" as const, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:10:00Z", status: "succeeded" as const, usage } });
    const ledger: ImplementationFacts = { version: 1, goalId: "g", outcomeId: "o", seatId: "s", attempts: [
      { id: "a1", cause: "claim", claimedAt: "2026-01-01T00:00:00Z", terminal: { status: "failed", at: "2026-01-01T00:20:00Z" }, events: [session("1", { inputTokens: 100, outputTokens: 10 }), { id: "c", at: "x", kind: "ci", result: "failed" }] },
      { id: "a2", cause: "retry", claimedAt: "2026-01-01T01:00:00Z", events: [session("2", { inputTokens: 200, cachedInputTokens: 150, outputTokens: 20 }), { id: "c2", at: "y", kind: "ci", result: "started" }] },
    ] };
    const record = { goalId: "g", outcomeId: "o", step: "ci", branch: "b", worktree: "w", reviewFixRounds: 1, sessions: [] } as SeatTaskRecord;
    expect(assignmentFacts(record, ledger)).toEqual({ step: "ci", fixRounds: 1, ci: "pending", usage: { inputTokens: 300, cachedInputTokens: 150, outputTokens: 30 }, sessions: 2, engine: "claude", claimedAt: "2026-01-01T01:00:00Z",
      burn: [{ at: "2026-01-01T00:10:00Z", tokens: 110 }, { at: "2026-01-01T00:10:00Z", tokens: 220 }] });
    ledger.attempts[1].events.push({ id: "m", at: "z", kind: "merge", result: "passed" });
    ledger.attempts[1].terminal = { status: "merged", at: "2026-01-01T02:00:00Z" };
    expect(assignmentFacts(record, ledger)).toMatchObject({ ci: "passed", endedAt: "2026-01-01T02:00:00Z" });
    // A record from before the ledger still reports its own sessions' usage.
    expect(assignmentFacts({ ...record, sessions: [{ role: "developer", sessionId: "x", startedAt: "", finishedAt: "", usage: { inputTokens: 5, outputTokens: 1 } }] }, undefined))
      .toEqual({ step: "ci", fixRounds: 1, usage: { inputTokens: 5, outputTokens: 1 }, sessions: 1, sessionIds: ["x"] });
    expect(assignmentFacts(undefined, undefined)).toBeUndefined();
  });

  it("adds ticket facts, the sprint's token total and Mattermost IDs to open goals only", async () => {
    const files: Record<string, unknown> = {
      "seat-seat-002-goal-open-o1": { goalId: "goal-open", outcomeId: "o1", step: "review", branch: "b", worktree: "w", sessions: [] },
      "implementation-goal-open-seat-002-o1": { version: 1, goalId: "goal-open", outcomeId: "o1", seatId: "seat-002", attempts: [{ id: "a", cause: "claim", claimedAt: "2026-01-01T00:00:00Z", events: [
        { id: "s", at: "t", kind: "session", session: { invocationId: "i", engine: "codex", startedAt: "", finishedAt: "", status: "succeeded", usage: { inputTokens: 1000, outputTokens: 100 } } }] }] },
    };
    const goal = (id: string, closed: boolean) => ({ id, teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Goal " + id, projectRefs: [], stage: "approved" as const,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mattermost: { channelId: "c".repeat(26), rootPostId: "r".repeat(26) }, brief: { summary: "s", decisions: [], openQuestions: [] },
      proposal: { id: "p-1", createdAt: "2026-01-01T00:00:00Z", summary: "s", outcomes: [{ id: "o1", title: "One", description: "d", seatId: "seat-002" }], risks: [], openQuestions: [] },
      assignments: [{ outcomeId: "o1", seatId: "seat-002", status: "in-review" as const, updatedAt: "2026-01-01T00:00:00Z" }],
      integration: { branch: `sprint/${id}`, baseSha: "a".repeat(40), status: "collecting" as const },
      ceremony: { version: 1 as const, stage: "implement" as const, history: [{ stage: "planning" as const, enteredAt: "2026-01-01T00:00:00Z" }],
        ...(closed ? { closure: { closedAt: "2026-01-02T00:00:00Z", evidence: { kind: "legacy-migration" } } } : {}) } });
    const reads: string[] = [];
    const runtime: RuntimeRecord = { lastSeenAt: 0, processedPostIds: [], proposalPostIds: ["q".repeat(26)], runs: [{ startedAt: "", finishedAt: "", usage: { inputTokens: 50, outputTokens: 5 } }] };
    const store = {
      read: async () => ({ $schema: "", schemaVersion: 1, teams: [], planningGoals: [goal("goal-open", false), goal("goal-closed", true)] }),
      runtime: async () => structuredClone(runtime),
      readRuntimeFile: async <T,>(name: string) => { reads.push(name); return files[name] as T | undefined; },
    };
    const host = { verifiedRecord: async () => undefined, isReady: async () => false, attachTarget: () => "" };
    const [open, closed] = (await new LocalSessionReader("unused", store as never, host).readSessions()).sessions;
    expect(open.loop?.tickets[0].facts).toMatchObject({ step: "review", usage: { inputTokens: 1000, outputTokens: 100 }, sessions: 1 });
    expect(open.loop?.usage).toEqual({ inputTokens: 1050, outputTokens: 105 });
    expect(open).toMatchObject({ runs: 1, usage: { inputTokens: 50, outputTokens: 5 }, mattermost: { channelId: "c".repeat(26), rootPostId: "r".repeat(26), proposalPostId: "q".repeat(26) } });
    expect(closed.loop?.tickets[0].facts).toBeUndefined();
    expect(closed.loop?.usage).toBeUndefined();
    expect(reads.some((name) => name.includes("goal-closed"))).toBe(false);
  });
});

// A busy afternoon: a sprint in implement, four Developer seats at different steps, and Chick waiting on nothing.
const ids = { thread: "o9rogqxy7br1zkrcami681sray", proposal: "k3j2h1g0f9e8d7c6b5a4z3y2x1", channel: "h0m3ch4nn3l1d0000000000000" };
const names = ["Chick Corea", "George Duke", "Aaron Magner", "Corey Henry", "Jordan Rudess"];
const snapshot: StateSnapshot = { teams: [{
  id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "t", homeChannelId: ids.channel, project: { github: "satoramoto/indra" },
  seats: names.map((displayName, index) => ({ id: "seat-00" + (index + 1), displayName, handle: displayName.toLowerCase().replace(" ", ""), mattermostUserId: "u" + index, roles: [index ? "Developer" : "Team Lead"] })),
}] };
const NOW = Date.parse("2026-09-29T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const titles = ["Show every seat's harness, model and token use on the team screen", "Light up each assignment's pipeline as it advances", "Link PRs and Mattermost posts from the sprint card", "Keep the hub inside a 96 by 42 terminal"];
const usage = (million: number) => ({ inputTokens: million * 1_000_000, cachedInputTokens: Math.round(million * 800_000), outputTokens: Math.round(million * 40_000) });
const live: Record<string, SeatLive> = {
  "seat-001": { process: "running", harness: seatHarness("claude", ["Team Lead"]), attach: { kind: "tmux", target: "indra:chick" } },
  "seat-002": { process: "running", harness: seatHarness("codex", ["Developer"]), activity: { message: "Opened PR 103; review requested", at: ago(3) },
    assignment: { title: titles[0], status: "in-review", prUrl: "https://github.com/satoramoto/indra/pull/103", goalId: "goal-hub", outcomeId: "o1",
      facts: { step: "ci", fixRounds: 0, ci: "pending", usage: usage(1.25), sessions: 3, sessionIds: ["s-george"], engine: "codex", claimedAt: ago(47),
        burn: [{ at: ago(90), tokens: 250_000 }, { at: ago(50), tokens: 400_000 }, { at: ago(20), tokens: 850_000 }] } } },
  "seat-003": { process: "running", harness: seatHarness("claude", ["Developer"]), activity: { message: "Building the pipeline row", at: ago(1) },
    assignment: { title: titles[1], status: "running", goalId: "goal-hub", outcomeId: "o2", facts: { step: "build", usage: usage(0.4), sessions: 1, sessionIds: ["s-aaron"], claimedAt: ago(12) } } },
  "seat-004": { process: "no credential", problem: "The 1Password service account token is missing; run npm start again.", harness: seatHarness("codex", ["Developer"]) },
  "seat-005": { process: "running", harness: seatHarness("codex", ["Developer"]),
    retry: { seatId: "seat-005", goalId: "goal-hub", goal: "Hub", outcomeId: "o4", title: titles[3], updatedAt: ago(5) } },
};
const hubSession = (stage: CeremonyStage = "implement"): TerminalSession => ({
  id: "goal-hub", teamId: "team-001", seatId: "seat-001", goal: "Make the terminal UI the owner's all-day hub: fit a 96×42 grid, colour every state and link every PR and post.",
  status: "idle", engine: "claude", sessionId: "claude:0e5f9f3e-1111-4222-8333-944445555666", stage: "approved", updatedAt: ago(2), createdAt: ago(200),
  recentActivity: ["Claude Code run finished " + ago(30)], runs: 4, usage: usage(2.1), attach: { kind: "tmux", target: "indra:chick" },
  mattermost: { channelId: ids.channel, rootPostId: ids.thread, proposalPostId: ids.proposal },
  loop: {
    stage, ceremony: { version: 1, stage, history: CEREMONY_STAGES.slice(0, CEREMONY_STAGES.indexOf(stage) + 1).map((name, index) => ({ stage: name, enteredAt: ago(200 - index * 30) })) },
    tickets: [
      { id: "o1", title: titles[0], seatId: "seat-002", status: "in review", prUrl: "https://github.com/satoramoto/indra/pull/103", facts: { step: "ci", fixRounds: 0, ci: "pending", usage: usage(1.25), sessions: 3 } },
      { id: "o2", title: titles[1], seatId: "seat-003", status: "building", facts: { step: "build", usage: usage(0.4), sessions: 1 } },
      { id: "o3", title: titles[2], seatId: "seat-004", status: "merged", prUrl: "https://github.com/satoramoto/indra/pull/98", facts: { step: "done", fixRounds: 1, ci: "passed", usage: usage(0.9), sessions: 4 } },
      { id: "o4", title: titles[3], seatId: "seat-005", status: "failed", prUrl: "https://github.com/satoramoto/indra/pull/99", facts: { step: "ci", fixRounds: 2, ci: "failed", usage: usage(1.6), sessions: 6 } },
    ],
    integration: { branch: "sprint/goal-hub", baseSha: "a".repeat(40), status: "collecting" },
    usage: usage(6.25),
  },
});

async function hubModel(session: TerminalSession | null = hubSession()) {
  const processes: SeatProcessPort = { ensureAll: async () => [], read: async () => live, stop: async () => {}, restart: async () => {}, retry: async () => "" };
  // The header's sync and update lines are on, as in the real app: 42 rows must hold them too.
  const stamp = { id: "build-1", sha: "82e2001aa", builtAt: ago(60) };
  const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: session ? [session] : [] }) }, processes,
    { start: vi.fn(), propose: vi.fn(), approve: vi.fn(), sprint: vi.fn() }, { sync: vi.fn() },
    { running: stamp, canReload: true, check: vi.fn(), current: async () => stamp });
  await model.refresh();
  model.syncResult = { outcome: "synced", message: "Up to date with origin/main", changed: false, at: ago(1) };
  model.updateResult = { outcome: "up-to-date", message: "Up to date", at: ago(1) };
  // Two headed runs going: George's window is above 80% of the cap, and Aaron's just compacted.
  model.liveUsage = {
    "seat-002": { engine: "codex", sessionId: "s-george", usage: usage(1.25), context: 250_000 },
    "seat-003": { engine: "claude", sessionId: "s-aaron", usage: usage(0.4), context: 41_000, compactedAt: ago(1) },
  };
  return model;
}

function walk(node: Renderable, into: Set<Renderable> = new Set()): Set<Renderable> {
  into.add(node);
  for (const child of node.getChildren()) walk(child as Renderable, into);
  return into;
}

/** Writes each screen as text for the PR description when HUB_FRAMES_DIR is set. */
async function keep(name: string, frame: string) {
  if (process.env.HUB_FRAMES_DIR) await writeFile(join(process.env.HUB_FRAMES_DIR, name + ".txt"), frame.split("\n").map((line) => line.trimEnd()).join("\n"));
}

/** Emoji, and anything a terminal may draw as one: pictographs and the emoji variation selector. */
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/gu;

const SCREENS = [
  ["team", { page: "team" as const, seatId: "seat-002" }],
  ["developer-seat", { page: "seat" as const, seatId: "seat-002" }],
  ["lead-seat", { page: "seat" as const, seatId: "seat-001" }],
  ["teams", { page: "teams" as const }],
] as const;

/** One screen of the busy afternoon at 96×42, with a live pane of progress lines. */
async function screen(view: { page: "team" | "seat" | "teams"; seatId?: string }, pulse: () => boolean = () => false) {
  const model = await hubModel();
  model.restore({ ...view, teamId: "team-001" });
  const session = { capture: async (_seat: unknown, size: { rows: number }) => ({ status: "ok" as const, lines: Array.from({ length: 20 }, (_, index) => [{ text: `15:${String(index).padStart(2, "0")} $ ✓ npm test step ${index}`, style: {} }]).slice(-size.rows) }) };
  const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} session={session} pulse={pulse} now={() => NOW} />, { width: HUB_GRID.columns, height: HUB_GRID.rows });
  await setup.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.renderOnce();
  return setup;
}

describe("the hub on the owner's screen", () => {
  it("documents the grid it is designed for", () => {
    expect(HUB_GRID).toEqual({ columns: 96, rows: 42 });
  });

  it.each(SCREENS)("fits the %s screen in 96×42 with every key field whole and no emoji", async (name, view) => {
    const setup = await screen(view);
    try {
      const frame = setup.captureCharFrame();
      await keep(name, frame);
      const scroll = setup.renderer.root.findDescendantById(view.page === "seat" ? "detail-scroll" : "team-scroll") as ScrollBoxRenderable | undefined;
      // Nothing to scroll on the team screens: the content is no taller than the screen gives it. On a seat screen the
      // live session takes most rows and the details are their own scrolling panel: every field is reachable by scrolling it.
      const frames = [frame];
      if (scroll && view.page === "seat") {
        for (let page = 0; page < 10 && scroll.scrollTop + scroll.viewport.height < scroll.scrollHeight; page++) {
          // A third of a page at a time, so a wrapped field is whole in at least one frame.
          scroll.scrollBy(Math.max(1, Math.floor(scroll.viewport.height / 3)));
          await setup.renderOnce();
          frames.push(setup.captureCharFrame());
        }
      } else if (scroll) expect(scroll.scrollHeight, frame).toBeLessThanOrEqual(scroll.height);
      const expected: Record<string, string[]> = {
        team: [...names, "NEEDS YOU · 2", "progress " + "▀".repeat(11) + " ".repeat(13) + "  45%", "The 1Password service account token is missing; run npm start again.", "Keep the hub inside a 96 by 42 terminal · failed · T retry",
          "SPRINT goal-hub", "planning → proposal → [implement] → release → retro", "open · 1/4 merged", "work 1.5M · out 250k · cache 5M · 3h20m since planning",
          "⇗ goal thread", "⇗ proposal post", "plan Plan approved.", "integration not opened", "release Waiting for implementation to finish.",
          "⎇ #103 ●", "⎇ #98 ●", "⎇ #99 ●", "in review", "building", "merged", "failed", "George Duke", "Aaron Magner",
          "SEATS · Yahaha · 5", "● 2 running", "◆ 1 needs you", "✗ 1 failed", "○ 1 idle",
          "SEAT", "TASK", "STEPS", "MODEL", "WORK", "OUT", "CACHE", "CTX", "TIME", "gpt-6-sol", "opus-5-5", "no credential", "failed · T retry", "idle session",
          "300k 50k 1M 250k 47m ⎇ #103 ●", "12m", "LATEST", "Opened PR 103; review requested", "context compacted 1m ago · Building the pipeline row"],
        "developer-seat": ["LIVE · George Duke · progress · click or i to drive", "SEAT George Duke", "George Duke @georgeduke · Developer · running", "process running (seat runner)",
          "harness Codex · model gpt-6-sol · effort medium", "tokens work 300k · out 50k · cache 1M · ctx 250k/300k · includes the run in progress",
          // George Duke's last hour: 400k at 50 minutes ago and 850k at 20 (the 90-minute session is outside the window).
          "burn ⢠⠀⢸⠀ last hour",
          `historical ${titles[0]} · in-review`, "pr ⎇ satoramoto/indra#103 · ● CI pending · 3 sessions · 47m on this task",
          "steps ■ build → ■ review → ─ fix skipped → ◧ ci → □ merge", "latest Opened PR 103; review requested",
          "SPRINTS", "planning → proposal → [implement] → release → retro", "tickets 1/4 tickets merged", "SEATS", ...names],
        "lead-seat": ["LIVE · Chick Corea · progress · click or i to drive", "Chick Corea @chickcorea · Team Lead · idle", "process running (planning bridge)", "harness Claude · model claude-opus-5-5 · effort max",
          "tokens work 504k · out 84k · cache 1.68M", "session idle session · Claude Code", "goal Make the terminal UI the owner's all-day hub",
          "Claude Code session: claude:0e5f9f3e-1111-4222-8333-944445555666", "4 runs", "live shown above · i or a click on it drives", "[implement]", "⇗ goal thread", "⇗ proposal post"],
        teams: ["TEAMS", "Yahaha (yahaha)", "5 seats", "⎇ satoramoto/indra"],
      };
      // Word wrapping inside a box is fine; cutting a key field short is not. Compare without spaces and box edges.
      const compact = (text: string) => text.replace(view.page === "seat" ? /[\s│█▀▄]/g : /\s/g, "");
      for (const text of expected[name]) expect(frames.map(compact).join("\n"), text + "\n" + frames.join("\n")).toContain(compact(text));
      for (const shown of frames) expect(shown).not.toMatch(/tmux|Ctrl-\]|Ctrl-b/);
      for (const shown of frames) expect(shown.match(EMOJI) ?? [], shown).toEqual([]);
      expect(frame.split("\n").length - 1).toBe(HUB_GRID.rows);
      expect(frame.match(EMOJI) ?? [], frame).toEqual([]);
    } finally { setup.renderer.destroy(); }
  });

  it("renders no emoji in the help overlay either", async () => {
    const setup = await testRender(() => <HelpOverlay />, { width: HUB_GRID.columns, height: HUB_GRID.rows });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("HELP · Esc, q or ? closes");
      expect(frame.match(EMOJI) ?? [], frame).toEqual([]);
    } finally { setup.renderer.destroy(); }
  });

  it("uses one glyph set whose glyphs are each one terminal column and none an emoji", async () => {
    const glyphs = [...new Set(allGlyphs())];
    expect(glyphs.length).toBeGreaterThan(15);
    for (const glyph of glyphs) {
      expect(Array.from(glyph), glyph).toHaveLength(1);
      expect(glyph, glyph).not.toMatch(/[\p{Extended_Pictographic}\u{FE0F}]/u);
    }
    // The renderer's own cell count for each glyph: one character, one cell. An emoji, two cells, is the control.
    const rows = [...glyphs, "🟢"];
    const setup = await testRender(() => <box flexDirection="column">{rows.map((row) => <text>{row}</text>)}</box>, { width: 10, height: rows.length });
    try {
      await setup.renderOnce();
      const cellsOf = (index: number) => setup.captureSpans().lines[index].spans.filter((span) => span.text.trim()).reduce((sum, span) => sum + span.width - (Array.from(span.text).length - Array.from(span.text.trim()).length), 0);
      glyphs.forEach((glyph, index) => expect(cellsOf(index), glyph).toBe(1));
      expect(cellsOf(glyphs.length)).toBe(2);
    } finally { setup.renderer.destroy(); }
  });

  it("lines the seats table up in columns under its header", async () => {
    const setup = await screen({ page: "team", seatId: "seat-002" });
    try {
      const lines = setup.captureCharFrame().split("\n").map((line) => Array.from(line));
      const header = lines.findIndex((line) => line.join("").includes("SEAT ") && line.join("").includes(" TASK "));
      expect(header).toBeGreaterThan(0);
      const at = (label: string) => lines[header].join("").indexOf(label);
      const cell = (row: string[], label: string, width: number) => row.slice(at(label), at(label) + width).join("");
      const rows = names.map((name) => lines.slice(header + 1).find((line) => line.join("").includes(name))!);
      const model: Record<string, string> = { "Chick Corea": "opus-5-5", "George Duke": "gpt-6-sol", "Aaron Magner": "opus-5-5", "Corey Henry": "gpt-6-sol", "Jordan Rudess": "gpt-6-sol" };
      rows.forEach((row, index) => {
        expect(cell(row, "SEAT", names[index].length), row.join("")).toBe(names[index]);
        expect(cell(row, "MODEL", model[names[index]].length), row.join("")).toBe(model[names[index]]);
        // Numbers are right-aligned: the column ends where its header ends.
        for (const label of ["WORK", "OUT", "CACHE", "CTX", "TIME"]) expect(row[at(label) + label.length - 1], label + ": " + row.join("")).not.toBe(" ");
        for (const label of ["WORK", "OUT", "CACHE", "CTX", "TIME"]) expect(row[at(label) + label.length] ?? " ", label + ": " + row.join("")).toBe(" ");
      });
      const george = rows[names.indexOf("George Duke")];
      expect(cell(george, "STEPS", 5)).toBe("■■─◧□");
      expect(cell(rows[names.indexOf("Aaron Magner")], "STEPS", 5)).toBe("◧□□□□");
      expect(cell(george, "PR", 8)).toBe("⎇ #103 ●");
      const right = (row: string[], label: string, width: number) => row.slice(at(label) + label.length - width, at(label) + label.length).join("");
      expect([right(george, "WORK", 5), right(george, "OUT", 5), right(george, "CACHE", 5), right(george, "CTX", 4), right(george, "TIME", 5)]).toEqual([" 300k", "  50k", "   1M", "250k", "  47m"]);
    } finally { setup.renderer.destroy(); }
  });

  it("pulses gently, and only what needs the owner or the active step", async () => {
    // At most one slow pulse: a flip every 1.5 s between the colour and its faded self.
    expect(PULSE_MS).toBeGreaterThanOrEqual(1000);
    expect(faded("#F87171")).not.toBe("#F87171");
    const cells = (setup: Awaited<ReturnType<typeof testRender>>) => setup.captureSpans().lines.map((line) => line.spans.flatMap((span) => Array.from(span.text).map((char) => ({ char, fg: span.fg.toInts().slice(0, 3).join(",") }))));
    const red = [PALETTE.bad].map((hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(","))[0];
    for (const view of [{ page: "team" as const, seatId: "seat-002" }, { page: "seat" as const, seatId: "seat-002" }]) {
      const [pulse, setPulse] = createSignal(false);
      const setup = await screen(view, pulse);
      try {
        const before = cells(setup);
        setPulse(true);
        await setup.renderOnce();
        const after = cells(setup);
        const changed: string[] = [];
        before.forEach((line, row) => line.forEach((cell, column) => {
          if (after[row]?.[column]?.fg === cell.fg || cell.char === " ") return;
          changed.push(cell.char);
          // A pulsing cell is in the needs-you/failed red, or it is the active pipeline step.
          expect(cell.fg === red || cell.char === GLYPH.stage.active, `${cell.char} at ${row}:${column}`).toBe(true);
        }));
        // The seat screen's pipeline sits below the fold of its scrolling details panel.
        if (view.page === "team") expect(changed).toContain(GLYPH.stage.active);
        if (view.page === "team") expect(changed).toEqual(expect.arrayContaining([GLYPH.state.needs, GLYPH.state.failed]));
        // The running glyph and the rest of the screen hold still.
        expect(changed).not.toContain(GLYPH.state.running);
        expect(changed.length).toBeLessThan(80);
      } finally { setup.renderer.destroy(); }
    }
  });

  it("keeps a blink cheap: it recolours existing renderables and never re-reads the model", async () => {
    const model = await hubModel();
    model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
    const [pulse, setPulse] = createSignal(false);
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} pulse={pulse} now={() => NOW} />, { width: 96, height: 42 });
    try {
      // Let the first layout settle (the scroll box measures its content once) before counting.
      await setup.renderOnce();
      await setup.renderOnce();
      const nodes = walk(setup.renderer.root);
      const reads = vi.spyOn(model, "sessionsFor");
      const frames: string[] = [];
      for (let tick = 0; tick < 60; tick++) {
        setPulse((value) => !value);
        await setup.renderOnce();
        frames.push(setup.captureCharFrame());
      }
      expect(reads).not.toHaveBeenCalled();
      // The same renderables, not one more: a blink never builds native objects.
      expect(walk(setup.renderer.root)).toEqual(nodes);
      const other = frames.find((frame) => frame !== frames[0])?.split("\n");
      expect(other ? frames[0].split("\n").flatMap((line, index) => line === other[index] ? [] : [line + " ≠ " + other[index]]) : []).toEqual([]);
    } finally { setup.renderer.destroy(); }
  });

  it("opens a PR or a Mattermost post when its link is clicked", async () => {
    const model = await hubModel();
    model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
    const opened: string[] = [];
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} pulse={() => false} now={() => NOW} openUrl={(url) => opened.push(url)} />, { width: 96, height: 42 });
    try {
      // Let the layout settle: the hit grid a click lands on is the one from the frame before.
      await setup.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
      await setup.renderOnce();
      const find = (label: string) => [...walk(setup.renderer.root)].find((node) => (node as unknown as { plainText?: string }).plainText?.includes(label))!;
      for (const [label, url] of [["⎇ #98", "https://github.com/satoramoto/indra/pull/98"], ["⎇ #103", "https://github.com/satoramoto/indra/pull/103"], ["⇗ goal thread", `https://mattermost.newegypt.io/yahaha/pl/${ids.thread}`], ["⇗ proposal post", `https://mattermost.newegypt.io/yahaha/pl/${ids.proposal}`]]) {
        const node = find(label);
        await setup.mockMouse.click(node.x + 1, node.y);
        expect(opened.at(-1), label).toBe(url);
      }
    } finally { setup.renderer.destroy(); }
  });
});

describe("per-cell polish", () => {
  const PALETTE = new Set(Array.from({ length: 240 }, (_, index) => ansi256Rgb(index + 16).join(",")));
  /** Every cell's colours on screen row `y`, from the captured spans. */
  const rowColors = (setup: Awaited<ReturnType<typeof testRender>>, y: number) => setup.captureSpans().lines[y].spans
    .flatMap((span) => Array.from({ length: Array.from(span.text).length }, () => ({ fg: span.fg.toInts().slice(0, 3).join(","), bg: span.bg.toInts().slice(0, 3).join(",") })));

  async function animate(model: TerminalUiModel, truecolor: boolean) {
    const [frame, setFrame] = createSignal(0);
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} pulse={() => false} now={() => NOW} frame={frame} truecolor={truecolor} />, { width: HUB_GRID.columns, height: HUB_GRID.rows });
    await setup.renderOnce();
    await setup.renderOnce();
    return { setup, setFrame };
  }

  it.each([
    ["a running sprint", () => hubModel()],
    ["the idle splash", () => hubModel(null)],
  ])("draws 60 animation frames over %s without creating a renderable", async (_name, make) => {
    const model = await make();
    model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
    const { setup, setFrame } = await animate(model, true);
    try {
      const nodes = walk(setup.renderer.root);
      const reads = vi.spyOn(model, "sessionsFor");
      const screens = new Set<string>();
      for (let tick = 1; tick <= 60; tick++) {
        setFrame(tick);
        await setup.renderOnce();
        screens.add(JSON.stringify(setup.captureSpans().lines.map((line) => line.spans.map((span) => [span.text, span.fg.toInts(), span.bg.toInts()]))));
      }
      expect(walk(setup.renderer.root)).toEqual(nodes);
      expect(reads).not.toHaveBeenCalled();
      // The frames really moved something: the header drift or the splash shimmer.
      expect(screens.size).toBeGreaterThan(1);
    } finally { setup.renderer.destroy(); }
  });

  it("drifts the header gradient only while a sprint is running", async () => {
    for (const [session, drifts] of [[hubSession(), true], [null, false]] as const) {
      const model = await hubModel(session);
      model.restore({ page: "team", teamId: "team-001" });
      const { setup, setFrame } = await animate(model, true);
      try {
        const before = rowColors(setup, 0).map((cell) => cell.bg);
        // Behind the title the bar is a gradient, not one flat colour.
        expect(new Set(before).size).toBeGreaterThan(5);
        setFrame(60);
        await setup.renderOnce();
        expect(rowColors(setup, 0).map((cell) => cell.bg).join(" ") !== before.join(" ")).toBe(drifts);
        // The title still reads on top of it.
        expect(setup.captureCharFrame().split("\n")[0]).toContain("INDRA  ›  Yahaha");
      } finally { setup.renderer.destroy(); }
    }
  });

  it("fills the progress bar in the current stage's colour and snaps every drawn colour to 256 without truecolor", async () => {
    for (const truecolor of [true, false]) {
      const model = await hubModel();
      model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
      const { setup } = await animate(model, truecolor);
      try {
        const lines = setup.captureCharFrame().split("\n");
        const y = lines.findIndex((line) => line.includes(" progress "));
        const x = Array.from(lines[y]).indexOf("▀");
        const cells = rowColors(setup, y);
        expect(cells[x].bg).toBe(paint(STAGE_COLOR.implement, truecolor).join(","));
        // The bar spans the row inside the page's one-column side padding.
        const header = rowColors(setup, 0).slice(1, -1).map((cell) => cell.bg);
        const drawn = [...header, ...cells.slice(x, x + 24).flatMap((cell) => [cell.fg, cell.bg])];
        if (truecolor) expect(drawn.some((color) => !PALETTE.has(color))).toBe(true);
        else expect(drawn.filter((color) => !PALETTE.has(color))).toEqual([]);
      } finally { setup.renderer.destroy(); }
    }
  });

  it("never paints the progress bar outside its scroll box on a short screen", async () => {
    const model = await hubModel();
    model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} pulse={() => false} now={() => NOW} frame={() => 0} truecolor />, { width: 96, height: 16 });
    try {
      await setup.renderOnce();
      const scroll = setup.renderer.root.findDescendantById("team-scroll") as ScrollBoxRenderable;
      for (let top = 0; top < scroll.scrollHeight; top++) {
        scroll.scrollTo(top);
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const outside = lines.filter((_, y) => y < scroll.y || y >= scroll.y + scroll.height);
        expect(outside.filter((line) => line.includes("▀") || line.includes("▄")), "scrolled to " + top).toEqual([]);
        expect(lines[0]).toContain("INDRA");
      }
    } finally { setup.renderer.destroy(); }
  });

  it("shows the INDRA wordmark on a team with no open sprint, inside 96×42", async () => {
    const model = await hubModel(null);
    model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
    const { setup } = await animate(model, true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      await keep("idle-splash", frame);
      // The seats table keeps its full width: the splash never pushes a scroll bar in.
      const lines = frame.split("\n");
      const header = lines.find((line) => line.includes(" TASK ")) ?? "";
      expect(header.trimEnd().endsWith("PR    CI"), frame).toBe(true);
      // One column of page padding, then the table across the whole content width.
      expect(header.trimEnd().length).toBe(1 + HUB_GRID.columns - 3);
      // Centred in the content width: the page's side padding and the column kept free for the scroll bar.
      expect(lines.find((line) => line.includes("No sprint open"))?.indexOf("No sprint open")).toBe(1 + Math.floor((HUB_GRID.columns - 3 - 14) / 2));
      expect(frame).toContain("No sprint open");
      expect(frame).toContain("█");
      expect(frame.split("\n").length - 1).toBe(HUB_GRID.rows);
      const scroll = setup.renderer.root.findDescendantById("team-scroll") as ScrollBoxRenderable;
      expect(scroll.scrollHeight, frame).toBeLessThanOrEqual(scroll.height);
    } finally { setup.renderer.destroy(); }
  });
});

describe("three-role goal hub", () => {
  const completedJournal = { version: 1, teamId: "team-001", seatId: "seat-002", active: null, runs: { finished: { status: "complete" } }, vetting: {}, deliveries: {} };
  async function productHub(journal: unknown) {
    const state = structuredClone(snapshot); state.teams[0].workflowModel = "goals-v1"; state.teams[0].seats[1].roles = ["Product"];
    const proposal: ProductProposal = { version: 1, goalId: "goal-next", proposalId: "proposal-next", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "Improve recovery", outcomes: [{ number: 1, title: "Improve", description: "Improve reliability", reason: "Mission", currentCode: ["src/work.ts"] }], ownedFiles: ["src/work.ts"], risks: [], rationale: "Useful improvement", basedOnRetros: [] };
    const record: ProductRuntimeRecord = { version: 1, teamId: "team-001", seatId: "seat-002", queue: Array.from({ length: 5 }, (_, index) => ({ proposal: { ...proposal, goalId: `goal-${index}`, proposalId: `proposal-${index}`, rank: index + 1 }, status: index ? "proposed" : "posted", vetting: null, rootPostId: index ? null : ids.proposal, proposalPostId: index ? null : ids.proposal })), events: [], handledEventIds: [], pending: null, failure: null, updatedAt: ago(1) };
    const product = await readProductFacts({ readRuntimeFile: async <T,>(name: string) => {
      if (name === productRuntimeFilename("team-001")) return structuredClone(record) as T;
      expect(name).toBe(productJournalFilename("team-001"));
      if (journal instanceof Error) throw journal;
      return structuredClone(journal) as T | undefined;
    } }, "team-001", "seat-002");
    const facts: Record<string, SeatLive> = { "seat-002": { process: "running", product, attach: { kind: "tmux", target: "indra:product" } } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => ({ connection: "connected", sessions: [] }) }, { ensureAll: async () => [], read: async () => facts, stop: async () => {}, restart: async () => {} });
    await model.refresh(); model.restore({ page: "team", teamId: "team-001" });
    return { model, live: facts["seat-002"], seat: state.teams[0].seats[1] };
  }

  it("shows the posted Product approval action after a completed run, with neutral idle occupancy and real failure precedence", async () => {
    const { model, live, seat } = await productHub(completedJournal);
    expect(model.sessionsFor(seat.id)).toEqual([]); expect(model.liveUsage).toEqual({});
    expect(live.product?.runState).toBe("idle");
    expect(occupancy(model, seat).label).toBe("no active session");
    expect(seatInfo(model, seat)).toMatchObject({ state: "needs", attention: "Proposal awaits your approval: Improve recovery" });
    const [revision, setRevision] = createSignal(model.revision);
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 120, height: 54 });
    try {
      await setup.renderOnce(); let frame = setup.captureCharFrame();
      expect(frame).toContain("NEEDS YOU · 1"); expect(frame).toContain("Proposal awaits your approval: Improve recovery");
      expect(frame).not.toContain("current session evidence unavailable");
      model.restore({ page: "seat", teamId: "team-001", seatId: seat.id }); setRevision((n) => n + 1);
      await setup.renderOnce(); frame = setup.captureCharFrame(); expect(frame).toContain("no active session");
      expect(frame).not.toContain("current session evidence unavailable");
      live.product!.failure = { message: "Product source could not be read", retryable: true, at: ago(1) };
      await model.refresh(); model.restore({ page: "team", teamId: "team-001" }); setRevision((n) => n + 1);
      await setup.renderOnce(); frame = setup.captureCharFrame();
      expect(frame).toContain("Product source could not be read"); expect(frame).not.toContain("Proposal awaits your approval");
      expect(seatInfo(model, seat).state).toBe("failed"); expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
      live.problem = "Product host credentials are unavailable";
      expect(seatInfo(model, seat).attention).toBe("Product host credentials are unavailable");
    } finally { setup.renderer.destroy(); }
  });

  it.each([
    ["missing", undefined], ["unreadable", new Error("Unreadable journal")],
    ["wrong team", { ...completedJournal, teamId: "team-other" }], ["wrong seat", { ...completedJournal, seatId: "seat-other" }],
    ["wrong version", { ...completedJournal, version: 2 }], ["missing activity", { ...completedJournal, active: undefined }],
    ["malformed activity", { ...completedJournal, active: false }], ["malformed runs", { ...completedJournal, runs: [] }],
    ["malformed run status", { ...completedJournal, runs: { finished: { status: "unknown" } } }],
  ])("keeps %s Product activity unknown without hiding its posted proposal", async (_name, journal) => {
    const { model, live, seat } = await productHub(journal);
    expect(live.product).toBeDefined(); expect(live.product?.runState).toBeUndefined();
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
    expect(seatInfo(model, seat).attention).toBe("Proposal awaits your approval: Improve recovery");
  });

  it("keeps a headless active Product turn active when no live token log exists", async () => {
    const { model, live, seat } = await productHub({ ...completedJournal, active: { causeId: "redirect:one", remaining: 1, refineGoalId: "goal-1", runId: "working" }, runs: { working: { status: "started" } } });
    expect(model.liveUsage).toEqual({}); expect(live.product?.runState).toBe("active");
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
    live.product!.queue = [];
    expect(seatInfo(model, seat).state).toBe("running");
    live.process = "stopped";
    expect(seatInfo(model, seat).state).toBe("waiting");
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
  });

  it("does not let an idle journal hide pending delivery, a stopped host, disconnected readings or a live session", async () => {
    const { model, live, seat } = await productHub(completedJournal);
    live.product!.pending = { goalId: "goal-0", proposalId: "proposal-0", deliveryId: "delivery-0", message: "Pending proposal" };
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
    live.product!.pending = null; live.process = "stopped";
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
    live.process = "running"; model.sessionResult.connection = "error";
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
    model.sessionResult.connection = "connected"; model.liveUsage[seat.id] = { engine: "claude", usage: { outputTokens: 1 } };
    expect(occupancy(model, seat).label).toBe("running session · Claude Code");
    model.liveUsage = {};
    model.sessionResult.sessions = [{ ...hubSession(), seatId: seat.id, status: "running", sessionId: undefined }];
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
    model.sessionResult.sessions[0].status = "error";
    expect(occupancy(model, seat).label).toBe("current session evidence unavailable");
  });

  it("renders whole-goal lanes, scheduler overlap and ranked Product proposals in their actual seat views", async () => {
    const { projectGoalRuntime } = await import("../src/goal-contract.js");
    const state = structuredClone(snapshot); state.teams[0].workflowModel = "goals-v1"; state.teams[0].seats[1].roles = ["Product"];
    const proposal: import("../src/goal-contract.js").ProductProposal = { version: 1, goalId: "goal-next", proposalId: "proposal-next", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "First ranked improvement", outcomes: [{ number: 1, title: "Improve", description: "Improve reliability", reason: "Mission", currentCode: ["src/work.ts"] }], ownedFiles: ["src/work.ts"], risks: [], rationale: "Useful improvement", basedOnRetros: [] };
    const brief: import("../src/goal-contract.js").GoalBrief = { version: 1, goalId: "goal-owned", teamId: "team-001", seatId: "seat-003", header: { repo: "satoramoto/indra", baseBranch: "main", baseSha: "a".repeat(40), branch: "sprint/goal-owned", prTarget: "main" }, outcomes: proposal.outcomes, ownedFiles: ["src/work.ts"], exclusions: [], swarm: "One file per worker", retros: [], redirects: [], reportFormat: "Report evidence" };
    const progress = projectGoalRuntime({ version: 1, goalId: "goal-owned", teamId: "team-001", assignment: { seatId: "seat-003", status: "running", updatedAt: ago(1) }, brief, plan: null, report: null, failure: null, events: [], handledEventIds: [], redirects: [], updatedAt: ago(1), lanes: [{ id: "lane-work", branch: "codex/goal-work", ownedFiles: ["src/work.ts"], dependsOn: [], status: "reviewing", prUrl: "https://github.com/satoramoto/indra/pull/123", headSha: "b".repeat(40), mergedSha: null, reviewer: "satori-miyamoto", review: "pending", ci: "passed", findings: [], fixRounds: 0, conflictRounds: 0, decisions: ["Keep the scope"], followUps: ["Measure latency later"], updatedAt: ago(1) }] });
    const facts: Record<string, SeatLive> = {
      "seat-001": { process: "running", scheduler: { version: 1, teamId: "team-001", approvedQueue: [{ goalId: "goal-waiting", rank: 2, ownedFiles: ["src/work.ts"], blockedByGoalIds: ["goal-owned"] }], activeDispatches: [{ goalId: "goal-owned", seatId: "seat-003", status: "running", assignedAt: ago(2), brief }], events: [], handledEventIds: [], redirects: [], failure: null, updatedAt: ago(1) }, attach: { kind: "tmux", target: "indra:chick" } },
      "seat-002": { process: "running", attach: { kind: "tmux", target: "indra:product" }, product: { version: 1, teamId: "team-001", seatId: "seat-002", queue: [{ proposal: { ...proposal, goalId: "goal-second", proposalId: "proposal-second", summary: "Second ranked improvement", rank: 2 }, status: "proposed", vetting: null, rootPostId: null, proposalPostId: null }, { proposal, status: "posted", vetting: null, rootPostId: "root", proposalPostId: "root" }], events: [], handledEventIds: [], pending: null, failure: null, updatedAt: ago(1) } },
      "seat-003": { process: "running", attach: { kind: "tmux", target: "indra:developer" }, goal: { goalId: "goal-owned", title: "Deliver one goal", status: "running", ownedFiles: ["src/work.ts"], progress }, assignment: { title: "Obsolete outcome queue", status: "running" } },
    };
    const session: TerminalSession = { ...hubSession(), id: "goal-owned", goal: "Deliver one goal", workflowModel: "goals-v1", goalOwnerSeatId: "seat-003", engine: "unknown", sessionId: undefined, loop: { stage: "implement", workflowModel: "goals-v1", tickets: [], goal: facts["seat-003"].goal, ceremony: { version: 1, stage: "implement", history: [] } } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => state }), { readSessions: async () => ({ connection: "connected", sessions: [session] }) }, { ensureAll: async () => [], read: async () => facts, stop: async () => {}, restart: async () => {} });
    await model.refresh(); const [revision, setRevision] = createSignal(model.revision);
    model.restore({ page: "seat", teamId: "team-001", seatId: "seat-001" });
    const setup = await testRender(() => <TerminalApp model={model} revision={revision} onKey={() => {}} />, { width: 140, height: 54 });
    const text = async () => { await setup.renderOnce(); const scroll = setup.renderer.root.findDescendantById("detail-scroll") as ScrollBoxRenderable; const frames: string[] = []; for (let top = 0; top < scroll.scrollHeight; top += 10) { scroll.scrollTo(top); await setup.renderOnce(); frames.push(setup.captureCharFrame()); } return frames.join("\n"); };
    try {
      let frame = await text(); expect(frame).toContain("Scheduler · approved queue and active goals"); expect(frame).toContain("goal-waiting"); expect(frame).toContain("overlap blocked by goal-owned"); expect(frame).toContain("seat-003 · running");
      model.seatId = "seat-002"; setRevision((n) => n + 1); frame = await text();
      expect(frame).toContain("Product · ranked proposed queue"); expect(frame).toContain("awaiting owner approval");
      expect(frame.indexOf("1. First ranked improvement")).toBeLessThan(frame.indexOf("2. Second ranked improvement"));
      expect(frame).toContain("Product runner"); expect(model.attachTarget()).toBe("indra:product");
      expect(model.sessionsFor("seat-002")).toEqual([]);
      delete facts["seat-002"].product; await model.refresh(); setRevision((n) => n + 1); frame = await text();
      expect(frame).toContain("Product queue unavailable."); expect(frame).toContain("current session evidence unavailable");
      model.seatId = "seat-003"; setRevision((n) => n + 1); frame = await text();
      expect(frame).toContain("Deliver one goal"); expect(frame).toContain("lane-work"); expect(frame).toContain("#123"); expect(frame).toContain("CI passed");
      expect(frame).toContain("Keep the scope"); expect(frame).toContain("Measure latency later"); expect(frame).not.toContain("Obsolete outcome queue");
      expect(model.attachTarget()).toBe("indra:developer"); expect(model.sessionsFor("seat-003").map((item) => item.id)).toEqual(["goal-owned"]);
    } finally { setup.renderer.destroy(); }
  });
});
