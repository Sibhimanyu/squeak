# Ponds: multiplayer Squeak (Flotilla)

Ponds are on by default. `SQUEAK_FLOTILLA=off` disables them. The two-Mac flow is covered by
`src/flotilla/journey.e2e.test.ts` using a test store.

## Every project is a pond (local ponds)

Each project has a Pond. The host reuses the existing record for the project. A local Pond works without sign-in.
Its `local: true` record and key stay in `flotilla/ponds.json` until it is shared.

**The first invite publishes.** Sign in under **Settings › You › Account** to connect to Squeak's hosted relay.
The host publishes the Pond's metadata and the Owner's membership before issuing the invite. A failed publish keeps
the local Pond's ID and key so it can be retried.

Use [GLOSSARY.md](../GLOSSARY.md) for product terms. The wire and source still use names such as `project` and `thread`.

## Who can do what

A Pond can use any folder. Members see the Ducks that are not Private. By default,
Members work with Ducks on the Owner's Mac. The experimental `SQUEAK_POND_OWN_THREADS=on` lets Members of a Git
Pond run their own Ducks and share their chats. Code moves through Git.

A Member can read, view changes, message, steer and answer; a Viewer only reads. The Duck's starter
handles approvals and Stop on the Mac that runs it. A question hold expires 2 minutes after its last renewal.
Other readers see who is answering.

- **Three roles: Owner, Member, Viewer.** Only the Owner invites, removes, changes roles and decides what a Member asked
  for. Approving edits and Stop are the Owner's alone, on every Duck in the Pond, including one a Member asked for (it
  runs on the Owner's Mac); a Member or a Viewer never. A **Viewer** reads and posts nothing. A **Member** reads, posts in
  the Room, messages Ducks, answers questions and makes Tasks or asks for a Duck; **Tasks and new Ducks always wait for
  the Owner's approval**, because they spend the Owner's tokens. There are no per-Member switches (finer permissions come
  later): an old `MemberDoc.canStartTasks` is ignored. The Owner changes a role from People
  (`POST /ponds/<id>/members/<memberId>/role { role }`); it takes effect on the next read and is a Ripple.
  Migration: old documents' `caps`, presets, `muted`, `canStartTasks`, per-Duck `locked`/`allow`/`deny` and machine grants
  are ignored (an old Viewer is a Viewer, every other role a Member); the `caps` the pond view still sends is derived from
  the role (`capsOf`) only so older clients decode it (`start` is true for a Member: it means "may ask").
- **A Member's Duck waits for the Owner.** The Member's `start` command is verified on the Owner's Mac like any command,
  then recorded, not run: `LocalPond.pendingStarts` (never in the cloud) holds who asked, the first message, agent, model
  and title; a Ripple says "asked for a duck". The pond view carries `starts` (all of them on the Owner's Mac with the
  first message; the Member's own on theirs, `mine: true`, title only, kept in `LocalPond.asked`). The Owner's Dashboard
  shows them in Needs you with Approve and Decline: `POST /ponds/<id>/starts/<requestId>/approve` starts the Duck through
  the normal start path (the Owner's default permission mode, never `bypassPermissions`) and delivers the first message,
  and the Member's Mac opens it by `requestId`; `.../decline` drops it and writes a Ripple ("declined the duck ...")
  whose `ref` is the `requestId`, which is how the Member's Mac stops showing "Waiting for <Owner>". A request lapses
  after a day; at most ten wait per Member; one from someone no longer a Member cannot be approved. The sender's Mac
  does not refuse a start any more; only a Viewer is refused ("Viewers can read but not send.").
- **Private Ducks.** A Private Duck is its starter's alone: its thread document and events are never written to the cloud,
  and every reader skips one that says `private`. Ducks shared in a Pond before its first invite are set Private by that
  invite (`LocalPond.invited`; a Pond that already has other members is past it); Ducks shared after are visible. Making
  one visible is the Duck's Private toggle (`POST /ponds/<id>/threads/<tid>/visibility { private: false }`).
- **Enforced on the thread's Mac, never trusted from the client**: `verifyCommand` reads the member list at that moment, so
  a role change takes effect on the next command and a client that skips its own check is refused with a fixed sentence
  ("Viewers can read but not send."). The sender's Mac checks the live member list too, not its cached role.
- **Mac UI**: People menu per member (Make viewer / Make member), the Dashboard's Needs you (Approve and Decline for a
  Member's Task or Duck; the Member reads "Waiting for <Owner>"), the thread
  header's Private toggle, composer disabled with the reason for a Viewer, rows of own threads carry the powered-by mark.
- **Phone and web**: the phone's pond-threads doc (`pondthreads`) carries optional `flock` and `access` (`canMessage`,
  `reason`), read by the Mac from the pond itself (`NativePhone.pondFlock`); older fields such as `locked` may still
  appear and are ignored. The web guest page derives what a role may do the same way (`capsOf`), disables the composer for a
  Viewer with the reason and shows the powered-by mark. Approvals and Stop are never grantable.
- **Journey test** also covers the account-based invite: a short code through the relay double, a signed-in member (named from the account), approval, then a message.

## Trust

The phone channel's rule holds: **a Mac trusts a key, not a server.**

- Every pond has a random 32-byte **pond key**. Every document is sealed with it (AES-256-GCM, AAD = its path), so the cloud
  holds opaque boxes.
- Each member is a Squeak account with a P-256 **device key** per device (one for a first-time member; see "Members are accounts"). Every command is signed; the receiving Mac checks membership, role, the thread
  not being private, expiry (≤ 10 min) and a fresh nonce, then runs it through the host's normal send path.
- An invite is a code carrying pond id, pond key, store location and one-time secret. Using it writes a join request. The Owner approves a general invite. An email invite can be approved
  automatically by the Owner's Mac when the relay verifies the matching account. The Owner's Mac signs the membership.
- Removing a member rotates the pond key (a new key sealed to each remaining member's public key).
- A guest's message drives an agent on the starter's Mac. So a thread running with `bypassPermissions` refuses other members'
  messages, and they never match the thread's "allow for this chat" rules unless its starter opts in.
- Accounts (Catalyst sign-in) name people: a member's `accountId` and display name come from the relay-verified Squeak account (see "Names"); the member key is still what authorises. A member with no verified account is the "Signed-out member".

## Transport

Shared Ponds use `CloudStore` (`src/cloud/store.ts`) on Squeak's hosted Catalyst relay. A Data Streams notice
wakes a read through the store. Existing Realtime Database installs can use their legacy store until they move.

Each Pond has one channel at `channels/<pondChannelId>/<kind>/<doc>`. The relay's `kinds.json` lists its document kinds.

- `pond`/`meta` — name, owner, gitRemote?, created.
- `members`/member id — name, public key, role, nest name, owner's signature.
- `joins`/request id — name, public key, one-time secret proof.
- `threads`/thread id — title, starter, nest, agent, model, state, private, mode, updated.
- `tevents`/`<thread>-<seq>` — a batch of normalized thread events.
- `presence`/member id — online, viewing thread, typing, `at`; lives 4 min (older writers: 45 s).
- `holds`/request id — who is answering, expires 2 minutes after renewal.
- `tcmds`/command id — a signed message, steer or answer.
- `ripples`/time-ordered id — one activity line.
- `keys`/member id — the rotated pond key sealed to that member.
- `room`/post id — one Room post, written only by the Owner's Mac (see "The Room reaches Members").
- `rposts`/time-ordered id — a Member's Room message waiting for the Owner's Mac.
- `rtasks`/task id (`:` as `-`) — a Task as Members see it, written only by the Owner's Mac.

Live output is batched at 250 ms, never token by token. Each event has a per-thread `seq`; a client resumes from its last `seq`.
`tevents` keeps the newest 500 per thread; the starter's Mac remains the source of history.

Normalized event (`ThreadEvent`): `{ seq, at, type, ... }`, with type one of `user` (`by`, `text`), `agent` (`text`), `thinking` (`text`),
`tool` (`label`, `state`), `question` (`requestId`, `text`, `options`), `approval` (`requestId`, `label`; shown, never answerable
remotely), `resolved` (`requestId`), `state` (`state`), `changed` (`files`, `added`, `removed`, `paths` up to 200, and per-file `diff`
up to 64 KB on request through `tcmds` `diff`).

## Host routes (`x-squeak-token`, no CORS, under `/native`)

- `GET /ponds` → `{ ponds: [PondSummary] }`
- `POST /ponds` with `{ name, projectId? , rootPath? }` → `{ pond }`
- `GET /ponds/<id>` → `{ pond, members, threads, ripples, presence, holds, joins, me }`
- `DELETE /ponds/<id>/members/<memberId>` → owner only; rotates the key
- `POST /ponds/<id>/invites` with `{ role, short? }` → `{ code, expiresAt, link? }`, or with `short: true` `{ short, expiresAt, id, inviteExpiresAt }` (`link` only when an invite link base is configured)
- `POST /ponds/<id>/invites/email` with `{ emails, role? }` → `{ sent: [email], failed: [{ email, reason }] }` (owner; 1 to 10 addresses, role member or viewer; publishes a local pond first; an email-bound invite per address, the relay sends the links; see "Invite by email")
- `POST /ponds/join` with `{ code }` → `{ pondId, status: "pending" }` (`code` is the code or the link; needs a signed-in Squeak account, else 401 "Sign in to Squeak to join a pond. Your name comes from your account."; an old client's `displayName` is ignored)
- `DELETE /ponds/<id>/invites/<inviteId>` → `{ id, state: "revoked" }` (owner; an unused invite only; ends its relay join token first)
- `POST /ponds/<id>/joins/<requestId>` with `{ approve, role }` → `{ ok }`
- `POST /ponds/<id>/threads` with `{ text, agent, model }` → own thread on this Nest; needs a git remote
- `POST /ponds/<id>/share` with `{ sessionId, private? }` → publishes a host chat as a thread
- `POST /ponds/<id>/threads/<tid>/visibility` with `{ private }` → starter only
- `GET /ponds/<id>/threads/<tid>/events?after=<seq>` → `{ events, lastSeq }`
- `POST /ponds/<id>/threads/<tid>/messages` with `{ text, mode?: "queue"|"steer" }` → `{ ok, queued }` (on someone else's thread `queued` is true: it waits for the starter's Mac)
- `POST /ponds/<id>/threads/<tid>/answers` with `{ requestId, answer }` → `{ ok }` or 409 with who holds it
- `POST /ponds/<id>/threads/<tid>/hold` with `{ requestId }` → `{ ok, heldBy }` or 409 `{ error, heldBy }`
- `POST /ponds/<id>/presence` with `{ viewing?, typing? }` → `{ ok }`
- `GET /ponds/stream` → SSE; `event: changed`, data `{ pondId }`, never content

Shapes: `PondSummary { id, name, role, memberCount, threadCount, needsYou, gitRemote?, tint }`; `Member { id, name, role, nest: string | null, online, you }` (`nest` is null for a web guest);
`PondThread { id, title, starter, starterName, nest, agent, model, state: "idle"|"working"|"waiting"|"error", private, mode: "own"|"shared", sessionId?, permissionMode?, workspace?, branch?, participants?, updatedAt }` (`sessionId` is local to the starter's Mac and never written to the cloud; `permissionMode` is, so a guest sees why a message is refused; `workspace` and `branch` are the starter's workspace name and branch, filled when a chat is shared or an own thread is started from the host session's workspace; `participants: { memberId, name, lastAt (ISO-8601) }[]` is the starter plus everyone whose message ran in the thread, newest activity first, at most 50. The starter's Mac keeps the running set in `ponds.json` as turns pass through the bridge (private threads too) and republishes the thread document when someone new joins; other members read it from the document. All five are optional: older threads and older clients simply lack them, and every decoder must ignore what it does not know);
`Ripple { id, at, actor, text }`; `Hold { requestId, by, byName, until }`;
`JoinView { requestId, name, nest: string | null, client?: "web", role }` (the role the invite offered); `Presence { memberId, online, until, viewing?, typing? }`
(`typing` is the **thread id** being typed in, not a flag; `POST .../presence` takes the same: `{ viewing?, typing? }` as ids);
`me { id, name, role, nest }`. `PondSummary` also carries `projectId?` (local to the host: the project the pond was made from, set by
`POST /ponds { projectId }`, never written to the cloud or an invite) and `status`. A 409 from `hold` and `answers` is
`{ error: "<name> is answering", heldBy: "<name>" }`; a pending join returns its state with no shared content.
The Mac's decoders are pinned to the real answers saved by `scripts/make-pond-fixtures.ts` in `macos/Tests/SqueakMacCoreTests/Fixtures/ponds/`. Roles: `owner`, `member`, `viewer` (viewers only watch).

## Wire details (as built, `src/flotilla/`)

- Document: `{ box, sig, device, at }`. `box` = `<keyVersion>.` + base64(nonce12 || AES-256-GCM ciphertext || tag16), AAD = the
  document's path. `sig` = ECDSA P-256 / SHA-256, `r || s`, over the UTF-8 bytes of `<path>\n<box>`; `device` = the signer's member
  id (`base64url(sha256(publicKey)[0..12])`, so an id is derived from a key, never claimed). A reader drops any document whose
  signature does not verify under the key the members list gives that id.
- Who signs what: `pond/meta`, `members/*` and `keys/*` by the owner (the owner's key is pinned in every invite, so the pond key
  alone cannot forge a member); `joins/*` by the joiner's own key; `threads/*`, `tevents/*` by the starter; `tcmds/*`, `presence/*`,
  `holds/*`, `ripples/*` by their writer. `keys/<member>` is the pond key sealed to the member's public key (ephemeral ECDH,
  HKDF-SHA256, AES-256-GCM) and signed by the owner; rotation writes a new key version, old versions still open old documents.
- Invite code: `squeak-pond:` + base64url JSON `{ v, p pondId, k key, kv version, o ownerKey, n name, s secret, e expiry, r role, l location }`.
  The join request carries `HMAC(secret, requestId || "\n" || publicKey)`, not the secret; an owner lists only requests whose proof
  matches an unexpired invite, and the decision (a person on the owner's Mac, `POST .../joins/<id>`) consumes the invite.
  An invite has a state: `pending | accepted | declined | expired | revoked` (`PondView.invites` for an owner: `{ id, role, state, expiresAt }`,
  never the code or secret; `POST /ponds/<id>/invites` also answers `id`). Expiry (24 h) is computed and persisted lazily; only a pending
  invite matches a join proof, so a declined, revoked or expired one cannot be used again. A decline tells the requester "The owner
  declined your request to join." and writes a Ripple; a revoke ends the relay join token, drops requests waiting on it and writes a Ripple.
  Invites saved before states have none and read as pending until they expire.
  Approval also writes the member's `keys` document, so a key rotated since the invite still reaches them.
- **Short codes are gone (2026-11-26, #122).** The relay's `/ponds/short` routes, the Mac's `{ short: true }` invite and joining by a six-character code were removed with the other obsolete kinds (see "The Room reaches Members" below); an invite is an emailed link.
- **Matching words** (`src/flotilla/join-words.ts`, Swift `JoinWords`, web `join-words.js`, fixture
  `macos/Tests/SqueakMacCoreTests/Fixtures/ponds/join-words.json`). Three words from a committed list of 256 plain words:
  SHA-256 over `"squeak-pond-words-v1\n" + ownerKey + "\n" + joinerKey + "\n" + pondId` (UTF-8, the keys as the base64 strings
  the documents carry), the first three bytes pick the words. The owner's approval card (`joins[].words`) and the joiner's
  waiting screen (`PondSummary.words`; web `record.words`) show the same three, for long invites too. A relay that swapped the
  owner's key in the details makes the joiner seal to the wrong key (the owner never sees a request) and one that forged a
  request with its own key shows different words on the two screens. 24 bits: it makes a swap visible to two people who compare,
  it is not a secret. Regenerate the fixture with `npx tsx scripts/make-join-words-fixture.ts`; never reorder the list.
- A pond is its channel: pond id = channel id (`channels/<pondId>/<kind>/<doc>`, 22 to 64 url-safe characters).
- Commands (`tcmds`): kinds `message`, `steer`, `answer`, `diff`, `start`; anything else (`approve`, `stop`, ...) is "not a command this Mac
  runs". `answer` runs only for a `question` request. The starter's Mac checks, in order: member, signature, current key version,
  readable, thread is its own, role (viewer refused), thread not private, expiry, life <= 10 min, issued not > 2 min ahead, nonce
  new (kept until expiry). It then deletes the command whatever the outcome; a refusal is a fixed sentence in the ripples.
- Messages from others are refused while the chat runs `bypassPermissions`. While a member's work runs the host skips the chat's
  "allow for this chat" rules (`SessionHost.setGuestTurn`); the starter's own turns still use them. Each member message is preceded
  in the starter's transcript by a note "<name> sent the next message." and its `user` event carries `by` and `byName`.
- Holds: first writer wins, read back after writing; a hold someone else owns answers 409 naming them. The starter's Mac refuses an
  `answer` whose sender is not the holder, and deletes the hold when the request resolves. A late answer is 409 ("already answered").
- Events: batches of up to 250 ms, one `tevents` document per batch named `<thread>-<firstSeq>`; the newest 500 events are kept;
  a resume past a pruned range reports `gap`. A private thread has no thread or event documents at all (making it private deletes
  them; making it public again backfills from the chat).
- Presence lives 4 minutes (`PRESENCE_TTL_MS`; an older writer expires after 45 s); the host writes it only when it changed (at most every 5 s) or every 2 minutes; ripples keep the newest 100.

## Web guests

Some people only need a shared thread and will use a web app (desktop or phone) with no Squeak install. Nothing in the model
assumes a Mac.

1. A member may have **no Nest**: `nest: null`, `client: "web"`. They watch, see diffs, message, steer and answer on shared threads
   exactly like a member, but cannot start own threads or share chats (there is nothing to run them on).
2. Everything a member does is **browser WebCrypto**: ECDSA P-256 signatures (raw `r || s`, the public key as a raw uncompressed
   point, the private key PKCS#8), AES-256-GCM with additional data, ECDH P-256 + HKDF-SHA256, HMAC-SHA256. The canonical signing
   encoding is the UTF-8 of `<path>\n<box>`. `src/flotilla/fixtures/web-vectors.json` has a vector for each (signature, sealed
   document, rotated-key envelope, join proof, member id); `crypto.test.ts` verifies them with `crypto.subtle` alone.
3. Invites also have a **link form**, `<relay origin>/app/index.html#<code>`: the code is in the URL fragment, which a browser never
   sends, so no server sees the secret (the page reads it, then takes it out of the address bar). The host's `POST /ponds/join` accepts
   either form. The Mac builds the link from `cloud.json`'s Catalyst `appUrl` (`guestInviteBase`, `<origin>/app/index.html`, the relay origin for a hosted Mac, the same origin as the Mac pairing link; old `squeak-mac.web.app/join` links forward there); with no
   Catalyst app domain (Firebase, or not deployed yet) an invite has no link, only the code. The page is Catalyst **web client hosting**
   in the relay's own project (`cloud/catalyst-relay/client`, assembled by `scripts/build-guest-client.sh`), so it is served from the same
   origin as the relay (`/server/squeak_relay`) and reaches it by a relative path; served anywhere else it uses the relay URL the invite
   carries.
   A guest's member key is one P-256 point used for both ECDSA and ECDH, and WebCrypto binds a key to one algorithm: the browser
   makes the pair extractable, imports the private half twice as non-extractable keys and drops the extractable copy; only the
   non-extractable keys are kept (IndexedDB). The invite's secret is used once for the join proof and never stored.
4. A web guest is **not handed the store-wide relay key** (it opens every channel in the store). On approval the owner's Mac asks the
   relay for a pond-scoped token (`POST /pond-token { pondId, memberId, ttlSec }`, relay key required), which the guest receives
   sealed to their member key. `cloud/catalyst-relay/functions/squeak_relay/scoped.js` + `handler.js` implement it:
   - `pt.<pondId>.<memberId>.<expiry>.<mac>`, HMAC under the relay key; sent as `x-squeak-pond-token` instead of `x-squeak-relay`.
   - Valid only for `/doc` and `/list` inside that pond's channel; writes only to `presence`, `tcmds`, `joins`, `holds`, `ripples`,
     `rposts` (never `room`, `rtasks`, `members`, `keys`, `threads`, `tevents`, `pond`). Reads are of sealed documents only.
   - Revoked on removal (`POST /pond-revoke`, a record in the store the relay checks on every request); a new token lifts it.
   - Data Streams: a guest may subscribe only to its pond's own channel (`POST /pond-stream { name }`, channel name derived from a hash
     of the pond id), which the relay also notifies on every write in that pond; it never gets the store-wide `/token`.
     The flotilla service issues and stores these tokens, and a joiner's store is opened with the pond token (`storeFor` in
     `src/flotilla/index.ts`). The SDK call that creates a pond's stream channel is not wired (the relay answers 503 until the
     channel exists). The web UI is `web/join.html`
     (docs/web-app.md, "Web guests"); it uses `/pond-stream` with a 60 s safety poll, so it works without that channel.
     A Mac invite for a Catalyst store carries the relay URL and a join-only token (`jt`), never the relay key.

5. **Sign in to join.** The hosted relay requires a Squeak account (`GUEST_SIGNIN=required`). It records verified
   identity in `joinids/<requestId>` for the Owner's Mac. The invite's join token (`pj`) is limited to the request.
   Approved browser members receive a pond-scoped guest token (`pt`) sealed to their key. Email-bound invites also
   require the signed-in email to match. Account sign-in and relay tokens do not replace the Owner's signed membership.

## Tasks, claims and scope locks (removed)

Removed 2026-11-26 (#122): the `tasks`, `claims` and `locks` kinds, `coordination.ts`, `tasks.ts`, `scope.ts` and their routes (`/ponds/<id>/tasks`, `/locks`). The Room's own Tasks (`rtasks`, below) are the only Tasks. The same change removed the `ripples` and `presence` kinds and the `grants` kind: what happened in a Pond is a Room line from the Owner's Mac, and who is online comes from live connections (cloud-layer.md, "Live notices").

## Members are accounts (2026-11-17)

A pond member is a person's Squeak **account**, not one device's key. Someone who joined in a browser and later signs in on
the Mac app (or the iPhone app) gets the pond there with no invite, no code and no approval prompt. Each device still has its
own key; the member is the account those keys belong to.

- **Data model: devices live in the member document.** `MemberDoc` (owner-signed, sealed with the pond key, as before) gains
  optional `devices: [{ id, publicKey, boxKey, client: "mac"|"web"|"ios", nest?, addedAt }]` and `primaryRetired?: true`. The
  document's own `publicKey` (and `id = memberIdOf(publicKey)`) is device number one, so every existing single-key document is
  already a one-device member and is read unchanged; old clients that do not know `devices` still decode it and simply treat the
  member as their first key. A separate device document kind was rejected: role, names and removal
  are already one owner-signed document per member, and a second document would need its own ordering against it (a device could
  outlive a removal, or be listed before the key reached it). `id` of a device is derived from its key and a reader drops a
  device whose id is not its key's, repeats, or is past 8 (`MAX_DEVICES_PER_MEMBER`). `boxKey` is the key a pond key is sealed
  to; it equals `publicKey` for every client today. `primaryRetired` is how the first key is removed on its own: the member id
  (a hash of that key) must not change, so the document keeps `publicKey` and stops counting it.
- **Signatures.** A signed document's `device` field stays the **member id**; it verifies under any of the member's current device
  keys (`keysOfMember`). So `verifyCommand` and every reader (threads, tevents, presence, holds, ripples, tasks) accept a
  second device without knowing about it, and thread starters, holds and nonces (all by member id) apply to
  every device. A device that is not the first finds itself by its key id among members' device ids (`memberOfDevice`) and acts as
  that member (`pond.memberId`). Its `keys/<deviceId>` document (the pond key and a per-device pond token, sealed to its `boxKey`,
  signed by the owner) is read by its own key id.
- **The trust argument.** "A Mac trusts a key, not a server" stays the default. The one exception is the one a person's own
  devices already have (docs/remote-channel.md, "Web accounts"): a device whose request the relay wrote for account X is added by the
  owner's Mac only when a member document of that pond carries `accountId` X. The owner's Mac is the only writer (it holds the owner
  signing key), and it seals the current pond key to the new device's key; no pond key travels unsealed, and the relay never holds
  one. The relay can vouch for an account only as it already could (it could forge a `joinids` note or an own-device request);
  a forged claim reaches at most the pond of an account the owner already listed. A member with no `accountId` (joined signed out)
  cannot attach devices: they re-join by invite, and nothing claims such a member for an account. The owner's own member document
  never takes devices (its signing key lives on one Mac).
- **Relay (1.7.0), routes.** (1) `POST /ponds/<pondId>/members/accounts` `{ ownerKey, name?, add: [userId], remove: [userId] }`,
  the pond's own Mac only (`channelAllowed`, the same ownership the other owner routes use) or the operator's key: the **account
  index**, relay-owned rows `acctponds/<userId>` / `<pondId>` = `{ ownerKey, name?, at }`, written only by that route and read only
  by (2). The owner's Mac writes it when it approves a member that has an `accountId`, on removal, and every 30 minutes for every
  member (so existing members of older ponds join the index at the first pass; `reconcileAccountIndex`). (2) `GET /account/ponds`:
  a Mac's own key or an account token (`x-squeak-account`); never the operator's key, a pond token or nobody (401). Answers
  `{ ponds: [{ pondId, ownerKey, name? }] }` for the caller's own account only. `ownerKey` is what a new device pins; like a short
  code's details it comes through the relay, but it only lets a hostile relay show a fake pond: the real pond key never reaches
  anyone but a device the real owner's Mac adds. (3) `POST /account/pond-devices` `{ pondId, publicKey, boxKey?, client, nest? }`
  (same callers): the account must be in that pond's index (403 `pond`), at most 10 requests a minute per account (429 `rate`), a
  device the owner removed is refused (403 `removed`, the relay's revocation record). It writes the relay-owned plain document
  `channels/<pondId>/devreqs/<deviceId>` = `{ v:1, reqId, userId, email, name, publicKey, boxKey, client, nest, at }` (no client
  token can read or write that kind; its presence **is** the attestation, exactly as `joinids` is for email invites) and answers
  `{ reqId, token, expiresAt }`: a join-scope pond token for that device id (24 h), with which the device reads what the owner
  writes back. `deviceId = base64url(sha256(publicKey)[0..12])`, so a retry replaces itself.
- **Owner's Mac.** On each refresh `adoptDeviceRequests` lists the pond's `devreqs`; for each it checks the request is well
  formed (both keys on-curve P-256, the id is the key's, at most 24 h old), that a **member of this pond has that `accountId`** and is
  not the owner, that the member has fewer than 8 devices, and that at most 5 devices were added to this pond in the last minute (the
  rest stay on the relay). It then writes `keys/<deviceId>` (the pond key and a device token) **before** the member document lists the
  device, deletes the request. No Ripple and no event: a device is never shown in a pond (#129). A request for
  a device already listed only sends its key again.
- **This Mac as a later device.** `syncAccountPonds` (at start, on sign-in `POST /native/ponds/sync-account {}`, at most every 5 min
  from list/refresh) calls `GET /account/ponds`; for each pond this Mac has no record of, it sends a device request and keeps the
  returned token as a pending pond with `deviceJoin: true` (no invite, no words, no approval screen). The ordinary refresh finds the
  member whose devices include this key, takes the pond key from `keys/<its id>` and the pond is active. A request nobody answers
  in a day, or a token the relay refused, leaves nothing behind and is asked again later. A pond already here in any state is left
  alone; a refused request is not repeated for 15 minutes.
- **Removal.** Removing a member (owner) revokes **every** device's token, writes each a "removed" note, removes the document, drops
  the account from the index and rotates the pond key, as before. `removeDevice(pondId, memberId, deviceId)` (`POST
/ponds/<id>/devices/remove`) removes one device (the last one is the member): its token is revoked at the relay (so it can never
  ask again), it gets the note, the member document drops it (or sets `primaryRetired`) and the pond key rotates; the person's other
  devices keep working. A member ends one of their own devices with `POST /ponds/<id>/devices/remove-mine { deviceKeyId }`: a
  Ripple "removed my device <id>" that the owner's Mac reads (only for a device the writer owns) and then does the same removal;
  `view()` hides that Ripple (and any older "added/removed a device" one), and the removal writes none.
  Leaving a pond is leaving as a person: every device goes.
- **Surfaces.** `view().members[]` is one row per person and carries nothing about devices (no count, no `ownDevices`; older
  clients treat both as optional). Neither the Mac's People list nor Pond settings mention devices. Devices live in Settings ›
  Your devices (Mac), one list for the account: `GET /native/ponds/account-devices` (the account's devices, this one marked) and
  `POST /native/ponds/account-devices/remove { deviceId }`. The relay removes the device from the account and writes
  `revoked/<pond>/<deviceId>` for every Pond the account is in, so its tokens are refused at once, and a relay-owned removal
  note `{v:1, reqId, userId, gone:true}` in each Pond's `devreqs`; each Owner's Mac reads it when online (`dropAccountDevice`):
  seals the device a removal, drops it from its member and rotates the key (a rotation that failed is finished by the next
  pass). A device registers itself under the account when it syncs (`POST /account/devices`) or asks to join a Pond. A new
  device's Pond is `status: "pending"` with `connecting: true` and the sentence "Connecting: waiting for <Owner>’s Mac" until the
  Owner's Mac seals the key; the Mac draws it with no button. The web signs in, asks `GET /account/ponds` on load and requests each pond
  it does not hold. The iPhone reads shared Pond and Room views through the Mac. See “The Room on iPhone” below.
- **Migration.** Nothing is rewritten. Existing documents are one-device members. An owner's Mac adds the accounts of members that
  have an `accountId` to the relay index at its first pass after the update; a member who joined with no `accountId` stays one device
  and re-joins by invite to attach an account. The email copy "you can add the Mac app later" is now true.

## Invite by email (2026-11-17)

The owner's way to bring people in: no code, no QR. Type one or more addresses in the invite sheet (Mac) and each person
gets an email; opening the link and signing in to Squeak **with that address** puts them in the pond at once, with no second
approval on the owner's Mac.

- **One invite per address.** `FlotillaService.inviteByEmail(pondId, emails, role)` makes an email-bound invite for each
  (`invite(..., email, { keyless: true })`): a relay join token pinned to the lower-cased address (`pins/<pondId>`,
  `/pond-token` with `email`), a week's life, and a link `https://squeak.onslate.in/join#<code>`. The code is **keyless**
  (`k: ""`, `kv: 0`, like a short code's details) and names the address (`em`), so an email never carries the pond key: it
  reaches the member sealed to their own key when the owner's Mac lets them in (`sendKeyTo`). `FlotillaService.join` and the
  web's `readInvite` both read `k: ""` as keyless.
- **Delivery.** The Mac calls the relay's `POST /ponds/<pondId>/invites/email` (its own key) with `{ emails, inviteUrls,
pondName, inviterName }`; the relay sends one email per address through Catalyst Mail (docs/cloud-layer.md, "Invite
  email") and answers `{ sent, failed }`. An address whose email did not go out has its invite withdrawn quietly (token
  revoked, no Ripple) and comes back in `failed` with a fixed sentence (limit, mail down, cloud unreachable). Limits: 20 emails
  per Mac per day, 10 per pond per hour.
- **Who is let in.** The relay enforces the pin: a join request written under that token by a signed-in account whose
  verified email (case-insensitive, trimmed) differs is `403 { error: "email", masked }`; a signed-out one is `401 signin`.
  On an owner's refresh, `autoApproveEmailJoins` approves a join request only when all three hold: it proves that invite's
  secret, the invite is still pending, and the relay-written `joinids` email equals the invite's address. It then runs the
  ordinary `decideJoin` (member named from the account, the "joined" Ripple, the `member-joined` event), so the owner is told
  in the Mac's usual Ripple path. A mismatched or missing verified email never auto-approves. An ordinary invite is
  never auto-approved.
- **The page** (web/join, the Slate origin): pond name, who invited you (initials), "Squeak lets a team watch, steer and talk
  to coding agents together.", **Sign in to join** (Zoho, Google or email; a new person makes the account right there).
  Sign-in goes through `/account/handoff` and returns to exactly `https://squeak.onslate.in/join` (the relay allows that path
  and `/`); the invite was parked in IndexedDB before leaving, so the fragment survives the round trip. Signed in with another
  address the page says "This invite is for p***@e***.com. Sign in with that address." with one button, "Sign out and switch
  account" (it knows the masked address from the link, or from the relay's refusal). After joining, a dismissible card offers
  Squeak for Mac (https://sibhimanyu.github.io/squeak/). There is no "Open in Squeak" button: the Mac app registers no
  pond-opening URL scheme.
- **Mac.** The invite sheet is the email form (tokens, Member/Viewer, Send invites, a row per address). "Copy invite link" is a
  small secondary action (an ordinary link that still waits for approval). The parsing and limits live in
  `SqueakMacCore/Ponds/EmailInviteList.swift`.

## Names (2026-11-13)

Nobody types or changes a name; a person is called by their Squeak account (Catalyst sign-in: Zoho, Google, email).

- **Where it lives.** The relay keeps `names/<userId> = { name, email, at }` (relay-owned pk, no `/doc` or `/list` path reaches it), written only from a verified sign-in: any cookie call (`/me`, `/account/app-token`, `/account/link-ticket`) and a cookie join. A token sign-in (`x-squeak-account`) reads it back, so `/me` answers the name to a Mac. The Mac keeps it in `cloud.json`'s `hosted.name` at sign-in (`HostedCloud.signIn`). `identity.name` is always the account's name, else its email, else "Squeak member" when signed out: the Mac's own user name (`id -F`) and whatever `identity.json` saved are never read, there is no per-pond name and no rename. A member document carries the account's `email` (optional; older hosts omit it) and the pond view serves it as `members[].email`; the Mac draws it under the name in People and on hover in the Room.
- **Joining needs sign-in.** `FlotillaService.join(code)` (no name argument; `POST /ponds/join` ignores `displayName`) first asks the relay for `POST /account/join-attest` (the Mac's own key; the relay says which account the key belongs to, never the joiner) and refuses with "Sign in to Squeak to join a pond. Your name comes from your account." (401) when it cannot. The attestation (`ja.<userId>.<exp>.<email>.<mac>`, 10 min; verified only on a join request, never an account token) rides beside the pond-scoped join token as `x-squeak-join-attest`; a bad one is `401 signin`, never an anonymous join. Web guests keep the Hosted-login cookie path (`GUEST_SIGNIN=required` refuses anonymous joins). The Mac shows the sentence and a Sign in button.
- **The owner decides the name.** The relay writes `joinids/<requestId> = { v:1, userId, email, name }` beside the request from the verified account. On approval the owner's Mac writes the member document from it: `name` = account name, else email, `accountId` = `userId`; with no `joinids` (a relay store without one, or a store that cannot verify anything) the member is "Signed-out member" and has no `accountId`. The request's own `name` is never shown or stored as a name; it stays on the wire for older owners.
- **Staying fresh.** Per pond, at most every 30 minutes and at the pond's next refresh, an owner's Mac calls `POST /account/names { ids }` (relay or Mac key, at most 50 ids, answers `{ names: { <userId>: { name, email? } }, self? }`) and rewrites a member document (owner-signed) only when a name differs; its own document follows its account. A member document without `accountId` on a Catalyst pond reads "Signed-out member" in the flock and Ripples (the stored name is kept for old docs; such a member cannot attach an account or devices: they join again by invite, see "Members are accounts").
- **Photos.** The relay holds a photo per account (`/account/avatar`), but a hosted Mac's key may read only its own account's (`403` for another's), so a member's photo is not fetched; the transcript uses initials on a colour derived from the member id. Showing photos needs a relay decision about who may read a co-member's.

## Changes and new threads across Macs (2026-11-13)

**Sidebar.** Threads someone else started (in a pond shared with me, or a member's in my own pond) are rows under their pond in the normal tree (`SharedThreadRows`, SqueakMacCore): newest first by last activity, ties by title, a chat row plus the starter's 16 pt avatar, the state mark (working, a question waiting on me; an approval waits on the starter and shows no mark, only a tooltip), and the age. A row opens the thread in the workbench (`PondThreadView`). A private thread never has a row (the host never lists it for anyone but its starter), my own threads are the chats the tree already has, and a finished thread drops off after a day unless it is open.

**Changes on someone else's thread** (`tcmds` kind `diff`, answered in `tevents`). A member's Mac writes a signed `diff` command (optionally `path`); the starter's Mac answers with a sealed, starter-signed document `tevents/<thread>-r<command id>` = `{ result: { id, threadId, to, at, expiresAt, files: [{path, changes?}], summary?: {files, added, removed}, patch?: {path, text, truncated} } }`. The event reader ignores it (its id is not `<thread>-<seq>`). Rules: only members and viewers of that pond (a viewer may read: reading changes is watching), never a private thread, `path` must be one of the changed files (no `..`, no absolute path, so it cannot name another file on that Mac), a patch is capped at 1 MB (`truncated`), the answer lives 10 minutes (`DIFF_RESULT_TTL_MS`; the Mac deletes it from the list it keeps, swept at each command pass, no listing of the cloud) and a thread made private makes it unreadable to everyone but its starter. No polling: the Mac asks when the Changes pane opens, when a file is picked and when the thread's turn ends (the starter's new `changed` event); it reads the answer when the pond says it changed. Routes: `POST /ponds/<id>/threads/<tid>/changes { path? }` answers `{ ready, requestId, result? }` (your own thread answers at once, `requestId: "local"`; someone else's `202 { ready: false, requestId }`) and `GET .../changes?request=<id>` answers `{ ready, result? }`. The Mac draws the normal Changes rows, read-only.

**Artifacts across Macs** (`tcmds` kinds `artifacts` and `artifact`, answered in `tevents`). A remote member sees the owner's outputs, never code. Pond-level commands (no thread): only the owner's Mac answers; members and viewers of that pond (the `see` cap must be on), a limit of `ARTIFACT_FETCH_PER_HOUR` (30) file asks per member per hour. The answer is a sealed, owner-signed `tevents/art-r<command id>` = `{ artifacts: { id, to, at, expiresAt, ownerName, items: [{path, name, kind, duckName?, branch?, source, modifiedAt, size}], file?, error? } }`; every document lives 10 minutes (`ARTIFACT_RESULT_TTL_MS`, swept like diff answers). `path` is a wire id (16 hex of a hash of the absolute path), never a path. The list is `Artifacts.shareable`: no source-code kinds (`other`), nothing a private thread or private duck produced, found files proven by real path to sit in a pond folder; at most 150 rows. `artifact` takes an id and is served only if it is in that list right now (so no arbitrary path, no `..`), at most 25 MB (`MAX_ARTIFACT_BYTES`; else `error`). A file travels in 360 KB chunks (`art-r<id>-<n>`, written before the result so a result means every chunk exists; the relay's document cap is 900 KB), with its size and sha256 in `file`. Routes on the member's Mac: `POST /ponds/<id>/artifacts` then `GET .../artifacts?request=<id>` answers `{ ready, result?, error? }`; `POST .../artifacts/fetch { path }` then `GET .../artifacts/fetch?request=<id>` answers `{ ready, progress?: {have, total}, error?, file?: {path, name, kind, size, ownerName?} }` (each GET pulls chunks for a few seconds; `file.path` is the checked copy under `<support>/artifact-cache/<pond>/`, pruned to a week, 40 files, 400 MB, and removed on leaving). The Mac's Artifacts tab in a remote pond asks when it opens (and on Refresh), header "From <owner>'s Mac"; an owner who does not answer in 25 s reads "<owner>'s Mac didn't answer". iPhone and web: not yet.

**Starting a thread on the owner's Mac** (`tcmds` kind `start`). A pond with no Git remote (or a project this Mac does not hold), or a person choosing "Runs on <owner>'s Mac", sends `POST /ponds/<id>/start { text, agent, model, title? }`: a signed `start` command (no thread id, `text`, `agent`, `model`, `title`, `requestId`; no permission or workspace field). Only the pond owner's Mac runs it; it checks the usual command rules plus role (member or owner of the pond, never a viewer), that the owner's Mac holds the pond's project, a limit of `START_PER_HOUR` (10) per member per pond per hour (in memory), then makes a normal native chat in the pond's folder (Main for a git pond, the folder for a plain one) in the owner's default permission mode, **never `bypassPermissions`** for someone else's thread, with the member as the thread's `requester` and first participant (the thread document's optional `requester: { memberId, requestId }`; a Ripple "<member> started <title>"). It is published like any thread, so everyone sees it, and the owner sees an ordinary chat. The member's Mac opens the thread when a pond read shows one carrying its `requestId`; if none comes in five minutes it says so. Not for the owner's own Mac: the owner starts in the normal way.

## Who wrote a message (host side)

A user message that arrived from another member through a pond is stored with its author: the host's `messages` (and `queue`) rows carry nullable `author_id`, `author_name` (schema version 8), and the host's message API (`GET /native/sessions/<id>/messages`, the SSE `message` event) adds an optional `author: { id, name }` to such a row. The owner's own messages have no `author` key. A queued message keeps its author until its turn starts; several steers merged into one message keep one only when they share an author. **The agent is told who is talking** (`src/native/thread-context.ts`): every thread's agent gets a short note that it runs in Squeak (pond, folder, branch, target branch, tools, ask format; Claude as `systemPrompt: { type: "preset", preset: "claude_code", append }`, Codex as `thread/start`/`thread/resume`'s `developerInstructions` plus a compact guide), built when its agent starts. Once anyone other than the owner has written in a thread, the text the agent receives starts with `[from <name> · teammate]` (a pond member) or `[from <owner> · owner]` (the owner: the pond member name, else the macOS full name, else "owner"); each steer merged into one turn keeps its own line, a leading `[from ` line in message text is stripped so it cannot forge one, and the stored/displayed message is never prefixed.

## Sidebar organisation and Pond icons

Per project, keyed by a native project's id (or a Conductor repository's name, which the Mac lists itself). Stored in the support dir: `project-prefs.json` (`{ <key>: { hidden, labels } }`, 0600, a project with neither is dropped) and `project-icons/<base64url key>.png`. Nothing is published: a pond's cloud documents have no icon field, so the icon and these choices stay on this Mac. **Hiding is only a sidebar choice**: a hidden project's chats stay in search, on the radar and keep pushing notifications.

- `GET /native/projects` rows gain `hidden: boolean`, `labels: string[]` and, only with a Squeak icon, `iconUrl` (`/native/projects/<key>/icon`) and `iconUpdatedAt` (ms; use it as a cache key).
- `PATCH /native/projects/<key>/prefs` body `{ hidden?, labels? }`, strict (unknown key or empty body is 400). Labels are trimmed, 1-24 characters, at most 8, unique ignoring case. Answers `{ hidden, labels, iconUrl?, iconUpdatedAt? }`.
- `GET /native/labels` answers `{ labels: [{ label, count }] }`, sorted by label.
- `PUT /native/projects/<key>/icon`: `{ icon: "data:image/png|jpeg;base64,..." }` (JSON) or the raw bytes with `content-type: image/png|jpeg`. Magic bytes checked, at most 512 KB (413), re-encoded to a PNG of at most 256 px with `sips` (400 if unreadable). Answers the same view as `PATCH`. `GET` answers `image/png` bytes (404 with none), `DELETE` clears it.
- **Colour.** `colour` is a palette name or `null` (clears it; the Mac then derives the tint from the pond's id, as before). `PATCH /native/projects/<key>/prefs` accepts `{ colour }` (case-insensitive, anything else is 400) and `GET /native/projects` and the `PATCH` answer carry it only when set. The palette is `POND_COLOURS` in `src/native/project-prefs.ts` (name to hue in degrees, none in the duck's band 25 to 75): red 355, coral 10, lime 95, green 140, teal 175, cyan 195, blue 220, indigo 245, violet 270, purple 295, pink 325. The Mac draws a named colour with `PondTint.rgb(hue:dark:)`.
- **Pond upkeep by an agent.** Every thread's agent has `pond_appearance` (`{ name, colour, colours, labels, hasIcon }`), `set_pond_icon {path}`, `set_pond_colour {colour}` (a name or `"default"`) and `set_pond_labels {labels}` in Squeak's MCP server (`agent-tools.ts`). They act only on the pond of the calling thread (its workspace's project, else the project whose folder it runs in; a thread with neither is refused). The icon path is resolved with `realpath` and must lie inside the thread's own folder (a symlink out is refused), then goes through the icon route's own validation and re-encode (`ProjectPrefs.setIcon`). Hide, rename, invite and membership have no tool on purpose. At most 10 changes an hour per thread. A change adds a Ripple ("Claude in <thread> set the pond icon") in a published pond; a local pond has no cloud to hold one, so there it is only logged, and a failing Ripple never fails the change.
- **Pond order.** `GET /native/pond-order` answers `{ mode: "recent" | "manual", order: string[] }` (default `{ mode: "recent", order: [] }`; keys are native project ids or Conductor repository names, as the prefs above). `PUT /native/pond-order` takes a strict `{ mode?, order? }` (unknown field or empty body is 400): `order` is at most 500 unique, non-empty strings of at most 200 characters, and may name keys that are absent now (a Conductor pond may come back). It answers the saved value. Stored in `project-prefs.json` under the reserved key `__pondOrder`, local to this Mac, never published. Removing a project (`DELETE /native/projects/<id>`) drops its key from the order. Only the Mac sidebar's ponds follow it, and only in `manual` mode; every other list stays newest first.
- Precedence: Squeak icon (`iconUrl`) > Conductor's `repos.icon` (the Mac reads it from Conductor's database) > none.

## Creation pages

- **Project display name.** `POST /native/projects` (`{ rootPath, name? }`) and `POST /native/projects/clone` (`{ url, parentDir?, name? }`) take an optional `name`: trimmed, 1-60 characters, one line (else 400). It is the display name only; the folder stays. An already-added folder is returned as it is, never renamed. A `/`, `\` or `:` in a name becomes `-` in the workspaces folder path.
- **Typed branch.** `POST /native/projects/<id>/workspaces` (`{ from?, branch? }`) and `POST /native/sessions` with `projectId` + `newWorkspace` (`{ branch? }`): for a new branch from the default, from a `base`, or for an `issue`, `branch` is the exact branch name (no prefix added), checked with `git check-ref-format --branch`, refused when a local branch has it or when its folder (a lowercase slug of it, `/` becoming `-`) is taken by a workspace or on disk (400 with the reason). The first message then does not rename it. Absent keeps the bird name. Ignored for `from: branch` and `pr`, which keep their own branch's name.
- **Pickers** (token-gated GETs). `/native/projects/<id>/branches[?fetch=1]` answers `{ branches: [{ name, remote, current, checkedOut, lastCommitAt }] }`, newest first, local and `origin/*` merged; `fetch=1` runs `git fetch --prune` (20 s). `/pulls` and `/issues` answer `{ items: [{ number, title, author, updatedAt, branch? (pulls), fork? (true), url }], available, reason? }` from `gh pr|issue list --limit 50` in the repo root (15 s, cached 60 s per project and kind); no gh, not signed in, or no GitHub remote is `available: false` with a plain `reason`, not an error. Code: `RepoPickers` in `src/native/workspace-sources.ts`.
- **Split the work.** `POST /native/sessions` takes `split: { code?, run?, planFirst? }` (the `checkWorkSplit` shape of `src/fleet/work-split.ts`) with a first `text`: Claude only (Codex, a bad worker or no text is 400). `splitBrief` is put in front of the first message for the agent only; the chat shows `text`. Kept in host memory until that first turn starts, so a host restart before it (a long setup script) drops the brief.

## Stream names

A new stream gets a pond-themed name, not a bird: "Quiet Creek", "Staff Otter", "Detached HEAD Duck". The generator is
`src/native/stream-names.ts` (pure, seedable; tests in `stream-names.test.ts`), from the owner's spec.

- **Templates, by weight:** 35% mood + creature, 25% mood + water, 15% coding word + creature, 10% office role +
  creature, 10% mood + odd object, 5% a handcrafted name ("Works On My Pond", "Quack Overflow"...). The mood slot is
  mostly a pleasant word (Quiet, Silver, Mossy, Willow, Pebble...) and sometimes a joke mood, so the feel is roughly 70%
  charming, 25% funny, 5% ridiculous. "Illegal", "Unauthorized", "Aggressive" and "Passive-Aggressive" are in, at a low
  weight.
- **Three forms of one name:** the title as generated and shown ("Detached HEAD Duck"), the folder slug
  (`detached-head-duck`: ASCII, lowercase, hyphens) and the git branch `<branch prefix><slug>`, the prefix chosen as before.
- **Never a reused slug:** a slug already used by a stream folder, a workspace of the pond or a local branch is refused;
  up to 50 tries, then `-2`, `-3` on the slug (and the number after the title).
- **Stored:** `workspaces.title` in `native.db` (nullable, added by a migration). Workspace rows in the API carry `title`;
  a stream made before this has none and shows its name made readable ("wood-duck" as "Wood Duck").
- **One source:** `GET /native/projects/<id>/suggest-stream` (token-gated) answers `{ title, slug, branch }`. The host's own
  creation (an agent's `start_chat`, a New stream with no name, a routine) uses the same generator.
- **A typed name:** `POST /native/projects/<id>/workspaces` takes `name`: it becomes the title and is slugged for the folder
  and the branch (made unique the same way). An explicit `branch` still wins for the git branch.
- **Squeak for Mac:** the New stream page asks `suggest-stream` and fills the Name field; typing overrides it, and the
  refresh button ("Another name") rolls again. A host too old to answer leaves the field empty and takes what is typed as
  the branch name, as before.

## Permissions

`src/flotilla/permissions.ts` holds every rule, as one pure `can(actor, action, ctx)` answering `{ ok: true }` or
`{ ok: false, reason }` (a fixed sentence). Two layers, kept apart:

- **Pond role** (owner, member, viewer): only the owner invites, decides joins and removes members; a viewer only
  watches; members ask for threads (always held for the Owner's approval), message, answer questions and ask
  for a diff on a thread someone else started.
- **Agent authority** (per thread): approving edits, shell or destructive work, pushing and stopping are the Owner's
  alone, on every Duck in the Pond, including one a Member asked for (it runs on the Owner's Mac); a Member or a Viewer
  never, and an agent never approves its own work. A private thread does not exist for anyone but its starter.

## States and the pond contract (2026-11-13)

Every person always sees one plain state; the host computes it and its sentence, the Mac and the web only draw it.

- **`status`** on a pond (list item and `view().pond`): `local` | `pending` | `active` | `declined` | `expired` | `revoked` | `removed`, with `statusLine` (one sentence: "Waiting for Sibhi to approve you as a member.", "Sibhi declined your request.", "This invite expired before Sibhi answered.", "Sibhi withdrew this invite.", "You were removed from greenroom.", "Only on this Mac. Invite someone to share it."), `ownerName` (the invite carries it, the members list confirms it), and for a pending join `requestedRole`, `requestedAt`. A terminal pond keeps its row until `POST /ponds/<id>/forget { pondId }` (a pending one is withdrawn, an active one refused: leave first). `view()` of a pond that is not active answers 200 with the state and nothing else (no members, threads or Ripples).
- **No raw transport error reaches a caller.** Store failures are mapped once (`FlotillaService.relayError`): 401/403 is an access error (a joiner's becomes `revoked`, or `expired` once the invite's own time has passed; a member's becomes `removed` only after the new key is picked up and the relay still refuses, or the members are readable and this key is not among them, or the owner's "removed" note in `keys/<id>` is read), 5xx, timeouts and `fetch failed` are "Can't reach Squeak's cloud." (503). A member who has not yet picked up a rotated key reads unreadable members and is **not** told they were removed.
- **Offline.** `offline: true`, `asOf`, and `offlineLine` ("Can't reach Squeak's cloud. Showing what was here at 10:42."). `list()` and `view()` answer within 6 s (`budgetMs`): past it, the last good read is served flagged offline while the read carries on and refreshes the snapshot. Reads of a view are made together (members once). A write is attempted and says "read-only" itself if it cannot go; a successful relay call of any kind clears the offline mark; a failed read refuses multi-step writes (removal, key change) for 3 s only. Tasks and locks are left out of `GET /ponds/<id>` unless `?coordination=1`.
- **Join** (owner's `joins[]`): `{ requestId, name (the verified account's name, else "Signed-out member"; never the joiner's claim), client: "mac"|"web", nest, role, verifiedEmail?, requestedAt, decision?: { state: "working"|"failed", line } }`. A request whose invite lapsed, was withdrawn or was already used stays 24 h, greyed (`decision.failed` with "Invite expired. Ask them to join again."), and cannot be approved; a request on a **declined** invite is decidable (the person asked again). A failed `join` (the relay refuses or is out of reach) leaves no pending pond behind. The name is never typed: `myName` is only the account name a joiner went by until the owner's member document says it.
- **Invites** (`view().invites[]`, owner): `{ id, role, state: pending|accepted|declined|expired|revoked, createdAt, expiresAt, usedBy?, link?, code? }`; a pending invite keeps its code and link (in the 0600 `ponds.json`, beside the pond key they carry) so they can be copied again, and loses them when used. `POST /invites` answers `{ id, code, expiresAt, link? }`; `DELETE /invites/<id>` revokes.
- **Members** (`view().members[]`): `{ id, name, role, nest, nestName, client: "mac"|"web", online, lastSeenAt?, you }`. `online` = the presence document has not passed its `until` (4 min; an older writer's heartbeat is judged by `ONLINE_MS`, 45 s); the host beats every 2 minutes for ponds it is in, and the Mac/web send `POST /presence { viewing?, typing? }` (strict) every 20 s while a pond or thread is on screen, which the host writes to the relay only when it changed. **Sync load**: a Data Streams notice carries no author, so the host drops the echo of its own presence/thread-event writes (5 s window), folds a burst into one read after 1 s (min 3 s apart), reads quietly on the safety poll (2 min shared, 5 min alone; the app is told only if this Mac's record changed), and backs a pond off on a 429 (30 s doubling to 10 min, with jitter). A refresh never writes presence. One log line per 5 minutes (`ponds sync (5 min)`: refreshes, relayCalls, streamEvents, skippedOwnEcho, coalesced, polls, backoffs, presenceWrites, presenceSkipped). The Mac's pond dashboard never changes height for a status: one fixed header row (access line, info mark, a fixed slot for refreshing/can't reach shown only for the person's own reads or ones over 1 s; `PondHeaderStatus`).
- **New routes** (all strict): `POST /ponds/<id>/members/<memberId>/role { role: "member"|"viewer" }` (owner; the key does not change), `POST /ponds/<id>/leave { pondId }` (a member; the owner's Mac removes their key when it reads their "left the pond" Ripple; an owner is refused: delete instead), `POST /ponds/<id>/rename { name }` (owner; the meta document, members read it on refresh), `POST /ponds/<id>/delete { pondId }` (owner; ends everyone's access, then clears the cloud), `POST /ponds/<id>/forget { pondId }`. A removal runs once per member at a time; the owner's removal writes a "removed" note sealed to the member and drops their holds.
- **Threads** (`view().threads[]`): the document's fields plus `mode`, `private`, `permissionMode`, `asks` (false = runs without asking), `starterOnline`, `starterName`, `nestName`, `stateLine` ("Working on Aarav's Mac", "Waiting for Sibhi to approve an edit", "Aarav's Mac is offline"), and `waitingOn: "question"|"approval"|null`. `needsYou` counts a thread only when its starter is you or it waits on a question and you are not a viewer. Making a chat's mode change republishes the thread (`mode` host event).
- **Send result**: `POST .../messages` answers `{ ok, queued, state: "queued"|"sent"|"refused", line }`; a refusal is a 200 with the reason ("Viewers can read but not send.", "Only Sibhi can message this thread while it runs without asking."). Messages carry `author { id, name }` on a teammate's message (not the starter's own).
- **Holds**: `{ requestId, by, byName, heldBy, heldByName, until }`, lapse 2 minutes after the last renewal; a viewer is refused; a removed member's hold is ignored and deleted.
- **Ripples**: `{ id, at, actor, actorName, text, onBehalf? }`; `text` never repeats the actor ("made the pond", "joined", "answered a question", "removed Aarav", "made Aarav a viewer", "renamed the pond to X", "changed the pond key", "turned down Dev's request to join", "withdrew an invite"); a Ripple the starter writes for another member's answer or joining carries `onBehalf` so `actorName` is that member. A private thread writes none, and sharing one later takes its "shared <title>" Ripple away. Agent upkeep Ripples say "Claude set the pond icon".
- **Remove from Squeak** (`DELETE /native/projects/<id>`) of a project whose pond is shared is refused (409) with a plain sentence: delete the pond first. A local pond goes with the project. (A pond cannot change hands yet, so deleting is the only way out.)

## Offline, and changing the key

- **Offline.** When the relay cannot be reached (network down, 429, 5xx) `list()` and `view()` answer from the last good read, flagged `offline: true` with `asOf` (unix ms) on the view and on each pond summary. The snapshot is `flotilla/snapshot.json` (0600, beside the keys): names, counts, thread titles and the Ripples feed only; no thread events or message bodies, no session ids, presence, holds or pending joins. A 401/403/404 from the relay is a refusal, never served from the cache, and a pond that is removed or forgotten leaves the cache. Writes are refused with one fixed sentence while the relay is unreachable; nothing is queued.
- **Rotate the key.** `POST /native/ponds/<id>/rotate-key` with exactly `{ "pondId": "<id>" }` (owner only; `rotateKey`): a new pond key sealed to every current member, their old relay tokens ended and issued again, Ripple "The pond key was changed". A member is an account with one or more device keys ("Members are accounts"), so a lost device is `POST /native/ponds/<id>/devices/remove` with exactly `{ memberId, deviceKeyId }` (`removeDevice`; for a member's only device the ids are equal and it is `removeMember`): that device is removed and the pond key rotates.

## Room

**Attachments.** A person's room message may carry up to four pictures (PNG/JPEG by their bytes, 2 MB each; the Mac shrinks to the chat composer's 1.2 MB) and four files (5 MB each, 16 MB in all): `POST .../room { text?, attachments: [{ name, data(base64) }] }`, a picture alone is a message. Bytes live in `<support dir>/room-attachments/`, named in the lazily-created `room_attachments` table; posts carry `attachments: [{ id, kind, name, mime, size, url, width?, height? }]`, served by the token-gated `GET /native/projects/<id>/room/attachments/<attId>`. When a message becomes work for a duck (job Go / Allow / New duck) they are copied under the duck's folder at `.context/attachments/<id>/` and named like a chat's (`@⟦image-1.png⟧(path)`, `Attached file: path`); the job still finds its turn by the text without those lines. The job check hears only "(+N images)". An `@duck` send from the Mac saves them the same way through the chat path.

Each pond has one room on this Mac (host side, `src/native/room.ts`; no cloud, no Flotilla publishing yet): a
time-ordered stream of short posts saying what each agent is _working on_ (intent, never every edit or command).
Agents post and read it through two MCP tools; the person posts like a group chat. Two levels: `room` (what a person
sees by default) and `agents` (agent-to-agent coordination; a person can open it). Stored in `native.db`
`room_posts` (newest 2000 per pond are kept).

```
RoomPost   = { seq, id, author: { kind: "person"|"agent"|"squeak", id?, name }, sessionId?,
               kind: "working"|"done"|"needs"|"message"|"handoff", level: "room"|"agents",
               text, toSessionId?, at /* ms epoch */ }
RoomThread = { sessionId, title, agent, state: "working"|"waiting"|"idle"|"error",
               workingOn?, workingOnAt?,
               lastState: "finished"|"stopped"|"error"|"idle", lastAt,  // non-archived chats active in 24 h, newest first;
                                            // workingOn = newest `working` post, gone once a later `done` exists
               progress?: { current, total, label? },   // the set_progress strip (1-based current), while working
               ask?: { question, options: [{ letter, text, recommended }] },  // waiting chats, from the last message (parseChoices)
               turnStartedAt?,                          // ms, while a turn runs
               filesChanged? }                          // not sent yet (a git run per chat)
RoomTurn   = { id: "<sessionId>:<turnId>", sessionId, threadTitle, agent, startedAt, endedAt?,
               outcome?: "finished"|"stopped"|"error",  // absent while running
               prompt /* one line, <= 200 */, author: { kind: "person", name, me },
               answer?: { letter, question, option? },  // the prompt picks one of the previous turn's options (A, option B, go with A, B please, 1, 2); option = its text
               outcomeText? /* first sentence of the closing reply, markdown stripped, <= 200 */,
               durationMs?, filesChanged?,
               intent?, progress?: { current, total } } // intent/progress only while running
```

**Turns come from timelines** (`room-turns.ts`, no store of their own): one per `turn.started` that is not an
agent-run turn (`auto`) and was sent from the room (`room: true`), to its `turn.ended`. A person's direct chat with a duck
is never in the room: its turns carry no `room`, so neither `GET .../room` nor the SSE `turn` frames serve them (the room
shows only room messages, `@duck` sends made from it with the duck's reply, and the ducks' own posts). The mark is set
where the room starts the turn: the Mac's `@duck` send (`POST /native/sessions/<id>/messages { room: true }`) and every
job send/start (Go, Allow, New duck). It rides the queue row (`queue.room`) so a queued message keeps it, and
`turn.started` in the timeline log, so it survives a restart. Older turns (before the mark) are not shown. The author is the message's pond member (`me: false`) or the owner
(`me: true`); `intent` is the chat's newest `working` post since the turn began. A per-chat cache is topped up by
timeline seq. `GET .../room` answers `{ posts, latestSeq, threads, turns }`: turns oldest to newest, those that started
inside the page's window (a plain page: the last 24 h, newest 100; a `since`/`before` page: the span of its posts).
Squeak no longer posts a Started/Finished/`needs` line: none are made, any old ones are deleted at start and never
served; agent, summariser and person posts are unchanged.

Routes (token-gated, no CORS, strict JSON bodies, an unknown key is a 400):

- `GET /native/projects/<id>/room?since=<seq>&before=<seq>&limit=<n>` -> `{ posts, latestSeq, threads, turns }`, posts oldest to
  newest. `since` gives the first `limit` posts after it, `before` the newest `limit` before it, neither the newest.
  Limit defaults to 100, at most 200.
- `POST /native/projects/<id>/room` `{ text, level? }` -> 201 `{ post }`; author is the person (pond member name, else
  the macOS full name, else "owner"), kind `message`.
- `GET /native/projects/<id>/room/stream` -> SSE: `event: hello` `{latestSeq}`, then `event: post` (a `RoomPost`, `id:` =
  seq), `event: turn` (a `RoomTurn`, upserted by `id`: sent when a turn starts, gets a new intent or progress, closes
  with a reply or ends; at most one frame per turn per 500 ms), a `: ping` comment every 25 s. Any GET or an open stream marks the room viewed.

Text is trimmed, at most 500 characters, never empty; everything but `message` is one line. Agents use
`post_to_room { text, kind, level?, toChatId? }` (30 a chat an hour; `toChatId` must be in the same pond) and
`read_room { last?, level? }` (compact `[hh:mm] name (kind): text` lines plus "Working now"); every `send_to_chat` is
mirrored as an `agents` message. While a chat works and its room was viewed in the last 10 minutes,
a chat that posts nothing for 90 s and has taken three new steps gets one Haiku-written `working` line posted for it
(`room-summary.ts`, at most one per chat per 3 minutes, one running per pond, `SQUEAK_ROOM_SUMMARY=off` disables it);
that line (or an agent's own) is the running turn's `intent`.

**The feed is a group chat (2026-11-25).** `posts` and the stream's `post` events serve only what a person would read
(`Room.feedRows`): people's messages, Duck messages, `needs` asks, `plan` cards and hand-offs (Duck to Duck included).
`working` ("took it"), Squeak's own lines (a Stream joined) and repeated `done` lines stay in storage but are not served; an
old `done` row is served only as its Room turn's last one. An agent's `read_room` still reads every stored row. A Duck
writes its Room message itself (`post_to_room` kind `message`, two or three plain sentences). When a Task's turn
finishes without one, `RoomTasks` writes one from the turn's final reply (`room-finish.ts`: the on-device model, Haiku
after) as an agent post with id `fb:<taskId>`; the wire post carries `onBehalf: true`. Every Duck post carries
`sessionId` + `turnId` (a person's post has its `id`); the turn's `RoomTurn.id` is `${sessionId}:${turnId}`.
`GET /native/sessions/<id>/turns/<turnId>` -> `{ sessionId, turnId, startSeq, startedAt, endedAt?, outcome? }` says
where to open the Duck's chat (load its timeline with `since=startSeq-1`). Each Task is one live item (`tasks` in the
page, `event: task` on the stream, same `id` for life): `state`, `title`, `owner` `{ duckId?, name, sessionId }`, `open`
`{ sessionId, turnId? }` and, on `done`, `summary` (the Duck's own message, else the one Squeak wrote, else its first
sentence), filled in place.

### The Room reaches Members (`src/flotilla/room-sync.ts`)

The cloud keeps the **whole Room**, sealed (docs/spec.md, "Cloud"; ADR 0005; docs/cloud-layer.md, "The Room in the cloud"). The Owner's
Mac writes its posts and Tasks; every Member writes their own posts as signed documents. The relay numbers every write with the Pond's
`seq`, and that number is the one order everyone draws.

- **Kinds.** `room`/<post id> = `{ v:1, seq, id, author:{kind person|agent, id?, name}, kind, level:"room", text, at }`, written only by the
  Owner's Mac (a Member's document of that kind is ignored; `seq` inside is the Owner's own and only a fallback: on read the cloud's number
  replaces it). A Duck's author has no id; a person's is their member id. Only `level: room` posts go: no `agents` level, no attachments yet.
  `rtasks`/<task id with `:` made `-`> = a Task as Members see it (a suggestion nobody took up is never published). `rposts`/<time-ordered
  id> = a **Member's own signed document**: a message `{ v:1, id, text, at, replyTo? }`, or one ask that waits for the Owner's Mac:
  `task:{messageId}` ("Make task"), `leave:true`, `removeDevice:<id>`, `start:{requestId,text,agent,model,title?}` (a Duck). `roomnote`/`trim`
  is the relay's own plain note that it paged the oldest out. Pond lines (someone joined, left, was removed, renamed, a Duck declined) are
  Room posts by Squeak with ids `ln-<id>` (`ln-dec-<requestId>` for a declined Duck, which tells that Member's Mac to stop saying
  "Waiting"); they travel as a message from "Squeak".
- **Members read at once.** A Member's post is readable by every Member the moment it is written, from their `rposts` document, with the
  Owner's Mac away; the Member's Room is the Owner's `room` documents and every `rposts` message, ordered by the cloud's `seq` (a store that
  does not number falls back to time, then the Owner's own order). A Member's message is not published a second time by the Owner's Mac.
- **The Owner's Mac ingests when it is online** (that is when Ducks hear it): on every pond pass it applies the Members' waiting posts and
  Tasks (`RoomSync.drain`) and, in the service, their leaves, device removals and Duck requests (`applyQueuedActs`), each oldest first by
  seq, through the Room's own post path as post `m-<doc id>` (a replay can never post twice). It remembers how far (`ingestedSeq`,
  `actsSeq` in `flotilla/ponds.json`); a numbered document stays in the cloud as the Room's record. Rules are the same as before: not a
  member, a viewer, `message` off, over 60 an hour per Member (counted by the Member's own times, so a backlog is not cut short), empty or
  over 500 characters are skipped quietly. A Duck request or leave waits as long as it takes (it is not a 5-minute command).
- **25 MB cap per Pond** (`room-cloud.js`): past it the relay pages out the oldest `room`/`rposts` by seq, leaves tombstones in the feed
  and the note; a Member's page carries `earlier: { line }`, and the Owner's Mac does not send a post older than the oldest the cloud still
  holds. The 200-post cap is gone, so a joiner or rejoiner reads everything the cloud still has.
- **Key rotation rewrites nothing.** Each document keeps its key version (its box tag); the Owner's Mac seals **every** version to each
  member and device (`keys` grant `versions`), so a new Member opens old and new. New writes use the new key.
- **A Member's token** may add an `rposts` document but never overwrite or delete one (409 / 403); the Owner's own key pages and removes.
- **Offline line.** While the Owner's Mac is not running (from the live connections, `options.presenceOf`) a Member's post answers 202
  `{ queued, id, offline: true, line }` and the Room shows the line; Ducks pick the post up when it is back.
- **Detail, canvas cards, plan cards, comments** are as before (`detail`, `canvases`, `replyTo` on a `room` document; a comment on a plan
  card is an `rposts` message with `replyTo`).
- **Ducks a Member can see** (not Private): their messages and short step lines for the last 30 days (`DUCK_HISTORY_MS`, thread
  events in `tevents`); tool output, diffs and files are never in an event. Opening one asks the Owner's Mac (`diff` and `artifact`
  commands) or shows "Available when <Owner>'s Mac is online". A Private Duck is never uploaded.

### The Room on iPhone (`src/remote/pond-room.ts`)

The phone reads the Room through the phone channel, never the host. While a phone has a pond's Room open (`room` in its
presence, `pondroom` in its caps) the Owner's Mac reads the Room (an Owner's own pond: `GET /native/projects/<id>/room`; a
joined one: the Member route above) at most every 2 s and writes one sealed `live` document (`pondRoomDoc`, hashed `room:<pond id>`
plus `-r`), only when it changes, deleted when the phone leaves. It holds the rows already decided: `message` (people and
Ducks, `mine`, `canTask`), `duck` (a Duck's state line, collapsed `line` with an optional `detail` a tap expands), `task` (title,
state, `stateLabel`, the routing line `routing`, `result`, `canDrop`), the switches `canPost`/`canTask`, a Member's `reason` and
the Owner-offline `offline` line, newest 80 rows. `agents`-level talk never goes. The routing line is the Task's own `routing`
when the host sends one, else made from what it routed ("→ given to Pixel (related to the icon work)").

Actions are signed `pond` commands: `room-post { pondId, text }` (at most 500), `room-task { pondId, messageId }` (Make task) and
`room-drop { pondId, taskId }`, exactly those keys. A Member's post goes the Member route (queued for the Owner's Mac); Make task
and Drop are the Owner's own pond only. The phone's "Make it a task" chip posts that phrase, which the host's plain rule reads.
The phone draws a sent message at once and keeps it until the Room shows it back (`PondRoomFeed`). Entry: the "Room" row of
the Pond screen. Fixtures: `pondRoomBox` in `mac-made.json` (`scripts/make-mac-fixture.ts`) and the three `pondRoom*Command`s in
`swift-command.json`.

### Tasks

A person's room message that asks for work becomes a **Task** Squeak routes to a Duck (`room-tasks.ts`; they were "jobs" before, the agent tools keep the names `open_jobs` and `claim_job`). Rules: Squeak
never chats (its only words are action and status lines); nothing is taken or started without the person's Go or
Allow; plain chat stays a note. Stored as JSON in `native.db` `room_tasks` (created lazily, like `room_backfill`; the old `room_jobs` table is renamed and its rows mapped once: suggested is waiting and still only proposed, handed and running are working, failed is blocked, dismissed is dropped).

```
RoomTask = { id: "task:<uuid>", messageId /* the message that made it */, text, title /* one line */,
            state: "waiting"|"working"|"blocked"|"done"|"dropped", proposed? /* only suggested by the check */, parentTaskId?,
            discussion: [{ id, author, authorKind: "person"|"agent", text, at }],  // Room messages since the previous Task, max 2 h
            suggestion?: { duckId?, name?, sessionId /* current chat, "" if none */, title, reason, pitch, state: "working"|"idle" }, candidates?: [same, up to 3],
            place?: { kind: "stream", workspaceId, branch } | { kind: "new", branch },   // see "Place"
            claim?: { sessionId, duckId?, title, eta?, at, status: "asking"|"allowed"|"denied" },
            handedTo?: { sessionId, duckId?, title, turnId? /* "<sessionId>:<turnId>", the RoomTurn id */, newThread },
            result? /* the Duck's first sentence */, createdAt, updatedAt }
```

- **Making a Task**: a person's message with "make it a task" (also this/that, "into a task", "turn this into a task",
  "make a task of it"; a plain rule, no model, works with the check off; "don't make it a task" and "should we make it a
  task?" do not count), `POST .../room/tasks {messageId, parentTaskId?}` (the Make task action; a dropped Task is made again,
  a suggestion is taken up), or Go / New on the check's suggestion (a `proposed` Task). A phrase-only message takes the last
  person message before it as the text. The **discussion** is the room's person and agent messages since the previous
  Task of the pond (suggestions nobody took up and dropped Tasks do not count), at most 2 h before the message, up to 60.
  `go`, `allow` and `new` take `messageIds`, the trimmed list; the Duck is sent the text and the kept messages after it
  (`promptOf`). Routing (`routeFor`) is the seam where a later decider plugs in. States: `go`/`new`/`allow` make it
  `working`; its turn ending makes it `done` (with `result`) or `blocked`; `drop` works on waiting, working and blocked.
- **Check**: after a person posts to the `room` level, one Haiku call (the auto-title helper, 20 s timeout) answers strict
  JSON `{job, text}`; a failure or timeout is no job. Messages under 3 words are skipped unless they start with an
  imperative verb; 30 checks an hour per pond; `SQUEAK_ROOM_JOBS=off` stops the automatic check (a manual job still works).
- **Matching** is rules only: the pond's non-archived chats active in 7 days are scored by word overlap of the job with
  the title (3), the `working` intent (2) and the last four turns' prompts and outcomes (1.5), plus a recency bonus;
  below 3 there is no suggestion (the person can start a new thread). `reason` is built from the evidence ("worked on
  layout builder 10 min ago"); a working chat has `state: "working"`.
- Routes: `GET .../room` adds `tasks` (open ones and those updated in 24 h, newest last); `POST .../room/tasks {messageId}`
  -> 201 `{task}`; `POST .../room/tasks/<taskId>` strict `{action: "go", sessionId?}`, `{action: "new"}` (a thread in the
  pond's folder, owner's default permission mode, the model of its newest chat), `drop`, `allow`, `deny` -> `{task}`,
  409 with a sentence when the state no longer allows it. SSE sends `event: task` (upsert by id).
- **Place**: every job has one, chosen by the host when it is made (absent in a plain-folder pond, which has no streams): the
  matched duck's current stream when the job's words match that stream's title, branch and last four turns strongly
  (a score of 4.5: a title word 3, a turn word 1.5), else a **new stream off the default branch** on a free slug branch
  made from the job text (`check-ref-format`, `-2`, `-3` when taken, the workspace branch prefix applied). `go`, `allow` and
  `new` take an optional `place` of the same shape as an override (a stream of this pond, or a free branch git accepts: 400
  for a bad shape, 409 when the stream is gone or the branch is taken) and `go`/`new` an optional `duckId` instead of
  `sessionId` (both 400). `sessionId` still works and means "continue in that chat, where it is".
- On `go`/`allow`: when the duck's current session is in the place, the job text goes to it as the next turn (queued
  when busy). Otherwise a **fresh session** starts in the place (a new stream is created first, setup scripts included)
  with the job text, a title from the job, the owner's default permission mode, the model of the duck's chat, and the
  duck's identity note; it becomes the duck's current session and the old one stays as history. One job per duck: a duck
  that is working or waiting cannot start a session elsewhere (409); it can claim "after this". `new` with no `duckId`
  makes a new duck, named from a short list, and starts it in the place.
- (Older behaviour kept) `go`/`allow` send the job text as a new turn from the person (queued when busy). The job follows the turn its text
  starts: `working` while it runs, then `done` (or `blocked`) with `result`, read from the chat's timeline.
- Agents: `open_jobs` (suggested jobs fitting this thread) and `claim_job {jobId, eta?}` (sets `claim` to `asking`; starts
  nothing; one claim at a time, a newer chat replaces it only after a deny; 10 an hour a chat).

### Ducks

A **duck** is a person-like identity that belongs to the **pond**, not to a stream or a chat: a name, a role, a colour, a
duty (user-facing copy says duck; the code keeps session/thread). Lessons live in the **Pond Notebook**, not on the duck.
A duck works in one place at a time.
Taking a job in another place starts a **fresh session there** carrying its name and role; the old session
becomes history (still the duck's: its turns carry the duck's `duckId`). Squeak never chats and nothing starts without
the person's Go or Allow. Host side: `room.ts` (`duckView`, `listDucks`, `createDuck`, `setDuckById`, `setDutyById`,
), `store.ts` (`ducks` and `duck_sessions`, created lazily like `room_jobs`, no numbered migration;
`session_ducks` is only read once, to migrate).

```
Duck = { id, projectId, name, role?, colourSeed, duty: "on"|"off", currentSessionId?, place?: Place,
         state: "working"|"waiting"|"idle"|"error", lastActiveAt, sessions /* how many it has had */,
         notebook /* always "": migrated into the Pond Notebook */, createdAt }
Place = { kind: "stream", workspaceId, branch }     // absent: Main, a plain-folder pond, or no session yet
```

#### Ducks start Pond-wide and choose their Streams (flag `ducksOwnBranch`, `SQUEAK_DUCKS_OWN_BRANCH`, on by default)

Replaces "Ducks own their branch" (ADR 0003, `docs/adr/0003-ducks-start-pond-wide.md`). Host side in
`src/native/placement.ts` (`openStream`, `leaveStream`, `streamsFor`), `agent-tools.ts` and `stream-edits.ts`. The flag keeps
its old name so Macs and phones keep reading it; off (`SQUEAK_DUCKS_OWN_BRANCH=off` or `flags.json`) means none of this
applies.

- **Start.** A new Duck's chat has `cwd` = the Pond's main folder and no workspace, in a git Pond and a folder Pond alike
  (`POST /native/sessions` with no place, `main: true` or `place: {kind:"main"}`). Squeak never picks a Stream for it, and
  a message to a chat in Main goes to that chat. An explicit `place` (`new`, `join`) or `newWorkspace` still starts the
  chat inside a Stream and records the Duck as joined.
- **Model.** `duck_streams (duck_id, workspace_id, joined_at)`, many to many; `NativeStore.joinDuckStream`,
  `leaveDuckStream`, `duckStreams(duckId)` (usable working copies, join order) and `ducksInStream(workspaceId)` (also
  counts older Ducks whose chat runs in the folder). `ducks.workspace_id` / `ducks.branch` stay for old Ducks until the
  migration ticket. A working copy is removed by the clean-up only when no Duck is in it.
- **Tools** (plain wording, listed only with the flag on): `streams()` lists the Pond's branches with working copies, each
  folder and who is in it, and which are yours; `open_stream({name?, branch?, from?})` joins the Stream called `name`
  (title, name or branch) or creates it, or opens the exact `branch` (joins the Stream that has it, opens an existing git
  branch, else cuts it new), branching off `from` (default: the default branch), and returns the folder;
  `leave_stream({name?})` leaves one (name optional when in just one). Squeak does the git work. Limits: 4 Streams per
  Duck at once, 24 per Pond, 5 created per chat per hour. A folder Pond answers `streams` with "plain folder" and refuses
  `open_stream`. `branch_off`, `join_branch` and `move_to_main` are no longer listed; a chat begun before still gets
  `open_stream` / `leave_stream` behaviour from them.
- **Main is read-only for Ducks in a git pond** (folder ponds edit the folder). Claude's PreToolUse hook (every mode) and
  `canUseTool` refuse Edit/Write/MultiEdit/NotebookEdit inside the Pond's root (`mainReadOnlyRoot`, a chat with no workspace
  whose `cwd` is the root); the refusal is a message pointing at `open_stream`, never an
  approval prompt: the chosen permission mode alone decides whether to ask (Skip approvals never asks, Bash is never escalated
  by the Main guard). Codex keeps Main read-only through the sandbox (read-only, or workspace-write with the joined Streams as
  writable roots) and its approval policy follows the chosen mode. A Duck edits a
  Stream by full path: `SessionHost.guardEdit` refuses a file inside a Stream's folder the Duck has not joined, and takes
  the per-file lock (`file-locks.ts`, one lock per absolute file, so per Stream) for the ones it has.
- **Room.** Creating, joining or leaving posts one line from Squeak under the Duck's name: `created Stream <title>`,
  `joined Stream <title>`, `left Stream <title>`. Opening a Stream the Duck is already in posts nothing.
- **State.** `DuckView` and `RoomThread` carry `streams?: {workspaceId, branch, title?}[]` (join order; absent when none).
  A `thread` frame is sent on join and leave. `GET /native/projects/<id>/changes` lists a Duck once per Stream it is in
  (join order). The Mac draws one chip per Stream in the Duck's top bar ("Pond" when none; a click opens Changes narrowed
  to it), lists the Streams in the Duck circle's tooltip, groups Changes per Stream, and shows Squeak's `created/joined/left
Stream` Room lines as compact moment lines (`DuckStreams.swift`, `RailLists.swift`, `RoomMessages.swift`).
- **Clean-up.** A working copy with no Duck in it (any Duck that joined it, or whose chat runs there), no busy chat, a
  clean folder and a branch pushed or merged is removed; the branch stays. After a leave, and every 15 min while the host
  runs.
- **Held back (no behaviour).** `nest` / `poweredBy` are optional on `DuckView` and `RoomThread` for members' own ducks.
- **Phone, cards (phase 3).** With the flag on the phone view carries `ducksOwnBranch: true`, each project pond's
  `branches` (`{name, ducks, lastActivityAt?, pr?}`, newest first, Main left out; `pr` reserved, not read yet; `streams`
  stays for old phones), and each chat's `duckId`, `branch` or `onMain` (also on the pond-threads rows and the host's
  `/threads`). The signed `pond` command `duck-place {duckId, place, message?}` runs `POST /native/ducks/<id>/place`
  (flag on, a duck of the Mac's own view, a pond that is not remote; `place` is the strict host shape). The iPhone
  (`SqueakCore/DuckMode.swift`) lists ducks newest first with a branch label, "Group by branch", no stream picker on a
  new duck, the duck menu (Branch off, Work with…, Move to main) and a header of the branch or "main · read-only" (no
  pull request on main); a remote pond keeps no code chrome. `cardLabel`/`sessionLabel` read "Duck · branch" ("main"
  in the pond's own folder). Flag off, nothing of this is sent or drawn.

- **Migration** (first start, idempotent): every non-archived session in a pond, and every session with an old
  `session_ducks` row, becomes one duck (its name, role and duty kept). A migrated duck's `colourSeed` is its first
  session id, so colours do not change; a new duck's is its own id. A chat that appears later gets its duck the first time
  the room sees it. A `name` of null follows the chat title.
- Routes (token-gated, strict bodies, unknown keys 400): `GET /native/projects/<id>/ducks` -> `{ducks: Duck[]}` (ducks
  with no session, and those whose chat was active in 30 days, newest first); `POST /native/projects/<id>/ducks
{name: 1..32, role?: 0..80}` -> 201 `{duck}` (identity only: idle, no place, no session);
  `PATCH /native/ducks/<id> {name?, role?}` -> `{duck}`; `POST /native/ducks/<id>/duty {on}` -> `{duty, duck}`. The
  session routes `PATCH /native/sessions/<id>/duck` and `POST .../duty` still work and resolve the session's duck.
  SSE `event: thread` carries the `RoomThread` on a name, role, duty or place change.
- **The room page's `threads` are one per duck** (a duck with no session has `sessionId: ""`, state idle). Each adds
  `duckId`, `colourSeed` and `place`; `sessionId` is the duck's current session. A duck is listed while its chat was
  active in 24 h, and always while it has had no session. `RoomTurn.duckId` names the duck that worked a turn.
  `RoomThread` still carries `name`, `role?`, `duty`, `lastActiveAt` and `RoomTurn.ducklings?` as before.
- Off duty: never a job candidate or suggestion, `open_jobs` empty, `claim_job` refused, `send_to_chat` to the duck's chats
  refused. A person's message to it, or a Go/Allow on a job, puts it back on duty.
- Matching ranks **ducks**: name, role and the current chat's title count 3 each, the `working` intent 2, notebook words (none now) and
  the duck's last four turns (across all its sessions) 1.5. `suggestion.sessionId` is its current session ("" for a duck
  with none), `suggestion.duckId` its id; a working duck is suggested with `state: "working"` (it can claim "after this").
  `pitch` and `reason` read as before.
- **Pond Notebook** (`pond-notebook.ts`, table `pond_notebook`, migration after `room_posts` detail): one shared list of
  lessons per pond, at most 40 lessons and 6000 characters in all (300 each, one line). Past either cap the lessons
  given out in a briefing longest ago go first (`last_used_at`, then oldest). Written only at Task end: the agent tool
  `note_to_notebook {lesson, taskDone: true}` is refused unless the chat holds a working Task from the Room and says
  `taskDone`, and after 3 lessons for that Task. Every new Duck's catch-up briefing (`RoomTasks.briefingOf`, the
  `notebook` hook) lists it and tells the Duck to add only lessons that will last; reading marks each lesson used.
  The Owner reads and edits it: `GET`/`PUT /native/projects/<id>/notebook` (`{entries: string[]}` replaces the list in
  that order; over the caps is a 400, not a trim), drawn in Pond settings > Agents (`PondNotebookSection.swift`,
  `NativeNotebook.swift`). The old per-duck notebooks moved into it once at startup (`migrateDuckNotebooks`, one entry
  per line, by "earlier ducks", then cleared); nothing writes `ducks.notebook` any more, and a duck's agent note no
  longer carries a notebook.
- The agent note adds "You are <name>, a duck in <pond>; your role: <role>", the current stream (from the note's own
  "This thread" line).

## Canvas

A canvas is a folder `canvases/<slug>.canvas/` in a pond (Main or a duck's working copy, so git and branches carry it):
`canvas.json` (`{version: 1, title, kind: deck|poster|logo|social|blank, artboards: [{id, name, width, height,
background?}]}` in order), `artboards/<id>.html` (self-contained HTML/CSS, inline SVG ok, body exactly width x height px)
and `assets/` (images, by relative path). Starting sizes: deck 1920x1080, poster 1080x1350, logo 1024x1024, social
1080x1080. System and web-safe fonts only.

- Host: `src/native/canvases.ts` (format, templates, path safety, watcher). Routes (token-gated, no CORS):
  `GET /native/projects/<id>/canvases`, `POST /native/projects/<id>/canvases {title, kind}`,
  `GET /native/canvases?path=` and an SSE `GET /native/canvases/stream?path=` (`hello`, then `changed`, debounced 300 ms).
  A canvas also lists in Artifacts as kind `canvas`.
- Agent tools: `canvas_create`, `canvas_add_artboard`, `canvas_update_artboard`, `canvas_open`; the format note is
  `CANVAS_LINE` in `src/native/thread-context.ts`.
- Hand editing (Mac, phase 2): clicking a board swaps it from its picture to a live WKWebView over it on the pasteboard
  (scaled with the zoom, scroll and pinch handed to the pasteboard); Esc or a click outside draws it back into a picture.
  The editing script is `macos/Sources/SqueakMac/Resources/canvas-edit.js` (no network; page scripts stay off, it runs in
  its own content world; the build scripts copy it into the app; `src/native/canvas-edit.test.ts` runs it under jsdom).
  It gives elements stable `data-sq-id` attributes, selects, moves, resizes, rotates, edits text in place, snaps to artboard
  and sibling edges and centres, and reports each change as the artboard's whole HTML. `CanvasEditor.swift` keeps the undo
  history per artboard (`EditHistory`, ⌘Z / ⇧⌘Z), saves 400 ms after a change, and merges a duck's write by element id
  (`EditMerge`; the same element changed by both keeps the person's and shows "A duck changed this artboard", Reload).
  The Design tab of the right zone (`CanvasDesignView.swift`) edits position, size, rotation, opacity, text, fill, radius
  and border. Routes: `PUT /native/canvases/artboard?path=&id=` `{html}` (atomic write, answers `{modifiedAt}`) and
  `POST /native/canvases/manage?path=` `{op: add|rename|duplicate|delete|reorder|resize, ...}` (canvas.json only). The
  artboard list drags to reorder, "+" adds at the kind's size presets, right-click renames, duplicates, deletes.
- Remote ponds: a canvas is an output (`SHAREABLE_KINDS` has `canvas`); the owner's Mac sends the folder as one
  `<slug>.canvasbundle` (`packCanvasBundle`: canvas.json, artboard HTML, assets as base64, 25 MB at most, no links), the
  member's Mac unpacks it (`CanvasBundle.unpack`, every name checked) and draws it view-only with PDF/PNG export. No remote editing.
- Room cards: the host remembers which canvases a chat's canvas tools made or changed (`Room.noteCanvasTouched`); the next
  `done` post of that chat in the room carries them as `canvases: [{id, path, slug, title, kind, artboards}]` (stored in
  `room_posts.canvases`; the Duck never writes it, a request body cannot set it). The Mac draws a card under the done line:
  the Owner's tap opens `path` like the Canvases list, a Member's opens the view-only bundle by `id` (the artifact wire id).
