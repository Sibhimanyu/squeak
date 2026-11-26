# The phone channel

Threat model and design: `docs/remote-channel.md` — read it before touching `src/remote/` or the iPhone channel.

- **The Mac trusts a key, not a server.** `RemoteBridge.handleCommand` runs a
  reply only if a paired, unrevoked device's P-256 key signed the exact box,
  it has not expired (≤10 min), its nonce is new, it names the chat's
  _current_ turn, and it is a plain reply. Keep every check; add tests for
  any new one. A device of another account or a QR pairing always waits for the human to approve on the Mac; your own
  account's devices join by signing in (below), with no code, QR or pairing screen on any surface.
- **One owner-chosen exception to "the Mac trusts a key, not a server":** a device signed in to the same Squeak account
  the Mac is linked to (relay `devreqs`, `userId` equal) is added without a code, because Catalyst vouches for the
  account. It is told at once (remote activity, a Telegram/Cliq card that is never muted, the Mac app's
  notification via `addedAutomatically`) and revocable. "Ask before adding my own devices" (`askOwnDevices`,
  `POST /control/remote/account/settings`) restores the code. Other accounts' requests are dropped, and QR and pond
  guests always need the Mac's approval. Docs: `docs/remote-channel.md`, "Web accounts".
- **The channel can live in the Realtime Database** (`SQUEAK_REMOTE_DATABASE_URL`),
  streamed over Server-Sent Events instead of polled. A stream event only wakes
  a pass; never act on the event's data, read through the store so every check
  runs. A change that lands while a pass runs must schedule another (`dirty` in
  the bridge, `tickAgain` on the phone), or it is silently dropped until the
  60s safety poll. The database URL is accepted only for an https
  `*.firebasedatabase.app` / `*.firebaseio.com` host on both sides.
- **The Realtime Database speaks HTTP/1.1, and iOS allows four connections
  per host.** A held stream takes one for good, so the phone shares one
  stream per path (`StreamHub`) on its own `Channel.streamSession`; never open
  a stream per listener or per command, or requests queue behind them.
- **Swift and Node must agree byte-for-byte.** Change a shape on one side and
  regenerate the fixtures (`swift run -c release squeak-fixtures
../../src/remote/fixtures/swift-command.json` in `ios/SqueakCore`; the Mac
  fixture with `npx tsx scripts/make-mac-fixture.ts`, from a real
  `RemoteBridge.phoneView()`), then run both test suites and
  `npx tsx scripts/e2e-remote.ts`. New fields are optional on the phone, so a
  phone updated before its Mac keeps decoding. The e2e runs the prebuilt
  `.build/release/squeak-e2e`: run `swift build -c release --product
squeak-e2e` first, or it tests yesterday's phone. A format an older phone
  cannot read (compression, the split recent list) is written only for a
  phone whose presence `caps` names it.
- **The Room on the phone is a sealed `live` document too** (`pond-room.ts`, `docs/ponds.md` "The Room on iPhone"): written
  only while presence names the pond's Room (`room`) and caps name `pondroom`, rows already decided on the Mac, actions are
  `pond` ops `room-post`/`room-task`/`room-drop` with strict keys. Never let the phone decide a Task state, a routing line or
  who may post.
- **The phone gets less of a working turn than the Mac window**: the newest
  six steps, each clipped to 200 characters, no timestamps, and only while
  the session works — what leaves the Mac is only what the phone renders.
  The one exception is verbose ("Show thinking live" on the phone, on by
  default): the whole turn of the one session open on screen (active, or a
  Conductor chat from the phone's Recent list, which gets history and queue but
  no steps), plus that chat's Conductor queue, deleted from the database when the phone leaves it
  (`live-turn.ts`). Keep it that narrow; `SQUEAK_REMOTE_VERBOSE=off` refuses
  it on the Mac.
- **History in the cloud is sealed and Mac-written** (docs/remote-channel.md, "History cache" Layer 2): kind `hist` under
  `channels/<id>/hist/` (`idx` + `<handle>-<first entry id>` pages, `src/remote/history-cloud.ts`), hosted relays only. Devices
  read by id with the channel key; only the Mac, with its own write token (`x-squeak-hist`, hash registered at
  `/account/macs/hist-token`, never in a pairing grant), may write or delete, capped 50 MB / 4000 documents per account. The
  setting `keepHistoryInCloud` (Account settings, default on when hosted) off deletes it. A phone reads it only when the Mac is
  silent or the chat is not held, then Layer 1's delta catches up; never let a cloud page overwrite a newer held entry.
- **The direct path is one more untrusted pipe, not a second brain.** `MirrorStore` wraps the bridge's store:
  every write also lands in the in-memory `DocTree` the `LocalChannelServer` serves, and a phone's local presence and
  commands are merged into what the bridge reads, so a local command runs through `handleCommand` with every check
  unchanged. Never give the local server a code path of its own for what the Mac says or does. It serves only the
  channel's `state`/`results`/`live`/`commands` (never pairing, never media), with the channel id left out of every
  path, an HMAC on every request (`local-auth.ts`: HKDF `squeak-local-v1`, 60 s, nonce, constant-time) and one on every
  response that binds the request's nonce. A refusal is a bare 401. Streams carry "changed", never data. A handled
  command's id is remembered 15 min so the other transport's copy cannot run or overwrite its result. On the phone
  (`LocalRoute.swift`) a command goes out on exactly one transport: local failure that proves nothing was sent goes to
  the cloud; an ambiguous one is taken back from the Mac first, and if that cannot be confirmed it is not sent again.
  `local-auth.json` pins Node and Swift byte for byte (`scripts/make-local-fixture.ts`);
  `SQUEAK_E2E_LOCAL=1 npx tsx scripts/e2e-remote.ts` runs the whole thing with the prebuilt `squeak-e2e`.
- **The iPhone app is standalone.** `SqueakRootView` (module `SqueakUI`) is
  the whole UI in one view and `ios/Squeak` is a window around it. The app
  owns the `squeak://` scheme; Telegram's "Open in Squeak" goes through
  `https://<project>.web.app/open/#s=<id>`, which redirects to
  `squeak://open?s=<id>` (`SqueakLink` parses it, `SqueakRouter` opens it).
  Launch flags are `-squeak-*` (demo screenshots only).
- The iPhone app is released with `ios/scripts/release.sh "notes"`; bump
  `MARKETING_VERSION` in `ios/project.yml` or SideStore never offers it. The
  file is served as `.zip` because Spark refuses `.ipa` on new projects.
- Signing in (hosted relay) turns the channel on; `SQUEAK_REMOTE_PROJECT` in Squeak's `.env` is only a gate on an old Firebase setup. The
  channel secret lives only in `~/Library/Application Support/squeak/remote.json`
  (0600) and in paired phones' Keychains.
