# Agent docs

Read only the file for the area you are touching. `AGENTS.md` at the root is the index that every session loads.

- `layout.md` — the code map: every folder and key file, one line each
- `deployment.md` — ship.sh, the session host, Mac/iPhone releases, the Conductor add-on's on/off rules
- `conductor.md` — Conductor add-on gotchas: model aliases, envelopes, window typing, closing tabs, background fallback
- `terminal-reply.md` — answering a `claude`/`codex` in Terminal: every proof step before a key is pressed
- `fleet.md` — `src/fleet/`: observers, merge, active rule, push rules, stalls, git and diff, sorting
- `phone-channel.md` — `src/remote/` and the iPhone channel: keys, Realtime Database, history, the direct path
- `codex-runner.md` — Codex in the session host: reading its protocol, and where it differs from Claude (approvals, late items)
- `mac-app.md` — `macos/`: the timeline feed, activity, control routes, capture flags
- `usage-and-cost.md` — pricing, cost reader, Codex quota, Claude rate limits and the usage endpoint
- `runtime.md` — proxy, native modules, launch agents, bot polling, sleep and pmset
- `misc.md` — Telegram formatting, one fleet process, lint configs, ask-format, call voices
- `cleanup.md` — code-health backlog and conventions
- `issue-tracker.md`, `triage-labels.md`, `domain.md` — config for the mattpocock engineering skills (GitHub issues, triage labels, glossary/ADR rules)

Older design docs in `docs/` (remote-channel, ponds, voice, cliq, flags, PROVENANCE, …) stay the source of truth for their area.
