# The state repository

`satoramoto/indra-state` holds Indra's `state.json`. Its checkout sits next to the indra checkout, at `../indra-state`.

## Indra is the only writer

- Indra commits every change to `state.json` itself, one commit per change, and pushes it straight to the state repository's branch. It fetches and rebases first when the branch has moved, and never force-pushes.
- There are no pull requests on the state repository. Don't edit it by hand: Indra refuses to commit over uncommitted changes in the checkout, and stops syncing until they are committed or discarded.
- Runtime metadata (session IDs, delivery cursors, usage, locks) stays in `<state-checkout>.runtime`, outside Git.

## The schema belongs to the indra repository

The JSON Schema for `state.json` lives in this repository at `schema/v1/state.schema.json` and ships with every build. Each time Indra starts, including after a self-update reload, it compares that file with the copy in the state checkout. When they differ, Indra writes its copy into the checkout, commits only that file (`Update state schema from Indra <full-sha>`) and pushes it through the same sync as `state.json`. It never downgrades: when the checkout's schema was last written by an Indra build that the running build does not include (checked with `git merge-base --is-ancestor` in the indra checkout), or when that can't be determined, Indra leaves it alone and says so. A change to the state shape therefore changes the schema here, in the same pull request. `state.json` keeps `"$schema": "./schema/v1/state.schema.json"`.

After the schema sync, the UI's start-up migrations run through the normal state write and commit path: legacy goals get their ceremony, and the retired top-level `sprints` array (draft sprints from before planning goals) is emptied in one commit, `Retire legacy draft sprints`. The key stays as `[]` so an earlier build that a rollback returns to can still read `state.json`; current builds ignore it. Both refuse to write over uncommitted edits and do nothing once done.

## Team and autonomy contracts

The additions below are optional v1 fields. An existing seat without `status` is active; an absent standing policy means auto mode is off. Reading an older document does not invent a mission, Product seat, policy, approval, or backlog. Schema sync must land before a consumer starts writing these fields. Definitions and predicates live in `src/state-domain.ts`; feature adapters use `src/autonomy-ports.ts`.

Each team may have an owner-set `mission`, `backlog`, `sprintCandidates`, and `standingPolicy`. The initial mission is exported as `INITIAL_TEAM_MISSION`:

> Indra is a startup simulator: a control plane where agent seats run a software team end to end on a real project, so the owner steers only by problems, value and approvals.

`PlanningStore.updateOwnerSettings(teamId, { mission?, autoMode? })` is the trusted owner/TUI port. `PlanningStore.update` is the agent-facing writer and rejects setting, replacing, or deleting a mission or standing policy, including through adding or replacing a team. Never expose the owner port to agent tools or use agent output as its input. Repeating the current auto mode does nothing. A change appends a policy revision:

```json
{
  "standingPolicy": {
    "revisions": [
      { "revision": 1, "enabled": true, "source": "owner-command", "at": "2026-09-29T12:00:00Z" },
      { "revision": 2, "enabled": false, "source": "owner-command", "at": "2026-09-29T13:00:00Z" }
    ]
  }
}
```

Revisions start at 1, advance by one, and have strictly increasing times. Previous revisions cannot change or disappear. The last revision controls new decisions; previous enabled revisions remain available to validate historical approvals.

### Seats and retirement

Every seat has exactly one role: `Team Lead`, `Developer`, or `Product`. Exactly one active or retiring Team Lead serves a team. `status` is `pending`, `active`, `retiring`, or `retired`:

- A pending seat has a chosen `externalIdentities.mattermost.username`; `userId` may be absent until the owner creates the bot and its credential works. `seatCredentialRequirement` returns the exact bot username, 1Password item `Mattermost bot - <username>`, and field `token`, never a credential value. Indra does not create Mattermost accounts.
- Activation requires a recorded user ID. The lifecycle adapter verifies the bot identity using its credential before writing `active`, then starts the seat. Pending seats cannot receive proposed or assigned implementation work.
- Active seats may become retiring. `developerSeats` selects only active Developers for new proposals; retiring seats may finish existing assignments. A failed assignment needs reassignment or a recorded omission at release before retirement.
- A pending seat can be cancelled directly to retired. A retiring seat becomes retired only after its durable work is finished or reassigned; the adapter must also verify that local runners have settled. Retired records remain in the team, with their IDs, roles and Mattermost identities, and cannot be reused or changed.

The raw seat record omits an unknown user ID. The legacy neutral `StateSeat` projection represents that absence with an empty `mattermostUserId`; consumers should inspect `status` before acting on it.

An approved proposal stays immutable when work moves between Developers. Append `assignments[].reassignments[]` entries containing `fromSeatId`, `toSeatId`, `at`, and `reason`, starting at the proposed seat and ending at the current assignment seat. Each transfer queues unfinished implementation work on an active Developer and clears the old PR reference. Transfers and approval history are append-only. Implementation evidence identifies the Developer who completed the current assignment; prior seat references still resolve after retirement. Legacy migration never rewrites historical assignments.

### Backlog and sprint candidates

`backlog[]` tickets contain `id`, `title`, `description`, `value`, `status` (`open`, `planned`, `done`, `discarded`), creation/update times and `createdBySeatId`/`updatedBySeatId`. Authors reference Product or Team Lead seats on that team, including retained historical seats. Optional `dependsOn` references other tickets; `research` contains `{ url, finding }` records.

`sprintCandidates[]` contain `id`, `title`, `summary`, `value`, positive `rank`, nonempty `ticketIds`, the same author/time fields, and `status` (`candidate`, `proposed`, `completed`, `discarded`). Upcoming candidates have distinct ranks, with the lowest number first. Optional `goalId` references a planning goal on the team; `retrospectiveGoalId` references a goal with a published retrospective. A planning goal may retain its citation as `source: { candidateId, ticketIds, retrospectiveGoalId? }`. References are validated by both readers and writers. Product/lead grooming results contain only tickets and candidates; the mission and standing policy are outside that port.

### Automatic approval evidence

Automatic decisions are explicit `source: "automatic"` records in a goal's append-only `automaticApprovals` array. Each includes `policyRevision`, `at`, and one exact `target`:

- Proposal: `{ kind: "proposal", goalId, proposalId, proposalDigest }`. `proposalDigest()` hashes the complete proposal with stable object-key ordering. The writer records the decision and enters implementation in the same transaction, using ceremony evidence `kind: "automatic-approval"`.
- Integration or archival PR: `{ kind: "integration" | "retro", goalId, prUrl, headSha, checksPassed: true, reviewApproved: true, reviewer: "satori-miyamoto", reviewedHeadSha }`. The review head must equal the approved head. An integration authorization requires that open PR and `integration.headSha` at release; archival authorization requires an open retro after a verified running release. Automatic revert approval is not part of this contract.

New records require the current enabled revision inside the state lock, even if an adapter cached or backdated a decision. Adapters must verify external checks on the exact head, recheck the current policy before acting, and merge with an expected-head check. The record is durable evidence of a decision, not permission to act after the owner switches off or a PR changes. Absent, failed, or unknown checks never authorize work.

Running release evidence retains the authorization and approved `headSha`; it still requires the merged integration, matching built/running SHAs, and verified ancestry for a descendant build. Retro closure retains `authorization: { headSha, mergePostId, approval }`. Previously recorded human and legacy evidence remains valid. Disabling auto mode preserves approvals already executed and permits their later running-build observation, but blocks new automatic decisions. Migration cannot invent automatic evidence or use policy to bypass the existing whole-ceremony migration rules.

Sessions, credential checks/retries, delivery cursors, usage, and timing/round observations remain under `<state-checkout>.runtime`. `CeremonyRuntimeFacts.integrationRounds` is optional for older runtime records and records `{ prUrl, headSha, conflict, merge }` observations; absence means unknown, not zero. No runtime fields are admitted to the durable contracts above.

## Credentials

Without further setup Indra fetches and pushes with the machine's own git credentials.

To give Indra its own access, create a fine-grained personal access token:

- Resource owner: `satoramoto`; repository access: only `satoramoto/indra-state`.
- Repository permissions: **Contents: Read and write**. Nothing else.

Supply it when starting Indra:

```sh
INDRA_STATE_GITHUB_TOKEN=github_pat_… npm start
```

Indra removes the variable from its environment at start-up, so no child process inherits it: not agents, tmux panes, seat runners, `gh`, `npm`, `op`, nor git in project checkouts. Only the state checkout's `git fetch` and `git push` receive it, in their own environment, through a credential helper passed on the command line that reads it from there. The helper answers only requests for `https://github.com/satoramoto/indra-state`; if the remote points anywhere else, or a request is redirected, it gives nothing. The token never appears in arguments, logs, error messages, the remote URL or git config, and it is never stored by a credential helper.
