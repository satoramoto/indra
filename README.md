# Indra

Indra reads stable team seats and planning goals from an `indra-state` Git checkout. The planning commands connect Chick's durable seat to an authenticated coding-agent CLI session and a dedicated Mattermost thread.

## Direction

Indra is a startup simulator: a control plane where stable team seats in Mattermost are filled by coding-agent sessions. This section describes the proof of concept we are building toward. The rest of this README describes what runs today.

**Roles.** There are exactly two permanent roles. The Team Lead is Chick Corea (`seat-001`). Every other seat is a Developer. There are no extra-role claims and no formal soft roles. A sprint proposal can describe soft responsibilities in prose.

**Seats and tasks.** A seat limits concurrency by task ownership: each seat owns one logical workstream at a time. Inside that task it can start any number of subagents with the developer, reviewer and quick-fix profiles.

**Rules inside a task.** Build, then review by a fresh agent, fix, merge. The reviewer is never the same agent reviewing its own work in the same context.

**People and state.** The only human step is approving plans. Agents merge their own PRs once CI is green and the fresh reviewer has approved. Indra writes planning records to `indra-state`. Indra reads live Mattermost (the existing `--mattermost` mode) to confirm it matches `indra-state`; that read stays read-only.

**POC milestone.** The full team loop runs on the Indra repository itself: a goal is set, Chick plans, a human approves, a Developer seat does the work in a worktree, opens a PR, starts a fresh reviewer, fixes, merges, then goes idle. Codex is the default; each seat can select Claude Code for new sessions. Existing sessions stay on their originating engine.

**Planned PR order.**

1. CI.
2. The two roles, plus the check that live Mattermost matches `indra-state`.
3. Plan approval, with assignment of approved work to seats.
4. Developer seats running the task loop.

## Run

```sh
npm start
```

That is the only thing to run. Closing the terminal window leaves Indra running; run `npm start` again, from any terminal, to bring the same screen back. `q` in the UI quits it. The terminal UI opens on the team and makes sure Chick's planning bridge and one runner per Developer seat are running; you never start or manage those processes yourself. Each seat row shows its process (running, stopped or no credential), the assignment it holds (outcome, status, PR link) and its newest thread activity. Keys: `n` starts a new planning goal when the team has no open goal (type only the goal, then Enter), `s` restarts the selected seat's process, `x` stops it, Enter opens the seat's detail, `a` watches its live process read-only (`Ctrl-]` comes back to Indra; the mouse wheel or `PgUp` scrolls back, and `q`, `Esc` or scrolling to the bottom returns to live), and `t` opens a read-only transcript of the seat's current Claude or Codex session that follows it live (`Esc` or `q` closes it). `?` lists every key. `q` quits and leaves every process running.

Team and seat views show the same persisted ceremony: **planning → proposal → implement → release → retro**. Clarification belongs to planning; Chick's draft and the owner's plan review belong to proposal; seat builds, reviews and fixes belong to implement; integration and self-update belong to release; the retro draft and publication belong to retro. Each card keeps outcome and PR links, displays why release or retro is waiting, and shows closure separately. A merged integration PR or an available build does not advance the displayed stage: release completes only when the running application and bridge are confirmed and the transition is recorded. Closed goals remain in the scrollable history (`PgUp`/`PgDn`). An open goal blocks `n` through retro publication; the UI names that goal and rechecks before submitting typed input. Legacy goals without a persisted ceremony remain visible, block new starts, and need migration before ceremony actions become available.

In Chick's seat detail, only applicable ceremony keys appear. `P` (Shift-p) requests a proposal during planning; `A` (Shift-a) approves a draft awaiting review during proposal. `I` opens the integration PR when there is merged work and no outcome building or in review. `M` identifies its operation as **merge release**, **merge revert** or **merge retro**, and the confirmation names the goal and PR URL. `V` opens a revert PR for a merged sprint (see [Sprints](#sprints)), including a sprint retained in closed history. Each action requires `y` confirmation; other keys cancel. Confirmations are revalidated against fresh state before dispatch, so a changed proposal or PR requires confirmation again. Backend guards still check the operation and CI; refusals refresh the UI. In the Mattermost goal thread, react 📝 (`:memo:`) on Chick's goal post to request a proposal and ✅ (`:white_check_mark:`) on Chick's proposal post to approve it.

Indra updates itself: about every 60 seconds it pulls new commits on `main`, rebuilds, and reloads the UI and restarts the bridge and seat runners once each is idle, so you rarely need to restart it. `U` (Shift-u) pauses or resumes that; while paused Indra doesn't pull, build or switch builds, `r` only reports what waits on `origin/main`, and the setting survives restarts (`<state-checkout>.runtime/self-update.json`). `R` (Shift-r), after a `y`/`n` naming both versions, switches back to the previous build (`dist-previous`), pauses updates so the bad commit isn't rebuilt, and reloads and restarts like an update; the status line then says "rolled back to SHA".

Each team is bound to a project and a home channel, both recorded in `indra-state` on the team: `project.github` (`owner/repo`) and `externalIdentities.mattermost.homeChannelId`. Starting planning never asks for either; when one is missing, the UI names the missing field instead of opening the goal input.

## Under the hood

First run in a checkout: `npm ci` then `npm run build`. Node.js 26.4.0 or newer is required; the launcher passes Node's `--experimental-ffi` flag without changing the system Node. The state checkout is the sibling `../indra-state` by default; `INDRA_STATE_REPO` or `--state PATH` overrides it (`--state` wins). `npm start -- --once` prints one state snapshot and exits.

On open, the UI first syncs the state checkout with its remote (see below), then hosts each missing process in its own detached tmux session on an Indra-owned socket, exactly as `planning host` does: Chick's `planning serve` for the Team Lead seat and `seat run --seat SEAT_ID` for each Developer seat. A verified live session is reused, never duplicated; a session Indra does not own is never touched. Ownership records live in `<state-checkout>.runtime/tmux-host.json` (bridge) and `tmux-seat-SEAT_ID.json` (seats). Before hosting anything, the UI stages the 1Password service account token with 0600 permissions in `<state-checkout>.runtime/op-service-account-token`. To avoid 1Password desktop prompts entirely, start Indra with the token in your shell as `OP_SERVICE_ACCOUNT_TOKEN` (for example `OP_SERVICE_ACCOUNT_TOKEN=… npm start`, the variable `op` itself understands): the UI stages it from there without running `op`, and every `op read` Indra runs uses the service account. Indra never sets, logs or stores that variable elsewhere, and removes it and every other `OP_*` variable from the environment of all child processes except `op`, including the tmux panes (even when the tmux server was started with it), seat runners, Codex, `git`, `gh` and `npm`. Without the variable, Indra uses a non-empty token already staged in that file (for example by a session hook that stages it before `npm start`) both for hosted processes and for its own `op read`s, so reloads after a self-update and seat restarts do not prompt. Only when neither exists does the UI read the token (`op://Agent Rig/cvldgk5zipacvawubvsvwmy5xq/credential`) through the normal `op` CLI, one desktop authorization. Restarting a seat that shows **no credential** reads it again. If 1Password rejects the staged token (for example after rotation), Indra removes the staged file and says so; the next start or seat restart stages a new one. Hosted processes read their bot token (the `token` field of `Mattermost bot - USERNAME`) headlessly, setting `OP_SERVICE_ACCOUNT_TOKEN` only in the environment of their own `op read`. A hosted process never falls back to a desktop prompt: without a staged token, or when its bot item is missing, it signals that before it exits and its seat shows **no credential**. Processes that were already running pick up a newly staged token when restarted with `s`. A new goal runs `planning start --goal TEXT` through the built CLI, and `A` runs `planning approve --goal GOAL_ID`; both read Chick's bot token with the staged service account token, so no credential enters the UI process. `P` runs `planning propose --goal GOAL_ID`, which reads no credential: it records the request for the bridge, which drafts the proposal on its next poll. The manual commands below still work for debugging.

`npm start` runs a small launcher (`dist/launcher.js`) that runs the UI as a child process in the same terminal and starts it again, on the current build, when it exits with code 75 (reload); any other exit ends it. Every build writes `dist/build-stamp.json`. About every 60 seconds the UI checks the Indra checkout it runs from: when `origin/main` has new commits and the checkout is on `main`, has no uncommitted changes to tracked files and can fast-forward, it runs `git pull --ff-only`, then `npm ci` only when `package-lock.json` changed since the running build, then `npm run build`. On another branch, with uncommitted changes, or when `main` has diverged, it does nothing and the status line says why; it never resets, stashes or discards anything. A failed build keeps the old build running and shows the error; the same commit is not rebuilt. When `dist/` holds a new build (from a self-update or an `npm run dev` rebuild), the UI reloads itself once nothing is in flight (no goal being typed, started or approved, no state sync) and reopens the same seat or view. The supervisor restarts each hosted process on an older build through its owned tmux session, at a safe point only: the bridge between polls (no Codex turn in flight, pending deliveries saved), a seat runner between steps and only while it holds no `running` or `in-review` assignment. Each poll or step holds `<state-checkout>.runtime/turn-bridge.lock` or `turn-seat-SEAT_ID.lock`, which the supervisor takes before stopping the process. Until then the seat shows **update pending**. The status line shows the running version (short SHA) and the update state: up to date, updating, update pending, or blocked with the reason. Run without the launcher (`node dist/cli.js`), the UI only reports that a new build is ready.

The app validates the version 1 structure and references before showing a snapshot. Each seat's `roles` holds exactly one of the two roles, `Team Lead` or `Developer`, and each team has exactly one Team Lead. Validation errors name the invalid field or reference. A failed refresh never presents malformed data as an empty roster. The `indra-state` repository contains [the formal JSON Schema](https://github.com/satoramoto/indra-state/blob/main/schema/v1/state.schema.json); `state.json` carries `$schema` and `schemaVersion`. The current sprint's work and allocations are **draft proposals**, not approved assignments or active execution.

## Chick planning

Use a writable, dedicated `indra-state` Git checkout with the compatible version 1 schema. `planning start` creates the thread, saves the goal and brief in its `state.json`, and opens Chick's Codex session. The thread goes to the team's home channel (`externalIdentities.mattermost.homeChannelId` on the team) and the goal records the team's project (`project.github`) in `projectRefs`. There are no channel or project options: when either field is missing, `planning start` stops with an error naming it. The app does not adopt existing conversations.

```sh
npm start -- planning start --state /path/to/indra-state --goal "Familiarize yourself with this project and propose a roadmap"
npm start -- planning propose --state /path/to/indra-state --goal GOAL_ID
npm start -- planning approve --state /path/to/indra-state --goal GOAL_ID
npm start -- planning integrate|merge|rollback --state /path/to/indra-state --goal GOAL_ID
npm start -- planning serve --state /path/to/indra-state
npm start -- planning host --state /path/to/indra-state
npm start -- planning status --state /path/to/indra-state
```

Optional `--participant SEAT_ID` records intended contributors. Only Chick runs in this MVP; listing George or another seat does not launch them. In the new thread, reply normally to clarify the brief. Actions are emoji reactions, because Mattermost treats a message starting with `/` as a slash command. React 📝 (`:memo:`) on Chick's goal post to request a draft. The bridge moves the goal through `clarifying`, `drafting`, and `awaiting-review`, writes the validated proposal into `state.json`, and posts its summary in the thread. Chick assigns every proposed outcome to a Developer seat on the team, one outcome per seat where the seats allow. The bridge never approves or executes proposal work on its own. A 📝 while the proposal awaits review reposts it. The owner can request the draft from the terminal instead, with `P` in Chick's seat detail (`planning propose --goal GOAL_ID`). It works only while the goal is `clarifying`; at any other stage it prints why and changes nothing. It records the request in the goal's runtime file under the same per-goal lock the bridge polls with, and the bridge drafts it on its next poll through the same code as 📝, with the same thread posts. A 📝 and a `planning propose` together draft once: whichever the bridge handles first drafts, and a `propose` that finds the proposal already drafted is dropped without a post. Repeating `planning propose` records nothing new.

To approve a proposal, a person (a Mattermost user that is not a bot) reacts ✅ (`:white_check_mark:`) on Chick's proposal post while the goal is `awaiting-review`, or the owner presses `A` in the terminal UI (`planning approve --goal GOAL_ID`). Both routes run the same approval code: the goal moves to `approved`, one `queued` assignment is recorded per outcome for its Developer seat, and a confirmation listing each outcome and seat is posted in the thread. Developer seat runners pick up queued assignments from `state.json`. The bridge reads reactions with `GET` only and counts a reaction only from a person: not a bot (`is_bot` true), not the bridge's own account and not Chick's seat. It ignores its own reactions; a reaction from another bot or from Chick's seat changes nothing and gets a short reply saying so. A ✅ at any other stage, or on the goal post instead of the proposal post, gets a reply explaining why nothing happened. Approving again by either route never queues assignments twice: a later ✅ reposts the confirmation without changing state, and repeating `planning approve` does nothing. Each reaction is handled once, keyed by post, user, emoji and time, so removing and re-adding a reaction counts as a new request.

### Sprints

Each approved goal is a sprint that lands on main as one PR and can be rolled back as a unit. Approval (✅ or `A`) first creates `sprint/GOAL_ID` on the team's GitHub repository from main's current head (reusing it if it exists; if GitHub fails, nothing is approved) and records `integration: { branch, baseSha, status: "collecting" }` on the goal in the same commit as the assignments. Seats branch from the sprint branch, open their PRs against it and merge it into their branch when behind or conflicting; they never push to main. When every assignment is `merged`, the bridge opens one integration PR from `sprint/GOAL_ID` into main whose body summarizes the goal and each outcome with its seat and PR, posts it in the thread and sets status `pr-open`. When outcomes failed instead, Chick says so once, and the owner can still open the PR for what merged with `I` in Chick's detail (`planning integrate`); failed and still-queued outcomes are listed as failed or skipped, and seats stop claiming a sprint's queued outcomes once its PR is open. Merging into main is the second human step: a person's ✅ on the integration post (same person-only rules as approval) or `M` in Chick's detail (`planning merge`, after `y`/`n`) squash-merges it once its CI is green, records `mergedSha` and status `merged`, and posts it. `V` (`planning rollback`, after `y`/`n`) opens a PR on main that reverts `mergedSha` from branch `revert/GOAL_ID` in Indra's project clone, records it as `revertPrUrl` and posts it; merging it goes through the same ✅ or `M` step and sets status `reverted`. Every step is idempotent and runs under the goal's lock. Goals approved before sprints existed keep targeting main.

### State commits

Indra commits its own state changes: nobody commits `state.json` by hand. Every write (goal started, brief updated, drafting started, proposal drafted, approval, and each assignment status change) is committed in the `indra-state` checkout right after the write, with a short message naming the change, such as `Approve goal goal-003: 2 assignments`. A write that changes nothing makes no commit. The commit contains only `state.json`; other staged or untracked files in the checkout are left alone.

The bridge and the seat runners take turns through a lock file, `<state-checkout>.runtime/state.lock`, so their writes never overwrite each other; a lock left by a process that no longer runs is cleared. If the commit fails, the write is rolled back and the command reports the error. If a process stops between writing and committing, the next write finishes that commit first. If `state.json` has changes that Indra did not make, Indra refuses to write and says so rather than committing them; commit or discard those changes, then retry. After each commit Indra runs `git push` in the background, best effort: a failed push never blocks or fails a write, and the next successful push carries every earlier commit.

The terminal UI keeps the checkout in step with its remote, so `indra-state` PRs merged on GitHub reach Indra without a manual pull. It syncs once on open, before hosting the bridge and seats, and then every 60 seconds while it runs; only the UI syncs, and the hosted processes see the new `state.json` the next time they read it. A sync takes the same `state.lock` as writes. It runs `git fetch`, then fast-forwards the current branch to its upstream, or, when Indra has local commits that are not pushed yet, rebases them onto the upstream; then it runs a plain `git push` for anything still unpushed. It never force-pushes and never drops a commit. If the rebase conflicts it runs `git rebase --abort`, leaving the checkout exactly as it was; if a tracked file has uncommitted changes, or a rebase or merge is unfinished, it does nothing. Either way, and when the remote cannot be reached, the UI shows the problem on its sync line and tries again on the next interval. The sync line shows the time (UTC) and result of the last sync; when a sync changed `state.json`, the screen refreshes at once.

The bridge uses Chick's 1Password bot item (`Mattermost bot - chickcorea`) and the existing authenticated Codex CLI. It does not accept an API key. Runtime session IDs, processed post IDs and reactions, the proposal post IDs, run timestamps, and any reported usage live outside Git in `<state-checkout>.runtime`; preserve that directory to resume after a restart. Keep only one `planning serve` process for this checkout; `planning propose` and `planning approve` share a per-goal lock file (`<state-checkout>.runtime/GOAL_ID.lock`) with it. The bridge polls every three seconds, serializes Chick's messages, caps a poll at 20 inputs, ignores its own posts, and scans the thread for delivery IDs before retrying pending replies. If a process dies in the narrow interval after a state update and before its pending delivery record is saved, inspect the thread and state before restarting. If `planning start` reports an orphan root post, inspect that post before trying again. 1Password may require desktop authorization.

`planning host` launches the same bridge in a dedicated detached tmux session. It uses an Indra-owned socket and exact session name derived from the state checkout, and reuses an already verified pane on repeated calls. It records the tmux server/session identity and pane in `<state-checkout>.runtime/tmux-host.json`, then waits for the bridge's first successful poll before reporting readiness. `planning status` prints a neutral JSON session snapshot, including an attach target only while that exact, live pane remains available. A connected bridge can show an idle seat between Codex turns. The target is `socket:session`; split it and pass the pieces as argv to `tmux -L SOCKET attach-session -t =SESSION`. Attaching or detaching does not stop the bridge. A stale or missing ownership record is never grounds to kill or attach another session. The host command requires the built `dist/cli.js` (`npm run build` first).

## Developer seats

A Developer seat picks up approved work and runs the dev loop on it with its selected engine:

```sh
npm start -- seat run --seat SEAT_ID --state /path/to/indra-state
```

It refuses a Team Lead seat or a seat that is not in `state.json`. Run one process per seat. The seat reads approved goals (`stage: "approved"`) and their `assignments`. A seat owns at most one `running` or `in-review` assignment. When idle, it claims its own oldest `queued` assignment and marks it `running` in `state.json` before doing any work. It then:

1. makes sure Indra's own clone of the team's project (`project.github`) exists at `<state-checkout>.runtime/projects/OWNER/REPO`, cloning it with `gh repo clone` when missing, fetches its `origin main` and the goal's sprint branch, and creates a fresh worktree and branch `SEAT_ID/GOAL_ID-OUTCOME_ID` from that clone's `origin/sprint/GOAL_ID` (see [Sprints](#sprints); `origin/main` for a goal without one) under `<state-checkout>.runtime/worktrees/`; nobody gives Indra a local path;
2. runs a new Codex session that implements the outcome under the project's AGENTS.md, runs the targeted tests once, commits, pushes and opens a PR against the sprint branch (the seat sets that base with `gh pr edit --base` whatever the session chose); the assignment becomes `in-review` with its `prUrl`;
3. runs a separate, new Codex session as the reviewer, read-only and without network, which returns its findings; the seat posts them on the PR as one comment with `gh pr comment`;
4. if there are findings, runs one new Codex fix session;
5. before waiting on CI, and again when a merge fails, checks whether the PR is behind or conflicting with its base (the sprint branch); if so it merges the fetched base into its own branch in its worktree (never a rebase or force-push), runs one Codex fix session to resolve any conflicts (at most 2 rounds per assignment, then it fails with "merge conflict with BASE could not be resolved"), and pushes before waiting on CI again;
6. waits with `gh pr checks --watch`, merges with `gh pr merge --squash --delete-branch` when CI is green, marks the assignment `merged`, removes the worktree and goes idle.

Any failure marks the assignment `failed` with a short `note` and the seat goes idle; a failed task's worktree is kept for inspection. On restart the seat resumes an `in-review` assignment from its recorded step; a `running` assignment that never opened a PR is marked `failed` rather than rebuilt. It never takes a second assignment while one is in flight. With nothing queued it checks again every 30 seconds.

Codex runs in the `workspace-write` sandbox with network access, so it can push and use `gh`; the builder and fix sessions may also write the project's shared Git directory, and the reviewer may not. They use the logged-in Codex CLI and `gh`. The seat posts short progress replies (claimed, PR opened, review done, merged or failed) in the goal thread as its own bot, using the 1Password item `Mattermost bot - USERNAME` (the seat's Mattermost username), as Chick's bridge does. A missing item stops the seat with an error naming it. Codex session IDs, usage and the task's step live in `<state-checkout>.runtime/seat-SEAT_ID-GOAL_ID-OUTCOME_ID.json`, not in `state.json`.

## Seat engines and optional personas

Create `<state-checkout>.runtime/seat-engines.json` to select an engine by the seat ID in `state.json`:

```json
{
  "seat-001": "claude",
  "seat-005": "codex"
}
```

The file is a plain seat-ID-to-engine object. Only `codex` and `claude` are accepted; unknown seat IDs, invalid JSON, invalid engines and unreadable files stop the command with a configuration error. A missing file or omitted seat selects Codex. This is machine-local configuration, never part of `state.json` or a Git commit. Restart the bridge or seat runner after changing it. Planning start/serve/approve/integrate/merge/rollback and Developer build/review/fix all use this selection. `planning propose` still only records the owner's request without a credential or model call.

Install and sign in to the chosen CLI before using it. Claude uses the logged-in `claude` executable, following the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference). The adapter pipes prompts on stdin, supplies `--json-schema` on every turn and accepts only a successful JSON result with `structured_output` and a session UUID. Usage and timestamps keep the existing runtime-record format. Claude handles are stored as **`claude:<UUID>`**; existing bare Codex IDs remain unchanged. A saved handle always selects its originating engine even after the seat configuration changes. Chick resumes that exact session; each Developer build, review and fix remains a fresh session. No cross-engine migration, automatic fallback or interrupted-turn replay occurs.

Claude uses `plan` permissions for planning/review and `acceptEdits` for Developer build/fix. Its sandbox is required: unavailable sandbox support fails the run, and unsandboxed retries are disabled. Planning/review permits file reads and read-only shell exploration, denies filesystem writes and network access, and exposes no edit, browser, MCP or subagent tools. Developer turns can edit the worktree and the explicit extra directories (the shared Git directory), and run sandboxed commands with network access. Claude's own protected paths and managed policies still apply; an operation those policies deny fails without bypassing permissions. User/project/local settings, hooks, slash commands and unconfigured MCP servers cannot expand these grants. See [Claude sandboxing](https://code.claude.com/docs/en/sandboxing) for platform dependencies. The adapter passes no API-key/token environment variables. It bounds stdout to 10 MB and stderr to 100 KB, terminates cancelled/timed-out processes, and withholds provider diagnostics from failures.

Seats run on a minimal baseline harness: the engine's built-in defaults plus the project's own AGENTS.md, never the owner's personal instructions, skills, MCP servers, hooks, plugins, agents or profiles. Codex runs with `CODEX_HOME` set to an Indra-owned home, `<state-checkout>.runtime/harness/SEAT_ID/codex/` (0700, created on first use), holding a `config.toml` with only the seat model and reasoning effort (`gpt-6-astra`, `max`; rewritten on every run) and `auth.json` as a symlink to the owner's `~/.codex/auth.json`, so the login is shared and never copied. Codex sessions live in that home, so a Chick session started before this change cannot be resumed; the run says so, and a new goal starts a fresh one. Claude keeps the owner's config directory, because its login is in the macOS Keychain keyed by that directory and a separate `CLAUDE_CONFIG_DIR` is signed out; it is isolated with the flags above plus `autoMemoryEnabled: false`. Its sessions, `~/.claude.json` and Keychain login stay the owner's.

Optional persona content lives in **`personas/yahaha.json` under the Indra application root**, using this contract:

```json
{
  "seat-001": {
    "voice": "A short description of how this seat speaks.",
    "background": "A short, factual background.",
    "funFact": "A verified fun fact, with a source link if useful.",
    "postPrefix": "A short recurring phrase for progress posts."
  }
}
```

Each field is a nonempty string of at most 1,000 characters; `postPrefix` is optional. Missing files or seat profiles preserve the current prompts and posts exactly. The loader resolves the existing application root from source, `dist/` and versioned `builds/<id>/` bundles, independent of the team's project working directory. Profiles add voice/background/fact context above either engine. Chick's and Developers' thread posts use the authored prefix, or a background/fact footer when no prefix is supplied. Original task and authorization wording, channel/root IDs, delivery IDs and recovery behavior are preserved. This adapter supplies the loader and decorators; the dependent persona outcome supplies the repository's actual profiles.

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

This mode requires network access to `https://mattermost.newegypt.io` and an existing signed-in 1Password CLI session with access to `op://Agent Rig/Mattermost/access_token` (or `OP_SERVICE_ACCOUNT_TOKEN` in the environment, whose service account `op` then uses instead). The launch commands use Node's system CA trust. Apart from that one variable, no token belongs in environment variables, arguments, or the state repository. The adapter sends only `GET` requests, suppresses credential-bearing diagnostics, and refuses HTTP redirects. Mattermost visibility is limited to that credential's permissions. Its refresh time is the last successful read, and agent occupancy is labeled **not connected yet**.

## Develop and verify

```sh
npm run dev -- --state /path/to/indra-state
npm run test:watch
npm test
npm run typecheck
npm run build
```

`npm run dev` watches source files and rebuilds the CLI and terminal UI; run `npm start` in a second terminal after the initial build. Vite compiles Solid TSX with the universal transform and Vitest runs fixture and native renderer tests. There is no web server or HTTP preview.

`npm start -- --state PATH` opens the OpenTUI Solid screen with the local state, the runtime session reader and the seat process supervisor (`src/supervisor.ts`); `--ui` is an alias. It polls state, session and process snapshots every two seconds, keeps the selected stable seat during refresh, and labels disconnected occupancy as unknown while still showing recorded planning goals and activity. The team view shows each seat's role and newest recorded activity; Enter opens its detail. Watching (`a`) is available only for a verified Indra-owned tmux target. Before the owner watches, Indra binds `Ctrl-]` to detach, `PgUp` to scroll back and turns the mouse on, all on its own seat socket only, adds a status line to that verified session, and switches that verified pane's input off, so nothing typed reaches the run. The transcript (`t`, `src/session-transcript.ts`) reads the engine's own log, never writes to or resumes the session, and redacts every line it shows. Detaching or quitting does not pause or stop the bridge. The 80-column view keeps all five Yahaha seats in the roster and moves the expanded detail to its own screen.

`src/state-domain.ts` defines neutral inventory records. `src/planning.ts` owns state writes and local resume metadata. `src/planning-bridge.ts` routes Chick's thread and validates model output. `src/codex-runtime.ts` and `src/planning-mattermost.ts` are the provider adapters. There is no HTTP preview server.
