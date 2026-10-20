# Squeak 2.0 (native macOS app)

Squeak 2.0 is a native SwiftUI/AppKit menu-bar app (`LSUIElement`, bundle id
`com.squeak.mac`, macOS 14+, Swift 6, one dependency: Sparkle 2 for updates). It is a
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

Built and unit tested (`swift test`, about 120 test cases):

- Core model: session keys, capabilities, messages.
- Daemon client and adapter, the local Conductor reader and `DaemonSender`
  (against fixture databases and a stubbed transport).
- Safe Markdown parser (`MessageMarkup`), including a 200 KB speed check.
- Diagnostics redaction and Connections report.
- Broker: catalog, polling, send correlation, reconciliation.
- Encrypted cache and drafts (in-memory key store, never the real Keychain).
- Policies: session ordering, search, notification wording.
- Relay port (`Relay/`): crypto against shared fixtures, pairing, proxy, server.

Only smoke-run (launched, screenshots taken with `SQUEAK_MAC_CAPTURE`):

- The popover, conversation window and a Markdown sample, light and dark.
  Settings (Connections, About) is not in the captures.

Untested:

- Interactive keyboard behaviour (including Cmd+Return to send).
- The global hot key, macOS notifications, and the onboarding flow.
- A live send from the native app (`DaemonSender` POSTing to the daemon's
  `/reply`). This was deliberately never exercised: no
  message was sent into a real Conductor chat from this app.
- Two-session isolation (a send to chat A never lands in chat B). This is
  section 7.1 of `docs/conductor-local-feasibility.md` and is pending for the
  owner, along with the other owner steps in section 7 (relaunch, restart,
  sleep/wake, disconnect).

Settings has Channels and iPhone tabs: Telegram bot token and allowed chats, Zoho Cliq
webhook and owner, and iPhone pairing (QR, approve, disconnect). They write the daemon's
`.env` (0600, `EnvFile`), restart the service with `launchctl kickstart`, and need the
daemon's `/control/channels` and `/control/telegram/*` routes (older daemons read as "update
the Squeak service"). Only smoke-run with demo data; no real token was entered, no test
message sent, no phone paired.

The Conductor relay is set up only through the terminal CLI; the app has no relay
setup UI. The Swift relay is written but not wired in. Sparkle updates have
not yet been exercised end to end against a published appcast (see Updates).

The release zip is ad-hoc signed and not notarized.

## Architecture

```
macos/Sources/
  SqueakMacCore/   no SwiftUI; everything here is testable
    Model/         HostSession, SessionKey, Capability(ies), ChatMessage
    Adapters/      HostAdapter protocol, DaemonClient, DaemonModels,
                   HTTPTransport, ConductorDaemonAdapter, DaemonSender,
                   ConductorSources
    Conductor/     ConductorLocalAdapter, ConductorDatabase (read-only SQLite),
                   ConductorRegistry, ClaudeActivityReader, ConductorText/Time
    Support/       ConnectionsReport, Diagnostics, MessageMarkup
    Broker/        Broker actor + BrokerClock
    Storage/       KeyStore (FileKeyStore), EncryptedCache, DraftStore
    Policy/        SessionOrdering, SearchIndex, NotificationPolicy
    Relay/         Swift port of src/fleet/conductor-relay (not wired in)
  SqueakMac/       App, AppModel, PopoverView, ConversationWindow,
                   QuickComposer, ComposerField, SettingsView, Onboarding,
                   HotKey (Carbon), Theme, Components, System, Capture, Updater (Sparkle),
                   ActivationPolicy (Dock icon while a window is open),
                   MarkdownView, AppLog
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

### Step 1 (what runs today): local reader plus the daemon

- **Conductor** is read by `ConductorLocalAdapter`: Conductor's own SQLite
  database opened read-only, plus Claude's transcripts for the activity feed.
  The session list, a chat's full history and activity work with no Squeak
  service running. Nothing is ever written to `conductor.db`.
- **Sending** to a Conductor chat goes through `DaemonSender`, which POSTs the
  daemon's token-gated `/control/session/<id>/reply`. The daemon types the
  message into Conductor's window. If the daemon is down or its token is
  missing, sending is disabled and Settings says why.
- **`ConductorDaemonAdapter`** (the daemon on `127.0.0.1:8477`; override with
  `SQUEAK_DAEMON_PORT`) keeps serving terminal and desktop sessions (Claude and
  Codex in Terminal, Claude Desktop), read from `/state` and the control routes.
  It reads a transcript through `/control/session/<id>/transcript`, which exists
  only after the daemon is shipped (`./scripts/ship.sh`, the owner's call); an
  older daemon answers 404 and the app reports no transcript.

Settings has a Connections tab with one row per source: Conductor database
(readable or not), Squeak service (connected, down, token missing, trouble) and
Sending (available or why not). About has "Copy diagnostics", which is redacted
(no message text, titles, paths, ids, tokens or URLs), "Check for Updates…" and
the "Automatically check for updates" switch (see Updates).

### Dock icon and menus

Squeak launches as a menu-bar accessory (`LSUIElement`). While the conversation
window, Settings or Welcome is open, `ActivationPolicyController` switches the
app to `.regular` (Dock icon, Cmd-Tab, its own menu bar: app menu with About,
Check for Updates…, Settings…, Hide, Quit; Edit; Sessions; Window; Help) and
activates it. When the last of those windows closes it goes back to `.accessory`.
The popover and the quick composer are panels and never trigger it. A reopen
with no window open (Spotlight, Finder, or the activation a clicked notification
causes) shows the quick composer, never the conversation; "Open Squeak" in the
popover and menus opens the conversation. Nothing here quits the app.

Cmd-Q (or the app menu's Quit) while a window is open only closes Squeak's windows:
the duck stays in the menu bar. The menu bar's "Quit Squeak" row (and "Quit Squeak
Completely", Option-Cmd-Q) really quits, as do logout, shutdown, the Dock's Quit,
AppleScript's `quit` and a Sparkle update. The decision is `QuitPolicy`.

### Claude usage

Claude Code never writes its plan limits to disk, so the Usage view's Refresh
asks the daemon (`POST /control/usage/claude-refresh`), which makes one GET to
Claude's usage endpoint with the sign-in Claude Code already holds. That is not
a model call: no tokens are used and no `claude` process is spawned. It runs
only when you press Refresh (never on a timer), at most once a minute, and it
waits out a rate limit's Retry-After. If it fails, the last reading and its age
stay as they were and the real reason is shown. A window Claude reports without
a reset time is shown as not reported.

## Updates

Squeak uses Sparkle 2 (`Sparkle.framework` in `Contents/Frameworks`, started by
`AppUpdater` only when running from the `com.squeak.mac` bundle, never in a capture
or `swift run`). Info.plist carries `SUFeedURL`
(`https://sibhimanyu.github.io/squeak/appcast.xml`), `SUPublicEDKey`,
`SUEnableAutomaticChecks`, `SUScheduledCheckInterval` (86400) and
`SUAllowsAutomaticUpdates`; the user can turn automatic checks off in Settings, About.

- The update archive is the release DMG. Sparkle accepts it only if its EdDSA
  signature matches `SUPublicEDKey`; the app's own ad-hoc code signature is not what
  protects updates.
- `CFBundleVersion` is the build number Sparkle compares: `major*10000 + minor*100 +
  patch` (2.0.2 is 20002). It must grow with every release.
- The EdDSA private key lives in the login Keychain (account `squeak`, made with
  Sparkle's `generate_keys --account squeak`) and is backed up, mode 0600, at
  `~/Library/Application Support/squeak/sparkle-ed25519-private.key`. Never commit
  it. Restore on a new Mac with `generate_keys --account squeak -f <that file>`.
  Losing it means installed copies can never be updated; they would need a manual
  reinstall with a new public key.
- The frameworks and the app are signed ad hoc, inside out, without the hardened
  runtime (its library validation refuses an ad-hoc framework: no Team ID).

### Message rendering

Agent and user messages are shown with a small Markdown subset: paragraphs,
headings, bullet and numbered lists, block quotes, fenced code (monospaced,
scrolls sideways) and inline bold, italic and code. `MessageMarkup` (Core) is a
pure parser; unclosed markers stay literal. `MarkdownView` builds the text by
hand: never `AttributedString(markdown:)`, never HTML. Links are untrusted:
the label is shown with its address in a muted style and is not clickable.
Text stays selectable.

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
3. Add a `RelayAdapter` implementing `HostAdapter` on top of it, and use it in
   `AppModel` in place of `DaemonSender` for sending to Conductor.
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
(Sparkle embedded, ad-hoc signed inside out, icon taken from
`desktop/build/squeak.icns` if present), `Squeak-<version>.zip` and its `.sha256`.
It installs nothing and makes no DMG.

`scripts/release.sh <version>` (add the `## <version>` CHANGELOG section first) bumps
the version, runs the tests, builds the app, builds the DMG (`make-dmg.sh`), signs
it with Sparkle's `sign_update`, fetches the published appcast and adds the new
item to it (`scripts/update-appcast.py`, older items are kept), and writes
`build/Squeak-<version>.dmg`, `build/appcast.xml` and `build/RELEASE_NOTES.md`.
It then prints the two publish steps and never runs them:

1. `gh release create v<version> build/Squeak-<version>.dmg … --repo Sibhimanyu/squeak`
   (upload the DMG first: the appcast points at it).
2. Copy `build/appcast.xml` to `squeak/appcast.xml` in
   `github.com/Sibhimanyu/sibhimanyu.github.io`, commit and push. Installed copies
   see the update on their next check.

Environment variables:

| variable | effect |
| --- | --- |
| `SQUEAK_DAEMON_PORT` | daemon port to talk to instead of 8477 |
| `SQUEAK_MAC_CAPTURE=<prefix>` | open the conversation window, save screenshots with that prefix, quit; uses no real cache or key file |
| `SQUEAK_MAC_APPEARANCE=light` | with capture, force light appearance (otherwise dark) |

## Install (for users)

The build is unsigned by Apple (ad-hoc signature only) and not notarized, so
Gatekeeper will warn the first time.

1. Check the download against its checksum file:

   ```bash
   shasum -a 256 Squeak-<version>.dmg
   ```

   The output must match the contents of `Squeak-<version>.dmg.sha256`.
2. Open the DMG and drag `Squeak.app` to Applications (or `~/Applications`).
   After that, Squeak updates itself.
3. Right-click the app and choose Open, then Open again in the dialog. If macOS
   still blocks it, go to System Settings, Privacy & Security, and choose
   "Open Anyway" next to the Squeak message.
4. Squeak has no Dock icon; look for it in the menu bar.

Reading Conductor chats needs nothing else. Sending, and terminal and desktop
sessions, need the Squeak daemon running on the same Mac (step 1 above).

## Privacy and data

- Messages the app has seen are cached in one encrypted file,
  `~/Library/Application Support/Squeak Mac/cache.squeak` (directory mode 0700).
- The cache key is a private file beside the cache (`cache-key.key`, mode 0600, excluded
  from backups), not a Keychain item: Squeak is ad-hoc signed, so every update has a new
  code identity and macOS would ask about a Keychain item again each time.
- Messages expire after 14 days and the cache is capped at 50 MB.
  Settings has a "Delete cache" button that purges it; Squeak rebuilds it as you
  open conversations.
- Notifications are private by default: they say a session needs you or has
  finished, and show session names only if you turn on "Show session names in
  notifications". They never carry message content. Clicking one opens the quick
  composer on exactly that chat, even on a cold launch (no inline reply; dismissing
  one does nothing); the composer closes on a click outside
  or a Space swipe, keeping unsent text per chat.
- The app as wired today reads Conductor's database locally and talks to the
  local daemon on loopback. The only other network call is Sparkle's daily
  check of the appcast on `sibhimanyu.github.io` (Sparkle sends the app and OS
  version, no message content, and no system profile). Once the
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

1. Ship the daemon so `/transcript` exists for terminal sessions.
2. Owner runs the feasibility doc section 7 tests, starting with 7.1
   two-session isolation, and a first supervised live send from the native app.
3. Exercise the untested UI: keyboard, hot key, notifications, onboarding.
4. Cut over to the Swift relay (plan above) and add `RelayAdapter`.
5. Sign with a Developer ID and notarize, if wider distribution is wanted.
6. Decide the fate of `desktop/` once the native app covers its use, and move
   the remaining channels out of Node only if there is a reason to.
