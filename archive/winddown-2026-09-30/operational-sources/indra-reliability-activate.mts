import assert from 'node:assert/strict';
import { captureOpEnvironment } from '/Users/ryan/The Source/indra/src/op-env.ts';
import { Supervisor } from '/Users/ryan/The Source/indra/src/supervisor.ts';
import { SelfUpdater } from '/Users/ryan/The Source/indra/src/self-update.ts';
import { readBuildStamp } from '/Users/ryan/The Source/indra/src/build-stamp.ts';
import { SystemTmux, TmuxHost, hostedProcessFor, turnLockFile } from '/Users/ryan/The Source/indra/src/tmux-host.ts';
import { withFileLock } from '/Users/ryan/The Source/indra/src/state-commit.ts';
import { createPlanningStore } from '/Users/ryan/The Source/indra/dist/cli.js';

captureOpEnvironment();
const appDir = '/Users/ryan/The Source/indra';
const checkout = '/Users/ryan/The Source/indra-state';
const runtimeDir = `${checkout}.runtime`;
const [mode, expectedSha] = process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(expectedSha ?? ''), 'Pass the reviewed upstream SHA');
assert(['update', 'recover-hosts', 'upgrade'].includes(mode), 'Unknown activation action');

if (mode === 'update') {
  const result = await new SelfUpdater(appDir, 'npm', 15 * 60_000, runtimeDir, 0).check();
  console.log(JSON.stringify({ action: mode, ...result }));
  assert(['built', 'up-to-date'].includes(result.outcome), 'Normal updater did not produce the reviewed build');
  assert.equal(result.sha, expectedSha, 'Upstream changed during update; inspect before host recovery');
  assert.equal((await readBuildStamp(appDir))?.sha, expectedSha);
} else if (mode === 'upgrade') {
  assert.equal((await readBuildStamp(appDir))?.sha, expectedSha);
  const store = createPlanningStore(checkout);
  const result = await new Supervisor(checkout, undefined, appDir, undefined, store).upgrade();
  console.log(JSON.stringify({ action: mode, ...result }));
} else {
  const stamp = await readBuildStamp(appDir);
  assert.equal(stamp?.sha, expectedSha, 'Selected build differs from reviewed upstream');
  const store = createPlanningStore(checkout);
  const state = await store.read();
  const team = state.teams.find((item: any) => item.id === 'team-001');
  assert(team && team.workflowModel === 'goals-v1');
  for (const seatId of ['seat-003', 'seat-002']) {
    const seat = team.seats.find((item: any) => item.id === seatId);
    assert(seat);
    const hosted = hostedProcessFor(seat);
    const host = new TmuxHost(checkout, new SystemTmux(), appDir, 15_000, hosted);
    let record = await host.verifiedRecord();
    if (record?.build === stamp!.id) {
      console.log(JSON.stringify({ seatId, action: 'already-current', build: record.build }));
      continue;
    }
    if (record) {
      const current = await store.readRuntimeFile<any>('goal-workflow-goal-b802a303-4685-4a02-bdd1-f6eb6b5cb14c');
      assert(seatId === 'seat-003' && current?.failure && current.assignment?.seatId === seatId, 'Only the verified blocked Developer may be restarted by this repair');
      await withFileLock(turnLockFile(checkout, hosted), async () => {
        const verified = await host.verifiedRecord();
        assert(verified && verified.readyNonce === record!.readyNonce, 'Host ownership changed; re-inspect');
        assert.equal((await readBuildStamp(appDir))?.id, stamp!.id);
        await host.stop();
      }, 1000);
    }
    // Starting outside the turn lease lets the new host reconcile its retained journal normally.
    record = await host.start();
    assert.equal(record.build, stamp!.id);
    console.log(JSON.stringify({ seatId, action: 'ready', build: record.build, paneId: record.paneId, startedAt: record.startedAt }));
  }
}
