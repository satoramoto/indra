import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveUsageReader, LiveUsageTail, type LiveUsage, type LiveUsagePort } from "../src/live-usage.js";
import { headedMarkerFile } from "../src/headed-session.js";
import { TmuxHost, type HostedProcess } from "../src/tmux-host.js";
import { StateInventory, type StateSnapshot } from "../src/state-domain.js";
import { TerminalUiModel } from "../src/terminal-ui.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "indra-live-usage-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}.runtime`, { recursive: true, force: true }); });

const id = "0e5f9f3e-1111-4222-8333-944445555666";
const assistant = (message: string, input: number, output: number) => JSON.stringify({ type: "assistant", sessionId: id, message: { id: message, usage: { input_tokens: input, output_tokens: output } } }) + "\n";

describe("incremental live-token reader", () => {
  it("counts a Claude transcript as it grows, reading only the bytes added since the last read", async () => {
    const log = join(dir, `${id}.jsonl`);
    const first = assistant("msg_1", 100, 10);
    await writeFile(log, first);
    const tail = new LiveUsageTail(log, "claude");
    expect(await tail.read()).toEqual({ uncachedInputTokens: 100, outputTokens: 10 });
    expect(tail.sessionId).toBe(`claude:${id}`);
    // Overwrite what was already read with a same-length line of other numbers: a reader that re-read it would change.
    const replaced = assistant("msg_1", 900, 90);
    expect(replaced.length).toBe(first.length);
    const second = assistant("msg_2", 50, 5);
    // A partial last line waits for the next read.
    await writeFile(log, replaced + second.slice(0, 20));
    expect(await tail.read()).toEqual({ uncachedInputTokens: 100, outputTokens: 10 });
    await appendFile(log, second.slice(20));
    expect(await tail.read()).toEqual({ uncachedInputTokens: 150, outputTokens: 15 });
    // Nothing new: the same totals.
    expect(await tail.read()).toEqual({ uncachedInputTokens: 150, outputTokens: 15 });
  });

  it("takes a Codex rollout's newest session total, and starts over when the log is replaced", async () => {
    const log = join(dir, "rollout-2026-09-29T10-00-00-01a0edc4-5423-7bb1-a275-d78d1bc9c520.jsonl");
    const count = (input: number, output: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } } }) + "\n";
    await writeFile(log, JSON.stringify({ type: "session_meta", payload: { id: "01a0edc4-5423-7bb1-a275-d78d1bc9c520" } }) + "\n" + count(10, 1) + count(40, 4) + "not json\n");
    const tail = new LiveUsageTail(log, "codex");
    expect(await tail.read()).toEqual({ inputTokens: 40, outputTokens: 4 });
    expect(tail.sessionId).toBe("01a0edc4-5423-7bb1-a275-d78d1bc9c520");
    await writeFile(log, count(7, 1));
    expect(await tail.read()).toEqual({ inputTokens: 7, outputTokens: 1 });
  });
});

describe("live usage of a hosted process", () => {
  const nonce = "0123abcd-0000-4000-8000-000000000000";
  const seat: HostedProcess = { kind: "seat", seatId: "seat-002" };
  async function hostRecord() {
    const host = new TmuxHost(dir, undefined, dir, undefined, seat);
    await mkdir(host.runtimeDir, { recursive: true });
    await writeFile(host.recordFile, JSON.stringify({ socket: host.socket, session: host.session, paneId: "%7", readyNonce: nonce }));
  }

  it("follows the headed-run marker to its session log, at most once per interval", async () => {
    await hostRecord();
    const log = join(dir, `${id}.jsonl`);
    await writeFile(log, assistant("msg_1", 100, 10));
    let now = 0;
    const reader = new LiveUsageReader(dir, 5000, () => now, (pid) => pid === 4242);
    expect(await reader.read(seat)).toBeUndefined();
    now = 5000;
    await writeFile(headedMarkerFile(dir, nonce), JSON.stringify({ pid: 4242, engine: "claude", startedAt: "t", log }));
    expect(await reader.read(seat)).toEqual({ engine: "claude", sessionId: `claude:${id}`, usage: { uncachedInputTokens: 100, outputTokens: 10 } });
    await appendFile(log, assistant("msg_2", 50, 5));
    now = 9999;
    expect((await reader.read(seat))?.usage.uncachedInputTokens).toBe(100);
    now = 10_000;
    expect((await reader.read(seat))?.usage.uncachedInputTokens).toBe(150);
    // The bridge has no record here, and a marker whose process is gone is no headed run.
    expect(await reader.read({ kind: "bridge" })).toBeUndefined();
    await writeFile(headedMarkerFile(dir, nonce), JSON.stringify({ pid: 999, engine: "claude", startedAt: "t", log }));
    now = 20_000;
    expect(await reader.read(seat)).toBeUndefined();
    // Reading never writes: the log is unchanged.
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("live tokens in the hub", () => {
  const snapshot: StateSnapshot = { teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", mattermostTeamId: "t", seats: [
    { id: "seat-001", displayName: "Chick Corea", handle: "chick", mattermostUserId: "user-1", roles: ["Team Lead"] },
    { id: "seat-002", displayName: "George Duke", handle: "george", mattermostUserId: "user-2", roles: ["Developer"] },
  ] }] };

  it("adds a running session's totals to the recorded ones once, and redraws only when they change", async () => {
    const reads: HostedProcess[] = [];
    let live: LiveUsage | undefined = { engine: "codex", sessionId: "s-live", usage: { inputTokens: 40, outputTokens: 4 } };
    const port: LiveUsagePort = { read: async (hosted) => { reads.push(hosted); return hosted.kind === "seat" ? live : undefined; } };
    const model = new TerminalUiModel(new StateInventory({ read: async () => snapshot }), { readSessions: async () => ({ connection: "connected", sessions: [] }) });
    model.liveUsagePort = port;
    expect(await model.refresh()).toBe(true);
    expect(reads).toEqual([{ kind: "bridge" }, { kind: "seat", seatId: "seat-002" }]);
    expect(model.liveUsage).toEqual({ "seat-002": live });
    expect(model.withLiveUsage("seat-002", { inputTokens: 100, outputTokens: 10 }, ["s-1"])).toEqual({ inputTokens: 140, outputTokens: 14 });
    expect(model.withLiveUsage("seat-002", undefined, [])).toEqual({ inputTokens: 40, outputTokens: 4 });
    // Once the session is recorded, its live total is not counted again.
    expect(model.withLiveUsage("seat-002", { inputTokens: 100, outputTokens: 10 }, ["s-1", "s-live"])).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(model.withLiveUsage("seat-001", { inputTokens: 1 }, [])).toEqual({ inputTokens: 1 });
    const revision = model.revision;
    expect(await model.refresh()).toBe(false);
    expect(model.revision).toBe(revision);
    live = undefined;
    expect(await model.refresh()).toBe(true);
    expect(model.liveUsage).toEqual({});
  });
});
