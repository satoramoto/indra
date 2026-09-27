# Indra

Indra opens a read-only view of stable team seats and a draft sprint from an `indra-state` Git checkout. A seat is a durable team identity; no agent session is connected or launched by this app.

## Run

Requires Node.js 26.4.0 or newer for the OpenTUI Solid terminal screen. The launcher passes Node's `--experimental-ffi` flag; it does not change the system Node installation. Keep the separate `indra-state` checkout beside this project, or pass its directory explicitly:

```sh
npm ci
npm run build
npm start
npm start -- --state /path/to/indra-state
```

The default is the sibling `../indra-state` directory. `INDRA_STATE_REPO` also sets the checkout path; `--state` takes precedence. The terminal shows recorded teams, seats, roles, and draft sprint details. Enter `r` to reread `state.json` after a file edit or Git checkout change, or `q` to quit. `--once` prints one snapshot and exits, useful for scripts and a quick check:

```sh
npm start -- --state /path/to/indra-state --once
```

The app validates the version 1 structure and references before showing a snapshot. Validation errors name the invalid field or reference. A failed refresh never presents malformed data as an empty roster. The `indra-state` repository contains [the formal JSON Schema](https://github.com/satoramoto/indra-state/blob/main/schema/v1/state.schema.json); `state.json` carries `$schema` and `schemaVersion`. Edit and commit that file in the state repository to preserve business-record history. Indra does not write it or maintain a second database. The current sprint's work and allocations are **draft proposals**, not approved assignments or active execution.

## Existing live Mattermost inventory

The previous read-only live inventory remains available explicitly:

```sh
npm start -- --mattermost
npm start -- --mattermost --team yahaha
```

This mode requires network access to `https://mattermost.newegypt.io` and an existing signed-in 1Password CLI session with access to `op://Agent Rig/Mattermost/access_token`. The launch commands use Node's system CA trust. No token belongs in environment variables, arguments, or the state repository. The adapter sends only `GET` requests, suppresses credential-bearing diagnostics, and refuses HTTP redirects. Mattermost visibility is limited to that credential's permissions. Its refresh time is the last successful read, and agent occupancy is labeled **not connected yet**.

## Develop and verify

```sh
npm run dev -- --state /path/to/indra-state
npm run test:watch
npm test
npm run typecheck
npm run build
```

`npm run dev` watches source files and rebuilds the CLI and terminal UI; run `npm start` in a second terminal after the initial build. Vite compiles Solid TSX with the universal transform and Vitest runs fixture and native renderer tests. There is no web server or HTTP preview.

`src/terminal-ui-solid.tsx` exports the read-only OpenTUI Solid screen for the coordinator to connect to `src/cli.ts` and the runtime's neutral `SessionReadPort`. It polls state and session snapshots every two seconds, keeps the selected stable seat during refresh, and labels disconnected occupancy as unknown. The team view shows each seat's role and recent runtime activity; Enter opens its detail. An attach action is available only for a verified Indra-owned tmux target and opens the bridge event/log view. Detaching or quitting does not pause or stop the bridge. The 80-column view keeps all five Yahaha seats in the roster and moves the expanded detail to its own screen.

`src/state-domain.ts` defines neutral state records and one read interface. `src/local-state.ts` validates and maps the local checkout; `src/cli.ts` selects it at the edge. `src/domain.ts` and `src/mattermost.ts` retain the independent live inventory path. This milestone does not synchronize providers, plan work, create messages, change roles, or run agents.
