import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { stateCheckout } from "./state-checkout.js";
import { PlanningStore, type PlanningGoal } from "../src/planning.js";
import { PlanningBridge, type PlanningChat, type Post, type Reaction } from "../src/planning-bridge.js";
import { DeveloperSeat, loadDeveloperSeat, type Shell, type ShellResult } from "../src/developer-seat.js";
import { CLARIFY_TIMEOUT_MS, DRAFT_TIMEOUT_MS, type MessageOptions, type WriteAccess } from "../src/codex-runtime.js";
import { SeatRuntime, type EngineFactory, type SeatEngine } from "../src/seat-runtime.js";
import { loadSeatPersonas, withPersonaChat, withPersonaRuntime } from "../src/seat-persona.js";

const roster = [
  ["seat-001", "Chick Corea", "Chick Corea", "Team Lead", "chickcorea"],
  ["seat-002", "George Duke", "George Duke", "Developer", "georgeduke"],
  ["seat-003", "Aaron Magner", "Aron Magner", "Developer", "aaronmagner"],
  ["seat-004", "Corey Henry", "Cory Henry", "Developer", "coreyhenry"],
  ["seat-005", "Jordan Rudess", "Jordan Rudess", "Developer", "jordanrudess"],
] as const;
interface Profile {
  voice: string; background: string; funFact: string; postPrefix: string;
}
const profiles: Record<string, Profile> = JSON.parse(await readFile(new URL("../personas/yahaha.json", import.meta.url), "utf8"));
const PR = "https://github.com/satoramoto/indra/pull/9";
const SHA = "a".repeat(40);
const engines: SeatEngine[] = ["codex", "claude"];
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(goals: PlanningGoal[] = []) {
  const checkout = await stateCheckout("indra-personas-", {
    $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: goals,
    teams: [{
      id: "team-001", slug: "yahaha", displayName: "Yahaha", project: { github: "satoramoto/indra" },
      externalIdentities: { mattermost: { teamId: "team", homeChannelId: "channel" } },
      seats: roster.map(([id, displayName, , role, username]) => ({ id, displayName, roles: [role], externalIdentities: { mattermost: { userId: id, username } } })),
    }],
  });
  temporary.push(checkout, `${checkout}.runtime`);
  if (!goals.length) return new PlanningStore(checkout);
  await mkdir(join(checkout, "schema/v1"), { recursive: true });
  await copyFile(new URL("../schema/v1/state.schema.json", import.meta.url), join(checkout, "schema/v1/state.schema.json"));
  return new PlanningStore(checkout, undefined, { version: 1, consumers: { planning: 1, developer: 1, release: 1, retro: 1, tui: 1 } });
}

function approvedGoal(seatId: string): PlanningGoal {
  const now = "2026-01-01T00:00:00Z";
  return {
    id: "goal-personas", teamId: "team-001", seatId: "seat-001", participantSeatIds: [], goal: "Keep factual progress visible", projectRefs: ["satoramoto/indra"],
    stage: "approved", createdAt: now, updatedAt: now, mattermost: { channelId: "channel", rootPostId: "root-dev" },
    brief: { summary: "Keep factual progress visible", decisions: [], openQuestions: [] },
    proposal: { id: "proposal-personas", createdAt: now, summary: "Plan", risks: [], openQuestions: [], outcomes: [{ id: "outcome-1", title: "Show progress", description: "Preserve the PR and the approval gate", seatId }] },
    assignments: [{ seatId, outcomeId: "outcome-1", status: "queued", updatedAt: now }],
    integration: { branch: "sprint/goal-personas", baseSha: SHA, status: "collecting" },
    ceremony: { version: 1, stage: "implement", history: [
      { stage: "planning", enteredAt: now }, { stage: "proposal", enteredAt: now },
      { stage: "implement", enteredAt: now, evidence: { kind: "approval", proposalId: "proposal-personas", proposalPostId: "proposal-post", approval: { source: "owner-command", command: "planning approve", at: now } } },
    ] },
  };
}

class MemoryChat implements PlanningChat {
  posts: Post[] = [];
  reacted: Reaction[] = [];
  loseDeliveryAck = false;
  private sequence = 0;
  constructor(private readonly own: string) {}
  async ownUserId() { return this.own; }
  async post(channel: string, message: string, root = "", delivery?: string) {
    const post: Post = { id: `post-${++this.sequence}`, user_id: this.own, channel_id: channel, root_id: root, message, create_at: Date.now() + this.sequence, props: { indra_delivery_id: delivery } };
    this.posts.push(post);
    if (delivery && root && this.loseDeliveryAck) { this.loseDeliveryAck = false; throw new Error("Delivery acknowledgement lost"); }
    return post;
  }
  async since(channel: string) { return this.posts.filter((post) => post.channel_id === channel); }
  async reactions(post: string) { return this.reacted.filter((reaction) => reaction.post_id === post); }
  async isBot(user: string) { return roster.some(([id]) => id === user); }
  human(root: string) { this.posts.push({ id: `human-${++this.sequence}`, user_id: "owner", channel_id: "channel", root_id: root, message: "Keep the PR visible.", create_at: Date.now() + this.sequence }); }
  react(post: string, emoji: string) { this.reacted.push({ post_id: post, user_id: "owner", emoji_name: emoji, create_at: Date.now() + ++this.sequence }); }
}

/** Real bridges, seats and engine routing; only the provider responses and external GitHub/Git commands are fake. */
class CapturedEngines {
  calls: { engine: SeatEngine; cwd: string; write?: WriteAccess; prompt: string; schema: string; session?: string; options?: MessageOptions }[] = [];
  fail = false;
  fixed = false;
  onWrite?: () => void;
  create: EngineFactory = (engine, cwd, _timeout, write) => ({
    message: async (prompt, schema, session, options) => {
      this.calls.push({ engine, cwd, write, prompt, schema, session, options });
      if (this.fail) throw new Error("Provider unavailable");
      if (prompt.includes("Outcome: every review finding") || prompt.includes("the merge is in progress")) { this.fixed = true; this.onWrite?.(); }
      const response = schema.endsWith("proposal.json")
        ? { summary: "Keep links", outcomes: [{ title: "Show progress", description: "Preserve PR links", seatId: "seat-002" }], risks: [], openQuestions: [] }
        : schema.endsWith("brief.json") ? { reply: "Which progress detail matters most?", summary: "Keep links", decisions: [], openQuestions: ["Priority?"] }
          : schema.endsWith("review.json") ? { findings: this.fixed ? [] : ["src/example.ts:12: progress loses its PR link"], summary: "Reviewed" }
            : { prUrl: PR, summary: "Preserved progress" };
      const suffix = String(this.calls.length).padStart(12, "0");
      const id = engine === "claude" ? `claude:00000000-0000-4000-8000-${suffix}` : `codex-session-${suffix}`;
      return { sessionId: session ?? id, response, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" };
    },
  });
}

class WorkflowShell implements Shell {
  calls: string[] = [];
  merged = false;
  branch = "";
  base = "";
  head = SHA;
  reviews: { body: string; user: { login: string }; state: string; commit_id: string }[] = [];
  async run(command: string, args: string[], cwd: string): Promise<ShellResult> {
    if (command === "env") { command = "gh"; args = args.slice(2); }
    const line = `${command} ${args.join(" ")}`;
    this.calls.push(line);
    const ok = (stdout = ""): ShellResult => ({ code: 0, stdout, stderr: "" });
    if (line.startsWith("gh repo clone")) await mkdir(join(args[3], ".git"), { recursive: true });
    if (line.startsWith("git worktree add")) { await mkdir(args[5], { recursive: true }); this.branch = args[4]; this.base = args[6].replace(/^origin\//, ""); }
    if (line.startsWith("git show-ref")) return { code: 1, stdout: "", stderr: "" };
    if (line === "git rev-parse HEAD") return ok(this.head);
    if (line.startsWith("git rev-parse")) return ok(join(cwd, ".git"));
    if (line === "gh api user --jq .login") return ok("satori-miyamoto");
    if (line.startsWith("gh api") && args.includes("--paginate")) return ok(JSON.stringify([this.reviews]));
    if (line.startsWith("gh api") && args.includes("POST")) {
      const body = JSON.parse(await readFile(args.at(-1)!, "utf8"));
      this.reviews.push({ body: body.body, user: { login: "satori-miyamoto" }, commit_id: body.commit_id, state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED" });
    }
    if (line.startsWith("gh pr view") && args.includes("headRefOid")) return ok(this.head);
    if (line.startsWith("gh api") && args[1]?.includes("git/ref/heads/")) return ok(SHA);
    if (line.startsWith("gh pr view") && args.includes("mergeable,mergeStateStatus")) return ok(JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }));
    if (line.startsWith("git merge --no-edit")) return { code: 1, stdout: "", stderr: "merge conflict" };
    // The seat verifies the PR's head and base before merging it (#44).
    if (line.startsWith("gh pr view") && args.includes("isDraft,headRefName,baseRefName,state")) return ok(JSON.stringify({ isDraft: false, headRefName: this.branch, baseRefName: this.base, state: this.merged ? "MERGED" : "OPEN" }));
    if (line.startsWith("gh pr merge")) this.merged = true;
    if (line.startsWith("gh pr view")) return ok(this.merged ? "MERGED\n" : "OPEN\n");
    return ok();
  }
}

function expectPersona(prompt: string, seatId: string) {
  for (const field of [profiles[seatId].voice, profiles[seatId].background, profiles[seatId].funFact]) expect(prompt).toContain(field);
  for (const [other, profile] of Object.entries(profiles)) if (other !== seatId) expect(prompt).not.toContain(profile.voice);
}

function expectPostPersona(message: string, seatId: string) {
  expect(message.startsWith(`${profiles[seatId].postPrefix}\n\n`)).toBe(true);
  expect(message).not.toContain(profiles[seatId].background);
  expect(message).not.toContain(profiles[seatId].funFact);
  for (const [other, profile] of Object.entries(profiles)) if (other !== seatId) expect(message).not.toContain(profile.postPrefix);
}

describe("repository Yahaha persona profiles", () => {
  it("covers precisely the five stable seats without renaming the bots", () => {
    expect(Object.keys(profiles).sort()).toEqual(roster.map(([id]) => id));
    for (const [id, displayName, namesake, role] of roster) {
      expect(profiles[id].background).toContain(displayName);
      expect(profiles[id].background).toContain(role);
      expect(profiles[id].funFact).toContain(namesake);
    }
  });

  it("has concise, distinct voices and sourced third-person musician biographies", () => {
    for (const [id, , namesake] of roster) {
      const profile = profiles[id];
      for (const field of [profile.voice, profile.background, profile.funFact, profile.postPrefix]) {
        expect(field.trim().length).toBeGreaterThan(10);
        expect(field.length).toBeLessThan(350);
      }
      expect(profile.background).toContain("bot inspired by");
      expect(profile.funFact).toContain(namesake);
      expect(profile.funFact).not.toMatch(/\b(?:I|my|we|our)\b/i);
      const link = /\[Source\]\((https:\/\/[^\s)]+)\)$/.exec(profile.funFact);
      expect(link).not.toBeNull();
      const source = new URL(link![1]);
      expect(source.protocol).toBe("https:");
      expect(source.hostname).not.toMatch(/(?:example|wikipedia)\./);
      expect(profile.postPrefix.split(/\s+/).length).toBeLessThanOrEqual(8);
    }
    expect(new Set(Object.values(profiles).map((profile) => profile.voice)).size).toBe(5);
    expect(new Set(Object.values(profiles).map((profile) => profile.postPrefix)).size).toBe(5);
  });

  it("loads the checked-in profiles through the shared loader and selects by stable ID", async () => {
    const loaded = await loadSeatPersonas();
    expect(loaded).toEqual(profiles);
    for (const [id] of roster) expect(loaded[id].voice).toBe(profiles[id].voice);
    expect(loaded["seat-unknown"]).toBeUndefined();
  });

  it.each(engines)("captures Chick's planning prompts and preserves approval and delivery on %s", async (engine) => {
    const store = await fixture(); const chat = new MemoryChat("seat-001"); const captured = new CapturedEngines();
    const profile = (await loadSeatPersonas())["seat-001"];
    const bridge = new PlanningBridge(store, withPersonaChat(chat, profile), withPersonaRuntime(new SeatRuntime(engine, store.checkout, undefined, undefined, captured.create), profile), 20, new WorkflowShell());
    const goal = await bridge.start("Keep factual progress visible");
    chat.human(goal.mattermost.rootPostId);
    await bridge.poll();
    chat.react(goal.mattermost.rootPostId, "memo");
    await bridge.poll();
    expect(captured.calls.map((call) => basename(call.schema))).toEqual(["brief.json", "brief.json", "proposal.json"]);
    expect(captured.calls.map((call) => call.engine)).toEqual([engine, engine, engine]);
    expect(captured.calls.map((call) => call.options?.timeoutMs)).toEqual([CLARIFY_TIMEOUT_MS, CLARIFY_TIMEOUT_MS, DRAFT_TIMEOUT_MS]);
    // Every clarify turn and the draft run in a fresh session; none resumes an earlier turn's.
    expect(captured.calls.map((call) => call.session)).toEqual([undefined, undefined, undefined]);
    for (const call of captured.calls) {
      expectPersona(call.prompt, "seat-001");
      expect(call.write).toBeUndefined();
      expect(call.prompt).toContain("This is planning only");
      expect(call.prompt).toContain("Return only JSON");
      expect(call.prompt).toContain("Goal: Keep factual progress visible");
    }
    expect((await store.read()).planningGoals![0].assignments).toBeUndefined();
    expect(chat.posts[0].message).toContain("React :memo: on this post to request a draft proposal for review.");
    const proposal = chat.posts.find((post) => post.message.includes("**Draft proposal"))!;
    expect(proposal.message).toContain("No work has been approved or executed. To approve it, a person reacts :white_check_mark: on this post.");
    const approved = await bridge.approve(goal.id);
    expect(approved.goal.assignments).toMatchObject([{ seatId: "seat-002", outcomeId: "outcome-1", status: "queued" }]);
    expect(chat.posts.at(-1)?.message).toContain("Each outcome is queued for its Developer seat.");
    expect(chat.posts.at(-1)?.message).toContain(`sprint/${goal.id}`);
    const own = chat.posts.filter((post) => post.user_id === "seat-001");
    for (const post of own) {
      expect(post.channel_id).toBe("channel");
      expectPostPersona(post.message, "seat-001");
      if (post !== own[0]) {
        expect(post.root_id).toBe(goal.mattermost.rootPostId);
        expect(post.props?.indra_delivery_id).toBeTruthy();
      }
    }
    expect(new Set(own.slice(1).map((post) => post.props?.indra_delivery_id)).size).toBe(own.length - 1);
  });

  for (const engine of engines) {
    it.each(roster.slice(1))("keeps %s's build, fresh review, fix and conflict prompts on " + engine, async (id, displayName, _namesake, _role, username) => {
      const store = await fixture([approvedGoal(id)]); const chat = new MemoryChat(id); const captured = new CapturedEngines(); const shell = new WorkflowShell();
      let revision = 0; captured.onWrite = () => { shell.head = (++revision).toString(16).padStart(40, "0"); };
      const profile = (await loadSeatPersonas())[id];
      const identity = await loadDeveloperSeat(store, id);
      expect(identity).toMatchObject({ id, displayName, username, roles: ["Developer"] });
      const seat = new DeveloperSeat(store, identity, withPersonaChat(chat, profile), shell, (cwd, write) => withPersonaRuntime(new SeatRuntime(engine, cwd, undefined, write, captured.create), profile));
      expect(await seat.tick()).toBe("worked");
      expect((await store.read()).planningGoals![0].assignments![0]).toMatchObject({ status: "merged", prUrl: PR });
      expect(captured.calls.map((call) => basename(call.schema))).toEqual(["developer.json", "review.json", "developer.json", "review.json", "developer.json", "review.json"]);
      expect(captured.calls.map((call) => call.engine)).toEqual([engine, engine, engine, engine, engine, engine]);
      expect(captured.calls.map((call) => call.session)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
      for (const call of captured.calls) expectPersona(call.prompt, id);
      expect(captured.calls[0].prompt).toContain(`You are ${displayName}, a Developer seat`);
      expect(captured.calls[0].prompt).toContain("--base sprint/goal-personas");
      expect(captured.calls[1].prompt).toContain("You are a fresh reviewer");
      expect(captured.calls[1].prompt).toContain("You did not write this change");
      expect(captured.calls[1].prompt).toContain("read-only without network");
      expect(captured.calls[1].write).toBeUndefined();
      expect(captured.calls[2].prompt).toContain("src/example.ts:12: progress loses its PR link");
      expect(captured.calls[4].prompt).toContain("the merge is in progress");
      for (const call of [captured.calls[0], captured.calls[2], captured.calls[4]]) {
        expect(call.write?.extraDirs).toEqual([join(store.runtimeDir, "projects", "satoramoto", "indra", ".git")]);
      }
      for (const post of chat.posts) {
        expect(post).toMatchObject({ channel_id: "channel", root_id: "root-dev", user_id: id });
        expectPostPersona(post.message, id);
      }
      expect(chat.posts.map((post) => post.message)).toEqual([
        expect.stringContaining("Claimed **Show progress** (outcome-1). Starting work."),
        expect.stringContaining(`Opened ${PR} for **Show progress**. Starting a fresh review.`),
        expect.stringContaining(`Review of ${PR} done: 1 finding(s); fixing.`),
        expect.stringContaining(`Review of ${PR} done: no findings.`),
        expect.stringContaining(`${PR} conflicts with sprint/goal-personas; resolving (round 1 of 2).`),
        expect.stringContaining(`Merged ${PR} for **Show progress**. Going idle.`),
      ]);
      expect(shell.calls).toContain(`gh pr checks ${PR} --watch`);
    });
  }

  it("keeps failed progress factual in the seat's own voice", async () => {
    const store = await fixture([approvedGoal("seat-004")]); const chat = new MemoryChat("seat-004"); const captured = new CapturedEngines(); captured.fail = true;
    const profile = (await loadSeatPersonas())["seat-004"];
    const seat = new DeveloperSeat(store, await loadDeveloperSeat(store, "seat-004"), withPersonaChat(chat, profile), new WorkflowShell(), (cwd, write) => withPersonaRuntime(new SeatRuntime("codex", cwd, undefined, write, captured.create), profile));
    await seat.tick();
    expect(captured.calls).toHaveLength(1);
    expect((await store.read()).planningGoals![0].assignments![0].status).toBe("failed");
    expect(chat.posts.at(-1)?.message).toContain("Failed **Show progress** (outcome-1):");
    expectPostPersona(chat.posts.at(-1)!.message, "seat-004");
    expect(chat.posts.some((post) => post.message.includes("Merged "))).toBe(false);
  });

  it("reconciles an acknowledged-by-server planning delivery without reposting or rerunning", async () => {
    const store = await fixture(); const chat = new MemoryChat("seat-001"); chat.loseDeliveryAck = true;
    const captured = new CapturedEngines(); const profile = (await loadSeatPersonas())["seat-001"];
    const bridge = new PlanningBridge(store, withPersonaChat(chat, profile), withPersonaRuntime(new SeatRuntime("codex", store.checkout, undefined, undefined, captured.create), profile), 20, new WorkflowShell());
    await expect(bridge.start("Keep factual progress visible")).rejects.toThrow("Delivery acknowledgement lost");
    const delivered = chat.posts[1];
    expect(delivered.props?.indra_delivery_id).toBeTruthy();
    expectPostPersona(delivered.message, "seat-001");
    await bridge.poll();
    expect(chat.posts).toHaveLength(2);
    expect(captured.calls).toHaveLength(1);
    const goal = (await store.read()).planningGoals![0];
    expect((await store.runtime(goal.id)).pending).toBeUndefined();
  });

  it.each(engines)("leaves unknown-seat prompts, posts and delivery untouched on %s", async (engine) => {
    const captured = new CapturedEngines(); const chat = new MemoryChat("seat-unknown");
    const unknown = (await loadSeatPersonas())["seat-unknown"];
    const runtime = new SeatRuntime(engine, tmpdir(), undefined, undefined, captured.create);
    expect(withPersonaRuntime(runtime, unknown)).toBe(runtime);
    expect(withPersonaChat(chat, unknown)).toBe(chat);
    await withPersonaRuntime(runtime, unknown).message("Keep the exact task", "developer.json");
    expect(captured.calls[0].prompt).toBe("Keep the exact task");
    expect(captured.calls[0].engine).toBe(engine);
    const message = `Opened ${PR}. To approve it, a person reacts :white_check_mark: on this post.`;
    const post = await withPersonaChat(chat, unknown).post("channel", message, "root", "delivery");
    expect(post).toMatchObject({ message, root_id: "root", channel_id: "channel", props: { indra_delivery_id: "delivery" } });
  });

  it("loads the actual profiles from compiled dist and builds modules outside the current directory", async () => {
    const app = await mkdtemp(join(tmpdir(), "indra-persona-build-")); temporary.push(app);
    await mkdir(join(app, "personas"));
    await cp(new URL("../personas/yahaha.json", import.meta.url), join(app, "personas", "yahaha.json"));
    await build({
      configFile: false, logLevel: "silent",
      build: { outDir: join(app, "dist"), lib: { entry: fileURLToPath(new URL("../src/seat-persona.ts", import.meta.url)), formats: ["es"], fileName: () => "persona.mjs" }, rollupOptions: { external: [/^node:/] } },
    });
    await mkdir(join(app, "builds", "test-build"), { recursive: true });
    await cp(join(app, "dist", "persona.mjs"), join(app, "builds", "test-build", "persona.mjs"));
    for (const directory of ["dist", "builds/test-build"]) {
      const module = pathToFileURL(join(app, directory, "persona.mjs")).href;
      const result = execFileSync(process.execPath, ["--input-type=module", "-e", `const {loadSeatPersonas} = await import(${JSON.stringify(module)}); console.log(JSON.stringify(await loadSeatPersonas()));`], { cwd: tmpdir(), encoding: "utf8" });
      expect(JSON.parse(result)).toEqual(profiles);
    }
  });
});
