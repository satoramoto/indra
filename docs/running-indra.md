# Running Indra

## Start it from your own terminal

Start the terminal UI from a terminal app you use yourself (Terminal, iTerm), inside the `indra-ui` tmux session:

```sh
tmux -L indra-ui new-session -A -s ui -x 160 -y 48 npm start
```

The UI then starts Chick's bridge and the Developer seats in Indra's own tmux server (socket `indra-<hash>`). That server
keeps running after the UI quits, and later UIs reuse it.

A browser preview may attach to the running session (`tmux -L indra-ui attach -t ui`), but it must never start it.

## Owner team controls

Open a team or seat and press `C` for team controls. The screen reads the mission, seat lifecycle and auto mode
from `indra-state` on every refresh, so settings survive a UI restart. Missing settings mean auto mode is **off**.

- `+` adds a seat: enter its display name and exact Mattermost bot username, use Tab to select the role, and use
  the arrow keys to choose Developer or Product. Enter reviews the request; `y` confirms it.
- `-` requests removal of the selected Developer or Product seat. A retiring seat accepts no new work and retires
  once existing work finishes or is safely reassigned. Its identity stays in history. The Team Lead cannot be removed here.
- `e` edits the owner mission. When no mission is saved, the editor offers the initial startup-simulator mission.
  Enter reviews it and `y` saves it; Escape cancels without changing state.
- `o` reviews an auto mode change. Enabling requires the policy/automation adapter; disabling remains available
  when that adapter is missing. Off stops automatic progression at the next approval gate. Auto mode and the
  `U` auto-update control are separate settings.

Every change names its team and target before confirmation. Refreshes invalidate a confirmation if the relevant
mission, policy or seat changed. The screen reports unavailable adapters instead of treating them as successful checks.
Until lifecycle and automation adapters land, those actions remain unavailable; mission editing is available.

A pending seat lists the exact account and credential to provision. For username `productbot`, create a Mattermost
**bot** account `productbot` and a 1Password item named **Mattermost bot - productbot**, with the credential in field
**token**, in the **Agent Rig** vault. Do not paste credentials into the UI or a command. Indra never
creates Mattermost accounts. The lifecycle adapter retries pending credentials while the owner UI runs, verifies the
bot's identity, and starts the seat when ready. `pending`, `active`, `retiring` and `retired` are persisted statuses.

## Optional service adapters

`src/control-adapters.ts` owns the typed factory contracts and the build-time discovery list. The CLI and TUI do not
need edits as later outcomes land. Each module exports only the factories it owns, with no import-time side effects:

| Module | Factory / purpose |
| --- | --- |
| `seat-lifecycle.ts`, `seat-provisioning.ts` | `createOwnerControls`: lifecycle `add`, `remove`, `reconcile` |
| `product-seat.ts` | `createProductRunner`: Product's own `tick` runner |
| `backlog-groomer.ts` | `createCeremonyAdapters`: Team Lead `grooming` |
| `owner-settings.ts`, `auto-policy.ts`, `auto-mode-adapter.ts` | Owner settings and final `autoMode.enable`; workflow `automaticGate` |
| `release-facts.ts` | `createCeremonyAdapters`: `releaseEvent` |
| `next-sprint.ts` | `createCeremonyAdapters`: `closedSprint` |
| `release-activation.ts`, `retro-publication.ts`, `integration-review.ts` | Existing release, retrospective and review services |

Factories receive the relevant store and runtime/process services. Workflow factories also receive the decorated
Team Lead chat and a deferred `start` callback through the existing bridge. They must not start work during composition.
`controlServices` advertises installed workflow services (`grooming`, `policy`, `releaseFacts`, `nextSprint`) for display;
it never enables approval. Duplicate providers for a hook, owner control or Product runner fail composition.

The owner settings writer is passed only to owner controls. Product receives a restricted state writer, runtime
metadata methods, its own decorated bot chat and a read-only runtime factory with its seat's engine, persona and
harness. `seat run` dispatches Product separately from Developer and refuses pending or retired seats. A missing
Product adapter fails before credential reads. Missing workflow hooks remain absent, preserving their existing gates.

Lifecycle adapters must commit through the validated state writer, recheck a removal request's `expected` identity
inside the transaction, and use verified owned processes. The UI calls `reconcile` at startup and every 30 seconds;
read-only refreshes do not run it. Only the completed automation adapter should expose `autoMode.enable`, and it must
validate the owner's policy before enabling. Mission saves and disabling use the owner settings port.

## Why not under ttyd

macOS asks before a process reads another app's data, and it asks about the *responsible* process: the app that
launched the process tree. A tmux server keeps the responsible process of whoever started it, even after it
detaches. When Indra was started under ttyd, ttyd was responsible for the UI and for the seats' tmux server. ttyd is
an ad-hoc-signed Homebrew binary, so macOS does not remember the answer and asks "“ttyd” would like to access data
from other apps" once per hosted process start. While the prompt waits, the process misses its 15 second readiness
check and shows NO CREDENTIAL.

The access came from the 1Password CLI. Every hosted process runs `op read` at start-up for its Mattermost bot token.
Even with a service account token, `op` 2.34.0 reads the 1Password app's settings file in
`~/Library/Group Containers/2BUA8C4S2C.com.1password/…` at start-up (`op --debug` logs "Skipped loading desktop app
settings file" when that read is denied). Indra now runs every service-account `op` call with
`OP_BIOMETRIC_UNLOCK_ENABLED=false` (the documented switch for app integration) and
`OP_LOAD_DESKTOP_APP_SETTINGS=false` (which stops the settings read), so it no longer touches the app's container.
Without a service account token, `op` still uses the desktop app as before, which does read that container.

The UI shows a red warning line when:

- ttyd is in its process ancestry, or the tmux client that created the UI's own tmux server still runs under ttyd;
- the seats' tmux server was started before this UI and Indra has no record of starting it outside ttyd. Indra
  records the server's pid and start time (in `<state-checkout>.runtime/seat-tmux-server.json`) when a UI finds a
  server that started after it. A server started by `planning host` or by an older Indra has no record, so it warns
  until it is replaced.

Indra never kills a tmux server. To replace the seats' server, stop every seat from the UI (the server exits with its
last session), quit the UI, and start it again with the command above.

## Full Disk Access instead

If you must run Indra under another launcher, you can grant that launcher Full Disk Access in System Settings →
Privacy & Security → Full Disk Access. macOS then stops asking about it. This grants the launcher, and everything it
starts, access to all your files, so prefer starting from your own terminal. For an ad-hoc-signed binary such as a
Homebrew ttyd, the grant may also be lost when the binary is upgraded.
