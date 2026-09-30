import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
const checkout = '/Users/ryan/The Source/indra-state';
const runtime = `${checkout}.runtime`;
let last = '';
let timer;
async function read(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } }
async function snapshot() {
  const [state, product, scheduler] = await Promise.all([read(`${checkout}/state.json`), read(`${runtime}/product-workflow-team-001.json`), read(`${runtime}/team-workflow-team-001.json`)]);
  const data = {
    product: product ? { updatedAt: product.updatedAt, failure: product.failure, queue: product.queue?.map(entry => ({ status: entry.status, proposal: entry.proposal && { goalId: entry.proposal.goalId, proposalId: entry.proposal.proposalId, summary: entry.proposal.summary, ownedFiles: entry.proposal.ownedFiles }, vetting: entry.vetting, publication: entry.publication })) } : null,
    scheduler: scheduler ? { updatedAt: scheduler.updatedAt, failure: scheduler.failure, approvedQueue: scheduler.approvedQueue, activeDispatches: scheduler.activeDispatches } : null,
    goals: state?.planningGoals?.filter(goal => !goal.ceremony?.closure).map(goal => ({ id: goal.id, goal: goal.goal, stage: goal.stage, ceremony: goal.ceremony?.stage, ownedFiles: goal.ownedFiles, goalAssignment: goal.goalAssignment, integration: goal.integration, mattermost: goal.mattermost })) ?? []
  };
  const serialized = JSON.stringify(data);
  if (serialized !== last) { last = serialized; console.log(JSON.stringify({ observedAt: new Date().toISOString(), ...data })); }
}
function wake(name) {
  if (!name || !['state.json', 'product-workflow-team-001.json', 'team-workflow-team-001.json'].includes(String(name))) return;
  clearTimeout(timer); timer = setTimeout(() => snapshot().catch(() => {}), 150);
}
const watchers = [watch(checkout, (_, name) => wake(name)), watch(runtime, (_, name) => wake(name))];
await snapshot();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); process.exit(0); });
