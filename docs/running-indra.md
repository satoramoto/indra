# Running Indra

## Start it from your own terminal

Start Indra from a terminal app you use yourself (Terminal, iTerm):

```sh
npm start
```

That is all. Closing the terminal window leaves Indra running; `npm start` again, from any terminal, brings the same
screen back instead of starting a second one. `q` in the UI quits it.

Under the hood, `npm start` runs the UI in Indra's own UI session (tmux socket `indra-ui`, session `ui`): it creates
the session when there is none and attaches to it when there is. The UI then starts Chick's bridge and the Developer
seats in Indra's own seat server (socket `indra-<hash>`), which keeps running after the UI quits; later UIs reuse it.
Indra never touches your own tmux server or configuration. Commands other than the UI (`npm start -- planning …`,
`--once`, `--mattermost`, `seat run`) run directly in your terminal as before.

A seat's screen shows its live session in a pane inside Indra, next to a seat list, the seat's details and the sprints:
the headed `claude` or `codex` CLI, or the progress output of a headless run, mirrored in colour a few times a second.
You never leave Indra and never see tmux. `Tab` and `Shift-Tab` move between those parts, and a click focuses one; the
focused part has a bright border, and the mouse wheel scrolls whatever is under the pointer. Watching is the default:
nothing you type reaches the seat. Focusing the session pane (`i`, `Tab` or a click) drives it during a headed run: the
border turns orange, the pane reads "DRIVING <seat> — Esc Esc or Tab to stop", and your keys go to the agent CLI,
`Ctrl-C` and a single `Esc` included. Two quick `Esc`s, `Tab`, or a click outside the pane stop driving. The bar at the
bottom always lists the keys that apply right now. `t` shows the seat's current Claude or Codex session as a read-only
transcript that follows it live. `?` lists every key.

The screens are designed for a window of about 720×720 logical pixels at a 13 px font: 96 columns by 42 rows. At that
size the team screen (seats plus the sprint card) fits without scrolling; on a seat's screen the live session takes
most rows and the details and sprints scroll in their own panels. Smaller terminals scroll with `PgUp`/`PgDn`. Colours and icons mean the same everywhere: 🏃 green
running, ⌛ amber waiting, 🙋 pink needs you, 💥 red failed, ✅ blue done, 💤 grey idle; needs-you and failed blink.
Each assignment shows its pipeline 🔨 build, 🔍 review, 🩹 fix, 🧪 CI, 🔀 merge, lit as it advances, with a 🟢 🟡 🔴 dot
for its last recorded CI run. Tokens (🧮) are the recorded input, cached input and output of finished sessions.
🐙 PR links and the 💬 goal thread and 📝 proposal post links are OSC 8 hyperlinks, and a click opens them with `open`.

A browser preview may attach to the running session (`tmux -L indra-ui attach -t ui`), but it must never start it.

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
last session), quit the UI, and start it again with `npm start`.

## Full Disk Access instead

If you must run Indra under another launcher, you can grant that launcher Full Disk Access in System Settings →
Privacy & Security → Full Disk Access. macOS then stops asking about it. This grants the launcher, and everything it
starts, access to all your files, so prefer starting from your own terminal. For an ad-hoc-signed binary such as a
Homebrew ttyd, the grant may also be lost when the binary is upgraded.
