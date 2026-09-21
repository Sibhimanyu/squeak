# conductor-tg

A Telegram bridge for driving a local Conductor installation. It reads Conductor's
SQLite database, spawns the local `codex` / `claude` binaries, and mirrors the
conversation back into Conductor.

**You are very likely running inside the thing you are editing.** Read the
deployment section before changing anything under `src/`.

## Layout

| path | what it is |
| --- | --- |
| `src/index.ts` | the bridge: Telegram handling, session panel, runtime state |
| `src/adapters/claude-code.ts` | spawns `claude`, parses its stream-json output |
| `src/adapters/codex-app-server.ts` | JSON-RPC client for the codex app-server |
| `src/adapters/conductor-registry.ts` | all reads/writes against `conductor.db` |
| `src/adapters/conductor-mirror.ts` | writes the conversation back into Conductor |
| `src/telegram/client.ts` | Telegram API calls, HTML rendering, retry/fallback |
| `src/utils/tg-format.ts` | markdown to Telegram HTML, message splitting |
| `src/bridge/state-store.ts` | the bridge's own SQLite state (`bridge.db`) |
| `src/squeak/` | Squeak: a separate status-only daemon with its own bot |
| `src/fleet/runtime.ts` | assembles the fleet stack; only one process may run it |
| `src/fleet/` | the fleet radar: every agent session on the Mac, not just Conductor's |
| `src/fleet/observers/` | one file per discovery source; none of them know about each other |
| `src/fleet/fleet-monitor.ts` | merges observers and hook events, decides what needs attention |
| `src/fleet/hook-ingress.ts` | loopback HTTP endpoint the installed agent hooks report to |
| `src/fleet/git-state.ts` | cached working-tree reads, so "finished" says what changed |
| `src/fleet/diff-view.ts` | reads and paginates a workspace diff for review in Telegram |
| `src/fleet/duck-mood.ts` | what the desktop duck is doing, derived where CI can test it |
| `desktop/` | the Electron duck: a separate package, plain JS, no build step |

`src/services/bridge-service.ts` is **dead code** — an older implementation that
still ships in the package. The live path is `cli.ts` to `index.ts`. Do not spend
time editing it.

## Deployment, and why you must not restart the bridge yourself

The running bridge is launched from the **main checkout**
(`~/conductor/repos/conductor-tg/dist`). Conductor workspaces are **git worktrees**
on their own branches, so your edits are isolated from the live process. Nothing
you do reaches the bridge until it is shipped.

Shipping is a single command, run from your worktree:

```bash
./scripts/ship.sh
```

It runs CI, merges your branch into the live branch, builds beside the live
`dist` rather than over it, smoke-tests that the build imports, swaps it in, and
then restarts the bridge **detached and delayed** so your reply is delivered
before the process handling it is killed. If the bridge does not come back up it
restores the previous `dist` automatically and leaves the bad build at
`dist.failed`.

Rules:

- **Never** run `npm run build` against the live checkout. It does `rm -rf dist`,
  and a failed compile would leave the bridge with no code to restart into.
- **Never** `pkill` the bridge or run `launchctl kickstart` directly. You will
  kill the process delivering your own reply, and the user will see nothing.
- Only ship when the user asks. Editing and testing freely in the worktree is
  fine and expected; putting code live is their call.
- Commit before shipping — `ship.sh` refuses a dirty worktree.

## Working on it

```bash
npm install
npm run ci      # typecheck + lint + format:check + test -- must pass before shipping
npm run build   # safe in a worktree, never in the live checkout
```

Tests are vitest and live beside the code as `*.test.ts`. Adding a regression
test for anything you fix is expected; the suite is fast.

## Things that are easy to get wrong

- **Conductor's model aliases are not CLI model ids.** `sessions.model` holds
  Conductor's picker alias (`opus-5-1m`); the `claude` CLI only accepts catalog
  ids (`claude-opus-5[1m]`) and exits 1 on anything else, before emitting any
  output. `toClaudeCliModel` handles the translation.
- **Mirrored assistant rows must match Conductor's envelope exactly.** Extra
  fields or `usage: null` make Conductor's UI render the message as "This message
  could not be displayed."
- **Conductor does not live-reload.** Rows written to `conductor.db` only appear
  after it reloads the session; there is no IPC to notify it.
- **Telegram needs `parse_mode`.** Without it markdown arrives as literal `##`
  and `**`. Everything goes out as HTML via `markdownToTelegramHtml`, with a
  plain-text retry if Telegram rejects the markup.
- **Messages cap at 4096 characters.** Use `splitMarkdown`, never truncate.
- A repo with no workspaces must still be selectable, otherwise a freshly added
  project can never be reached from Telegram.

## Two daemons, not one

`conductor-tg` is the bridge: a conversation you navigate and talk to agents
through. `squeak` is a pager: it watches every agent on the Mac and
messages you when one finishes or blocks. Separate binaries, separate bots,
separate config (`~/Library/Application Support/squeak/.env`), separate
state (`squeak.db`).

- **Only one process may run the fleet.** Two would bind the same hook port
  and send every notification twice. The bridge no longer wires it up at all;
  `createFleetRuntime` belongs to Squeak.
- Squeak passes `openConductorSession: null`, which hides Reply and Open on
  its cards. It has no control channel — offering them would open a chat it
  cannot continue.
- The desktop duck still reads `127.0.0.1:8477/state`; that is now served by
  Squeak rather than the bridge.

- **Native modules must match the running Node.** `better-sqlite3` is built
  for one ABI; `node` here is v22 (`NODE_MODULE_VERSION` 127) but Homebrew
  ships v26 (147). If `npm install` runs with `/opt/homebrew/bin/node` ahead
  on `PATH`, Squeak dies at startup with a NODE_MODULE_VERSION error.
  `npm rebuild better-sqlite3` fixes it.
- Launch agents are generated by `scripts/install-squeak-agents.sh` and point
  at the **main checkout**, never a worktree — Conductor archives those. The
  daemon uses `KeepAlive: true`; anything the user can quit from a menu uses
  `KeepAlive: { SuccessfulExit: false }`, or a deliberate Quit is restarted
  instantly and reads as the app ignoring them.
- **`desktop/` has its own eslint config**, run by `npm run lint`. It is
  invisible to tsc and to `eslint src/`, and two real bugs reached the user
  through that gap. Note that flat-config `files` patterns resolve against the
  directory eslint runs from, so they must be repo-relative — a config whose
  patterns match nothing passes everything, which is worse than no linter.

## The fleet layer

The bridge used to see only sessions Conductor spawned. `src/fleet/` widens
that to every Claude Code and Codex session on the machine by reading their
transcripts, and ranks them by what is blocked on the human.

- **Observers are independent and must stay that way.** Each one answers "what
  does my source say" and nothing else; `merge.ts` is the only place that
  reconciles them. That is what keeps them testable against fixture files.
- **Sessions join on the agent's own session id.** Conductor stores it in
  `sessions.claude_session_id` for both agents, despite the column name.
- **Transcripts cannot record an approval prompt.** Blocked states only ever
  come from hooks. Anything that infers "awaiting approval" from a file is
  wrong.
- **Use `PermissionRequest`, not `Notification`, to detect blocked-on-approval.**
  Both measured with a temporary settings file against a real SDK-mode run:
  `Notification` never fires there, because the prompt goes to the host app
  rather than to a terminal user — but `PermissionRequest` does. So Conductor
  sessions *can* report that they are waiting on an approval, which an earlier
  version of this file wrongly said was impossible. `Notification` is still
  installed, because it also covers idle-waiting-for-input on terminal agents.
  Do not try to infer approval from a "PreToolUse then silence" timer — a slow
  test run looks identical. Note that a third of Conductor sessions run
  `bypassPermissions` and never block on approval at all.
- Hooks *do* fire in SDK-spawned sessions: 32 of 34 `sdk-ts` transcripts on
  this machine ran a Stop hook.
- **Hooks must never block.** The installed script backgrounds its request,
  caps curl at 2s, and exits 0 unconditionally. These run inside other people's
  agents; a bridge problem must never become their problem. There is a
  regression test that runs the real script against a dead port.
- **`~/.claude/settings.json` is shared.** On a typical machine it already
  carries entries from other tools. Install merges, uninstall removes only
  entries naming `fleet-notify.sh`, and both back the file up first.
- **Callback data caps at 64 bytes.** Session keys do not fit, so
  `FleetStore.handleFor` allocates short integer aliases. Never put a raw
  session key in `callback_data`.
- **Only *active* sessions reach a screen** — running, blocked, finished in the
  last fifteen minutes, or quiet with a live process. Everything else stays
  tracked but hidden. On this machine that is 4 of 26; without the filter the
  radar is an archive rather than a status display.
- Blocked and finished sessions get pushed to Telegram; errored and
  low-on-context ones only appear on the radar. Push cards are **two lines** —
  they are lock-screen notifications, not documents.
- `src/fleet/active.ts` owns the active rule. The monitor, the radar and the
  local state endpoint all read it; do not reimplement the predicate.
- **The duck decides nothing.** Mood, the active set and every rendered field
  come from `/state`; the renderer only draws. Putting logic in
  `desktop/renderer/` means it escapes CI and can start disagreeing with
  Telegram about what is happening.
- `desktop/` is a **separate package on purpose**: `conductor-tg` is published
  to npm and must not carry Electron as a dependency. It is excluded from
  `package.json` `files`, from `tsconfig`, and from `eslint src/`.
- Expansion state lives in the Electron **main** process, which also owns the
  window size; the renderer only reacts to `duck:expanded`. Tracking it in
  both was a desync waiting to happen.
- To see the duck without Screen Recording permission, use
  `DUCK_CAPTURE=<prefix>` — the window photographs itself.
- The ingress serves `GET /state` unauthenticated on loopback for local UIs.
  It is read-only and exposes nothing a local process could not already read
  from the same files; hook posts still require the token.
- **A session can want attention for several reasons at once**, so
  `classifyAttentions` returns a list. Do not collapse it back to one.
- **`workspaces.state = 'archived'` does not mean "done", it means the worktree
  is gone** — which is still a reason to stop asking for review. On this
  machine that is 8 of 18 workspaces, so getting it wrong either buries the
  radar in dead work or hides live work.
- **Git runs only for sessions that will be rendered**, and is cached for 30
  seconds including misses — an archived workspace whose directory is gone must
  not be re-probed every refresh. Enrichment happens *before* push cards are
  emitted, so the card carries the diffstat.
- **A Conductor branch usually has no upstream**, so `@{upstream}` exits
  non-zero and that is the normal case, not an error. Unpushed work is counted
  against `origin/<repos.default_branch>` instead — and note that
  `default_branch` is the real target branch, not necessarily `main`.
- **The diff is taken against the base branch, not HEAD**, and includes
  untracked files. Agents create files without staging them, so a review built
  on `git diff HEAD` alone silently omits most new code.
- **`git diff --no-index` exits 1 when the files differ**, which for a new file
  is always. Its stdout is the answer even though execFile rejects; read
  `error.stdout` rather than treating it as a failure.
- **Diff buttons carry absolute file indices**, not positions on the page, and
  the page number is clamped — a stale button from a longer list must not open
  the wrong file.
- Writing to `diff_comments` is **not implemented**. Every row in that table on
  this machine was written by an agent via the MCP DiffComment tool
  (`author` is a model alias), so there is no example of a human-authored row
  to copy, and Conductor renders a wrong envelope as broken. Confirm the shape
  against a real human comment before writing one.
- Conductor fields that look useful but are **not populated** on a normal
  single-user install: `sessions.unread_count`, `workspaces.unread`,
  `sessions.queue_paused_at`. They read as all-zero; do not build on them
  without checking a real database first. `context_used_percent` is populated
  for roughly two thirds of sessions and is the one worth using.

## Upstream

Forked from `xudong963/conductor_mobile` (Apache-2.0), kept as the `upstream`
remote. `origin` is a private repo.
