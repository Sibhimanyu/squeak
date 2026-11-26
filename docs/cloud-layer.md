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
