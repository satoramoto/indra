import { describe, expect, it } from "vitest";
import { codexProgress, describeCodexEvent, formatProgressLine, LineSplitter, MAX_PROGRESS_LINE, shellCommand, type ProgressTimers } from "../src/codex-progress.js";

// Recorded from `codex exec --json` (codex-cli 0.156.1); the worktree path is replaced with /work/repo.
const RECORDED = [
  `{"type":"thread.started","thread_id":"01a0ea4b-f529-7da1-8f81-acb6d0a87505"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Todo: create the file, run both shell commands, then mark the tasks complete."}}`,
  `{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc 'ls .codex-probe'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc 'ls .codex-probe'","aggregated_output":"hello.txt\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"/bin/zsh -lc false","aggregated_output":"","exit_code":1,"status":"failed"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"**Preparing file creation**\\n**Preparing b.txt creation**"}}`,
  `{"type":"item.started","item":{"id":"item_5","type":"file_change","changes":[{"path":"/work/repo/.codex-probe/b.txt","kind":"add"}],"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_5","type":"file_change","changes":[{"path":"/work/repo/.codex-probe/b.txt","kind":"add"}],"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_6","type":"agent_message","text":"Todo complete: created the file.\\nSecond line is dropped."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":40172,"cached_input_tokens":26752,"cache_write_input_tokens":0,"output_tokens":377,"reasoning_output_tokens":42}}`,
];

const EXPECTED = [
  "12:34 # build",
  "12:34 · session started",
  "12:34 · turn started",
  "12:34 › Todo: create the file, run both shell commands, then mark the tasks complete.",
  "12:34 $ ✓ ls .codex-probe",
  "12:34 $ ✗1 false",
  "12:34 ~ Preparing file creation",
  "12:34 ± add .codex-probe/b.txt",
  "12:34 › Todo complete: created the file.",
  "12:34 · turn done (in 40172, cached 26752, out 377, reasoning 42)",
];

// Local time, so the printed HH:MM doesn't depend on the machine's time zone.
const now = () => new Date(2026, 8, 28, 12, 34, 56);

class FakeTimers implements ProgressTimers {
  pending = new Map<number, () => void>();
  private next = 0;
  setTimeout(run: () => void): unknown { const id = ++this.next; this.pending.set(id, run); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  fire(): void { const runs = [...this.pending.values()]; this.pending.clear(); for (const run of runs) run(); }
}

function run(chunks: string[], purpose?: string, timers = new FakeTimers()): string[] {
  const lines: string[] = [];
  const progress = codexProgress({ purpose, cwd: "/work/repo", write: (line) => lines.push(line), now, timers });
  for (const chunk of chunks) progress.push(chunk);
  progress.end();
  return lines;
}

const command = (id: string, phase: "started" | "completed", cmd: string, exit: number | null = null) =>
  JSON.stringify({ type: `item.${phase}`, item: { id, type: "command_execution", command: cmd, exit_code: exit, status: phase === "started" ? "in_progress" : exit === 0 ? "completed" : "failed" } }) + "\n";

describe("codex progress", () => {
  it("prints the purpose once, then one marked line per meaningful recorded event", () => {
    expect(run([RECORDED.map((line) => `${line}\n`).join("")], "build")).toEqual(EXPECTED);
  });

  it("gives the same lines when JSONL is split at every character, including a final line with no newline", () => {
    const stream = RECORDED.join("\n");
    expect(run([...stream], "build")).toEqual(EXPECTED);
    const cut = Math.floor(stream.length / 2);
    expect(run([stream.slice(0, cut), stream.slice(cut)], "build")).toEqual(EXPECTED);
  });

  it("prints no purpose line without a purpose", () => {
    expect(run([`{"type":"turn.started"}\n`])).toEqual(["12:34 · turn started"]);
  });

  it("splits lines only on newlines and keeps a partial line until it completes", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(`{"a":`)).toEqual([]);
    expect(splitter.push(`1}\r\n{"b"`)).toEqual([`{"a":1}`]);
    expect(splitter.push(`:2}`)).toEqual([]);
    expect(splitter.flush()).toEqual([`{"b":2}`]);
    expect(splitter.flush()).toEqual([]);
  });

  it("quietly ignores unknown, malformed and non-object events and never prints raw JSON", () => {
    const lines = run([
      `not json\n{"type":"item.completed","item":{"type":"agent_mess\n`,
      `{"type":"something.new","secret":"x"}\n[1,2]\nnull\n"text"\n`,
      `{"type":"item.completed","item":{"type":"future_item","text":"hi"}}\n{"type":"item.completed","item":null}\n`,
      `{"type":"item.completed","item":{"type":"file_change","changes":"oops"}}\n{"type":"item.completed","item":{"type":"todo_list","items":{}}}\n`,
    ]);
    expect(lines).toEqual([]);
  });

  it("marks todo lists, tool calls, web searches and failures", () => {
    expect(describeCodexEvent({ type: "item.updated", item: { type: "todo_list", items: [{ text: "Write tests", completed: true }, { text: "Open the PR", completed: false }] } })).toBe("· todo 1/2, next: Open the PR");
    expect(describeCodexEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "github", tool: "get_pr", status: "in_progress" } })).toBeUndefined();
    expect(describeCodexEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "github", tool: "get_pr", status: "completed" } })).toBe("» ✓ github.get_pr");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "github", tool: "get_pr", status: "failed", error: { message: "nope" } } })).toBe("» ✗ github.get_pr");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "web_search", query: "vitest docs" } })).toBe("» search vitest docs");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "file_change", status: "failed", changes: [{ kind: "update", path: "a.ts" }] } })).toBe("± ✗ update a.ts");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: null, status: "declined" } })).toBe("$ ✗ npm test");
    expect(describeCodexEvent({ type: "turn.failed", error: { message: "stream disconnected\nretrying" } })).toBe("! turn failed: stream disconnected");
    expect(describeCodexEvent({ type: "error", message: "Reconnecting... 1/5" })).toBe("! Reconnecting... 1/5");
    expect(describeCodexEvent({ type: "turn.completed" })).toBe("· turn done");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "" } })).toBeUndefined();
  });

  it("strips the shell wrapper and its quoting", () => {
    expect(shellCommand(`/bin/zsh -lc "sed -n '1,160p' tests/state-check.test.ts"`)).toBe("sed -n '1,160p' tests/state-check.test.ts");
    expect(shellCommand(`/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(shellCommand(`/bin/zsh -lc "echo \\"a\\" \\$HOME"`)).toBe(`echo "a" $HOME`);
    expect(shellCommand(`bash -lc git status`)).toBe("git status");
    expect(shellCommand(["/bin/zsh", "-lc", "git log --oneline"])).toBe("git log --oneline");
    expect(shellCommand(["rg", "foo"])).toBe("rg foo");
    expect(shellCommand("npm test\nsecond line")).toBe("npm test");
  });

  it("prints a command once, on completion, with its status before the command so a narrow cut keeps it", () => {
    const timers = new FakeTimers();
    const lines = run([command("c1", "started", "/bin/zsh -lc 'git log --oneline'"), command("c1", "completed", "/bin/zsh -lc 'git log --oneline'", 128)], undefined, timers);
    expect(lines).toEqual(["12:34 $ ✗128 git log --oneline"]);
    expect(timers.pending.size).toBe(0);
  });

  it("adds a start line only for a command still running after the slow-command delay", () => {
    const timers = new FakeTimers();
    const lines: string[] = [];
    const progress = codexProgress({ purpose: "build", write: (line) => lines.push(line), now, timers });
    progress.push(command("c1", "started", "/bin/zsh -lc 'npm test'"));
    progress.push(command("c2", "started", "/bin/zsh -lc 'ls'"));
    progress.push(command("c2", "completed", "/bin/zsh -lc 'ls'", 0));
    expect(timers.pending.size).toBe(1);
    timers.fire();
    progress.push(command("c1", "completed", "/bin/zsh -lc 'npm test'", 0));
    progress.push(command("c3", "started", "/bin/zsh -lc 'sleep 60'"));
    progress.end();
    expect(timers.pending.size).toBe(0);
    expect(lines).toEqual(["12:34 # build", "12:34 $ ✓ ls", "12:34 $ … npm test", "12:34 $ ✓ npm test"]);
  });

  it("redacts the delayed start line of a slow command", () => {
    const timers = new FakeTimers();
    const lines: string[] = [];
    const token = `ghp_${"a1".repeat(20)}`;
    const progress = codexProgress({ write: (line) => lines.push(line), now, timers });
    progress.push(command("c1", "started", `/bin/zsh -lc 'curl -H "Authorization: Bearer ${token}" https://api.github.com'`));
    expect(lines).toEqual([]);
    timers.fire();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("12:34 $ … curl")).toBe(true);
    expect(lines[0]).toContain("[redacted]");
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).not.toContain("ghp_");
    progress.end();
  });

  it("redacts secrets and caps every line", () => {
    const token = `ghp_${"a1".repeat(20)}`;
    const [line] = run([`{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc 'GH_TOKEN=${token} gh pr view'","exit_code":0}}\n`]);
    expect(line).not.toContain(token);
    expect(line).toContain("[redacted]");
    const long = formatProgressLine(`› ${"word ".repeat(200)}`, now());
    expect(long.length).toBe(MAX_PROGRESS_LINE);
    expect(long.startsWith("12:34 › word")).toBe(true);
  });

  it("redacts before capping: a secret straddling the cap whose visible prefix alone would not be redacted", () => {
    // Only the "long mixed run" rule matches this secret; its first 11 characters alone match nothing.
    const secret = "Zq8w3Rt5Yp1Lm9Nb7Vc4Xk2Hj6Gf0Ds8Ae";
    const prefix = secret.slice(0, 11);
    expect(formatProgressLine(prefix, now())).toContain(prefix);
    // "12:34 " plus 180 characters puts the secret at column 186; the cap cuts at 197, 11 characters into it.
    const straddling = formatProgressLine(`${"x ".repeat(90)}${secret} and more text after it`, now());
    expect(straddling.indexOf("[redacted]")).toBe(186);
    expect(straddling).not.toContain(secret.slice(0, 4));
    expect(straddling.length).toBe(MAX_PROGRESS_LINE);
  });

  it("keeps printing after a write fails", () => {
    let calls = 0;
    const progress = codexProgress({ now, write: () => { calls++; throw new Error("EPIPE"); } });
    progress.push(`{"type":"turn.started"}\n{"type":"turn.started"}\n`);
    expect(calls).toBe(2);
  });

  it("guards process.stdout against an async EPIPE once when writing to it", () => {
    const before = process.stdout.listenerCount("error");
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      codexProgress({ now }).push(`{"type":"turn.started"}\n`);
      codexProgress({ now }).end();
    } finally { process.stdout.write = write; }
    expect(process.stdout.listenerCount("error")).toBe(before + 1);
    expect(() => process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });
});
