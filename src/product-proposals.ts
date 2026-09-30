import { CircuitBudget, isCircuitOpen } from "./circuit-budget.js";
import { circuitRuntime, circuitShell, productCircuitScope, withCircuitScope } from "./circuit-scope.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DRAFT_TIMEOUT_MS, type AgentRuntime } from "./codex-runtime.js";
import { processShell, type Shell } from "./command-shell.js";
import type { RuntimeFactory } from "./developer-seat.js";
import { assertProductQueueCapacity, productRuntimeFilename, validateOwnedFiles, validateProductProposal, type ProductProposal, type ProductQueueEntry, type ProductRuntimeRecord, type WorkflowEvent } from "./goal-contract.js";
import type { Post } from "./planning-bridge.js";
import type { MattermostPlanningChat } from "./planning-mattermost.js";
import { requireTeamHome, type PlanningDocument, type PlanningStore } from "./planning.js";
import { ensureProjectCheckout, projectCheckoutPath } from "./project-checkout.js";
import { ProductSnapshotError, ProductSourceSnapshots, type ProductSourceRevision } from "./product-source-snapshot.js";
import { redactSecrets } from "./redact.js";
import { schemaPathOf } from "./reload.js";
import { loadSeatPersonas, personaPost } from "./seat-persona.js";

export const PRODUCT_QUEUE_CAP = 5;
export type ProductChat = Pick<MattermostPlanningChat, "ownUserId" | "isBot" | "since" | "post">;
export interface ProductProposalServices {
  store: PlanningStore; teamId: string; productSeatId: string;
  /** Retained for host compatibility; generation requires runtimeFor to bind the exact source snapshot. */
  runtime?: AgentRuntime;
  runtimeFor?: RuntimeFactory;
  chat?: ProductChat;
  shell?: Shell;
}
export interface ProposalTurnResult { status: "disabled" | "blocked" | "idle" | "proposed" | "refined"; proposals: ProductProposal[] }
export class ProductTurnError extends Error {
  override name = "ProductTurnError";
  constructor(message: string, readonly recorded = false) { super(message); }
}
type VettedEvent = Extract<WorkflowEvent, { kind: "proposal-vetted" }>;
interface Team { id: string; workflowModel?: string; seats: { id: string; roles: string[]; externalIdentities: { mattermost: { userId: string } } }[] }
interface Source { github: string; project: string; sha: string; files: string[]; mission: string; retros: { goalId: string; text: string }[] }
interface ModelRun {
  goalId: string; proposalId: string; rank: number; sourceDigest: string | null;
  prompt: string; files: string[]; retroIds: string[]; status: "prepared" | "started" | "failed" | "complete";
  proposal: ProductProposal | null; sessionId: string | null; usage: unknown;
  source?: ProductSourceRevision;
}
interface Delivery { digest: string; channelId: string; userId: string; since: number; messages: string[]; attempted: boolean; postId: string | null }
interface ProductJournal {
  version: 1; teamId: string; seatId: string;
  active: { causeId: string; remaining: number; refineGoalId: string | null; runId: string | null } | null;
  runs: Record<string, ModelRun>;
  vetting: Record<string, { source: ProductProposal; event: VettedEvent }>;
  deliveries: Record<string, Delivery>;
}
const now = () => new Date().toISOString();
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const idle = (): ProposalTurnResult => ({ status: "idle", proposals: [] });
export const productJournalFilename = (teamId: string) => `product-journal-${productRuntimeFilename(teamId)}`;
export const productProposalDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(validateProductProposal(value)), "utf8").digest("hex");
const proofId = (event: VettedEvent) => /^proposal-vetted:([a-z][a-z0-9-]*):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(event.id);
const published = (state: PlanningDocument, teamId: string) => (state.planningGoals ?? []).filter((goal) => goal.teamId === teamId && goal.workflowModel === "goals-v1" && goal.goalProposal && goal.stage !== "approved" && !goal.ceremony?.closure);
const queueOrder = (a: ProductQueueEntry, b: ProductQueueEntry) => a.proposal.rank - b.proposal.rank || a.proposal.proposalId.localeCompare(b.proposal.proposalId);

export function productProposalMessage(input: ProductProposal): string {
  const proposal = validateProductProposal(input);
  return [`## Proposed goal: ${proposal.summary}`, `Proposal: ${proposal.proposalId}\nGoal: ${proposal.goalId}\nRank: ${proposal.rank}`, `Mission: ${proposal.mission}`, "### Outcomes", ...proposal.outcomes.map((outcome) => `${outcome.number}. **${outcome.title}** — ${outcome.description}\n   Reason: ${outcome.reason}\n   Current code: ${outcome.currentCode.join(", ")}`), `### Owned files\n${proposal.ownedFiles.map((path) => `- ${path}`).join("\n")}`, `### Rationale\n${proposal.rationale}`, `### Risks\n${proposal.risks.join("\n") || "None identified."}`, `Recent retros: ${proposal.basedOnRetros.join(", ") || "None available."}`, "React ✅ to approve this exact proposal, or reply to redirect. Approval is the only human gate; Product does not start work."].join("\n\n");
}

function validateRecord(record: ProductRuntimeRecord, services: ProductProposalServices): void {
  if (record.version !== 1 || record.teamId !== services.teamId || record.seatId !== services.productSeatId || !Array.isArray(record.queue) || !Array.isArray(record.events) || !Array.isArray(record.handledEventIds) || record.handledEventIds.some((id) => typeof id !== "string")) throw new ProductTurnError("Product runtime identity or record is invalid.");
  for (const entry of record.queue) {
    entry.proposal = validateProductProposal(entry.proposal);
    if (entry.proposal.productSeatId !== services.productSeatId || !["proposed", "posted", "approved"].includes(entry.status) || ![entry.rootPostId, entry.proposalPostId].every((id) => id === null || typeof id === "string")) throw new ProductTurnError("Product queue provenance is invalid.");
  }
  if (new Set(record.queue.map((entry) => entry.proposal.proposalId)).size !== record.queue.length || new Set(record.queue.map((entry) => entry.proposal.rank)).size !== record.queue.length) throw new ProductTurnError("Product queue identities and ranks must be unique.");
  if (record.pending && ![record.pending.goalId, record.pending.proposalId, record.pending.deliveryId, record.pending.message].every((value) => typeof value === "string" && value.trim())) throw new ProductTurnError("Product delivery intent is invalid.");
}

/** One lock covers the queue, model intent, delivery and durable publication across processes. */
export async function proposeGoals(services: ProductProposalServices, event: WorkflowEvent): Promise<ProposalTurnResult> {
  if (!event || event.teamId !== services.teamId || (event.kind === "product-retry" && event.seatId !== services.productSeatId)) return idle();
  if (!Number.isFinite(Date.parse(event.at)) || (event.kind !== "startup" && (typeof event.id !== "string" || !event.id.trim()))) throw new ProductTurnError("Invalid Product event identity.");
  if (!["startup", "proposal", "proposal-vetted", "approval", "goal-closed", "redirect", "retry", "product-retry", "queue-changed"].includes(event.kind)) return idle();
  const name = productRuntimeFilename(services.teamId);
  return services.store.withGoalLock(name, async () => {
    const state = await services.store.read();
    const team = (state.teams as Team[]).find((item) => item.id === services.teamId);
    if (team?.workflowModel !== "goals-v1" || !team.seats.some((seat) => seat.id === services.productSeatId && seat.roles.length === 1 && seat.roles[0] === "Product")) return { status: "disabled", proposals: [] };
    const record = await services.store.readRuntimeFile<ProductRuntimeRecord>(name) ?? { version: 1, teamId: services.teamId, seatId: services.productSeatId, queue: [], events: [], handledEventIds: [], pending: null, failure: null, updatedAt: now() };
    validateRecord(record, services);
    const journal = await services.store.readRuntimeFile<ProductJournal>(productJournalFilename(services.teamId)) ?? { version: 1, teamId: services.teamId, seatId: services.productSeatId, active: null, runs: {}, vetting: {}, deliveries: {} };
    if (journal.version !== 1 || journal.teamId !== services.teamId || journal.seatId !== services.productSeatId || !journal.runs || !journal.vetting || !journal.deliveries || (journal.active && (!Number.isInteger(journal.active.remaining) || journal.active.remaining < 1 || journal.active.remaining > PRODUCT_QUEUE_CAP))) throw new ProductTurnError("Product recovery journal is invalid.");
    const turn = new ProductTurn(services, record, journal);
    try { return await withCircuitScope(services.store.runtimeDir, productCircuitScope(services.teamId, services.productSeatId), "product", () => turn.run(event)); }
    catch (error) {
      const message = isCircuitOpen(error) || error instanceof ProductTurnError || error instanceof ProductSnapshotError ? error.message : "Product turn failed; preserved runtime intent requires explicit retry.";
      record.failure = { at: now(), message, retryable: !isCircuitOpen(error) }; await turn.save(); throw new ProductTurnError(message, true);
    }
  });
}

class ProductTurn {
  private readonly shell: Shell;
  private readonly changed: ProductProposal[] = [];
  private refined = false;
  constructor(private readonly services: ProductProposalServices, private readonly record: ProductRuntimeRecord, private readonly journal: ProductJournal) { this.shell = circuitShell(services.shell ?? processShell); }
  private async state() { return this.services.store.read(); }
  private team(state: PlanningDocument): Team {
    const team = (state.teams as Team[]).find((item) => item.id === this.services.teamId);
    if (!team || team.workflowModel !== "goals-v1" || !team.seats.some((seat) => seat.id === this.services.productSeatId && seat.roles[0] === "Product")) throw new ProductTurnError("Product identity changed during the turn.");
    return team;
  }
  private async journalSave() { await this.services.store.saveRuntime(productJournalFilename(this.services.teamId), this.journal); }
  async save() {
    const state = await this.state(); this.team(state); validateRecord(this.record, this.services);
    assertProductQueueCapacity(this.record, published(state, this.services.teamId).map((goal) => ({ goalId: goal.id, proposalId: goal.goalProposal!.proposalId })));
    this.record.updatedAt = now(); await this.services.store.saveRuntime(productRuntimeFilename(this.services.teamId), this.record);
  }
  private emit(event: WorkflowEvent) { if (event.kind !== "startup" && !this.record.events.some((item) => item.kind !== "startup" && item.id === event.id)) this.record.events.push(event); }
  private async reconcile(): Promise<void> {
    const state = await this.state(); this.team(state);
    const goals = (state.planningGoals ?? []).filter((goal) => goal.teamId === this.services.teamId && goal.workflowModel === "goals-v1" && goal.goalProposal);
    for (const entry of this.record.queue) {
      const goal = goals.find((item) => item.id === entry.proposal.goalId);
      if (goal) {
        if (!equal(goal.goalProposal, entry.proposal)) throw new ProductTurnError("A queued proposal differs from its sealed durable goal.");
        entry.status = goal.stage === "approved" || goal.ceremony?.closure ? "approved" : "posted";
        entry.rootPostId = goal.mattermost.rootPostId; entry.proposalPostId = goal.mattermost.rootPostId;
      } else if (entry.status !== "proposed") throw new ProductTurnError("Posted or approved Product queue entry has no matching durable goal.");
    }
    for (const goal of published(state, this.services.teamId)) if (!this.record.queue.some((entry) => entry.proposal.goalId === goal.id)) this.record.queue.push({ proposal: validateProductProposal(goal.goalProposal), status: "posted", rootPostId: goal.mattermost.rootPostId, proposalPostId: goal.mattermost.rootPostId, vetting: null });
    this.record.queue = this.record.queue.filter((entry) => entry.status !== "approved" || entry.proposal.goalId === this.record.pending?.goalId).sort(queueOrder);
    assertProductQueueCapacity(this.record, published(state, this.services.teamId).map((goal) => ({ goalId: goal.id, proposalId: goal.goalProposal!.proposalId })));
  }
  private async vet(event: VettedEvent): Promise<boolean> {
    const entry = this.record.queue.find((item) => item.status === "proposed" && item.proposal.goalId === event.goalId && item.proposal.proposalId === event.vetting?.proposalId && item.proposal.goalId !== this.record.pending?.goalId);
    if (!entry) return false;
    const fields = event.vetting;
    const ids = proofId(event);
    const lead = this.team(await this.state()).seats.find((seat) => seat.roles[0] === "Team Lead");
    if (!ids || ids[1] !== entry.proposal.proposalId || ids[2] !== productProposalDigest(entry.proposal) || fields.leadSeatId !== lead?.id || !Array.isArray(fields.notes) || fields.notes.some((note) => typeof note !== "string") || !Number.isFinite(Date.parse(fields.at)) || !equal(Object.keys(fields).sort(), ["at", "leadSeatId", "notes", "ownedFiles", "proposalId"])) return false;
    const corrected = validateProductProposal({ ...entry.proposal, ownedFiles: validateOwnedFiles(fields.ownedFiles) });
    if (ids[3] !== productProposalDigest(corrected)) return false;
    this.journal.vetting[entry.proposal.proposalId] = { source: entry.proposal, event: structuredClone(event) }; await this.journalSave();
    entry.proposal = corrected; entry.vetting = structuredClone(fields); this.emit(structuredClone(event)); await this.save(); return true;
  }
  private async verifiedVetting(entry: ProductQueueEntry) {
    const proof = this.journal.vetting[entry.proposal.proposalId];
    const ids = proof && proofId(proof.event);
    const lead = this.team(await this.state()).seats.find((seat) => seat.roles[0] === "Team Lead");
    if (!proof || !ids || !entry.vetting || proof.event.goalId !== entry.proposal.goalId || ids[1] !== entry.proposal.proposalId || ids[2] !== productProposalDigest(proof.source) || ids[3] !== productProposalDigest(entry.proposal) || !equal(proof.event.vetting, entry.vetting) || entry.vetting.leadSeatId !== lead?.id || !equal(validateProductProposal({ ...proof.source, ownedFiles: entry.vetting.ownedFiles }), entry.proposal)) return null;
    return entry.vetting;
  }
  private async chatIdentity() {
    const chat = this.services.chat;
    if (!chat) throw new ProductTurnError("Product publication requires an authenticated own-bot chat adapter.");
    const state = await this.state(); const home = requireTeamHome(state, this.services.teamId);
    const product = this.team(state).seats.find((seat) => seat.id === this.services.productSeatId)!;
    const userId = await chat.ownUserId();
    if (userId !== product.externalIdentities.mattermost.userId || !await chat.isBot(userId)) throw new ProductTurnError("Product chat does not belong to the configured Product bot.");
    return { chat, home, userId };
  }
  private checkPost(post: Post, delivery: Delivery, deliveryId: string) {
    if (!post || typeof post.id !== "string" || !post.id.trim() || post.user_id !== delivery.userId || post.channel_id !== delivery.channelId || post.root_id !== "" || !delivery.messages.includes(post.message) || post.props?.indra_delivery_id !== deliveryId || !Number.isSafeInteger(post.create_at) || post.create_at <= 0 || (delivery.postId !== null && delivery.postId !== post.id)) throw new ProductTurnError("Product delivery does not match its own frozen root proposal.");
  }
  private async settleDelivery(): Promise<void> {
    const pending = this.record.pending; if (!pending) return;
    const entry = this.record.queue.find((item) => item.proposal.goalId === pending.goalId && item.proposal.proposalId === pending.proposalId);
    const delivery = this.journal.deliveries[pending.deliveryId];
    if (!entry || !delivery || delivery.digest !== productProposalDigest(entry.proposal) || pending.message !== productProposalMessage(entry.proposal)) throw new ProductTurnError("Product delivery intent lost its exact proposal revision.");
    const vetting = await this.verifiedVetting(entry);
    if (!vetting) throw new ProductTurnError("Publication needs revision-bound Team Lead vetting.");
    const { chat, home, userId } = await this.chatIdentity();
    if (home.channelId !== delivery.channelId || userId !== delivery.userId) throw new ProductTurnError("Product delivery identity changed; the intent is preserved.");
    const find = async () => {
      const matches = (await chat.since(delivery.channelId, delivery.since)).filter((post) => post.props?.indra_delivery_id === pending.deliveryId);
      if (matches.length > 1) throw new ProductTurnError("Multiple posts claim the same Product delivery identity.");
      if (matches[0]) this.checkPost(matches[0], delivery, pending.deliveryId);
      return matches[0];
    };
    let post = await find();
    if (!post) {
      if (delivery.attempted) throw new ProductTurnError("Product delivery acknowledgment is uncertain; GET recovery found no matching post, so no second POST was attempted.");
      delivery.attempted = true; await this.journalSave();
      const sent = await chat.post(delivery.channelId, pending.message, "", pending.deliveryId);
      this.checkPost(sent, delivery, pending.deliveryId); delivery.postId = sent.id; await this.journalSave();
      post = await find();
      if (!post) throw new ProductTurnError("Product post acknowledgment is awaiting GET verification; its delivery intent is preserved.");
    }
    delivery.postId = post.id; await this.journalSave();
    const existing = (await this.state()).planningGoals?.find((goal) => goal.id === entry.proposal.goalId);
    if (existing) {
      if (existing.teamId !== this.services.teamId || !equal(existing.goalProposal, entry.proposal) || existing.mattermost.rootPostId !== post.id || existing.mattermost.channelId !== delivery.channelId) throw new ProductTurnError("Recovered Product post differs from the durable published goal.");
    } else await this.services.store.publishProductProposal(this.services.teamId, entry.proposal, { id: post.id, userId: post.user_id, channelId: post.channel_id, rootId: post.root_id, createdAt: new Date(post.create_at).toISOString() }, vetting);
    entry.status = "posted"; entry.rootPostId = post.id; entry.proposalPostId = post.id;
    this.record.pending = null; this.record.failure = null;
    this.emit({ kind: "proposal", id: `product-published:${entry.proposal.proposalId}:${delivery.digest}:${post.id}`, teamId: this.services.teamId, goalId: entry.proposal.goalId, proposalId: entry.proposal.proposalId, at: now() });
    this.changed.push(entry.proposal); await this.save(); await this.reconcile(); await this.save();
  }
  private async publishNext(): Promise<void> {
    if (this.record.pending) { await this.settleDelivery(); return; }
    if (published(await this.state(), this.services.teamId).length) return;
    const entry = this.record.queue.filter((item) => item.status === "proposed").sort(queueOrder)[0];
    if (!entry || !await this.verifiedVetting(entry)) return;
    const { home, userId } = await this.chatIdentity();
    const message = productProposalMessage(entry.proposal); const digest = productProposalDigest(entry.proposal);
    const messages = [...new Set([message, personaPost(message, (await loadSeatPersonas())[this.services.productSeatId])])];
    if (messages.some((text) => Buffer.byteLength(text, "utf8") > 16_000)) throw new ProductTurnError("Product proposal exceeds the single-post delivery limit; refine it before publication.");
    const deliveryId = `product:${this.services.teamId}:${entry.proposal.proposalId}:${digest}`;
    this.journal.deliveries[deliveryId] ??= { digest, channelId: home.channelId, userId, since: Math.max(0, Date.now() - 5000), messages, attempted: false, postId: null }; await this.journalSave();
    this.record.pending = { goalId: entry.proposal.goalId, proposalId: entry.proposal.proposalId, deliveryId, message }; await this.save();
    await this.settleDelivery();
  }
  private async command(project: string, args: string[]): Promise<string> {
    const result = await this.shell.run("git", args, project);
    if (result.code !== 0) throw new ProductTurnError(`Product project read failed (git ${args[0]}, exit ${result.code}).`);
    return result.stdout;
  }
  private async project(github?: string): Promise<string> {
    github ??= requireTeamHome(await this.state(), this.services.teamId).github;
    const project = await ensureProjectCheckout(this.shell, this.services.store.runtimeDir, github);
    if (await realpath(project) !== join(await realpath(this.services.store.runtimeDir), "projects", ...github.split("/"))) throw new ProductTurnError("Product project checkout resolves outside its managed location.");
    const remote = (await this.command(project, ["remote", "get-url", "origin"])).trim();
    if (![ `https://github.com/${github}`, `https://github.com/${github}.git`, `git@github.com:${github}.git`, `ssh://git@github.com/${github}.git` ].includes(remote)) throw new ProductTurnError("Product checkout origin differs from the state-derived project.");
    return realpath(project);
  }
  private async source(): Promise<Source> {
    const { github } = requireTeamHome(await this.state(), this.services.teamId);
    const project = await this.project(github);
    const sha = (await this.command(project, ["rev-parse", "--verify", "refs/remotes/origin/main"])).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new ProductTurnError("Product project has no immutable origin/main.");
    const tree = (await this.command(project, ["ls-tree", "-r", "-z", sha])).split("\0").filter(Boolean).map((row) => /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/.exec(row)).filter((row): row is RegExpExecArray => row !== null).map((row) => row[2]);
    if (!tree.includes("docs/mission.md")) throw new ProductTurnError("The team's project has no regular docs/mission.md file.");
    const mission = await this.command(project, ["show", `${sha}:docs/mission.md`]);
    const retros = await Promise.all(tree.filter((path) => /^docs\/retros\/[a-z][a-z0-9-]*\.md$/.test(path)).map(async (path) => ({ path, time: Number((await this.command(project, ["log", "-1", "--format=%ct", sha, "--", path])).trim()) })));
    retros.sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
    return { github, project, sha, files: tree, mission, retros: await Promise.all(retros.slice(0, 3).map(async ({ path }) => ({ goalId: path.slice("docs/retros/".length, -3), text: await this.command(project, ["show", `${sha}:${path}`]) }))) };
  }
  private async meaningful(event: WorkflowEvent): Promise<boolean> {
    if (event.kind === "startup") return true;
    const state = await this.state();
    if (event.kind === "approval" || event.kind === "goal-closed") {
      const goal = state.planningGoals?.find((item) => item.id === event.goalId && item.teamId === this.services.teamId);
      return !!goal && (event.kind === "approval" ? goal.stage === "approved" : !!goal.ceremony?.closure);
    }
    if (event.kind !== "redirect") return false;
    const { chat, home } = await this.chatIdentity(); const redirect = event.redirect;
    if (!redirect || !Number.isFinite(Date.parse(redirect.at))) return false;
    const post = (await chat.since(home.channelId, Math.max(0, Date.parse(redirect.at) - 5000))).find((item) => item.id === redirect.postId);
    const goal = event.goalId === null ? null : state.planningGoals?.find((item) => item.id === event.goalId && item.teamId === this.services.teamId);
    if (!post || post.channel_id !== home.channelId || post.user_id !== redirect.userId || post.message !== redirect.message || this.team(state).seats.some((seat) => seat.externalIdentities.mattermost.userId === post.user_id) || await chat.isBot(post.user_id) || (event.goalId !== null && (!goal || (post.root_id || post.id) !== goal.mattermost.rootPostId))) return false;
    return true;
  }
  private async generate(event: WorkflowEvent): Promise<void> {
    const active = this.journal.active!;
    if (!this.services.runtimeFor) throw new ProductTurnError("Product generation requires runtimeFor to bind a read-only runtime to its immutable source snapshot.");
    let source: Source | undefined;
    let project: string | undefined;
    // A persisted finite budget, never a queue-changed/refinement feedback loop.
    while (active.remaining > 0) {
      let run = active.runId ? this.journal.runs[active.runId] : undefined;
      if (!run) {
        source ??= await this.source();
        const target = active.refineGoalId ? this.record.queue.find((entry) => entry.proposal.goalId === active.refineGoalId && entry.status === "proposed" && entry.proposal.goalId !== this.record.pending?.goalId) : undefined;
        if (active.refineGoalId && !target) throw new ProductTurnError("The unpublished refinement target is no longer available.");
        const identity = target ? { goalId: target.proposal.goalId, proposalId: target.proposal.proposalId, rank: target.proposal.rank } : { goalId: `goal-${randomUUID()}`, proposalId: `proposal-${randomUUID()}`, rank: Math.max(0, ...this.record.queue.map((entry) => entry.proposal.rank)) + 1 };
        const repo = source.github;
        const prompt = [`Repo: ${repo}\nBase: origin/main at ${source.sha}\nRole: Product. Read-only proposal turn; no implementation branch or PR.`, `Proposal identity: ${JSON.stringify({ ...identity, productSeatId: this.services.productSeatId })}`, "Outcome (what must be true when done):\n1. Return one useful ProductProposal grounded in the mission and available recent retros. Keep the exact identity and rank above, mission docs/mission.md, numbered outcomes with reasons and existing repository-relative currentCode file pointers.\n2. Propose nonempty safe ownedFiles globs, concrete rationale and risks. Read current code at the immutable base; do not infer completion from another agent's text.\n3. Preserve published/approved scope. Propose only: no edits, posts, approvals, work dispatch, checks, commits, credentials or servers. Start no workers or background processes.", `Mode: ${target ? "Refine this unpublished proposal without changing its identity or rank" : "Add a distinct next ranked goal"}.\nTarget: ${JSON.stringify(target?.proposal ?? null)}`, `Current queue: ${JSON.stringify(this.record.queue.map(({ proposal, status }) => ({ proposal, status })))}`, `Existing goals: ${JSON.stringify((await this.state()).planningGoals?.map((goal) => ({ id: goal.id, summary: goal.goal, stage: goal.stage, closed: !!goal.ceremony?.closure })) ?? [])}`, `Trigger: ${JSON.stringify(event)}`, `Mission:\n${source.mission}`, `Recent retros (use only these goal IDs for basedOnRetros):\n${source.retros.map((retro) => `${retro.goalId}:\n${retro.text}`).join("\n\n") || "None available."}`, `Current code files (first 1000; the complete immutable Git tree remains readable):\n${source.files.slice(0, 1000).join("\n")}`, "Report only the strict ProductProposal output. Other seats own implementation, scheduling, release and approval. You are not alone in the repository; leave all checkouts and runtime resources unchanged."].join("\n\n");
        if (Buffer.byteLength(prompt, "utf8") > 240_000) throw new ProductTurnError("Product context exceeds the bounded prompt size.");
        run = { ...identity, sourceDigest: target ? productProposalDigest(target.proposal) : null, prompt, files: source.files, retroIds: source.retros.map((retro) => retro.goalId), status: "prepared", proposal: null, sessionId: null, usage: null, source: { github: repo, sha: source.sha, snapshots: [] } };
        active.runId = randomUUID(); this.journal.runs[active.runId] = run; await this.journalSave();
      }
      if (run.status === "started" || run.status === "failed") throw new ProductTurnError("Interrupted Product context requires an explicit retry; accepted drafts are preserved.");
      if (run.status === "prepared") {
        const github = requireTeamHome(await this.state(), this.services.teamId).github;
        const recorded = /^Repo: ([^\n]+)\nBase: origin\/main at ([0-9a-f]{40})\nRole: Product\./.exec(run.prompt);
        if (!recorded || recorded[1] !== github || (run.source && (run.source.github !== github || run.source.sha !== recorded[2]))) throw new ProductTurnError("Product's saved prompt no longer matches its recorded source base.");
        // Older journals did not record a checkout. Recover only the immutable base in their saved prompt.
        run.source ??= { github, sha: recorded[2], snapshots: [] };
        let snapshot = run.source.snapshots.at(-1);
        if (!snapshot || snapshot.status === "preserved") {
          snapshot = { id: randomUUID(), status: "prepared" }; run.source.snapshots.push(snapshot); await this.journalSave();
        }
        project ??= source?.project ?? await this.project();
        const snapshots = new ProductSourceSnapshots(this.shell, project, this.services.teamId, this.services.productSeatId);
        const cwd = await snapshots.prepare(run.source, active.runId!, snapshot);
        snapshot.status = "ready";
        const runtime = circuitRuntime(this.services.runtimeFor(cwd), this.services.store.runtimeDir, productCircuitScope(this.services.teamId, this.services.productSeatId), "product", `draft:${active.runId}:${snapshot.id}`, run.source.snapshots.length > 1);
        run.status = "started"; await this.journalSave();
        try {
          const result = await runtime.message(run.prompt, schemaPathOf(import.meta.url, "product-proposal.json"), undefined, { timeoutMs: DRAFT_TIMEOUT_MS, purpose: "product-proposal" });
          const proposal = validateProductProposal(result.response);
          const prose = JSON.stringify({ mission: proposal.mission, summary: proposal.summary, outcomes: proposal.outcomes, ownedFiles: proposal.ownedFiles, risks: proposal.risks, rationale: proposal.rationale });
          if (proposal.goalId !== run.goalId || proposal.proposalId !== run.proposalId || proposal.productSeatId !== this.services.productSeatId || proposal.rank !== run.rank || proposal.mission !== "docs/mission.md" || proposal.basedOnRetros.some((id) => !run!.retroIds.includes(id)) || proposal.outcomes.some((outcome) => !outcome.currentCode.length || outcome.currentCode.some((path) => !run!.files.includes(path.replace(/:\d+(?::\d+)?$/, "")))) || redactSecrets(prose) !== prose) throw new ProductTurnError("Product output changed its reserved identity or invented source evidence.");
          run.proposal = proposal; run.sessionId = result.sessionId; run.usage = result.usage ?? null; run.status = "complete"; await this.journalSave();
        } catch (error) { run.status = "failed"; await this.journalSave(); throw error; }
      }
      const proposal = validateProductProposal(run.proposal);
      const existing = this.record.queue.find((entry) => entry.proposal.goalId === proposal.goalId);
      const durable = (await this.state()).planningGoals?.find((goal) => goal.id === proposal.goalId);
      const queueEventId = `product-queue:${proposal.proposalId}:${productProposalDigest(proposal)}`;
      const accepted = this.record.events.some((event) => event.kind === "queue-changed" && event.id === queueEventId)
        && (equal(existing?.proposal, proposal) || equal(durable?.goalProposal, proposal));
      if (!accepted) {
        if (existing) {
          if (existing.status !== "proposed" || run.sourceDigest !== productProposalDigest(existing.proposal)) throw new ProductTurnError("Product refinement would overwrite a newer or sealed proposal.");
          existing.proposal = proposal; existing.vetting = null; this.refined = true;
        } else {
          if (run.sourceDigest !== null || durable) throw new ProductTurnError("Product draft identity is already durable or no longer queued.");
          this.record.queue.push({ proposal, status: "proposed", rootPostId: null, proposalPostId: null, vetting: null });
        }
        delete this.journal.vetting[proposal.proposalId]; this.record.queue.sort(queueOrder);
        this.emit({ kind: "queue-changed", id: queueEventId, teamId: this.services.teamId, at: now() });
        await this.save(); this.changed.push(proposal);
      }
      const completedRunId = active.runId!;
      active.remaining--; active.runId = null;
      if (active.remaining === 0) { this.record.handledEventIds.push(active.causeId); this.journal.active = null; await this.save(); }
      await this.journalSave();
      const snapshot = run.source?.snapshots.at(-1);
      if (run.source && snapshot?.status === "ready") {
        project ??= source?.project ?? await realpath(projectCheckoutPath(this.services.store.runtimeDir, run.source.github)).catch(() => undefined);
        if (project && await new ProductSourceSnapshots(this.shell, project, this.services.teamId, this.services.productSeatId).retire(run.source, completedRunId, snapshot)) {
          snapshot.status = "removed"; await this.journalSave();
        }
      }
    }
  }
  async run(event: WorkflowEvent): Promise<ProposalTurnResult> {
    const key = event.kind === "startup" ? `product-startup:${this.services.teamId}` : event.id;
    const retry = event.kind === "retry" || event.kind === "product-retry";
    if (retry) await new CircuitBudget({ runtimeDir: this.services.store.runtimeDir, scopeId: productCircuitScope(this.services.teamId, this.services.productSeatId) }).assertAvailable();
    // A retry is one durable attempt, including when it fails or the host restarts before receipt.
    if (retry && this.record.handledEventIds.includes(key)) return this.result();
    if (this.record.failure && !retry) {
      // The host receipts this turn: retain incoming vetting even while generation/delivery is blocked.
      if (event.kind === "proposal-vetted" && !this.record.handledEventIds.includes(key) && await this.vet(event)) {
        this.record.handledEventIds.push(key); await this.save();
      }
      return this.result();
    }
    if (retry) { this.record.handledEventIds.push(key); await this.save(); }
    await this.reconcile();
    if (this.journal.active && this.record.handledEventIds.includes(this.journal.active.causeId)) { this.journal.active = null; await this.journalSave(); }
    // Recover a saved vetted revision before startup deduplication, but leave recorded failures
    // at the event boundary so the host can consume an operator's explicit retry.
    if (this.record.pending || event.kind === "startup" || event.kind === "proposal-vetted" || retry) await this.publishNext();
    if (!retry && this.record.handledEventIds.includes(key)) return this.result();
    if (event.kind === "proposal-vetted") { if (!await this.vet(event)) return this.result(); await this.publishNext(); this.record.handledEventIds.push(key); await this.save(); return this.result(); }
    // Own queue/proposal receipts settle. They never generate or invalidate a draft awaiting vetting.
    if (event.kind === "queue-changed" || event.kind === "proposal") { await this.publishNext(); return this.result(); }
    if (retry) {
      if (!this.record.failure && !this.journal.active) return this.result();
      this.record.failure = null;
      const active = this.journal.active; const run = active?.runId ? this.journal.runs[active.runId] : undefined;
      if (run && ["prepared", "failed", "started"].includes(run.status)) {
        // A fresh attempt keeps the reserved proposal and prompt/base, while preserving failed or uncertain source copies.
        const snapshot = run.source?.snapshots.at(-1);
        if (snapshot) snapshot.status = "preserved";
        run.status = "prepared";
      }
      await this.journalSave(); await this.save();
    } else if (!this.journal.active && await this.meaningful(event)) {
      const available = PRODUCT_QUEUE_CAP - this.record.queue.filter((entry) => entry.status !== "approved").length;
      const target = [...this.record.queue].sort(queueOrder).reverse().find((entry) => entry.status === "proposed" && entry.proposal.goalId !== this.record.pending?.goalId);
      if (available > 0 || target) this.journal.active = { causeId: key, remaining: available > 0 ? available : 1, refineGoalId: available > 0 ? null : target!.proposal.goalId, runId: null };
      await this.journalSave();
    }
    if (this.journal.active) await this.generate(event);
    await this.publishNext();
    if (!this.record.handledEventIds.includes(key)) this.record.handledEventIds.push(key);
    this.record.failure = null; await this.save(); return this.result();
  }
  private result(): ProposalTurnResult {
    return { status: this.record.failure ? "blocked" : this.changed.length ? this.refined ? "refined" : "proposed" : "idle", proposals: [...new Map(this.changed.map((proposal) => [proposal.proposalId, proposal])).values()] };
  }
}
