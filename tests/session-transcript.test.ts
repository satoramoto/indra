import { describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, ENTRY_LIMIT, LocalTranscriptSource, parseSessionHandle, parseTranscript, safeText, TranscriptLocator, TranscriptTail } from "../src/session-transcript.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "transcripts", name), "utf8");
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

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
