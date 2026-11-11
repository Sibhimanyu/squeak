# Ponds: multiplayer Squeak (Flotilla)

Status: design and contract, 2026-11-10. Owner's decisions are marked **D**. **On for everyone** (owner, 2026-11-10); `SQUEAK_FLOTILLA=off` is the off switch. Real sharing has not been tried end to end.

## Every project is a pond (local ponds)

There is no "convert to a pond" step. The host keeps a **local pond** for every project (native projects by `projectId`; the other projects the Mac lists, Conductor's, by name): `GET /native/ponds` and `POST /native/ponds/local` call `ensureLocalPond`, which is synchronous and returns the pond a project already has (local or published, by project id, else by name for a pond with no project), so a project tied to a published pond never gets a second one and no existing pond or chat is touched. A local pond is a `local: true` entry in `flotilla/ponds.json`: its key exists but **nothing goes to any cloud**, nothing is watched, no network call is made, and with no cloud set up the service still constructs and works (`store: null`). Its home is the same page as a published one (a flock of just you, threads, Ripples) with one quiet line that only this Mac can see it.

**The first invite publishes.** `POST /native/ponds/<id>/invites` on a local pond runs `publish` first (the same documents `createPond` writes: the pond's meta with name and gitRemote, the owner's member document, a first Ripple), then makes the invite. One publish per pond runs at a time (a double click shares it); a failure before the owner document is written leaves the pond local with the same id and key, so a retry reuses it and no orphan is made. With no cloud the answer is the plain sentence "Set up a cloud store (Firebase or Catalyst) before inviting someone to a pond." and nothing changes. The Mac's Invite signs in to the Squeak account first when it is signed out, then continues to the invite.

## Words (DESIGN.md §9)

**Pond** the shared container. **Flock** its members. **Thread** one agent on one task. **Nest** a member's machine.
**Egg** an idea not started; starting it hatches a thread. **Duckling** a helper agent. **Quack** a notification.
**Ripples** the activity feed. Workspace still means one git worktree. Controls stay literal.

## The model (D)

- A pond is any folder. Opening one shows its home: the flock and every thread.
- Access is granted per pond. Members see every thread unless its starter marks it private.
- Two kinds of collaboration:
  1. **Own thread**: a member runs their own agent on their own Nest. Needs a pond with a Git remote; code moves only through Git.
  2. **Shared thread**: members chat in a thread running on its starter's Nest. Only messages travel, so any folder works.
- On someone else's thread a member can watch, see the diff, message, steer and answer. **Approving actions and stopping a
  thread belong to its starter**, and only on the starter's own Mac; neither exists as a command on the wire.
- Whoever starts answering a question holds it (`hold`, 30 s, renewed while typing); others see "Aarav is answering".

## Trust

The phone channel's rule holds: **a Mac trusts a key, not a server.**

- Every pond has a random 32-byte **pond key**. Every document is sealed with it (AES-256-GCM, AAD = its path), so the cloud
  holds opaque boxes.
- Each member has a P-256 **member key** per Mac. Every command is signed; the receiving Mac checks membership, role, the thread
  not being private, expiry (≤ 10 min) and a fresh nonce, then runs it through the host's normal send path.
- An invite is a code carrying pond id, pond key, store location and one-time secret. Using it writes a join request; **a person on
  an owner's Mac must approve it**, as pairing does. The approval, signed by the owner, is what adds the member.
- Removing a member rotates the pond key (a new key sealed to each remaining member's public key).
- A guest's message drives an agent on the starter's Mac. So a thread running with `bypassPermissions` refuses other members'
  messages, and they never match the thread's "allow for this chat" rules unless its starter opts in.
- Accounts (Catalyst sign-in) are a seam: `member.accountId` is optional today. Identity today is the member key and a display name.

## Transport

`CloudStore` (`src/cloud/store.ts`), so Catalyst or Firebase, chosen by `cloud.json`. `watch` is the wake-up (Data Streams on
Catalyst, SSE on Firebase); a stream event never carries data and the reader re-reads through the store.

One channel per pond: `channels/<pondChannelId>/<kind>/<doc>`. New kinds, added to the relay's `kinds.json` and the RTDB rules:

| kind       | doc              | contents                                                          |
| ---------- | ---------------- | ----------------------------------------------------------------- |
| `pond`     | `meta`           | name, owner, gitRemote?, created                                  |
| `members`  | member id        | name, public key, role, nest name, owner's signature              |
| `joins`    | request id       | name, public key, one-time secret proof                           |
| `threads`  | thread id        | title, starter, nest, agent, model, state, private, mode, updated |
| `tevents`  | `<thread>-<seq>` | a batch of normalized thread events                               |
| `presence` | member id        | online, viewing thread, typing; expires in 60 s                   |
| `holds`    | request id       | who is answering, expires in 30 s                                 |
| `tcmds`    | command id       | a signed message, steer or answer                                 |
| `ripples`  | time-ordered id  | one activity line                                                 |
| `keys`     | member id        | the rotated pond key sealed to that member                        |

Live output is batched at 250 ms, never token by token. Each event has a per-thread `seq`; a client resumes from its last `seq`.
`tevents` keeps the newest 500 per thread; the starter's Mac remains the source of history.

Normalized event (`ThreadEvent`): `{ seq, at, type, ... }`, with type one of `user` (`by`, `text`), `agent` (`text`), `thinking` (`text`),
`tool` (`label`, `state`), `question` (`requestId`, `text`, `options`), `approval` (`requestId`, `label`; shown, never answerable
remotely), `resolved` (`requestId`), `state` (`state`), `changed` (`files`, `added`, `removed`, `paths` up to 200, and per-file `diff`
up to 64 KB on request through `tcmds` `diff`).

## Host routes (`x-squeak-token`, no CORS, under `/native`)

| route                                              | body                                | answer                                                                                       |
| -------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /ponds`                                       |                                     | `{ ponds: [PondSummary] }`                                                                   |
| `POST /ponds`                                      | `{ name, projectId? , rootPath? }`  | `{ pond }`                                                                                   |
| `GET /ponds/<id>`                                  |                                     | `{ pond, members, threads, ripples, presence, holds, joins, me }`                            |
| `DELETE /ponds/<id>/members/<memberId>`            |                                     | owner only; rotates the key                                                                  |
| `POST /ponds/<id>/invites`                         | `{ role }`                          | `{ code, expiresAt, link? }` (`link` only when an invite link base is configured)            |
| `POST /ponds/join`                                 | `{ code, displayName }`             | `{ pondId, status: "pending" }` (`code` is the code or the link)                             |
| `POST /ponds/<id>/joins/<requestId>`               | `{ approve, role }`                 | `{ ok }`                                                                                     |
| `POST /ponds/<id>/threads`                         | `{ text, agent, model }`            | own thread on this Nest; needs a git remote                                                  |
| `POST /ponds/<id>/share`                           | `{ sessionId, private? }`           | publishes a host chat as a thread                                                            |
| `POST /ponds/<id>/threads/<tid>/visibility`        | `{ private }`                       | starter only                                                                                 |
| `GET /ponds/<id>/threads/<tid>/events?after=<seq>` |                                     | `{ events, lastSeq }`                                                                        |
| `POST /ponds/<id>/threads/<tid>/messages`          | `{ text, mode?: "queue"\|"steer" }` | `{ ok, queued }` (on someone else's thread `queued` is true: it waits for the starter's Mac) |
| `POST /ponds/<id>/threads/<tid>/answers`           | `{ requestId, answer }`             | `{ ok }` or 409 with who holds it                                                            |
| `POST /ponds/<id>/threads/<tid>/hold`              | `{ requestId }`                     | `{ ok, heldBy }` or 409 `{ error, heldBy }`                                                  |
| `POST /ponds/<id>/presence`                        | `{ viewing?, typing? }`             | `{ ok }`                                                                                     |
| `GET /ponds/stream`                                |                                     | SSE; `event: changed`, data `{ pondId }`, never content                                      |

Shapes: `PondSummary { id, name, role, memberCount, threadCount, needsYou, gitRemote?, tint }`; `Member { id, name, role, nest: string | null, online, you }` (`nest` is null for a web guest);
`PondThread { id, title, starter, starterName, nest, agent, model, state: "idle"|"working"|"waiting"|"error", private, mode: "own"|"shared", sessionId?, permissionMode?, workspace?, branch?, participants?, updatedAt }` (`sessionId` is local to the starter's Mac and never written to the cloud; `permissionMode` is, so a guest sees why a message is refused; `workspace` and `branch` are the starter's workspace name and branch, filled when a chat is shared or an own thread is started from the host session's workspace; `participants: { memberId, name, lastAt (ISO-8601) }[]` is the starter plus everyone whose message ran in the thread, newest activity first, at most 50. The starter's Mac keeps the running set in `ponds.json` as turns pass through the bridge (private threads too) and republishes the thread document when someone new joins; other members read it from the document. All five are optional: older threads and older clients simply lack them, and every decoder must ignore what it does not know);
`Ripple { id, at, actor, text }`; `Hold { requestId, by, byName, until }`;
`JoinView { requestId, name, nest: string | null, client?: "web", role }` (the role the invite offered); `Presence { memberId, online, until, viewing?, typing? }`
(`typing` is the **thread id** being typed in, not a flag; `POST .../presence` takes the same: `{ viewing?, typing? }` as ids);
`me { id, name, role, nest }`. `PondSummary` also carries `projectId?` (local to the host: the project the pond was made from, set by
`POST /ponds { projectId }`, never written to the cloud or an invite) and `status`. A 409 from `hold` and `answers` is
`{ error: "<name> is answering", heldBy: "<name>" }`; viewing a pond whose join is not yet approved is a 409 too.
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
  Approval also writes the member's `keys` document, so a key rotated since the invite still reaches them.
- A pond is its channel: pond id = channel id (`channels/<pondId>/<kind>/<doc>`, 22 to 64 url-safe characters).
- Commands (`tcmds`): kinds `message`, `steer`, `answer`, `diff`; anything else (`approve`, `stop`, ...) is "not a command this Mac
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
- Presence expires 60 s after it is written; ripples keep the newest 100.

## Web guests

Some people only need a shared thread and will use a web app (desktop or phone) with no Squeak install. Nothing in the model
assumes a Mac.

1. A member may have **no Nest**: `nest: null`, `client: "web"`. They watch, see diffs, message, steer and answer on shared threads
   exactly like a member, but cannot start own threads or share chats (there is nothing to run them on).
2. Everything a member does is **browser WebCrypto**: ECDSA P-256 signatures (raw `r || s`, the public key as a raw uncompressed
   point, the private key PKCS#8), AES-256-GCM with additional data, ECDH P-256 + HKDF-SHA256, HMAC-SHA256. The canonical signing
   encoding is the UTF-8 of `<path>\n<box>`. `src/flotilla/fixtures/web-vectors.json` has a vector for each (signature, sealed
   document, rotated-key envelope, join proof, member id); `crypto.test.ts` verifies them with `crypto.subtle` alone.
3. Invites also have a **link form**, `https://<app domain>/app/join.html#<code>`: the code is in the URL fragment, which a browser never
   sends, so no server sees the secret (the page reads it, then takes it out of the address bar). The host's `POST /ponds/join` accepts
   either form. The Mac builds the link from `cloud.json`'s Catalyst `appUrl` (`guestInviteBase`, `<appUrl>/app/join.html`); with no
   Catalyst app domain (Firebase, or not deployed yet) an invite has no link, only the code. The page is Catalyst **web client hosting**
   in the relay's own project (`cloud/catalyst-relay/client`, assembled by `scripts/build-guest-client.sh`), so it is served from the same
   origin as the relay (`/server/squeak_relay`) and reaches it by a relative path; served anywhere else it uses the relay URL the invite
   carries. Unverified until the first deploy: that the legacy web client is served under `/app/` (the Catalyst SDK notes say so:
   "`/app/index.html` is for legacy Web Client Hosting") and that `join.html` is served at `/app/join.html`.
   A guest's member key is one P-256 point used for both ECDSA and ECDH, and WebCrypto binds a key to one algorithm: the browser
   makes the pair extractable, imports the private half twice as non-extractable keys and drops the extractable copy; only the
   non-extractable keys are kept (IndexedDB). The invite's secret is used once for the join proof and never stored.
4. A web guest is **not handed the store-wide relay key** (it opens every channel in the store). On approval the owner's Mac asks the
   relay for a pond-scoped token (`POST /pond-token { pondId, memberId, ttlSec }`, relay key required), which the guest receives
   sealed to their member key. `cloud/catalyst-relay/functions/squeak_relay/scoped.js` + `handler.js` implement it, undeployed:
   - `pt.<pondId>.<memberId>.<expiry>.<mac>`, HMAC under the relay key; sent as `x-squeak-pond-token` instead of `x-squeak-relay`.
   - Valid only for `/doc` and `/list` inside that pond's channel; writes only to `presence`, `tcmds`, `joins`, `holds`, `ripples`
     (never `members`, `keys`, `threads`, `tevents`, `pond`). Reads are of sealed documents only.
   - Revoked on removal (`POST /pond-revoke`, a record in the store the relay checks on every request); a new token lifts it.
   - Data Streams: a guest may subscribe only to its pond's own channel (`POST /pond-stream { name }`, channel name derived from a hash
     of the pond id), which the relay also notifies on every write in that pond; it never gets the store-wide `/token`.
     Not yet: the flotilla service issues and stores these tokens (it still writes with the store it was given), and the SDK call that
     creates a pond's stream channel is not wired (the relay answers 503 until the channel exists). The web UI is `web/join.html`
     (docs/web-app.md, "Web guests"); it uses `/pond-stream` with a 60 s safety poll, so it works without that channel.
     A Mac invite for a Catalyst store still carries the store location, relay key included; narrowing that (a join-only token) is open.

5. **Sign-in identifies, never grants.** Guests may sign in with Catalyst Hosted login (Zoho, Google, email). The relay's
   `GET /me` (no relay key, `no-store`) answers `{userId, email, name}` or a bare 401. When a guest writes its join request, the
   relay looks the signed-in user up and writes a relay-owned plain-JSON document `joinids/<requestId>`
   (`{v:1,userId,email,name,at}`): no client token of any scope reads or writes it, and not even the relay key writes it (the Mac
   may read and delete it). The Mac shows it as `verifiedEmail`/`verifiedName` on a pending join; the owner still approves every
   join, and every key, proof and token check is unchanged. `GUEST_SIGNIN=required` (function env var, unset by default) refuses a
   join with nobody signed in (`401 {"error":"signin"}`). An invite may be pinned to an email (`POST /pond-token` with `email`, a
   join token only; the Mac's `invite(pondId, role, email)` and `POST /ponds/<id>/invites {email}`): the join is then refused
   `401 signin` / `403 email` unless that account matches, whatever `GUEST_SIGNIN` says. On Firebase there is no relay and none
   of this. Unverified until deployed: the real `getCurrentUser` answer and that the Hosted-login cookie reaches the function.

## Not yet

a push path, scheduling across Nests, handoffs, Eggs and tasks, file locks, shared secrets. Real use needs a
deployed relay with the new kinds; that deploy and any cloud project are the owner's to start.

### Who wrote a message (host side)

A user message that arrived from another member through a pond is stored with its author: the host's `messages` (and `queue`) rows carry nullable `author_id`, `author_name` (schema version 8), and the host's message API (`GET /native/sessions/<id>/messages`, the SSE `message` event) adds an optional `author: { id, name }` to such a row. The owner's own messages have no `author` key. A queued message keeps its author until its turn starts; several steers merged into one message keep one only when they share an author.

### Sidebar organisation and pond icons (host side, local to this Mac)

Per project, keyed by a native project's id (or a Conductor repository's name, which the Mac lists itself). Stored in the support dir: `project-prefs.json` (`{ <key>: { hidden, labels } }`, 0600, a project with neither is dropped) and `project-icons/<base64url key>.png`. Nothing is published: a pond's cloud documents have no icon field, so the icon and these choices stay on this Mac. **Hiding is only a sidebar choice**: a hidden project's chats stay in search, on the radar and keep pushing notifications.

- `GET /native/projects` rows gain `hidden: boolean`, `labels: string[]` and, only with a Squeak icon, `iconUrl` (`/native/projects/<key>/icon`) and `iconUpdatedAt` (ms; use it as a cache key).
- `PATCH /native/projects/<key>/prefs` body `{ hidden?, labels? }`, strict (unknown key or empty body is 400). Labels are trimmed, 1-24 characters, at most 8, unique ignoring case. Answers `{ hidden, labels, iconUrl?, iconUpdatedAt? }`.
- `GET /native/labels` answers `{ labels: [{ label, count }] }`, sorted by label.
- `PUT /native/projects/<key>/icon`: `{ icon: "data:image/png|jpeg;base64,..." }` (JSON) or the raw bytes with `content-type: image/png|jpeg`. Magic bytes checked, at most 512 KB (413), re-encoded to a PNG of at most 256 px with `sips` (400 if unreadable). Answers the same view as `PATCH`. `GET` answers `image/png` bytes (404 with none), `DELETE` clears it.
- **Colour.** `colour` is a palette name or `null` (clears it; the Mac then derives the tint from the pond's id, as before). `PATCH /native/projects/<key>/prefs` accepts `{ colour }` (case-insensitive, anything else is 400) and `GET /native/projects` and the `PATCH` answer carry it only when set. The palette is `POND_COLOURS` in `src/native/project-prefs.ts` (name to hue in degrees, none in the duck's band 25 to 75): red 355, coral 10, lime 95, green 140, teal 175, cyan 195, blue 220, indigo 245, violet 270, purple 295, pink 325. The Mac draws a named colour with `PondTint.rgb(hue:dark:)`.
- **Pond upkeep by an agent.** Every thread's agent has `pond_appearance` (`{ name, colour, colours, labels, hasIcon }`), `set_pond_icon {path}`, `set_pond_colour {colour}` (a name or `"default"`) and `set_pond_labels {labels}` in Squeak's MCP server (`agent-tools.ts`). They act only on the pond of the calling thread (its workspace's project, else the project whose folder it runs in; a thread with neither is refused). The icon path is resolved with `realpath` and must lie inside the thread's own folder (a symlink out is refused), then goes through the icon route's own validation and re-encode (`ProjectPrefs.setIcon`). Hide, rename, invite and membership have no tool on purpose. At most 10 changes an hour per thread. A change adds a Ripple ("Claude in <thread> set the pond icon") in a published pond; a local pond has no cloud to hold one, so there it is only logged, and a failing Ripple never fails the change.
- Precedence: Squeak icon (`iconUrl`) > Conductor's `repos.icon` (the Mac reads it from Conductor's database) > none.
