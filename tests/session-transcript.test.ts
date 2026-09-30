import { describe, expect, it, vi } from "vitest";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxHost, type HostRecord } from "../src/tmux-host.js";
import { headedMarkerFile } from "../src/headed-session.js";
import { PlanningStore } from "../src/planning.js";
import { stateCheckout } from "./state-checkout.js";
import { claudeProjectDir, ENTRY_LIMIT, LocalTranscriptSource, parseSessionHandle, parseTranscript, safeText, TranscriptLocator, TranscriptTail } from "../src/session-transcript.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "transcripts", name), "utf8");
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const transcriptState = (newModel: boolean) => ({ $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [], teams: [{
  id: "team-one", slug: "fixture", displayName: "Fixture", ...(newModel ? { workflowModel: "goals-v1" } : {}), project: { github: "fixture/project" },
  externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } },
  seats: ["Team Lead", newModel ? "Product" : "Developer", "Developer"].map((role, index) => ({ id: `seat-00${index + 1}`, displayName: `Seat ${index + 1}`, roles: [role], externalIdentities: { mattermost: { userId: `user-${index + 1}`, username: `seat${index + 1}` } } })),
}] });


describe("session transcript parsing", () => {
  it("turns a Claude transcript into prompts, thinking, tool calls, results and errors, redacted", async () => {
    const entries = parseTranscript("claude", await fixture("claude-session.jsonl"));
    expect(entries.map((entry) => [entry.kind, entry.label])).toEqual([
      ["user", "Prompt"],
      ["thinking", "Thinking"],
      ["assistant", "Assistant"],
      ["tool", "Tool · Bash"],
      ["result", "Result"],
      ["tool", "Tool · Read"],
      ["error", "Tool error"],
      ["error", "Error"],
    ]);
    expect(entries[0]).toEqual({ kind: "user", label: "Prompt", text: "Build the outcome: add a help overlay.", at: "2026-09-29T10:00:01.000Z" });
    expect(entries[3]!.text).toBe("grep -n overlay src/terminal-ui.ts");
    expect(entries[5]!.text).toBe('{"file_path":"/tmp/missing.ts"}');
    expect(entries[6]!.text).toBe("File does not exist.");
    expect(entries[7]!.text).toBe("API Error: 529 overloaded");
    const all = JSON.stringify(entries);
    expect(all).not.toContain("ghp_");
    expect(all).not.toContain("abc.def.ghi");
    expect(entries[1]!.text).toContain("token=[redacted]");
    expect(entries[4]!.text).toContain("Bearer [redacted]");
  });

  it("turns a Codex rollout into the same kinds, skipping injected context and duplicate events", async () => {
    const entries = parseTranscript("codex", await fixture("codex-rollout.jsonl"));
    expect(entries.map((entry) => [entry.kind, entry.label])).toEqual([
      ["user", "Prompt"],
      ["thinking", "Thinking"],
      ["tool", "Tool · shell"],
      ["result", "Result"],
      ["tool", "Tool · shell"],
      ["error", "Tool error"],
      ["tool", "Tool · apply_patch"],
      ["result", "Result"],
      ["assistant", "Assistant"],
      ["error", "Error"],
    ]);
    expect(entries[2]!.text).toBe("bash -lc gh pr diff 12");
    expect(entries[3]!.text).toBe("diff --git a/x b/x\n+export GH_TOKEN=[redacted]");
    expect(entries[5]!.text).toBe("1 failed");
    expect(entries[1]!.text).toBe("**Checking the diff** with password: [redacted]");
    expect(entries[9]!.text).toBe("stream disconnected before completion");
    expect(JSON.stringify(entries)).not.toMatch(/ghp_|hunter2/);
  });

  it("strips terminal escapes and redacts before cutting long text, so a cut never exposes part of a secret", () => {
    const secret = "ghp_" + "a1".repeat(30);
    const text = safeText("\u001b[31mred\u001b[0m " + "x".repeat(20) + " " + secret, 30);
    expect(text).toBe("red " + "x".repeat(20) + " [reda … (5 more characters)");
    expect(text).not.toContain("ghp_");
    const long = parseTranscript("claude", JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "y".repeat(5000) }] } }));
    expect(long[0]!.text.startsWith("y".repeat(ENTRY_LIMIT.result) + " … (")).toBe(true);
  });

  it("accepts only engine-qualified session handles", () => {
    expect(parseSessionHandle("claude:" + CLAUDE_ID)).toEqual({ engine: "claude", id: CLAUDE_ID });
    expect(parseSessionHandle(CODEX_ID)).toEqual({ engine: "codex", id: CODEX_ID });
    for (const bad of [undefined, "", "claude:../../etc", "../" + CODEX_ID, "codex-123"]) expect(parseSessionHandle(bad)).toBeUndefined();
  });
});

describe("session transcript files", () => {
  it("reads a growing log from where it stopped and holds back a partial line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indra-transcript-"));
    const path = join(dir, "log.jsonl");
    const line = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    await writeFile(path, line("one") + "\n" + line("two").slice(0, 20));
    const tail = new TranscriptTail(path, "claude");
    expect((await tail.read()).map((entry) => entry.text)).toEqual(["one"]);
    await appendFile(path, line("two").slice(20) + "\n" + line("three") + "\n");
    expect((await tail.read()).map((entry) => entry.text)).toEqual(["two", "three"]);
    expect(await tail.read()).toEqual([]);
    // A long log starts near its end, at a whole line.
    const big = new TranscriptTail(path, "claude", line("three").length + 5);
    expect((await big.read()).map((entry) => entry.text)).toEqual(["three"]);
  });

  it("finds Chick's recorded Claude session and a Developer seat's live Codex and Claude logs in their own homes", async () => {
    const root = await mkdtemp(join(tmpdir(), "indra-locate-"));
    const checkout = join(root, "indra-state");
    const runtime = checkout + ".runtime";
    const home = join(root, "home");
    await mkdir(checkout); await writeFile(join(checkout, "state.json"), JSON.stringify(transcriptState(false)));
    // Chick's recorded Claude session, in the owner's Claude home.
    const chickLog = join(home, ".claude", "projects", "-work-indra", `${CLAUDE_ID}.jsonl`);
    await mkdir(join(chickLog, ".."), { recursive: true });
    await writeFile(chickLog, await fixture("claude-session.jsonl"));
    const locator = new TranscriptLocator(checkout, {}, home);
    const lead = { id: "seat-001", roles: ["Team Lead"] };
    expect(await locator.locate(lead, "claude:" + CLAUDE_ID)).toEqual({ engine: "claude", sessionId: CLAUDE_ID, path: chickLog });
    expect(await locator.locate(lead, undefined)).toBeUndefined();

    // A Developer seat: its task record names the worktree and an older Codex session.
    const dev = { id: "seat-002", roles: ["Developer"] };
    const worktree = join(runtime, "worktrees", "goal-1234abcd-outcome-1");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(runtime, "seat-seat-002-goal-1234abcd-outcome-1.json"), JSON.stringify({ worktree, sessions: [{ role: "developer", sessionId: CODEX_ID }] }));
    // Another seat whose ID starts the same way is never read.
    await writeFile(join(runtime, "seat-seat-002-x-goal-1234abcd-outcome-1.json"), JSON.stringify({ worktree, sessions: [{ sessionId: "claude:" + CLAUDE_ID }] }));
    const day = join(runtime, "harness", "seat-002", "codex", "sessions", "2026", "09", "29");
    await mkdir(day, { recursive: true });
    const recorded = join(day, `rollout-2026-09-29T10-00-00-${CODEX_ID}.jsonl`);
    await writeFile(recorded, await fixture("codex-rollout.jsonl"));
    await utimes(recorded, new Date(1_000_000), new Date(1_000_000));
    expect(await locator.locate(dev)).toEqual({ engine: "codex", sessionId: CODEX_ID, path: recorded });

    // A newer, not yet recorded Claude session in the active worktree's project wins while it runs.
    const liveId = "99999999-8888-4777-8666-555555555555";
    const project = join(home, ".claude", "projects", claudeProjectDir(worktree));
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${liveId}.jsonl`), "");
    expect(await locator.locate(dev)).toEqual({ engine: "claude", sessionId: liveId, path: join(project, `${liveId}.jsonl`) });

    // The source follows the located file and reports new entries only once.
    let now = 0;
    const feed = new LocalTranscriptSource(locator, 5000, () => now).feed(lead, () => "claude:" + CLAUDE_ID);
    const first = await feed.poll();
    expect(first.status === "ok" && first.reset && first.entries.length).toBe(8);
    now = 1000;
    expect(await feed.poll()).toMatchObject({ status: "ok", reset: false, entries: [] });
    expect((await stat(chickLog)).isFile()).toBe(true);
  });
});


it("routes Product to its own verified finite-run log and never to an old outcome or Chick's handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "indra-product-transcript-"));
  const checkout = join(root, "fixture-state"); const runtime = checkout + ".runtime"; const home = join(root, "home");
  const chickLog = join(home, ".claude/projects/chick", `${CLAUDE_ID}.jsonl`);
  await mkdir(join(chickLog, ".."), { recursive: true }); await writeFile(chickLog, await fixture("claude-session.jsonl"));
  await mkdir(runtime); await writeFile(join(runtime, "seat-seat-002-goal-old-outcome-1.json"), JSON.stringify({ sessions: [{ sessionId: "claude:" + CLAUDE_ID }] }));
  const locator = new TranscriptLocator(checkout, {}, home); const product = { id: "seat-002", roles: ["Product"] };
  const ownership = vi.spyOn(TmuxHost.prototype, "verifiedRecord").mockResolvedValue(undefined);
  try {
    expect(await locator.locate(product, "claude:" + CLAUDE_ID)).toBeUndefined();
    const nonce = "00000000-0000-4000-8000-000000000001";
    const id = "99999999-8888-4777-8666-555555555555";
    const ownLog = join(home, ".claude/projects/product", `${id}.jsonl`);
    await mkdir(join(ownLog, ".."), { recursive: true }); await writeFile(ownLog, await fixture("claude-session.jsonl"));
    await writeFile(headedMarkerFile(checkout, nonce), JSON.stringify({ pid: process.pid, engine: "claude", startedAt: new Date().toISOString(), log: ownLog }));
    ownership.mockImplementation(async function (this: TmuxHost) {
      expect(this.hosted).toEqual({ kind: "seat", seatId: "seat-002" });
      return { readyNonce: nonce } as HostRecord;
    });
    expect(await locator.locate(product, "claude:" + CLAUDE_ID)).toEqual({ engine: "claude", sessionId: id, path: ownLog });
    ownership.mockRejectedValue(new Error("Foreign host"));
    expect(await locator.locate(product, "claude:" + CLAUDE_ID)).toBeUndefined();
  } finally { ownership.mockRestore(); }
});


describe("finite transcripts require current-run evidence", () => {
  const at = "2026-09-29T12:00:00Z";
  const readiness = { version: 1 as const, consumers: { planning: 1 as const, developer: 1 as const, release: 1 as const, retro: 1 as const, tui: 1 as const } };
  const cases = (["Product", "idle Developer", "active Developer", "reported Developer"] as const)
    .flatMap((role) => (["claude", "codex"] as const).map((engine) => ({ role, engine })));
  it.each(cases)("does not show stale own $engine logs for a $role", async ({ role, engine }) => {
    const checkout = await stateCheckout("indra-finite-transcript-", transcriptState(true));
    const runtime = checkout + ".runtime"; const home = join(runtime, "fixture-home");
    const store = new PlanningStore(checkout, undefined, readiness);
    await mkdir(join(checkout, "schema/v1"), { recursive: true });
    await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(checkout, "schema/v1/state.schema.json"));
    if (role === "active Developer" || role === "reported Developer") {
      const proposal = { version: 1 as const, goalId: "goal-transcript", proposalId: "proposal-transcript", productSeatId: "seat-002", rank: 1, mission: "docs/mission.md", summary: "Transcript fixture", outcomes: [{ number: 1, title: "Deliver", description: "Deliver the goal", reason: "Mission", currentCode: ["src/work.ts"] }], ownedFiles: ["src/work.ts"], risks: [], rationale: "Fixture", basedOnRetros: [] };
      await store.publishProductProposal("team-one", proposal, { id: "proposal-post", userId: "user-2", channelId: "home", rootId: "", createdAt: at }, { proposalId: proposal.proposalId, leadSeatId: "seat-001", ownedFiles: proposal.ownedFiles, notes: [], at });
      await store.approveGoal(proposal.goalId, { kind: "approval", proposalId: proposal.proposalId, proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at } });
      await store.assignGoal(proposal.goalId, "seat-003", { branch: "sprint/goal-transcript", baseSha: "a".repeat(40), status: "collecting" });
      await store.update((state) => { state.planningGoals![0].goalAssignment!.status = role === "reported Developer" ? "reported" : "running"; }, "Fixture assignment state");
    }
    const seat = { id: role === "Product" ? "seat-002" : "seat-003", roles: [role === "Product" ? "Product" : "Developer"] };
    const locator = new TranscriptLocator(checkout, {}, home);
    const worktree = join(runtime, "worktrees", "goal-old-outcome-one"); await mkdir(worktree, { recursive: true });
    const directory = engine === "claude" ? join(locator.claudeRoots(seat.id)[0], claudeProjectDir(worktree)) : join(locator.codexSessions(seat.id), "2026", "09", "29");
    const oldId = engine === "claude" ? CLAUDE_ID : CODEX_ID;
    const oldLog = join(directory, engine === "claude" ? `${oldId}.jsonl` : `rollout-2026-09-29T10-00-00-${oldId}.jsonl`);
    await mkdir(directory, { recursive: true }); await writeFile(oldLog, await fixture(engine === "claude" ? "claude-session.jsonl" : "codex-rollout.jsonl"));
    await writeFile(join(runtime, `seat-${seat.id}-goal-old-outcome-one.json`), JSON.stringify({ worktree, sessions: [{ sessionId: engine === "claude" ? "claude:" + oldId : oldId }] }));
    const before = await readFile(join(checkout, "state.json"), "utf8");
    const nonce = "00000000-0000-4000-8000-000000000001";
    const ownership = vi.spyOn(TmuxHost.prototype, "verifiedRecord");
    const current = async function (this: TmuxHost) { expect(this.hosted).toEqual({ kind: "seat", seatId: seat.id }); return { readyNonce: nonce } as HostRecord; };
    try {
      // These are actual seat-owned logs, so the former newest-harness fallback would find them.
      expect(await locator.recorded(seat.id, engine === "claude" ? "claude:" + oldId : oldId)).toMatchObject({ path: oldLog });
      ownership.mockResolvedValue(undefined);
      expect(await locator.locate(seat, "claude:" + CLAUDE_ID)).toBeUndefined();
      ownership.mockRejectedValue(new Error("Foreign host identity"));
      expect(await locator.locate(seat)).toBeUndefined();
      ownership.mockImplementation(current);
      expect(await locator.locate(seat)).toBeUndefined(); // Verified host, but no headed run.
      await writeFile(headedMarkerFile(checkout, nonce), JSON.stringify({ pid: 2147483647, engine, startedAt: at, log: oldLog }));
      expect(await locator.locate(seat)).toBeUndefined(); // A dead run is not current evidence.
      const currentId = "99999999-8888-4777-8666-555555555555";
      const currentLog = join(directory, engine === "claude" ? `${currentId}.jsonl` : `rollout-2026-09-29T09-00-00-${currentId}.jsonl`);
      await writeFile(currentLog, await fixture(engine === "claude" ? "claude-session.jsonl" : "codex-rollout.jsonl"));
      await utimes(currentLog, new Date(1_000), new Date(1_000)); // Current evidence wins even against a newer stale log.
      await writeFile(headedMarkerFile(checkout, nonce), JSON.stringify({ pid: process.pid, engine, startedAt: at, log: currentLog }));
      expect(await locator.locate(seat)).toEqual({ engine, sessionId: currentId, path: currentLog });
      const feed = new LocalTranscriptSource(locator, 0).feed(seat, () => undefined);
      expect(await feed.poll()).toMatchObject({ status: "ok", location: { path: currentLog }, reset: true });
      await rm(headedMarkerFile(checkout, nonce));
      expect(await feed.poll()).toEqual({ status: "none" });
      if (role !== "Product") {
        await writeFile(join(checkout, "state.json"), "unreadable fixture");
        expect(await locator.locate(seat)).toBeUndefined(); // Unknown team configuration cannot become legacy.
        await writeFile(join(checkout, "state.json"), before);
      }
      expect(await readFile(join(checkout, "state.json"), "utf8")).toBe(before);
      expect(await readFile(oldLog, "utf8")).toBe(await fixture(engine === "claude" ? "claude-session.jsonl" : "codex-rollout.jsonl"));
    } finally { ownership.mockRestore(); await rm(checkout, { recursive: true, force: true }); await rm(runtime, { recursive: true, force: true }); }
  });
});
