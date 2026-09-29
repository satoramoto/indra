import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, MessageOptions, WriteAccess } from "../src/codex-runtime.js";
import type { CeremonyAdapters, PlanningChat } from "../src/planning-bridge.js";
import { processShell, type RuntimeFactory } from "../src/developer-seat.js";
import { createPlanningBridge, createPlanningStore, main } from "../src/cli.js";
import { PlanningStore } from "../src/planning.js";
import { loadSeatPersonas, type SeatPersona } from "../src/seat-persona.js";

const fakes = vi.hoisted(() => ({
  calls: [] as { engine: string; cwd: string; timeout?: number; write?: WriteAccess; home?: string; roles?: readonly string[]; prompt: string; schema: string; session?: string; options?: MessageOptions }[],
  posts: [] as { username: string; channel: string; message: string; root?: string; delivery?: string }[],
  actions: [] as string[],
  adapters: [] as CeremonyAdapters[],
  token: vi.fn(async () => "test-bot-token"),
  request: vi.fn(async () => ({ goal: { id: "goal-1" }, alreadyRequested: false })),
  resume: undefined as string | undefined,
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


  it("connects the release reader only after merge approval and green CI, retaining verified descendant evidence", async () => {
    const store = new PlanningStore(checkout);
    const runtime = new (fakeRuntime("codex"))("/project");
    const mergedSha = "a".repeat(40); const runningSha = "b".repeat(40);
    const read = vi.fn(async () => ({ status: "running" as const, reason: "Ready", evidence: { mergedSha, buildSha: runningSha, runningSha, runningAt: new Date().toISOString() } }));
    const shell = vi.spyOn(processShell, "run").mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    await createPlanningBridge(store, {} as PlanningChat, runtime, { release: { LocalReleaseActivationReader: class { read = read; } } });
    const adapter = fakes.adapters[0].release!;
    const context: Parameters<typeof adapter.poll>[0] = { store, runtime, post: async () => "post", recordRun: async () => {}, recordSession: async () => {}, goal: {
      id: "goal-one", teamId: "team-one", seatId: "seat-one", participantSeatIds: [], goal: "Goal", projectRefs: ["test/project"], stage: "approved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      mattermost: { channelId: "home", rootPostId: "root" }, brief: { summary: "Goal", decisions: [], openQuestions: [] },
      integration: { branch: "sprint/goal-one", baseSha: mergedSha, status: "merged", prUrl: "https://github.com/test/project/pull/1", mergedSha },
    } };
    expect(await adapter.poll(context)).toMatchObject({ status: "pending" });
    expect(shell).not.toHaveBeenCalled();
    context.mergeApproval = { postId: "merge-post", approval: { source: "owner-command", command: "planning merge", at: new Date().toISOString() } };
    expect(await adapter.poll(context)).toMatchObject({ status: "pending" });
    expect(read).not.toHaveBeenCalled();
    shell.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    expect(await adapter.poll(context)).toMatchObject({ status: "complete", evidence: { mergedSha, buildSha: runningSha, runningSha, mergePostId: "merge-post", ancestry: { ancestorSha: mergedSha, descendantSha: runningSha, verified: true } } });
    expect(read).toHaveBeenCalledWith(context.goal.integration);
  });

});
