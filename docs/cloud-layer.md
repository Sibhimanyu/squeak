# Squeak's hosted cloud

Sign in on the Mac in **Settings › You › Account**. The daemon provisions that Mac on Squeak's hosted Catalyst
relay and saves its key in `cloud.json` in the support directory. The Account page shows the connection state and
offers **Retry** after a connection error. See [Feature flags](flags.md) for the relay URL override.

## What a store is

`CloudStore` (`src/cloud/store.ts`) provides `get`, `set`, `delete`, `list` and `watch`. A watch is a signal
to read again. The daemon uses `CatalystStore` and the iPhone uses `CatalystClient`. Both retain a Realtime
Database implementation for older installs (see "What is still on Firebase").

## Catalyst transport

- The `squeak_relay` function lives in `cloud/catalyst-relay/`. Its base path is `/server/squeak_relay`.
- `GET`, `PUT` and `DELETE /doc?path=` access one document. `GET /list?prefix=` lists a collection.
  `GET /ping` reports relay health. `POST /token` opens the Data Streams connection.
- Channel documents use `channels/<channelId>/<kind>/<doc>`. The relay validates paths and sizes.
  The NoSQL table `squeak_docs` uses `channels/<channelId>/<kind>` as its partition key and the document ID as
  its sort key. Channel payloads are sealed by the devices.
- Data Streams wakes watchers after writes. Clients read through the store and poll as a fallback.

## Devices and migration

An iPhone or browser signs in with the Mac's account. The Mac authorizes each device and seals its channel details
to that device's key. See [Remote channel](remote-channel.md#web-accounts-2026-11-10).

## What is still on Firebase

Firestore is gone from the daemon: no `FirestoreRest`, no Firestore rules, no Firestore Cliq inbox or Deluge handlers.
`ChannelDoc` lives in `src/cloud/store.ts`. The Realtime Database client (`src/remote/rtdb-rest.ts`, with `fake-rtdb.ts` as
the in-memory double most tests use) stays, for what is still live:

- The old store a Mac announces its signed `move` from, and `cloud.json` `"active": "firebase"` for a Mac not yet signed in:
  paired iPhones (`CatalystClient` keeps its Realtime Database fallback) follow the move.
- The voice add-on's rendezvous database (`RENDEZVOUS_DATABASE`, `src/voice/claim-protocol.ts`) and the Home Assistant
  gateway's own store, which older add-ons still open.
- The Cliq inbox in the Realtime Database, read next to the Catalyst `cliq` kind until the handlers are pasted again.
- The web app (`web/js/rtdb.js`) for a browser paired before Catalyst, and `firebase/` Hosting for `/app`.

Remove each when its owner is gone; the remaining ticket steps (older Mac apps refused, `/app` redirect) come first.

When sign-in moves a Mac from an older store, the daemon writes a sealed, signed `state/move` document on that store.
Compatible paired phones and voice gateways verify it and move to the new location. The Mac reads the old store for
10 minutes after the move. A phone that missed the move can sign in again.

## People data (Data Store tables) and clean start

Who is in a Pond lives in server-readable Catalyst Data Store tables; what people and Ducks say stays sealed in NoSQL
(ADR 0005, `docs/spec.md` "Cloud: what is stored where"). Code is in `cloud/catalyst-relay/functions/squeak_relay/`:

- `people-schema.json` is the checked-in table definition: `people_accounts`, `people_devices`, `people_push_tokens`,
  `people_ponds`, `people_memberships`, `people_slots`, `people_invites`, `people_invite_locks`. The setup script
  `cloud/catalyst-relay/scripts/create-people-tables.mjs` creates them (dry run by default; `--apply` only in Development).
- `people.js` is the one interface, `createPeople({ tables, now })`, over a small `Tables` port (`insert`, `get`, `select`,
  `all`, `update`, `delete`, `clear`; the contract is at the top of the file). Two implementations of the port:
  `people-datastore.js` (Catalyst: ZCQL reads, SDK writes, 300-row pages, bulk delete of 200) and `people-memory.js` (tests;
  enforces the same unique columns). A route handler or test gets a `people` and never sees a table.
- What it offers, grouped. Accounts: `upsertAccount` (names come from sign-in), `getAccount`, `accountByEmail`.
  Devices: `addDevice`, `devicesOf`, `removeDevice`, `setPushToken`, `pushTokensOf`. Ponds: `createPond` (the Owner becomes
  the first member), `getPond`, `pondsOf`, `pondIds`. Memberships: `addMember`, `removeMember`, `isMember`, `membershipOf`,
  `membersOf`. Invites: `createInvite`, `settleInvite` (joined, declined, withdrawn, expired), `getInvite`, `invitesOf`,
  `pendingInvitesFor`. Clean start: `cleanStart`. Refusals are `PeopleError` with a stable `code` (`already-member`,
  `pond-full`, `invite-pending`, `invite-exists`, `pond-exists`, `device-taken`, `not-member`, `owner`, `not-pending`,
  `no-invite`, `no-pond`, `invalid`); routes map them to statuses. Later tickets build on this: #120 (sequence numbers and the
  change feed) reads `isMember` and `membersOf`, #126 (invites) uses the invite calls, #128 (removal) uses `removeMember`.
- Rules live in the tables, not in code that reads then writes, because Data Store has no transactions and `IsUnique`
  is per column: the membership key is `pondId:userId` (unique); the 10-person cap is ten slot rows `pondId:0..9`
  (a taken slot is refused by the unique key); one pending invite per address per Pond is a lock row
  `pondId:sha256(email)` that is deleted when the invite is settled (an expired invite's lock is cleared by the next invite
  to that address). A membership row is written first, so a duplicate is refused before any slot is touched.
- Names (accounts, devices, Ponds) are stored escaped (backslash doubled, characters above U+FFFF as `\u{hex}`) because Data
  Store turns 4-byte UTF-8 into `?`; `people.js` encodes and decodes, so callers see plain text. Times are epoch-ms bigint
  columns, never `CREATEDTIME`. Lookup values in ZCQL may not contain `'`, `\` or control characters (refused, never escaped).
- Wiring: `index.js` builds `people` only when `SQUEAK_PEOPLE_TABLES=on`, so a relay deployed before the tables exist behaves
  as before. No existing route reads the tables yet. The Data Store duplicate error shape, the ZCQL value escaping and the
  SDK calls (`new Datastore(app).table()`, `new ZCQL(app).executeZCQLQuery()`) are **unmeasured against a live project**;
  the live test plan in `cloud-spike-2026-11.md` covers them.

## Sequence numbers and the change feed

Every content write in a Pond (kinds in `feed.js` `FEED_KINDS`: pond, members, joins, threads, tevents, holds,
tcmds, keys, room, rposts, rtasks, roomnote) gets the Pond's next `seq`; a device asks what
changed since a seq and gets only those documents. Code: `functions/squeak_relay/feed.js`, the daemon side in
`src/cloud/change-feed.ts`.

- **The counter (no transactions, no conditional update).** A seq is a row: `feed/<pondId>` / `<seq as 12 digits>` holds the
  change itself (`{seq, kind, id, doc|null, at}`, a delete is `doc: null`). A writer takes seq n by _inserting_ row n, which
  the unique `(pk, doc)` key lets only one writer do (`store.claim`, insert only). A refused insert means another writer
  holds n: walk to the end of the log (`store.range`) and try the next number, up to 40 tries, then 503. Unique, because the
  store refuses a second insert; gapless and ordered, because a writer only tries n after rows below n were seen (the walk
  reads them; the hint is written after its row); atomic with the content, because the row carries the document, so a reader
  never sees a seq whose document is not there yet. `feedhead/<pondId>` is a lower-bound hint written every 8 seqs so the
  walk reads a few rows, not all; losing it costs reads, never correctness. Rejected: a counter row read-then-written
  (loses increments under concurrency), and a seq reserved before the document is written (leaves a hole a reader may
  step over).
- **Routes.** `GET /changes?pond=<id>&since=<seq|head>&limit=<1..100>` answers `{changes:[{seq,kind,id,doc|null}], next, more}`,
  oldest first; `since=head` returns only the end as `next`. Callers: the operator key, a Mac key (`channelAllowed`), a pond
  token of that Pond, or an `x-squeak-account` token whose account `people.isMember(pondId, userId)` (a non-member, a
  removed member, or a relay without the people tables is 403). 404 when the store has no `claim`/`range` (feed off).
- **Old clients.** The stored document also gets `seq` (an extra field older clients ignore); `/doc` and `/list` are unchanged
  and the iPhone app keeps using them. The daemon's `ChannelDoc.seq` carries it to the Room (`FeedMirror` puts the change's seq back on each document).
- **Daemon.** `CatalystStore.list` of a content kind goes through `FeedMirror`: first open of a Pond = `since=head`, one list
  of that kind, one catch-up read; afterwards every list of that Pond is one `/changes` read applied to a mirror held per
  Pond (cursor) and kind. A relay without the feed, or a token it refuses, turns the mirror off and lists plainly.
- **Known limits.** The mirror and cursors live in the daemon's memory, so a restart is a first open again. The log is not
  compacted yet, and a Pond reset by clean start restarts at seq 1 (clients restart too). The canonical `/doc` row of a
  document written by two writers at once can hold the earlier seq's content; the feed, in seq order, is the truth.
  `claim` and `range` on NoSQL (`index.js`) are **unmeasured against a live project**: insert refusing an existing key, and
  query results ascending by sort key with a `start_key`. Add them to the live test plan.

## The Room in the cloud (issue #122)

Code: `functions/squeak_relay/room-cloud.js`, `src/flotilla/room-sync.ts`; the design is in `docs/ponds.md`, "The Room reaches Members".

- **Kept whole, sealed.** `room` (the Owner's posts) and `rposts` (every Member's own signed documents) are stamped like any content.
  A Member's token may add an `rposts` document and never overwrite (409) or delete (403) one. Everything a Member writes is readable by
  every other Member at once; the Owner's Mac ingests it when it is online.
- **25 MB per Pond.** A counter row `roombytes/<pond>` (relay-owned, outside `channels/`) is raised by every Room write; it only ever
  overcounts. When it passes the cap the relay measures exactly (`room` + `rposts`), and a Room that is really over loses its oldest by seq
  until it is under 90% of the cap: each removal is a feed tombstone, then `channels/<pond>/roomnote/trim` = `{v, removed, before, at}` is
  written (plain JSON, relay only, stamped into the feed, readable by every Member, refused to every writer). `deps.roomCapBytes`
  overrides the cap in tests. Clean start deletes the counter and the note. Unmeasured live: the NoSQL cost of the measuring read.
- **Key versions.** Boxes are tagged `<version>.<sealed>`; the relay never reads them. A rotation leaves old documents alone.
- **Kinds removed.** `ripples`, `presence`, `grants`, `claims`, `tasks`, `locks` are no longer kinds (`kinds.json`, `FEED_KINDS`, the RTDB
  rules, the guest token's write set), and `/ponds/short` and `/ponds/short/redeem` are gone. A write to a removed kind is a 400 (403 for a
  token). `guest` remains the name of the token a web or iPhone member device holds (writes: `tcmds`, `joins`, `holds`, `rposts`).
  What the iPhone still uses, unchanged: `state`, `pairing`, `commands`, `results`, `live`, `media`, `voice*`, `hist`, `cliq`, `devreqs`,
  `devresults`; its pond view still decodes `ripples` (the Mac serves the Owner's recent lines, empty for a Member) and `presence` (empty).

### Pictures and files (issue #123)

Code: `functions/squeak_relay/blobs.js` (the store), `blob-stratus.js` and `blob-memory.js` (the two buckets), the `/blob` route in
`handler.js`; the daemon side in `src/flotilla/blobs.ts` (seal and open), `CatalystStore.putBlob/getBlob` and `src/flotilla/room-sync.ts`.

- **A post names a blob by id.** A Room post document (`room`, or a Member's `rposts`) carries `blobs: [{id, kind: image|file, name, mime,
size, width?, height?}]` inside its sealed box; the bytes are never in a NoSQL document. A post of only a picture has empty `text`.
- **Sealed on the device.** The sending Mac seals the bytes under the Pond key at the current key version: `<version>.` then nonce (12),
  AES-256-GCM ciphertext and tag (16), with `blobs/<pond>/<blob id>` as the additional authenticated data (the cloud cannot hand one blob out
  as another). The relay checks only the shape (a version head and room for a box) and refuses anything else with 400 `blob-unsealed`, so a
  client that forgets to seal fails loudly. A rotation leaves old blobs alone; a Member holding the old key still opens them.
- **Routes.** `PUT /blob?pond=&id=&kind=room|rposts&doc=<post id>` (body: the sealed bytes, 204), `GET /blob?pond=&id=` (the bytes, 404 once
  paged out), `DELETE /blob?pond=&id=` (the Pond's Mac or the key, 204). A blob id is 16 to 64 base64url characters chosen by the sender and
  is written once (409 on a second write). Who: read by a Mac of the Pond, an account that `people.isMember`, a pond token of that Pond that is
  not revoked (a removed member's token is 401 and their account is 403 at once); write by a Mac of the Pond, a member's Mac signed in as a
  member, or a guest or member token (kind `rposts` only: a Member adds to their own post and can never delete); an account token reads only.
  Without `SQUEAK_BLOB_BUCKET` every call is 503 `blobs-off`.
- **Limits, separate from the 25 MB Room cap** (which counts NoSQL bytes): one sealed blob is at most **6 MB** (a 5 MB file plus the box; the Mac's
  own limits are 2 MB a picture, 5 MB a file, four of each, 16 MB a post); one Pond keeps at most **200 MB** of blobs. Past either the relay
  answers 413 `{error: "blob-too-large" | "blob-quota", message}` with a plain sentence the Mac shows as it is. A full Pond first frees orphans
  (a blob whose post document does not exist and that is over an hour old: an upload whose post never arrived). `deps.blobMaxBytes` and
  `deps.blobCapBytes` override the limits in tests.
- **Bookkeeping.** One small NoSQL row per blob, `blobs/<pond>` / `<blob id>` = `{v, size, at, kind, doc, by}` (relay-owned, no `/doc` path
  reaches it): which document names it, and its size for the Pond's usage (a sum of the rows).
- **Cleanup.** When a Room post leaves the cloud its blobs go with it: the 25 MB page-out (`room-cloud.js` `trim`) drops the blobs of every post it
  removes, `DELETE /doc` of a `room` or `rposts` document drops its blobs, and clean start removes every blob of the Pond. A removed Member's
  blobs stay with their posts (the Room keeps them). Dropping a blob that is not there is not an error.
- **Daemon.** The Owner's Mac uploads the pictures of a post (from its local attachments) before writing the `room` document and does not send
  them again after a restart. A refusal (too big, full, no bucket yet) leaves that picture on the Mac and the post goes without it (a post of
  only that picture is not sent). A Member's Mac seals and uploads before writing its `rposts` document; there a refusal is an error with the
  plain sentence and nothing is posted. The Owner's Mac, applying a Member's post, fetches its blobs into its own Room attachments. A Member's
  page carries each post's `blobs` and `attachments` (the Owner's Room shape; `url` is `/native/ponds/<id>/room/blobs/<blob id>`), and that route
  fetches and opens the blob when it is viewed. `POST /native/ponds/<id>/room` takes `attachments: [{name, data}]` like the Owner's Room.
- **Not done here.** Drawing a Member's attachments in the Mac and the web (the daemon serves them), any web upload, and an iPhone change
  (the iPhone's `media` kind is untouched).
- **Unmeasured live.** The `@zcatalyst/stratus` calls (`new Stratus(app).bucket(name)`, `putObject` refusing an existing key, `getObject`'s
  stream), a 6 MB request body through AppSail and the function, and what a hosted account's daily byte limit says about uploads (blob bytes are
  not charged to it).

**Owner steps for the Stratus bucket (nothing is created by code; Development environment first).**

1. In the Catalyst console, **Cloud Scale > Stratus > Create bucket**. Bucket names are globally unique: use `squeak-blobs-<project id prefix>`.
   Keep it **private** (no public read, no object URLs: only the relay reads it). Leave versioning off (a blob is written once and deleted whole).
   Encryption at rest on if offered. Do not add a lifecycle rule: the relay deletes what a post's page-out or removal frees.
2. Set `SQUEAK_BLOB_BUCKET=<the bucket name>` in the relay function's environment variables (and the AppSail relay's, if it runs there), in
   Development first. Unset, `/blob` answers 503 and nothing else changes.
3. Make sure the function and the AppSail app's role may use Stratus in that project (the console's Stratus page lists the access it needs), then
   deploy the relay (`deploy-hosted.sh`); its `package.json` now depends on `@zcatalyst/stratus`.
4. Check: from a Mac signed in on that environment, post a picture in a shared Pond's Room; the bucket shows one object `<pondId>/<blobId>`
   whose bytes are not an image (they begin `1.`), and a Member's Mac opens it. Delete the post and the object goes.
5. Rollback: unset `SQUEAK_BLOB_BUCKET` (Macs keep their pictures; new posts go without them); delete the bucket to free it.

### Clean start

The release clears all cloud Pond data; every Pond and Duck stays on the Owner's Mac and shared Ponds become local again.

- **Cloud side.** `POST /admin/clean-start {confirm:"wipe-cloud-ponds", pondIds?, userIds?}` with the operator's `x-squeak-relay`
  key. It answers 403 unless the relay runs with `SQUEAK_CLEAN_START=on` (the development environment only; leave it unset
  in production). It clears the Pond tables, each Pond's sealed documents (every kind under `channels/<pondId>/`), its pins,
  revocations and channel claim, and every account's Pond index (`acctponds/<userId>`). It keeps accounts, devices, push
  tokens and every Mac's own channel (a Pond id that is a Mac's key id is skipped), so the iPhone keeps working. The store
  cannot list partitions: Pond ids come from the Pond table, from the account indexes of every account in the tables, and from
  `pondIds` and `userIds` the operator names (needed for accounts the tables have not seen yet). Idempotent.
- **Mac side.** `FlotillaService.startClean()` (once; recorded as `cleanStartedAt` in `flotilla/ponds.json`) makes each Pond
  this Mac owns a local Pond again (same id, name, project and key; invites and tokens dropped; Ducks and Room history
  untouched) and forgets records this Mac only joined. It runs at start when `SQUEAK_CLEAN_START=on` is set for the daemon
  (see [flags](flags.md)); the release that clears production flips that to the default.

## Live notices (`squeak-live`, issue #121)

A device keeps one live connection and is told, in a few bytes, that something it watches changed; it then reads the change
feed above. Decision and measurements: `docs/cloud-spike-2026-11.md` (SSE only, WebSocket is stripped by the front door).
Code: `cloud/catalyst-relay/live/` (own folder, shares only the relay's modules), the relay's side in
`functions/squeak_relay/live-notice.js`, the daemon's in `src/cloud/live-notices.ts` (`LiveClient`).

- **A separate AppSail service, `squeak-live`.** An open stream counts toward the platform's 100 concurrent requests per
  instance (5 instances, about 500 devices), so streams must not share that budget with the relay's ordinary calls, and a
  relay deploy must not drop every device. Routes: `GET /live?pond=<id>&pond=<id>` (SSE; `x-squeak-account` or
  `x-squeak-mac-key`, plus `x-squeak-device`), `POST /typing {pond}`, `GET /presence?pond=<id>`, `GET /health`.
- **What a device says and gets.** It names its Ponds; the service checks each against `people.isMember` (cached 2 min per
  account and Pond) and answers `event: hello {ponds, refused, maxAgeMs}`: a Pond the account is not in is refused, never
  subscribed. Then `event: notice {pond, seq, kind}` after each stamped write (no content), `typing {pond, user}`,
  `removed {pond}`, and `bye`. Heartbeat comment every 15 s.
- **One stream per device, handed over without a gap.** The platform ends every response at about 45 s and never says a client
  left. The service sends `bye` and closes at 40 s; the client opens its replacement at 35 s, so two streams overlap for a few
  seconds, both deliver a notice, and the client drops the repeat by seq; it closes the old one when the new one says hello.
  After a notice the client reads `GET /changes` from its own cursor; an idle device makes no request but the renewal.
- **Between instances: one internal Data Streams channel, `squeak_live`.** Only the instances subscribe (at most five); no
  device touches it. Messages: `{t:"n", pond, seq, kind}` (the relay publishes one after `feed.append`, `stamp()` in
  `handler.js`), `{t:"rm", pond, user}` (published by `people.removeMember` through `withRemovalNotice`: the person's
  subscriptions to that Pond close at once, the service sends `removed`), `{t:"pr", dev, user, at}` (presence renewals),
  `{t:"ty", pond, user}` (typing). The instances cannot mint Data Streams tokens or publish themselves, so they ask the relay
  with the relay key: `POST /live/token {name}` and `POST /live/publish {text}` (key only, never a Mac key or device).
  In tests the channel is `createMemoryBus()` (`live/fanout.js`).
- **Presence is not stored.** A device is online while its stream was renewed within 45 s (the service learns of renewals,
  not disconnects). When a device lapses and no other device of the account is online, `lastseen/<userId>` is written once,
  by the instance that took the last renewal. Typing is passed along and never stored.
- **Fallback.** While no stream is open `LiveClient.state` is `reconnecting` (the UI of #130 says "Reconnecting...") and the
  feed is polled every 30 s; new streams are tried with growing jittered delays, and the first hello after being down reads
  each Pond once. Live again: no poll. The old shared `squeak_notice` channel and `/token` are unchanged for the iPhone app.
- **Wired (issue #130).** A hosted Mac's `CatalystStore` starts one `LiveClient` with its first watcher when `SQUEAK_LIVE_URL`
  names `squeak-live` (https, or http on this machine). It takes `FeedMirror.cursors`; a notice reads `/changes` and wakes the
  watchers of that Pond, which list through the mirror as before. With it set, the store's own Data Streams socket stays
  closed; unset, the old notice path runs unchanged. The daemon computes one connection state per Pond and overall
  (`src/flotilla/connection.ts`): `live`, `reconnecting` (stream down or cloud unreadable) or `owner-offline` (Owner's presence,
  never shown to the Owner), on `PondSummary.connection` and `PondView.connection`, and `connection` beside `ponds` in
  `GET /ponds`. The Mac draws it (Dashboard state line, Room header) and works out nothing. Leave is done only when the cloud
  confirms the account-level leave (503 with a sentence otherwise); remove and delete already answer after their cloud writes.

Owner steps (nothing here is deployed; Development environment first):

1. In the Catalyst console, Data Streams: create the channel `squeak_live` (same access-control function as `squeak_notice`,
   `squeak_relay`). The relay finds it by name (`liveChannelId`); until it exists no notice is published and nothing breaks.
2. Deploy the relay function with this change (`deploy-hosted.sh`), and, if the relay runs on AppSail, that app too.
3. Stage and deploy the service: `cloud/catalyst-relay/live/build.sh /tmp/live-build`, then from a Catalyst project directory
   `catalyst deploy appsail --name squeak-live --build-path /tmp/live-build --stack node22 --command "node server.js"`
   with the env of `live/app-config.json` (`RELAY_KEY` the same as the relay's, `SQUEAK_RELAY_URL` the relay's base URL,
   `SQUEAK_PEOPLE_TABLES=on`). Check `GET <service>/health`.
4. Unverified live (list for the live test): the AppSail runtime initialising the Catalyst SDK without a request (`zcAuth.init`
   in `live/server.js` `main()`), the people-table and NoSQL reads from `squeak-live`, the Data Streams WebSocket from an
   AppSail instance, and the 500-stream cap (ask Zoho, see the spike's draft email).
5. Rollback: delete the `squeak_live` channel (the relay then publishes nothing) and the `squeak-live` service; devices fall
   back to the 30 s feed poll.

## Accounts (Catalyst Hosted login; relay routes)

The account identifies the person; device keys authorise. The relay holds nothing that opens a Mac's channel, and a
signed-in account alone never grants access. Cookie routes answer a bare 401 when nobody is signed in and always send
`Cache-Control: no-store`; Mac-side routes need `x-squeak-relay`.

- `POST /account/link-ticket` issues a 10-minute ticket from a signed-in browser session.
- `POST /account/link` exchanges a ticket for the account identity. `POST /account/unlink` removes the account link and pending device requests.
- `POST /account/app-token` exchanges the browser session for a 30-day token for a native app.
- `/account/avatar` reads, writes or removes the account's JPEG photo. Uploads are capped at 64 KB.
- `GET /account/macs` lists the account's Macs.
- `POST /account/device-request` submits a new device's keys. The matching GET polls for the result.

- **Ticket** `al.<userId>.<expMs>.<emailBase64url>.<mac>`: HMAC-SHA256 under `RELAY_KEY` over a domain prefix and the
  fields (`scoped.js`, constant-time verify). The email of the signed-in user is one of the signed fields, so the relay
  stores nothing at issue and `/account/link` learns the email from the ticket alone.
- **App token** `at.<userId>.<expMs>.<emailBase64url>.<mac>`: the same shape as a ticket under its own MAC domain tag
  (`squeak-account-app`), so neither verifies as the other. A native app (Squeak for Mac, Squeak for iPhone) gets one from
  the web callback page (`POST /account/app-token`, cookie only) and sends it as `x-squeak-account: <token>` on `/me`,
  `/account/macs`, `/account/device-request` (POST and GET) and `/account/avatar` (its own photo); the token wins over the cookie when both are present, and
  a bad or expired one is a bare 401, never a fall back to the cookie. It also authorizes hosted Mac provisioning. A browser session is required to mint tickets and app tokens. `/me` also carries `avatarAt` (ms) when a photo exists. Through a token `/me` answers `name: ""` (the
  token carries the email only). It identifies, never authorises: the Mac still approves every device.
- **Records** (store partition keys): `accounts/<userId>` doc `<macId>` = `{macId, name, linkedAt}`; `maclinks` doc
  `<macId>` = `{userId, email}`; `channels/<macId>/devreqs` doc `<reqId>` = `{v:1, reqId, userId, email, name, publicKey,
boxKey, at}` (a request older than 10 min is gone); `channels/<macId>/devresults` doc `<reqId>` = whatever the Mac wrote.
- **Profile photo**: Catalyst's user record has none, so the relay keeps one JPEG per user in the store under the
  relay-owned partition key `avatars`, doc `<userId>` = `{v:1, type, data (base64), at}` (about 88 KB at the 64 KB cap,
  well under the NoSQL item limit as documented; not measured against a live table), and the write counter under
  `avatar-writes` = `{since, n}`. Neither key has the `channels/<id>/<kind>` shape, so no `/doc` or `/list` path, with
  the relay key or a pond token, can name them. The Mac fetches the linked user's photo with the relay key.
- **Kinds**: `devreqs` is relay-owned (the relay key may GET/list/DELETE, never PUT); `devresults` the Mac writes (relay
  key); no pond token touches either. A device request wakes the Mac with the same change notice a PUT would; the Mac
  checks the keys and answers.

## Account-wide pond membership (relay 1.7.0)

Design and trust argument: docs/ponds.md, "Members are accounts". Three routes, no new secret, no new kind (`devreqs` already
exists and is relay-owned: no pond token reads or writes it, and the relay key never PUTs it):

- `POST /ponds/<pondId>/members/accounts` `{ ownerKey, name?, add: [userId], remove: [userId] }` (a Mac's own key that owns the
  pond's channel, or the operator's key; at most 50 ids per list): writes/removes relay-owned rows `acctponds/<userId>` /
  `<pondId>` = `{ v:1, ownerKey, name?, at }`. 204; 400 `ids` | `key`; 403 not the channel's Mac.
- `GET /account/ponds` (a Mac's own key, or `x-squeak-account`; 401 for the operator's key, a pond token or nobody): `{ ponds:
[{ pondId, ownerKey, name? }] }` for the caller's own account only (at most 100), `no-store`.
- `GET /account/overview` (`x-squeak-account`): `{ ponds: [{ pondId, name, ownerName, ownerKey, mine, role, shared, lastActivityAt,
seqHead, counts: { members, ducks } }], invitations: [{ inviteId, pondName, inviterName, at }] }`, metadata only (ADR 0005), `no-store`,
  newest activity first, at most 100 Ponds. From the account's `acctponds` rows (which may carry `ownerUserId` and `role`, written by the
  Owner's Mac), `people.pondsOf`, the feed's newest row (`seq` and `at`), and document ids counted under `members` and `threads`.
  `POST /account/invitations/<inviteId>/join` (200 `{ pondId }`) and `/decline` (204): the invite must be pending and addressed to the
  caller's email (403 otherwise; 404 unknown; 409 settled). Join writes the people-table membership; the full lifecycle is #126's.
- `GET /account/devices?deviceId=<this>` (account token or the Mac's own key) answers `{ devices: [{ deviceId, name, kind:
"mac"|"web"|"iphone", createdAt, lastSeenAt, thisDevice }] }` from `people_devices`; `POST /account/devices { publicKey, name,
kind }` registers or refreshes one (20 per account; `pond-devices` registers too); `DELETE /account/devices/<deviceId>` (204,
  404 when not the caller's) removes it everywhere: deleted from the people tables, `revoked/<pond>/<deviceId>` for every Pond
  of the account (the `acctponds` index and `people.pondsOf`, not owned ones), and a relay-owned removal note in each Pond's
  `devreqs` for the Owner's Mac (docs/ponds.md, "Surfaces"). Devices are never written anywhere a Member can read. `acctponds`
  rows may carry `ownerName` (from the Owner's Mac) so a new device can say "waiting for <Owner>’s Mac".
- `POST /account/pond-devices` `{ pondId, publicKey, boxKey?, client: "mac"|"web"|"ios", nest? }` (same callers): 403 `pond` unless
  the caller's account is in the pond's index, 403 `removed` for a device whose id has a revocation record, 429 `rate` past 10 a
  minute per account (`ponddev-rate`). Writes `channels/<pondId>/devreqs/<deviceId>` (`deviceId` = base64url of the first 12 bytes
  of SHA-256 of the key) = `{ v:1, reqId, userId, email, name, publicKey, boxKey, client, nest, at }`, announces it, and answers
  `{ reqId, token, expiresAt }` (a join-scope token, 24 h, for that device id).

## Invite email (relay 1.6.0, Catalyst Mail)

`POST /ponds/<pondId>/invites/email` (a Mac's own key, or the operator's relay key; the Mac must own the pond's channel):
strict body `{ emails: [1..10 addresses], inviteUrls: { <lower-cased address>: <link> }, pondName, inviterName }`, nothing
else. Each address is checked with a simple strict pattern (max 254 characters); each link must be
`https://squeak.onslate.in/join#<base64url code>` (the relay will not mail a link to anywhere else); names are one line,
HTML-escaped in the body. One email per address, subject `<inviter> invited you to <pond> on Squeak`, plain words, no
tracking. Catalyst Mail sends one body per message (`@zcatalyst/mail` 1.0.0, `sendMail({ from_email, to_email, subject,
content, html_mode })`), so the email is HTML with the bare link also in the text; `mail.js` also builds the plain-text
version for the day the API takes both. Limits in `invite-mail`: 10 emails per pond per hour, 20 per Mac per day (an
operator-key call counts as "operator"). Answers `200 { sent, failed }` (partial failure lists the addresses),
`400 { error: "body" | "links" | "ids" }`, `429 { error: "busy" }`, `503 { error: "mail", reason }` when nothing went out
(sender not set up, quota): a fixed sentence, never the SDK's words. The sender is `SQUEAK_MAIL_FROM` (an env variable of the
function and AppSail; `deploy-hosted.sh` and `deploy-appsail.sh` pass it through when it is set; unset = 503, no mail).
A join refused for the wrong email is now `403 { error: "email", masked: "p***@e***.com" }`. `/account/handoff` also accepts
a return to `https://squeak.onslate.in/join` (exactly).

Catalyst Mail's free tier is **100 emails a month for the whole account**, then **$0.001 per email**.

One-time console setup the owner must do before invite emails work (not done by any script; the path is from the Catalyst
docs and the SDK README and was not clicked through here, so check the labels):

1. In the Catalyst console, open the project, **Cloud Scale > Mail** (docs: "Catalyst Mail > Email configuration"), and enable
   Mail for the project (in each environment that sends: Development now, Production later).
2. Add a **sender address** (a Zoho Mail or domain address you control; a custom domain also needs the domain
   verification the console shows: SPF and DKIM records) and verify it from the confirmation email Catalyst sends.
3. Set `SQUEAK_MAIL_FROM` to that exact address (`SQUEAK_MAIL_FROM=... deploy-hosted.sh`, and for AppSail the same variable
   to `deploy-appsail.sh`, or in the function's and AppSail's environment variables in the console), then redeploy the
   relay. Until then the Mac's Send invites answers "Squeak couldn't send email right now".

## Squeak's hosted relay: per-Mac keys

Squeak runs one relay for every user. `RELAY_KEY` stays with the operator and opens every channel; a Mac gets its own key
only after its owner signs in (a Squeak account is required to use the hosted cloud). Code: `tenants.js`, wired in `handler.js`.

- **Provision**: `POST /account/macs/provision {macId, name?}` (cookie or `x-squeak-account` token; strict body, `macId`
  16-64 of `[A-Za-z0-9_-]`, `name` at most 64 printable characters). Returns `{macId, key, createdAt, rotated, header, namespace, limits}`
  once: the key is 32 random bytes (base64url) and only its SHA-256 is stored. Calling it again for the same Mac rotates
  (the old key stops working at once). At most 10 Macs per account (`409 {error:"too-many-macs"}`); a `macId` owned by another account is `403`.
- **Use**: header `x-squeak-mac-key: <key>` instead of `x-squeak-relay` on `/doc`, `/list`, `/ping`, `/token`,
  `/pond-token`, `/pond-revoke`, `/account/link`, `/account/unlink` and `GET /account/avatar?userId=` (own user only). Both headers together, an unknown, revoked or malformed key: bare `401`.
  Phones keep working unchanged: the pairing grant's `ck` is the Mac's key, so a phone holds one Mac's access, never the operator's.
- **Namespace** = first-writer-wins channel claims. A Mac's own channel is its `macId` (when 22+ characters; claimed at provision
  for the account), and any other channel id (its ponds) is claimed by the first Mac key to touch it, recorded under `channel-owners`
  and refused to every other Mac (`403`), at most 64 per Mac. Chosen over deriving ids from the macId because ponds are
  channels with their own random ids and the daemon and phones already build paths as `channels/<id>/<kind>`: nothing changes there.
  Claims survive revocation, so a revoked or deleted Mac's channel cannot be taken over by another account.
- **Streams and opaque notices**: every tenant shares the one `squeak_notice` channel, so with `SQUEAK_RELAY_HOSTED=1` a notice carries no path
  and no kind: `{"t":"<tag>"}`, where tag = the first 22 characters of base64url(SHA-256(`"squeak-notice-v1:" + channelId`)) (pinned vector:
  channel `"A"`x30 gives `uhjd2c2uhsob5iRwl6Scxr`; `scoped.noticeTag`, `noticeTag` in `src/cloud/catalyst-store.ts`). Channel ids are secret
  to other tenants, so a tag can't be linked to a channel without knowing its id; clients compute it themselves, no server secret. Without the
  flag (self-hosted, one tenant) notices stay `{"p":"channels/<id>/<kind>"}`. `/token` with a Mac key returns the shared token pair; `/ping` omits the
  stream id for it. A notice only wakes a pass (the kind is gone, so any change on the channel wakes one); data is always re-read through the store.
  Receivers: the daemon accepts both shapes and, on `t`, wakes only the watchers of the channel the tag names. The web guest page wakes on every
  notice without parsing it, so it needs nothing. iPhone's `CatalystClient.notice` reads `p` and treats anything else as a resync (re-reads
  everything): `t` works unchanged but wastefully; to match it would compute the tag (CryptoKit SHA-256, base64url, 22 chars) of each watched channel and yield only matching listeners.
- **Header and link rows**: the relay also treats an `x-squeak-relay` value that is not `RELAY_KEY` (compared first, constant time) as a Mac key, same lookup,
  confinement and quota, because phones, the voice add-on and the daemon's `readLocation` send a grant's `ck` under that header. Provision writes the
  `accounts/<userId>` and `maclinks` rows `/account/link` writes (the same code; only for a 22+ character `macId`; a rotate keeps `linkedAt` and the name), so "Your Macs"
  and device requests work without a ticket; `DELETE` removes them and the Mac's pending device requests.
- **Daemon side** (`src/cloud/hosted.ts`): a hosted location sends `x-squeak-mac-key`. `cloud.json` holds `"active": "hosted"` and
  `hosted: {provider, url, macKey, macId, hosted: true, email?}`; `hosted-account.json` (0600) holds the account token only until provisioning succeeds.
- **Revoke**: `DELETE /account/macs/<macId>` (owner only; `404` unknown, `403` other account) deletes the key hash; the key then gets `401`.
- **Limits** per account (all its Macs together, UTC day): `SQUEAK_RELAY_DAILY_REQUESTS` (default 50 000: about a Mac and a phone
  polling every 10 s) and `SQUEAK_RELAY_DAILY_BYTES` (default 20 MiB of written documents, the shared Firebase server's
  `SHARED_DAILY_BUDGET_BYTES`); over either: `429 {error:"quota"}`, reset at 00:00 UTC. Counters are cheap on purpose: a warm
  instance keeps them in memory, re-reads the store once a minute and writes every `SQUEAK_RELAY_QUOTA_BATCH` (default 10) charges,
  so the limit can overshoot by about that many per warm instance; set the batch to 1 for exact counting.
- **Relay-owned partition keys** (no `channels/<id>/<kind>` shape, so no `/doc` or `/list` path names them, like `avatars`):
  `mac-keys` (hash to `{userId, macId, createdAt}`), `mac-owners` (macId to `{userId, hash, name, createdAt, channels}`),
  `mac-user/<userId>` (the account's Mac count), `channel-owners`, `usage` (userId to `{day, req, bytes}`).

## Daemon control routes (token-gated `x-squeak-token`, no CORS, like every `/control/*`)

- `GET /control/cloud` answers `{ active, hosted, firebase: { configured, projectId, databaseUrl, lastTest }, catalyst:
{ configured, projectId, projectName, dc, appUrl, lastTest } }`. `hosted` is the block the Mac app draws
  (`cloud/hosted.ts`: `needs-sign-in`, `connecting`, `ready`, `error`).
- `POST /control/cloud/hosted/connect` `{}` starts or restarts the hosted connection with what is linked (202; 409
  `not-signed-in`).
- `POST /control/cloud/move-now` `{}` runs a move that was held (202; 409 `not-signed-in`).
- `POST /control/cloud/hosted/relay` `{ relay }` sends device traffic to a pinned relay base, or `null` to put it back
  on the account origin.
- `POST /control/cloud/test` `{ provider }` answers `{ ok, writeMs, readMs, noticeMs, error? }` (a throwaway random
  channel, written, watched, read and deleted; never real channel data).
- Self-hosting is gone. The old routes to pick a Catalyst project, deploy a relay, select a provider or set up Firebase
  answer `410 self-hosting-removed`. Errors are fixed sentences; never a CLI's raw output or a token.

## History in the cloud (relay 1.5.0)

Kind `hist` (`channels/<id>/hist/<doc>`): a sealed copy of the Mac's recent chats for a device that cannot ask the Mac
(asleep, or new). Reads by id with the channel's key; `GET /list` of `hist` is 403. `PUT` and `DELETE` also need
`x-squeak-hist: <token>`, whose hash the Mac registered with `POST /account/macs/hist-token {channel, token, previous?}` (its own
key; registers or rotates it, replacing the old token; another Mac's key gets 409). A store write over the account's cap (50 MB, 4000 documents, kept in
`hist-usage/<userId>`; a replacement counts as the difference) answers 413 `{error:"cap"}`. Only the index document `idx`
sends a change notice. Design and client behaviour: docs/remote-channel.md, "History cache", Layer 2.
