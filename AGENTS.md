# AGENTS.md

This file is the one place that says what must pass. CI on the pull request is the final check, and it must pass before merge. There is no other required process.

## Checks

CI on the pull request runs `npm run typecheck`, `npm test` and `npm run build`. Each must exit 0 before merge.

## Commands

Each command exits 0 on success. `npm ci` installs dependencies; a fresh checkout or worktree needs it before the others.

- `npm run typecheck` type-checks all of `src` and `tests` with `tsc --noEmit`. It covers any TypeScript change.
- `NODE_OPTIONS=--experimental-ffi npx vitest run <file>`, for example `tests/planning.test.ts`, runs one test file. The flag is needed for the native OpenTUI renderer, as in the `test` script in package.json.
- `npm test` runs every test file once.
- `npm run test:watch` reruns the affected tests on each save.
- `npm run build` builds `dist/cli.js` with Vite. It covers the CLI entry point, the terminal UI, the Vite config and dependencies. `planning host` and `npm start` need it.

## Review

Every PR gets one review, posted on the PR itself as line comments plus a verdict (`gh pr review --approve` or `--request-changes`). The review runs as soon as the PR opens, alongside CI rather than after it. The reviewer is a fresh agent, never the one that wrote the change. A PR merges when CI passes and the review is addressed.

**Review account:** `satori-miyamoto`. Post reviews with `GH_CONFIG_DIR=~/.config/gh-yahaha-bot gh …`, and check first that `GH_CONFIG_DIR=~/.config/gh-yahaha-bot gh api user --jq .login` prints `satori-miyamoto`. Use it only for reviews. Everything else (commits, PRs, merges) uses the owner's default `gh` login.

Reviewers flag only these, each with the file, the line and a one-line reason:

- **Credentials:** no token, password or API key in command arguments, environment variables, the `indra-state` repository, logs or error messages. Credentials come from 1Password at run time. One exception: the owner may supply the 1Password service account token as `OP_SERVICE_ACCOUNT_TOKEN` in the environment of `npm start`. Indra never sets it, logs it, or passes it (or any other `OP_*` variable) to a child process other than `op`; tmux panes, seat runners, Codex and Claude agents, `git`, `gh` and `npm` run without it. It is written only to the 0600 staged file under `<state-checkout>.runtime`. A second exception: the owner may supply a GitHub token for the state repository as `INDRA_STATE_GITHUB_TOKEN` in the environment of `npm start`. Indra captures it at start-up like `OP_*` (`src/op-env.ts`) and gives it only to the state checkout's `git fetch` and `git push`, in that git process's environment, read by a credential helper; it never appears in arguments, logs, error messages, remotes, git config or any other child process, `op` included. See `docs/state-repo.md`.
- **Mattermost inventory:** the `--mattermost` mode sends only `GET` requests and refuses redirects. It never writes to Mattermost.
- **Mattermost writes:** Chick's bridge and the Product and Developer seat runners write only their own posts, plus one exception: each may add its own bot to its team's Mattermost team and home channel from `indra-state`, with its own token and only after a `GET` shows it is not a member. Nothing adds other users or joins other channels.
- **State writes:** anything written to `state.json` stays valid against the v1 schema and Indra's reference checks. Runtime metadata (session IDs, delivery cursors, usage) stays in `<state-checkout>.runtime`, not in Git.
- **tmux:** never kill, reuse or attach a tmux session or pane that Indra doesn't own and hasn't verified. A stale or missing ownership record is not grounds to act on another session.
- **Approval:** work begins only after a person's ✅ on the matching proposal post or the owner's `planning approve`. Both use the same proposal approval validation. Reactions are read with GET; bots, the bridge's own account and all team seats never count as human approval. Approval freezes the goal's nonempty `ownedFiles` and proposal. There is no second human release or archival gate.
- **Sprints:** a goal's approved `ownedFiles` is its sprint's file boundary. Concurrent goals and parallel lanes own disjoint scopes, including possible future filenames. Developers branch from, target and merge into `sprint/<goal-id>`. Integration and revert PRs target main. Automated merges use immediate `--squash --match-head-commit` only with fresh `satori-miyamoto` approval on that exact head, passing CI and verified server-enforced sole-bot Code Owner protection; see docs/remodel-contract.md. Never arm deferred `--auto` or bypass missing protection. Verify the actual merge. This immediate-merge exception was owner-approved for the remodel. The owner's safety valve remains `planning rollback`. Release still requires verified running-build evidence and ancestry. The only other main PR is `retro/<goal-id>`, changing only `docs/retros/<goal-id>.md` with the frozen, verified thread content; it uses the same protected merge gate with its own fresh current-head bot review and green CI. Closed-unmerged PRs, missing delivery, failed reviews and failed CI keep the goal open. Suggested process changes remain owner proposals. Preserve historical human merge evidence, never invent it. `release-reverted` and evidence-based `legacy-migration` closures remain readable. The `remodel-closure` exception applies only to the six goals listed in docs/mission.md at their existing implement/release/retro stages, preserves all history and observed workflow facts, and never invents approvals or retros. Runtime sessions, cursors, usage and mutable lane orchestration remain outside Git. `.github/workflows/ci.yml` must run for PRs to any base.
- **Team home:** a team's channel and project come from `indra-state` (`externalIdentities.mattermost.homeChannelId`, `project.github`), never from prompts or options. Project checkouts stay under `<state-checkout>.runtime/projects/`.
- **Bugs:** wrong logic, and tests that would pass without the code under test working.

Don't comment on style or naming. Put small edge cases in a follow-up issue rather than blocking the PR.

Claude write-mode seats run in Claude Code's `auto` permission mode (owner decision): a classifier approves safe actions instead of prompting. Read-only reviewer runs keep `plan`/`dontAsk`.

## Git

- One branch per PR, created from `origin/main`: `git checkout --no-track -b <branch> origin/main`. Push with `git push -u origin HEAD:refs/heads/<branch>`.
- Small PRs, one concern each. Split big work into a chain.

## Never commit

Credentials, access tokens, or runtime metadata from `<state-checkout>.runtime`.
