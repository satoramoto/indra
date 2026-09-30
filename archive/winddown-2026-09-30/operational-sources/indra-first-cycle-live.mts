import { readFile, readdir } from 'node:fs/promises';
import { TmuxHost, SystemTmux, hostedProcessFor } from '/Users/ryan/The Source/indra/src/tmux-host.ts';
import { processStart } from '/Users/ryan/The Source/indra/src/running-build.ts';
import { createPlanningStore } from '/Users/ryan/The Source/indra/dist/cli.js';

const checkout = '/Users/ryan/The Source/indra-state';
const appDir = '/Users/ryan/The Source/indra';
const store = createPlanningStore(checkout);
const state = await store.read();
const hosts = [];
for (const team of state.teams) {
  for (const seat of team.seats) {
    const host = new TmuxHost(checkout, new SystemTmux(), appDir, 15_000, hostedProcessFor(seat));
    try {
      const verified = await host.verifiedRecord();
      hosts.push({ seatId: seat.id, roles: seat.roles, liveOwned: !!verified, socket: host.socket, session: host.session, ...(verified ? { paneId: verified.paneId, startedAt: verified.startedAt, build: verified.build, readiness: await host.readiness(verified) } : {}) });
    } catch (error) {
      hosts.push({ seatId: seat.id, verificationError: (error as Error).message });
    }
  }
}
const builds = [];
for (const name of await readdir(`${checkout}.runtime/builds-in-use`).catch(() => [])) {
  try {
    const receipt = JSON.parse(await readFile(`${checkout}.runtime/builds-in-use/${name}`, 'utf8'));
    if (receipt.role && receipt.processStart === await processStart(receipt.pid)) builds.push(receipt);
  } catch {}
}
console.log(JSON.stringify({ hosts, liveBuilds: builds, teams: state.teams.map((team: any) => ({id: team.id, workflowModel: team.workflowModel})), openGoals: (state.planningGoals ?? []).filter((goal: any) => !goal.ceremony?.closure).map((goal: any) => ({id:goal.id, stage:goal.stage, ceremony:goal.ceremony?.stage, workflowModel:goal.workflowModel})) }, null, 2));
