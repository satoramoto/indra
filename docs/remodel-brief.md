# Remodel brief

This is the orchestrator's brief for building the model in [mission.md](mission.md). It is written to be pasted, whole, into a Codex conversation running in this repository. Read `docs/mission.md` and `AGENTS.md` first.

## Your role

You are the orchestrator for the remodel: the person the mission doc calls "the owner" will only approve and redirect. You plan the work into a contract PR plus file-disjoint lanes, dispatch a native subagent per lane, get every PR reviewed the moment it opens, triage reviews, dispatch fixes, merge on green, and keep a running board in this conversation. You do not write the lanes' code yourself.

Work the way the mission doc's "Rules that make it work" say. In particular: outcomes not procedures, every brief in the standard shape, disjoint files per lane, review on open, one fix agent per problem, checks once at the end, decisions in PR bodies, never poll.

## Authorizations for this task

- Create branches from `origin/main` (`git checkout --no-track -b <branch> origin/main`), push them (`git push -u origin HEAD:refs/heads/<branch>`), open PRs against `main`, and merge them with `gh pr merge --squash --match-head-commit <reviewed-head>` once CI is green and the review verdict is approve. This is the specific authorization the personal orchestration policy asks for; it covers this task only.
- Use the owner's default GitHub account. Indra records exact-head review evidence from a fresh independent read-only agent and can post an informational verdict comment; no separate reviewer account or Code Owner gate is required.
- Edit AGENTS.md in the contract lane when a check or a review rule changes. Nothing else edits it.
- Never touch `../indra-state` or `<state-checkout>.runtime`. The state repository is data, not a lane. Migration code that closes stuck goals runs later under `npm start`, not now.

## Where this differs from the personal orchestration policy

`~/.codex/AGENTS.md` describes a coordinator worktree, an Integrator that combines commits, and hand-off of commits rather than branches. For this task, replace that with the lanes-and-PRs model:

- There is no coordinator worktree and no Integrator agent. GitHub is the integration point. Each lane is a branch from plain `origin/main` in its own worktree, delivered as one PR. Lanes merge in any order because their files are disjoint.
- Review happens on the exact PR head, by a fresh independent subagent that only reads (`gh pr diff N`), never edits, and returns findings plus APPROVE or REQUEST_CHANGES for the host to record.
- The personal `developer`, `research`, `review` and `integrator` agent definitions are not the roles here. Use native subagents with the briefs below; if the client lets you select a personal agent definition, don't. Two roles inside a lane are enough: a lead per lane, and workers a lead may launch for independent files of its own lane. Workers own exactly one file each, run nothing, and never commit. The lead runs the checks once, commits, pushes and opens the PR.
- The `.claude/agents` definitions in this repository's owner's home directory are Claude Code files and do not apply to Codex. Ignore any reference to them.

Everything else in the personal policy still holds: exclusive worktrees, explicit `workdir` on every repository command, never rewriting another owner's refs, never removing a worktree with uncommitted work.

## Machine and checks

There is no compile step. `npm run typecheck` covers every TypeScript change. A lane runs, once, after its final edit:

```
npm run typecheck
NODE_OPTIONS=--experimental-ffi npx vitest run <each test file the lane touched or added>
```

Never `npm test` locally; CI on the PR runs it. Reviewers run nothing. As many lanes as there are lanes can run at once; the only limit is API rate, so if a lane stalls on rate limits, queue the next one rather than adding more.

## The plan

Read the current code before you finalise lanes. The file lists below are a starting point from the module names in `src/`; correct them against what you find, and keep every lane's set disjoint. If two lanes need the same file, that file goes into the contract PR or into exactly one lane.

**Contract PR (lands first, alone, green with stubs):**

- `src/state-schema.ts`, `src/state-domain.ts`, `src/domain.ts`, `src/consistency.ts`, `schemas/*.json`, `schema/v1/*`: a third role `Product`; each team has exactly one Team Lead, one Product, and Developers. A planning goal gains `ownedFiles: string[]` (globs, non-empty once approved). The ceremony's release gate is CI green plus independent agent approval; the human ✅ on the merge post and the owner's `M` are removed from the gate (keep `planning rollback`). Brief and report shapes as JSON schemas in `schemas/` (outcome list, owned files, do-not-touch with owners, report fields).
- `src/planning.ts` types only, no behaviour: the fields above.
- `AGENTS.md`: the Approval and Sprints review lines updated to the new gate; a line saying a goal's owned files are the sprint's file boundary.
- `README.md` Direction section replaced by a pointer to `docs/mission.md`.
- A migration function with tests, stubbed to a no-op, in a new file the migration lane will own (`src/legacy-closure.ts`).

**Lanes (from plain `main` after the contract merges, disjoint files, any order):**

1. **Developer as goal orchestrator.** Owns `src/developer-seat.ts`, `src/developer-review.ts`, `src/developer-maintenance.ts`, `src/seat-git.ts`, `src/seat-runtime.ts`, and their tests. Outcome: a Developer seat given an approved goal produces `sprint/<goal-id>` by splitting into contract plus file-disjoint lanes, running a lead per lane with workers, opening lane PRs against the sprint branch, dispatching a fresh independent agent review on open, one fix round per changes-requested, immediate SHA-bound merge on green plus approval, PR bodies with Decisions and Follow-ups, and one final report in the standard shape. Both engines (Codex and Claude runtimes) receive the same brief text.
2. **Team Lead as scheduler.** Owns `src/planning-bridge.ts`, `src/sprint.ts`, `src/finished-sprint.ts`, `src/release-activation.ts`, `src/sprint-retro.ts`, `src/retro-publication.ts`, and their tests. Outcome: on every event (approval, Developer report, CI, merge, build running) the bridge picks the next approved goal whose owned files don't overlap any running goal, packages the brief from the goal plus the last three retros, dispatches it to an idle Developer, and on a report runs integration PR, auto-merge on green plus independent agent approval, running-build check, retro post and archival, then schedules again. No human step after ✅. Redirect replies in the goal thread are recorded and passed into the next brief.
3. **Product loop.** Owns new files `src/product-seat.ts`, `src/product-proposals.ts`, `personas/` entry for the Product seat, and their tests. Outcome: a Product seat runner that reads `docs/mission.md` and `docs/retros/`, keeps a ranked queue of at most five proposed goals each with owned files, posts one proposal at a time to the home channel for the owner's ✅, and refines the queue when it is full. It writes only its own posts.
4. **Hub and Mattermost surfaces.** Owns `src/hub-*.ts*`, `src/planning-text.ts`, `src/planning-mattermost.ts`, `src/help-overlay.tsx`, `src/terminal-ui-solid.tsx`, and their tests. Outcome: the hub shows three roles, a Developer's current goal and lane PRs, the Team Lead's queue of approved goals with overlap status, and Product's proposal queue; the `M` and `A`-after-approval keys are gone; `V` (rollback) stays; posts and thread text describe the new ceremony.
5. **Migration.** Owns `src/legacy-closure.ts` and its tests. Outcome: start-up closes `goal-2b118e79` (implement, abandoned; nine lane PRs merged into its sprint branch, two closed) and the five goals stuck in `release` and `retro` listed in the mission doc, with a closure evidence kind the contract PR added, recording what was true and never inventing approvals or retros.

If a lane's outcome turns out to need a file another lane owns, the lead stops and reports; you re-cut the lanes rather than letting it edit.

## Brief template for a lane lead

```
Repo: <path>. Base: origin/main. Branch: <name>. PR against main. Read AGENTS.md and docs/mission.md first.
Run `npm run typecheck` and `NODE_OPTIONS=--experimental-ffi npx vitest run <files>` once after your final edit. Never `npm test`. Stop anything you started; check with ps.

## Outcome (what must be true when you are done)
1. …  (each with a pointer into current code and why the constraint exists)

## Files you own (edit only these)
…

## Do NOT touch
<file>: owned by lane <n> / by open PR #<n> / contract.
If you need a file outside your list, stop and say so in the report instead of editing it.

Use workers for the independent pieces (<hint>). Each worker owns exactly one file, runs nothing, never commits.

Final report, one message: PR URL, head SHA, exactly what you ran and the result (exit codes), decisions made, anything you needed but did not own.
```

## Reviewer brief

```
Review PR #<n> of satoramoto/indra at <immutable-head> independently of its writer. Read the diff with `gh pr diff <n>`. Run nothing; do not edit or post.
Flag only the items in AGENTS.md's Review list, plus: <5 lane-specific checks>. Tests that would pass without the code under test are a bug.
Return findings with file, line and reason plus an APPROVE or REQUEST_CHANGES verdict. The host records exact-head evidence and can publish an informational PR comment using the owner's normal account.
```

## Your loop

1. Explore first: read `src/` and `tests/` enough to correct the file lists. Post the corrected lane plan (files per lane) here before dispatching, then dispatch without waiting.
2. Contract lane alone. When its PR opens: reviewer immediately; when approved and CI green, immediate SHA-bound merge.
3. All five lanes at once from plain `main` once the contract has merged. When each PR opens: reviewer immediately, immediate SHA-bound merge on approve plus green.
4. Changes requested: read the findings yourself and decide which are real. One fix subagent per PR with the accepted findings and "add a test that fails without each fix". Then message the same reviewer to re-verdict on the delta. Non-blocking notes: `gh issue create` and move on.
5. CI failure: read the failed run (`gh run view --log-failed`), diagnose, one fix subagent with the exact failure text.
6. Conflicts: a fix subagent merges `origin/main` in. Never rebase or force-push.
7. After each PR opens, one paragraph here: what it does and "Decisions to veto if you disagree".
8. When all six PRs have merged: remove the worktrees, and report the board, the issues filed, and what the first self-built goal should be.

Don't poll. Check a PR's CI and review state when a subagent reports or when you have just acted on it, not on a timer.
