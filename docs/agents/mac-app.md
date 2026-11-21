# Mac app and surfaces

Read before touching `macos/`, the session timeline or control routes. Full detail: `macos/README.md`.

- **An open Squeak chat's feed is the host's timeline, not a guess from rows.** `src/native/timeline.ts` /
  `timeline-log.ts`: one ordered event log per chat in `native.db` (`timeline_events`): `turn.started` (written
  synchronously when a send is accepted, before the agent starts; carries author, `clientNonce`, `queuedId`),
  `step.added/updated` (stable step ids: tool id or `<message id>:<block>`; api waits are one `wait-n` step),
  `reply.done`, `turn.ended`, `prompt.queued/dequeued`; `reply.delta` is ephemeral (offset-addressed, no seq).
  `GET /native/sessions/:id/timeline?since=|turns=&before=`, and `tl=<seq>` on the session stream adds `timeline`
  frames. The Mac's `TurnTimeline` (SqueakMacCore) is a pure reducer over it (idempotent by seq, gaps refetched
  with `since`, rows only grow, ended turns immutable, a press is a row reconciled by nonce); `TimelinePresentation`
  makes everything the screens read. Pond members get the same events as `timeline` thread events (host `seq`
  inside) and reduce them with `PondReplica`. Do not add another source of "the current turn" for these chats:
  the activity route and transcript reads are only for other sources and hosts without the route.
- **"What it's doing" reads the transcript, not the card.** `activity.ts`
  lists the current turn: Claude's thinking summaries (present because
  Conductor runs `--thinking-display summarized`), its notes between steps,
  and each tool call as a plain label — never the raw input. Claude writes
  each block of a message as its own entry under one message id, so blocks
  are keyed by tool id or content, not position (keying by position merged
  thinking, text and tool into one). A `<task-notification>` is a worker
  reporting in, part of the turn; any other user text starts a new one.
  Codex's reasoning is encrypted with an empty summary, so its feed is notes
  and commands. It is served on the token-gated
  `/control/session/<key>/activity`, since thinking is session content, and
  the window refreshes only the feed each poll so drafts and scroll survive.
- Squeak for Mac, the iPhone app and the daemon's other surfaces all read the same
  daemon: `127.0.0.1:8477/state` and the token-gated `/control/*` routes.
- **Squeak for Mac is native** (`macos/`, SwiftUI/AppKit, `LSUIElement` menu-bar
  accessory, macOS 14+, Swift 6, Sparkle 2). It reads `conductor.db` read-only
  itself, so the session list, history and activity work with the daemon down;
  sending, terminal sessions and every channel need the daemon. The Dock icon
  appears only while the conversation window, Settings or Welcome is open.
  Cmd-Q closes its windows, "Quit Squeak" in the menu really quits. Its cache is
  one encrypted file in `Application Support/Squeak Mac/`, key in a 0600 file
  beside it, not the Keychain.
  The release is signed with the Apple Development identity (`build-app.sh`, same lookup as Squeak Hands, so the Input Monitoring grant for the double-tap Quick message shortcut survives updates; ad hoc with a warning if none), not notarized. Full detail, status and what is
  still untested: `macos/README.md`.
- **Control routes are token-gated and carry no CORS header.**
  `/control/session/<id>/message` and `/reply` on the ingress let the Mac app
  read a chat's full message and answer it through the same `ConductorReplier`
  as Telegram. Any web page can reach 127.0.0.1, so unlike `/state` these must
  never be readable or callable from a browser. `/state` sends no CORS header either (removed; only the retired Electron duck's `file://` page needed it), so a web page cannot read it; a regression test pins that.
- **Capturing the native app:** `SQUEAK_MAC_CAPTURE=<prefix>` opens the window,
  saves screenshots and quits, with its own temp cache and key. Add
  `SQUEAK_MAC_DEMO=1` for fake data: no network, and no send ever reaches a chat.
  Never exercise a real send against a live chat without the owner. See the
  table of flags in `macos/README.md`.
