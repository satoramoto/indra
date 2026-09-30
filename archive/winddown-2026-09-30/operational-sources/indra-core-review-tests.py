from pathlib import Path
p=Path('tests/sprint.test.ts');s=p.read_text().replace('import { SprintError', 'import { readReviewEvidence, reviewOnce, reviewEvidencePath } from "../src/review-evidence.js";\nimport { SprintError')
a=s.index('function policyEvidence(');b=s.index('class GitHub',a);s=s[:a]+s[b:]
s=s.replace('  reviewer = "satori-miyamoto";', '  reviewer = "owner";\n  comments: { body: string }[] = [];\n  reviewDecision = "";')
s=s.replace('  protectedTarget = true;', '  protectedTarget = false;')
a=s.index('    if (command === "env")');b=s.index('    if (command !== "gh")',a);s=s[:a]+s[b:]
s=s.replace('    if (args[0] === "api") {','''    if (args[0] === "api") {
      if (args[1].includes("/comments?")) return ok(JSON.stringify([this.comments]));
      if (args[1].endsWith("/comments") && args.includes("POST")) {
        if (this.refuseReview) return ok("", 1);
        this.comments.push(JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8")));
        return ok("", this.loseReview ? 1 : 0);
      }''',1)
s=s.replace('      const policy = policyEvidence(args[1], this.head(), this.protectedTarget);\n      if (policy) return ok(JSON.stringify(policy));\n','')
s=s.replace('mergeCommit: this.state === "MERGED" ? { oid: this.head() } : null, reviewDecision: "",','mergeCommit: this.state === "MERGED" ? { oid: this.head() } : null, reviewDecision: this.reviewDecision,')
s=s.replace('    expect(f.shell.reviews).toHaveLength(1);\n    expect(f.shell.reviews[0]).toMatchObject({ state: "CHANGES_REQUESTED", commit_id: f.shell.head(), comments: [{ path, line: 1, side: "RIGHT", body: "Incorrect result" }] });\n    expect(f.shell.reviews[0].body).toContain("indra-integration-review:");','''    expect(f.shell.comments).toHaveLength(1);
    expect(await readReviewEvidence(f.runtimeDir, url, f.shell.head())).toMatchObject({ verdict: "REQUEST_CHANGES", findings: [{ path, line: 1, reason: "Incorrect result" }] });
    expect(f.shell.comments[0].body).toContain(f.shell.head());''')
s=s.replace('''    expect(shell.reviews).toHaveLength(1);
    expect(shell.reviews[0]).toMatchObject({ commit_id: shell.head(), user: { login: "satori-miyamoto" }, state: findings ? "CHANGES_REQUESTED" : "APPROVED",
      comments: findings ? [{ path, line: 3, side: "RIGHT", body: "Missing recorded evidence." }] : [] });''','''    expect(shell.comments).toHaveLength(1);
    expect(await readReviewEvidence(runtimeDir, url, shell.head())).toMatchObject({ headSha: shell.head(), reviewer: "independent-agent", verdict: findings ? "REQUEST_CHANGES" : "APPROVE",
      findings: findings ? [{ path, line: 3, reason: "Missing recorded evidence." }] : [] });''')
s=s.replace('expect(shell.calls.filter((call) => call.command === "env").every((call) => call.args.includes("user") || call.args.some((arg) => arg.endsWith("/reviews")))).toBe(true);','expect(shell.calls.some((call) => call.command === "env")).toBe(false);')
s=s.replace('  async function rejectedArchive() {','  async function rejectedArchive(local = false) {')
s=s.replace('    await f.github.reviewRetroPr("test/project", goal, content, url, f.shell.head(), async () => ({ summary: "Correct the unsupported count", findings: [{ path, line: 3, reason: "Missing recorded Product history." }] }));','''    if (local) await f.github.reviewRetroPr("test/project", goal, content, url, f.shell.head(), async () => ({ summary: "Correct the unsupported count", findings: [{ path, line: 3, reason: "Missing recorded Product history." }] }));
    else f.shell.reviews.push({ id: 1, user: { login: "satori-miyamoto" }, state: "CHANGES_REQUESTED", commit_id: f.shell.head(), submitted_at: "2026-01-01T00:00:00.000Z" });''')
s=s.replace('    expect(rejection).toEqual({ reviewId: 1, headSha: f.shell.head(), submittedAt: "2026-01-01T00:00:00.000Z" });','    expect(rejection).toEqual({ reviewId: local ? expect.stringMatching(/^agent:[a-f0-9]{64}$/) : 1, headSha: f.shell.head(), submittedAt: local ? expect.any(String) : "2026-01-01T00:00:00.000Z" });')
a=s.index('  it.each(["unprotected", "unreadable"])("never attempts');b=s.index('  it.each(["stale", "author"',a)
s=s[:a]+'''  it.each([false, true])("corrects a verified rejection and merges on new host approval despite historical GitHub changes requests (local rejection: %s)", async (local) => {
    const f = await rejectedArchive(local); const old = f.shell.head();
    f.shell.reviews.push({ id: 10, user: { login: "satori-miyamoto" }, state: "CHANGES_REQUESTED", commit_id: old, submitted_at: "2026-01-01T00:00:00.000Z" });
    f.shell.reviewDecision = "CHANGES_REQUESTED"; f.shell.policyUnavailable = true;
    const head = await f.github.correctRetroPr("test/project", goal, content, replacement, url, f.rejection);
    expect((await f.github.mergeRetroPr("test/project", goal, replacement, url, head)).merged).toBe(false);
    const review = vi.fn(async () => ({ summary: "Corrected evidence verified", findings: [] }));
    await f.github.reviewRetroPr("test/project", goal, replacement, url, head, review);
    f.shell.checks = []; expect((await f.github.mergeRetroPr("test/project", goal, replacement, url, head)).merged).toBe(false);
    f.shell.checks = [{ name: "checks", bucket: "pass" }];
    expect((await f.github.mergeRetroPr("test/project", goal, replacement, url, head)).merged).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(f.shell.calls.some((call) => call.command === "env" || call.args.some((arg) => /protection|permission|codeowners/i.test(arg)))).toBe(false);
    expect(f.shell.reviews[0].commit_id).toBe(old);
  });

''' +s[b:]
a=s.index('describe("server-enforced bot review policy"');b=s.index('describe("integration and revert automatic merge gate"',a);s=s[:a]+s[b:]
a=s.index('      if (args[0] === "api" && !args[1].includes("/reviews?"))');b=s.index('      if (args[1] === "view")',a);s=s[:a]+s[b:]
a=s.index('  it.each(["unprotected", "unreadable"])("does not attempt');b=s.index('  it.each(["DISMISSED", "CHANGES_REQUESTED"])',a)
s=s[:a]+'''  it.each(["approved", "rejected", "missing", "stale", "wrong-pr", "failed-ci", "empty-ci", "closed", "unverified"])("enforces host proof and CI without repository policy APIs (%s)", async (problem) => {
    const shell = new Gate(); shell.protectedTarget = false; shell.verdict = "CHANGES_REQUESTED";
    const runtime = await mkdtemp(join(tmpdir(), "indra-review-gate-")); roots.push(runtime);
    if (problem !== "missing") await reviewOnce(runtime, url, problem === "stale" ? "b".repeat(40) : shell.head, async () => ({ summary: "Checked", findings: problem === "rejected" ? [{ path: "a.ts", line: 1, reason: "Wrong result" }] : [] }), async () => {});
    if (problem === "wrong-pr") {
      const file = reviewEvidencePath(runtime, url, shell.head); const proof = JSON.parse(await readFile(file, "utf8")); proof.prUrl = url + "2"; await writeFile(file, JSON.stringify(proof));
      await expect(new SprintGitHub(shell, runtime).merge(url)).rejects.toThrow("proof is invalid"); return;
    }
    if (problem === "failed-ci") shell.checks[0].bucket = "fail";
    if (problem === "empty-ci") shell.checks = [];
    if (problem === "closed") shell.state = "CLOSED";
    if (problem === "unverified") shell.pending = true;
    expect((await new SprintGitHub(shell, runtime).merge(url)).merged).toBe(problem === "approved");
    expect(shell.calls.some((args) => args.some((arg) => /protection|permission|codeowners/i.test(arg)))).toBe(false);
    expect(shell.calls.some((args) => args.includes("--admin") || args.includes("--auto"))).toBe(false);
  });
''' +s[b:]
p.write_text(s)
