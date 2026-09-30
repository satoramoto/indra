import { readFile } from 'node:fs/promises'
import { runTerminalUi } from '/Users/ryan/.codex/worktrees/indra-terminal-ui/indra/dist/terminal-ui.js'
const raw = JSON.parse(await readFile('/Users/ryan/The Source/indra-state/state.json', 'utf8'))
const snapshot = {
  teams: raw.teams.map((team) => ({ id: team.id, slug: team.slug, displayName: team.displayName, seats: team.seats.map((seat) => ({ id: seat.id, displayName: seat.displayName, handle: seat.externalIdentities.mattermost.username, roles: seat.roles })) })),
  sprints: raw.sprints,
}
await runTerminalUi({ current: async () => snapshot }, { readSessions: async () => ({ connection: 'disconnected', sessions: [] }) })
