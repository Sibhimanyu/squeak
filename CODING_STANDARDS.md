# Coding standards (for review)

Judgement calls a reviewer checks in a diff. Mechanical rules belong in a check (eslint, a test, CI), not here. The hard
rules are in `AGENTS.md`.

## State and data

- **Data an always-visible surface needs is loaded by the model or by that surface**, never only by a page that may not
  be on screen. The Duck tabs vanished when a chat was opened first after a relaunch: only the Dashboard and Room
  fetched the roster.
- **"What is open" comes from where the person is, not from a remembered selection.** A selection kept for later
  (`lastChat`) read as "this Duck is showing" made clicks on it do nothing.
- **One rule, many surfaces.** A count or mark shown in more than one place (needs-you, working, failed) comes from one
  function, ideally a daemon field. The sidebar ⊗ and the Dashboard tile disagreed because each counted on its own.
- **A view's visible state and the state that drives it are one value.** A page strip that moves while its preference
  holds the other page is two truths.

## Agents (Claude, Codex)

- **Never assume Codex behaves like Claude.** Approval policy, turn boundaries and inputs differ:
  `docs/agents/codex-runner.md`. A change to one runner says what the other does in the same case.
- **A turn is opened and closed by the agent's own events.** Never infer a turn from a stray item.

## Controls

- **Every control has a flow** (DESIGN.md): the reviewer names who uses it, when, and what happens next. A mark that
  signals a problem (⊗, a badge) leads somewhere when clicked.
- **A blocked state has a way out in the same place.** A read-only composer with no action next to it is a dead end.

## Tests

- **A test waits for a condition, not a fixed sleep.** `vi.waitFor`, `until(...)`, or the event itself; fixed sleeps
  failed on a loaded CI runner four times.
- **A test that compares times allows for the clock moving** between two steps it does not control.
