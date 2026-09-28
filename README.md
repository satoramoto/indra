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

```sh
npm start
```

That is the only thing to run. The terminal UI opens on the team and makes sure Chick's planning bridge and one runner per Developer seat are running; you never start or manage those processes yourself. Each seat row shows its process (running, stopped or no credential), the assignment it holds (outcome, status, PR link) and its newest thread activity. Keys: `n` starts a new planning goal (type only the goal, then Enter), `s` restarts the selected seat's process, `x` stops it, Enter opens the seat's detail and `a` attaches to its tmux session read-only. In Chick's seat detail, `P` (Shift-p) requests Chick's proposal for the newest goal still being clarified, and `A` (Shift-a) approves the newest goal whose proposal awaits review, each after a `y`/`n` confirmation that names the goal. With `n`, `P` and `A` a whole planning cycle runs from the terminal. `q` quits and leaves every process running. In the Mattermost goal thread, react 📝 (`:memo:`) on Chick's goal post to request a proposal and ✅ (`:white_check_mark:`) on Chick's proposal post to approve it.

Indra updates itself: about every 60 seconds it pulls new commits on `main`, rebuilds, and reloads the UI and restarts the bridge and seat runners once each is idle, so you rarely need to restart it. `U` (Shift-u) pauses or resumes that; while paused Indra doesn't pull, build or switch builds, `r` only reports what waits on `origin/main`, and the setting survives restarts (`<state-checkout>.runtime/self-update.json`). `R` (Shift-r), after a `y`/`n` naming both versions, switches back to the previous build (`dist-previous`), pauses updates so the bad commit isn't rebuilt, and reloads and restarts like an update; the status line then says "rolled back to SHA".

Each team is bound to a project and a home channel, both recorded in `indra-state` on the team: `project.github` (`owner/repo`) and `externalIdentities.mattermost.homeChannelId`. Starting planning never asks for either; when one is missing, the UI names the missing field instead of opening the goal input.

## Under the hood

First run in a checkout: `npm ci` then `npm run build`. Node.js 26.4.0 or newer is required; the launcher passes Node's `--experimental-ffi` flag without changing the system Node. The state checkout is the sibling `../indra-state` by default; `INDRA_STATE_REPO` or `--state PATH` overrides it (`--state` wins). `npm start -- --once` prints one state snapshot and exits.

On open, the UI first syncs the state checkout with its remote (see below), then hosts each missing process in its own detached tmux session on an Indra-owned socket, exactly as `planning host` does: Chick's `planning serve` for the Team Lead seat and `seat run --seat SEAT_ID` for each Developer seat. A verified live session is reused, never duplicated; a session Indra does not own is never touched. Ownership records live in `<state-checkout>.runtime/tmux-host.json` (bridge) and `tmux-seat-SEAT_ID.json` (seats). Before hosting anything, the UI reads the 1Password service account token (`op://Agent Rig/cvldgk5zipacvawubvsvwmy5xq/credential`) once through the normal `op` CLI, so there is at most one desktop authorization, and writes it with 0600 permissions to `<state-checkout>.runtime/op-service-account-token`. Hosted processes read their bot token (the `token` field of `Mattermost bot - USERNAME`) headlessly, setting `OP_SERVICE_ACCOUNT_TOKEN` only in the environment of their own `op read`. A hosted process never falls back to a desktop prompt: without a staged token, or when its bot item is missing, it signals that before it exits and its seat shows **no credential**. Processes that were already running pick up a newly staged token when restarted with `s`. A new goal runs `planning start --goal TEXT` through the built CLI, and `A` runs `planning approve --goal GOAL_ID`; both read Chick's bot token with the staged service account token, so no credential enters the UI process. `P` runs `planning propose --goal GOAL_ID`, which reads no credential: it records the request for the bridge, which drafts the proposal on its next poll. The manual commands below still work for debugging.

`npm start` runs a small launcher (`dist/launcher.js`) that runs the UI as a child process in the same terminal and starts it again, on the current build, when it exits with code 75 (reload); any other exit ends it. Every build writes `dist/build-stamp.json`. About every 60 seconds the UI checks the Indra checkout it runs from: when `origin/main` has new commits and the checkout is on `main`, has no uncommitted changes to tracked files and can fast-forward, it runs `git pull --ff-only`, then `npm ci` only when `package-lock.json` changed since the running build, then `npm run build`. On another branch, with uncommitted changes, or when `main` has diverged, it does nothing and the status line says why; it never resets, stashes or discards anything. A failed build keeps the old build running and shows the error; the same commit is not rebuilt. When `dist/` holds a new build (from a self-update or an `npm run dev` rebuild), the UI reloads itself once nothing is in flight (no goal being typed, started or approved, no state sync) and reopens the same seat or view. The supervisor restarts each hosted process on an older build through its owned tmux session, at a safe point only: the bridge between polls (no Codex turn in flight, pending deliveries saved), a seat runner between steps and only while it holds no `running` or `in-review` assignment. Each poll or step holds `<state-checkout>.runtime/turn-bridge.lock` or `turn-seat-SEAT_ID.lock`, which the supervisor takes before stopping the process. Until then the seat shows **update pending**. The status line shows the running version (short SHA) and the update state: up to date, updating, update pending, or blocked with the reason. Run without the launcher (`node dist/cli.js`), the UI only reports that a new build is ready.

The app validates the version 1 structure and references before showing a snapshot. Each seat's `roles` holds exactly one of the two roles, `Team Lead` or `Developer`, and each team has exactly one Team Lead. Validation errors name the invalid field or reference. A failed refresh never presents malformed data as an empty roster. The `indra-state` repository contains [the formal JSON Schema](https://github.com/satoramoto/indra-state/blob/main/schema/v1/state.schema.json); `state.json` carries `$schema` and `schemaVersion`. The current sprint's work and allocations are **draft proposals**, not approved assignments or active execution.

## Chick planning

Use a writable, dedicated `indra-state` Git checkout with the compatible version 1 schema. `planning start` creates the thread, saves the goal and brief in its `state.json`, and opens Chick's Codex session. The thread goes to the team's home channel (`externalIdentities.mattermost.homeChannelId` on the team) and the goal records the team's project (`project.github`) in `projectRefs`. There are no channel or project options: when either field is missing, `planning start` stops with an error naming it. The app does not adopt existing conversations.

```sh
npm start -- planning start --state /path/to/indra-state --goal "Familiarize yourself with this project and propose a roadmap"
npm start -- planning propose --state /path/to/indra-state --goal GOAL_ID
npm start -- planning approve --state /path/to/indra-state --goal GOAL_ID
npm start -- planning serve --state /path/to/indra-state
npm start -- planning host --state /path/to/indra-state
npm start -- planning status --state /path/to/indra-state
```

Optional `--participant SEAT_ID` records intended contributors. Only Chick runs in this MVP; listing George or another seat does not launch them. In the new thread, reply normally to clarify the brief. Actions are emoji reactions, because Mattermost treats a message starting with `/` as a slash command. React 📝 (`:memo:`) on Chick's goal post to request a draft. The bridge moves the goal through `clarifying`, `drafting`, and `awaiting-review`, writes the validated proposal into `state.json`, and posts its summary in the thread. Chick assigns every proposed outcome to a Developer seat on the team, one outcome per seat where the seats allow. The bridge never approves or executes proposal work on its own. A 📝 while the proposal awaits review reposts it. The owner can request the draft from the terminal instead, with `P` in Chick's seat detail (`planning propose --goal GOAL_ID`). It works only while the goal is `clarifying`; at any other stage it prints why and changes nothing. It records the request in the goal's runtime file under the same per-goal lock the bridge polls with, and the bridge drafts it on its next poll through the same code as 📝, with the same thread posts. A 📝 and a `planning propose` together draft once: whichever the bridge handles first drafts, and a `propose` that finds the proposal already drafted is dropped without a post. Repeating `planning propose` records nothing new.

To approve a proposal, a person (a Mattermost user that is not a bot) reacts ✅ (`:white_check_mark:`) on Chick's proposal post while the goal is `awaiting-review`, or the owner presses `A` in the terminal UI (`planning approve --goal GOAL_ID`). Both routes run the same approval code: the goal moves to `approved`, one `queued` assignment is recorded per outcome for its Developer seat, and a confirmation listing each outcome and seat is posted in the thread. Developer seat runners pick up queued assignments from `state.json`. The bridge reads reactions with `GET` only and counts a reaction only from a person: not a bot (`is_bot` true), not the bridge's own account and not Chick's seat. It ignores its own reactions; a reaction from another bot or from Chick's seat changes nothing and gets a short reply saying so. A ✅ at any other stage, or on the goal post instead of the proposal post, gets a reply explaining why nothing happened. Approving again by either route never queues assignments twice: a later ✅ reposts the confirmation without changing state, and repeating `planning approve` does nothing. Each reaction is handled once, keyed by post, user, emoji and time, so removing and re-adding a reaction counts as a new request.

### State commits

Indra commits its own state changes: nobody commits `state.json` by hand. Every write (goal started, brief updated, drafting started, proposal drafted, approval, and each assignment status change) is committed in the `indra-state` checkout right after the write, with a short message naming the change, such as `Approve goal goal-003: 2 assignments`. A write that changes nothing makes no commit. The commit contains only `state.json`; other staged or untracked files in the checkout are left alone.

The bridge and the seat runners take turns through a lock file, `<state-checkout>.runtime/state.lock`, so their writes never overwrite each other; a lock left by a process that no longer runs is cleared. If the commit fails, the write is rolled back and the command reports the error. If a process stops between writing and committing, the next write finishes that commit first. If `state.json` has changes that Indra did not make, Indra refuses to write and says so rather than committing them; commit or discard those changes, then retry. After each commit Indra runs `git push` in the background, best effort: a failed push never blocks or fails a write, and the next successful push carries every earlier commit.

The terminal UI keeps the checkout in step with its remote, so `indra-state` PRs merged on GitHub reach Indra without a manual pull. It syncs once on open, before hosting the bridge and seats, and then every 60 seconds while it runs; only the UI syncs, and the hosted processes see the new `state.json` the next time they read it. A sync takes the same `state.lock` as writes. It runs `git fetch`, then fast-forwards the current branch to its upstream, or, when Indra has local commits that are not pushed yet, rebases them onto the upstream; then it runs a plain `git push` for anything still unpushed. It never force-pushes and never drops a commit. If the rebase conflicts it runs `git rebase --abort`, leaving the checkout exactly as it was; if a tracked file has uncommitted changes, or a rebase or merge is unfinished, it does nothing. Either way, and when the remote cannot be reached, the UI shows the problem on its sync line and tries again on the next interval. The sync line shows the time (UTC) and result of the last sync; when a sync changed `state.json`, the screen refreshes at once.

The bridge uses Chick's 1Password bot item (`Mattermost bot - chickcorea`) and the existing authenticated Codex CLI. It does not accept an API key. Runtime session IDs, processed post IDs and reactions, the proposal post IDs, run timestamps, and any reported usage live outside Git in `<state-checkout>.runtime`; preserve that directory to resume after a restart. Keep only one `planning serve` process for this checkout; `planning propose` and `planning approve` share a per-goal lock file (`<state-checkout>.runtime/GOAL_ID.lock`) with it. The bridge polls every three seconds, serializes Chick's messages, caps a poll at 20 inputs, ignores its own posts, and scans the thread for delivery IDs before retrying pending replies. If a process dies in the narrow interval after a state update and before its pending delivery record is saved, inspect the thread and state before restarting. If `planning start` reports an orphan root post, inspect that post before trying again. 1Password may require desktop authorization.

`planning host` launches the same bridge in a dedicated detached tmux session. It uses an Indra-owned socket and exact session name derived from the state checkout, and reuses an already verified pane on repeated calls. It records the tmux server/session identity and pane in `<state-checkout>.runtime/tmux-host.json`, then waits for the bridge's first successful poll before reporting readiness. `planning status` prints a neutral JSON session snapshot, including an attach target only while that exact, live pane remains available. A connected bridge can show an idle seat between Codex turns. The target is `socket:session`; split it and pass the pieces as argv to `tmux -L SOCKET attach-session -t =SESSION`. Attaching or detaching does not stop the bridge. A stale or missing ownership record is never grounds to kill or attach another session. The host command requires the built `dist/cli.js` (`npm run build` first).

## Developer seats

A Developer seat picks up approved work and runs the dev loop on it with Codex:

```sh
npm start -- seat run --seat SEAT_ID --state /path/to/indra-state
```

It refuses a Team Lead seat or a seat that is not in `state.json`. Run one process per seat. The seat reads approved goals (`stage: "approved"`) and their `assignments`. A seat owns at most one `running` or `in-review` assignment. When idle, it claims its own oldest `queued` assignment and marks it `running` in `state.json` before doing any work. It then:

1. makes sure Indra's own clone of the team's project (`project.github`) exists at `<state-checkout>.runtime/projects/OWNER/REPO`, cloning it with `gh repo clone` when missing, fetches its `origin main`, and creates a fresh worktree and branch `SEAT_ID/GOAL_ID-OUTCOME_ID` from that clone's `origin/main` under `<state-checkout>.runtime/worktrees/`; nobody gives Indra a local path;
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

`npm start -- --state PATH` opens the OpenTUI Solid screen with the local state, the runtime session reader and the seat process supervisor (`src/supervisor.ts`); `--ui` is an alias. It polls state, session and process snapshots every two seconds, keeps the selected stable seat during refresh, and labels disconnected occupancy as unknown while still showing recorded planning goals and activity. The team view shows each seat's role and newest recorded activity; Enter opens its detail. An attach action is available only for a verified Indra-owned tmux target and opens a read-only bridge event/log view. Detaching or quitting does not pause or stop the bridge. The 80-column view keeps all five Yahaha seats in the roster and moves the expanded detail to its own screen.

`src/state-domain.ts` defines neutral inventory records. `src/planning.ts` owns state writes and local resume metadata. `src/planning-bridge.ts` routes Chick's thread and validates model output. `src/codex-runtime.ts` and `src/planning-mattermost.ts` are the provider adapters. There is no HTTP preview server.
