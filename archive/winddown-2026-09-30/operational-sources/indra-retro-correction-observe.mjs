import { readFile } from 'node:fs/promises';
const path = '/Users/ryan/The Source/indra-state.runtime/retro-publication-goal-b802a303-4685-4a02-bdd1-f6eb6b5cb14c.json';
const record = JSON.parse(await readFile(path, 'utf8'));
const summary = (publication) => ({
  attempts: publication.attempts?.map((attempt) => ({ startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, errorKind: attempt.errorKind, generationStatus: attempt.generation?.status, sessionId: attempt.generation?.sessionId, retryId: attempt.retry?.id })),
  frozenHash: publication.frozen?.sha256,
  postIds: publication.postIds,
  headSha: publication.headSha ?? publication.gate?.headSha,
  review: publication.review && { headSha: publication.review.headSha, findingCount: publication.review.result?.findings?.length },
  correction: publication.correction && { revision: publication.correction.revision, resultHeadSha: publication.correction.resultHeadSha, noticePostId: publication.correction.notice?.postId },
});
console.log(JSON.stringify({ goalId: record.goalId, current: summary(record), previous: record.revisions?.map(summary), prUrl: record.prUrl, failure: record.failure, verifiedAt: record.verifiedAt }, null, 2));
