import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { withFileLock } from "./state-commit.js";
import { goalRuntimeFilename, teamRuntimeFilename, validateGoalReport, validateOwnedFiles, type GoalRuntimeRecord, type SchedulerRuntimeRecord, type WorkflowEvent } from "./goal-contract.js";
import { teamProject, type PlanningStore } from "./planning.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length < 16_000 && !value.includes("\0");
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const instant = (value: unknown): value is string => text(value) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const url = (value: unknown) => typeof value === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value);
export const workflowDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function need(ok: unknown): asserts ok { if (!ok) throw new Error("Invalid workflow event."); }

/** External notifications are hints, never approval/merge evidence. Validate before retaining any payload. */
export function validateWorkflowEvent(value: unknown): WorkflowEvent {
  need(object(value) && text(value.kind) && id(value.teamId) && instant(value.at));
  const fields: Record<string, string[]> = {
    startup: [], proposal: ["goalId", "proposalId"], approval: ["goalId"], "proposal-vetted": ["goalId", "vetting"],
    "developer-report": ["goalId", "seatId", "report"], ci: ["goalId", "laneId", "prUrl", "headSha", "state"],
    review: ["goalId", "laneId", "prUrl", "headSha", "reviewer", "state", "findings"], merge: ["goalId", "laneId", "prUrl", "headSha", "mergedSha"],
    "build-running": ["goalId", "buildSha", "runningSha"], redirect: ["goalId", "redirect"], "goal-closed": ["goalId"], "seat-idle": ["seatId"],
    retry: ["goalId", "reason"], "queue-changed": [], conflict: ["goalId", "laneId", "prUrl", "headSha", "baseSha"],
    "agent-completed": ["goalId", "laneId", "agentId", "status", "headSha", "report"],
  };
  need(Object.hasOwn(fields, value.kind)); const extra = fields[value.kind];
  const keys = ["kind", "teamId", "at", ...(value.kind === "startup" ? [] : ["id"]), ...extra];
  need(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  if (value.kind !== "startup") need(text(value.id));
  for (const key of ["goalId", "seatId", "proposalId", "laneId"]) if (key in value) need(id(value[key]) || (value[key] === null && ((key === "laneId" && value.kind !== "conflict" && value.kind !== "agent-completed") || (key === "goalId" && value.kind === "redirect"))));
  for (const key of ["headSha", "mergedSha", "baseSha", "buildSha", "runningSha"]) if (key in value) need(sha(value[key]) || (key === "headSha" && value.kind === "agent-completed" && value[key] === null));
  if ("prUrl" in value) need(url(value.prUrl));
  if (value.kind === "ci") need(["pending", "passed", "failed"].includes(String(value.state)));
  if (value.kind === "review") {
    need(text(value.reviewer) && ["approved", "changes-requested", "dismissed"].includes(String(value.state)) && Array.isArray(value.findings));
    for (const item of value.findings) { need(object(item) && Object.keys(item).length === 3 && text(item.path) && Number.isSafeInteger(item.line) && Number(item.line) > 0 && text(item.reason)); validateOwnedFiles([item.path]); }
  }
  if (value.kind === "redirect") { const r = value.redirect; need(object(r) && Object.keys(r).length === 4 && text(r.postId) && text(r.userId) && text(r.message) && instant(r.at)); }
  if (value.kind === "proposal-vetted") { const v = value.vetting; need(object(v) && Object.keys(v).length === 5 && v.proposalId !== undefined && id(v.proposalId) && id(v.leadSeatId) && instant(v.at) && Array.isArray(v.notes) && v.notes.every(text)); validateOwnedFiles(v.ownedFiles); }
  if (value.kind === "retry") need(text(value.reason));
  if (value.kind === "agent-completed") need(text(value.agentId) && ["succeeded", "failed"].includes(String(value.status)));
  if ("report" in value && value.report !== null) {
    const report = validateGoalReport(value.report); need(report.teamId === value.teamId && report.goalId === value.goalId && (!value.seatId || report.seatId === value.seatId));
  } else need(value.kind !== "developer-report");
  return structuredClone(value) as unknown as WorkflowEvent;
}

/** Immutable inbox files and separate receipts: consumer writes never retrigger the inbox watcher. */
export class WorkflowInbox {
  readonly directory: string;
  constructor(readonly runtimeDir: string) { this.directory = join(runtimeDir, "workflow-events"); }
  async publish(input: WorkflowEvent): Promise<void> {
    const event = validateWorkflowEvent(input); need(event.kind !== "startup");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = workflowDigest(event.id); const path = join(this.directory, `${name}.json`); const bytes = JSON.stringify(event);
    await withFileLock(join(this.runtimeDir, `workflow-event-${name}.lock`), async () => {
      const previous = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
      if (previous !== undefined) {
        const original = validateWorkflowEvent(JSON.parse(previous));
        if (JSON.stringify({ ...event, at: original.at }) !== previous) throw new Error("Workflow event identity was reused with different content.");
        return; // Redelivery keeps the first receipt time instead of manufacturing a second event.
      }
      const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path);
    });
  }
  async drain(consumer: string, teamId: string, turn: (event: WorkflowEvent) => Promise<void>): Promise<void> {
    need(id(consumer) && id(teamId));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await withFileLock(join(this.runtimeDir, `workflow-consumer-${consumer}.lock`), async () => {
      const receipt = join(this.runtimeDir, `workflow-receipts-${consumer}.json`);
      const handled = new Set<string>(JSON.parse(await readFile(receipt, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return "[]"; })));
      const entries: WorkflowEvent[] = [];
      for (const name of (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        const bytes = await readFile(join(this.directory, name), "utf8"); need(bytes.length < 1_000_000);
        const event = validateWorkflowEvent(JSON.parse(bytes));
        if (event.kind !== "startup" && event.teamId === teamId && !handled.has(event.id)) entries.push(event);
      }
      entries.sort((a, b) => a.at.localeCompare(b.at));
      for (const event of entries) {
        if (event.kind === "startup") continue;
        await turn(event); handled.add(event.id);
        const tmp = `${receipt}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify([...handled]), { mode: 0o600 }); await rename(tmp, receipt);
      }
    });
  }
}

/** A signed GitHub delivery only wakes records in the repository from state. Services re-read GitHub proof. */
export async function githubEvents(store: PlanningStore, delivery: string, kind: string, payload: unknown): Promise<WorkflowEvent[]> {
  need(text(delivery) && /^[A-Za-z0-9-]+$/.test(delivery) && object(payload));
  if (kind === "ping") return [];
  need(["pull_request", "pull_request_review", "check_run", "check_suite", "status"].includes(kind));
  need(object(payload.repository) && text(payload.repository.full_name));
  const repository = payload.repository.full_name;
  const state = await store.read(); const events: WorkflowEvent[] = [];
  const pr = object(payload.pull_request) ? payload.pull_request : undefined;
  const head = pr && object(pr.head) ? pr.head.sha : object(payload.check_run) ? payload.check_run.head_sha : object(payload.check_suite) ? payload.check_suite.head_sha : payload.sha;
  need(sha(head));
  for (const goal of state.planningGoals ?? []) {
    if (goal.workflowModel !== "goals-v1" || goal.ceremony?.closure || teamProject(state, goal.teamId)?.toLowerCase() !== repository.toLowerCase()) continue;
    const record = await store.readRuntimeFile<GoalRuntimeRecord>(goalRuntimeFilename(goal.id));
    const scheduler = await store.readRuntimeFile<SchedulerRuntimeRecord>(teamRuntimeFilename(goal.teamId));
    const archive = await store.readRuntimeFile<{ prUrl?: string; gate?: { headSha: string } }>(`retro-publication-${goal.id}`);
    const lane = record?.lanes.find((lane) => (pr ? lane.prUrl === pr.html_url : lane.headSha === head));
    const candidates = [goal.integration?.prUrl, goal.integration?.revertPrUrl, archive?.prUrl].filter(Boolean);
    const checks = object(payload.check_run) ? payload.check_run : object(payload.check_suite) ? payload.check_suite : undefined;
    const referenced = Array.isArray(checks?.pull_requests) ? checks.pull_requests.flatMap((item) => object(item) && Number.isSafeInteger(item.number) && Number(item.number) > 0 ? [`https://github.com/${repository}/pull/${item.number}`] : []) : [];
    const observed = [...scheduler?.events ?? []].reverse().find((event) => "headSha" in event && event.headSha === head && "prUrl" in event && candidates.includes(event.prUrl));
    const prUrl = pr?.html_url ?? lane?.prUrl ?? referenced.find((url) => candidates.includes(url)) ?? (observed && "prUrl" in observed ? observed.prUrl : undefined) ?? (archive?.gate?.headSha === head ? archive.prUrl : record?.report?.headSha === head ? goal.integration?.prUrl : undefined);
    if (!url(prUrl) || (!lane && !candidates.includes(prUrl as string))) continue;
    const at = new Date().toISOString(); const common = { id: `github:${delivery}:${goal.id}`, teamId: goal.teamId, goalId: goal.id, at, laneId: lane?.id ?? null, prUrl: prUrl as string, headSha: head };
    if (pr && kind === "pull_request" && pr.merged === true && sha(pr.merge_commit_sha)) events.push({ ...common, kind: "merge", mergedSha: pr.merge_commit_sha });
    else if (kind === "pull_request_review" && object(payload.review) && object(payload.review.user) && text(payload.review.user.login)) {
      const verdict = String(payload.review.state).toLowerCase().replace("_", "-");
      if (["approved", "changes-requested", "dismissed"].includes(verdict)) events.push({ ...common, kind: "review", reviewer: payload.review.user.login, state: verdict as "approved", findings: [] });
    } else events.push({ ...common, kind: "ci", state: "pending" });
  }
  return events;
}

export function verifyWebhook(secret: string, signature: unknown, bytes: Buffer): boolean {
  if (!secret || typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature.slice(7), "hex"), createHmac("sha256", secret).update(bytes).digest());
}
export function webhookHandler(store: PlanningStore, inbox: WorkflowInbox, secret: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== "POST" || request.url !== "/indra/github") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1_000_000) { response.writeHead(413).end(); return; } chunks.push(bytes); }
      const bytes = Buffer.concat(chunks);
      if (!verifyWebhook(secret, request.headers["x-hub-signature-256"], bytes)) { response.writeHead(401).end(); return; }
      const events = await githubEvents(store, String(request.headers["x-github-delivery"] ?? ""), String(request.headers["x-github-event"] ?? ""), JSON.parse(bytes.toString("utf8")));
      for (const event of events) await inbox.publish(event);
      response.writeHead(202).end();
    } catch { response.writeHead(400).end(); }
  };
}

export interface WorkflowHostOptions {
  store: PlanningStore; teamId: string; consumer: string; turn(event: WorkflowEvent): Promise<void>; signal?: AbortSignal;
  /** Only the bridge owns external ingress. The secret is read from 1Password into memory by cli.ts. */
  mattermost?: { server: string; token: string; channelId: string };
  github?: { port: number; secret: string };
  onReady?(): Promise<void>;
}

/** Socket/file events drive finite turns. Disconnects fail visibly; there is no timer/reconnect/poll fallback. */
export async function runWorkflowHost(options: WorkflowHostOptions): Promise<void> {
  const { store, teamId, consumer } = options; const inbox = new WorkflowInbox(store.runtimeDir);
  await mkdir(inbox.directory, { recursive: true, mode: 0o700 });
  const watchers: FSWatcher[] = []; let socket: WebSocket | undefined; let authenticated = Promise.resolve();
  const server = options.github ? createServer(webhookHandler(store, inbox, options.github.secret)) : undefined;
  let queue = Promise.resolve(); let fail!: (error: Error) => void; let finish!: () => void;
  const ended = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  void ended.catch(() => {}); // A socket can fail while the finite startup turn is still finishing.
  const drain = () => { queue = queue.then(() => inbox.drain(consumer, teamId, options.turn)); void queue.catch(() => fail(new Error("Workflow event processing failed; restart to reconcile the retained delivery."))); };
  const wake = async (source: string, value: unknown) => { await inbox.publish({ kind: "queue-changed", id: `${source}:${teamId}:${workflowDigest(value)}`, teamId, at: "1970-01-01T00:00:00.000Z" }); };
  const abort = () => finish(); options.signal?.addEventListener("abort", abort, { once: true });
  try {
    watchers.push(watch(inbox.directory, (_event, name) => { if (name?.toString().endsWith(".json")) drain(); }));
    if (options.mattermost) {
      watchers.push(watch(store.checkout, (_event, name) => { if (name?.toString() === "state.json") void readFile(join(store.checkout, "state.json"), "utf8").then((bytes) => wake("state", bytes)).catch(() => fail(new Error("Workflow state delivery failed."))); }));
      // Readiness/update receipts have a distinct watch from the Scheduler's own runtime journals.
      watchers.push(watch(store.runtimeDir, (_event, name) => { if (/^(?:self-update|update-status|host-ready-)/.test(name?.toString() ?? "")) void readFile(join(store.runtimeDir, name!.toString()), "utf8").then((bytes) => wake("build", bytes)).catch(() => {}); }));
      const builds = join(store.runtimeDir, "builds-in-use"); await mkdir(builds, { recursive: true, mode: 0o700 });
      watchers.push(watch(builds, (_event, name) => { if (name?.toString().endsWith(".json")) void readFile(join(builds, name.toString()), "utf8").then((bytes) => wake("running", bytes)).catch(() => {}); }));
      const connection = new URL("/api/v4/websocket", options.mattermost.server); need(connection.protocol === "https:"); connection.protocol = "wss:";
      socket = new WebSocket(connection);
      let accept!: () => void;
      authenticated = new Promise<void>((resolve) => { accept = resolve; });
      socket.addEventListener("open", () => socket!.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: options.mattermost!.token } })));
      socket.addEventListener("message", (message) => {
        try {
          const frame: unknown = JSON.parse(String(message.data));
          if (!object(frame)) return;
          if (frame.seq_reply === 1 && frame.status === "OK") { accept(); return; }
          if (frame.status === "FAIL") { fail(new Error("Mattermost WebSocket authentication failed.")); return; }
          if (!["posted", "post_edited", "reaction_added", "reaction_removed"].includes(String(frame.event))) return;
          if (!object(frame.broadcast) || frame.broadcast.channel_id !== options.mattermost!.channelId) return;
          void wake("mattermost", frame).catch(() => fail(new Error("Mattermost event delivery failed.")));
        } catch { fail(new Error("Unreadable Mattermost event.")); }
      });
      socket.addEventListener("error", () => fail(new Error("Mattermost WebSocket unavailable; restore connectivity and restart the event host.")));
      socket.addEventListener("close", () => { if (!options.signal?.aborted) fail(new Error("Mattermost WebSocket disconnected; restart to reconcile current reactions and posts.")); });
    }
    if (server) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.github!.port, "127.0.0.1", resolve); });
    await Promise.race([authenticated, ended]);
    if (options.signal?.aborted) return;
    await options.turn({ kind: "startup", teamId, at: new Date().toISOString() });
    await inbox.drain(consumer, teamId, options.turn); await options.onReady?.();
    if (options.signal?.aborted) finish();
    await ended;
  } finally {
    options.signal?.removeEventListener("abort", abort); watchers.forEach((watcher) => watcher.close()); socket?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await queue.catch(() => {});
  }
}
