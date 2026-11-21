# Conductor add-on gotchas

Read before touching `addons/conductor/` or anything that reads `conductor.db`. Fleet-side Conductor rules (timestamps, turn ends, waiting, hidden chats) are in fleet.md.

- **Conductor's model aliases are not CLI model ids.** `sessions.model` holds
  Conductor's picker alias (`opus-5-1m`); the `claude` CLI only accepts catalog
  ids (`claude-opus-5[1m]`) and exits 1 on anything else, before emitting any
  output. `toClaudeCliModel` handles the translation.
- **Mirrored assistant rows must match Conductor's envelope exactly.** Extra
  fields or `usage: null` make Conductor's UI render the message as "This message
  could not be displayed."
- **Conductor does not live-reload.** Rows written to `conductor.db` only appear
  after it reloads the session; there is no IPC to notify it. That is why
  replies are typed into Conductor's window when they can be.
- Squeak passes `openConductorSession: null` (no Open Chat — it has no
  conversation view) but does pass a `replier`, so a **finished** Conductor
  card carries Reply, Full message, and one button per lettered option.
  A letter tap sends just that letter; a swipe-reply or a Reply prompt sends
  free text. Routing is by the replied-to message id, stored in
  `fleet_reply_target` so it survives restarts — never guess the target from
  loose text, several chats may be waiting.
- **A reply is typed into Conductor's own window first** (the relay add-on, when enabled on a dev install, is tried before it), so it shows and
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
- **Closing a chat from the phone closes its tab through Conductor's own "Close tab"** (`addons/conductor/close-chat.ts`, Squeak
  Hands `close`: the tab's `AXShowMenu`, then the menu item), because `is_hidden = 1` alone left the tab open in
  Conductor's window — it does not reload. Only tabs titled like the chat are tried and the route must name it
  before anything is pressed; the person's view is put back afterwards, success or not. The database write is the
  fallback when the window cannot be driven, and the only step when the tab is not open.
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
