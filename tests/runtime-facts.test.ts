import { describe, expect, it } from "vitest";
import { RuntimeEventStream, RuntimeFacts, normalizeUsage, usageDelta } from "../src/runtime-facts.js";

// Reduced provider-format fixtures: Codex 0.156.1 exec JSONL and Claude Code 2.1.283 stream-json.
// Codex emits thread lifetime usage (event_processor_with_jsonl_output.rs::usage_from_last_total).
// Claude result.usage is main-loop turn usage; modelUsage/cost are resumed lifetime totals.
// https://code.claude.com/docs/en/agent-sdk/cost-tracking
const codex = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"response is not evidence"}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"cache_write_input_tokens":0,"output_tokens":122,"reasoning_output_tokens":0}}',
];
const id = "12345678-1234-4321-8765-123456789abc";
const init = { type: "system", subtype: "init", session_id: id, cwd: "/private/workspace", tools: ["Read"] };
const step = { type: "assistant", parent_tool_use_id: null, session_id: id, message: {
  id: "msg_example", role: "assistant", content: [{ type: "text", text: "Not retained" }],
  usage: { input_tokens: 32, cache_creation_input_tokens: 8, cache_read_input_tokens: 12, output_tokens: 1 },
} };
const delta = (tokens: number) => ({ type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: tokens } } });
const start = { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_start", message: step.message } };
// Rollout-shaped entries as in tests/fixtures/transcripts/codex-rollout.jsonl.
const rolloutMeta = { timestamp: "2026-09-29T10:00:00.000Z", type: "session_meta", payload: { id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } };
const rolloutTotal = (total_token_usage: object) => ({ timestamp: "2026-09-29T10:00:10.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage } } });

describe("normalized provider counters", () => {
  it("keeps Codex cache/reasoning subsets separate and makes Claude input totals inclusive", () => {
    expect(normalizeUsage("codex", { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 30, reasoning_output_tokens: 20 })).toEqual({ inputTokens: 100, uncachedInputTokens: 60, cachedInputTokens: 40, cacheWriteInputTokens: 5, outputTokens: 30, reasoningOutputTokens: 20 });
    expect(normalizeUsage("claude", step.message.usage)).toEqual({ inputTokens: 52, uncachedInputTokens: 32, cachedInputTokens: 12, cacheWriteInputTokens: 8, outputTokens: 1 });
    expect(normalizeUsage("claude", { output_tokens: 30, output_tokens_details: { thinking_tokens: 20 } })).toEqual({ outputTokens: 30, reasoningOutputTokens: 20 });
  });

  it("does not convert absent, invalid, overflowing or unrelated counters to zero", () => {
    for (const value of [undefined, null, [], {}, { output_tokens: -1 }, { input_tokens: "12" }, { output_tokens: Infinity }, { input_tokens: 2.5 }, { output_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(normalizeUsage("codex", value)).toBeUndefined();
    }
    expect(normalizeUsage("claude", { input_tokens: 7, output_tokens: 0, extra: "private diagnostic" })).toEqual({ uncachedInputTokens: 7, outputTokens: 0 });
    expect(normalizeUsage("claude", { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 })).not.toHaveProperty("inputTokens");
  });

  it("derives Codex uncached input only when input and cached reads are both reported", () => {
    const facts = new RuntimeFacts("codex");
    facts.observeLog(rolloutMeta);
    facts.observeLog(rolloutTotal({ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0, total_tokens: 24885 }));
    expect(facts.finish("succeeded")).toMatchObject({ sessionId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", usage: { inputTokens: 24763, uncachedInputTokens: 315, cachedInputTokens: 24448 } });
    expect(normalizeUsage("codex", { input_tokens: 10 })).not.toHaveProperty("uncachedInputTokens");
    expect(normalizeUsage("codex", { cached_input_tokens: 4 })).not.toHaveProperty("uncachedInputTokens");
    expect(normalizeUsage("codex", { input_tokens: 3, cached_input_tokens: 4 })).toEqual({ inputTokens: 3, cachedInputTokens: 4 });
    const stale = new RuntimeFacts("codex");
    stale.observeLog(rolloutTotal({ input_tokens: 100, cached_input_tokens: 40 })); stale.observeLog(rolloutTotal({ input_tokens: 150 }));
    const record = stale.finish("succeeded");
    expect(record.cumulativeUsage).toEqual({ inputTokens: 150, cachedInputTokens: 40 });
    expect(record.cumulativeUsage?.uncachedInputTokens).toBeUndefined();
  });

  it("subtracts only known monotonic counters", () => {
    expect(usageDelta({ inputTokens: 140, outputTokens: 30, cachedInputTokens: 10 }, { inputTokens: 100, cachedInputTokens: 20 })).toEqual({ inputTokens: 40 });
    expect(usageDelta({ inputTokens: 140 }, undefined)).toBeUndefined();
    expect(usageDelta(undefined, { inputTokens: 140 })).toBeUndefined();
    expect(usageDelta({ inputTokens: 0 }, { inputTokens: 0 })).toEqual({ inputTokens: 0 });
  });
});

describe("invocation facts", () => {
  it("records only facts, deduplicating Codex cumulative reports even across chunk boundaries", () => {
    const facts = new RuntimeFacts("codex");
    const stream = new RuntimeEventStream((event) => facts.observe(event));
    const text = [...codex, codex.at(-1)].join("\n");
    for (let n = 0; n < text.length; n += 17) stream.push(text.slice(n, n + 17));
    stream.end();
    const record = facts.finish("succeeded");
    expect(record).toMatchObject({ engine: "codex", status: "succeeded", sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", usage: { inputTokens: 24763, outputTokens: 122 } });
    expect(record.cumulativeUsage).toEqual(record.usage);
    expect(Date.parse(record.finishedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt));
    expect(JSON.stringify(record)).not.toContain("response is not evidence");
    expect(stream.malformed).toBe(false);
  });

  it("preserves a resumed Codex total without attributing old tokens to the new invocation", () => {
    const first = new RuntimeFacts("codex"); codex.forEach((line) => first.observe(JSON.parse(line)));
    const previous = first.finish("succeeded");
    const resumed = new RuntimeFacts("codex", previous.sessionId, previous.cumulativeUsage);
    const update = { type: "turn.completed", usage: { input_tokens: 25000, output_tokens: 130 } };
    resumed.observe(update); resumed.observe(update);
    expect(resumed.finish("succeeded")).toMatchObject({ usage: { inputTokens: 237, outputTokens: 8 }, cumulativeUsage: { inputTokens: 25000, outputTokens: 130 } });
    expect(resumed.finish("succeeded").usage).not.toHaveProperty("cachedInputTokens");
    expect(resumed.finish("succeeded").usage).not.toHaveProperty("uncachedInputTokens");
    const withoutBaseline = new RuntimeFacts("codex", previous.sessionId);
    withoutBaseline.observe(update);
    expect(withoutBaseline.finish("succeeded")).toMatchObject({ cumulativeUsage: { inputTokens: 25000, outputTokens: 130 } });
    expect(withoutBaseline.finish("succeeded")).not.toHaveProperty("usage");
    expect(resumed.invocationId).not.toBe(first.invocationId);
  });

  it("carries derived Codex uncached input into a resumed invocation's delta", () => {
    const first = new RuntimeFacts("codex"); codex.forEach((line) => first.observe(JSON.parse(line)));
    const previous = first.finish("succeeded");
    expect(previous.cumulativeUsage?.uncachedInputTokens).toBe(315);
    const resumed = new RuntimeFacts("codex", previous.sessionId, previous.cumulativeUsage);
    resumed.observe({ type: "turn.completed", usage: { input_tokens: 25000, cached_input_tokens: 24600, output_tokens: 130 } });
    const record = resumed.finish("succeeded");
    expect(record.usage).toMatchObject({ inputTokens: 237, cachedInputTokens: 152, uncachedInputTokens: 85, outputTokens: 8 });
    expect(record.cumulativeUsage?.uncachedInputTokens).toBe(400);
  });

  it("does not invent a delta when the provider resets a resumed session counter", () => {
    const facts = new RuntimeFacts("codex", "thread-1", { inputTokens: 100 });
    facts.observe({ type: "turn.completed", usage: { input_tokens: 120 } });
    facts.observe({ type: "turn.completed", usage: { input_tokens: 10 } });
    expect(facts.finish("succeeded").cumulativeUsage).toEqual({ inputTokens: 10 });
    expect(facts.finish("succeeded").usage).toBeUndefined();
  });

  it("keeps incomplete output's earlier reports and never exposes malformed diagnostics", () => {
    const facts = new RuntimeFacts("codex");
    const stream = new RuntimeEventStream((event) => facts.observe(event));
    stream.push(`${codex.join("\n")}\n{"type":"turn.failed","private diagnostic`);
    stream.end(); stream.end();
    expect(stream.malformed).toBe(true);
    expect(facts.finish("failed").usage?.outputTokens).toBe(122);
    expect(JSON.stringify(facts.finish("failed"))).not.toContain("private diagnostic");
  });

  it("keeps all statuses and absent identity/counters explicit without fabricated zeroes", () => {
    for (const engine of ["codex", "claude"] as const) for (const status of ["succeeded", "failed", "interrupted", "timed-out"] as const) {
      const facts = new RuntimeFacts(engine).finish(status);
      expect(facts).toMatchObject({ engine, status, startedAt: expect.any(String), finishedAt: expect.any(String) });
      expect(facts).not.toHaveProperty("sessionId"); expect(facts).not.toHaveProperty("usage");
    }
  });

  it("counts Claude message IDs once, uses streaming output snapshots and avoids summing the final aggregate", () => {
    const facts = new RuntimeFacts("claude");
    [init, start, delta(4), delta(9), delta(9), step, step].forEach((event) => facts.observe(event));
    facts.observe({ type: "result", session_id: id, usage: { ...step.message.usage, output_tokens: 9 }, modelUsage: { model: { inputTokens: 1000000 } }, diagnostic: "Not retained" });
    expect(facts.finish("succeeded").usage).toEqual({ inputTokens: 52, uncachedInputTokens: 32, cachedInputTokens: 12, cacheWriteInputTokens: 8, outputTokens: 9 });
    expect(facts.finish("succeeded").sessionId).toBe(`claude:${id}`);
    expect(JSON.stringify(facts.finish("succeeded"))).not.toMatch(/Not retained|workspace|tools|modelUsage/);
  });

  it("adds distinct Claude requests even when counters match, while assistant output placeholders stay unknown", () => {
    const facts = new RuntimeFacts("claude");
    facts.observe(step); facts.observe(step);
    facts.observe({ ...step, message: { ...step.message, id: "msg_next" } });
    expect(facts.finish("interrupted").usage).toEqual({ inputTokens: 104, uncachedInputTokens: 64, cachedInputTokens: 24, cacheWriteInputTokens: 16 });
    expect(facts.finish("interrupted").sessionId).toBe(`claude:${id}`);
  });

  it("preserves partial usage when a Claude crash result is zeroed or omits counters", () => {
    const facts = new RuntimeFacts("claude");
    [init, start, delta(9), step].forEach((event) => facts.observe(event));
    facts.observe({ type: "result", subtype: "error_during_execution", is_error: true, session_id: id, usage: { input_tokens: 0, output_tokens: 0 }, errors: ["private diagnostic"] });
    expect(facts.finish("failed").usage).toEqual({ inputTokens: 52, uncachedInputTokens: 32, cachedInputTokens: 12, cacheWriteInputTokens: 8, outputTokens: 9 });
  });

  it.each(["message", "result", "message-and-result"])("recomputes Claude input totals after partial %s updates", (source) => {
    const facts = new RuntimeFacts("claude");
    const initial = { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
    if (source === "result") facts.observe({ type: "result", session_id: id, usage: initial });
    else facts.observe({ ...start, event: { type: "message_start", message: { ...step.message, usage: initial } } });
    const update = source === "message"
      ? { ...delta(9), event: { type: "message_delta", usage: { input_tokens: 120 } } }
      : { type: "result", session_id: id, usage: { input_tokens: 120 } };
    facts.observe(update); facts.observe(update);
    expect(facts.finish("failed").usage).toEqual({ inputTokens: 180, uncachedInputTokens: 120, cachedInputTokens: 50, cacheWriteInputTokens: 10 });
  });

  it("derives Claude totals only when all input components are known and their sum is safe", () => {
    const facts = new RuntimeFacts("claude");
    const report = (usage: object) => facts.observe({ type: "result", session_id: id, usage });
    report({ input_tokens: 100 }); report({ cache_read_input_tokens: 50 });
    expect(facts.finish("failed").usage).toEqual({ uncachedInputTokens: 100, cachedInputTokens: 50 });
    report({ cache_creation_input_tokens: 10 });
    expect(facts.finish("failed").usage?.inputTokens).toBe(160);
    report({ input_tokens: Number.MAX_SAFE_INTEGER });
    expect(facts.finish("failed").usage).toEqual({ uncachedInputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 50, cacheWriteInputTokens: 10 });
  });

  it("uses only the current Claude turn on resume, ignoring lifetime model totals, replayed users and subagents", () => {
    const facts = new RuntimeFacts("claude", `claude:${id}`);
    facts.observe({ type: "user", message: step.message });
    facts.observe({ ...step, parent_tool_use_id: "toolu_child" });
    facts.observe({ type: "result", session_id: id, usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { model: { inputTokens: 1000, outputTokens: 500 } } });
    expect(facts.finish("succeeded").usage).toEqual({ uncachedInputTokens: 10, outputTokens: 3 });
  });
});

it.each(["sidechain", "delegation"])("does not claim complete Claude usage after unaccounted %s work", (kind) => {
  const facts = new RuntimeFacts("claude");
  if (kind === "sidechain") facts.observeLog({ type: "assistant", isSidechain: true, message: { id: "child", usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 } } });
  else facts.observeLog({ type: "assistant", message: { id: "delegate", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent" }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 } } });
  facts.observeLog({ type: "assistant", message: { id: "final", stop_reason: "end_turn", usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 } } });
  facts.observeLog({ type: "system", subtype: "turn_duration" });
  expect(facts.finish("succeeded").usageComplete).not.toBe(true);
});
