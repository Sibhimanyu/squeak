# Squeak: current-state audit (Phase 0 of "Squeak 2.0")

> **Historical (pre-2.0).** This audit describes the Electron app in `desktop/`, which
> has since been replaced by the native Squeak for Mac in `macos/` and retired
> (no `com.squeak.duck` agent, no Electron process). The daemon, routes, files and
> secrets sections still hold; every statement about Electron, `Squeak.app` as an
> Electron loader, or the duck window is out of date. See `CLAUDE.md` and
> `macos/README.md` for the current state.

Purpose: a factual map of what Squeak is today, so a native SwiftUI/AppKit
menu-bar rebuild can preserve the hard-won logic and replace only what should
be replaced. Everything here was read from the code in this worktree
(branch `blume-style-session-hub`, HEAD `ae3a41a`); nothing is proposed that
does not exist. Paths are repo-relative; `path:line` points at the code that
backs a claim. Where the code disagrees with `CLAUDE.md` it is called out in
section 8.

Note on naming: `package.json` already says `"version": "2.0.0"`
(`package.json:3`). That is the npm package's number and is unrelated to the
planned native rewrite.

---

## 1. Repository map

| Path                          | Language                                  | What it is                                                                                                                                                                                           | Built / run                                                                                                                                                                       | Entry point                                                                                                                           |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/squeak/`                 | TypeScript (ESM, Node >= 22)              | The daemon: config, CLI, Telegram long-poll loop, wiring of every other module                                                                                                                       | `tsc -p tsconfig.build.json` to `dist/`; run by launchd as `node dist/squeak/cli.js start`                                                                                        | `src/squeak/cli.ts` (`main`, `cli.ts:142`); `SqueakApp` in `src/squeak/app.ts`                                                        |
| `src/fleet/`                  | TypeScript                                | The fleet radar: observers, merge, attention rules, hook ingress, replies, cost/limits, git state, activity feed                                                                                     | Part of the daemon                                                                                                                                                                | `createFleetRuntime` (`src/fleet/runtime.ts:58`)                                                                                      |
| `src/fleet/observers/`        | TypeScript                                | One file per discovery source (Conductor DB, Claude transcripts, Claude Cowork, Codex rollouts, process liveness)                                                                                    | Part of the daemon                                                                                                                                                                | Constructed in `runtime.ts:69-80`                                                                                                     |
| `src/fleet/conductor-relay/`  | TypeScript                                | Local stand-in for Conductor's cloud desktop relay, plus the encrypted "phone" client that injects a message into a chat through Conductor's own composer                                            | Part of the daemon                                                                                                                                                                | `ConductorRelayService` (`conductor-relay/service.ts`)                                                                                |
| `src/adapters/`               | TypeScript                                | `conductor-registry.ts` (all conductor.db access), `conductor-mirror.ts` (writes background replies into Conductor), `claude-code.ts` (spawns `claude`), `codex-app-server.ts` (JSON-RPC to `codex`) | Part of the daemon                                                                                                                                                                | n/a                                                                                                                                   |
| `src/remote/`                 | TypeScript                                | The iPhone channel's Mac side: crypto, Firestore REST, `RemoteBridge`                                                                                                                                | Part of the daemon                                                                                                                                                                | `RemoteBridge` (`remote-bridge.ts`)                                                                                                   |
| `src/cliq/`                   | TypeScript                                | Zoho Cliq: cards out, taps/replies back via a signed Firestore relay                                                                                                                                 | Part of the daemon                                                                                                                                                                | `CliqChannel` (`cliq/channel.ts`), CLI `cliq-relay`                                                                                   |
| `src/telegram/`, `src/utils/` | TypeScript                                | Telegram client, markdown-to-HTML, helpers                                                                                                                                                           | Part of the daemon                                                                                                                                                                | n/a                                                                                                                                   |
| `desktop/`                    | Plain JavaScript (CommonJS), Electron ^35 | Squeak for Mac: the duck (always-on-top panel), menu-bar tray, and the main window                                                                                                                   | No build step. `desktop/node_modules/electron` is copied into `Squeak.app` by `scripts/build-squeak-app.sh`; the bundle's loader `require`s the main checkout's `desktop/main.js` | `desktop/main.js` (752 lines); window in `desktop/app-window.js`; renderer in `desktop/renderer/` (`app.js` 851, `duck.js` 350 lines) |
| `helpers/squeak-hands/`       | Swift, single file (577 lines)            | Signed helper app that alone holds the Accessibility grant and the Automation (Terminal) grant                                                                                                       | `helpers/squeak-hands/build.sh <dir>` runs `swiftc` and `codesign`; output `Squeak Hands.app` (`com.squeak.hands`, `LSUIElement`)                                                 | `main.swift:426` dispatches on argv[1]: `probe`, `press`, `choose-file`, `send`, `terminal-read`, `terminal-type`                     |
| `ios/`                        | Swift (SwiftUI, xcodegen)                 | Squeak for iPhone; `ios/SqueakCore` is a SwiftPM package (`Channel`, `ChannelCrypto`, `Firestore`, `Pairing`, `SqueakLink`, `Models`) plus `SqueakUI` (the whole UI)                                 | `xcodegen` from `ios/project.yml` (MARKETING_VERSION 1.3.0); `swift test` in `SqueakCore`; ship with `ios/scripts/release.sh`                                                     | `ios/Squeak/SqueakApp.swift`; `SqueakRootView`                                                                                        |
| `firebase/`                   | Rules + static hosting                    | Project `squeak-5c9gvo`: `firestore.rules` (channel + Cliq relay shapes), Hosting for the SideStore source and the `/open/` hand-off page                                                            | `firebase deploy` (`firebase/deploy-pages.sh`)                                                                                                                                    | `firebase/firebase.json`                                                                                                              |
| `scripts/`                    | bash, TS, Python                          | `ship.sh`, `install-squeak-agents.sh`, `build-squeak-app.sh`, `conductor-relay.ts`, `e2e-remote.ts`, `make-mac-fixture.ts`, `move-checkout.sh`, `rename-in-conductor.py`                             | Run by hand                                                                                                                                                                       | n/a                                                                                                                                   |
| `docs/`                       | Markdown                                  | `remote-channel.md` (threat model), `cliq.md`, `duck-states/`                                                                                                                                        | n/a                                                                                                                                                                               | n/a                                                                                                                                   |
| `DESIGN.md`                   | Markdown                                  | Brand and design system; tokens in section 11                                                                                                                                                        | n/a                                                                                                                                                                               | n/a                                                                                                                                   |
| `.context/`                   | gitignored                                | Local research, notably `.context/re/conductor-remote-control-protocol.md` (the relay spec the TypeScript crypto cites). Not in git                                                                  | n/a                                                                                                                                                                               | n/a                                                                                                                                   |

Size of the moving parts (non-test TypeScript in `src/fleet/` is the bulk):
`hook-ingress.ts` 397, `session-reply.ts` 399, `terminal-reply.ts` 390,
`conductor-relay/*` about 1,050 non-test lines, `conductor-registry.ts` over
1,200.

Runtime dependencies (`package.json:36-39`): only `better-sqlite3` ^12.8 and
`zod` ^4.3. `desktop/package.json`: `electron` ^35 (dev) and `qrcode` ^1.5
(runtime, used for the pairing QR in `desktop/squeak-service.js:216`). The
relay WebSocket is hand-written (`conductor-relay/ws.ts`) to avoid `ws`; the
crypto uses only Node builtins.

---

## 2. Process architecture today

```
 launchd (gui/<uid>)
  |-- com.squeak.daemon  KeepAlive=true   node dist/squeak/cli.js start
  |-- com.squeak.duck    KeepAlive={SuccessfulExit:false}   Squeak.app --background
  |
 Daemon (one Node process)                          Electron app (one process)
  |-- Telegram long-poll (getUpdates)                |-- duck panel (renderer/duck.js)
  |-- FleetMonitor (poll every 20s + hooks)          |     fetch http://127.0.0.1:8477/state
  |-- HookIngressServer  127.0.0.1:8477  <-----------|-- Squeak window (renderer/app.js)
  |-- ConductorRelayService  127.0.0.1:<port>        |     IPC -> app-window.js -> squeak-service.js
  |-- RemoteBridge  -> Firestore REST (iPhone)       |           (HTTP + token file, launchctl, Hands)
  |-- CliqChannel   -> Cliq API + Firestore relay    '-- tray menu, 2 global shortcuts
  '-- spawns: Squeak Hands (via `open`), claude, codex
```

### 2.1 launchd agents (`scripts/install-squeak-agents.sh`)

- Writes `~/Library/LaunchAgents/com.squeak.daemon.plist` and
  `com.squeak.duck.plist` with `RunAtLoad`, `ThrottleInterval 10`, logs to
  `~/Library/Logs/squeak/{squeak,duck}.log` (`install-squeak-agents.sh:29-68`).
- Daemon: `<node on PATH> <main checkout>/dist/squeak/cli.js start`,
  `KeepAlive true` (line 98). The node path is whatever `command -v node`
  resolved at install time, baked into the plist.
- Duck: `~/Applications/Squeak.app/Contents/MacOS/Electron --background`
  when the app exists, else the raw Electron binary with the `desktop` folder
  (lines 104-113). `KeepAlive {SuccessfulExit:false}` so a menu Quit sticks.
- The repo root is derived from `git worktree list` (line 15), so the script
  must be run from a git checkout; it refuses if `dist/squeak/cli.js` is
  missing (line 20).
- There is no agent for the standalone relay CLI and none for Squeak Hands
  (Hands is launched on demand).

### 2.2 The daemon's HTTP surface (`src/fleet/hook-ingress.ts`)

One `http.createServer`, bound to `127.0.0.1` only (line 108), default port
8477 (`FLEET_HOOK_PORT`, `config.ts`). The token is 24 random bytes hex,
created on first start at `~/Library/Application Support/squeak/hook-token`
mode 0600 (`hook-ingress.ts:67-80`), compared with `timingSafeEqual`
(line 380). The header is `x-squeak-token`. Every route, in dispatch order
(`handle`, lines 126-190; `handleControl`, 200-313):

| Method + path                                                                        | Auth                                                                                  | Purpose                                                                                                                                                                                                                  | Response                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `GET /state*` (prefix match on `/state`)                                             | None                                                                                  | Whole fleet snapshot for the duck and window (`serializeState`, `runtime.ts:165`). Sends `access-control-allow-origin: *` and `cache-control: no-store` (line 322-327)                                                   | JSON; 503 if no reader; 500 on error                  |
| `POST /hook*` (prefix match on `/hook`)                                              | `x-squeak-token` (403 otherwise) plus `x-squeak-agent: claude\|codex` (400 otherwise) | Agent hook events from `fleet-notify.sh`. Body capped at `MAX_BODY_BYTES` (413). Acknowledges 200 first, parses afterwards (`dispatch`, line 337)                                                                        | `ok`                                                  |
| `GET /control/session/<id>/message`                                                  | Token                                                                                 | Full text of a session's latest turn plus parsed lettered `choices` (`router.lastTurnText` + `parseChoices`, `app.ts:~170`). `<id>` is a Conductor chat id or a fleet key (`[A-Za-z0-9_:-]{1,120}`)                      | JSON `{text, choices}`                                |
| `POST /control/session/<id>/reply` body `{"text": "..."}`                            | Token                                                                                 | Send a reply through `FleetReplyRouter.send`; response is the `ReplyOutcome` (`started` via `conductor`/`terminal`/`background`, or `refused` with a reason). Can take tens of seconds because it drives UI and confirms | JSON; 400 bad json / text required; 500               |
| `GET /control/session/<id>/queue`                                                    | Token                                                                                 | A Conductor chat's queued messages `{items:[{id,text,mode,position}]}` (`ConductorReplier.queue`, relay only); 404 unreadable, 503 not wired                                                                             | JSON                                                  |
| `POST /control/session/<id>/queue/<messageId>/promote` or `/cancel`                  | Token                                                                                 | Steer a queued message in now / delete it (`ConductorReplier.queueAction`, as the phone's `queue` command); 404 if the id is no longer queued, 409 refused                                                               | JSON `{ok}` / `{ok:false,reason}`                     |
| `GET /control/session/<key>/activity`                                                | Token                                                                                 | The current turn step by step (`readActivity`, `src/fleet/activity.ts`); 503 if not wired                                                                                                                                | JSON `{steps, total}`                                 |
| `GET /control/remote/status`                                                         | Token                                                                                 | Phone-channel state (paired devices, pending pairing)                                                                                                                                                                    | JSON; 503 `remote unavailable` if no Firebase project |
| `POST /control/remote/pair`                                                          | Token                                                                                 | Opens a pairing window and returns `{url}` (carries the channel key; desktop renders it as a QR)                                                                                                                         | JSON                                                  |
| `POST /control/remote/approve/<deviceId>`                                            | Token                                                                                 | Approve a pending phone                                                                                                                                                                                                  | `{ok}`                                                |
| `POST /control/remote/reject/<deviceId>`                                             | Token                                                                                 | Reject a pending phone                                                                                                                                                                                                   | `{ok}`                                                |
| `POST /control/remote/revoke/<deviceId>`                                             | Token                                                                                 | Revoke a paired phone                                                                                                                                                                                                    | `{ok}`                                                |
| `POST /control/remote/reset`                                                         | Token                                                                                 | Wipe the channel                                                                                                                                                                                                         | `{ok}`                                                |
| `GET /control/relay`, `POST /control/relay/setup`, `POST /control/relay/reset`       | Token                                                                                 | In-app Conductor relay setup (`conductor-relay/setup.ts`; see docs/conductor-local-feasibility.md, "In-app setup"); 409 on refusal, 503 not wired                                                                        | JSON status / `{ok,status}`                           |
| `GET /control/hooks`, `POST /control/hooks/install`, `POST /control/hooks/uninstall` | Token                                                                                 | In-app agent hooks (`fleet/hooks-setup.ts`): status `{state,claude,codex,message,steps}`; install is idempotent and repairs; 409 `{ok:false,reason,status}`, 503 not wired                                               | JSON                                                  |
| any other `/control/*`                                                               | Token first, then 404                                                                 | n/a                                                                                                                                                                                                                      | 404 `not found`                                       |
| anything else                                                                        | None                                                                                  | n/a                                                                                                                                                                                                                      | 404                                                   |

Details worth knowing:

- The token check happens before routing for all of `/control/` (line 202),
  so an unauthenticated probe cannot learn which sub-routes exist. If the
  control object was never installed the route returns 503 (line 209).
- The control object is installed after construction by
  `runtime.ingress.setControl(...)` in `app.ts:~125-175`. `reply` there is
  `this.router.send`, the same `FleetReplyRouter` Telegram uses.
- `/control/remote/*` method mismatches return 405 (503 if remote is off).
- `/state` has no token and no Host-header check. See section 5.

### 2.3 Electron app and how it reaches the daemon

- Single-instance via `app.requestSingleInstanceLock()` (`main.js:32`);
  `userData` pinned to `Application Support/squeak/desktop` (`main.js:18`).
- Two renderer pages: the duck (`renderer/index.html`, `duck.js`) and the
  window (`renderer/app.html`, `app.js`). Tray with a usage menu and two
  global shortcuts (`main.js:559-740`).
- The **duck** fetches `http://127.0.0.1:<port>/state` directly from a
  `file://` page (`renderer/duck.js:6,70`), which is why `/state` carries
  CORS `*`.
- The **window** never sees a token or URL. `app-window.js:106-114`
  registers nine IPC handlers (`squeak:state`, `service`, `restart-service`,
  `message`, `activity`, `reply`, `open-in-conductor`, `remote`,
  `pairing-qr`), each delegating to `desktop/squeak-service.js` in the main
  process.
- `squeak-service.js` does all outbound work: reads `/state` without a token
  (line 50); reads `Application Support/squeak/hook-token` itself and sends it
  on `/control/...` calls (lines 33, 58-68); asks launchd about the daemon via
  `/bin/launchctl print|kickstart|bootstrap` (lines 113-147); drives Squeak
  Hands for "Open in Conductor" with `navigateOnly: true` (lines 154-190);
  makes the QR code with `qrcode` (line 216).
- The Heresay Report button is a remote script loaded into the window's
  renderer: `renderer/app.html:7,43` allows `script-src` and `connect-src` to
  `https://heresay-sibhi-42b1.web.app` and loads `/sdk.js`; `app.js:846`
  calls `Heresay.introduce()`. This is the only remote code the app loads.

### 2.4 Squeak Hands

- A separate signed app (`com.squeak.hands`) launched per action as
  `open -W -n "Squeak Hands.app" --args <mode> <request.json> <result.json>`
  (`conductor-ui.ts` `runHands`, lines ~120-165; `squeak-service.js:177`).
  The request is a 0600 file in a fresh `mkdtemp` dir; the verdict comes back
  in `result.json`. Launching through LaunchServices makes macOS attribute the
  grant to Hands, not to node.
- Modes: `send` (type into Conductor's composer), `press`, `choose-file`,
  `probe` (Accessibility); `terminal-read`, `terminal-type` (Automation of
  Terminal.app via `NSAppleScript`, `main.swift:288-420`). Accessibility is
  requested for every non-terminal mode (`main.swift:433-437`).
- Terminal script takes `tty`, validates it against `^ttys[0-9]{3,4}$`
  (line ~381), and passes reply text as an Apple Event parameter, never spliced
  into script source (`callTerminal`, line 320).
- Signing: Apple Development identity auto-picked from the keychain, ad-hoc
  otherwise (`build.sh:25-27`); an ad-hoc build loses its Accessibility grant
  on every rebuild.

### 2.5 The Conductor relay (`src/fleet/conductor-relay/`)

What it is: Conductor has an internal "remote control" feature where its
desktop host connects out to a cloud relay and a paired phone sends chat
messages through an end-to-end encrypted tunnel. Squeak impersonates both the
relay and the phone locally.

- Setup (by hand, `scripts/conductor-relay.ts setup --port N`): backs up
  `conductor.db`, then **writes** `roundhouse_client_url_override =
http://127.0.0.1:<port>`, `internal_desktop_remote_access = true`, and three
  UI feature flags into Conductor's `settings` table (`conductor-relay.ts:82-107`).
  `reset` deletes the override. Conductor must be quit and reopened to pick it up.
- `keychain-pair` creates a device record and writes it to the **login
  Keychain** with `security add-generic-password -U -A -s
com.conductor.app.production.settings -a desktop_relay_paired_devices -w
<json>` (`conductor-relay.ts:128-155`). The JSON holds `deviceId`, name
  `Squeak`, and `sha256(deviceToken)`. `-A` means any application may read
  that item without a prompt. The raw `deviceToken` goes to
  `Application Support/squeak/conductor-relay.json` (0600) beside the host's
  pinned X25519 public key.
- At daemon start `ConductorRelayService.start()` (`service.ts:80`) reads
  `settings.roundhouse_client_url_override` from `conductor.db` read-only, and
  only if it matches `http://127.0.0.1:<port>` and `conductor-relay.json` has
  credentials does it bind that port (retry every 5s, `service.ts:107-130`).
  Otherwise it is inert and `isReady()` is false. `start()` never throws.
- When Conductor's host dials `ws://127.0.0.1:<port>/desktop-relay/v1/host`
  (`relay-server.ts:RELAY_PATH`), `onHost` runs the handshake, pins/learns the
  host static key, and authenticates with the saved device credentials
  (`service.ts:132-145`). `isReady()` is then true.
- **Every other request Conductor makes to its cloud now passes through
  Squeak.** The override is one global base URL, so `proxy.ts` forwards all
  non-relay HTTP and WebSocket traffic to `https://api.conductor.build`
  unchanged (including `Authorization` headers and `/auth/exchange`), and for
  WebSocket upgrades it pipes raw TLS bytes both ways. While the daemon is down
  and the override is set, Conductor's cloud traffic has nowhere to go
  (`service.ts:101-106` comments on this).
- Crypto (`crypto.ts`, 309 lines, Node builtins only): X25519 (two DH
  exchanges), HKDF-SHA256, XChaCha20-Poly1305 built by hand from Node's
  IETF ChaCha20-Poly1305 plus a hand-written HChaCha20 (`crypto.ts:13-17,79`).
  Labels `conductor-desktop-relay-v1/{transcript,salt,keys}`, protocol version 2.
- Sending (`phone.ts:220-250`): `GET /workspaces/<ws>/sessions/<sid>/pending-messages`
  for the queue generation, then `POST .../pending-messages/send` with
  `{messageId, deliveryPayload:{message}, config:{}, mode:"queue", expectedGeneration}`;
  on 409 it re-reads the generation and retries. Requests time out at 30s.
- Tests exist for crypto, pairing, proxy, server and service
  (`conductor-relay/*.test.ts`); the protocol spec lives in `.context/re/`
  (not in git).

### 2.6 Telegram

`TelegramClient` (`src/telegram/client.ts`) long-polls `getUpdates` in the
daemon (`app.ts` `pollLoop`). `SQUEAK_BOT_TOKEN` is **required**: the zod
schema (`config.ts:46`) fails config load without it, and `startSqueak`
prints "Squeak is not configured" (`cli.ts:129-137`). So the daemon, and with
it the Mac window's data, cannot start without a Telegram bot. Cards,
buttons and replies are in `FleetController`, `radar.ts`, `card-text.ts`.
Exactly one process may poll a given bot (409 otherwise).

### 2.7 Cliq (`src/cliq/`)

Optional. Outbound cards via the bot's `/message` endpoint; inbound taps and
replies arrive as HMAC-signed records posted by Deluge handlers to Firestore
`cliq/<relay>/inbox/{doc}` and polled by `CliqRelayInbox` every 5s (30s
backoff). Records older than 10 min, forged, or replayed are dropped. Needs
`SQUEAK_REMOTE_PROJECT` plus `SQUEAK_CLIQ_*` in `.env`. `FleetAssistant`
(plain-language questions) spawns the user's `claude` with
`--output-format stream-json --verbose`. See `docs/cliq.md`.

### 2.8 Phone channel (`src/remote/`, `docs/remote-channel.md`)

Enabled only if `SQUEAK_REMOTE_PROJECT` is set. `RemoteBridge` publishes an
encrypted snapshot to Firestore (REST, unauthenticated, rules enforce shape
only, `firestore-rest.ts`) and runs phone commands after verifying a P-256
Secure Enclave signature, expiry (<= 10 min), nonce freshness, current turn id
and "plain reply" kind. Key material and paired devices live in
`Application Support/squeak/remote.json` (0600). The phone replier is the
Conductor-only `ConductorReplier` (`app.ts:~100`: `replier: this.replier`),
not the terminal-aware router.

---

## 3. Send / receive sequences

### 3.1 Answering an existing Conductor chat

Entry points that reach it: Mac window (`POST /control/session/<chat id>/reply`),
Telegram reply/letter tap, phone command, Cliq tap. All end at
`ConductorReplier.send(sessionId, text, onFailed)` (`session-reply.ts:161`);
the Mac and Telegram go through `FleetReplyRouter.send`, which passes a
non-`:` target straight to it (`reply-router.ts:send`).

```
Surface        FleetReplyRouter   ConductorReplier            Relay (loopback)        Squeak Hands          claude/codex          conductor.db
 |  reply(id,t)     |                    |                           |                      |                      |                      |
 |----------------->| id has no ":"      |                           |                      |                      |                      |
 |                  |------------------->| t = text.trim(); empty -> refused                |                      |                      |
 |                  |                    |-- getSessionById ---------------------------------------------------------------------->|
 |                  |                    |<- status, workspaceId, claudeSessionId, agentType, model ------------------------------|
 |                  |                    | status needs_user_input / needs_plan_response -> REFUSED (both routes)                   |
 |                  |                    |                                                                                          |
 |                  |                    | ROUTE 1: relay?.isReady() && !isReplying                                                 |
 |                  |                    |--- sendChatMessage(ws,sid,t, mode:"queue") -->|  (GET queue generation, POST send)       |
 |                  |                    |<-- HTTP 2xx -> return {started, via:"conductor"}  [no busy check, no confirm read]        |
 |                  |                    |<-- error/non-2xx -> log, FALL THROUGH                                                    |
 |                  |                    |                                                                                          |
 |                  |                    | ROUTE 2: ui != null && !isReplying   (Hands path configured)                             |
 |                  |                    | startedAt = now                                                                          |
 |                  |                    |--- open -W -n Squeak Hands.app send req.json -->|                                       |
 |                  |                    |       Hands: AX focus Conductor, select workspace+tab, verify AXURL route                |
 |                  |                    |       names sessionId, refuse over a draft, paste, press Enter                           |
 |                  |                    |<-- result.json {ok} -> {started, via:"conductor"}                                        |
 |                  |                    |<-- {ok:false,error}:                                                                     |
 |                  |                    |     error in (unconfirmed, helper-failed)  == mayHaveSent                                 |
 |                  |                    |        poll listSessionMessages(10) every 500ms up to 6s for a role=user row with        |
 |                  |                    |        identical text and sentAt >= startedAt  --------------------------------------->|
 |                  |                    |        found -> started via conductor                                                    |
 |                  |                    |        not found -> REFUSED "typed it but could not confirm" (NEVER falls to route 3)    |
 |                  |                    |     any other error (locked, no-window, chat-not-open, draft-present, not-trusted,       |
 |                  |                    |        helper-missing, ...) == nothing typed -> remember fallbackReason, FALL THROUGH     |
 |                  |                    |                                                                                          |
 |                  |                    | ROUTE 3: background                                                                      |
 |                  |                    | guards: agentType in {claude,codex}; claudeSessionId present; not already replying;      |
 |                  |                    |   busyReason(status) (working, cancelling, waiting) -> REFUSED; workspace path resolves   |
 |                  |                    |-- adapter.resumeThread + startTurn(input) (bypassPermissions / approvals off) ---------->|
 |                  |                    |-- mirror.updateSessionStatus("working"); appendUserMessage ------------------------------>| WRITE
 |                  |                    |<- notifications item/completed -> mirror.appendAssistantMessage ------------------------->| WRITE
 |                  |                    |<- turn/completed -> status idle (or error + onFailed callback) --------------------------->| WRITE
 |<-----------------| ReplyOutcome {started via:"background", fallbackReason}                                                      |
```

Facts to carry into a port:

- **Order is relay, Hands window typing, background CLI**
  (`session-reply.ts:177-283`). `CLAUDE.md` describes only the last two.
- The relay route returns success on any 2xx and does not check whether the
  chat is `working`; it uses `mode: "queue"` (`service.ts:60-69`) and relies on
  Conductor's own pending-message queue. The Hands route has no busy check in
  node either (only `needs_user_input`/`needs_plan_response` are refused before
  routes 1 and 2). Only the background route refuses `working`, `cancelling`
  and `waiting` (`busyReason`, `session-reply.ts:369`).
- A dead relay connection nulls `client` so `isReady()` flips false
  (`service.ts:73-76`).
- "No resend" rule: only `unconfirmed` and `helper-failed` mean "may have sent"
  (`conductor-ui.ts` `mayHaveSent`). Those are confirmed against Conductor's
  own `session_messages` and never retried through another route. All other
  Hands errors guarantee nothing was typed.
- Refused outcomes carry a human-readable `reason`; every surface shows it.
- Sends through Hands are serialized by a promise queue (`SqueakHandsSender.queue`).

**How the answer and status come back** (nothing is pushed from Conductor to
Squeak; Squeak polls or is told by hooks):

| Signal                                                                             | Source                                                                                                                           | Where                                                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Chat status (`idle/working/waiting/needs_user_input/...`), title, model, workspace | `sessions` and `workspaces`/`repos` rows in `conductor.db`                                                                       | `ConductorRegistryAdapter.listFleetSessions` (`conductor-registry.ts:528`); polled every `FLEET_POLL_INTERVAL_MS` (20s) |
| Whether the last turn ended and how                                                | `session_messages` rows whose content starts `{"type":"result"` / `{"type":"error"` (`aborted by user` counts as idle)           | same query, subquery at lines 556-566                                                                                   |
| The agent's reply text                                                             | `session_messages` assistant rows, newest turn only (`ConductorReplier.lastTurnText`, `session-reply.ts:127`)                    | on demand via `/control/session/<id>/message`                                                                           |
| Live blocked/finished state                                                        | Claude/Codex hooks (`PermissionRequest`, `Notification`, `Stop`, ...) POSTed to `/hook`                                          | `fleet-notify.sh` -> `hook-ingress.ts` -> `monitor.ingestHookEvent`                                                     |
| Current-turn feed                                                                  | Claude/Codex transcript JSONL, tail read                                                                                         | `activity.ts`, `/control/session/<key>/activity`                                                                        |
| Context %, cost, git, limits                                                       | `context_used_percent`; transcript token sums (`claude-cost.ts`); `git` (`git-state.ts`); Codex `rate_limits` (`codex-usage.ts`) | enriched only for sessions that will be rendered                                                                        |

Conductor does not live-reload rows written behind its back, which is the
reason routes 1 and 2 exist; route 3's exchange appears in Conductor only
after a reload.

### 3.2 Answering a terminal agent (`terminal-reply.ts`)

Target is a fleet key (contains `:`), resolved through `monitor.snapshot`
(`reply-router.ts`). If Conductor has adopted the session since, it goes
through section 3.1 instead. `TerminalReplier.send` is serialized with a queue
(one keyboard).

```
Surface   Router     TerminalReplier (node)              process table / ~/.claude/sessions        Squeak Hands (Swift)         Terminal.app        transcript
 |reply(key,t)|           |                                       |                                         |                          |                  |
 |----------->| resolve   |                                       |                                         |                          |                  |
 |            |---------->| sanitizeTerminalText(t) (strip control chars; empty -> refuse)                   |                          |                  |
 |            |           | origin==terminal, transcriptPath present                                          |                          |                  |
 |            |           | codex: state must be finished/idle (no status file exists)                        |                          |                  |
 |            |           |-- locateAgentProcess ---------------->|  claude: ~/.claude/sessions/<pid>.json   |                          |                  |
 |            |           |                                       |   sessionId + status + procStart (UTC)   |                          |                  |
 |            |           |                                       |   vs `TZ=UTC ps -o lstart` (pid-reuse)   |                          |                  |
 |            |           |                                       |  codex: the one TUI with that cwd        |                          |                  |
 |            |           |<- pid, tty, pgid==tpgid, host app (ancestry), claudeStatus                         |                          |                  |
 |            |           | host must be Terminal.app (iTerm/tmux/ssh refused by name)                       |                          |                  |
 |            |           | claude status must be "idle" (busy / waiting: permission prompt -> refuse)        |                          |                  |
 |            |           |-- terminal-read {tty} ----------------------------------------------------------->| find the ONE tab on /dev/<tty>                      |
 |            |           |                                                                                    | (0 -> no-tab, >1 -> ambiguous-tab)                  |
 |            |           |                                                                                    |--- contents of tab ------>|                  |
 |            |           |<-- {contents, sha256} -----------------------------------------------------------|                          |                  |
 |            |           | promptState(agent, contents): ready | draft | not-at-prompt  (draft/not-at-prompt -> refuse)   |                  |
 |            |           | codex only: last message from transcript must be visible on that screen (screenShowsMessage)     |                  |
 |            |           |-- locateAgentProcess AGAIN; pid and tty must be unchanged; claude still idle                      |                  |
 |            |           | since = now - 1s                                                                                   |                  |
 |            |           |-- terminal-type {tty, text, expectSha256} --------------------------------------->| sha256(screen) == expected else screen-changed     |
 |            |           |                                                                                    | `ps -t tty -o pgid=,tpgid=,comm=`: a row with        |
 |            |           |                                                                                    |  pgid==tpgid and comm claude|codex else not-agent-foreground |
 |            |           |                                                                                    |--- do script ESC[200~ text ESC[201~ in tab -->|       |
 |            |           |<-- {ok} (or {error}; error other than helper-failed -> REFUSED, nothing typed)    |                          |                  |
 |            |           | confirm: poll transcript tail every 500ms up to 10s for a user entry == text, ts >= since   -------------->|
 |<-----------|<----------| found -> {started, via:"terminal"}; else REFUSED "check that terminal before sending again" (never retyped)
```

Safety checks and why they exist (each was a real failure; see
`terminal-screen.ts` header and `CLAUDE.md`):

- Only Claude `idle` is typed into; `procStart` is UTC, `ps lstart` local,
  hence `TZ=UTC`.
- Agent must own the tty foreground (`pgid == tpgid`), checked in node and again
  by Hands right before typing, so text can never be aimed at a shell.
- Screen must show the agent's own empty prompt. Claude: a `❯` line between two
  `─{20,}` rules; known placeholders (`Try "..."`, Codex's two) count as empty;
  anything else is a draft and refused (`terminal-screen.ts:38-108`).
- Screen hash must be unchanged between approve and type (TOCTOU).
- Bracketed paste keeps multi-line replies as one message; `do script` adds the Enter.
- Confirmation is from the transcript only (Claude `user` entry; Codex
  `response_item` message role `user`).
- Apple Events go from Hands to Terminal; a `-1743` error maps to
  `not-authorized`.
- No failure callback: the turn runs in the terminal and the fleet reports its end.

---

## 4. Data and secrets

### 4.1 Read / written, by location

| Location                                                                | Owner                         | Squeak access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Notes                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `~/Library/Application Support/com.conductor.app/conductor.db` (SQLite) | Conductor                     | **Opened read-write** by `ConductorRegistryAdapter` (`conductor-registry.ts:114`, `busy_timeout 5000`). Writes: `sessions.status`, `sessions.last_user_message_at`, `workspaces.active_session_id` (`:766-802`), inserts into `session_messages` (mirror, `:1107`). `createSession`/`createWorkspace` exist (`:834`, `:899`) but nothing outside the registry and its test calls them. Relay service opens it read-only to read the `settings` override (`service.ts:159`). `scripts/conductor-relay.ts setup/reset` writes `settings` | Tables read: `sessions`, `session_messages`, `workspaces`, `repos`, `settings`                               |
| `~/Library/Application Support/com.conductor.app/bin/{claude,codex}`    | Conductor                     | Executed for background replies (`CLAUDE_BIN`, `CODEX_BIN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                              |
| `~/.claude/projects/**/*.jsonl`                                         | Claude Code                   | Read (tail 256KB for state; whole file for cost, 16MB cap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                                              |
| `~/.claude/sessions/<pid>.json`                                         | Claude Code                   | Read (pid/session/status for terminal replies)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                              |
| `~/.claude/settings.json`                                               | Claude Code / user            | **Merged into** by `install-hooks` (backup `settings.json.squeak.bak`); uninstall removes only entries naming `fleet-notify.sh` (`hook-install.ts`)                                                                                                                                                                                                                                                                                                                                                                                    | Shared with other tools                                                                                      |
| `~/.codex/hooks.json`, Codex rollout files, `state_5.sqlite` area       | Codex                         | Hooks merged; rollouts read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                              |
| `~/Library/Application Support/Claude/local-agent-mode-sessions/...`    | Claude Desktop (Cowork)       | Read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                              |
| `~/Library/Application Support/squeak/.env` (0600)                      | Squeak                        | Read at start; written by `setup`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Telegram token, chat ids, Cliq secrets, `SQUEAK_REMOTE_PROJECT`, paths, ports                                |
| `.../squeak/hook-token` (0600)                                          | Squeak                        | Written by daemon/`install-hooks`; read by hook script (`cat`) and by the Electron main process                                                                                                                                                                                                                                                                                                                                                                                                                                        | The only gate on `/control/*` and `/hook`                                                                    |
| `.../squeak/hooks/fleet-notify.sh`                                      | Squeak                        | Written by `install-hooks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Backgrounds curl, 2s cap, always exit 0                                                                      |
| `.../squeak/squeak.db` (+ wal/shm)                                      | Squeak                        | Fleet state: aliases for callback data, reply targets (`fleet_reply_target`), snooze                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                              |
| `.../squeak/conductor-relay.json` (0600)                                | Squeak                        | Device credentials (`deviceId`, raw `deviceToken`) and the pinned host static public key                                                                                                                                                                                                                                                                                                                                                                                                                                               | Written by the relay CLI; host key re-persisted by the service (`service.ts:180`)                            |
| `.../squeak/remote.json` (0600)                                         | Squeak                        | Phone channel: `projectId`, `channelId`, `key` (symmetric channel key), paired devices                                                                                                                                                                                                                                                                                                                                                                                                                                                 | See `docs/remote-channel.md`                                                                                 |
| `.../squeak/claude-limits.json`                                         | Squeak                        | Last rate-limit event the assistant's `claude` run reported                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                              |
| `.../squeak/Squeak Hands.app`                                           | Squeak                        | Built bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Path from `SQUEAK_HANDS_APP`; the value `off` disables Hands and with it terminal replies (`config.ts:~176`) |
| `.../squeak/desktop/`                                                   | Electron                      | userData, single-instance lock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                              |
| `.../squeak/assistant/`, `repo-icon.png`, `cliq-handlers.txt`           | Squeak                        | Working files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                              |
| `~/Library/Logs/squeak/{squeak,duck}.log`                               | launchd                       | stdout/stderr                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                              |
| `~/Library/LaunchAgents/com.squeak.{daemon,duck}.plist`                 | Squeak                        | Written by installer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Node path and repo path baked in                                                                             |
| `/tmp/squeak-hands-\*/request.json                                      | result.json` (0600, per call) | Squeak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Hands IPC; removed after each call                                                                           | Reply text transits here |
| Workspaces under `~/conductor/workspaces/**`                            | Conductor                     | `git` reads for diffstat, base-branch diff, unpushed count                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                                              |

### 4.2 Keychain

- **Written by Squeak:** one item in the login keychain, service
  `com.conductor.app.production.settings`, account
  `desktop_relay_paired_devices`, via `security add-generic-password -U -A`
  (`scripts/conductor-relay.ts:128-155`). It belongs to Conductor's settings
  namespace: Squeak is adding itself to Conductor's own paired-device list. The
  `-U` update **replaces the whole value**, so if Conductor has other paired
  devices in that item, this call overwrites the list with only the Squeak
  record (the code builds a one-element array, no merge). `keychain-unpair`
  deletes the whole item.
- **Squeak's own secrets are not in the Keychain.** Telegram token, Cliq
  secret and relay credentials are files (`.env`, `conductor-relay.json`,
  `remote.json`, all 0600). The iPhone app keeps its keys in the iOS Keychain
  and Secure Enclave (`ios/SqueakCore/Sources/SqueakUI/KeyStore.swift`).

### 4.3 Token handling summary

| Secret                        | Created by                              | Stored                                                              | Sent where                                                                                                            |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Hook/control token            | Daemon on first start (24 random bytes) | `hook-token` 0600                                                   | `x-squeak-token` header over loopback HTTP, from the hook script and the Electron main process. Never to the renderer |
| Telegram bot token            | User (BotFather)                        | `.env`                                                              | Telegram API                                                                                                          |
| Remote channel key            | `generateChannel`                       | `remote.json`; QR code shown only as an image from the main process | Phone, via QR                                                                                                         |
| Conductor device token        | `keychain-pair`                         | raw in `conductor-relay.json`, SHA-256 in Keychain                  | Inside the relay's encrypted session                                                                                  |
| Cliq HMAC secret              | `squeak cliq-relay`                     | `.env` and the Deluge handlers                                      | Signs relay records                                                                                                   |
| Conductor cloud bearer tokens | Conductor                               | In Conductor                                                        | Transit Squeak's proxy in clear on loopback while the override is set (not stored by Squeak)                          |

---

## 5. Dependencies and security notes

### 5.1 Dependencies

- Daemon runtime: `better-sqlite3` (native; ABI-tied to the Node that ran
  `npm install`), `zod`. Everything else is Node builtins, including all relay
  and phone-channel crypto.
- Dev: `typescript`, `vitest`, `eslint` + `typescript-eslint`, `prettier`,
  `tsx`. `engines.node >= 22`.
- Desktop: Electron ^35 (must stay >= 35.1.3; transparent small windows
  render opaque white on <= 34), `qrcode`. Its own `package-lock.json` and
  ESLint config (`desktop/eslint.config.mjs`).
- External services: Telegram Bot API; Zoho Cliq API; Firebase (Firestore REST
  on project `squeak-5c9gvo`, Hosting); `heresay-sibhi-42b1.web.app` (SDK script
  in the window); `api.conductor.build` (proxied, not called by Squeak itself).
- Local binaries Squeak shells out to: `claude`, `codex` (Conductor's copies by
  default), `git`, `ps`, `curl` (inside hook script), `launchctl`, `open`,
  `security`, `swiftc` and `codesign` (build-time), `plutil`.
- iOS: no third-party packages in `SqueakCore` (CryptoKit, Security).

### 5.2 macOS permissions

| Permission                 | Held by                               | Used for                                                                                                                                                                                 |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accessibility              | Squeak Hands (not node, not Electron) | Driving Conductor's window (`send`, `press`, `choose-file`, "Open in Conductor")                                                                                                         |
| Automation of Terminal.app | Squeak Hands                          | `terminal-read`, `terminal-type` via `NSAppleScript` (`NSAppleEventsUsageDescription` in the bundle)                                                                                     |
| Full Disk Access           | Not required by code                  | Reading `~/Library/Application Support/Claude` and Conductor's db works under the user's own account today; worth re-verifying under App Sandbox-less but hardened-runtime native builds |
| Login item                 | launchd agents                        | Start at login (not `SMAppService`)                                                                                                                                                      |
| Screen Recording           | Not used                              | Captures use Electron's own `capturePage`                                                                                                                                                |

### 5.3 Security observations

1. **`/state` is unauthenticated with `Access-Control-Allow-Origin: *`**
   (`hook-ingress.ts:131,326`). Any web page in any browser tab can `fetch`
   `127.0.0.1:8477/state` and read session titles, repo names, branches, working
   directories, summaries, reply targets and Conductor ids. There is also no
   `Host` check, so a DNS-rebinding page gets the same read. `CLAUDE.md`
   acknowledges the CORS part. `/state` also leaks `replyTarget` values, which
   are the identifiers the token-gated routes take.
2. `/control/*` is correctly token-gated, has no CORS header, and rejects before
   routing. The token is a long-lived static secret in a 0600 file, readable by
   any process running as the user (same trust boundary as `~/.claude`).
   `POST /control/session/<id>/reply` is effectively "type into any agent":
   anyone with the token can drive Conductor chats and terminal agents.
3. `/hook` and `/state` match by `startsWith`, so `/statefoo` and `/hookbar`
   are accepted.
4. **The Conductor relay is invasive by design.** It requires editing
   Conductor's settings table, adds Squeak to Conductor's paired-device
   Keychain item with `-A` (readable by any app), and puts a local proxy in the
   path of all Conductor cloud traffic including bearer tokens and
   WebSockets. It depends on an undocumented Conductor feature
   (`roundhouse_client_url_override`) and a reverse-engineered protocol
   (`protocol version 2`); a Conductor update can break it without notice.
   See `.context/re/roundhouse-override-blast-radius.md` and
   `relay-redirect-feasibility.md`.
5. The registry opens Conductor's database read-write for the whole life of the
   daemon, and writes into `session_messages` using Conductor's exact envelope
   shape (wrong shapes render as "This message could not be displayed"). The
   schema is not under Squeak's control.
6. Background replies run `claude -p --resume` with `bypassPermissions` and
   Codex with approvals off (`adapters/claude-code.ts`, `codex-app-server.ts`).
7. The Heresay script is remote code loaded into the window (CSP restricts it
   to one origin). The renderer otherwise has no token, shell or URL, and
   agent text is rendered with `textContent` only.
8. Firestore access for the phone channel and Cliq is unauthenticated REST,
   guarded by unguessable ids plus end-to-end encryption/signatures on the Mac
   side (documented in `docs/remote-channel.md`). A native rewrite must keep
   verifying signatures on the Mac.
9. Hands IPC puts reply text in `/tmp` request files (0600, mkdtemp 0700,
   deleted afterwards).

---

## 6. Setup pain points today

What a new user must do, all in a terminal, in roughly this order:

1. Install Node 22 (not Homebrew's v26, ABI 147) and run `npm install`. If
   `/opt/homebrew/bin/node` is first on PATH, `better-sqlite3` is built for the
   wrong ABI and the daemon dies at startup with `NODE_MODULE_VERSION`;
   fix is `npm rebuild better-sqlite3`. The same pitfall applies to the node
   path baked into the plist.
2. `npm run build` (only safe outside the live checkout), or `ship.sh`, since the
   installer refuses without `dist/squeak/cli.js`.
3. Create a Telegram bot with BotFather, then `squeak setup` (needs a TTY) or
   hand-edit `.env`. **Telegram is mandatory** even for someone who only wants
   the Mac app.
4. `squeak install-hooks`, which edits `~/.claude/settings.json` and
   `~/.codex/hooks.json`. Agents already running do not pick up new hooks.
5. `helpers/squeak-hands/build.sh ~/Library/Application\ Support/squeak`
   (needs Xcode command line tools and a codesigning identity or the grant is
   lost on every rebuild), then grant **Accessibility** and, for terminal
   replies, **Automation > Terminal** in System Settings. `ship.sh` does not
   rebuild Hands; an old Hands answers new modes with nothing.
6. `cd desktop && npm install`, then `scripts/build-squeak-app.sh` (copies
   Electron, signs, writes the bundle loader).
7. `scripts/install-squeak-agents.sh` for the two launch agents.
8. For live replies without the screen: the relay. Four manual steps:
   `tsx scripts/conductor-relay.ts setup --port N` (writes Conductor's db),
   `keychain-pair` (writes the Keychain), **quit and reopen Conductor**, then
   the daemon binds the port. Nothing in the app shows whether the relay is
   inert, listening or authenticated; the only signal is a log line
   (`conductor relay inert: ...`, `service.ts:84,89`).
9. For the phone: create a Firebase project, `SQUEAK_REMOTE_PROJECT`, deploy
   `firestore.rules`, build and sideload the iOS app via SideStore.
10. For Cliq: Deluge handlers pasted in by hand (`cliq-handlers.txt`), then
    `squeak cliq-relay`.

Structural pain points beyond the step list:

- Squeak lives inside a git checkout. `Squeak.app` is Electron plus a loader
  that `require`s the main checkout's `desktop/main.js`; launch agents point at
  the checkout's `dist`. There is no installable artifact: moving or deleting
  the checkout breaks login startup (`scripts/move-checkout.sh` exists for it).
- Code and live process are tied by `ship.sh`, which merges branches into the
  main checkout and restarts launchd jobs.
- Two long-lived processes (Node daemon + Electron) with a token-file handshake
  and a launchctl-based "restart service" button.
- Permissions are held by a third helper app that is launched via `open -W`
  with JSON files in `/tmp`; every send is a process launch (seconds).
- Failures are mostly logs (`~/Library/Logs/squeak/`).

---

## 7. Preserve vs rewrite (for a native Swift app)

### 7.1 Preserve: port the logic, ideally with its tests as the spec

Test fixtures and `*.test.ts` files next to each module are the executable spec.
Port the test cases, not just the code.

| Module                                                                                                                                | Why it is hard-won                                                                                                                                                                        | Port notes                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/fleet/conductor-relay/crypto.ts`, `phone.ts`, `pairing.ts`, `ws.ts`                                                              | Reimplementation of Conductor's E2E tunnel: X25519 x2, HKDF labels, XChaCha20-Poly1305, framing, pair/auth, request/response reassembly, generation-retry send                            | Swift has CryptoKit: X25519, HKDF, ChaChaPoly (12-byte nonce) available, so HChaCha20 must still be hand-written; reuse `crypto.test.ts` vectors. Replace the hand-written WebSocket server with `Network.framework`. Keep the proxy logic (`proxy.ts`) or find a way to drop it (see 7.4). Spec only in gitignored `.context/re/` — copy it into `docs/` first |
| `src/fleet/terminal-screen.ts` (+ `fixtures/screens/`)                                                                                | Prompt-shape detection from real screens of Claude 2.1.281, Codex 0.149.1; Codex update picker offers `curl                                                                               | sh`                                                                                                                                                                                                                                                                                                                                                             | Port verbatim, including the "unknown means draft means refuse" bias and fixtures |
| `src/fleet/terminal-process.ts`                                                                                                       | `~/.claude/sessions/<pid>.json` link, UTC `procStart` vs `TZ=UTC ps`, pid-reuse, Codex one-TUI-per-cwd, tty foreground (`pgid==tpgid`), host-app ancestry                                 | In Swift use `sysctl`/`proc_pidinfo` or keep calling `ps`; preserve every check. Becomes simpler when the same app holds the grant                                                                                                                                                                                                                              |
| `src/fleet/terminal-reply.ts`                                                                                                         | The full send protocol and transcript-based confirmation, no-retype rule, two-phase process check                                                                                         | Port as an actor (replaces the promise queue)                                                                                                                                                                                                                                                                                                                   |
| `helpers/squeak-hands/main.swift`                                                                                                     | Already Swift: AX navigation, AXURL route proof of which chat is on screen, draft refusal, Terminal tab-by-tty script, sha256 gate, foreground check                                      | Fold into the app target. Caveat: the TCC grants then belong to the main app, which is a larger blast radius; see 7.4                                                                                                                                                                                                                                           |
| `src/fleet/session-reply.ts` (`ConductorReplier`)                                                                                     | Route order and the "may have sent" confirmation rule; `busyReason`; `lastTurnText` newest-turn-only logic                                                                                | Port the decision logic. Background route needs `claude -p --resume` + mirror; decide whether to keep it                                                                                                                                                                                                                                                        |
| `src/fleet/conductor-ui.ts`                                                                                                           | Error taxonomy (`UiSendError`), which are "nothing typed" vs "may have sent"                                                                                                              | Becomes in-process calls, but keep the taxonomy                                                                                                                                                                                                                                                                                                                 |
| `src/fleet/active.ts`                                                                                                                 | The one definition of "active" (running, blocked, finished < 15 min, quiet terminal with live process; never an idle Conductor/SDK chat on a live process)                                | Port exactly; the Telegram side (still Node) must agree, so share fixtures                                                                                                                                                                                                                                                                                      |
| `src/adapters/conductor-registry.ts` `conductorTimestampToIso`, `listFleetSessions`                                                   | Two timestamp spellings (naive UTC `datetime('now')` vs ISO), `datetime()` ordering, turn-end `result`/`error` subquery, hidden chats flagged not dropped                                 | Port the SQL and normalization with the existing tests; read-only connection in Swift                                                                                                                                                                                                                                                                           |
| `src/fleet/observers/conductor.ts`, `claude-transcript.ts`, `codex-rollout.ts`, `claude-cowork.ts`, `process-liveness.ts`, `merge.ts` | Status inference: Conductor `waiting` means working, 30s grace, stalled detection by `waitingOn`, no approval inference from files, join on agent session id                              | Large but pure; port with fixtures. Highest-risk area for regressions                                                                                                                                                                                                                                                                                           |
| `src/fleet/fleet-monitor.ts`, `attention.ts`, `radar.ts`, `duck-mood.ts`, `distinctTitles`                                            | Attention classification (a list, not a single reason), push rules, title disambiguation, duck mood derived where CI tests it                                                             | Port, or keep in Node during transition (see 7.3)                                                                                                                                                                                                                                                                                                               |
| `src/fleet/claude-cost.ts`, `claude-pricing.ts`                                                                                       | Whole-file read with `(path, mtime)` cache and 16MB cap; dedupe by `message.id` keep last (overcounted ~85% otherwise); `null` for unpriced models; Opus 5.5 / Fable 5.1 cache-read rates | Port with tests; keep the "unknown model returns null" rule                                                                                                                                                                                                                                                                                                     |
| `src/fleet/codex-usage.ts`, `claude-limits.ts`                                                                                        | `rate_limits` is a sibling of `info` on `token_count` events; limits only from live stdout of a spawned CLI                                                                               | Port as is                                                                                                                                                                                                                                                                                                                                                      |
| `src/fleet/activity.ts`, `choices.ts`, `git-state.ts`, `diff-view.ts`, `card-text.ts`                                                 | Transcript block keying (by tool id/content, not position), lettered options, base-branch diff including untracked files, `git diff --no-index` exit 1                                    | Port with fixtures                                                                                                                                                                                                                                                                                                                                              |
| `src/fleet/hook-install.ts` + `fleet-notify.sh` template                                                                              | Merge-not-overwrite of shared settings, backup, marker `squeak-fleet`, hooks never block                                                                                                  | Port; the installer could be an in-app button                                                                                                                                                                                                                                                                                                                   |
| `src/adapters/conductor-mirror.ts` + `utils/conductor-envelope.ts`                                                                    | Exact envelope Conductor accepts                                                                                                                                                          | Only if the background route survives                                                                                                                                                                                                                                                                                                                           |
| `src/remote/*` + `ios/SqueakCore`                                                                                                     | Swift and Node already agree byte-for-byte via fixtures; the Mac verifies a Secure Enclave signature, expiry, nonce, turn id                                                              | Mac side in Swift would be a natural fit (CryptoKit P-256, AES-GCM). Keep the fixture-driven interop tests (`scripts/e2e-remote.ts`, `make-mac-fixture.ts`)                                                                                                                                                                                                     |

### 7.2 Rewrite / replace (Electron UI and its plumbing)

| Component                                                          | Replace with                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `desktop/main.js`, `preload.js`, `app-preload.js`, `app-window.js` | `NSStatusItem` / `MenuBarExtra`, `NSPanel` for the duck, SwiftUI window                                            |
| `desktop/renderer/*` (HTML/CSS/JS, `duck-*.png` sprites)           | SwiftUI views; reuse the sprites, `DESIGN.md` tokens and mood mapping (`duck-mood.ts` stays the rule)              |
| `desktop/squeak-service.js` (HTTP + token file + `launchctl`)      | In-process model objects; no token, no loopback hop, no launchd restart button                                     |
| `Squeak.app` loader + `scripts/build-squeak-app.sh`                | A normal Xcode target with a stable bundle id, Developer ID signing, notarisation                                  |
| `scripts/install-squeak-agents.sh`, `ship.sh`                      | `SMAppService` login item; Sparkle or similar updates. `ship.sh` remains for the Node daemon during the transition |
| Hands as a separate process with `open -W` and `/tmp` JSON         | In-process (or XPC) calls                                                                                          |
| `qrcode` npm dependency                                            | `CIFilter.qrCodeGenerator`                                                                                         |
| Heresay web SDK in the window                                      | Heresay Swift package (`customize-apple` guide)                                                                    |
| `CORS: *` on `/state`                                              | Drop it once the duck no longer fetches from a `file://` page                                                      |

### 7.3 Can stay in the Node daemon for now

- **Telegram** (`src/telegram/`, `FleetController`, `tg-format.ts`): complete,
  tested, and owns the bot poll loop (only one process may poll).
- **Cliq** (`src/cliq/`): optional and independent.
- **Phone channel** (`src/remote/`): the iPhone app and fixtures already pin
  the protocol; leaving it in Node costs nothing until the Mac side is ported.
- **Hook ingress** if a native app is to coexist with the daemon: the hooks
  already POST to `127.0.0.1:8477`. A native app could start by being a client
  of `/state` and `/control/*` exactly as the Electron one is, then absorb
  responsibilities module by module.
- Constraint during any coexistence: **only one process may run the fleet**
  (`createFleetRuntime` binds the hook port) and only one may poll Telegram, so
  the native app must either be a client of the daemon or replace it wholesale.
- Prerequisite change worth making in Node first: make `SQUEAK_BOT_TOKEN`
  optional (`config.ts:46`) so a Mac-only install is possible at all.

### 7.4 Decisions the rewrite has to make explicitly

1. **Relay or no relay.** It is the best reply route (live, works locked) and the
   most fragile (reverse-engineered protocol, global URL override, Keychain item
   shared with Conductor). Options: keep it as an opt-in advanced feature
   with a visible status, or rely on Hands typing. If kept, fix the
   keychain overwrite (merge with existing devices) and make setup a button.
2. **TCC grant placement.** Today Accessibility and Terminal Automation sit in a
   tiny helper so a compromise of the main app or node does not inherit them.
   Merging Hands into one menu-bar app simplifies setup but widens the blast
   radius; keeping a helper (embedded login-item/XPC service) keeps the isolation.
3. **Background `claude -p --resume` route.** It exists as a last resort and
   carries `bypassPermissions`. A native app could drop it and refuse instead.
4. **Where conductor.db is written.** Decide whether the native app opens it
   read-only and drops the mirror/status writes.
5. **Auth for local control.** In-process removes the token. If the daemon
   remains, the `/state` exposure (5.3 item 1) should be closed at the same
   time, ideally by moving the duck's fetch off a `file://` origin.

---

## 8. Places where the code differs from `CLAUDE.md`

Found while writing this audit.

1. **The relay is absent from `CLAUDE.md`.** The layout table lists no
   `src/fleet/conductor-relay/` entry and `session-reply.ts` is described as
   "Conductor's window first, background CLI second". In code the order is
   relay, then window, then background (`session-reply.ts:177-283`), and
   `app.ts` constructs `ConductorRelayService` and passes it as `relay`.
2. **`CLAUDE.md` says blocked/working cards get no Reply** because the
   background fallback refuses when the chat is `working`. With the relay the
   `working`/`waiting` guard is skipped (only `needs_user_input` and
   `needs_plan_response` are refused before the relay is tried), and
   `runtime.ts:136-141` comments that replies now "work even when idle".
3. **`CLAUDE.md` says "Squeak passes `openConductorSession: null`".** True for
   the Telegram controller (`app.ts`), but the Mac app does open chats, via
   `openInConductor` and Hands `navigateOnly` (`squeak-service.js:154`).
4. **The installer does not manage the relay or Hands.**
   `install-squeak-agents.sh` handles only the daemon and the app; the relay
   setup is the standalone `scripts/conductor-relay.ts` and is undocumented in
   `README.md` (`grep relay README.md` hits only the phone channel).
5. **The phone and terminal agents.** The phone channel is given
   `this.replier`, not `this.router` (`app.ts:~100`), so a phone can answer
   Conductor chats but not terminal agents, while Telegram, Cliq and the Mac
   window can.
6. **`firestore-rest.ts` says "a package published to npm"**, but
   `package.json` is `private` and `CLAUDE.md` says nothing is published.
   Stale comment only.
7. **`ConductorRegistryAdapter` exposes `createSession` and `createWorkspace`**
   (`conductor-registry.ts:834,899`) that no production code calls. Remnants
   of the earlier "bridge" product; dead write paths into Conductor's database.
8. **Duplicate comment block** in `install-squeak-agents.sh:23-28` (the
   keep-alive explanation appears twice). Cosmetic.
9. `scripts/conductor-relay.ts` `keychain-pair` overwrites the entire
   `desktop_relay_paired_devices` item with a one-element array (4.2). The
   code comment calls it "harmless and reversible"; that holds only if no other
   device was paired in Conductor.
