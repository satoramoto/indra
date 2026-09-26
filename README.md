# Indra

Indra explores stable Mattermost team seats that can later be occupied by interchangeable coding-agent sessions. The current milestone is a **read-only terminal inventory**; it does not connect an agent to a seat.

## Run

Requires Python 3.10 or newer, network access to `https://mattermost.newegypt.io`, and an existing signed-in 1Password CLI session with access to `op://Agent Rig/Mattermost/access_token`.

```sh
python3 -m indra
```

The app lists teams visible to that credential. Enter a team number to inspect its active bot seats. Use `r` to refresh, `b` to return to teams, or `q` to quit. For a one-shot view:

```sh
python3 -m indra --team yahaha
```

No token belongs in environment variables or command arguments. The app reads the existing 1Password reference into process memory, sends only `GET` requests, suppresses credential-bearing diagnostics, and refuses HTTP redirects. It does not create or change accounts, roles, messages, tokens, or sessions.

Seats are active bot accounts whose IDs appear in a team's membership list. A bot can appear on multiple teams. Role comes from the existing custom profile multiselect field named `Role`, with its option IDs resolved against field metadata. Mattermost permission roles and online presence are not used as agent occupancy. The UI labels agent occupancy **not connected yet**.

The refresh time describes the last successful read for that view. A failed read is shown as an error, never as an empty team or seat list. Visibility depends on the credential's permissions; an absent team, bot, or Role value does not prove it does not exist elsewhere.

## Verify

```sh
python3 -m unittest discover -s tests -v
```

Tests use fake Mattermost responses and never read 1Password or contact production. The product direction is to add controller-managed seat occupancy, handoff, routing, and engine adapters in later milestones.
