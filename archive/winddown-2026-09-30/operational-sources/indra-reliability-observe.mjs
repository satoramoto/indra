import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = '/Users/ryan/The Source/indra-state.runtime';
const stateRoot = '/Users/ryan/The Source/indra-state';
const goal = 'goal-b802a303-4685-4a02-bdd1-f6eb6b5cb14c';
const files = new Set([`scheduler-work-team-001-${goal}.json`, `goal-workflow-${goal}.json`, `developer-goal-workflow-${goal}.json`, 'product-workflow-team-001.json', 'product-journal-product-workflow-team-001.json']);
const previous = new Map();
async function report(name) {
  const value = JSON.parse(await readFile(join(root, name), 'utf8'));
  let status;
  if (name.startsWith('scheduler-work-')) status = { failure: value.failure };
  else if (name.startsWith('developer-goal-')) status = { failures: value.failures, lanes: Object.entries(value.lanes ?? {}).map(([id, lane]) => ({ id, attempt: lane.attempt, built: lane.built, prUrl: lane.prUrl, headSha: lane.headSha, mergedSha: lane.mergedSha, sessions: lane.sessions.map(({ key, status }) => ({ key, status })) })) };
  else if (name.startsWith('goal-workflow-')) status = { failure: value.failure, assignment: value.assignment?.status, lanes: value.lanes?.map(({ id, status, prUrl, headSha, mergedSha, review, ci }) => ({ id, status, prUrl, headSha, mergedSha, review, ci })), report: value.report ? { status: value.report.status, headSha: value.report.headSha } : null };
  else if (name.startsWith('product-journal-')) status = { active: value.active, runs: Object.entries(value.runs ?? {}).map(([id, run]) => ({ id, status: run.status, source: run.source ? { sha: run.source.sha, snapshots: run.source.snapshots } : null })) };
  else status = { failure: value.failure, pending: value.pending, queue: value.queue.map((entry) => ({ goalId: entry.proposal?.goalId, status: entry.status, vetted: !!entry.vetting })) };
  const fingerprint = JSON.stringify(status);
  if (previous.get(name) !== fingerprint) { previous.set(name, fingerprint); console.log(JSON.stringify({ at: new Date().toISOString(), file: name, status })); }
}
async function reportState() {
  const value = JSON.parse(await readFile(join(stateRoot, 'state.json'), 'utf8'));
  const status = value.planningGoals.filter((item) => !item.ceremony?.closure || item.id === goal).map((item) => ({ id: item.id, stage: item.stage, assignment: item.goalAssignment?.status, ceremony: item.ceremony?.stage, closure: item.ceremony?.closure, integration: item.integration }));
  const fingerprint = JSON.stringify(status);
  if (previous.get('state') !== fingerprint) { previous.set('state', fingerprint); console.log(JSON.stringify({ at: new Date().toISOString(), file: 'state.json', status })); }
}
await reportState();
for (const name of files) await report(name);
const watcher = watch(root, (_, name) => { if (name && files.has(name)) void report(name).catch(() => {}); });
const stateWatcher = watch(stateRoot, (_, name) => { if (name === 'state.json') void reportState().catch(() => {}); });
process.on('SIGTERM', () => { watcher.close(); stateWatcher.close(); process.exit(0); });
process.on('SIGINT', () => { watcher.close(); stateWatcher.close(); process.exit(0); });
