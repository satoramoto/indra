import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const source = (file) => pathToFileURL(`${process.cwd()}/src/${file}`).href;
const { captureOpEnvironment } = await import(source('op-env.ts'));
captureOpEnvironment();
const { recordedRetroInput, priorRetroAttempts } = await import(source('retro-publication.ts'));
const { buildRetroSnapshot } = await import(source('sprint-retro.ts'));
const runtimeDir = '/Users/ryan/The Source/indra-state.runtime';
const state = JSON.parse(await readFile('/Users/ryan/The Source/indra-state/state.json', 'utf8'));
const id = 'goal-b802a303-4685-4a02-bdd1-f6eb6b5cb14c';
const goal = state.planningGoals.find(g => g.id === id);
assert(goal);
const allowed = new Set([`ceremony-${id}`, `goal-workflow-${id}`, `developer-goal-workflow-${id}`, `release-attempts-${id}`]);
const store = {
  runtimeDir,
  read: async () => state,
  readRuntimeFile: async (name) => {
    if (!allowed.has(name)) throw new Error('Unscoped runtime read');
    try { return JSON.parse(await readFile(`${runtimeDir}/${name}.json`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  },
};
try {
  const publication = JSON.parse(await readFile(`${runtimeDir}/retro-publication-${id}.json`, 'utf8'));
  const input = await recordedRetroInput({ goal, store }, priorRetroAttempts(publication.attempts));
  const snapshot = buildRetroSnapshot(input);
  assert.equal(snapshot.goalId, id);
  console.log(JSON.stringify({ phase: 'snapshot', goalId: snapshot.goalId, sessions: input.facts.sessions.length,
    priorAttempts: publication.attempts.length, bytes: Buffer.byteLength(JSON.stringify(snapshot)),
    prEvidence: input.lanePrs.map(pr => ({url: pr.url, headSha: pr.headSha})) }));
} catch (error) {
  console.log(JSON.stringify({phase: 'failed', error: error.message}));
  process.exitCode = 1;
}
