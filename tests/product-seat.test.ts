import { accountedFailure } from "./circuit-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// These integration cases exercise durable accounting plus real Git/process supervision.
vi.setConfig({ testTimeout: 20_000 });
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { WorkflowInbox, runWorkflowHost } from "../src/remodel-events.js";
import { ProductSeat, loadProductSeat } from "../src/product-seat.js";
import { productJournalFilename, productProposalDigest, type ProductChat } from "../src/product-proposals.js";
import { productRuntimeFilename, type ProductProposal, type ProductRuntimeRecord, type WorkflowEvent } from "../src/goal-contract.js";
import { PlanningStore } from "../src/planning.js";
import { MattermostPlanningChat } from "../src/planning-mattermost.js";
import { processShell, type Shell, type ShellResult } from "../src/command-shell.js";
import type { AgentRuntime, WriteAccess } from "../src/codex-runtime.js";
import { loadSeatPersonas, withPersonaChat } from "../src/seat-persona.js";
import type { Post } from "../src/planning-bridge.js";
import type { ProductSourceRevision } from "../src/product-source-snapshot.js";
import { stateCheckout, git } from "./state-checkout.js";

vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const teamId = "team-one"; const seatId = "seat-002"; const github = "fixture/product-project";
const at = "2026-09-01T00:00:00Z";
const startup: WorkflowEvent = { kind: "startup", teamId, at };
const ready = { version: 1 as const, consumers: { planning: 1 as const, developer: 1 as const, release: 1 as const, retro: 1 as const, tui: 1 as const } };

async function fixture(options: { decorate?: boolean; noChat?: boolean; fallback?: boolean; liveness?: (path: string) => ShellResult } = {}) {
  const state = { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [{ id: teamId, slug: "fixture", displayName: "Fixture", workflowModel: "goals-v1", project: { github }, externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } }, seats: [
    { id: "seat-001", displayName: "Chick Corea", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "lead-user", username: "chickcorea" } } },
    { id: seatId, displayName: "George Duke", roles: ["Product"], externalIdentities: { mattermost: { userId: "product-user", username: "georgeduke" } } },
    { id: "seat-003", displayName: "Developer", roles: ["Developer"], externalIdentities: { mattermost: { userId: "developer-user", username: "developer" } } },
  ] }], planningGoals: [] };
  const checkout = await stateCheckout("indra-product-", state); roots.push(checkout, `${checkout}.runtime`);
  const store = new PlanningStore(checkout, undefined, ready);
  await mkdir(join(checkout, "schema/v1"), { recursive: true }); await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(checkout, "schema/v1/state.schema.json"));
  let project = join(store.runtimeDir, "projects", github); const remote = join(store.runtimeDir, "fixture-remote.git");
  await mkdir(join(project, "docs/retros"), { recursive: true }); await mkdir(join(project, "src"));
  await writeFile(join(project, "docs/mission.md"), "Ship reliable continuous builds, without doing Product's own implementation.\n");
  await writeFile(join(project, "src/work.ts"), "export const work = 1;\n");
  for (const letter of ["a", "b", "c", "d"]) await writeFile(join(project, `docs/retros/goal-${letter}.md`), `Retro ${letter}: preserve the evidence before reporting.\n`);
  git(project, "init", "--quiet", "--initial-branch=main"); git(project, "add", "."); git(project, "commit", "--quiet", "-m", "Project mission and retros");
  git(project, "init", "--bare", "--quiet", remote); git(project, "remote", "add", "origin", remote); git(project, "push", "--quiet", "origin", "main");
  project = await realpath(project);
  const commands: { command: string; args: string[]; cwd: string }[] = [];
  const shell: Shell = { run: async (command, args, cwd) => { commands.push({ command, args, cwd }); if (command === "lsof" && options.liveness) return options.liveness(args.at(-1)!); if (command === "git" && args.join(" ") === "remote get-url origin") return { code: 0, stdout: `https://github.com/${github}.git`, stderr: "" }; return processShell.run(command, args, cwd); } };
  const posts: Post[] = []; const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let losePost = false; let hidePosts = false; let foreignBot = false; let badPost = false;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname.replace("/api/v4", ""); const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ path, method, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === "/users/me") return json({ id: foreignBot ? "other-user" : "product-user" });
    if (path.startsWith("/users/")) return json({ id: path.slice("/users/".length), is_bot: path !== "/users/human" });
    if (path === "/channels/home/posts") { const visible = hidePosts ? [] : posts.filter((post) => post.create_at >= Number(url.searchParams.get("since"))); return json({ order: visible.map((post) => post.id), posts: Object.fromEntries(visible.map((post) => [post.id, post])) }); }
    if (path === "/posts" && method === "POST") {
      const post: Post = { id: `post-${posts.length + 1}`, user_id: badPost ? "other-user" : "product-user", channel_id: String(body!.channel_id), root_id: String(body!.root_id), message: String(body!.message), create_at: Date.now(), props: body!.props as Post["props"] };
      posts.push(post); if (losePost) { losePost = false; throw new Error("Lost POST response"); } return json(post);
    }
    throw new Error(`Unexpected fixture HTTP ${method} ${path}`);
  };
  const rawChat = new MattermostPlanningChat("fixture-token", "georgeduke", request);
  const chat: ProductChat = options.decorate ? withPersonaChat(rawChat, (await loadSeatPersonas())[seatId]) : rawChat;
  const calls: { prompt: string; schema: string; session?: string; purpose?: string }[] = [];
  const contexts: { cwd: string; write?: WriteAccess }[] = [];
  let failCall = 0; let outputPatch: Partial<ProductProposal> = {};
  let inspect: ((cwd: string, prompt: string) => Promise<void>) | undefined;
  const runtime: AgentRuntime = { message: async (prompt, schema, session, messageOptions) => {
    messageOptions?.onUsage?.({ inputTokens: 8, outputTokens: 2 });
    calls.push({ prompt, schema, session, purpose: messageOptions?.purpose });
    if (calls.length === failCall) throw accountedFailure("Interrupted model turn");
    const identity = JSON.parse(/^Proposal identity: (.+)$/m.exec(prompt)![1]) as Pick<ProductProposal, "goalId" | "proposalId" | "rank" | "productSeatId">;
    const response: ProductProposal = { version: 1, ...identity, mission: "docs/mission.md", summary: `Reliable build improvement ${identity.rank}`, outcomes: [{ number: 1, title: "Verify delivery", description: "Improve the existing delivery evidence with a regression", reason: "The mission needs reliable autonomous delivery", currentCode: ["src/work.ts"] }], ownedFiles: ["src/**", "tests/**"], risks: ["Existing callers need compatibility"], rationale: `Use mission and retros, turn ${calls.length}`, basedOnRetros: ["goal-d", "goal-c", "goal-b"], ...outputPatch };
    return { sessionId: `product-session-${calls.length}`, response, usage: { inputTokens: 8, outputTokens: 2 }, startedAt: at, finishedAt: at };
  } };
  const seat = (await loadProductSeat(store, seatId))!;
  const runner = () => new ProductSeat({ store, seat, runtime, runtimeFor: options.fallback ? undefined : (cwd, write) => { contexts.push({ cwd, write }); return { message: async (...args) => { await inspect?.(cwd, args[0]); return runtime.message(...args); } }; }, chat: options.noChat ? undefined : chat, shell });
  const current = async () => (await store.readRuntimeFile<ProductRuntimeRecord>(productRuntimeFilename(teamId)))!;
  const vet = async (index = 0, ownedFiles = ["src/work.ts", "tests/work.test.ts"]): Promise<Extract<WorkflowEvent, { kind: "proposal-vetted" }>> => {
    const proposal = (await current()).queue[index].proposal; const corrected = { ...proposal, ownedFiles };
    return { kind: "proposal-vetted", id: `proposal-vetted:${proposal.proposalId}:${productProposalDigest(proposal)}:${productProposalDigest(corrected)}`, teamId, goalId: proposal.goalId, vetting: { proposalId: proposal.proposalId, leadSeatId: "seat-001", ownedFiles, notes: ["Verified technical scope"], at }, at };
  };
  const approve = async () => {
    const goal = (await store.read()).planningGoals![0];
    await store.approveGoal(goal.id, { kind: "approval", proposalId: goal.goalProposal!.proposalId, proposalPostId: goal.mattermost.rootPostId, approval: { source: "owner-command", command: "planning approve", at: new Date().toISOString() } });
    return { kind: "approval", id: `approved:${goal.id}`, goalId: goal.id, teamId, at } as WorkflowEvent;
  };
  const redirect = (): WorkflowEvent => {
    const post: Post = { id: `human-${posts.length}`, user_id: "human", channel_id: "home", root_id: "", message: "Prioritize safer recovery behavior", create_at: Date.now() }; posts.push(post);
    return { kind: "redirect", id: `redirect:${post.id}`, goalId: null, teamId, at, redirect: { postId: post.id, userId: post.user_id, message: post.message, at: new Date(post.create_at).toISOString() } };
  };
  let retries = 0;
  const retry = (): WorkflowEvent => ({ kind: "product-retry", id: `retry-${++retries}`, seatId, teamId, reason: "Explicit recovery", at });
  const advanceMain = async (content: string) => {
    const author = join(store.runtimeDir, "fixture-author");
    if (!await stat(author).catch(() => undefined)) git(project, "clone", "--quiet", "--branch", "main", remote, author);
    await writeFile(join(author, "src/work.ts"), content);
    await writeFile(join(author, "src/new-source.ts"), "export const added = true;\n");
    git(author, "add", "."); git(author, "commit", "--quiet", "-m", "Advance source remotely"); git(author, "push", "--quiet", "origin", "main");
    return git(author, "rev-parse", "HEAD").trim();
  };
  return { store, project, commands, requests, posts, calls, contexts, runner, current, vet, approve, redirect, retry, advanceMain,
    inspectRuntime: (probe: typeof inspect) => { inspect = probe; },
    failModel: (after = 0) => { failCall = calls.length + after + 1; }, patchOutput: (patch: Partial<ProductProposal>) => { outputPatch = patch; }, losePost: () => { losePost = true; }, hidePosts: (value: boolean) => { hidePosts = value; }, foreignBot: () => { foreignBot = true; }, badPost: () => { badPost = true; } };
}

interface SourceJournal {
  active: { runId: string } | null;
  runs: Record<string, { status: string; prompt: string; goalId: string; proposalId: string; source?: ProductSourceRevision }>;
}

describe("finite Product seat with real store and own-bot delivery", () => {
  it("fills at most five ranked drafts from the managed project's mission and latest three retros, with fresh contexts", async () => {
    const f = await fixture(); const before = await readFile(join(f.store.checkout, "state.json"), "utf8");
    expect(await f.runner().turn(startup)).toMatchObject({ status: "proposed", proposalIds: expect.any(Array) });
    const record = await f.current(); expect(record.queue).toHaveLength(5); expect(record.queue.map((entry) => entry.proposal.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(f.calls).toHaveLength(5); expect(f.calls.every((call) => call.session === undefined && call.schema.endsWith("product-proposal.json"))).toBe(true);
    expect(f.contexts).toHaveLength(5); expect(new Set(f.contexts.map(({ cwd }) => cwd)).size).toBe(5);
    expect(f.contexts.every(({ cwd, write }) => cwd.startsWith(`${f.project}.product-snapshots/`) && write === undefined)).toBe(true);
    expect(f.calls[0].prompt).toContain("Ship reliable continuous builds"); expect(f.calls[0].prompt).toContain("goal-d:"); expect(f.calls[0].prompt).not.toContain("goal-a:");
    expect(f.commands.every((call) => call.cwd === f.project || call.cwd === join(f.store.runtimeDir, "projects", github) || f.contexts.some(({ cwd }) => cwd === call.cwd))).toBe(true);
    expect(f.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
    expect(await readFile(join(f.store.checkout, "state.json"), "utf8")).toBe(before);
    expect((await f.store.readRuntimeFile<{ runs: Record<string, { sessionId: string }> }>(productJournalFilename(teamId)))!.runs).toBeDefined();
  });

  it("runs ordinary file reads at fetched main while preserving the old, dirty shared checkout", async () => {
    const f = await fixture(); const oldHead = git(f.project, "rev-parse", "HEAD");
    const head = await f.advanceMain("export const work = 2;\n");
    await writeFile(join(f.project, "src/work.ts"), "Unfinished shared work\n");
    await writeFile(join(f.project, "untracked-note.txt"), "Keep my notes\n");
    const status = git(f.project, "status", "--porcelain", "--untracked-files=all", "--ignored");
    const observed: string[] = [];
    f.inspectRuntime(async (cwd, prompt) => {
      expect(cwd).not.toBe(f.project); expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(head);
      expect(prompt).toContain(`Base: origin/main at ${head}`);
      observed.push(await readFile(join(cwd, "src/work.ts"), "utf8"));
      expect(await readFile(join(cwd, "src/new-source.ts"), "utf8")).toBe("export const added = true;\n");
    });
    expect(await f.runner().turn(startup)).toMatchObject({ status: "proposed" });
    expect(observed).toEqual(Array(5).fill("export const work = 2;\n"));
    expect(git(f.project, "rev-parse", "HEAD")).toBe(oldHead);
    expect(git(f.project, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe(status);
    expect(await readFile(join(f.project, "src/work.ts"), "utf8")).toBe("Unfinished shared work\n");
    expect(await readFile(join(f.project, "untracked-note.txt"), "utf8")).toBe("Keep my notes\n");
    expect(f.commands.some(({ args }) => args.includes("reset") || args.includes("checkout"))).toBe(false);
    const journal = (await f.store.readRuntimeFile<SourceJournal>(productJournalFilename(teamId)))!;
    expect(Object.values(journal.runs).every((run) => run.source?.sha === head)).toBe(true);
    expect(f.contexts.every(({ write }) => write === undefined)).toBe(true);
  });
  it("resumes a prepared run at its saved base after main advances without changing its identity or accepted drafts", async () => {
    const f = await fixture(); const base = git(f.project, "rev-parse", "HEAD").trim();
    const save = f.store.saveRuntime.bind(f.store); let stopped = false;
    const persistence = vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      if (stopped) throw new Error("Product host stopped after preparation");
      await save(name, value);
      if (name === productJournalFilename(teamId)) {
        const journal = value as SourceJournal; const run = journal.active?.runId ? journal.runs[journal.active.runId] : undefined;
        if (f.calls.length === 2 && run?.status === "prepared" && run.source?.snapshots.length === 1) {
          stopped = true; throw new Error("Product host stopped after preparation");
        }
      }
    });
    await expect(f.runner().turn(startup)).rejects.toThrow("Product host stopped after preparation"); persistence.mockRestore();
    const before = (await f.store.readRuntimeFile<SourceJournal>(productJournalFilename(teamId)))!;
    const runId = before.active!.runId; const reserved = before.runs[runId];
    const accepted = structuredClone((await f.current()).queue); expect(accepted).toHaveLength(2);
    const nextHead = await f.advanceMain("export const work = 3;\n"); const observed: string[] = [];
    f.inspectRuntime(async (cwd, prompt) => {
      const expected = observed.length ? nextHead : base;
      expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(expected);
      expect(prompt).toContain(`Base: origin/main at ${expected}`);
      if (!observed.length) expect(prompt).toBe(reserved.prompt);
      observed.push(await readFile(join(cwd, "src/work.ts"), "utf8"));
    });
    expect(await f.runner().turn(startup)).toMatchObject({ status: "proposed" });
    expect(observed).toEqual(["export const work = 1;\n", "export const work = 3;\n", "export const work = 3;\n"]);
    const after = (await f.store.readRuntimeFile<SourceJournal>(productJournalFilename(teamId)))!;
    expect(after.runs[runId]).toMatchObject({ status: "complete", prompt: reserved.prompt, goalId: reserved.goalId, proposalId: reserved.proposalId, source: { sha: base } });
    expect(after.runs[runId].source!.snapshots[0].id).toBe(reserved.source!.snapshots[0].id);
    expect((await f.current()).queue.slice(0, 2)).toEqual(accepted); expect((await f.current()).queue).toHaveLength(5);
    await f.runner().turn(startup); expect(f.calls).toHaveLength(5);
  });
  it.each(["prepared", "failed", "started", "legacy"] as const)("retries a %s run in a fresh copy of its original source and preserves earlier work", async (recovery) => {
    const f = await fixture(); f.failModel(2); await f.runner().turn(startup);
    const accepted = structuredClone((await f.current()).queue);
    const before = (await f.store.readRuntimeFile<SourceJournal>(productJournalFilename(teamId)))!;
    const runId = before.active!.runId; const reserved = structuredClone(before.runs[runId]);
    const base = reserved.source!.sha; const failedCopy = f.contexts[2].cwd;
    await writeFile(join(failedCopy, "recovery-note.txt"), "Preserve interrupted work\n");
    if (recovery === "started" || recovery === "prepared") before.runs[runId].status = recovery;
    if (recovery === "legacy") delete before.runs[runId].source;
    await f.store.saveRuntime(productJournalFilename(teamId), before);
    const nextHead = await f.advanceMain("export const work = 4;\n"); const observed: string[] = [];
    f.inspectRuntime(async (cwd, prompt) => {
      expect(cwd).not.toBe(failedCopy);
      expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(observed.length ? nextHead : base);
      if (!observed.length) expect(prompt).toBe(reserved.prompt);
      observed.push(await readFile(join(cwd, "src/work.ts"), "utf8"));
    });
    const retry = f.retry(); expect(await f.runner().turn(retry)).toMatchObject({ status: "proposed" });
    expect(observed).toEqual(["export const work = 1;\n", "export const work = 4;\n", "export const work = 4;\n"]);
    const after = (await f.store.readRuntimeFile<SourceJournal>(productJournalFilename(teamId)))!;
    expect(after.runs[runId]).toMatchObject({ status: "complete", prompt: reserved.prompt, goalId: reserved.goalId, proposalId: reserved.proposalId, source: { sha: base } });
    if (recovery !== "legacy") expect(after.runs[runId].source!.snapshots[0]).toMatchObject({ id: reserved.source!.snapshots[0].id, status: "preserved" });
    expect(await readFile(join(failedCopy, "recovery-note.txt"), "utf8")).toBe("Preserve interrupted work\n");
    expect((await f.current()).queue.slice(0, 2)).toEqual(accepted); expect((await f.current()).queue).toHaveLength(5);
    await f.runner().turn(retry); await f.runner().turn(startup); expect(f.calls).toHaveLength(6);
  });
  it("retires only completed clean unused source copies and retains ignored evidence or live usage", async () => {
    let busy = "";
    // Control the process observation boundary; all ownership, Git and filesystem operations are real.
    const f = await fixture({ liveness: (path) => path === busy ? { code: 0, stdout: "p12345\n", stderr: "" } : { code: 1, stdout: "", stderr: "" } });
    f.inspectRuntime(async (cwd) => {
      if (f.calls.length === 0) {
        await mkdir(join(cwd, ".indra")); await writeFile(join(cwd, ".indra/.gitignore"), "*\n");
        await writeFile(join(cwd, ".indra/result.json"), "{\"retained\":true}\n");
      }
      if (f.calls.length === 1) busy = cwd;
    });
    expect(await f.runner().turn(startup)).toMatchObject({ status: "proposed" });
    expect(await readFile(join(f.contexts[0].cwd, ".indra/result.json"), "utf8")).toBe("{\"retained\":true}\n");
    expect(await stat(f.contexts[1].cwd)).toBeDefined();
    const journal = (await f.store.readRuntimeFile<SourceJournal>(productJournalFilename(teamId)))!;
    expect(Object.values(journal.runs).map((run) => run.source!.snapshots[0].status)).toEqual(["ready", "ready", "removed", "removed", "removed"]);
    for (const { cwd } of f.contexts.slice(2)) expect(await stat(cwd).catch(() => undefined)).toBeUndefined();
    expect(f.commands.some(({ args }) => args.includes("--force"))).toBe(false);
  });
  it("preserves complete snapshots when process observation is uncertain", async () => {
    const f = await fixture({ liveness: () => ({ code: 1, stdout: "", stderr: "Observation was incomplete" }) });
    expect(await f.runner().turn(startup)).toMatchObject({ status: "proposed" });
    for (const { cwd } of f.contexts) expect(await stat(cwd)).toBeDefined();
    expect(f.commands.some(({ args }) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
    expect((await f.current()).failure).toBeNull();
  });
  it("settles its own outbox and duplicate starts without another model run, then publishes a vetted revision", async () => {
    const f = await fixture(); await f.runner().turn(startup);
    const emitted = [...(await f.current()).events];
    for (const message of [...emitted, ...emitted, startup]) await f.runner().turn(message);
    expect(f.calls).toHaveLength(5); expect((await f.current()).events).toHaveLength(5);
    const vetted = await f.vet(); await f.runner().turn(vetted);
    for (const message of [...(await f.current()).events]) await f.runner().turn(message);
    expect(f.calls).toHaveLength(5); expect(f.posts).toHaveLength(1);
    const goals = (await f.store.read()).planningGoals!; expect(goals).toHaveLength(1); expect(goals[0]).toMatchObject({ stage: "awaiting-review", ownedFiles: vetted.vetting.ownedFiles, ceremony: { stage: "proposal" } });
    expect(goals[0].goalAssignment).toBeUndefined(); expect(goals[0].integration).toBeUndefined(); expect(goals[0].mattermost.rootPostId).toBe(f.posts[0].id);
    expect(f.requests.filter((request) => request.method !== "GET").map((request) => request.path)).toEqual(["/posts"]);
  });
  it.each(["startup", "receipt", "retry"] as const)("recovers a saved scope correction before delivery on %s without another model turn", async (trigger) => {
    const f = await fixture(); await f.runner().turn(startup);
    const source = structuredClone((await f.current()).queue[0].proposal); const vetted = await f.vet();
    const corrected = { ...source, ownedFiles: vetted.vetting.ownedFiles };
    expect(productProposalDigest(source)).not.toBe(productProposalDigest(corrected));
    const save = f.store.saveRuntime.bind(f.store); let crashed = false;
    const persistence = vi.spyOn(f.store, "saveRuntime").mockImplementation(async (name, value) => {
      // Model process death immediately after the public correction is durable: no later write,
      // including the outer catch's failure record, reaches disk.
      if (crashed) throw new Error("Process stopped after durable vetting");
      await save(name, value);
      if (name === productRuntimeFilename(teamId) && (value as ProductRuntimeRecord).queue.some((entry) => entry.proposal.proposalId === source.proposalId && entry.vetting !== null)) {
        crashed = true; throw new Error("Process stopped after durable vetting");
      }
    });
    await expect(f.runner().turn(vetted)).rejects.toThrow("Process stopped after durable vetting"); persistence.mockRestore();
    const saved = await f.current(); expect(saved.queue[0]).toMatchObject({ proposal: corrected, vetting: vetted.vetting, status: "proposed" });
    expect(saved.pending).toBeNull(); expect(saved.failure).toBeNull(); expect(saved.handledEventIds).toContain(`product-startup:${teamId}`);
    const journal = await f.store.readRuntimeFile<{ active: unknown; vetting: Record<string, unknown>; deliveries: Record<string, unknown> }>(productJournalFilename(teamId));
    expect(journal).toMatchObject({ active: null, vetting: { [source.proposalId]: { source, event: vetted } } }); expect(journal?.deliveries).toEqual({});
    expect((await f.store.read()).planningGoals).toHaveLength(0); expect(f.posts).toHaveLength(0); expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    // No queue event or synthetic failure flag compensates for the lost publication turn.
    await f.runner().turn(trigger === "startup" ? startup : trigger === "receipt" ? vetted : f.retry());
    expect(f.posts).toHaveLength(1); expect((await f.store.read()).planningGoals).toHaveLength(1);
    for (const event of [startup, vetted, f.retry(), startup]) await f.runner().turn(event);
    const goals = (await f.store.read()).planningGoals!;
    expect(goals).toHaveLength(1); expect(goals[0].goalProposal).toEqual(corrected); expect(goals[0].ownedFiles).toEqual(vetted.vetting.ownedFiles);
    expect((await f.current()).queue).toHaveLength(5); expect((await f.current()).pending).toBeNull(); expect(f.calls).toHaveLength(5);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1); expect(f.posts).toHaveLength(1);
  });
  it("serializes concurrent startup and vetting deliveries across fresh runners", async () => {
    const f = await fixture(); await Promise.all([f.runner().turn(startup), f.runner().turn(startup)]);
    expect(f.calls).toHaveLength(5); const vetted = await f.vet(); await Promise.all([f.runner().turn(vetted), f.runner().turn(vetted)]);
    expect((await f.current()).queue).toHaveLength(5); expect(f.posts).toHaveLength(1); expect((await f.store.read()).planningGoals).toHaveLength(1);
  });
  it("keeps later vetted proposals unpublished until actual human approval frees the one published slot", async () => {
    const f = await fixture(); await f.runner().turn(startup); await f.runner().turn(await f.vet()); await f.runner().turn(await f.vet(1));
    expect(f.posts).toHaveLength(1); const approved = await f.approve(); await f.runner().turn(approved);
    const goals = (await f.store.read()).planningGoals!; expect(goals).toHaveLength(2); expect(goals.map((goal) => goal.stage)).toEqual(["approved", "awaiting-review"]);
    expect(f.posts).toHaveLength(2); expect((await f.current()).queue).toHaveLength(5); expect(f.calls).toHaveLength(6);
    const published = (await f.current()).queue.filter((entry) => entry.status === "posted"); expect(published).toHaveLength(1);
  });
  it("recovers a delivered post after its acknowledgment is lost without sending a duplicate", async () => {
    const f = await fixture(); await f.runner().turn(startup); f.losePost();
    await expect(f.runner().turn(await f.vet())).resolves.toMatchObject({ status: "blocked" }); expect(f.posts).toHaveLength(1); expect((await f.current()).pending).not.toBeNull();
    await f.runner().turn(f.retry()); expect(f.posts).toHaveLength(1); expect((await f.store.read()).planningGoals).toHaveLength(1); expect((await f.current()).pending).toBeNull();
  });
  it("keeps ambiguous post delivery blocked instead of resending, then recovers when GET confirms it", async () => {
    const f = await fixture(); await f.runner().turn(startup); f.losePost(); await expect(f.runner().turn(await f.vet())).resolves.toMatchObject({ status: "blocked" });
    f.hidePosts(true); await expect(f.runner().turn(f.retry())).resolves.toMatchObject({ status: "blocked" }); expect((await f.current()).failure?.message).toContain("no second POST"); expect(f.posts).toHaveLength(1);
    f.hidePosts(false); await f.runner().turn(f.retry()); expect(f.posts).toHaveLength(1); expect((await f.current()).pending).toBeNull();
  });
  it("recovers a lost state-publication response using the exact durable goal and verified root", async () => {
    const f = await fixture(); await f.runner().turn(startup); const publish = f.store.publishProductProposal.bind(f.store);
    vi.spyOn(f.store, "publishProductProposal").mockImplementationOnce(async (...args) => { await publish(...args); throw new Error("Lost state ACK"); });
    await expect(f.runner().turn(await f.vet())).resolves.toMatchObject({ status: "blocked" }); expect((await f.store.read()).planningGoals).toHaveLength(1);
    await f.runner().turn(f.retry()); expect(f.posts).toHaveLength(1); expect(f.store.publishProductProposal).toHaveBeenCalledTimes(1);
  });
  it("accepts only exact revision-bound vetting by the actual Team Lead", async () => {
    const f = await fixture(); await f.runner().turn(startup); const original = structuredClone((await f.current()).queue[0].proposal); const vetted = await f.vet();
    await f.runner().turn({ ...vetted, id: vetted.id.replace(/:[0-9a-f]{64}$/, `:${"f".repeat(64)}`) });
    await f.runner().turn({ ...vetted, id: `${vetted.id}-extra` });
    await f.runner().turn({ ...vetted, vetting: { ...vetted.vetting, leadSeatId: seatId } });
    expect((await f.current()).queue[0].proposal).toEqual(original); expect(f.posts).toHaveLength(0);
    // A rejected receipt must not consume the valid digest-bound event identity.
    await f.runner().turn(vetted); expect(f.posts).toHaveLength(1);
  });
  it("refines only unpublished entries at capacity, invalidating their old vetting without rewriting a posted proposal", async () => {
    const f = await fixture(); await f.runner().turn(startup); await f.runner().turn(await f.vet()); const posted = structuredClone((await f.current()).queue[0]);
    const old = await f.vet(4); await f.runner().turn(old); expect((await f.current()).queue[4].vetting).not.toBeNull();
    const redirect = f.redirect(); await f.runner().turn(redirect); const queue = (await f.current()).queue;
    expect(queue).toHaveLength(5); expect(queue[0]).toEqual(posted); expect(queue[4].vetting).toBeNull(); expect(f.calls).toHaveLength(6);
    await f.runner().turn(old); expect((await f.current()).queue[4].vetting).toBeNull(); expect(f.posts.filter((post) => post.user_id === "product-user")).toHaveLength(1);
  });
  it("retains accepted drafts across a failed fresh context and consumes each retry only once", async () => {
    const f = await fixture(); f.failModel(2); await expect(f.runner().turn(startup)).resolves.toMatchObject({ status: "blocked" });
    const accepted = structuredClone((await f.current()).queue); expect(accepted).toHaveLength(2); expect(f.calls).toHaveLength(3);
    const retry = f.retry(); f.failModel(); await expect(f.runner().turn(retry)).resolves.toMatchObject({ status: "blocked" });
    expect(f.calls).toHaveLength(4); expect((await f.current()).handledEventIds).toContain(retry.kind !== "startup" && retry.id);
    for (const event of [startup, retry, { kind: "queue-changed", id: "ordinary-wakeup", teamId, at } as WorkflowEvent]) await f.runner().turn(event);
    expect(f.calls).toHaveLength(4); expect((await f.current()).queue).toEqual(accepted);
    await f.runner().turn({ ...f.retry(), teamId: "another-team" });
    await f.runner().turn({ kind: "product-retry", id: "another-seat", seatId: "seat-003", teamId, reason: "Wrong seat", at });
    expect(f.calls).toHaveLength(4); expect((await f.current()).failure).not.toBeNull();
    await f.runner().turn(f.retry()); expect(f.calls).toHaveLength(7); expect((await f.current()).queue).toHaveLength(5);
    expect((await f.current()).queue.slice(0, 2)).toEqual(accepted);
    await f.runner().turn(startup); expect(f.calls).toHaveLength(7);
  });
  it("retains vetting delivered while generation is blocked so receipted evidence survives recovery", async () => {
    const f = await fixture(); f.failModel(2); await f.runner().turn(startup);
    const vetted = await f.vet();
    await expect(f.runner().turn(vetted)).resolves.toMatchObject({ status: "blocked" });
    expect((await f.current()).handledEventIds).toContain(vetted.id);
    expect((await f.current()).queue[0].vetting).toEqual(vetted.vetting);
    expect(f.posts).toHaveLength(0); expect(f.calls).toHaveLength(3);
    await f.runner().turn(f.retry());
    expect(f.posts).toHaveLength(1); expect(f.calls).toHaveLength(6); expect((await f.current()).queue).toHaveLength(5);
    expect((await f.store.read()).planningGoals).toMatchObject([{ stage: "awaiting-review", ownedFiles: vetted.vetting.ownedFiles }]);
    await f.runner().turn(vetted); expect(f.posts).toHaveLength(1);
  });
  it("recovers the first failed turn through the real seat retry CLI, host restart and verified publication", async () => {
    const f = await fixture(); f.failModel();
    await expect(f.runner().turn(startup)).resolves.toMatchObject({ status: "blocked" });
    expect((await f.store.read()).planningGoals).toHaveLength(0); expect((await f.current()).queue).toHaveLength(0);
    const before = await readFile(join(f.store.checkout, "state.json"), "utf8");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["planning", "retry", "--seat", seatId, "--state", f.store.checkout])).toBe(0);
    expect(await readFile(join(f.store.checkout, "state.json"), "utf8")).toBe(before);
    const seen: WorkflowEvent[] = [];
    const restart = async () => {
      const controller = new AbortController();
      await runWorkflowHost({ store: f.store, teamId, consumer: seatId, signal: controller.signal,
        onReady: async () => controller.abort(), turn: async (event) => { seen.push(event); await f.runner().turn(event); },
      });
    };
    await restart();
    expect(seen.map((event) => event.kind)).toEqual(["startup", "product-retry"]);
    expect(seen[1]).toMatchObject({ teamId, seatId }); expect(seen[1]).not.toHaveProperty("goalId");
    expect(f.calls).toHaveLength(6); expect((await f.current()).queue).toHaveLength(5); expect((await f.current()).failure).toBeNull();
    expect((await f.store.read()).planningGoals).toHaveLength(0); expect(f.posts).toHaveLength(0);
    const inbox = new WorkflowInbox(f.store.runtimeDir); await inbox.publish(await f.vet());
    await restart(); await restart();
    expect(f.calls).toHaveLength(6); expect(f.posts).toHaveLength(1);
    expect((await f.store.read()).planningGoals).toMatchObject([{ stage: "awaiting-review", mattermost: { rootPostId: f.posts[0].id }, ceremony: { stage: "proposal" } }]);
    expect((await f.store.read()).planningGoals![0].goalAssignment).toBeUndefined();
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
  it("lets a restarted host consume a queued recovery when an old publication failure remains unresolved", async () => {
    const f = await fixture(); await f.runner().turn(startup); f.losePost();
    await f.runner().turn(await f.vet()); f.hidePosts(true);
    const retry = f.retry(); const inbox = new WorkflowInbox(f.store.runtimeDir); await inbox.publish(retry);
    const controller = new AbortController(); const statuses: string[] = [];
    await runWorkflowHost({ store: f.store, teamId, consumer: seatId, signal: controller.signal,
      onReady: async () => controller.abort(), turn: async (event) => { statuses.push((await f.runner().turn(event)).status); },
    });
    expect(statuses).toEqual(["blocked", "blocked"]); expect(f.posts).toHaveLength(1); expect(f.calls).toHaveLength(5);
    const redelivered = vi.fn(async () => {}); await inbox.drain(seatId, teamId, redelivered); expect(redelivered).not.toHaveBeenCalled();
    f.hidePosts(false); await f.runner().turn(f.retry());
    expect(f.posts).toHaveLength(1); expect((await f.store.read()).planningGoals).toHaveLength(1);
  });
  it.each(["identity", "pointer", "scope"])("refuses invalid %s model claims before they enter the public queue", async (failure) => {
    const f = await fixture(); f.patchOutput(failure === "identity" ? { productSeatId: "seat-001" } : failure === "scope" ? { ownedFiles: ["../state.json"] } : { outcomes: [{ number: 1, title: "Invalid", description: "Unknown", reason: "Unverified", currentCode: ["missing.ts"] }] });
    await expect(f.runner().turn(startup)).resolves.toMatchObject({ status: "blocked" }); expect((await f.current()).failure).not.toBeNull(); expect((await f.current()).queue).toHaveLength(0); expect(f.posts).toHaveLength(0);
  });
  it.each(["missing", "foreign", "post"])("does not publish with %s own-bot capability/evidence", async (problem) => {
    const f = await fixture({ noChat: problem === "missing" }); await f.runner().turn(startup); if (problem === "foreign") f.foreignBot(); if (problem === "post") f.badPost();
    await expect(f.runner().turn(await f.vet())).resolves.toMatchObject({ status: "blocked" }); expect((await f.current()).failure).not.toBeNull(); expect((await f.store.read()).planningGoals).toHaveLength(0);
    expect(f.requests.filter((request) => request.method !== "GET")).toHaveLength(problem === "post" ? 1 : 0);
  });
  it("preserves persona decoration and verifies its complete frozen proposal during GET recovery", async () => {
    const f = await fixture({ decorate: true }); await f.runner().turn(startup); await f.runner().turn(await f.vet());
    expect(f.posts[0].message).toMatch(/^Keeping a steady groove\.\n\n## Proposed goal:/); expect((await f.store.read()).planningGoals).toHaveLength(1);
  });
  it("refuses an unbound fallback runtime and ignores unrelated events", async () => {
    const f = await fixture({ fallback: true }); await f.runner().turn({ ...startup, teamId: "another-team" }); expect(f.calls).toHaveLength(0);
    expect(await f.runner().turn(startup)).toMatchObject({ status: "blocked" }); expect(f.contexts).toHaveLength(0); expect(f.calls).toHaveLength(0); expect((await f.current()).failure?.message).toContain("runtimeFor");
  });
});


it("stops Product on a token trip and refuses ordinary retry after recreation", async () => {
  const f = await fixture();
  await writeFile(join(f.store.runtimeDir, "circuit-policy.json"), JSON.stringify({ maxTokens: 1 }));
  await f.runner().turn({ kind: "startup", teamId, at });
  expect((await f.current()).failure).toMatchObject({ retryable: false, message: expect.stringContaining("Circuit open") });
  expect(f.calls).toHaveLength(1);
  await f.runner().turn(f.retry());
  expect(f.calls).toHaveLength(1);
  expect((await f.current()).failure!.retryable).toBe(false);
});
