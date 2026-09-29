import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningStore } from "../src/planning.js";
import { ReleaseRecorder, readReleaseFacts, releaseRounds, type ReleaseFact, type ReleaseFacts } from "../src/release-facts.js";

const dirs: string[] = [];
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, seconds)).toISOString();
const prUrl = "https://github.com/test/project/pull/1";
const headSha = "a".repeat(40);
const begin = (): ReleaseFact => ({ kind: "tracking-started", key: "tracking", at: at(0), prUrl });
const observe = (seconds: number, conflicting: boolean | null, head = headSha): ReleaseFact => ({ kind: "observation", key: `observation-${seconds}`, at: at(seconds), prUrl, headSha: head, state: "OPEN", conflicting });
const start = (seconds: number, attemptId = "attempt-one"): ReleaseFact => ({ kind: "merge-started", key: `${attemptId}:start`, at: at(seconds), prUrl, headSha, attemptId });
const finish = (seconds: number, result: "failed" | "merged" | "unknown", attemptId = "attempt-one"): ReleaseFact => ({ kind: "merge-finished", key: `${attemptId}:finish`, at: at(seconds), prUrl, headSha, attemptId, result });
const history = (...events: ReleaseFact[]): ReleaseFacts => ({ version: 1, goalId: "goal-one", events });
const rounds = (facts: ReleaseFacts | undefined, seconds = 100) => releaseRounds(facts, "goal-one", prUrl, at(seconds));
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "indra-release-facts-")); dirs.push(dir);
  const store = new PlanningStore(join(dir, "state"));
  return { store, recorder: new ReleaseRecorder(store, "goal-one") };
}

describe("recorded integration rounds", () => {
  it("counts observed conflict episodes across resolutions, never polling, unknown checks or changed heads", () => {
    const facts = history(begin(), observe(1, false), observe(2, true), observe(3, true), observe(4, null),
      observe(5, true, "b".repeat(40)), observe(6, false), observe(7, false), observe(8, true));
    expect(rounds(facts)).toEqual({ conflict: 2, merge: 0, missing: [] });
    expect(rounds(facts, 5).conflict).toBe(1);
    expect(rounds(facts, 1).conflict).toBe(0);
  });

  it("counts failed and successful commands by attempt identity, excluding observations and copied events", () => {
    const facts = history(begin(), observe(1, false), start(2), start(2), finish(3, "failed"), finish(3, "failed"),
      observe(4, false), start(5, "attempt-two"), finish(6, "merged", "attempt-two"));
    expect(rounds(facts)).toEqual({ conflict: 0, merge: 2, missing: [] });
  });

  it("preserves a merge attempt's identity after restart and replays its finish once", async () => {
    const { store, recorder } = await fixture();
    for (const event of [begin(), observe(1, false), start(2)]) await recorder.record(event);
    const restart = new ReleaseRecorder(store, "goal-one");
    expect(rounds(await restart.read()).merge).toBeNull();
    await restart.record({ ...start(2), at: at(3) });
    await restart.record(finish(4, "merged"));
    await restart.record({ ...finish(4, "merged"), at: at(5) });
    const facts = await readReleaseFacts(store, "goal-one");
    expect(facts!.events.filter((event) => event.kind === "merge-started")).toEqual([start(2)]);
    expect(rounds(facts)).toEqual({ conflict: 0, merge: 1, missing: [] });
    expect(rounds(facts, 3)).toMatchObject({ conflict: 0, merge: null });
  });

  it("does not turn interrupted or unmatched attempts into a complete total", () => {
    for (const attempts of [[start(2)], [finish(3, "merged")], [start(2), finish(3, "unknown")],
      [start(2), { ...finish(3, "merged"), headSha: "b".repeat(40) }],
      [start(2), { ...start(3), key: "another-command" }, finish(4, "merged")]]) {
      expect(rounds(history(begin(), observe(1, false), ...attempts))).toEqual({ conflict: 0, merge: null,
        missing: ["Integration PR merge attempts are incomplete; merge rounds are unknown."] });
    }
  });

  it("excludes later attempts and resolutions at the cutoff, without completing a pending attempt early", () => {
    const facts = history(begin(), observe(1, true), start(2), finish(3, "failed"), observe(4, false), observe(5, true),
      start(6, "attempt-two"), finish(7, "merged", "attempt-two"));
    expect(rounds(facts, 1)).toEqual({ conflict: 1, merge: 0, missing: [] });
    expect(rounds(facts, 2).merge).toBeNull();
    expect(rounds(facts, 3)).toEqual({ conflict: 1, merge: 1, missing: [] });
    expect(rounds(facts, 5)).toEqual({ conflict: 2, merge: 1, missing: [] });
    expect(rounds(facts, 6).merge).toBeNull();
    expect(rounds(facts, 7)).toEqual({ conflict: 2, merge: 2, missing: [] });
  });

  it("distinguishes explicit zero from absent, legacy, post-cutoff and unknown observation history", async () => {
    const { store, recorder } = await fixture();
    expect(await recorder.read()).toBeUndefined();
    for (const facts of [undefined, history(), history(observe(1, false)), history({ ...begin(), at: at(101) })]) {
      expect(rounds(facts)).toMatchObject({ conflict: null, merge: null });
    }
    expect(rounds(history(begin(), observe(1, null)))).toMatchObject({ conflict: null, merge: 0 });
    for (const event of [begin(), observe(1, false)]) await recorder.record(event);
    expect(rounds(await readReleaseFacts(store, "goal-one"))).toEqual({ conflict: 0, merge: 0, missing: [] });
  });

  it("leaves corrupt, crossed and contradictory history unknown", async () => {
    const { store, recorder } = await fixture();
    for (const event of [begin(), observe(1, false)]) await recorder.record(event);
    for (const facts of [history(begin(), observe(2, false), observe(1, true)),
      history(begin(), observe(1, false), { ...observe(1, true) }),
      history(begin(), { ...observe(1, false), prUrl: "https://github.com/test/project/pull/2" }),
      { ...history(begin(), observe(1, false)), goalId: "goal-other" }]) {
      expect(rounds(facts)).toMatchObject({ conflict: null, merge: null });
    }
    await writeFile(join(store.runtimeDir, `${recorder.name}.json`), "{");
    expect(await readReleaseFacts(store, "goal-one")).toBeUndefined();
    await expect(recorder.record(start(2))).rejects.toThrow();
    expect(await readFile(join(store.runtimeDir, `${recorder.name}.json`), "utf8")).toBe("{");
  });

  it("writes only whitelisted evidence under runtime with private permissions and serializes concurrent delivery", async () => {
    const { store, recorder } = await fixture();
    await recorder.record(Object.assign(begin(), { diagnostic: "untrusted diagnostic", arbitrary: { nested: "discard me" } }));
    await Promise.all([recorder.record(observe(1, false)), recorder.record(observe(1, false))]);
    await expect(recorder.record(observe(1, true))).rejects.toThrow("Conflicting release event replay");
    const file = join(store.runtimeDir, `${recorder.name}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).facts.releaseFacts).toEqual(history(begin(), observe(1, false)));
    await expect(stat(store.checkout)).rejects.toThrow();
  });
});
