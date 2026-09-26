# Indra

A control plane for agent teams, where stable team seats can be occupied by interchangeable coding-agent sessions.

## Direction

- Mattermost provides team identities, communication, and visibility into work.
- Seats retain their roles, assignments, and durable handoff history independently of the agent engine.
- A controller manages seat occupancy, message routing, session lifecycle, and resource limits.
- A terminal interface operates the controller; tmux may host persistent worker sessions.
- Engine adapters connect Claude Code, Codex, and eventually other runtimes.

## First milestone

Connect one Mattermost seat to a running agent, route a mention and reply end to end, then replace the engine while preserving the assignment through an explicit handoff.

Start with bounded concurrency and resumable work. Broader sprint orchestration comes after the one-seat workflow is proven.

## Status

Project initialized. No runtime or control-plane implementation yet.
