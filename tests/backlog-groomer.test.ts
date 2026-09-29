import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacklogStore, type BacklogSnapshot, type TicketInput } from "../src/backlog.js";
import { BacklogGroomer, GROOMING_INTERVAL_MS, GROOMING_RETRY_MS, GROOMING_TURN_MS, groomingRecordName, parseProductOutput, type GroomingRecord, type ProductOutput } from "../src/backlog-groomer.js";
import type { AgentResult, AgentRuntime } from "../src/codex-runtime.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import { PlanningBridge, type PlanningChat } from "../src/planning-bridge.js";
import { AgentRunError } from "../src/runtime-facts.js";
import type { TeamRecord } from "../src/state-domain.js";
import { git, stateCheckout } from "./state-checkout.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true }))); });
const teamId = "team-one"; const product = "seat-product"; const lead = "seat-lead";
const source = { url: "https://github.com/acme/demo/issues/1", text: "The owner repeats sprint planning after every release." };
const evidence = { url: source.url, quote: source.text, finding: "Planning needs durable context." };
function ticket(id = "ticket-one", patch: Partial<TicketInput> = {}): TicketInput {
  return { id, title: "Retain context", problem: "The owner repeats planning.", value: "Less owner work per sprint.", status: "open", acceptanceCriteria: ["Context survives restart."], dependsOn: [], research: [{ url: evidence.url, finding: evidence.finding }], ...patch };
}
function response(snapshot: BacklogSnapshot, id = "ticket-one"): ProductOutput {
  return { summary: "Retain mission-linked planning context.", evidence: [evidence], edit: { expectedRevision: snapshot.revision, ticketChanges: [{ action: "create", ticket: ticket(id) }], candidateChanges: [] } };
}
const context = (prompt: string): BacklogSnapshot => JSON.parse(/^Current team and backlog snapshot: (.+)$/m.exec(prompt)![1]);
const result = (output: unknown, sessionId = "grooming-session"): AgentResult => ({ sessionId, response: output, startedAt: "2026-09-29T00:00:00Z", finishedAt: "2026-09-29T00:01:00Z" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(goals: PlanningGoal[] = []) {
  const team: TeamRecord = { id: teamId, slug: "team-one", displayName: "Team", mission: "Let the owner steer by problems, value and approvals.", project: { github: "acme/demo" }, externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } }, seats: [
    { id: lead, displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { username: "chick", userId: "chick" } } },
    { id: product, displayName: "Product", roles: ["Product"], externalIdentities: { mattermost: { username: "product", userId: "product" } } },
    { id: "seat-developer", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { username: "developer", userId: "developer" } } },
  ] };
  const dir = await stateCheckout("indra-groomer-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [team], sprints: [], planningGoals: goals }); dirs.push(dir);
  await mkdir(join(dir, "schema/v1"), { recursive: true });
  await writeFile(join(dir, "schema/v1/state.schema.json"), await readFile(new URL("../schema/v1/state.schema.json", import.meta.url), "utf8"));
  const store = new PlanningStore(dir); const backlog = new BacklogStore(store);
  let now = 0;
  const research = vi.fn(async () => ({ cwd: join(store.runtimeDir, "projects/acme/demo"), sources: [source] }));
  const log = vi.fn();
  const make = (seatId: string, message: AgentRuntime["message"], useStore = store) => new BacklogGroomer(useStore, teamId, seatId, () => ({ message }), { research, now: () => now, log });
  return { store, backlog, dir, research, make, log, advance: (ms = GROOMING_RETRY_MS) => { now += ms; }, record: (seatId = product) => store.readRuntimeFile<GroomingRecord>(groomingRecordName(teamId, seatId)) };
}

describe("validated Product/Lead mutations", () => {
  it("accepts cited ticket/candidate edits and rejects unknown mutations, invented citations and credentials", async () => {
    const f = await fixture(); const snapshot = await f.backlog.read(teamId); const output = response(snapshot);
    output.edit.candidateChanges = [{ action: "create", candidate: { id: "candidate-one", title: "Keep context", summary: "Keep a durable backlog.", value: "Less owner planning.", rank: 1, status: "candidate", ticketIds: ["ticket-one"], goalId: null, retrospectiveGoalId: null } }];
    expect(parseProductOutput(output, snapshot, [source])).toEqual(output);
    const bad: unknown[] = [
      { ...output, mission: "Agent mission" }, { ...output, approval: true }, { ...output, assignments: [] },
      { ...output, edit: { ...output.edit, standingPolicy: {} } },
      { ...output, evidence: [], edit: { ...output.edit, ticketChanges: [] } },
      { ...output, evidence: [{ ...evidence, url: "https://unknown.test" }] },
      { ...output, evidence: [{ ...evidence, quote: "Invented source quote." }] },
      { ...output, edit: { ...output.edit, expectedRevision: "b".repeat(40) } },
      { ...output, summary: `Bearer ${"example".repeat(6)}` },
      { ...output, edit: { ...output.edit, ticketChanges: [{ action: "create", ticket: { ...ticket(), createdBySeatId: lead } }] } },
      { ...output, edit: { ...output.edit, ticketChanges: [{ action: "create", ticket: ticket("ticket-one", { research: [] }) }] } },
      { ...output, edit: { ...output.edit, ticketChanges: Array.from({ length: 7 }, (_, index) => ({ action: "create", ticket: ticket(`ticket-${index}`) })) } },
    ];
    for (const value of bad) expect(() => parseProductOutput(value, snapshot, [source])).toThrow();
    for (const status of ["planned", "done"] as const) expect(() => parseProductOutput({ ...output, edit: { ...output.edit, ticketChanges: [{ action: "update", ticket: ticket("ticket-one", { status }) }] } }, snapshot, [source])).toThrow("committed sprint tickets");
    for (const patch of [{ status: "proposed" }, { status: "completed" }, { goalId: "goal-one" }]) expect(() => parseProductOutput({ ...output, edit: { ...output.edit, candidateChanges: [{ action: "create", candidate: { ...output.edit.candidateChanges[0].candidate, ...patch } }] } }, snapshot, [source])).toThrow();
    const discarded = structuredClone(output); discarded.edit.ticketChanges[0].ticket.status = "discarded";
    expect(() => parseProductOutput(discarded, snapshot, [source])).toThrow("open, uncommitted tickets");
  });

  it("cannot edit tickets already reserved by a sprint even if their ticket status remains open", async () => {
    const f = await fixture(); const snapshot = await f.backlog.read(teamId);
    const output = response(snapshot);
    snapshot.candidates.push({ id: "candidate-one", title: "Committed sprint", summary: "Work", value: "Value", rank: 1, ticketIds: ["ticket-one"], status: "proposed", goalId: "goal-one", createdBySeatId: lead, updatedBySeatId: lead, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" });
    expect(() => parseProductOutput(output, snapshot, [source])).toThrow("committed sprint tickets");
  });

  it("persists only valid backlog edits and runtime journals, with authorship supplied by code", async () => {
    const f = await fixture(); const before = await f.store.read();
    const message = vi.fn<AgentRuntime["message"]>(async (prompt) => result(response(context(prompt))));
    const groomer = f.make(product, message);
    expect(await groomer.tick()).toBe("worked");
    const snapshot = await f.backlog.read(teamId);
    expect(snapshot.tickets[0]).toMatchObject({ id: "ticket-one", research: [{ url: source.url, finding: evidence.finding }], createdBySeatId: product, updatedBySeatId: product });
    expect((await f.store.read()).planningGoals).toEqual(before.planningGoals);
    expect(snapshot.mission).toBe((before.teams as TeamRecord[])[0].mission);
    expect(git(f.dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("state.json");
    expect((await f.record())?.sessionId).toBe("grooming-session");
    expect(await groomer.tick()).toBe("idle");
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0][3]).toMatchObject({ timeoutMs: GROOMING_TURN_MS, purpose: "groom" });
  });

  it("does not apply malformed output or invalid cross-references, and retries after a persisted delay", async () => {
    const f = await fixture(); const before = git(f.dir, "rev-parse", "HEAD");
    const message = vi.fn<AgentRuntime["message"]>(async (prompt) => result({ ...response(context(prompt)), ownerSettings: { mission: "forbidden" } }));
    const groomer = f.make(product, message);
    await groomer.tick();
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(before);
    expect(JSON.stringify(await f.record())).not.toContain("forbidden");
    expect((await f.record())?.feedback).toBe("invalid");
    expect(await groomer.tick()).toBe("idle");
    f.advance();
    message.mockImplementation(async (prompt) => { const output = response(context(prompt)); output.edit.ticketChanges[0].ticket.dependsOn = ["ticket-missing"]; return result(output); });
    await groomer.tick();
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(before);
    expect((await f.record())?.pending).toBeUndefined();
    f.advance(); message.mockImplementation(async (prompt) => result(response(context(prompt)))); await groomer.tick();
    expect((await f.backlog.read(teamId)).tickets).toHaveLength(1);
  });
});

describe("bounded, resumable background grooming", () => {
  it("grooms during an active sprint while repeated real bridge polls keep observing workflow events", async () => {
    const at = "2026-09-29T00:00:00Z";
    const goal: PlanningGoal = { id: "goal-active", teamId, seatId: lead, participantSeatIds: ["seat-developer"], goal: "Implement a feature", stage: "approved", createdAt: at, updatedAt: at, projectRefs: ["acme/demo"], mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Implement", decisions: [], openQuestions: [] },
      proposal: { id: "proposal-active", createdAt: at, summary: "Implement", risks: [], openQuestions: [], outcomes: [{ id: "outcome-one", title: "Build", description: "Build the feature.", seatId: "seat-developer" }] },
      assignments: [{ outcomeId: "outcome-one", seatId: "seat-developer", status: "running", updatedAt: at }], integration: { branch: "sprint/goal-active", baseSha: "a".repeat(40), status: "collecting" } };
    const f = await fixture([goal]); const pending = deferred<AgentResult>();
    const message = vi.fn<AgentRuntime["message"]>(() => pending.promise); const groomer = f.make(lead, message);
    const chat: PlanningChat = { ownUserId: vi.fn(async () => "chick"), since: vi.fn(async () => []), reactions: vi.fn(async () => []), isBot: vi.fn(async () => true),
      post: vi.fn(async (channel_id, text, root_id = "") => ({ id: "posted", user_id: "chick", channel_id, root_id, message: text, create_at: 1 })) };
    const bridgeMessage = vi.fn<AgentRuntime["message"]>();
    const bridge = new PlanningBridge(f.store, chat, { message: bridgeMessage }, 20, { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) }, { grooming: async () => { groomer.poll(); } });
    await bridge.poll();
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(1));
    expect(message.mock.calls[0][0]).toContain('"id":"goal-active"');
    expect(message.mock.calls[0][0]).toContain('"status":"running"');
    await bridge.poll(); await bridge.poll();
    expect(vi.mocked(chat.ownUserId).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(bridgeMessage).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledTimes(1);
    pending.resolve(result(response(context(message.mock.calls[0][0]))));
    await groomer.settled();
    expect((await f.backlog.read(teamId)).tickets).toHaveLength(1);
    expect((await f.store.read()).planningGoals![0].assignments).toEqual(goal.assignments);
  });

  it("continues state work while a model is pending, and coalesces overlapping ticks", async () => {
    const f = await fixture(); const pending = deferred<AgentResult>();
    const message = vi.fn<AgentRuntime["message"]>(() => pending.promise);
    const groomer = f.make(product, message);
    expect(groomer.poll()).toBeUndefined();
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 10; index++) groomer.poll();
    // This real state transaction would block if the model held state.lock.
    await f.store.updateOwnerSettings(teamId, { mission: "A changed owner mission." });
    expect((await f.backlog.read(teamId)).mission).toBe("A changed owner mission.");
    pending.resolve(result(response(context(message.mock.calls[0][0]))));
    await groomer.settled();
    expect((await f.backlog.read(teamId)).tickets).toEqual([]);
    expect((await f.record())?.feedback).toBe("stale");
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("reconciles concurrent Product and Lead edits without overwriting either seat's work", async () => {
    const f = await fixture(); const productDone = deferred<AgentResult>(); const leadDone = deferred<AgentResult>();
    const productMessage = vi.fn<AgentRuntime["message"]>(() => productDone.promise);
    const leadMessage = vi.fn<AgentRuntime["message"]>(() => leadDone.promise);
    const first = f.make(product, productMessage); const other = f.make(lead, leadMessage, new PlanningStore(f.dir));
    const firstTurn = first.tick(); const otherTurn = other.tick();
    await vi.waitFor(() => { expect(productMessage).toHaveBeenCalledTimes(1); expect(leadMessage).toHaveBeenCalledTimes(1); });
    productDone.resolve(result(response(context(productMessage.mock.calls[0][0]), "ticket-product"), "product-session")); await firstTurn;
    leadDone.resolve(result(response(context(leadMessage.mock.calls[0][0]), "ticket-lead"), "lead-session")); await otherTurn;
    expect((await f.record(lead))?.feedback).toBe("stale");
    f.advance();
    leadMessage.mockImplementation(async (prompt) => { expect(context(prompt).tickets[0].id).toBe("ticket-product"); expect(prompt).toContain("Reconcile with the current records"); return result(response(context(prompt), "ticket-lead"), "lead-session"); });
    await other.tick();
    expect((await f.backlog.read(teamId)).tickets.map((item) => [item.id, item.createdBySeatId])).toEqual([["ticket-product", product], ["ticket-lead", lead]]);
    expect(leadMessage.mock.calls[1][2]).toBe("lead-session");
  });

  it("refreshes the owner's mission on a resumed turn and never applies the earlier mission's output", async () => {
    const f = await fixture(); const pending = deferred<AgentResult>();
    const message = vi.fn<AgentRuntime["message"]>(() => pending.promise); const groomer = f.make(product, message);
    const turn = groomer.tick(); await vi.waitFor(() => expect(message).toHaveBeenCalled());
    await f.store.updateOwnerSettings(teamId, { mission: "Help the owner compare sprint value." });
    pending.resolve(result(response(context(message.mock.calls[0][0])))); await turn;
    expect((await f.backlog.read(teamId)).tickets).toEqual([]);
    f.advance(); message.mockImplementation(async (prompt) => result(response(context(prompt))));
    await groomer.tick();
    expect(message.mock.calls[1][0]).toContain('Current owner mission: "Help the owner compare sprint value."');
    expect(message.mock.calls[1][2]).toBe("grooming-session");
    expect((await f.backlog.read(teamId)).tickets).toHaveLength(1);
  });

  it("recovers a validated pending response without rerunning research or the agent", async () => {
    const f = await fixture(); const save = f.store.saveRuntime.bind(f.store); let stopped = false;
    vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      await save(name, value);
      if ((value as GroomingRecord).phase === "pending" && !stopped) { stopped = true; throw new Error("Interrupted after journal write"); }
    });
    const message = vi.fn<AgentRuntime["message"]>(async (prompt) => result(response(context(prompt))));
    await f.make(product, message).tick();
    expect((await f.record())?.pending).toBeDefined();
    expect((await f.backlog.read(teamId)).tickets).toEqual([]);
    const restartedMessage = vi.fn<AgentRuntime["message"]>();
    const restarted = f.make(product, restartedMessage, new PlanningStore(f.dir));
    await restarted.tick();
    expect((await f.backlog.read(teamId)).tickets).toHaveLength(1);
    expect(restartedMessage).not.toHaveBeenCalled(); expect(f.research).toHaveBeenCalledTimes(1);
    expect(await restarted.tick()).toBe("idle");
  });

  it("recognizes an already committed response after a crash before acknowledgment", async () => {
    const f = await fixture(); const save = f.store.saveRuntime.bind(f.store); let pendingSaved = false;
    vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      if (name === groomingRecordName(teamId, product) && pendingSaved) throw new Error("Process stopped");
      await save(name, value);
      if ((value as GroomingRecord).phase === "pending") pendingSaved = true;
    });
    const message = vi.fn<AgentRuntime["message"]>(async (prompt) => result(response(context(prompt))));
    await f.make(product, message).tick();
    expect((await f.backlog.read(teamId)).tickets).toHaveLength(1);
    expect((await f.record())?.pending).toBeDefined();
    const head = git(f.dir, "rev-parse", "HEAD");
    const restartedMessage = vi.fn<AgentRuntime["message"]>();
    await f.make(product, restartedMessage, new PlanningStore(f.dir)).tick();
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(head);
    expect((await f.record())?.pending).toBeUndefined();
    expect((await f.record())?.nextRunAt).toBe(GROOMING_INTERVAL_MS);
    expect(restartedMessage).not.toHaveBeenCalled();
  });

  it("keeps a timed-out session handle and usage locally and resumes with a bounded turn after restart", async () => {
    const f = await fixture();
    const message = vi.fn<AgentRuntime["message"]>().mockRejectedValue(new AgentRunError("Private runtime diagnostics", { invocationId: "invocation-one", engine: "codex", sessionId: "partial-session", startedAt: "2026-09-29T00:00:00Z", finishedAt: "2026-09-29T00:03:00Z", status: "timed-out", cumulativeUsage: { inputTokens: 20 } }));
    await f.make(product, message).tick();
    expect((await f.record())?.sessionId).toBe("partial-session");
    expect(JSON.stringify(await f.record())).not.toContain("Private runtime");
    expect(f.log.mock.calls.flat().join()).not.toContain("Private runtime");
    const restarted = f.make(product, message, new PlanningStore(f.dir));
    expect(await restarted.tick()).toBe("idle"); f.advance();
    message.mockImplementation(async (prompt) => result(response(context(prompt)), "partial-session"));
    await restarted.tick();
    expect(message.mock.calls[1][2]).toBe("partial-session");
    expect(message.mock.calls[1][3]).toMatchObject({ timeoutMs: GROOMING_TURN_MS, previousSessionUsage: { inputTokens: 20 } });
  });

  it("stops applying grooming output when the Product seat starts retirement during its turn", async () => {
    const f = await fixture(); const pending = deferred<AgentResult>();
    const message = vi.fn<AgentRuntime["message"]>(() => pending.promise); const groomer = f.make(product, message);
    const turn = groomer.tick(); await vi.waitFor(() => expect(message).toHaveBeenCalled());
    await f.store.update((state) => { (state.teams as TeamRecord[])[0].seats.find((seat) => seat.id === product)!.status = "retiring"; }, "Retire Product");
    pending.resolve(result(response(context(message.mock.calls[0][0])))); await turn;
    expect((await f.backlog.read(teamId)).tickets).toEqual([]);
    f.advance(GROOMING_INTERVAL_MS);
    expect(await groomer.tick()).toBe("idle");
    expect(message).toHaveBeenCalledTimes(1);
  });
});
