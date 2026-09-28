import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlanningStore, type PlanningAssignment, type PlanningGoal, type RuntimeRecord, type SprintIntegration } from "../src/planning.js";
import { engineLabel, LocalSessionReader, LocalSprintBuildReader, projectSprint, sessionEngine } from "../src/session-snapshot.js";

const time = "2026-09-28T12:00:00Z";
function goal(statuses: PlanningAssignment["status"][] = []): PlanningGoal {
  return {
    id: "goal-loop", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Make the sprint loop visible", projectRefs: [],
    stage: "approved", createdAt: time, updatedAt: time, mattermost: { channelId: "home", rootPostId: "root" },
    brief: { summary: "A visible loop", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-1", createdAt: time, summary: "One ticket per seat", risks: [], openQuestions: [], outcomes: statuses.map((_, index) => ({
      id: `outcome-${index}`, title: `Ticket ${index}`, description: "An outcome", seatId: `seat-${index + 2}`,
    })) },
    assignments: statuses.map((status, index) => ({ outcomeId: `outcome-${index}`, seatId: `seat-${index + 2}`, status, updatedAt: time, prUrl: `https://github.com/example/indra/pull/${index + 1}` })),
    integration: { branch: "sprint/goal-loop", baseSha: "a".repeat(40), status: "collecting" },
  };
}

describe("sprint projection", () => {
  it.each([
    ["clarifying", "Clarify"], ["drafting", "Propose"], ["awaiting-review", "Approve"],
  ] as const)("shows %s as %s without promoting planning into work", (stage, expected) => {
    const planning = { ...goal(), stage, integration: undefined, assignments: undefined };
    expect(projectSprint(planning).stage).toBe(expected);
    expect(planning.stage).toBe(stage);
    expect(planning.assignments).toBeUndefined();
  });

  it.each<[PlanningAssignment["status"][], string]>([
    [[], "Build"], [["queued"], "Build"], [["running"], "Build"], [["queued", "in-review"], "Build"],
    [["running", "in-review", "merged"], "Build"], [["in-review", "merged"], "Review"], [["in-review"], "Review"],
    [["merged", "merged"], "Integrate"], [["merged", "failed"], "Integrate"], [["failed"], "Build"],
    [["failed", "in-review", "merged"], "Build"], [["queued", "merged", "failed"], "Build"],
  ])("derives the stage of %j as %s", (statuses, expected) => {
    expect(projectSprint(goal(statuses)).stage).toBe(expected);
  });

  it("retains every outcome, seat, PR and status without changing saved state", () => {
    const saved = goal(["queued", "running", "in-review", "merged", "failed"]);
    const before = structuredClone(saved);
    expect(projectSprint(saved).tickets).toEqual(saved.proposal!.outcomes.map((outcome, index) => ({
      id: outcome.id, title: outcome.title, seatId: outcome.seatId,
      status: ["queued", "building", "in review", "merged", "failed"][index], prUrl: saved.assignments![index].prUrl,
    })));
    expect(saved).toEqual(before);
    saved.assignments = saved.assignments!.slice(1);
    expect(projectSprint(saved).tickets[0]).toMatchObject({ title: "Ticket 0", status: "not assigned" });
    expect(projectSprint(saved).stage).toBe("Build");
  });

  it("prioritizes partial integration while keeping unfinished and failed tickets visible", () => {
    const partial = goal(["merged", "queued", "failed"]);
    partial.integration = { ...partial.integration!, status: "pr-open", prUrl: "https://github.com/example/indra/pull/20" };
    expect(projectSprint(partial)).toMatchObject({ stage: "Merge", integration: { prUrl: partial.integration.prUrl }, tickets: [{ status: "merged" }, { status: "queued" }, { status: "failed" }] });
    partial.integration.status = "merged";
    expect(projectSprint(partial, { status: "running" }).stage).toBe("Updated");
    expect(projectSprint(partial).build?.status).toBe("unavailable");
  });

  it.each(["reload-pending", "update-pending", "unavailable"] as const)("keeps %s at Merge until the running build includes the integration", (status) => {
    const saved = goal(["merged"]);
    saved.integration!.status = "merged";
    expect(projectSprint(saved, { status })).toMatchObject({ stage: "Merge", build: { status } });
  });

  it("does not claim Updated for a reverted sprint even with positive ancestry evidence", () => {
    const saved = goal(["merged"]);
    saved.integration = { ...saved.integration!, status: "merged", revertPrUrl: "https://github.com/example/indra/pull/21" };
    expect(projectSprint(saved, { status: "running" })).toMatchObject({ stage: "Merge", build: { status: "revert-open" } });
    saved.integration.status = "reverted";
    expect(projectSprint(saved, { status: "running" })).toMatchObject({ stage: "Merge", build: { status: "reverted" } });
  });
});

describe("read-only session snapshots", () => {
  const runtime: RuntimeRecord = { lastSeenAt: 0, processedPostIds: [], runs: [{ startedAt: time, finishedAt: time }] };
  const host = () => ({ verifiedRecord: vi.fn(async () => undefined), isReady: vi.fn(async () => false), attachTarget: vi.fn(() => "unused"), start: vi.fn() });

  it.each([
    [undefined, "codex", "Codex"], ["legacy-session", "codex", "Codex"], ["claude:session-1", "claude", "Claude Code"],
    ["future:session-1", "unknown", "Unknown engine"], ["codex:session-1", "unknown", "Unknown engine"], ["claude:", "unknown", "Unknown engine"],
  ] as const)("labels the persisted handle %s", async (handle, engine, label) => {
    const saved = goal(["running"]);
    const reader = new LocalSessionReader("unused", { read: async () => ({ $schema: "", schemaVersion: 1, teams: [], sprints: [], planningGoals: [saved] }), runtime: async () => ({ ...runtime, sessionId: handle }) }, host());
    const session = (await reader.readSessions()).sessions[0];
    expect(sessionEngine(handle)).toBe(engine);
    expect(engineLabel(session.engine)).toBe(label);
    expect(session.sessionId).toBe(handle);
    expect(session.recentActivity).toEqual([`${label} run finished ${time}`]);
  });

  it("keeps multiple sprints and integration links when runtime metadata is unreadable", async () => {
    const first = goal(["merged", "failed"]);
    first.integration = { ...first.integration!, status: "pr-open", prUrl: "https://github.com/example/indra/pull/22" };
    const second = { ...goal(["in-review"]), id: "goal-second" };
    const update = vi.fn(); const saveRuntime = vi.fn(); const bridge = host();
    const store = { read: async () => ({ $schema: "", schemaVersion: 1, teams: [], sprints: [], planningGoals: [first, second] }),
      runtime: async (id: string) => { if (id === first.id) throw new Error("bad JSON"); return runtime; }, update, saveRuntime };
    const result = await new LocalSessionReader("unused", store, bridge).readSessions();
    expect(result.connection).toBe("disconnected");
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({ status: "error", engine: "unknown", sprint: "pr-open", loop: { stage: "Merge", integration: { prUrl: first.integration.prUrl }, tickets: [{ status: "merged" }, { status: "failed" }] } });
    expect(result.sessions[1].loop?.stage).toBe("Review");
    expect(bridge.start).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(saveRuntime).not.toHaveBeenCalled();
  });

  it("reads missing runtime files without creating them or losing planning context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "indra-session-read-"));
    try {
      const store = new PlanningStore(directory, join(directory, "runtime"));
      const reader = new LocalSessionReader(directory, { read: async () => ({ $schema: "", schemaVersion: 1, teams: [], sprints: [], planningGoals: [goal(["queued", "failed"])] }), runtime: store.runtime.bind(store) }, host());
      const session = (await reader.readSessions()).sessions[0];
      expect(session.sessionId).toBeUndefined();
      expect(session.loop?.tickets.map((ticket) => ticket.status)).toEqual(["queued", "failed"]);
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("survives malformed runtime records and unavailable build evidence", async () => {
    const saved = goal(["merged"]); saved.integration!.status = "merged";
    const session = (await new LocalSessionReader("unused", { read: async () => ({ $schema: "", schemaVersion: 1, teams: [], sprints: [], planningGoals: [saved] }), runtime: async () => ({} as RuntimeRecord) }, host(), { read: async () => { throw new Error("unavailable"); } }).readSessions()).sessions[0];
    expect(session).toMatchObject({ status: "error", loop: { stage: "Merge", build: { status: "unavailable" }, tickets: [{ status: "merged" }] } });
  });
});

describe("local running-build evidence", () => {
  let directory: string; let before: string; let merge: string; let after: string;
  const stamp = (sha: string) => ({ id: sha, sha, builtAt: time });
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: directory })).stdout.trim();
  const integration = (): SprintIntegration => ({ branch: "sprint/goal-loop", baseSha: before, status: "merged", mergedSha: merge });
  const available = async (sha: string) => writeFile(join(directory, "dist", "build-stamp.json"), JSON.stringify(stamp(sha)));
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "indra-build-evidence-"));
    await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
    await git("commit", "--allow-empty", "-qm", "before"); before = await git("rev-parse", "HEAD");
    await git("commit", "--allow-empty", "-qm", "integration"); merge = await git("rev-parse", "HEAD");
    await git("commit", "--allow-empty", "-qm", "later"); after = await git("rev-parse", "HEAD");
    await mkdir(join(directory, "dist"));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("proves exact and descendant running builds using local history", async () => {
    await available(before);
    for (const sha of [merge, after]) {
      expect(await new LocalSprintBuildReader(directory, Promise.resolve(stamp(sha))).read(integration())).toMatchObject({ status: "running", runningSha: sha });
    }
  });

  it("keeps the captured running stamp while dist switches, distinguishing update from reload", async () => {
    const reader = new LocalSprintBuildReader(directory, Promise.resolve(stamp(before)));
    await available(before);
    expect((await reader.read(integration())).status).toBe("update-pending");
    await available(after);
    expect(await reader.read(integration())).toMatchObject({ status: "reload-pending", runningSha: before, availableSha: after });
  });

  it("reports unavailable for missing stamps, invalid SHAs or missing commit objects", async () => {
    await available(after);
    for (const running of [undefined, stamp(""), stamp("not-a-commit"), stamp("f".repeat(40))]) {
      expect((await new LocalSprintBuildReader(directory, Promise.resolve(running)).read(integration())).status).toBe("unavailable");
    }
    await rm(join(directory, "dist", "build-stamp.json"));
    expect((await new LocalSprintBuildReader(directory, Promise.resolve(stamp(before))).read(integration())).status).toBe("unavailable");
  });

  it("makes reversion explicit even though the original integration remains in history", async () => {
    const reader = new LocalSprintBuildReader(directory, Promise.resolve(stamp(after)));
    expect((await reader.read({ ...integration(), revertPrUrl: "https://github.com/example/indra/pull/23" })).status).toBe("revert-open");
    expect((await reader.read({ ...integration(), status: "reverted" })).status).toBe("reverted");
  });
});
