import { testRender } from "@opentui/solid";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel, type TerminalSession } from "../src/terminal-ui.js";
import { openLink, TerminalApp } from "../src/terminal-ui-solid.js";
import { HUB_GRID, sprintLinks } from "../src/hub-view.js";
import type { SeatLive, SeatProcessPort } from "../src/supervisor.js";
import type { CeremonyStage } from "../src/session-snapshot.js";
import { CEREMONY_STAGES, LocalSessionReader } from "../src/session-snapshot.js";
import {
  formatElapsed, formatTokens, mattermostChannelUrl, mattermostPostUrl, openableUrl, parseUsage, pipelineSteps, prLabel, sumUsage, totalTokens, usageLine,
} from "../src/hub-format.js";
import { assignmentFacts, seatHarness } from "../src/hub-facts.js";
import type { ImplementationFacts } from "../src/implementation-facts.js";
import type { SeatTaskRecord } from "../src/developer-seat.js";
import type { RuntimeRecord } from "../src/planning.js";

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
    expect(usageLine(total)).toBe("in 1.25M · cached 1M · out 50k · Σ 1.3M tok");
    expect(usageLine(undefined)).toBe("no tokens recorded yet");
    expect(sumUsage([undefined])).toBeUndefined();
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
    expect(assignmentFacts(record, ledger)).toEqual({ step: "ci", fixRounds: 1, ci: "pending", usage: { inputTokens: 300, cachedInputTokens: 150, outputTokens: 30 }, sessions: 2, engine: "claude", claimedAt: "2026-01-01T01:00:00Z" });
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
      facts: { step: "ci", fixRounds: 0, ci: "pending", usage: usage(1.25), sessions: 3, engine: "codex", claimedAt: ago(47) } } },
  "seat-003": { process: "running", harness: seatHarness("claude", ["Developer"]), activity: { message: "Building the pipeline row", at: ago(1) },
    assignment: { title: titles[1], status: "running", goalId: "goal-hub", outcomeId: "o2", facts: { step: "build", usage: usage(0.4), sessions: 1, claimedAt: ago(12) } } },
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

async function hubModel(session = hubSession()) {
  const processes: SeatProcessPort = { ensureAll: async () => [], read: async () => live, stop: async () => {}, restart: async () => {}, retry: async () => "" };
  // The header's sync and update lines are on, as in the real app: 42 rows must hold them too.
  const stamp = { id: "build-1", sha: "82e2001aa", builtAt: ago(60) };
  const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [session] }) }, processes,
    { start: vi.fn(), propose: vi.fn(), approve: vi.fn(), sprint: vi.fn() }, { sync: vi.fn() },
    { running: stamp, canReload: true, check: vi.fn(), current: async () => stamp });
  await model.refresh();
  model.syncResult = { outcome: "synced", message: "Up to date with origin/main", changed: false, at: ago(1) };
  model.updateResult = { outcome: "up-to-date", message: "Up to date", at: ago(1) };
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

describe("the hub on the owner's screen", () => {
  it("documents the grid it is designed for", () => {
    expect(HUB_GRID).toEqual({ columns: 96, rows: 42 });
  });

  it.each([
    ["team", { page: "team" as const, seatId: "seat-002" }],
    ["developer-seat", { page: "seat" as const, seatId: "seat-002" }],
    ["lead-seat", { page: "seat" as const, seatId: "seat-001" }],
    ["teams", { page: "teams" as const }],
  ])("fits the %s screen in 96×42 with every key field whole", async (name, view) => {
    const model = await hubModel();
    model.restore({ ...view, teamId: "team-001" });
    const session = { capture: async (_seat: unknown, size: { rows: number }) => ({ status: "ok" as const, lines: Array.from({ length: 20 }, (_, index) => [{ text: `15:${String(index).padStart(2, "0")} ⚙ step ${index}`, style: {} }]).slice(-size.rows) }) };
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} session={session} pulse={() => false} now={() => NOW} />, { width: HUB_GRID.columns, height: HUB_GRID.rows });
    try {
      await setup.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      await keep(name, frame);
      const scroll = setup.renderer.root.findDescendantById(view.page === "seat" ? "detail-scroll" : "team-scroll") as ScrollBoxRenderable | undefined;
      // Nothing to scroll on the team screens: the content is no taller than the screen gives it. On a seat screen the
      // live session takes most rows and the details are their own scrolling panel: every field is reachable by scrolling it.
      const frames = [frame];
      if (scroll && view.page === "seat") {
        for (let page = 0; page < 10 && scroll.scrollTop + scroll.viewport.height < scroll.scrollHeight; page++) {
          scroll.scrollBy(1, "viewport");
          await setup.renderOnce();
          frames.push(setup.captureCharFrame());
        }
      } else if (scroll) expect(scroll.scrollHeight, frame).toBeLessThanOrEqual(scroll.height);
      const expected: Record<string, string[]> = {
        team: [...names, "Developer", "Team Lead", "NO CREDENTIAL", "Codex gpt-6-sol·medium", "Claude opus-5-5·max", "Claude opus-5-5·medium", "⌛ 47m", "⌛ 12m", "🧮 Σ1.3M",
          "🐙 #103", "🟡", "The 1Password service account token is missing; run npm start again.", "Keep the hub inside a 96 by 42 terminal · failed · T retry",
          "SPRINT · goal-hub", "Current stage: implement", "Closure: open", "planning → proposal → [implement] → release → retro", "1/4 merged",
          "💬 goal thread", "📝 proposal post", "🧮 Sprint total: in 6.25M · cached 5M · out 250k · Σ 6.5M tok · ⌛ 3h20m since planning",
          ...titles.map((title, index) => title + " · " + ["in review", "building", "merged", "failed"][index]),
          "👤 George Duke", "🐙 #98", "🟢 CI passed", "🔴 CI failed", "Integration PR: not opened", "↑↓ choose seat · Enter open seat"],
        "developer-seat": ["LIVE · George Duke · progress · click or i to drive", "SEATS", ...names, "George Duke  @georgeduke", "Process: running (seat runner)", "🤖 Codex · model gpt-6-sol · effort medium",
          `Assignment: ${titles[0]} · in-review`, "🐙 satoramoto/indra#103", "🟡 CI pending", "build ✓", "review ✓", "fix skipped", "ci ●", "merge",
          "🟡 CI pending", "3 sessions · ⌛ 47m on this task", "🧮 in 1.25M · cached 1M · out 50k · Σ 1.3M tok", "Latest: Opened PR 103; review requested",
          "SPRINT · goal-hub", "Current stage: implement", "Closure: open", "planning → proposal → [implement] → release → retro", "1/4 tickets merged",
          "Tab next panel · i drive session · t transcript"],
        "lead-seat": ["LIVE · Chick Corea · progress · click or i to drive", "Chick Corea  @chickcorea", "Process: running (planning bridge)", "🤖 Claude · model claude-opus-5-5 · effort max",
          "🧮 Planning: in 2.1M · cached 1.68M · out 84k · Σ 2.18M tok", "IDLE SESSION · Claude Code", "Planning goal: Make the terminal UI the owner's all-day hub",
          "Claude Code session: claude:0e5f9f3e-1111-4222-8333-944445555666", "4 runs", "Live session: shown above · i or a click on it drives", "Current stage: implement", "💬 goal thread", "📝 proposal post"],
        teams: ["👥 Yahaha  (yahaha)", "5 stable seats", "🐙 satoramoto/indra", "↑↓ choose team · Enter open"],
      };
      // Word wrapping inside a box is fine; cutting a key field short is not. Compare without spaces and box edges.
      const compact = (text: string) => text.replace(view.page === "seat" ? /[\s│█▀▄]/g : /[\s│]/g, "");
      for (const text of expected[name]) expect(frames.map(compact).join("\n"), text + "\n" + frames.join("\n")).toContain(compact(text));
      for (const shown of frames) expect(shown).not.toMatch(/tmux|Ctrl-\]|Ctrl-b/);
      expect(frame.split("\n").length - 1).toBe(HUB_GRID.rows);
    } finally { setup.renderer.destroy(); }
  });

  it("colours states consistently and blinks what needs the owner", async () => {
    const model = await hubModel();
    model.restore({ page: "team", teamId: "team-001", seatId: "seat-002" });
    const [pulse, setPulse] = createSignal(false);
    const setup = await testRender(() => <TerminalApp model={model} revision={() => model.revision} onKey={() => {}} pulse={pulse} now={() => NOW} />, { width: 96, height: 42 });
    try {
      await setup.renderOnce();
      // The colour of `text` on the row that names `seat`.
      const color = (seat: string, text: string) => setup.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(seat)))
        ?.spans.find((span) => span.text.includes(text))?.fg.toInts().slice(0, 3);
      const before = { failed: color("Corey Henry", "NO CREDENTIAL"), needs: color("Jordan Rudess", "RUNNING"), running: color("Aaron Magner", "RUNNING") };
      expect(before).toEqual({ failed: [248, 113, 113], needs: [244, 114, 182], running: [74, 222, 128] });
      setPulse(true);
      await setup.renderOnce();
      expect(color("Corey Henry", "NO CREDENTIAL")).not.toEqual(before.failed);
      expect(color("Jordan Rudess", "RUNNING")).not.toEqual(before.needs);
      expect(color("Aaron Magner", "RUNNING")).toEqual(before.running);
    } finally { setup.renderer.destroy(); }
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
      await setup.renderOnce();
      const find = (label: string) => [...walk(setup.renderer.root)].find((node) => (node as unknown as { plainText?: string }).plainText?.includes(label))!;
      for (const [label, url] of [["🐙 #98", "https://github.com/satoramoto/indra/pull/98"], ["💬 goal thread", `https://mattermost.newegypt.io/yahaha/pl/${ids.thread}`], ["📝 proposal post", `https://mattermost.newegypt.io/yahaha/pl/${ids.proposal}`]]) {
        const node = find(label);
        await setup.mockMouse.click(node.x + 1, node.y);
        expect(opened.at(-1), label).toBe(url);
      }
    } finally { setup.renderer.destroy(); }
  });
});
