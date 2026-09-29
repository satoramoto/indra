# The state repository

`satoramoto/indra-state` holds Indra's `state.json`. Its checkout sits next to the indra checkout, at `../indra-state`.

## Indra is the only writer

- Indra commits every change to `state.json` itself, one commit per change, and pushes it straight to the state repository's branch. It fetches and rebases first when the branch has moved, and never force-pushes.
- There are no pull requests on the state repository. Don't edit it by hand: Indra refuses to commit over uncommitted changes in the checkout, and stops syncing until they are committed or discarded.
- Runtime metadata (session IDs, delivery cursors, usage, locks) stays in `<state-checkout>.runtime`, outside Git.

## The schema belongs to the indra repository

The JSON Schema for `state.json` lives in this repository at `schema/v1/state.schema.json` and ships with every build. Each time Indra starts, including after a self-update reload, it compares that file with the copy in the state checkout. When they differ, Indra writes its copy into the checkout, commits only that file (`Update state schema from Indra <short-sha>`) and pushes it through the same sync as `state.json`. A change to the state shape therefore changes the schema here, in the same pull request. `state.json` keeps `"$schema": "./schema/v1/state.schema.json"`.

## Credentials

Without further setup Indra fetches and pushes with the machine's own git credentials.

To give Indra its own access, create a fine-grained personal access token:

- Resource owner: `satoramoto`; repository access: only `satoramoto/indra-state`.
- Repository permissions: **Contents: Read and write**. Nothing else.

Supply it when starting Indra:

```sh
INDRA_STATE_GITHUB_TOKEN=github_pat_… npm start
```

Indra removes the variable from its environment at start-up, so no child process inherits it: not agents, tmux panes, seat runners, `gh`, `npm`, `op`, nor git in project checkouts. Only the state checkout's `git fetch` and `git push` receive it, in their own environment, through a credential helper passed on the command line that reads it from there. The token never appears in arguments, logs, error messages, the remote URL or git config, and it is never stored by a credential helper.
