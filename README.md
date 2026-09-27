# Indra

Indra reads stable team seats and draft sprint records from an `indra-state` Git checkout. The planning commands connect Chick's durable seat to an authenticated Codex CLI session and a dedicated Mattermost thread.

## Run

Requires Node.js 26.4.0 or newer for the OpenTUI Solid terminal screen. The launcher passes Node's `--experimental-ffi` flag; it does not change the system Node installation. Keep the separate `indra-state` checkout beside this project, or pass its directory explicitly:

```sh
npm ci
npm run build
npm start
npm start -- --state /path/to/indra-state
npm start -- --ui --state /path/to/indra-state
```

The default is the sibling `../indra-state` directory. `INDRA_STATE_REPO` also sets the checkout path; `--state` takes precedence. The terminal shows recorded teams, seats, roles, and draft sprint details. Enter `r` to reread `state.json` after a file edit or Git checkout change, or `q` to quit. `--once` prints one snapshot and exits, useful for scripts and a quick check:

```sh
npm start -- --state /path/to/indra-state --once
```

The app validates the version 1 structure and references before showing a snapshot. Validation errors name the invalid field or reference. A failed refresh never presents malformed data as an empty roster. The `indra-state` repository contains [the formal JSON Schema](https://github.com/satoramoto/indra-state/blob/main/schema/v1/state.schema.json); `state.json` carries `$schema` and `schemaVersion`. The current sprint's work and allocations are **draft proposals**, not approved assignments or active execution.

## Chick planning

Use a writable, dedicated `indra-state` checkout with the compatible version 1 schema. `planning start` creates the thread, saves the goal and brief in its `state.json`, and opens Chick's Codex session. Pass an exact Mattermost channel ID; the app does not choose a channel or adopt existing conversations.

```sh
npm start -- planning start --state /path/to/indra-state --channel CHANNEL_ID --goal "Familiarize yourself with this project and propose a roadmap" --project /path/to/project
npm start -- planning serve --state /path/to/indra-state
npm start -- planning host --state /path/to/indra-state
npm start -- planning status --state /path/to/indra-state
```

Optional `--participant SEAT_ID` records intended contributors. Only Chick runs in this MVP; listing George or another seat does not launch them. In the new thread, reply normally to clarify the brief. Send the exact message `/proposal` in that thread to request a draft. The bridge moves the goal through `clarifying`, `drafting`, and `awaiting-review`, writes the validated proposal into `state.json`, and posts its summary in the thread. It never approves or executes proposal work. Review and commit `state.json` in its own repository to preserve business history.

The current commands read Chick's 1Password bot token from `op://Agent Rig/Mattermost bot - chickcorea/token` in each process, using the existing desktop authorization. The bridge uses the existing authenticated Codex CLI and does not accept an API key. Each Codex child inherits only basic runtime paths, locale, and certificate settings; application credentials, database URLs, and proxy values are excluded. Runtime session IDs, processed post IDs, run timestamps, and any reported usage live outside Git in `<state-checkout>.runtime`; preserve that directory to resume after a restart. Keep only one `planning serve` process for this checkout. The bridge polls every three seconds, serializes Chick's messages, caps a poll at 20 inputs, ignores its own posts, and scans the thread for delivery IDs before retrying pending replies. If a process dies in the narrow interval after a state update and before its pending delivery record is saved, inspect the thread and state before restarting. If `planning start` reports an orphan root post, inspect that post before trying again. This attended 1Password flow does not provide unattended cold restart or hosted start without another desktop authorization.

`planning host` launches the same bridge in a dedicated detached tmux session. It uses an Indra-owned socket and exact session name derived from the state checkout, and reuses an already verified pane on repeated calls. It records the tmux server/session identity and pane in `<state-checkout>.runtime/tmux-host.json`, then waits for the bridge's first successful poll before reporting readiness. `planning status` prints a neutral JSON session snapshot, including an attach target only while that exact, live pane remains available. A connected bridge can show an idle seat between Codex turns. The target is `socket:session`; split it and pass the pieces as argv to `tmux -L SOCKET attach-session -t =SESSION`. Attaching or detaching does not stop the bridge. A stale or missing ownership record is never grounds to kill or attach another session. The host command requires the built `dist/cli.js` (`npm run build` first).

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

`npm start -- --ui --state PATH` opens the read-only OpenTUI Solid screen with the local state and runtime session reader. It polls state and session snapshots every two seconds, keeps the selected stable seat during refresh, and labels disconnected occupancy as unknown while still showing recorded planning goals and activity. The team view shows each seat's role and newest recorded activity; Enter opens its detail. An attach action is available only for a verified Indra-owned tmux target and opens a read-only bridge event/log view. Detaching or quitting does not pause or stop the bridge. The 80-column view keeps all five Yahaha seats in the roster and moves the expanded detail to its own screen.

`src/state-domain.ts` defines neutral inventory records. `src/planning.ts` owns state writes and local resume metadata. `src/planning-bridge.ts` routes Chick's thread and validates model output. `src/codex-runtime.ts` and `src/planning-mattermost.ts` are the provider adapters. There is no HTTP preview server.
