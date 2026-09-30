from pathlib import Path
p=Path('src/sprint.ts'); s=p.read_text().replace('import { homedir } from "node:os";\n','')
s=s.replace('import { ownedFileMatches', 'import { inspectReview, postReviewComment, reviewOnce, type ReviewRejection, type Reviewer } from "./review-evidence.js";\nimport { ownedFileMatches')
s=s.replace('A fresh approval from the review account on this exact head, with no outstanding change requests.', 'Host-verified independent approval on this exact head, or historical delivered bot evidence.')
s=s.replace('reviewed: boolean; checksPassed: boolean;', 'reviewed: boolean; checksPassed: boolean; reviewer?: Reviewer;')
s=s.replace('Latest delivered bot verdict rejects this exact open head; historical or dismissed findings are insufficient.', 'Validated local or historical delivered verdict rejects this exact open head.')
s=s.replace('export interface RetroRejection { reviewId: number; headSha: string; submittedAt: string }','export type RetroRejection = ReviewRejection;')
a=s.index('  /** One independent bot review'); b=s.index('  /** Creates `sprint/', a)
s=s[:a]+'''  /** A fresh read-only callback creates durable exact-head proof before optional comment delivery. */
  async reviewIntegration(github: string, goalId: string, prUrl: string, headSha: string, review: (cwd: string) => Promise<unknown>): Promise<void> {
    const endpoint = this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid integration review head.");
    const verify = async () => {
      const current = await this.inspectMerge(prUrl);
      if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Integration changed during review.");
    };
    const before = await this.inspectMerge(prUrl);
    if (before.headSha !== headSha || before.state !== "OPEN") throw new SprintError("Integration changed before review.");
    // Historical approvals/rejections are readable; a rejected immutable head cannot silently get a new verdict.
    if (before.reviewed || before.rejection) return;
    await reviewOnce(this.runtimeDir, prUrl, headSha, async () => {
      const details = JSON.parse((await this.must("gh", ["pr", "view", prUrl, "--json", "baseRefName,isCrossRepository"])).stdout) as { baseRefName?: string; isCrossRepository?: boolean };
      if (details.baseRefName !== "main" || details.isCrossRepository !== false) throw new SprintError("Integration review requires the project's main target.");
      const cwd = await ensureProjectCheckout(this.shell, this.runtimeDir, github);
      await this.must("git", [...GH_CREDENTIAL, "fetch", "origin", `refs/pull/${prUrl.split("/").at(-1)}/head`], cwd);
      const root = join(this.runtimeDir, "worktrees"); await mkdir(root, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(root, `integration-review-${goalId}-`)); const checkout = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", checkout, headSha], cwd);
        const value = await review(checkout) as RetroReview;
        const files = await this.retroPages<{ filename: string }>(`${endpoint}/files?per_page=100`);
        if (typeof value?.summary !== "string" || !Array.isArray(value.findings) || value.findings.some((finding) => !finding || !files.some((file) => file.filename === finding.path))) throw new SprintError("Invalid integration reviewer findings.");
        return value;
      } finally { if ((await this.run("git", ["worktree", "remove", "--force", checkout], cwd)).code === 0) await rm(temp, { recursive: true, force: true }); }
    }, verify, async (proof) => { await postReviewComment(this.shell, dirname(this.runtimeDir), proof); });
  }

''' +s[b:]
s=s.replace('    const github = prUrl.split("/").slice(3, 5).join("/"); const number = prUrl.split("/").at(-1)!;\n','',1)
a=s.index('    const reviews = await this.retroPages',s.index('  async inspectMerge')); b=s.index('    const checks = ',a)
s=s[:a]+'''    const review = await inspectReview(this.runtimeDir, this.shell, dirname(this.runtimeDir), prUrl, before.headRefOid, before.author.login, before.reviewDecision);
''' +s[b:]
s=s.replace('Array.isArray(rows) && rows.some((row) => row.name === "checks") && rows.every((row) => row.bucket === "pass")','Array.isArray(rows) && rows.length > 0 && rows.every((row) => typeof row?.name === "string" && !!row.name && row.bucket === "pass")')
s=s.replace('return { url: prUrl, state: before.state, headSha: before.headRefOid, reviewed, checksPassed,','return { url: prUrl, state: before.state, headSha: before.headRefOid, reviewed: !before.isDraft && review.reviewed, reviewer: review.reviewer, checksPassed,\n      ...(before.state === "OPEN" && !before.isDraft && review.rejection ? { rejection: review.rejection } : {}),')
a=s.index('  /**\n   * Read-only preflight'); b=s.index('  /** Current-head bot approval',a); s=s[:a]+s[b:]
s=s.replace('    const blocker = await this.serverMergeBlocker(prUrl, before.headSha);\n    if (blocker) return { merged: false, reason: blocker };\n','')
s=s.replace('    const blocker = await this.serverMergeBlocker(prUrl, headSha);\n    if (blocker) return { merged: false, reason: blocker };\n','')
s=s.replace('    // GitHub enforces the Code Owner verdict at mutation time; the SHA precondition pins this attempt.','    // The host has verified its exact-head proof and CI; the SHA precondition pins this attempt.')
s=s.replace('reviewer: "satori-miyamoto", checksPassed: true','reviewer: proof.reviewer!, checksPassed: true')
s=s.replace('!Number.isSafeInteger(rejection.reviewId) || rejection.reviewId < 1','!(typeof rejection.reviewId === "number" ? Number.isSafeInteger(rejection.reviewId) && rejection.reviewId > 0 : /^agent:[0-9a-f]{64}$/.test(rejection.reviewId))')
a=s.index('    const reviews = await this.retroPages',s.index('  async inspectRetroPr')); b=s.index('    const checks = ',a)
s=s[:a]+'''    const review = await inspectReview(this.runtimeDir, this.shell, dirname(this.runtimeDir), prUrl, pr.headRefOid, pr.author.login, pr.reviewDecision);
''' +s[b:]
a=s.index('    const rejection = ',s.index('  async inspectRetroPr')); b=s.index('\n  }',a)
s=s[:a]+'''    return { url: prUrl, state: pr.state, headSha: pr.headRefOid, mergedSha: pr.mergeCommit?.oid, reviewed: review.reviewed && !pr.isDraft, reviewer: review.reviewer, checksPassed,
      ...(pr.state === "OPEN" && !pr.isDraft && review.rejection ? { rejection: review.rejection } : {}) };''' +s[b:]
a=s.index('  /** A fresh read-only reviewer sees'); b=s.index('  /** The publication adapter',a)
s=s[:a]+'''  /** A fresh read-only reviewer sees the pinned checkout; the host owns the resulting proof. */
  async reviewRetroPr(github: string, goalId: string, markdown: string, prUrl: string, headSha: string, review: (worktree: string) => Promise<RetroReview>): Promise<void> {
    this.retroRepo(github, goalId, prUrl);
    if (!SHA.test(headSha)) throw new SprintError("Invalid retrospective review head.");
    const verify = async () => {
      const current = await this.inspectRetroPr(github, goalId, markdown, prUrl);
      if (current.state !== "OPEN" || current.headSha !== headSha) throw new SprintError("Retrospective PR changed during review.");
    };
    const before = await this.inspectRetroPr(github, goalId, markdown, prUrl);
    if (before.headSha !== headSha || before.state !== "OPEN") throw new SprintError("Retrospective PR changed before review.");
    if (before.reviewed || before.rejection) return;
    await reviewOnce(this.runtimeDir, prUrl, headSha, async () => {
      const project = await this.retroCheckout(github);
      const worktrees = join(this.runtimeDir, "worktrees"); await mkdir(worktrees, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(worktrees, `retro-review-${goalId}-`)); const worktree = join(temp, "checkout");
      try {
        await this.must("git", ["worktree", "add", "--detach", worktree, headSha], project);
        const result = await review(worktree);
        if (typeof result?.summary !== "string" || !Array.isArray(result.findings) || result.findings.some((item) => !item || item.path !== retroPath(goalId)
          || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > markdown.split("\\n").length || typeof item.reason !== "string" || !item.reason.trim())) throw new SprintError("Invalid retrospective review findings.");
        return result;
      } finally {
        if ((await this.run("git", ["worktree", "remove", "--force", worktree], project)).code === 0) await rm(temp, { recursive: true, force: true });
      }
    }, verify, async (proof) => { await postReviewComment(this.shell, dirname(this.runtimeDir), proof); });
  }

''' +s[b:]
s=s.replace('current-head bot approval','current-head independent approval').replace('Current-head bot approval','Current-head independent approval').replace('Current-head satori-miyamoto approval','Current-head independent approval').replace('fresh satori-miyamoto review','fresh independent review').replace('same delivered bot rejection','same verified review rejection').replace('Protected merge is not verified','Merge is not verified').replace('exact-head bot/CI gate','exact-head review/CI gate').replace('bot review and CI','independent review and CI')
s=s.replace('!proof.reviewed || !proof.checksPassed || view.baseRefName','!proof.reviewed || proof.reviewer !== lane.reviewer || !proof.checksPassed || view.baseRefName')
p.write_text(s)
p=Path('src/developer-seat.ts');s=p.read_text().replace('requireApprovedReview(this.shell, record.prUrl!, record.worktree)', 'requireApprovedReview(this.shell, record.prUrl!, record.worktree, this.store.runtimeDir)').replace('requireApprovedReview(this.shell, prUrl!, project)','requireApprovedReview(this.shell, prUrl!, project, this.store.runtimeDir)')
a=s.index('        const blocker = await new SprintGitHub'); b=s.index('        await this.event(record, { kind: "merge", result: landed ?',a)
s=s[:a]+'''        const result = await new SprintGitHub(this.shell, this.store.runtimeDir).merge(prUrl!, async (head) => {
          if (head !== checkedHead) throw new SeatError("PR head changed after CI; not merging.");
          await this.event(record, { kind: "merge", result: "started", headSha: checkedHead });
        });
        const landed = result.merged;
''' +s[b:]
s=s.replace('        await this.factsFor(goal.id, record.outcomeId).retain(record);','        if (!await new SprintGitHub(this.shell, this.store.runtimeDir).mergeVerification(record.prUrl!)) throw new SeatError("Merged assignment lacks verified current-head review and passing CI.");\n        await this.factsFor(goal.id, record.outcomeId).retain(record);')
p.write_text(s)
