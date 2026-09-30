import { readFile } from 'node:fs/promises';
import { parseState } from '/Users/ryan/.codex/worktrees/indra-conflict-recovery/indra/src/local-state.ts';
import { closeRemodelGoal, REMODEL_CLOSURE_GOALS } from '/Users/ryan/.codex/worktrees/indra-conflict-recovery/indra/src/ceremony.ts';

const file = '/Users/ryan/The Source/indra-state/state.json';
const before = JSON.parse(await readFile(file, 'utf8'));
parseState(before);
const after = structuredClone(before);
const closed: string[] = [];
for (const goal of after.planningGoals ?? []) {
  if (Object.hasOwn(REMODEL_CLOSURE_GOALS, goal.id) && !goal.ceremony?.closure) {
    goal.ceremony = closeRemodelGoal(goal, new Date().toISOString());
    closed.push(goal.id);
  }
}
const retiredSprints = after.sprints?.length ?? 0;
after.sprints = [];
const team = after.teams.find((team: { id: string }) => team.id === 'team-001');
if (!team) throw new Error('Configured team is missing.');
team.workflowModel = 'goals-v1';
const product = team.seats.find((seat: { id: string }) => seat.id === 'seat-002');
if (!product || product.displayName !== 'George Duke') throw new Error('Product identity changed; inspect before activation.');
product.roles = ['Product'];
parseState(after);
console.log(JSON.stringify({dryRun: true, sourceUnchanged: (await readFile(file, 'utf8')) === JSON.stringify(before, null, 2) + '\n', validated: true, historicalClosures: closed, retiredSprints, team: {id: team.id, workflowModel: team.workflowModel, seats: team.seats.map(({id, displayName, roles}: {id: string; displayName: string; roles: string[]}) => ({id, displayName, roles}))}}, null, 2));
