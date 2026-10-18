# Squeak 2.0 (native macOS app)

Squeak 2.0 is a native SwiftUI/AppKit menu-bar app (`LSUIElement`, bundle id
`com.squeak.mac`, macOS 14+, Swift 6, no third-party dependencies). It is a
separate Swift package; the Node daemon and the Electron app in `desktop/` are
untouched by it.

## What it is

A bridge to your existing Conductor chats. It lists the sessions that are
already running on your Mac, shows a chat's messages, and sends a message into
one of those chats from the menu-bar popover, a conversation window, or a global
quick-composer hot key. It also notifies you when a session needs you or
finishes.

There is no AI inside Squeak. It does not generate text, summarise, or run an
agent. Every reply you read was written by the agent in your Conductor chat;
every message you send goes to that chat.

## Status

Be clear about what has and has not been checked.

Built and unit tested (`swift test`, about 80 test cases):

- Core model: session keys, capabilities, messages.
- Daemon client and the Conductor adapter (against a stubbed transport).
- Broker: catalog, polling, send correlation, reconciliation.
- Encrypted cache and drafts (in-memory key store, never the real Keychain).
- Policies: session ordering, search, notification wording.
- Relay port (`Relay/`): crypto against shared fixtures, pairing, proxy, server.

Only smoke-run (launched, screenshots taken with `SQUEAK_MAC_CAPTURE`):

- The popover and conversation window layout, light and dark.

Untested:

- Interactive keyboard behaviour (including Cmd+Return to send).
- The global hot key, macOS notifications, and the onboarding flow.
- A live send from the native app. This was deliberately never exercised: no
  message was sent into a real Conductor chat from this app.
- Two-session isolation (a send to chat A never lands in chat B). This is
  section 7.1 of `docs/conductor-local-feasibility.md` and is pending for the
  owner, along with the other owner steps in section 7 (relaunch, restart,
  sleep/wake, disconnect).

The release zip is ad-hoc signed and not notarized.

## Architecture

```
macos/Sources/
  SqueakMacCore/   no SwiftUI; everything here is testable
    Model/         HostSession, SessionKey, Capability(ies), ChatMessage
    Adapters/      HostAdapter protocol, DaemonClient, DaemonModels,
                   HTTPTransport, ConductorDaemonAdapter
    Broker/        Broker actor + BrokerClock
    Storage/       KeyStore (+ Keychain), EncryptedCache, DraftStore
    Policy/        SessionOrdering, SearchIndex, NotificationPolicy
    Relay/         Swift port of src/fleet/conductor-relay (not wired in)
  SqueakMac/       App, AppModel, PopoverView, ConversationWindow,
                   QuickComposer, ComposerField, SettingsView, Onboarding,
                   HotKey (Carbon), Theme, Components, System, Capture
```

- `SessionKey` identifies a session by provider, installation and host session
  id. Sessions are never merged by title.
- `Capability` per action (discover, read transcript, send, activity, approve,
  open in host, attachments) is `supported`, `unsupported(reason)` or
  `unknown`; the UI disables what is unsupported and shows the reason.
- `HostAdapter` is the contract a source implements: discover, transcript,
  activity, send, open-in-host URL, health.
- `Broker` is an actor. It owns the catalog, polls the adapters, correlates
  each send with the message that later appears, reconciles, and publishes
  events as an `AsyncStream`.

### Step 1 (what runs today): the daemon's control routes

`ConductorDaemonAdapter` talks to the existing Squeak daemon on loopback
(`127.0.0.1:8477` by default; override with `SQUEAK_DAEMON_PORT`). It reads
`/state` for the session list and uses the token-gated `/control/session/...`
routes (message, reply, activity) with the daemon's token file. The daemon is
what actually delivers the reply to Conductor.

Reading a transcript uses a new route, `/control/session/<id>/transcript`.
It exists only in this branch, so it works only after the daemon is shipped
(`./scripts/ship.sh`, which is the owner's call). Against an older daemon the
client gets a 404 and reports no transcript.

### Step 2 (written and tested, not wired in): the Swift relay

`Relay/` is a Swift port of the Node relay in `src/fleet/conductor-relay/`:
`RelayCrypto`, `RelayPairing`, `RelayProxy`, `RelayServer` (HTTP and
WebSocket), `RelayPhoneClient`, `RelaySessions`, and `RelayService`. It is
checked against fixtures generated from the Node code
(`scripts/make-relay-fixtures.ts`, `Tests/.../Fixtures/relay-vectors.json`).

It is not used by the app. The daemon's relay service currently owns the local
relay port (8788), and only one process can bind it. `RelayService` is inert
unless Conductor's override URL is `http://127.0.0.1:<port>` and credentials are
present, and it retries a held port rather than failing.

Cutover plan (not done):

1. Stop the daemon's conductor-relay service, so the port is free.
2. Point `RelayService` at the same port and config (the override URL and device
   credentials the Node service uses today).
3. Add a `RelayAdapter` implementing `HostAdapter` on top of it, and register it
   in `AppModel` in place of `ConductorDaemonAdapter` for Conductor.
4. Run the section 7 checks from the feasibility doc before relying on it.

The transport choice and its caveats (undocumented, changes one Conductor
setting and one Keychain item, reversible) are in
`docs/conductor-local-feasibility.md`.

## Build and run

From `macos/`:

```bash
swift build
swift test
swift run SqueakMac            # needs the daemon running for real data
./scripts/build-app.sh         # release, arm64
```

`scripts/build-app.sh` writes only inside `macos/build/`: `Squeak.app`
(ad-hoc signed, icon taken from `desktop/build/squeak.icns` if present),
`Squeak-2.0.0.zip` and `Squeak-2.0.0.zip.sha256`. It installs nothing and makes
no DMG.

Environment variables:

| variable | effect |
| --- | --- |
| `SQUEAK_DAEMON_PORT` | daemon port to talk to instead of 8477 |
| `SQUEAK_MAC_CAPTURE=<prefix>` | open the conversation window, save screenshots with that prefix, quit; uses no real Keychain or cache |
| `SQUEAK_MAC_APPEARANCE=light` | with capture, force light appearance (otherwise dark) |

## Install (for users)

The build is unsigned by Apple (ad-hoc signature only) and not notarized, so
Gatekeeper will warn the first time.

1. Check the download against its checksum file:

   ```bash
   shasum -a 256 Squeak-2.0.0.zip
   ```

   The output must match the contents of `Squeak-2.0.0.zip.sha256`.
2. Unzip and move `Squeak.app` to Applications (or `~/Applications`).
3. Right-click the app and choose Open, then Open again in the dialog. If macOS
   still blocks it, go to System Settings, Privacy & Security, and choose
   "Open Anyway" next to the Squeak message.
4. Squeak has no Dock icon; look for it in the menu bar.

It needs the Squeak daemon running on the same Mac (step 1 above).

## Privacy and data

- Messages the app has seen are cached in one encrypted file,
  `~/Library/Application Support/Squeak Mac/cache.squeak` (directory mode 0700).
- The cache key is stored in the Keychain under the service `com.squeak.mac`
  (account `cache-key`).
- Messages expire after 14 days and the cache is capped at 50 MB.
  Settings has a "Delete cache" button that purges it; Squeak rebuilds it as you
  open conversations.
- Notifications are private by default: they say a session needs you or has
  finished, and show session names only if you turn on "Show session names in
  notifications". They never carry message content.
- The app as wired today talks only to the local daemon on loopback. Once the
  Swift relay is cut over, it also proxies Conductor's own cloud traffic to
  `api.conductor.build` (the redirect is global, as with the daemon's relay);
  Squeak adds nothing of its own to that traffic.
- Search runs in memory over cached messages.

## Migration from Electron

Squeak 2.0 replaces the Electron window and duck for the Conductor use case. It
does not yet replace the daemon. Staying in Node for now:

- Telegram bot and Cliq bridge
- the phone (iPhone) channel and its Firestore relay
- agent hooks and the hook ingress
- the fleet monitor (observers, attention rules, `/state`)
- Squeak Hands and terminal replies

Next steps:

1. Ship the daemon so `/transcript` exists, then run the app against it.
2. Owner runs the feasibility doc section 7 tests, starting with 7.1
   two-session isolation, and a first supervised live send from the native app.
3. Exercise the untested UI: keyboard, hot key, notifications, onboarding.
4. Cut over to the Swift relay (plan above) and add `RelayAdapter`.
5. Sign with a Developer ID and notarize, if wider distribution is wanted.
6. Decide the fate of `desktop/` once the native app covers its use, and move
   the remaining channels out of Node only if there is a reason to.
