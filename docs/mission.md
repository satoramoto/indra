# Mission

Indra is a system that builds software according to a mission, continuously, with one human whose only recurring job is approving goals. Indra's first mission is Indra itself: this project is done when Indra can propose, build, review, release and retro improvements to its own source, and start the next one, without the owner doing anything but approving goals and occasionally redirecting.

Everything below is the target. The README describes what runs today. Where they disagree, this document wins and the README is out of date.

## The loop

```
mission ──► Product proposes goals ──► owner ✅ ──► Team Lead schedules ──► Developer builds a sprint
                                                          ▲                          │
                                                          └──── release + retro ◄────┘
```

- **Product** turns the mission and the retros into a ranked queue of proposed goals. It writes proposals and nothing else. When the queue is full it refines the queue instead of adding to it.
- **The owner** reacts ✅ on a proposal, or ignores it, or replies in the thread to redirect. That is the only human step. There is no second human step before release: a goal's integration PR merges when CI is green and the fresh reviewer has approved. The owner's safety valve is `planning rollback`, which reverts a merged sprint, and a redirect reply, which the Team Lead treats as new direction for every open goal.
- **The Team Lead** (Chick, `seat-001`) is a scheduler. It keeps every Developer seat busy: pick the next approved goal whose owned files don't overlap a running goal, package the goal brief, dispatch it to an idle Developer, and when the Developer reports, run release (integration PR, merge, running-build check) and retro, then dispatch the next goal. In idle time it vets Product's proposals technically and pre-writes briefs. The number of Developer seats is the number of concurrent goals, and nothing else limits throughput.
- **A Developer** takes one goal and delivers a green `sprint/<goal-id>` branch plus one report. Inside the goal it is an orchestrator: it splits the goal into a contract change (only when a shared surface exists) and file-disjoint lanes, runs a lead per lane, lets leads swarm workers on independent pieces, gets every lane PR reviewed by a fresh independent read-only agent reviewer as soon as it opens, sends one targeted fix per review round, merges each lane PR into the sprint branch on green CI plus approval, and carries every decision forward in PR bodies. It starts fresh per goal; its memory is the brief and the retros.

## Rules that make it work

These are the rules that made the lanes approach fast elsewhere. They are process rules, not method rules: they say what must be true, not how to think.

1. **A goal declares the files it owns.** Product proposes them, the Team Lead corrects them. Two goals run concurrently only when their file sets are disjoint. Otherwise the later one queues. Never split a file between goals or lanes: when two need the same file, sequence them or move the shared surface into a contract PR that lands first.
2. **Every brief has the same shape.** Header (repo, base branch, branch name, PR target), an outcome section ("what must be true when you are done", numbered, with pointers into current code and the reason for each constraint), "Files you own (edit only these)", "Do NOT touch" naming who owns each excluded file, one line on how to swarm, and the report format: PR URL, head SHA, exactly what you ran and the result, decisions made, anything you needed but did not own. A brief never contains step-by-step procedure.
3. **If you need a file you don't own, stop and say so.** Never edit it. The orchestrator above you lands contract changes or hands ownership over after the owning PR merges.
4. **Review on the PR, right away.** A fresh independent read-only agent reviews the exact head when a PR opens, alongside CI. Indra records the verdict and findings in runtime evidence and can publish an informational PR comment using the owner's default account. No special reviewer account or repository review rule is required. It flags only the AGENTS.md review list, never style. Non-blocking notes become a follow-up issue, never scope creep into a queued PR. After a fix, the same reviewer re-verdicts on the delta.
5. **One fix agent per problem**, given the exact failure text or the accepted findings, and told to add a test that fails without the fix. Merge conflicts are resolved by merging the base in, never by rebasing or force-pushing.
6. **Run checks once, targeted, at the end.** Per-file test runs for the files touched, plus typecheck. Never the full suite locally. CI on the PR is the full check. Exit code is the verdict, not grep.
7. **Decisions live in PR bodies.** Every decision an agent made without asking is in its PR body under "Decisions", with "Follow-ups" beneath. The retro reads the sprint's PR bodies. The Team Lead reads recent retros before writing the next brief. Those two channels plus AGENTS.md are the only way learnings travel; there is no agent-to-agent chatter.
8. **Event-driven, never polling.** CI results, review verdicts, conflicts and agent completions arrive as events. Nothing sleeps in a loop, tails a log, or "checks back". Nothing long-lived accumulates context: the Team Lead's scheduler and Product's loop are short turns triggered by events, and a Developer's context ends with its goal.
9. **Merge when CI is green and the review is addressed.** Lane PRs merge into the sprint branch with immediate `--squash --match-head-commit` after Indra verifies independent review and CI on that head. Integration PRs use the same gate for `main`. Then the running build updates itself, the retro is written and posted, and the goal closes.
10. **Nothing outlives its task.** Every process an agent started is stopped before it reports, and it checks with `ps`. Worktrees are removed once their PR merges and nothing is uncommitted.

## Roles and seats

Five seats, three roles:

| Seat | Role | Job |
| --- | --- | --- |
| `seat-001` Chick | Team Lead | Schedule goals onto Developers, run release and retro, vet proposals, pre-write briefs. |
| one seat | Product | Turn mission and retros into a ranked queue of proposed goals with owned files. |
| three seats | Developer | One goal at a time, delivered as a green sprint branch through lanes, reviews and merges. |

The two-role model in the README (Team Lead plus Developers, seats as workstream slots holding queues of outcomes) is replaced by this. A seat no longer holds a queue of outcomes: a Developer holds one goal, and the goal's internal parallelism is the Developer's own business.

## What "done" means

Indra has reached its first milestone when one goal completes this path with no owner action other than the ✅:

1. Product proposes it from the mission and the previous retros, with owned files.
2. The owner reacts ✅.
3. The Team Lead schedules it onto an idle Developer with a brief in the standard shape.
4. The Developer delivers `sprint/<goal-id>` through lane PRs, each bot-reviewed and merged on green CI.
5. The Team Lead opens the integration PR, it merges on green CI plus bot approval, the running build updates to it, and the retro is posted and archived.
6. The Team Lead schedules the next approved goal.

After that, Indra keeps going. Speed is set by how fast Product proposes and how fast the owner approves.

## Getting there

The remodel is built with the lanes approach directly, not through the old seat loop, because the seat loop is what is being replaced. The abandoned sprint `goal-2b118e79` stays in `indra-state` in its `implement` stage until the remodel's start-up migration closes it; its branch `sprint/goal-2b118e79` is kept for reference and nothing on it is assumed to land. Three goals before it (`goal-855701cc`, `goal-ca9dd9ed`, `goal-df104a26`) are stuck in `release` and two (`goal-88dd199e`, `goal-96296dff`) in `retro`; the same migration closes them.

The remodel's own sequence:

1. **Contract PR.** The Product role in the state schema and validation; a goal's owned-files list; the merge gate reduced to CI plus bot approval; the brief and report shapes as documented schemas; migration that closes the stuck goals. Small, with stubs, green on its own.
2. **Lanes**, disjoint by file, from plain `main` once the contract merges: the Developer runner as goal orchestrator (lanes, leads, workers, reviewer dispatch, fix rounds, auto-merge into the sprint branch); the Team Lead scheduler (goal selection by file overlap, brief packaging, release and retro on report); the Product loop (proposals from mission and retros, queue cap); the hub and Mattermost surfaces for the three roles.
3. **First self-built goal.** Whatever Product proposes first, run through the new loop with the owner's ✅.
