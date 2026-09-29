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

- **Credentials:** no token, password or API key in command arguments, environment variables, the `indra-state` repository, logs or error messages. Credentials come from 1Password at run time. One exception: the owner may supply the 1Password service account token as `OP_SERVICE_ACCOUNT_TOKEN` in the environment of `npm start`. Indra never sets it, logs it, or passes it (or any other `OP_*` variable) to a child process other than `op`; tmux panes, seat runners, Codex and Claude agents, `git`, `gh` and `npm` run without it. It is written only to the 0600 staged file under `<state-checkout>.runtime`.
- **Mattermost inventory:** the `--mattermost` mode sends only `GET` requests and refuses redirects. It never writes to Mattermost.
- **Mattermost writes:** Chick's bridge and the Developer seat runners write only their own posts, plus one exception: each may add its own bot to its team's Mattermost team and home channel from `indra-state`, with its own token and only after a `GET` shows it is not a member. Nothing adds other users or joins other channels.
- **State writes:** anything written to `state.json` stays valid against the v1 schema and Indra's reference checks. Runtime metadata (session IDs, delivery cursors, usage) stays in `<state-checkout>.runtime`, not in Git.
- **tmux:** never kill, reuse or attach a tmux session or pane that Indra doesn't own and hasn't verified. A stale or missing ownership record is not grounds to act on another session.
- **Approval:** nothing approves or starts proposal work without the human plan approval step: a person's ✅ reaction on Chick's proposal post, or the owner's `planning approve` from the terminal UI. Both go through the same approval code. Reactions are read with `GET` only, and reactions from bots, the bridge's own account or Chick's seat never count.
- **Sprints:** an approved goal's seats branch from, target and merge into `sprint/<goal-id>`, never main. The sprint's integration PR and its revert PR target main, and they merge only through the second human step: a person's ✅ on their thread post (same rules as approval) or the owner's `planning merge` (`M`), and only once CI is green. The sole additional main-targeting PR is `retro/<goal-id>`: after the released build is running, it may change only `docs/retros/<goal-id>.md`, containing the same frozen retrospective posted by Chick. It requires a fresh `satori-miyamoto` approval on the current head, passing CI, and a new human ✅ on its own archival post or owner `M`. Closed-unmerged PRs and failed delivery, review or CI keep the goal in retro. Close only after verified thread delivery and archival merge; suggested process changes remain owner proposals. `.github/workflows/ci.yml` must keep running on PRs to any base.
- **Team home:** a team's channel and project come from `indra-state` (`externalIdentities.mattermost.homeChannelId`, `project.github`), never from prompts or options. Project checkouts stay under `<state-checkout>.runtime/projects/`.
- **Bugs:** wrong logic, and tests that would pass without the code under test working.

Don't comment on style or naming. Put small edge cases in a follow-up issue rather than blocking the PR.

## Git

- One branch per PR, created from `origin/main`: `git checkout --no-track -b <branch> origin/main`. Push with `git push -u origin HEAD:refs/heads/<branch>`.
- Small PRs, one concern each. Split big work into a chain.

## Never commit

Credentials, access tokens, or runtime metadata from `<state-checkout>.runtime`.
