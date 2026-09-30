import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubEvents, runWorkflowHost, validateWorkflowEvent, verifyWebhook, webhookHandler, workflowDigest, WorkflowInbox } from "../src/remodel-events.js";
import type { PlanningStore } from "../src/planning.js";
import type { WorkflowEvent } from "../src/goal-contract.js";
import * as stateCommit from "../src/state-commit.js";

const fileNotifications = vi.hoisted(() => ({ suppressed: false }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, watch: (path: string, listener: (event: string, name: string | null) => void) => original.watch(path, (event, name) => {
    if (!fileNotifications.suppressed) listener(event, name);
  }) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); vi.unstubAllGlobals(); fileNotifications.suppressed = false; });
const at = "2026-09-01T00:00:00.000Z";
const sha = "a".repeat(40);
const url = "https://github.com/test/project/pull/7";
const queue = (id = "delivery-one"): WorkflowEvent => ({ kind: "queue-changed", id, teamId: "team-one", at });
async function directory() { const root = await mkdtemp(join(tmpdir(), "indra-workflow-events-")); roots.push(root); return root; }
function store(runtimeDir: string, repo = "test/project"): PlanningStore {
  return { runtimeDir, checkout: runtimeDir,
    read: async () => ({ teams: [{ id: "team-one", project: { github: repo } }], planningGoals: [{ id: "goal-one", teamId: "team-one", workflowModel: "goals-v1", integration: { prUrl: url } }] }),
    readRuntimeFile: async (name: string) => name === "goal-workflow-goal-one" ? { lanes: [{ id: "lane-one", prUrl: url, headSha: sha }], report: { headSha: sha } } : undefined,
  } as unknown as PlanningStore;
}

describe("finite workflow event validation", () => {
  it("validates a seat-scoped Product retry without a synthetic goal or approval fields", () => {
    const event = { kind: "product-retry", id: "product-retry-one", teamId: "team-one", seatId: "seat-product", reason: "Resolved model failure", at };
    expect(validateWorkflowEvent(event)).toEqual(event);
    for (const invalid of [{ ...event, goalId: "goal-fabricated" }, { ...event, seatId: "../seat" }, { ...event, seatId: null }, { ...event, reason: "" }, { ...event, approved: true }]) expect(() => validateWorkflowEvent(invalid)).toThrow();
  });
  it("accepts the finite startup event but rejects extra fields, unknown variants, unsafe identities and mismatched reports", () => {
    expect(validateWorkflowEvent({ kind: "startup", teamId: "team-one", at })).toEqual({ kind: "startup", teamId: "team-one", at });
    for (const event of [{ ...queue(), secret: "do-not-retain" }, { ...queue(), kind: "poll" }, { ...queue(), teamId: "../team" }, { ...queue(), at: "later" }, { ...queue(), id: "" }, { kind: "startup", teamId: "team-one", at, id: "extra" }, { ...queue(), kind: "developer-report", goalId: "goal-one", seatId: "seat-one", report: null }]) expect(() => validateWorkflowEvent(event)).toThrow();
    expect(() => validateWorkflowEvent({ ...queue(), kind: "review", goalId: "goal-one", laneId: null, prUrl: url, headSha: sha, reviewer: "bot", state: "approved", findings: [{ path: "../token", line: 1, reason: "unsafe" }] })).toThrow();
    expect(() => validateWorkflowEvent({ ...queue(), kind: "ci", goalId: "goal-one", laneId: null, prUrl: "https://evil.test/pull/1", headSha: sha, state: "passed" })).toThrow();
    expect(() => validateWorkflowEvent({ ...queue(), kind: "ci", goalId: "goal-one", laneId: null, prUrl: url, headSha: "moving-branch", state: "passed" })).toThrow();
  });
  it("returns a detached validated event and preserves review findings without accepting arbitrary approval fields", () => {
    const input = { ...queue(), kind: "review", goalId: "goal-one", laneId: "lane-one", prUrl: url, headSha: sha, reviewer: "satori-miyamoto", state: "changes-requested", findings: [{ path: "src/a.ts", line: 8, reason: "Incorrect result" }] };
    const value = validateWorkflowEvent(input); input.findings[0].reason = "Changed";
    expect(value).toMatchObject({ findings: [{ reason: "Incorrect result" }] });
    expect(() => validateWorkflowEvent({ ...input, approved: true })).toThrow();
  });
});

describe("immutable delivery and restart receipts", () => {
  it("delivers Product retry only to its seat while other consumers receipt it without work", async () => {
    const root = await directory(); const inbox = new WorkflowInbox(root);
    await inbox.publish({ kind: "product-retry", id: "product-retry-one", teamId: "team-one", seatId: "seat-product", reason: "Resolved model failure", at });
    for (const consumer of ["scheduler-one", "seat-developer", "seat-product"]) {
      const seen: string[] = []; const controller = new AbortController();
      await runWorkflowHost({ store: store(root), teamId: "team-one", consumer, signal: controller.signal,
        onReady: async () => controller.abort(), turn: async (event) => { seen.push(event.kind); },
      });
      expect(seen).toEqual(consumer === "seat-product" ? ["startup", "product-retry"] : ["startup"]);
      const replay = vi.fn(async () => {}); await inbox.drain(consumer, "team-one", replay); expect(replay).not.toHaveBeenCalled();
    }
  });
  it("reconciles duplicate deliveries, retries interrupted consumers and keeps separate durable consumer receipts", async () => {
    const root = await directory(); const inbox = new WorkflowInbox(root);
    await Promise.all([inbox.publish(queue()), inbox.publish(queue())]);
    await inbox.publish({ ...queue(), at: "2026-09-02T00:00:00.000Z" });
    const files = (await readdir(inbox.directory)).filter((name) => name.endsWith(".json")); expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(inbox.directory, files[0]), "utf8")).at).toBe(at);
    const failed = vi.fn(async () => { throw new Error("crash"); });
    await expect(inbox.drain("developer-one", "team-one", failed)).rejects.toThrow("crash");
    const turn = vi.fn(async () => {});
    await new WorkflowInbox(root).drain("developer-one", "team-one", turn);
    await new WorkflowInbox(root).drain("developer-one", "team-one", turn);
    expect(turn).toHaveBeenCalledTimes(1);
    await inbox.drain("scheduler-one", "team-one", turn); expect(turn).toHaveBeenCalledTimes(2);
    await inbox.drain("scheduler-other", "team-other", turn); expect(turn).toHaveBeenCalledTimes(2);
    await expect(inbox.publish({ ...queue(), teamId: "team-other" })).rejects.toThrow("identity was reused");
  });
  it("rejects malformed retained messages instead of treating unreadable state as an empty inbox", async () => {
    const inbox = new WorkflowInbox(await directory()); await inbox.publish(queue());
    const [name] = await readdir(inbox.directory); await writeFile(join(inbox.directory, name), JSON.stringify({ ...queue(), credential: "unexpected" }));
    const turn = vi.fn(async () => {}); await expect(inbox.drain("consumer-one", "team-one", turn)).rejects.toThrow("Invalid workflow event"); expect(turn).not.toHaveBeenCalled();
  });
  it("runs a real file-event lifecycle without timer polling or waking on its own receipts", async () => {
    const root = await directory(); const inbox = new WorkflowInbox(root); const controller = new AbortController(); const seen: string[] = [];
    let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
    let received!: () => void; const delivery = new Promise<void>((resolve) => { received = resolve; });
    const host = runWorkflowHost({ store: store(root), teamId: "team-one", consumer: "consumer-one", signal: controller.signal, onReady: async () => ready(), turn: async (event) => { seen.push(event.kind); if (event.kind !== "startup") received(); } });
    await started;
    // Retain an event without the in-process publisher, exercising the other-process filesystem path.
    const path = join(inbox.directory, `${workflowDigest("delivery-one")}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(queue()), { mode: 0o600 }); await rename(`${path}.tmp`, path);
    await delivery; controller.abort(); await host;
    expect(seen).toEqual(["startup", "queue-changed"]);
    const restarted = vi.fn(async () => {}); await new WorkflowInbox(root).drain("consumer-one", "team-one", restarted); expect(restarted).not.toHaveBeenCalled();
  });
  it("keeps a long consumer turn alive while acknowledging scheduler idle without losing receipts", async () => {
    const root = await directory(); const inbox = new WorkflowInbox(root); const controller = new AbortController();
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
    const ready = deferred(); const started = deferred(); const release = deferred(); const idleSeen = deferred(); const received = deferred();
    const seen: string[] = []; let activities = 0;
    const withFileLock = stateCommit.withFileLock;
    // Compress the production lock deadline, then hold real work past it; filesystem locks remain real.
    const lockDeadline = vi.spyOn(stateCommit, "withFileLock").mockImplementation((file, work) => withFileLock(file, work, 25));
    const acknowledge = WorkflowInbox.prototype.acknowledgeSchedulerIdle;
    const idleObservation = vi.spyOn(WorkflowInbox.prototype, "acknowledgeSchedulerIdle").mockImplementation(async function (this: WorkflowInbox, consumer, teamId, event) {
      idleSeen.resolve(); await acknowledge.call(this, consumer, teamId, event);
    });
    const host = runWorkflowHost({ store: store(root), teamId: "team-one", consumer: "seat-product", signal: controller.signal,
      onReady: async () => ready.resolve(), activity: async (run) => { activities++; await run(); },
      turn: async (event) => {
        if (event.kind === "startup") return;
        seen.push(event.id);
        if (event.id === "long-turn") { started.resolve(); await release.promise; }
        if (event.id === "after-long-turn") received.resolve();
      },
    });
    const ended = host.then(() => { throw new Error("Host ended before its next business event."); });
    void ended.catch(() => {});
    try {
      await Promise.race([ready.promise, ended]);
      await inbox.publish(queue("long-turn")); await Promise.race([started.promise, ended]);
      const activeDuringLongTurn = activities;
      const idle: Extract<WorkflowEvent, { kind: "queue-changed" }> = { kind: "queue-changed", id: "scheduler-idle:team-one:long-turn", teamId: "team-one", at: "1970-01-01T00:00:00.000Z" };
      await inbox.publish(idle); await idleSeen.promise;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(activities).toBe(activeDuringLongTurn);
      await inbox.publish(queue("after-long-turn")); release.resolve();
      await Promise.race([received.promise, ended]);
      controller.abort(); await host;
      expect(seen).toEqual(["long-turn", "after-long-turn"]);
      const receipts: string[] = JSON.parse(await readFile(join(root, "workflow-receipts-seat-product.json"), "utf8"));
      expect(receipts).toEqual(expect.arrayContaining(["long-turn", "after-long-turn", idle.id]));
      expect(new Set(receipts).size).toBe(receipts.length);
      const replay = vi.fn(async () => {}); await new WorkflowInbox(root).drain("seat-product", "team-one", replay); expect(replay).not.toHaveBeenCalled();
    } finally {
      release.resolve(); controller.abort(); await Promise.allSettled([host]); idleObservation.mockRestore(); lockDeadline.mockRestore();
    }
  });
  it.each([false, true])("delivers a durable UI-only idle hint and settles receipt-only (missed file notification: %s)", async (missedNotification) => {
    fileNotifications.suppressed = missedNotification;
    const root = await directory(); const inbox = new WorkflowInbox(root); const controller = new AbortController();
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
    const slowStarted = deferred(); const release = deferred(); const idleSeen = deferred(); const receiptOnly = deferred(); const uiReady = deferred();
    let leased = false; let activities = 0; let idleEvent: WorkflowEvent | undefined;
    const acknowledged = new Set<string>();
    const acknowledge = WorkflowInbox.prototype.acknowledgeSchedulerIdle;
    const receiptObservation = vi.spyOn(WorkflowInbox.prototype, "acknowledgeSchedulerIdle").mockImplementation(async function (this: WorkflowInbox, consumer, teamId, event) {
      await acknowledge.call(this, consumer, teamId, event);
      acknowledged.add(consumer); if (acknowledged.size === 2) receiptOnly.resolve();
    });
    const primary = vi.fn(async () => {}); const slow = vi.fn(async (event: WorkflowEvent): Promise<WorkflowEvent[]> => { if (event.kind === "startup") { slowStarted.resolve(); await release.promise; } return []; });
    const onIdle = vi.fn(async (identity: string) => {
      expect(leased).toBe(false);
      idleEvent = { kind: "queue-changed", id: `scheduler-idle:team-one:${identity}`, teamId: "team-one", at: "1970-01-01T00:00:00.000Z" };
      await inbox.publish(idleEvent);
    });
    const ui = runWorkflowHost({ store: store(root), teamId: "team-one", consumer: "ui-team-one", signal: controller.signal, includeSchedulerIdle: true,
      onReady: async () => uiReady.resolve(), turn: async (event) => { if (event.kind === "queue-changed" && event.id.startsWith("scheduler-idle:")) { expect(leased).toBe(false); idleSeen.resolve(); } },
    });
    const uiEnded = ui.then(() => { throw new Error("UI host ended before idle delivery."); }); void uiEnded.catch(() => {});
    await Promise.race([uiReady.promise, uiEnded]);
    const business = runWorkflowHost({ store: store(root), teamId: "team-one", consumer: "scheduler-team-one", signal: controller.signal, turn: primary,
      consumers: async () => [{ consumer: "release-goal-one", turn: slow }], onIdle,
      activity: async (run) => { activities++; leased = true; try { await run(); } finally { leased = false; } },
    });
    const businessEnded = business.then(() => { throw new Error("Business host ended before idle receipts."); }); void businessEnded.catch(() => {});
    const deadline = setTimeout(() => { controller.abort(); release.resolve(); }, 4_000);
    try {
      await Promise.race([slowStarted.promise, businessEnded, uiEnded]); expect(onIdle).not.toHaveBeenCalled(); expect(leased).toBe(true);
      release.resolve(); await Promise.race([idleSeen.promise, uiEnded, businessEnded]); await Promise.race([receiptOnly.promise, businessEnded, uiEnded]);
      expect(onIdle).toHaveBeenCalledTimes(1); expect(primary).toHaveBeenCalledTimes(1); expect(slow).toHaveBeenCalledTimes(1);
      expect(activities).toBe(1);
      const retained = (await readdir(inbox.directory)).filter((name) => name.endsWith(".json"));
      expect(retained).toHaveLength(1);
      expect(JSON.parse(await readFile(join(inbox.directory, retained[0]), "utf8"))).toEqual(idleEvent);
      for (const key of ["scheduler-team-one", "release-goal-one", "ui-team-one"]) {
        // UI signals during its turn; draining below waits for its receipt commit before checking it.
        await new WorkflowInbox(root).drain(key, "team-one", async () => { throw new Error("Idle hint was not durably acknowledged."); });
      }
      expect(idleEvent!.kind === "queue-changed" && idleEvent!.id).toMatch(/^scheduler-idle:team-one:[a-f0-9]{64}$/);
      await inbox.publish(idleEvent!);
      const rerun = vi.fn(async () => {});
      await new WorkflowInbox(root).drain("scheduler-team-one", "team-one", rerun);
      await new WorkflowInbox(root).drain("release-goal-one", "team-one", rerun);
      expect(rerun).not.toHaveBeenCalled(); expect(onIdle).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(deadline); controller.abort(); release.resolve(); await Promise.allSettled([business, ui]); receiptObservation.mockRestore(); }
  });
  it.each([false, true])("authenticates the Mattermost socket and durably dispatches only home notifications (missed file notification: %s)", async (missedNotification) => {
    const root = await directory(); const controller = new AbortController(); let socket!: FakeSocket;
    fileNotifications.suppressed = missedNotification;
    const frames: unknown[] = [];
    class FakeSocket extends EventTarget {
      closed = false;
      constructor(connection: URL) { super(); socket = this; expect(String(connection)).toBe("wss://mattermost.example/api/v4/websocket"); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(value: string) { frames.push(JSON.parse(value)); this.frame({ status: "OK", seq_reply: 1 }); }
      frame(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
      close() { this.closed = true; this.dispatchEvent(new Event("close")); }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    let received!: () => void; const delivery = new Promise<void>((resolve) => { received = resolve; }); const events: WorkflowEvent[] = [];
    const host = runWorkflowHost({ store: store(root), teamId: "team-one", consumer: "bridge-one", signal: controller.signal, mattermost: { server: "https://mattermost.example", token: "fixture-token", channelId: "home" },
      onReady: async () => { socket.frame({ event: "reaction_added", broadcast: { channel_id: "elsewhere" } }); socket.frame({ event: "reaction_added", broadcast: { channel_id: "home" }, data: { reaction: "untrusted" } }); },
      turn: async (event) => {
        events.push(event);
        if (event.kind !== "startup") {
          const directory = join(root, "workflow-events");
          const retained = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
          expect(retained).toContainEqual(event); received();
        }
      },
    });
    const deadline = setTimeout(() => controller.abort(), 4_000);
    try {
      await Promise.race([delivery, host.then(() => { throw new Error("Mattermost host ended before delivering the authenticated notification."); })]);
    } finally { clearTimeout(deadline); controller.abort(); await host; }
    expect(frames).toEqual([{ seq: 1, action: "authentication_challenge", data: { token: "fixture-token" } }]);
    expect(events.map((event) => event.kind)).toEqual(["startup", "queue-changed"]);
    expect(JSON.stringify(events)).not.toContain("fixture-token"); expect(JSON.stringify(events)).not.toContain("untrusted"); expect(socket.closed).toBe(true);
    const duplicate = vi.fn(async () => {}); await new WorkflowInbox(root).drain("bridge-one", "team-one", duplicate); expect(duplicate).not.toHaveBeenCalled();
  });
});

describe("authenticated GitHub ingress", () => {
  const payload = { repository: { full_name: "test/project" }, pull_request: { html_url: url, head: { sha }, merged: false } };
  it("rejects changed raw bytes and invalid signatures", () => {
    const bytes = Buffer.from(JSON.stringify(payload)); const secret = "fixture-only";
    const signature = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
    expect(verifyWebhook(secret, signature, bytes)).toBe(true);
    expect(verifyWebhook(secret, signature, Buffer.concat([bytes, Buffer.from(" ")]))).toBe(false);
    expect(verifyWebhook(secret, "sha256=not-a-signature", bytes)).toBe(false);
    expect(verifyWebhook("", signature, bytes)).toBe(false);
  });
  it("maps only state-project PRs and treats CI claims as wakeups requiring a fresh external read", async () => {
    const s = store(await directory());
    expect(await githubEvents(s, "delivery-1", "pull_request", payload)).toEqual([expect.objectContaining({ kind: "ci", state: "pending", goalId: "goal-one", laneId: "lane-one", headSha: sha })]);
    expect(await githubEvents(s, "delivery-1", "pull_request", { ...payload, repository: { full_name: "elsewhere/project" } })).toEqual([]);
    expect(await githubEvents(s, "delivery-2", "pull_request_review", { ...payload, review: { user: { login: "satori-miyamoto" }, state: "dismissed" } })).toEqual([expect.objectContaining({ kind: "review", state: "dismissed" })]);
    expect(await githubEvents(s, "delivery-3", "check_run", { repository: payload.repository, check_run: { head_sha: "b".repeat(40), conclusion: "success", pull_requests: [{ number: 7 }] } })).toEqual([expect.objectContaining({ kind: "ci", state: "pending", headSha: "b".repeat(40) })]);
  });
  it("acknowledges only after a valid signed delivery is retained; unauthorized requests write nothing", async () => {
    const s = store(await directory()); const inbox = new WorkflowInbox(s.runtimeDir); const bytes = Buffer.from(JSON.stringify(payload));
    const secret = "fixture-only"; const signature = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
    const request = (signature: string) => Object.assign(Readable.from([bytes]), { method: "POST", url: "/indra/github", headers: { "x-hub-signature-256": signature, "x-github-event": "pull_request", "x-github-delivery": "delivery-1" } }) as unknown as IncomingMessage;
    const response = () => { const result = { status: 0, writeHead(status: number) { this.status = status; return this; }, end() {} }; return result; };
    const denied = response(); await webhookHandler(s, inbox, secret)(request("wrong"), denied as unknown as ServerResponse); expect(denied.status).toBe(401);
    const turn = vi.fn(async () => {}); await inbox.drain("consumer", "team-one", turn); expect(turn).not.toHaveBeenCalled();
    const accepted = response(); await webhookHandler(s, inbox, secret)(request(signature), accepted as unknown as ServerResponse); expect(accepted.status).toBe(202);
    await inbox.drain("consumer", "team-one", turn); expect(turn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "github:delivery-1:goal-one" }));
    const repeated = response(); await webhookHandler(s, inbox, secret)(request(signature), repeated as unknown as ServerResponse); expect(repeated.status).toBe(202);
    await inbox.drain("consumer", "team-one", turn); expect(turn).toHaveBeenCalledTimes(1);
  });
});
