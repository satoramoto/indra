# Indra

Indra reads stable team seats and draft sprint records from an `indra-state` Git checkout. The planning commands connect Chick's durable seat to an authenticated Codex CLI session and a dedicated Mattermost thread.

## Direction

Indra is a startup simulator: a control plane where stable team seats in Mattermost are filled by coding-agent sessions. This section describes the proof of concept we are building toward. The rest of this README describes what runs today.

**Roles.** There are exactly two permanent roles. The Team Lead is Chick Corea (`seat-001`). Every other seat is a Developer. There are no extra-role claims and no formal soft roles. A sprint proposal can describe soft responsibilities in prose.

**Seats and tasks.** A seat limits concurrency by task ownership: each seat owns one logical workstream at a time. Inside that task it can start any number of subagents with the developer, reviewer and quick-fix profiles.

**Rules inside a task.** Build, then review by a fresh agent, fix, merge. The reviewer is never the same agent reviewing its own work in the same context.

**People and state.** The only human step is approving plans. Agents merge their own PRs once CI is green and the fresh reviewer has approved. Indra writes planning records to `indra-state`. Indra reads live Mattermost (the existing `--mattermost` mode) to confirm it matches `indra-state`; that read stays read-only.

**POC milestone.** The full team loop runs on the Indra repository itself: a goal is set, Chick plans, a human approves, a Developer seat does the work in a worktree, opens a PR, starts a fresh reviewer, fixes, merges, then goes idle. Codex runs every seat first. The Claude Code adapter and handing a seat from one engine to another come later.

**Planned PR order.**

1. CI.
2. The two roles, plus the check that live Mattermost matches `indra-state`.
3. Plan approval, with assignment of approved work to seats.
4. Developer seats running the task loop.

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

The app validates the version 1 structure and references before showing a snapshot. Each seat's `roles` holds exactly one of the two roles, `Team Lead` or `Developer`, and each team has exactly one Team Lead. Validation errors name the invalid field or reference. A failed refresh never presents malformed data as an empty roster. The `indra-state` repository contains [the formal JSON Schema](https://github.com/satoramoto/indra-state/blob/main/schema/v1/state.schema.json); `state.json` carries `$schema` and `schemaVersion`. The current sprint's work and allocations are **draft proposals**, not approved assignments or active execution.

## Chick planning

Use a writable, dedicated `indra-state` checkout with the compatible version 1 schema. `planning start` creates the thread, saves the goal and brief in its `state.json`, and opens Chick's Codex session. Pass an exact Mattermost channel ID; the app does not choose a channel or adopt existing conversations.

```sh
npm start -- planning start --state /path/to/indra-state --channel CHANNEL_ID --goal "Familiarize yourself with this project and propose a roadmap" --project /path/to/project
npm start -- planning serve --state /path/to/indra-state
npm start -- planning host --state /path/to/indra-state
npm start -- planning status --state /path/to/indra-state
```

Optional `--participant SEAT_ID` records intended contributors. Only Chick runs in this MVP; listing George or another seat does not launch them. In the new thread, reply normally to clarify the brief. Send the exact message `/proposal` in that thread to request a draft. The bridge moves the goal through `clarifying`, `drafting`, and `awaiting-review`, writes the validated proposal into `state.json`, and posts its summary in the thread. Chick assigns every proposed outcome to a Developer seat on the team, one outcome per seat where the seats allow. The bridge never approves or executes proposal work on its own.

To approve a proposal, a person (a Mattermost user that is not a bot) sends the exact message `/approve` in the goal thread while the goal is `awaiting-review`. The bridge moves the goal to `approved`, records one `queued` assignment per outcome for its Developer seat, and posts a confirmation listing each outcome and seat. Developer seat runners pick up queued assignments from `state.json`. The bridge ignores its own posts; `/approve` from another bot or from Chick's seat account changes nothing and gets a short reply saying so; in any other stage it gets a reply explaining why nothing happened. Repeating `/approve` after approval reposts the confirmation without changing state. Review and commit `state.json` in its own repository to preserve business history.

The bridge uses Chick's 1Password bot item (`Mattermost bot - chickcorea`) and the existing authenticated Codex CLI. It does not accept an API key. Runtime session IDs, processed post IDs, run timestamps, and any reported usage live outside Git in `<state-checkout>.runtime`; preserve that directory to resume after a restart. Keep only one `planning serve` process for this checkout. The bridge polls every three seconds, serializes Chick's messages, caps a poll at 20 inputs, ignores its own posts, and scans the thread for delivery IDs before retrying pending replies. If a process dies in the narrow interval after a state update and before its pending delivery record is saved, inspect the thread and state before restarting. If `planning start` reports an orphan root post, inspect that post before trying again. 1Password may require desktop authorization.

`planning host` launches the same bridge in a dedicated detached tmux session. It uses an Indra-owned socket and exact session name derived from the state checkout, and reuses an already verified pane on repeated calls. It records the tmux server/session identity and pane in `<state-checkout>.runtime/tmux-host.json`, then waits for the bridge's first successful poll before reporting readiness. `planning status` prints a neutral JSON session snapshot, including an attach target only while that exact, live pane remains available. A connected bridge can show an idle seat between Codex turns. The target is `socket:session`; split it and pass the pieces as argv to `tmux -L SOCKET attach-session -t =SESSION`. Attaching or detaching does not stop the bridge. A stale or missing ownership record is never grounds to kill or attach another session. The host command requires the built `dist/cli.js` (`npm run build` first).

## Developer seats

A Developer seat picks up approved work and runs the dev loop on it with Codex:

```sh
npm start -- seat run --seat SEAT_ID --state /path/to/indra-state
```

It refuses a Team Lead seat or a seat that is not in `state.json`. Run one process per seat. The seat reads approved goals (`stage: "approved"`) and their `assignments`. A seat owns at most one `running` or `in-review` assignment. When idle, it claims its own oldest `queued` assignment and marks it `running` in `state.json` before doing any work. It then:

1. fetches `origin main` in the goal's target project (`projectRefs[0]`, a local Git checkout) and creates a fresh worktree and branch `SEAT_ID/GOAL_ID-OUTCOME_ID` from `origin/main` under `<state-checkout>.runtime/worktrees/`;
2. runs a new Codex session that implements the outcome under the project's AGENTS.md, runs the targeted tests once, commits, pushes and opens a PR; the assignment becomes `in-review` with its `prUrl`;
3. runs a separate, new Codex session as the reviewer, read-only and without network, which returns its findings; the seat posts them on the PR as one comment with `gh pr comment`;
4. if there are findings, runs one new Codex fix session;
5. waits once with `gh pr checks --watch`, merges with `gh pr merge --squash --delete-branch` when CI is green, marks the assignment `merged`, removes the worktree and goes idle.

Any failure marks the assignment `failed` with a short `note` and the seat goes idle; a failed task's worktree is kept for inspection. On restart the seat resumes an `in-review` assignment from its recorded step; a `running` assignment that never opened a PR is marked `failed` rather than rebuilt. It never takes a second assignment while one is in flight. With nothing queued it checks again every 30 seconds.

Codex runs in the `workspace-write` sandbox with network access, so it can push and use `gh`; the builder and fix sessions may also write the project's shared Git directory, and the reviewer may not. They use the logged-in Codex CLI and `gh`. The seat posts short progress replies (claimed, PR opened, review done, merged or failed) in the goal thread as its own bot, using the 1Password item `Mattermost bot - USERNAME` (the seat's Mattermost username), as Chick's bridge does. A missing item stops the seat with an error naming it. Codex session IDs, usage and the task's step live in `<state-checkout>.runtime/seat-SEAT_ID-GOAL_ID-OUTCOME_ID.json`, not in `state.json`.

## Live Mattermost check and inventory

`--mattermost` reads live Mattermost and compares it with the `indra-state` checkout (`--state`, `INDRA_STATE_REPO`, or the sibling default, as above). This report is where Mattermost vs state mismatches appear:

```sh
npm start -- --mattermost --once
npm start -- --mattermost --state /path/to/indra-state --once
npm start -- --mattermost
npm start -- --mattermost --team yahaha
```

For every state team, the check reads the active members of its Mattermost team (`externalIdentities.mattermost.teamId`) and reports each mismatch on its own line, naming the seat and field:

- a seat whose Mattermost user (`externalIdentities.mattermost.userId`) is not an active member of the team;
- a Mattermost username that differs from the seat's `externalIdentities.mattermost.username`;
- a Mattermost profile **Position** that does not equal the seat's role (`Team Lead` or `Developer`, compared exactly after trimming spaces);
- a bot account in the team that no seat in state claims.

Human accounts in the team that no seat claims (such as the owner's) are listed as `Info:` lines and do not count as mismatches.

With `--once` it prints the report and exits 1 when there is any mismatch, 0 when everything matches. Without `--once` it prints the same report, then opens the interactive team and seat browser. `--team SLUG` prints one team's bot seats and their custom **Role** attribute without the state check. The check never writes to Mattermost or to `state.json`; fix a mismatch by editing the Mattermost profile or the state record yourself.

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
