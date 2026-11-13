# Where Squeak's code comes from

Squeak's history, told plainly, and the evidence that its own coding engine is its own.

## The story

1. **A pager (October 2026).** Squeak began as a fork of the open-source
   [conductor_mobile](https://github.com/xudong963/conductor_mobile) (Apache-2.0, credited in `NOTICE`): a daemon
   that watched agent sessions and sent Telegram cards when one needed its owner.
2. **The phone channel.** The iPhone app, an end-to-end sealed channel between Mac and phone, Cliq, calls.
3. **A Conductor relay (2026-10-17 to 2026-11-09).** To answer Conductor chats with the screen locked, Conductor's
   desktop app was reverse-engineered and a local relay built (commit `1a2898f2`). That work is Squeak's past. The
   relay was taken out of every distributed build on 2026-11-09 (`f8294ce6`) and is a development-only add-on
   (`addons/conductor-relay/`) that no release contains.
4. **Squeak's own engine (from 2026-11-08).** Squeak runs Claude and Codex chats itself (`src/native/`), through
   Anthropic's Claude Agent SDK and Codex's app-server, with its own session host, storage, tools, workspaces and UI.
   Conductor remains an optional add-on that reads Conductor's own database for people who use both.

## What was checked (2026-11-13)

| Check                             | Method                                                                                                                                          | Result                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Copied code                       | jscpd 4.3.0, 50-token minimum, Squeak's engine TypeScript against Conductor's extracted JavaScript (prettified)                                 | No clone between the two                                                                             |
| Copied strings and identifiers    | Every literal ≥ 12 characters and identifier ≥ 10 in the engine (TypeScript and Swift) looked up in Conductor's material; 7-word phrase matches | No copied code or prompt text; the overlaps found are listed below and were rewritten                |
| Database schema                   | Squeak's `native.db` and `core.db` against Conductor's schema and migrations                                                                    | Different columns, order and structure; only generic table names (`sessions`, `workspaces`) coincide |
| Extracted code pasted by an agent | Every file write by every agent session that had read the reverse-engineering notes, scanned for minified or extracted code                     | None found                                                                                           |
| What shipped                      | The installed Squeak for Mac 2.23.28 bundle                                                                                                     | No relay add-on, no relay code; the Conductor add-on only restores Conductor's own settings          |
| Release history of the repo       | Every file ever added to git, all refs                                                                                                          | No Conductor bundle, binary, dump or capture was ever committed                                      |

## What was rewritten clean-room (2026-11-13)

The scan found interfaces that had been designed while the notes were open. Each was redone from Squeak's own needs
by agents that were not given the notes:

- **Agent tools** (`src/native/agent-tools.ts`): Squeak's own names, inputs and wording: `stream_changes`,
  `list_review_notes`, `add_review_note`, `resolve_review_note`, `page_person`, `set_progress`, `set_merge_branch`,
  `script_output`. Old names still answer calls from chats started before the change, but are not offered.
- **Chat statuses** (`src/native/types.ts`): `awaiting_approval`, `awaiting_plan`, `awaiting_answer`, `stopping`;
  stored rows migrated, readers accept older data.
- **Colours** (`macos/.../Tokens.swift`, `DESIGN.md` §3.2): one OKLCH hue from the duck yellow's family, lightness
  set per role, contrast checked. Light mode rebuilt the same way.
- **Notes and comments** that described Squeak as following another product's look were rewritten.

Reviewed and left as is, with reasons:

- **Engine files edited in sessions that had the notes open** (`host.ts`, `server.ts`, `planner.ts`,
  `workspace-sources.ts`, `codex-runner.ts`, `context-usage.ts`): no overlap in any scan above; their behaviour is
  Squeak's (session host, backlog, workspaces from a branch, PR or issue).
- **Project scripts and branch prefix** (setup, run and archive scripts per project): a common workflow in
  worktree-based tools, described in public product documentation; Squeak's storage and UI for them are its own.
- **Conductor add-on** (`addons/conductor/`): reads Conductor's database and a repository's `conductor.json` so
  people who use both see their chats in one place. That is interoperability with data on the person's own Mac.

## The rule from here

No one working on Squeak reads Conductor's internals. The reverse-engineering notes were archived read-only outside
every workspace on 2026-11-13 (`conductor-teardown-2026-11-13.tar.gz`, SHA-256
`2b70dd00d71af23d76ee72675427b563adac9447986a2e2d11e40b069506b136`, with a per-file manifest) and are kept only as a
record. New features are designed from Squeak's own needs, `DESIGN.md` and public documentation.
