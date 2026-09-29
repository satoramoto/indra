# Running Indra

## Start it from your own terminal

Start the terminal UI from a terminal app you use yourself (Terminal, iTerm), inside the `indra-ui` tmux session:

```sh
tmux -L indra-ui new-session -A -s ui -x 160 -y 48 npm start
```

The UI then starts Chick's bridge and the Developer seats in Indra's own tmux server (socket `indra-<hash>`). That server
keeps running after the UI quits, and later UIs reuse it.

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
last session), quit the UI, and start it again with the command above.

## Full Disk Access instead

If you must run Indra under another launcher, you can grant that launcher Full Disk Access in System Settings →
Privacy & Security → Full Disk Access. macOS then stops asking about it. This grants the launcher, and everything it
starts, access to all your files, so prefer starting from your own terminal. For an ad-hoc-signed binary such as a
Homebrew ttyd, the grant may also be lost when the binary is upgraded.
