# Indra

Indra opens a read-only view of stable team seats and a draft sprint from an `indra-state` Git checkout. A seat is a durable team identity; no agent session is connected or launched by this app.

## Run

Requires Node.js 22.15.0 or newer. Keep the separate `indra-state` checkout beside this project, or pass its directory explicitly:

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

`npm run dev` restarts the TypeScript CLI on source edits; enter `r` to reload state data without restarting. Vite builds the CLI and Vitest runs fixture tests. There is no web server or HTTP preview.

`src/state-domain.ts` defines neutral state records and one read interface. `src/local-state.ts` validates and maps the local checkout; `src/cli.ts` selects it at the edge. `src/domain.ts` and `src/mattermost.ts` retain the independent live inventory path. This milestone does not synchronize providers, plan work, create messages, change roles, or run agents.
