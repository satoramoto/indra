# Owner standing policy

Auto mode is off by default. A missing policy, an unconfigured scope, or an old boolean-only enabled setting cannot
authorize automatic work. The owner explicitly chooses one scope; neither an agent nor a default selects it:

| Choice | Authority |
| --- | --- |
| Mission-wide | Goals on this team under the exact saved owner mission. Changing the mission switches auto mode off and requires a new scope choice. |
| Named problem | One existing, open goal on this team, identified by its goal ID. The saved problem text makes the owner's choice readable. Future goals require a new choice. |

`OwnerSettingsCommands` in `src/owner-settings.ts` is an owner capability. Its commands are `chooseScope(teamId,
{ kind: "mission" })`, `chooseScope(teamId, { kind: "problem", goalId })`, `enable(teamId)`, `disable(teamId)`, and
`updateOwnerSettings(teamId, { mission })`. Choosing or changing a scope never enables automation. The owner may
enable only after choosing a valid scope. Changing the scope first disables the old policy. Saving a changed
mission disables in the same state transaction. Repeating an unchanged setting has no effect.

From the Indra source checkout, the owner can make the explicit choice at the terminal (replace the checkout and
team/goal IDs). These commands use the validated state writer and commit the settings to indra-state:

```sh
node --import tsx src/owner-settings.ts --state /path/to/indra-state --team team-one scope mission
node --import tsx src/owner-settings.ts --state /path/to/indra-state --team team-one scope problem goal-one
node --import tsx src/owner-settings.ts --state /path/to/indra-state --team team-one auto on
node --import tsx src/owner-settings.ts --state /path/to/indra-state --team team-one auto off
node --import tsx src/owner-settings.ts --state /path/to/indra-state --team team-one mission 'The owner mission'
```

Choose one of the two scope commands. The terminal `auto on` records standing authority; automatic work additionally
requires the final automation adapter to be installed in the running build.

The owner-control factory supplies the mission/disable settings port to the TUI. The final automation adapter owns
the separate `autoMode.enable` control, checks that its services are available, and calls these commands following
the owner's confirmation. This module does not install that enable control or run a background approval loop.
Agents receive only the restricted state port; it rejects mission and standing-policy writes, including forged
`source: "owner-command"` data. Owner commands are never reconstructed from agent output, a claimed role, a bot
reaction, or a Mattermost message. Product has no settings capability.

## Durable records

The v1 `state.json` contract retains its append-only `teams[].standingPolicy.revisions`. Each revision records the
enabled setting, its consecutive number, `source: "owner-command"`, and its time. Disabling appends a revision;
it never removes earlier decisions. Policy changes, including off/on, invalidate cached authorizations.

The companion `autonomy.json` in the same indra-state Git checkout stores version 1 owner policy records:

- A stable policy ID and team ID.
- The owner's selected scope, including its mission or named-problem text.
- Immutable grant snapshots, each bound to an enabled state revision by **both its number and exact timestamp**.

This companion uses strict validation and contains durable owner decisions, not runtime metadata. Each write
commits only `autonomy.json`, using the same state/Git lock as `PlanningStore`. Scope selection and enable/disable
commands additionally serialize through an owner-settings lock across processes. Configure it through the owner
commands, not by editing the file or routing it through an agent writer.

Enabling first commits a grant snapshot while off, then enables that exact state revision. If the second commit
fails, the prepared grant remains inactive. Retrying prepares a new timestamp; only the snapshot whose timestamp
matches the committed enabled revision can authorize work. If a scope write fails, the previous document is
restored and auto mode stays off. Uncommitted or malformed policy data cannot authorize new work. Disabling remains
available even if the companion file is dirty, missing, or unreadable.

`goal.automaticApprovals` uses the existing v1 automatic provenance: `source: "automatic"`, `policyRevision`, `at`,
and an exact proposal digest or PR URL/head. `approvalPolicy(document, team, revision)` resolves that revision to
its immutable policy ID and scope using the team's historical setting timestamp. This preserves attribution after
disabling, scope changes, and restart, without adding fields that older v1 state readers cannot understand. Human
commands remain `source: "owner-command"`; verified human reactions remain `source: "reaction"`. A policy's owner
command is the standing authority, not a human approval of each automatic action.

## Gate integration

The final automation adapter calls `evaluateAutomaticGate(store, goalId, request)` for each proposal, integration,
or retro gate. It reads current state and policy together under the state lock. Evaluation returns a proposal for
an authorization; it does not start assignments, merge a PR, or record a decision by itself. The shared bridge
records the returned approval with the transition and rechecks the enabled revision inside the state transaction
and immediately before an external merge. Changing scope always disables before writing the new scope, so the
existing revision check also revokes decisions evaluated against the old scope. Owner mission changes use the same
revocation path. Never cache an evaluator result as permission for another gate or install a boolean-only adapter.

Proposal authorization binds to the delivered proposal's ID and complete digest. Unanswered proposal questions
keep the gate pending. PR requests must come from the existing checked inspectors: those verify the team's
project, expected branch, main base, exact head, passing CI, and a fresh `satori-miyamoto` approval. Integration
still requires complete implementation evidence; partial releases require the owner's explicit decision and a
human merge approval. Retro additionally requires a verified running release and the existing archival checks:
only the frozen `docs/retros/<goal-id>.md`, verified thread delivery, and a reviewed current PR head. Missing or
unknown evidence stays pending. Automatic decisions never authorize reverts.

Turning auto mode off prevents the next automatic gate or an unexecuted automatic merge. Already approved
assignments keep running, and the bridge can still reconcile a merge GitHub accepted before the switch. All
recorded approvals remain. With auto mode off, proposals and integration/retro merges retain their existing human
command or verified human ✅ gates. Reverts always retain their human gate.

## Product

Product and the Team Lead may groom mission-linked backlog tickets and candidate sprints. They cannot change the
owner mission, standing policy, or approval history. Product follows the same Mattermost limits as Developers and
Chick: write only its own posts; use its own bot token; join only its own team's home channel and team from
indra-state, and only after a GET proves that its bot is not already a member. No seat creates Mattermost accounts,
adds other users, or joins other channels. Bot reactions, including Product's, never supply human approval.
