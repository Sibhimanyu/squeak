# Conductor local-session feasibility (Squeak 2.0, Phase 1 gate)

Question: can an external macOS app reliably **send a prompt into, and receive
replies from, the same pre-existing Conductor local session**?

**Verdict: SUPPORTED**, through the owner-authorized local relay, on an
undocumented interface, with the caveats in sections 5 to 7. Send was observed
end to end once. Several reliability properties are designed or covered by unit
tests only and are listed in section 7 with steps to close them.

Labels used throughout:

- **Observed**: run against real Conductor 0.91.1 on this Mac, or read directly
  off the shipped bundle or live state.
- **Designed**: implemented and unit-tested in this repo, but not exercised
  against the real app in the way the row claims.
- **Untested**: neither.

## 1. Version and harness tested

| item | value | basis |
| --- | --- | --- |
| Conductor | 0.91.1 (Tauri, macOS WKWebView) | Observed: `defaults read /Applications/Conductor.app/Contents/Info CFBundleShortVersionString` |
| macOS | Darwin 25.6.0 | Observed: this environment |
| Date of live relay run | 2026-10-17 | Owner-run, recorded in the owner's memory notes |
| Reverse-engineered bundles | `renderApp-BhRpw2zl.js`, `main-DAFNnNfp.js` | `.context/re/*.md` |
| Squeak side | `src/fleet/conductor-relay/*` (crypto, pairing, phone client, relay server, upstream proxy, service), wired into `ConductorReplier.send` in `src/fleet/session-reply.ts` | code |
| CLI | `scripts/conductor-relay.ts` (`list`, `setup`, `reset`, `run`, `keychain-pair`) | code |

Live state at the time of writing (read-only probes, nothing printed that is
secret and no message content selected):

- `conductor.db` `settings.roundhouse_client_url_override` = `http://127.0.0.1:8788`.
- `conductor.db` `settings.internal_desktop_remote_access` is present.
- The Squeak daemon (node, pid 90886) listens on `127.0.0.1:8477` (`/state`
  answers) and on `127.0.0.1:8788` (the relay and proxy). Conductor's own
  loopback listeners are separate processes.

So the override and the daemon-side listener are both in place right now. That
shows the setup persists. It does not show a host is currently connected; the
daemon log would say "authenticated; ready to answer chats live".

What was verified on 2026-10-17 (owner's run, Observed): setup wrote the two
settings keys; Conductor was restarted once; a device was paired by writing the
login Keychain item (service `com.conductor.app.production.settings`, account
`desktop_relay_paired_devices`); Conductor's host then connected to the local
server and authenticated; `GET /desktop-remote-access/health` returned 200;
`POST /workspaces/<id>/sessions/<sid>/pending-messages/send` injected a message
that appeared **live in the same, pre-existing chat**, with the screen locked
and no cloud involved.

## 2. How the relay route works

1. Conductor reads `roundhouse_client_url_override` (a plain `settings` row,
   validated only for http or https; default `https://api.conductor.build`) and
   uses it as the base for its whole cloud client. The host relay socket is
   `<base>/desktop-relay/v1/host?hostId=...` (http rewritten to ws).
2. With `internal_desktop_remote_access = true`, Conductor starts its "mobile
   access" host and dials that URL. Squeak's `ConductorRelayServer` accepts it,
   answers `POST /auth/exchange` locally, and plays the phone side of the
   encrypted session (`phone.ts`, `crypto.ts`).
3. The phone side authenticates with a paired device credential, then speaks
   Conductor's local Roundhouse API through the tunnel. Sending is
   `GET .../pending-messages` (for `generation`) then
   `POST .../pending-messages/send` with a fresh `messageId` UUID,
   `deliveryPayload.message`, `mode` (`queue` or `steer`) and
   `expectedGeneration`. Conductor then calls the same composer function its own
   UI uses, so the message appears and streams like a typed one.
4. Everything that is not the relay path (about 150 REST routes, `/auth/exchange`
   for other consumers, the Codex ChatGPT proxy, `/direct/mws` terminal
   websocket, git sync) is passed through byte for byte to the real backend by
   `proxy.ts`. This is mandatory because the override is global (section 5).

Evidence for the protocol: `.context/re/conductor-remote-control-protocol.md`
(section 5.4 for the send route and its idempotency on `messageId`),
`relay-redirect-feasibility.md` and `roundhouse-override-blast-radius.md`.

## 3. Capability table

Routes: **R1** local relay; **R2** Squeak Hands AX typing into Conductor's
window; **R3** background CLI plus DB mirror; **R4** public cloud API; **R5**
deep links; **R6** sidecar socket; **R7** app-actions DOM bridge.

### R1. Local relay (preferred)

| capability | status | evidence |
| --- | --- | --- |
| Discover sessions | Observed | Squeak reads them from `conductor.db` (`conductor-registry.ts`), not through the relay. The relay can also list them (`sessions?workspace=` topic, `GET /workspaces`), Designed, RE only. |
| Stable session id | Observed | `sessions.id` is the id in the route path; the send landed in the intended pre-existing chat. Joins to agent transcripts via `claude_session_id`. |
| Send into the same session | Observed | 2026-10-17 run: message appeared live in the existing chat. If the id did not exist, Conductor would create a session (RE), so the id must come from the DB. |
| Positive acknowledgment | Observed (HTTP) / Designed (delivery) | Response 200 with queue state is what `service.ts` treats as ok. A message moving from `messages` to `ingestedMessageIds` means delivered to the agent (RE, not coded). `409 generation` handling and idempotent retry on `messageId` are RE-documented; unit tests cover the client, not a live 409. |
| Read reply | Observed (DB), Designed (relay feed) | Reply text is read from `session_messages` and the turn-end rows (section 4). The relay `/ws` and `/feed` topics could stream it; Squeak does not use them. |
| Streaming or progress | Observed (in Conductor's own window), Designed (in Squeak) | Appears and streams live in Conductor's window. Squeak's own progress comes from transcripts (`activity.ts`), not the relay. |
| Approvals | Not supported | RE: plan responses, question answers and tool approvals return 501 over this channel. `session-reply.ts` refuses `needs_user_input` and `needs_plan_response`. |
| Open in host via `conductor://workspace?id=&session=` | Untested | Nothing in `src/` or the old `desktop/` uses `conductor://`. CLAUDE.md records that the documented links cannot open an existing chat. Treat as unavailable until tested. |
| Survives Conductor restart | Observed once (setup restart) / Untested (steady state) | Conductor was restarted once during setup and then connected. Reconnect after a later relaunch is Designed: `onHost` supersedes any older client. See 7.2. |
| Survives Squeak (daemon) restart | Designed | `listenWithRetry` rebinds the port every 5 s; the override points here permanently, so Conductor's cloud traffic waits meanwhile. Not exercised live. See 7.3. |
| Survives sleep or wake | Untested | Sockets die on sleep; `send` clears the client on a thrown error so `isReady()` goes false and replies fall back. Recovery depends on Conductor redialing. See 7.4. |
| Works with screen locked | Observed | 2026-10-17 run. |
| Reversible disconnect | Designed | `scripts/conductor-relay.ts reset` deletes the settings rows (needs a Conductor restart); `setup` first copies `conductor.db` to `conductor.db.before-squeak-relay-<ts>`. Paired-device Keychain entry removal is manual. Not run live. |

### R2. Squeak Hands AX typing (fallback 1)

| capability | status | evidence |
| --- | --- | --- |
| Send into the same session | Observed (in production use) | `helpers/squeak-hands` proves the visible chat from the web area's `AXURL` (`...sessionId=<id>`), never from a tab label. |
| Acknowledgment | Designed | Possibly-sent results are confirmed against `session_messages`, never re-sent (`session-reply.ts`, `mayHaveSent`). |
| Read reply, approvals | As R1 | DB read; approvals still answered in Conductor. |
| Screen locked | Not possible | Needs an unlocked GUI session and Accessibility. |
| Restart or sleep | Designed | Stateless per send; fails closed. |
| Disconnect | N/A | Nothing is installed in Conductor. |

### R3. Background CLI plus DB mirror (fallback 2)

| capability | status | evidence |
| --- | --- | --- |
| Send | Observed (shipped) | `claude -p --resume` or codex app-server; both sides mirrored into `conductor.db` (`conductor-mirror.ts`). |
| Same session | Partial | Same agent session and same Conductor row, but Conductor does not live-reload; the exchange appears only after Conductor reloads the chat. |
| Busy sessions | Refused | `working`, `cancelling`, `needs_user_input`, `needs_plan_response`: a second writer would talk past Conductor. |
| Risk | Writes `conductor.db` | Envelope must match Conductor's exactly or the UI shows "could not be displayed" (CLAUDE.md). |

### R4 to R7. Other routes

| route | verdict | reason |
| --- | --- | --- |
| R4 public cloud API (`conductor message create`) | Not applicable | Cloud-only; cannot address a local session. |
| R5 deep links | Open only | Can raise Conductor or a workspace; cannot send, and cannot open an existing chat per CLAUDE.md. |
| R6 sidecar socket | Rejected | The agent runtime's loopback listeners belong to Conductor's own client; connecting would steal or confuse it, and it speaks the agent protocol, not the composer. |
| R7 app-actions DOM bridge / webview JS | Weak; not pursued | `webview-injection-feasibility.md`: the WKWebView is inspectable, but only through Apple's Remote Web Inspector (private XPC, no supported client, tied to an unlocked GUI session). No Tauri command evaluates JS. Not lock-screen-safe. |

## 4. Reading replies back

Squeak never needs the relay to read. Replies are read from `conductor.db`:

- `session_messages` rows for a session (`role`, `content`, `turn_id`,
  `sent_at`, `cancelled_at`), ordered by recency. `listSessionMessages` and
  `listAssistantMessagesAfterRowId` (rowid watermark) are the readers;
  `ConductorReplier.lastTurnText` takes the newest turn only.
- Turn end is the `result` or `error` row every agent writes. A user abort is
  `{"type":"error","content":"aborted by user"}` and counts as idle; other
  `error` rows or `is_error: 1` are errors. This is what distinguishes a real
  finish from a bumped `updated_at`.
- For a send, delivery is confirmed by a new `role = user` row in
  `session_messages` (and, for terminal agents, a transcript entry), never by
  retyping.

Read-only status: these are `SELECT`s. One caveat to be honest about:
`ConductorRegistry` opens the database with `new Database(path)`, not
`readonly: true`, because the same class also performs the R3 mirror writes. The
relay route itself writes nothing to the database apart from the one-time
`setup` and `reset` settings rows. A pure read-only Squeak 2.0 client should
open the file with `readonly: true`.

## 5. Identity

- Primary key: `sessions.id` (also what `pending-messages/send` takes), with
  `sessions.workspace_id` for the route's workspace segment.
- Agent identity: `sessions.claude_session_id` (set for Claude and Codex despite
  the name). It joins Conductor rows to transcripts and hook events.
- Never identify a chat by tab title (two chats in one workspace can share one)
  or by loose text. Reply routing is by the replied-to message id, stored in
  `fleet_reply_target`.
- Conductor creates a missing session id on send. Take ids only from
  `conductor.db`, so a typo cannot create a stray chat.
- Ordering guard: a reply names the turn it answers (`lastTurnId`) and is
  refused once the chat has moved on.

## 6. Risks and mitigations

| risk | detail | mitigation |
| --- | --- | --- |
| Undocumented interface | Everything is reverse engineered from minified bundles; a Conductor release can rename, move or remove it. | Pin the tested version (0.91.1). On start, compare `CFBundleShortVersionString` with the tested list; if it differs, leave the relay off and use R2 or R3. Re-run the RE diff per release. Keep the fallbacks in `ConductorReplier.send`. |
| Minified names change per release | `ej`, `OVr`, `Ha` and friends are per-build aliases. | Anchor on stable strings: the setting key `roundhouse_client_url_override`, the path `/desktop-relay/v1/host`, the route `pending-messages/send`, the `hello.v == 2` handshake. Do not depend on alias names. |
| Global override | The setting redirects **all** Roundhouse cloud traffic (REST, `/auth/exchange`, Codex proxy, terminal websocket, git sync), read live. If Squeak is down, Conductor's cloud features fail. | `proxy.ts` forwards everything except the relay path verbatim (HTTP, and websocket upgrades by piping bytes with no frame parsing). Daemon rebinds with retry. `reset` restores the default. Tell the owner this is a standing dependency. |
| Keychain write | Pairing writes a login Keychain item owned by Conductor's service name. | Owner-initiated only (`keychain-pair`), one named item, document its removal; never done by the daemon on its own. |
| Sign-in dependency | Needs a stored Conductor API token (prior sign-in); enterprise data privacy blocks it. | Detect and report "relay inert" instead of failing silently (`service.ts` logs the reason). |
| One host per account | The relay allows one host (4409), so Squeak acts as the phone side. A second Conductor machine on the same account would conflict. | Single Mac assumption; documented. |
| Telemetry | Each remote send is logged to Conductor's analytics (`remote_control_message_sent`). | Disclose; not avoidable on this route. |
| Busy sessions not refused by relay | The relay queues behind a running turn (`mode: queue`) or injects into it (`steer`). | Squeak defaults to `queue`; replier still refuses held questions and plans. |
| Settings edit while Conductor runs | `setup` and `reset` write `conductor.db`. | Run with Conductor quit; automatic timestamped backup first. |

## 7. What remains untested (owner steps)

All steps below only observe, or use throwaway chats. Do not run them on a chat
with work in progress. "Chat A" and "Chat B" are two new, empty chats in the same
or different workspaces. Get ids with
`npx tsx scripts/conductor-relay.ts list` (read-only).

### 7.1 Two-session isolation

Goal: a send addressed to chat A never lands in chat B, even while B is the chat
on screen.

1. Create chats A and B. Note their session ids (`sidA`, `sidB`) and workspace
   ids from `list`.
2. Bring chat B to the front in Conductor.
3. Send a unique marker to A through the daemon's reply path (for example the
   Squeak window's reply box on chat A, or the control route
   `/control/session/<sidA>/reply`).
4. Check with read-only SQL, counting only (do not select content):
   `SELECT session_id, COUNT(*) FROM session_messages WHERE role='user' AND
   session_id IN ('<sidA>','<sidB>') GROUP BY session_id;` Expected: A gained
   one row, B gained none.
5. Repeat with A on screen and a reply to B. Then send to A and B back to back
   (under a second) and confirm one row each.
6. Pass criterion: 0 misrouted rows in at least 10 sends. Also resend the same
   `messageId` once (via the CLI `run --text`) and confirm Conductor does not
   create a duplicate row (idempotency, Designed so far).

### 7.2 Conductor relaunch

1. Confirm the daemon log shows "conductor relay authenticated".
2. Quit Conductor, wait 10 s, reopen it. Do not touch settings.
3. Within 60 s the log should show a new "authenticated" line without any
   command from you. Send a marker to chat A and verify the reply path used the
   relay (log line, no fallback message).
4. Record the time from launch to ready. If it never reconnects, note whether
   the toggle in Conductor's Remote Control settings needs flipping; that is a
   defect for Squeak 2.0 to handle.

### 7.3 Squeak restart

1. `launchctl kickstart -k gui/$UID/com.squeak.daemon` (this restarts Squeak
   only; it is the supported restart, not a second `squeak start`).
2. While it is down, open a Conductor feature that uses the cloud (for example
   the PR or git sync view) and note that it fails; this is the cost of the
   global override.
3. After restart, confirm port 8788 is listening again, the host reconnects, and
   a send works. Record the gap.

### 7.4 Sleep and wake

1. With the relay ready, close the lid or run `pmset sleepnow`, wait at least
   two minutes, wake.
2. Immediately send a marker. Expected: either success or a clean fallback
   (the reply says it fell back), never a silent drop or a duplicate.
3. Wait 60 s and send again; the relay should be ready again if Conductor
   redialed. Repeat once with the network off during sleep.

### 7.5 Disconnect (reversibility)

1. Quit Conductor.
2. `npx tsx scripts/conductor-relay.ts reset`; confirm both settings keys are
   gone, and the backup file exists beside `conductor.db`.
3. Remove the Keychain item
   (`security delete-generic-password -s com.conductor.app.production.settings
   -a desktop_relay_paired_devices`). Note that this removes the whole paired
   device list; check first that no real phone is paired.
4. Reopen Conductor. Confirm cloud features work and port 8788 is no longer
   needed. Pass criterion: no Squeak process required for Conductor to function.

### 7.6 Other open items

- Whether `conductor://workspace?id=&session=` opens an existing chat on 0.91.1
  (expected no).
- Delivery confirmation via `ingestedMessageIds` instead of the DB poll.
- Behaviour after a Conductor update (7.2 on the next version) and a
  version-check gate that disables the route on unknown versions.

## 8. Verdict

**SUPPORTED, with conditions.** An external macOS app can send a prompt into the
same pre-existing Conductor local session and read the reply back, using the
owner-authorized local relay:

- **Observed**: send into an existing chat, live in its window, screen locked,
  no cloud, on Conductor 0.91.1 (2026-10-17); setup, Keychain pairing, health
  check and authentication; override and daemon listener currently in place;
  reply and turn-end reading from `session_messages`; the AX and background-CLI
  fallbacks in production.
- **Designed, not yet observed**: acknowledgment beyond HTTP 200, idempotent
  retry, reconnect after Conductor or daemon restart, sleep or wake recovery,
  `reset` as a clean undo.
- **Not available by any route**: approvals, plan answers and question answers
  from outside Conductor; opening an existing chat by deep link.

Conditions: the interface is undocumented and pinned to the tested Conductor
version; the override puts Squeak in the path of all Conductor cloud traffic;
pairing writes one Keychain item. Phase 2 should be gated on the section 7
isolation test (7.1) passing, and ship with a version check plus automatic
fallback to Squeak Hands and the background CLI.
