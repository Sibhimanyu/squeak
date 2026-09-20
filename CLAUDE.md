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

## Upstream

Forked from `xudong963/conductor_mobile` (Apache-2.0), kept as the `upstream`
remote. `origin` is a private repo.
