from pathlib import Path
p=Path('src/sprint.ts');s=p.read_text().replace('if (before.reviewed || before.rejection) return;', 'if (before.reviewer === "satori-miyamoto" && (before.reviewed || before.rejection)) return;');p.write_text(s)
p=Path('src/retro-publication.ts');s=p.read_text().replace('was rejected by satori-miyamoto on its current head', 'was rejected by ${typeof pr.rejection.reviewId === "number" ? "satori-miyamoto" : "independent-agent"} on its current head');p.write_text(s)
p=Path('tests/retro-publication.test.ts');s=p.read_text().replace('async function rejectedPublication(priorFailure = false)', 'async function rejectedPublication(priorFailure = false, localReview = false)').replace('reviewId: 7, submittedAt: new Date().toISOString()', 'reviewId: localReview ? `agent:${"a".repeat(64)}` : 7, submittedAt: new Date().toISOString()').replace('expect.stringContaining("rejected by satori-miyamoto")', 'expect.stringContaining(`rejected by ${localReview ? "independent-agent" : "satori-miyamoto"}`)')
pos=s.index('  it("corrects a rejected frozen publication')
s=s[:pos]+'''  it("recovers local agent rejection only through a fresh retry, retaining its proof identity", async () => {
    const f = await rejectedPublication(false, true);
    await f.restart().poll(f.context); expect(f.draft).toHaveBeenCalledTimes(1);
    await f.restart().poll(retryContext(f, "correct-local-rejection"));
    expect(f.record().revisions![0].rejection.reviewId).toBe(`agent:${"a".repeat(64)}`);
    expect(f.services.review).toHaveBeenCalledTimes(2); expect(f.draft).toHaveBeenCalledTimes(2);
    f.pr.checksPassed = true; expect((await f.restart().poll(f.context)).status).toBe("complete");
    expect(f.services.review).toHaveBeenCalledTimes(2);
  });

''' +s[pos:];p.write_text(s)
