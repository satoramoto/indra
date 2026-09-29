import { describe, expect, it } from "vitest";
import { claudeProgress } from "../src/claude-progress.js";

// Recorded from `claude --print --output-format stream-json --verbose --include-partial-messages` (Claude Code 2.1.283),
// trimmed to the fields the formatter reads; the worktree path is replaced with /work/repo.
const RECORDED = [
  `{"type":"system","subtype":"init","cwd":"/work/repo","session_id":"1184e1eb-5f91-402e-b44d-24690ed25cd0","tools":["Bash","Read"]}`,
  `{"type":"system","subtype":"status","status":"requesting","session_id":"1184e1eb-5f91-402e-b44d-24690ed25cd0"}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Do"}}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"**Reading the manifest**\\nthen more","signature":"Es4F"}]}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01R6","name":"Read","input":{"file_path":"/work/repo/package.json"}}]}}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01R6","type":"tool_result","content":"1\\t{"}]}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"npm test\\n","description":"Run tests"}}]}}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_02","type":"tool_result","content":"Exit code 1","is_error":true}]}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_03","name":"Edit","input":{"file_path":"/work/repo/src/a.ts","old_string":"a","new_string":"b"}}]}}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_03","type":"tool_result","content":"ok"}]}}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done.\\nSecond line dropped."}]}}`,
  `{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"Done.","usage":{"input_tokens":17,"cache_creation_input_tokens":14375,"cache_read_input_tokens":57939,"output_tokens":272}}`,
];

const EXPECTED = [
  "12:34 · session started",
  "12:34 ~ Reading the manifest",
  "12:34 » ✓ Read package.json",
  "12:34 $ ✗ npm test",
  "12:34 ± edit src/a.ts",
  "12:34 › Done.",
  "12:34 · run done (4 turns, in 17, cached 57939, cache write 14375, out 272)",
];

function run(chunks: string[]) {
  const lines: string[] = [];
  const progress = claudeProgress({ cwd: "/work/repo", write: (text) => lines.push(text), now: () => new Date(2026, 0, 1, 12, 34) });
  for (const chunk of chunks) progress.push(chunk);
  progress.end();
  return lines;
}

describe("claudeProgress", () => {
  it("prints recorded events as marked lines", () => {
    expect(run([RECORDED.join("\n") + "\n"])).toEqual(EXPECTED);
  });

  it("handles JSONL split across chunks", () => {
    const text = RECORDED.join("\n");
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));
    expect(run(chunks)).toEqual(EXPECTED);
  });

  it("ignores unknown and malformed events quietly", () => {
    expect(run(["not json\n", `{"type":"mystery"}\n`, `[1]\n`, `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"nope"}]}}\n`])).toEqual([]);
  });

  it("reports errors and failed results", () => {
    expect(run([
      `{"type":"assistant","error":"rate_limit","message":{"content":[]}}\n`,
      `{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":9}\n`,
    ])).toEqual(["12:34 ! rate_limit", "12:34 ! run failed: error_max_turns (9 turns)"]);
  });

  it("redacts secrets before truncating", () => {
    const secret = "ghp_" + "a".repeat(36);
    const [printed] = run([`{"type":"assistant","message":{"content":[{"type":"text","text":"${"x".repeat(150)} ${secret}"}]}}\n`]);
    expect(printed).not.toContain("ghp_");
    expect(printed.length).toBeLessThanOrEqual(200);
  });
});
