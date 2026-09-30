import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, MessageOptions, WriteAccess } from "../src/codex-runtime.js";
import type { CeremonyAdapters, PlanningChat } from "../src/planning-bridge.js";
import { processShell, type RuntimeFactory } from "../src/developer-seat.js";
import { createPlanningBridge, createPlanningStore, developerEventTurn, main, parseOptions, uiWorkflowEvents, workflowDelivery } from "../src/cli.js";
import { CircuitBudget, CircuitOpenError } from "../src/circuit-budget.js";
import { withCircuitScope } from "../src/circuit-scope.js";
import { SprintGitHub } from "../src/sprint.js";
import { PlanningStore } from "../src/planning.js";
import { loadSeatPersonas, type SeatPersona } from "../src/seat-persona.js";
import { WorkflowInbox, runWorkflowHost, type WorkflowHostOptions } from "../src/remodel-events.js";
import { ProductSeat } from "../src/product-seat.js";
import * as projectCheckouts from "../src/project-checkout.js";
import * as op from "../src/op-env.js";
import type { WorkflowEvent } from "../src/goal-contract.js";

const fakes = vi.hoisted(() => ({
  calls: [] as { engine: string; cwd: string; timeout?: number; write?: WriteAccess; home?: string; roles?: readonly string[]; prompt: string; schema: string; session?: string; options?: MessageOptions }[],
  posts: [] as { username: string; channel: string; message: string; root?: string; delivery?: string }[],
  actions: [] as string[],
  adapters: [] as CeremonyAdapters[],
  token: vi.fn(async () => "test-bot-token"),
  request: vi.fn(async () => ({ goal: { id: "goal-1" }, alreadyRequested: false })),
  resume: undefined as string | undefined,
  hosts: [] as WorkflowHostOptions[],
}));
function fakeRuntime(engine: string) {
  return class implements AgentRuntime {
    // The fourth argument is Codex's harness home, or Claude's seat roles.
    constructor(private cwd: string, private timeout?: number, private write?: WriteAccess, private fourth?: string | readonly string[]) {}
    async message(prompt: string, schema: string, session?: string, options?: MessageOptions) {
      const home = engine === "codex" ? this.fourth as string | undefined : undefined;
      const roles = engine === "claude" ? this.fourth as readonly string[] | undefined : undefined;
      fakes.calls.push({ engine, cwd: this.cwd, timeout: this.timeout, write: this.write, home, roles, prompt, schema, session, options });
      return { sessionId: session ?? (engine === "claude" ? "claude:12345678-1234-4321-8765-123456789abc" : "codex-new"), response: {}, startedAt: "start", finishedAt: "finish" };
    }
  };
}
vi.mock("../src/codex-runtime.js", async (original) => ({ ...await original<typeof import("../src/codex-runtime.js")>(), CodexRuntime: fakeRuntime("codex") }));
vi.mock("../src/claude-runtime.js", async (original) => ({ ...await original<typeof import("../src/claude-runtime.js")>(), ClaudeRuntime: fakeRuntime("claude") }));
vi.mock("../src/seat-persona.js", async (original) => ({ ...await original<typeof import("../src/seat-persona.js")>(), loadSeatPersonas: vi.fn(async () => ({})) }));
vi.mock("../src/service-account.js", () => ({ opCredential: vi.fn(async () => ({})), stageServiceToken: vi.fn() }));
vi.mock("../src/remodel-events.js", async (original) => ({ ...await original<typeof import("../src/remodel-events.js")>(), runWorkflowHost: vi.fn(async (options: WorkflowHostOptions) => { fakes.hosts.push(options); await options.turn({ kind: "startup", teamId: options.teamId, at: "2026-09-01T00:00:00Z" }); await options.onReady?.(); }) }));
vi.mock("../src/self-update.js", async (original) => ({ ...await original<typeof import("../src/self-update.js")>(), recordRunningBuild: vi.fn(), SelfUpdater: vi.fn() }));
vi.mock("../src/state-commit.js", async (original) => ({ ...await original<typeof import("../src/state-commit.js")>(), withFileLock: async (_path: string, run: () => Promise<unknown>) => run() }));
vi.mock("../src/planning-mattermost.js", async (original) => ({
  ...await original<typeof import("../src/planning-mattermost.js")>(),
  readBotToken: fakes.token, readChickToken: fakes.token,
  MattermostPlanningChat: class {
    constructor(_token: string, private username: string) {}
    async ensureHomeMembership() {}
    async post(channel: string, message: string, root?: string, delivery?: string) {
      fakes.posts.push({ username: this.username, channel, message, root, delivery });
      return { id: "post", channel_id: channel, message, root_id: root ?? "", user_id: this.username, create_at: 1 };
    }
  },
}));
vi.mock("../src/planning-bridge.js", () => ({
  PlanningBridge: class {
    static requestProposal = fakes.request;
    constructor(_store: PlanningStore, private chat: PlanningChat, private runtime: AgentRuntime, _maxQueue?: number, _shell?: unknown, adapters: CeremonyAdapters = {}) { fakes.adapters.push(adapters); }
    async exercise(action: string) {
      fakes.actions.push(action);
      await this.runtime.message("Human approval is required. Do not execute work.", "brief-schema", fakes.resume, { timeoutMs: 1234 });
      await this.chat.post("home", "No work has been approved or executed.", "root-id", "delivery-id");
    }
    async start() { await this.exercise("start"); return { id: "goal-1", mattermost: { rootPostId: "root-id" } }; }
    async approve() { await this.exercise("approve"); return { goal: { id: "goal-1", assignments: [] }, alreadyApproved: false }; }
    async integrate() { await this.exercise("integrate"); return "Integrated"; }
    async merge() { await this.exercise("merge"); return "Merged"; }
    async rollback() { await this.exercise("rollback"); return "Reverted"; }
    async poll() { await this.exercise("serve"); throw new Error("End fake server loop"); }
    async dispatch(event: WorkflowEvent) { fakes.actions.push(`scheduler-${event.kind}`); return { record: { failure: null }, events: [] }; }
    async consumers() { return []; }
  },
}));
vi.mock("../src/developer-seat.js", async (original) => ({
  ...await original<typeof import("../src/developer-seat.js")>(),
  DeveloperSeat: class {
    constructor(_store: PlanningStore, _seat: unknown, private chat: PlanningChat, _shell: unknown, private runtimeFor: RuntimeFactory) {}
    async tick() {
      for (const [prompt, write] of [["Build. Do not merge.", { extraDirs: ["/shared.git"] }], ["Review. Do not edit or post.", undefined], ["Fix. Do not merge.", { extraDirs: ["/shared.git"] }]] as const) {
        await this.runtimeFor("/assignment-worktree", write as WriteAccess | undefined).message(prompt, "developer-schema");
      }
      await this.chat.post("home", "Opened PR. Starting a fresh review.", "goal-root");
      throw new Error("End fake seat loop");
    }
  },
}));
const chick: SeatPersona = { voice: "Curious", background: "Band leader", funFact: "Chick fact" };
const developer: SeatPersona = { voice: "Direct", background: "Keyboardist", funFact: "Developer fact" };
let checkout: string;
beforeEach(async () => {
  checkout = join(await mkdtemp(join(tmpdir(), "indra-engine-cli-")), "state"); await mkdir(`${checkout}.runtime`);
  fakes.calls.length = 0; fakes.posts.length = 0; fakes.actions.length = 0; fakes.adapters.length = 0; fakes.resume = undefined; fakes.token.mockClear(); fakes.request.mockClear();
  fakes.hosts.length = 0;
  vi.mocked(loadSeatPersonas).mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(PlanningStore.prototype, "read").mockResolvedValue({ $schema: "schema", schemaVersion: 1, sprints: [], teams: [{ id: "team-001", slug: "yahaha", externalIdentities: { mattermost: { teamId: "team", homeChannelId: "home" } }, seats: [
    { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { username: "chickcorea", userId: "chick-id" } } },
    { id: "seat-dev", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { username: "developer", userId: "developer-id" } } },
  ] }] });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(join(checkout, ".."), { recursive: true, force: true }); });
const configure = (value: unknown) => writeFile(join(`${checkout}.runtime`, "seat-engines.json"), JSON.stringify(value));
const planning = (action: string) => main(["planning", action, ...(action === "serve" ? [] : ["--goal", "goal-1"]), "--state", checkout]);

describe("goals-v1 production event wiring", () => {
  it("queues Product recovery for the configured seat without a goal, credentials or state writes", async () => {
    const state = await new PlanningStore(checkout).read();
    const team = state.teams[0] as { workflowModel?: string; seats: { id: string; roles: string[] }[] };
    team.workflowModel = "goals-v1"; team.seats.find((seat) => seat.id === "seat-dev")!.roles = ["Product"];
    const before = structuredClone(state); const writes = vi.spyOn(PlanningStore.prototype, "publishProductProposal");
    expect(await main(["planning", "retry", "--seat", "seat-dev", "--state", checkout])).toBe(0);
    const events: WorkflowEvent[] = []; await new WorkflowInbox(`${checkout}.runtime`).drain("seat-dev", "team-001", async (event) => { events.push(event); });
    expect(events).toMatchObject([{ kind: "product-retry", teamId: "team-001", seatId: "seat-dev", reason: expect.any(String) }]);
    expect(events[0]).not.toHaveProperty("goalId"); expect(state).toEqual(before); expect(writes).not.toHaveBeenCalled();
    expect(fakes.calls).toEqual([]); expect(fakes.posts).toEqual([]); expect(fakes.token).not.toHaveBeenCalled();
  });
  it.each(["missing", "developer", "team-lead", "legacy", "mixed"])("rejects a %s Product retry target without publishing an event", async (target) => {
    const state = await new PlanningStore(checkout).read();
    const team = state.teams[0] as { workflowModel?: string; seats: { id: string; roles: string[] }[] };
    team.workflowModel = target === "legacy" ? undefined : "goals-v1";
    if (target === "legacy" || target === "mixed") team.seats[1].roles = target === "mixed" ? ["Product", "Developer"] : ["Product"];
    const seat = target === "missing" ? "seat-missing" : target === "team-lead" ? "seat-lead" : "seat-dev";
    expect(await main(["planning", "retry", "--seat", seat, "--state", checkout])).toBe(1);
    const turn = vi.fn(async () => {}); await new WorkflowInbox(`${checkout}.runtime`).drain("seat-dev", "team-001", turn);
    expect(turn).not.toHaveBeenCalled(); expect(fakes.token).not.toHaveBeenCalled(); expect(fakes.calls).toEqual([]);
  });
  it("requires exactly one retry target and limits seat targeting to retry", () => {
    expect(parseOptions(["planning", "retry", "--goal", "goal-one", "--state", checkout])).toMatchObject({ action: "retry", goal: "goal-one" });
    for (const args of [["planning", "retry"], ["planning", "retry", "--goal", "goal-one", "--seat", "seat-dev"], ["planning", "retry", "--seat", "seat-dev", "--seat", "seat-dev"], ["planning", "approve", "--seat", "seat-dev"]]) expect(() => parseOptions(args)).toThrow("Usage:");
  });
  it.each(["codex", "claude"])("adapts Product's %s runtime factory without confusing write capability and timeout", async (engine) => {
    const state = await new PlanningStore(checkout).read();
    const team = state.teams[0] as { workflowModel?: string; project?: { github: string }; seats: { id: string; roles: string[] }[] };
    team.workflowModel = "goals-v1"; team.project = { github: "test/product-project" }; team.seats.find((seat) => seat.id === "seat-dev")!.roles = ["Product"];
    await configure({ "seat-dev": engine });
    const project = join(`${checkout}.runtime`, "projects", "test-product-project");
    const clone = vi.spyOn(projectCheckouts, "ensureProjectCheckout").mockResolvedValue(project);
    const write: WriteAccess = { extraDirs: ["/shared.git"] }; const options = { timeoutMs: 2345 };
    vi.spyOn(ProductSeat.prototype, "turn").mockImplementation(async function (this: ProductSeat, event) {
      expect(event).toMatchObject({ kind: "startup", teamId: "team-001" });
      await this.services.runtime.message("Default read-only runtime.", "product-schema", undefined, options);
      await this.services.runtimeFor!(project).message("Explicit read-only runtime.", "product-schema", undefined, options);
      await this.services.runtimeFor!(project, write).message("Factory capability probe.", "product-schema", undefined, options);
      return { status: "idle", proposalIds: [] };
    });
    expect(await main(["seat", "run", "--seat", "seat-dev", "--state", checkout])).toBe(0);
    expect(clone).toHaveBeenCalledExactlyOnceWith(processShell, `${checkout}.runtime`, "test/product-project");
    expect(fakes.calls).toHaveLength(3);
    expect(fakes.calls.map((call) => call.write)).toEqual([undefined, undefined, write]);
    for (const call of fakes.calls) expect(call).toMatchObject({ engine, cwd: project, timeout: undefined, options, session: undefined });
    expect(fakes.hosts[0]).toMatchObject({ teamId: "team-001", consumer: "seat-dev" });
  });
  it("omits event ingress for an entirely historical UI and joins every enabled host on abort", async () => {
    const store = new PlanningStore(checkout); const onEvent = vi.fn(async () => {});
    expect(uiWorkflowEvents(store, [])).toBeUndefined(); expect(fakes.hosts).toEqual([]);
    const stopped: string[] = [];
    vi.mocked(runWorkflowHost).mockImplementationOnce(async (options) => {
      fakes.hosts.push(options); await new Promise<void>((done) => options.signal!.addEventListener("abort", () => { stopped.push(options.teamId); done(); }, { once: true }));
    }).mockImplementationOnce(async (options) => {
      fakes.hosts.push(options); await new Promise<void>((done) => options.signal!.addEventListener("abort", () => { stopped.push(options.teamId); done(); }, { once: true }));
    });
    const controller = new AbortController(); let ended = false;
    const run = uiWorkflowEvents(store, ["team-001", "team-other"])!(onEvent, controller.signal).then(() => { ended = true; });
    expect(fakes.hosts.map((host) => host.consumer)).toEqual(["ui-team-001", "ui-team-other"]); expect(ended).toBe(false);
    controller.abort(); await run; expect(stopped).toEqual(["team-001", "team-other"]); expect(ended).toBe(true);
  });
  it("uses the finite Developer capability and fails honestly when that lane is unavailable", async () => {
    const event: WorkflowEvent = { kind: "startup", teamId: "team-001", at: "2026-09-01T00:00:00Z" };
    const tick = vi.fn(async () => "idle"); await expect(developerEventTurn({ tick }, event)).rejects.toThrow("unavailable"); expect(tick).not.toHaveBeenCalled();
    const turn = vi.fn(async () => ({ events: [], report: null })); expect(await developerEventTurn({ turn, tick }, event)).toEqual({ events: [], report: null });
    expect(turn).toHaveBeenCalledExactlyOnceWith(event); expect(tick).not.toHaveBeenCalled();
  });
  it("requires an explicit non-secret delivery configuration and reads the secret through op only at startup", async () => {
    const store = new PlanningStore(checkout); const read = vi.spyOn(op, "opRead").mockResolvedValue("fixture-secret");
    await expect(workflowDelivery(store)).rejects.toThrow("Configure workflow-delivery.json"); expect(read).not.toHaveBeenCalled();
    await store.saveRuntime("workflow-delivery", { version: 1, port: 9781, secretRef: "op://fixture/webhook/secret" });
    expect(await workflowDelivery(store)).toEqual({ port: 9781, secret: "fixture-secret" }); expect(read).toHaveBeenCalledExactlyOnceWith("op://fixture/webhook/secret", {});
    await store.saveRuntime("workflow-delivery", { version: 1, port: 9781, secret: "never-configure-a-raw-secret" });
    await expect(workflowDelivery(store)).rejects.toThrow("Configure workflow-delivery.json"); expect(read).toHaveBeenCalledTimes(1);
  });
  it("routes enabled planning serve through external ingress and a finite startup turn instead of the legacy poll", async () => {
    const state = await new PlanningStore(checkout).read(); const team = state.teams[0] as { workflowModel?: string; project?: { github: string } }; team.workflowModel = "goals-v1"; team.project = { github: "test/project" };
    vi.mocked(PlanningStore.prototype.read).mockResolvedValue(state);
    await new PlanningStore(checkout).saveRuntime("workflow-delivery", { version: 1, port: 9781, secretRef: "op://fixture/webhook/secret" });
    vi.spyOn(op, "opRead").mockResolvedValue("fixture-webhook-secret");
    expect(await planning("serve")).toBe(0);
    expect(fakes.actions).toEqual(["scheduler-startup"]);
    expect(fakes.hosts).toHaveLength(1);
    expect(fakes.hosts[0]).toMatchObject({ teamId: "team-001", consumer: "scheduler-team-001", mattermost: { channelId: "home", token: "test-bot-token" }, github: { port: 9781, secret: "fixture-webhook-secret" } });
    expect(fakes.hosts[0].consumers).toBeTypeOf("function"); expect(fakes.hosts[0].activity).toBeTypeOf("function");
    expect(fakes.calls).toEqual([]);
    expect(runWorkflowHost).toHaveBeenCalled();
  });
});

describe("every CLI runtime/chat construction path", () => {
  it.each(["start", "serve", "approve", "integrate", "merge", "rollback"])("routes planning %s through Chick's state ID and both decorators", async (action) => {
    await configure({ "seat-lead": "claude", "seat-dev": "codex" });
    vi.mocked(loadSeatPersonas).mockResolvedValue({ "seat-lead": chick, "seat-dev": developer });
    await planning(action);
    expect(fakes.actions).toEqual([action]); expect(fakes.calls).toHaveLength(1);
    expect(fakes.calls[0]).toMatchObject({ engine: "claude", prompt: expect.stringContaining(chick.voice), schema: "brief-schema", session: undefined, options: { timeoutMs: 1234 } });
    expect(fakes.calls[0].prompt).toContain("Human approval is required. Do not execute work.");
    expect(fakes.posts).toEqual([{ username: "chickcorea", channel: "home", root: "root-id", delivery: "delivery-id", message: expect.stringContaining(chick.funFact) }]);
    expect(fakes.posts[0].message).toMatch(/^No work has been approved or executed\./);
  });

  it("preserves Codex defaults and exact prompt/post text without profiles", async () => {
    expect(await planning("start")).toBe(0);
    expect(fakes.calls[0]).toMatchObject({ engine: "codex", prompt: "Human approval is required. Do not execute work." });
    expect(fakes.posts[0].message).toBe("No work has been approved or executed.");
  });

  it("selects the exact Developer ID and Chick's Yahaha ID when bots also belong to another team", async () => {
    const state = await new PlanningStore(checkout).read();
    state.teams.unshift({ slug: "another-team", seats: [
      { id: "seat-other-lead", externalIdentities: { mattermost: { username: "chickcorea" } } },
      { id: "seat-other-dev", externalIdentities: { mattermost: { username: "developer" } } },
    ] });
    await configure({ "seat-other-lead": "codex", "seat-other-dev": "codex", "seat-lead": "claude", "seat-dev": "claude" });
    vi.mocked(loadSeatPersonas).mockResolvedValue({ "seat-lead": chick, "seat-dev": developer });
    await planning("start");
    expect(fakes.calls[0]).toMatchObject({ engine: "claude", prompt: expect.stringContaining(chick.voice) });
    await main(["seat", "run", "--seat", "seat-dev", "--state", checkout]);
    expect(fakes.calls.slice(1)).toHaveLength(3);
    for (const call of fakes.calls.slice(1)) expect(call).toMatchObject({ engine: "claude", prompt: expect.stringContaining(developer.voice) });
  });

  it.each([["claude", "legacy-session", "codex"], ["codex", "claude:12345678-1234-4321-8765-123456789abc", "claude"]])("keeps a saved Chick session on its engine after selection changes to %s", async (selected, handle, expected) => {
    await configure({ "seat-lead": selected }); fakes.resume = handle;
    await planning("serve"); expect(fakes.calls[0]).toMatchObject({ engine: expected, session: handle });
  });

  it.each(["claude", "codex"])("uses %s for Developer build/review/fix with fresh sessions and the original write boundaries", async (engine) => {
    await configure({ "seat-lead": engine === "claude" ? "codex" : "claude", "seat-dev": engine });
    vi.mocked(loadSeatPersonas).mockResolvedValue({ "seat-dev": developer });
    await main(["seat", "run", "--seat", "seat-dev", "--state", checkout]);
    expect(fakes.calls).toHaveLength(3);
    expect(fakes.calls.map((call) => call.engine)).toEqual([engine, engine, engine]);
    expect(fakes.calls.map((call) => call.session)).toEqual([undefined, undefined, undefined]);
    expect(fakes.calls.map((call) => call.write)).toEqual([{ extraDirs: ["/shared.git"] }, undefined, { extraDirs: ["/shared.git"] }]);
    for (const call of fakes.calls) expect(call).toMatchObject({ cwd: "/assignment-worktree", timeout: 60 * 60_000, prompt: expect.stringContaining(developer.voice) });
    expect(fakes.posts[0]).toMatchObject({ username: "developer", channel: "home", root: "goal-root", delivery: undefined, message: expect.stringContaining(developer.funFact) });
  });

  it("gives each seat's Codex runs its own harness home under the runtime directory, and Claude none", async () => {
    await configure({ "seat-lead": "codex", "seat-dev": "claude" });
    await planning("start");
    expect(fakes.calls[0]).toMatchObject({ engine: "codex", home: join(`${checkout}.runtime`, "harness", "seat-lead", "codex") });
    await configure({ "seat-lead": "codex", "seat-dev": "codex" });
    await main(["seat", "run", "--seat", "seat-dev", "--state", checkout]);
    for (const call of fakes.calls.slice(1)) expect(call.home).toBe(join(`${checkout}.runtime`, "harness", "seat-dev", "codex"));
    await configure({ "seat-lead": "claude" }); fakes.calls.length = 0;
    await planning("start");
    // Claude gets no harness home, but it does get the seat's roles from state, which pick its effort.
    expect(fakes.calls[0]).toMatchObject({ engine: "claude", home: undefined, roles: ["Team Lead"] });
  });

  it("surfaces invalid config before reading a token or constructing a model/chat", async () => {
    await configure({ "seat-lead": "invalid" });
    expect(await planning("start")).toBe(1); expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid seat-engines.json"));
    expect(fakes.calls).toEqual([]); expect(fakes.posts).toEqual([]); expect(fakes.token).not.toHaveBeenCalled();
  });

  it("keeps propose independent of credentials, runtime configuration and model calls", async () => {
    await configure({ "seat-lead": "invalid" });
    expect(await planning("propose")).toBe(0); expect(fakes.request).toHaveBeenCalledTimes(1);
    expect(fakes.token).not.toHaveBeenCalled(); expect(fakes.calls).toEqual([]); expect(fakes.posts).toEqual([]);
  });

  it("discovers optional adapters without changing the CLI's seat runtime", async () => {
    const store = new PlanningStore(checkout);
    const runtime = new (fakeRuntime("codex"))("/project");
    const release = { poll: vi.fn(async () => ({ status: "pending" as const, reason: "Waiting for reload" })) };
    const factory = vi.fn(async (services: { store: PlanningStore; runtime: AgentRuntime }) => {
      expect(services.store).toBe(store);
      expect(services.runtime).toBe(runtime);
      return { release };
    });
    await createPlanningBridge(store, {} as PlanningChat, runtime, { "./release-activation.ts": { createCeremonyAdapters: factory } });
    expect(factory).toHaveBeenCalledOnce();
    expect(fakes.adapters).toEqual([{ release }]);
    expect(release.poll).not.toHaveBeenCalled();
  });

  it("leaves absent adapters pending and rejects duplicate ownership", async () => {
    const store = new PlanningStore(checkout);
    const runtime = new (fakeRuntime("codex"))("/project");
    await createPlanningBridge(store, {} as PlanningChat, runtime, {});
    expect(fakes.adapters).toEqual([{}]);
    const module = { createCeremonyAdapters: () => ({ release: { poll: async () => ({ status: "pending" as const, reason: "Reload" }) } }) };
    await expect(createPlanningBridge(store, {} as PlanningChat, runtime, { a: module, b: module })).rejects.toThrow("Multiple ceremony adapters");
  });

  it("refuses incomplete rollout declarations before any posting or model invocation", () => {
    expect(() => createPlanningStore(checkout, { adapter: { ceremonyReadiness: { version: 1, consumers: { planning: 1 } } as never } })).toThrow("all consumers");
    expect(fakes.posts).toEqual([]);
    expect(fakes.calls).toEqual([]);
  });


  it("connects the release reader only after exact-head bot approval and green CI, retaining verified descendant evidence", async () => {
    const store = new PlanningStore(checkout);
    const runtime = new (fakeRuntime("codex"))("/project");
    const mergedSha = "a".repeat(40); const runningSha = "b".repeat(40);
    const read = vi.fn(async () => ({ status: "running" as const, reason: "Ready", evidence: { mergedSha, buildSha: runningSha, runningSha, runningAt: new Date().toISOString() } }));
    const proof = vi.spyOn(SprintGitHub.prototype, "mergeVerification").mockResolvedValue(undefined);
    await createPlanningBridge(store, {} as PlanningChat, runtime, { release: { LocalReleaseActivationReader: class { read = read; } } });
    const adapter = fakes.adapters[0].release!;
    const context: Parameters<typeof adapter.poll>[0] = { store, runtime, post: async () => "post", recordRun: async () => {}, recordSession: async () => {}, goal: {
      id: "goal-one", teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "Goal", projectRefs: ["test/project"], stage: "approved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] },
      integration: { branch: "sprint/goal-one", baseSha: mergedSha, status: "merged", prUrl: "https://github.com/test/project/pull/1", mergedSha },
    } };
    expect(await adapter.poll(context)).toMatchObject({ status: "pending" });
    expect(proof).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    proof.mockResolvedValue({ headSha: mergedSha, reviewCommitSha: mergedSha, reviewer: "satori-miyamoto", checksPassed: true });
    expect(await adapter.poll(context)).toMatchObject({ status: "complete", evidence: { mergedSha, buildSha: runningSha, runningSha, mergeVerification: { reviewer: "satori-miyamoto", headSha: mergedSha }, ancestry: { ancestorSha: mergedSha, descendantSha: runningSha, verified: true } } });
    expect(read).toHaveBeenCalledWith(context.goal.integration);
  });

});


it("bounds release merge-verification commands and propagates the circuit trip", async () => {
  const store = new PlanningStore(checkout);
  await writeFile(join(store.runtimeDir, "circuit-policy.json"), JSON.stringify({ maxInvocationMs: 20 }));
  const runtime = new (fakeRuntime("codex"))("/project");
  const read = vi.fn(async () => ({ status: "unavailable" as const, reason: "Not reached" }));
  await createPlanningBridge(store, {} as PlanningChat, runtime, { release: { LocalReleaseActivationReader: class { read = read; } } });
  let signal: AbortSignal | undefined;
  vi.spyOn(processShell, "run").mockImplementation(async (_command, _args, _cwd, options) => {
    signal = options?.signal;
    if (!signal) throw new Error("Missing circuit signal");
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const adapter = fakes.adapters[0].release!;
  const context: Parameters<typeof adapter.poll>[0] = { store, runtime, post: async () => "post", recordRun: async () => {}, recordSession: async () => {}, goal: {
    id: "goal-release", teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "Goal", projectRefs: ["test/project"], stage: "approved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] },
    integration: { branch: "sprint/goal-release", baseSha: "a".repeat(40), status: "merged", prUrl: "https://github.com/test/project/pull/1", mergedSha: "a".repeat(40) },
  } };
  await expect(withCircuitScope(store.runtimeDir, "goal-release", "release", () => adapter.poll(context))).rejects.toBeInstanceOf(CircuitOpenError);
  expect(signal?.aborted).toBe(true); expect(read).not.toHaveBeenCalled();
  expect((await new CircuitBudget({ runtimeDir: store.runtimeDir, scopeId: "goal-release" }).status()).trip).toBeDefined();
});
