import { describe, expect, it } from "vitest";
import { codexProgress, describeCodexEvent, formatProgressLine, LineSplitter, MAX_PROGRESS_LINE } from "../src/codex-progress.js";

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
  "12:34:56 [build] session started",
  "12:34:56 [build] turn started",
  "12:34:56 [build] agent: Todo: create the file, run both shell commands, then mark the tasks complete.",
  "12:34:56 [build] $ ls .codex-probe",
  "12:34:56 [build] $ ls .codex-probe -> exit 0",
  "12:34:56 [build] $ false -> exit 1",
  "12:34:56 [build] thinking: Preparing file creation",
  "12:34:56 [build] files: add .codex-probe/b.txt",
  "12:34:56 [build] agent: Todo complete: created the file.",
  "12:34:56 [build] turn finished (usage: in 40172, cached 26752, out 377, reasoning 42)",
];

const now = () => new Date("2026-09-28T12:34:56.000Z");

function run(chunks: string[], purpose?: string): string[] {
  const lines: string[] = [];
  const progress = codexProgress({ purpose, cwd: "/work/repo", write: (line) => lines.push(line), now });
  for (const chunk of chunks) progress.push(chunk);
  progress.end();
  return lines;
}

describe("codex progress", () => {
  it("prints one readable line per meaningful recorded event", () => {
    expect(run([RECORDED.map((line) => `${line}\n`).join("")], "build")).toEqual(EXPECTED);
  });

  it("gives the same lines when JSONL is split at every character, including a final line with no newline", () => {
    const stream = RECORDED.join("\n");
    expect(run([...stream], "build")).toEqual(EXPECTED);
    const cut = Math.floor(stream.length / 2);
    expect(run([stream.slice(0, cut), stream.slice(cut)], "build")).toEqual(EXPECTED);
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

  it("describes todo lists, tool calls, web searches and failures", () => {
    expect(describeCodexEvent({ type: "item.updated", item: { type: "todo_list", items: [{ text: "Write tests", completed: true }, { text: "Open the PR", completed: false }] } })).toBe("todo 1/2, next: Open the PR");
    expect(describeCodexEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "github", tool: "get_pr", status: "in_progress" } })).toBe("tool: github.get_pr");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "github", tool: "get_pr", status: "failed", error: { message: "nope" } } })).toBe("tool: github.get_pr failed");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "web_search", query: "vitest docs" } })).toBe("search: vitest docs");
    expect(describeCodexEvent({ type: "turn.failed", error: { message: "stream disconnected\nretrying" } })).toBe("turn failed: stream disconnected");
    expect(describeCodexEvent({ type: "error", message: "Reconnecting... 1/5" })).toBe("error: Reconnecting... 1/5");
    expect(describeCodexEvent({ type: "turn.completed" })).toBe("turn finished");
    expect(describeCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "" } })).toBeUndefined();
  });

  it("redacts secrets and caps every line", () => {
    const token = `ghp_${"a1".repeat(20)}`;
    const [line] = run([`{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc 'GH_TOKEN=${token} gh pr view'","exit_code":0}}\n`]);
    expect(line).not.toContain(token);
    expect(line).toContain("[redacted]");
    const long = formatProgressLine(`agent: ${"word ".repeat(200)}`, now(), "review");
    expect(long.length).toBe(MAX_PROGRESS_LINE);
    expect(long.startsWith("12:34:56 [review] agent: word")).toBe(true);
    // A secret straddling the cap is redacted before the line is cut.
    const straddling = formatProgressLine(`${"x ".repeat(90)}${token}`, now());
    expect(straddling).not.toContain("ghp_a1a1");
  });

  it("keeps printing after a write fails", () => {
    let calls = 0;
    const progress = codexProgress({ now, write: () => { calls++; throw new Error("EPIPE"); } });
    progress.push(`{"type":"turn.started"}\n{"type":"turn.started"}\n`);
    expect(calls).toBe(2);
  });
});
