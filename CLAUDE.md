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
| `src/squeak/` | Squeak: a separate pager daemon with its own bot; it can answer a finished Conductor chat |
| `src/fleet/session-reply.ts` | continues a Conductor chat from a Squeak card: resume, mirror, refuse when busy |
| `src/fleet/choices.ts` | reads lettered options out of an agent's last message, for one-tap answers |
| `src/fleet/runtime.ts` | assembles the fleet stack; only one process may run it |
| `src/fleet/` | the fleet radar: every agent session on the Mac, not just Conductor's |
| `src/fleet/observers/` | one file per discovery source; none of them know about each other |
| `src/fleet/fleet-monitor.ts` | merges observers and hook events, decides what needs attention |
| `src/fleet/hook-ingress.ts` | loopback HTTP endpoint the installed agent hooks report to |
| `src/fleet/git-state.ts` | cached working-tree reads, so "finished" says what changed |
| `src/fleet/diff-view.ts` | reads and paginates a workspace diff for review in Telegram |
| `src/fleet/duck-mood.ts` | what the desktop duck is doing, derived where CI can test it |
| `src/fleet/claude-pricing.ts` | per-token dollar rates; a model missing here returns null, never a guess |
| `src/fleet/claude-cost.ts` | whole-file, cached, lazy Claude cost estimate — see the note below on why |
| `desktop/` | Squeak for Mac: the duck plus the main window; a separate package, plain JS, no build step |
| `desktop/app-window.js`, `desktop/renderer/app.*` | the Squeak window: sessions, full messages, decisions, replies, service control |
| `desktop/squeak-service.js` | the window's only way out: /state, token-gated control routes, launchctl, Squeak Hands |
| `scripts/build-squeak-app.sh` | packages `~/Applications/Squeak.app` (icon, bundle id, signing) |
| `DESIGN.md` | the brand and design system every surface follows; tokens in §11 |
| `src/remote/` | the phone channel's Mac side: crypto, Firestore REST, `RemoteBridge` |
| `ios/` | Squeak for iPhone (SwiftUI, xcodegen) and `SqueakCore` (`swift test`) |
| `firebase/` | project `squeak-5c9gvo`: Firestore rules, and Hosting for the SideStore source |
| `docs/remote-channel.md` | the phone channel's threat model and design — read before touching it |

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

## Two daemons, not one — and only one is meant to run

`conductor-tg` is the bridge: a conversation you navigate and talk to agents
through. `squeak` is a pager: it watches every agent on the Mac and
messages you when one finishes or blocks. Separate binaries, separate bots,
separate config (`~/Library/Application Support/squeak/.env`), separate
state (`squeak.db`).

**As of 2026-09-22 the user asked for the bridge to stop running entirely.**
`com.conductor-tg.bridge` was booted out and its plist moved to
`~/Library/LaunchAgents/disabled/`. Only `com.squeak.daemon` and
`com.squeak.duck` should be running now — the duck comes bundled with Squeak
via `install-squeak-agents.sh`, which installs both together.

**Do not re-enable the bridge without being asked.** `ship.sh`'s
`restart_bridge` decides whether to kickstart or bootstrap based on whether
`~/Library/LaunchAgents/com.conductor-tg.bridge.plist` *exists on disk* — not
whether it is loaded. Moving the plist out of that directory is exactly what
stops a future `ship.sh` run in this worktree from silently bringing the
bridge back via its bootstrap fallback.

`ship.sh` itself now checks for `~/Library/LaunchAgents/disabled/<label>.plist`
before touching the bridge at all — both in `restart_bridge`'s manual-start
fallback and, separately, before the health-check/rollback block runs. Without
that second check, shipping *any* change (not just one touching `src/index.ts`)
would have looked like a failed deploy the moment the bridge stayed down on
purpose, and triggered a rollback that reverted a perfectly good build back to
`dist.prev` for no reason. If the bridge is ever re-enabled, delete or rename
that marker file, not just move the plist back. If the user ever wants it back:
`mv ~/Library/LaunchAgents/disabled/com.conductor-tg.bridge.plist
~/Library/LaunchAgents/` then `launchctl bootstrap gui/$(id -u)
~/Library/LaunchAgents/com.conductor-tg.bridge.plist`.

- **Only one process may run the fleet.** Two would bind the same hook port
  and send every notification twice. The bridge no longer wires it up at all;
  `createFleetRuntime` belongs to Squeak.
- Squeak passes `openConductorSession: null` (no Open Chat — it has no
  conversation view) but does pass a `replier`, so a **finished** Conductor
  card carries Reply, Full message, and one button per lettered option.
  A letter tap sends just that letter; a swipe-reply or a Reply prompt sends
  free text. Routing is by the replied-to message id, stored in
  `fleet_reply_target` so it survives restarts — never guess the target from
  loose text, several chats may be waiting.
- **A reply is typed into Conductor's own window first**, so it shows and
  streams live. Conductor's API (`conductor message create`) is cloud-only and
  the documented `conductor://` links cannot open an existing chat, so there is
  no other live route. `helpers/squeak-hands/` is a tiny Swift app that alone
  holds the Accessibility grant; build it with
  `helpers/squeak-hands/build.sh ~/Library/Application\ Support/squeak`.
  It is signed with the Apple Development identity on purpose: an ad-hoc
  signature changes every build and silently revokes the grant. It is launched
  through `open` so macOS attributes it to its own grant, not to node.
  - It proves which chat is on screen from the web area's `AXURL` (Conductor's
    router: `…/workspace/<id>?activeTabType=session&sessionId=<id>`), never
    from a tab label — two chats in one workspace can share a title, and this
    happens on a real machine. Tabs are tried until the route names the session.
  - Conductor's sidecar shares the app's bundle id; pick the `.regular`
    process or AX sees no windows about half the time.
  - Every failure except `unconfirmed`/`helper-failed` guarantees nothing was
    typed, and only then does the reply fall back to the background CLI. A
    possibly-sent message is confirmed against `session_messages`, never
    re-sent. It refuses to paste over an existing draft.
- **The background fallback runs `claude -p --resume` (or the codex app-server)**, with
  the adapters' `bypassPermissions` / approvals-off, and mirrors both sides
  into `conductor.db`. It refuses — never queues — when the Conductor session
  is `working`, `cancelling`, `needs_user_input` or `needs_plan_response`:
  Conductor's own process holds that chat and a second writer would talk
  past it. Blocked cards therefore get no Reply. The answer is not streamed;
  it comes back as the next finish card, and Conductor only shows the
  exchange once it reloads the chat.
- **The card's `detail` is a 180-char summary**, useless for reading options.
  `ConductorReplier.lastTurnText` reads the full text from `session_messages`
  instead, newest turn only — role `assistant` rows there also hold tool
  calls, tool results, `result` and `system` events, and a turn that has
  just started must not resurface the previous turn's question.
- The desktop duck still reads `127.0.0.1:8477/state`; that is now served by
  Squeak rather than the bridge.
- **Squeak for Mac is the duck's Electron app with a window.** One process,
  one instance (`requestSingleInstanceLock`): opening Squeak from Spotlight or
  Finder while it runs shows the window. launchd starts it with
  `--background` (duck and menu bar only). `Squeak.app` is Electron plus a
  two-line loader that `require`s the **main checkout's** `desktop/main.js`,
  so `ship.sh` updates the app without rebuilding it; rebuild only for icon,
  metadata or Electron changes. It lives in `~/Applications` because
  `/Applications` needs admin. `SQUEAK_DESKTOP_MAIN` points the bundle at a
  worktree for testing.
- The app keeps the old `conductor-tg-duck` userData folder on purpose
  (`app.setPath` before ready): packaged as "Squeak", Electron would move it
  and lose the duck's position, and the single-instance lock would stop
  matching an older running copy.
- **Control routes are token-gated and carry no CORS header.**
  `/control/session/<id>/message` and `/reply` on the ingress let the window
  read a chat's full message and answer it through the same `ConductorReplier`
  as Telegram. Any web page can reach 127.0.0.1, so unlike `/state` these must
  never be readable or callable from a browser. Note `/state` itself still
  sends `access-control-allow-origin: *`, which lets any web page read session
  titles, paths and summaries — the duck's `file://` page needs *some* CORS;
  moving its fetch into the main process would let that header go.
- The window's renderer never gets the token, a shell, or a URL: everything
  goes through `app-preload.js` to `squeak-service.js` in the main process.
  Agent messages are rendered with `textContent` only — they are untrusted.
- `SQUEAK_CAPTURE=<prefix>` photographs the window (loaded, each row, the
  iPhone view before pairing) and quits. The decision tap **sends a reply**, so
  it runs only with `SQUEAK_CAPTURE_TAP=1` and never on the live port 8477 —
  point `FLEET_HOOK_PORT` at a test endpoint. The capture using its own temp userData so it cannot collide
  with the running duck. Capture turns off background throttling and floats
  the window, or shots of a covered window come out as empty files.

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
- **Exactly one bridge may poll the bot.** Two instances make Telegram return
  409 and messages land in whichever won the race — visible only as noise in
  the log, so it can persist for days. `ship.sh` decides how to restart by
  whether the launch agent's plist *exists*, not by whether `launchctl list`
  currently shows it (it is briefly empty during a reload, and the manual
  branch then starts a second bridge), and reaps any process launchd does not
  own after restarting.
- `install-squeak-agents.sh` writes **every** plist before unloading anything,
  and a load failure warns rather than aborting. `launchctl bootout` is
  asynchronous, so bootstrapping straight after it fails with "Input/output
  error" — leaving a service booted out and nothing bootstrapped in its place,
  which is worse than whatever the rerun was fixing.
- **Codex quota is account-wide, not per-session.** `rate_limits` sits on
  every `token_count` event as a sibling of `info`, not nested inside it — a
  first attempt at `codex-usage.ts` nested it and silently returned null
  forever. Verified against a real machine before and after the fix.
- **`cost-state` is almost never written for a Conductor-driven session.**
  Measured on a real machine: 1/37 `sdk-ts` transcripts and 1/18 `sdk-cli`
  transcripts had one, against 2/3 for terminal (`cli`) sessions. So the
  original per-session cost tracking was correct but invisible for the
  overwhelming majority of real usage.
- **`src/fleet/claude-pricing.ts` estimates cost from raw token counts**
  instead, since every entrypoint writes those on every assistant message
  regardless of `cost-state`. Rates and the cache write/read multipliers
  (1.25x / 2x for 5-min / 1-hour TTL writes, 0.1x for reads) come from the
  `claude-api` skill, not memory — pricing drifts and a stale number here
  would be worse than admitting the model is unpriced (`rateForModel`
  returns `null` for anything not in the table, on purpose).
- **This needed a whole-file read, which is a different cost class from
  everything else in `src/fleet/`.** State detection only needs the *last*
  entry, which the 256KB tail read easily contains; cost needs a *sum* across
  the entire session. A real 22MB transcript only has ~1% of itself in that
  tail window — computing the estimate from the tail alone would have
  silently under-reported exactly the longest, most expensive sessions by
  orders of magnitude. `src/fleet/claude-cost.ts` (`ClaudeCostReader`) reads
  the whole file instead, but only for sessions about to be rendered (same
  discipline as `GitStateReader`), caches by `(path, mtime)`, and returns
  `null` above a 16MB size cap rather than a silently partial sum.
- **Claude Code writes the same assistant message more than once as it
  streams**, each occurrence carrying the *full* usage for that message, not
  a delta. Summing every occurrence instead of deduplicating by
  `message.id` overcounted a real session's cost by ~85% against Anthropic's
  own authoritative `cost-state` total — caught by checking the estimate
  against that one real number before trusting it anywhere else. Keep only
  the last occurrence per id.
- **Claude Code never persists its rate-limit event to disk.** `rate_limit_event`
  only ever appears in the live stdout of whatever process spawned the CLI —
  confirmed by dumping the raw hook payload too, which carries none of it
  either. So Claude gets local per-session cost tracking (`cost-state`
  entries, real and persisted) but not quota/reset tracking; do not try to
  fake the latter from a spawned probe process, which would burn real quota
  just to check quota.
- The tray dropdown shows **usage, not the session list** — that already
  lives in the duck's own panel one click away. `tray.on("click", peek)` was
  removed: Electron already opens the context menu on a tray click by
  itself, so the handler was firing the agents panel open *at the same time*
  as the menu.
- The duck has **two independent global shortcuts**: peek-at-panel and
  show/hide. They must stay separate — a single shortcut that both reveals
  and can hide the duck would eventually hide it when you meant to peek.
- **`desktop/` has its own eslint config**, run by `npm run lint`. It is
  invisible to tsc and to `eslint src/`, and two real bugs reached the user
  through that gap. Note that flat-config `files` patterns resolve against the
  directory eslint runs from, so they must be repo-relative — a config whose
  patterns match nothing passes everything, which is worse than no linter.

## The phone channel (docs/remote-channel.md)

- **The Mac trusts a key, not a server.** `RemoteBridge.handleCommand` runs a
  reply only if a paired, unrevoked device's P-256 key signed the exact box,
  it has not expired (≤10 min), its nonce is new, it names the chat's
  *current* turn, and it is a plain reply. Keep every check; add tests for
  any new one. Pairing always waits for the human to approve on the Mac.
- **Swift and Node must agree byte-for-byte.** Change a shape on one side and
  regenerate the fixtures (`swift run -c release squeak-fixtures
  ../../src/remote/fixtures/swift-command.json` in `ios/SqueakCore`; the Mac
  fixture from a `RemoteBridge.phoneView()`), then run both test suites and
  `npx tsx scripts/e2e-remote.ts`.
- The iPhone app is released with `ios/scripts/release.sh "notes"`; bump
  `MARKETING_VERSION` in `ios/project.yml` or SideStore never offers it. The
  file is served as `.zip` because Spark refuses `.ipa` on new projects.
- `SQUEAK_REMOTE_PROJECT` in Squeak's `.env` turns the channel on. The
  channel secret lives only in `~/Library/Application Support/squeak/remote.json`
  (0600) and in paired phones' Keychains.

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
- Blocked sessions get pushed to Telegram wherever they run; a **finish only
  pushes for a Conductor session** (`shouldPush` in `attention.ts`). Every
  agent on the Mac ends turns all day and those finishes were the bulk of the
  noise. Errored and low-on-context ones only appear on the radar.
- Push cards are **three short lines at most** — which session, what the agent
  said it did, what changed on disk — and the last one is only on a finish.
  They are lock-screen notifications, not documents: no commit counts
  (`describeGitState(state, { countCommits: false })`), and the heading drops
  the repo rather than wrapping, since the branch identifies the work. The
  agent's own last message is the point of the card; `card-text.ts` strips its
  markdown, because Telegram would otherwise show `##` and `**` literally.
- **A card carries no button that is also a command.** Snooze and Radar sat on
  every card and read as chrome repeated down the chat; they are `/snooze` and
  `/radar`. Only per-session actions stay.
- `src/fleet/active.ts` owns the active rule. The monitor, the radar and the
  local state endpoint all read it; do not reimplement the predicate.
- **The duck decides nothing.** Mood, the active set and every rendered field
  come from `/state`; the renderer only draws. Putting logic in
  `desktop/renderer/` means it escapes CI and can start disagreeing with
  Telegram about what is happening. Formatting an existing field (agent name,
  a context-percent warning glyph) is fine and duplicated on both sides on
  purpose; a real computation across sessions (the title-collision check
  below) is not, and belongs server-side in `radar.ts` so both surfaces stay
  in sync instead of drifting.
- **Two sessions can share repo, branch, *and* agent** — Conductor allows a
  second chat on the same workspace, and this is not hypothetical: this
  session and an earlier one in it were, on this machine, simultaneously
  "conductor-tg · blume-style-session-hub" with nothing to tell them apart.
  `renderRadar` disambiguates by appending each session's own title, but only
  once two rows actually collide (`labelCounts` in `radar.ts`) — the same
  discipline `formatWorkspaceLabel` already uses for repo names, applied here
  because most rows never collide and don't need the extra text. Conductor's
  own "Untitled" placeholder counts as no title.
- `desktop/` is a **separate package on purpose**: `conductor-tg` is published
  to npm and must not carry Electron as a dependency. It is excluded from
  `package.json` `files`, from `tsconfig`, and from `eslint src/`.
- Expansion state lives in the Electron **main** process, which also owns the
  window size; the renderer only reacts to `duck:expanded`. Tracking it in
  both was a desync waiting to happen.
- The duck window is an **NSPanel** (`type: "panel"`) at **`"floating"`**
  always-on-top level, not `"screen-saver"`. `"screen-saver"` is the level real
  screensavers use; WindowServer plausibly special-cases it during the Mission
  Control Space-swipe animation, which is why the duck still vanished and
  reappeared on swipe after becoming a panel. `"floating"` sits above ordinary
  windows, which is all the duck needs, without that apparent special-casing.
  `applyFloatingBehavior` also re-applies both settings on `ready-to-show`,
  since several Electron issues report the collection-behavior flags not
  reliably sticking when set immediately after construction, before the
  window has a backing NSWindow.
- `skipTransformProcessType: true` on `setVisibleOnAllWorkspaces`: without it
  Electron flips the process between UIElementApplication and
  ForegroundApplication, which by its own documentation "will hide the window
  and dock for a short time". The dock is hidden before the window is built,
  so the app is already a UIElementApplication and the transform buys nothing.
- A panel can still take focus, which click-away-to-close needs — checked with
  a standalone probe before *and after* changing the always-on-top level,
  since both are easy to break silently and not obvious from reading the code.
- To see the duck without Screen Recording permission, use
  `DUCK_CAPTURE=<prefix>` — the window photographs itself. Note it photographs
  the *page*, not the composited window: it shows transparency correctly even
  when the native window has lost it, so it cannot verify a white-background
  report. Only eyes on the menubar can.
- **Keep the duck on Electron >= 35.1.3.** On 34 and earlier a transparent
  window at or below ~128-160px renders as an opaque white rounded square
  (upstream #38630 / #44884, fixed by #46353) — which is exactly the collapsed
  duck at 132x132. It reads as "a white card behind the duck" and is easy to
  misdiagnose as CSS or a bad sprite, both of which photograph fine.
- The ingress serves `GET /state` unauthenticated on loopback for local UIs.
  It is read-only and exposes nothing a local process could not already read
  from the same files; hook posts still require the token.
- **Conductor writes two timestamp spellings.** The app writes ISO-8601 with an
  offset, but its `update_sessions_updated_at` trigger rewrites `updated_at`
  with `datetime('now')` — a UTC wall time with no offset. `Date.parse` reads
  that in local time, so on a UTC+5:30 machine every trigger-touched row looked
  5.5h stale: finished sessions permanently missed the 15-minute active window
  and the fleet never pushed them, while brand-new chats (still carrying the
  app-written ISO stamp) pushed a bogus "done" at creation. `listFleetSessions`
  normalizes via `conductorTimestampToIso` (and orders by `datetime()` so both
  spellings sort by real recency); the conductor observer additionally reports
  a session with no `last_user_message_at` as idle, since a chat nobody spoke
  in never ran. Do not compare raw `updated_at` strings across rows — the `' '`
  in the naive spelling sorts before the `'T'` in ISO and inverts recency.
- **An idle Conductor chat is "finished" only if its last turn *ended*.**
  The observer used to infer a finish from `sessions.updated_at` being recent,
  but Conductor's trigger bumps that on any write to the row: closing a chat
  (`is_hidden`), touching several at once, a rename. And a turn that errors a
  second after you send it is just as recent as one that completed. Both made
  the duck celebrate and Telegram push "done" with nothing done — seen on a
  real machine for a user-aborted turn, an "OpenCode 2 required" failure, and
  a chat idle since the week before. The turn-end record is the `result` /
  `error` row every agent writes (Claude and Codex both), read per chat in
  `listFleetSessions` via the `session_id` index (~20ms for the whole list).
  `{"type":"error","content":"aborted by user"}` is you pressing stop, so idle;
  other `error` rows or `is_error: 1` are `error`. A resting chat's
  `lastActivityAt` is its content time, never `updated_at`.
- **Closed Conductor chats stay in the Conductor observation, flagged.**
  `listFleetSessions` used to skip `is_hidden` chats, but their transcripts
  still exist, so the fleet rediscovered each one as an anonymous
  non-Conductor session (labelled by folder, not repo). They are returned with
  `isHidden` and the observer marks them retired. Hidden repos likewise.
- **An idle Conductor chat is never active because of a live process.**
  Conductor's sidecar keeps a warm `claude` process per recently used chat
  for many hours (four at once on a real machine, all idle 16h), so "quiet
  with a live process" — the right signal for a terminal agent — means nothing
  for a Conductor chat, whose status Conductor reports itself.
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
