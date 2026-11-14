# Step 4 — The remote channel (design, before any code)

> Status: **built** · 2026-09-25 · Roadmap steps 4–5 in `DESIGN.md` §13.
> Firebase project `squeak-5c9gvo` (Firestore in asia-south1), iOS via SideStore.
>
> This is the first step where a device that is not your Mac can make agents
> on your Mac _do things_. That is remote code execution with extra steps: an
> agent running `bypassPermissions` will run whatever a reply asks for. So the
> security model is decided here, on paper, before the first line of code.

## What it has to do

1. **See** — the phone shows what the Squeak window shows: sessions by state,
   the agent's last message, the parsed decision.
2. **Be told** — a push notification when something needs you or a Conductor
   chat finishes (the same events Telegram gets today).
3. **Answer** — tap a letter or send text to one specific chat.
4. **Work when the Mac is not reachable directly** — the phone is on cellular,
   the Mac is behind home NAT. The Mac only ever makes _outbound_ connections.

Explicitly **not** in scope for step 4 (starting new chats was later added, see the end): stopping agents,
approving permission prompts, reading diffs of arbitrary files, anything that
touches a machine other than this Mac. Each is a later, separate decision.

## Threat model

| Threat                                                      | What it would mean                                                | Mitigation (below)                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Someone else's phone sends a reply                          | Arbitrary instructions to a `bypassPermissions` agent on your Mac | Device pairing + per-device keys; Mac verifies every command's signature                                                  |
| The cloud provider (or a leaked admin key) forges a command | Same as above, at scale                                           | Commands are **signed on the phone with a key the cloud never sees**; the Mac rejects anything unsigned                   |
| Replay of an old, legitimately signed "A"                   | An old decision re-sent to a new question                         | Each command names the chat **and the turn it answers**, carries a nonce and expiry; the Mac rejects stale or reused ones |
| Conversation text leaks from the cloud                      | Your code, paths, business details exposed                        | Store only what the phone must render, encrypted end-to-end; short retention                                              |
| Phone lost or stolen                                        | Holder can answer agents                                          | Revocation from the Mac app in one click; biometric unlock before sending                                                 |
| Prompt injection _through_ the channel                      | A message crafted to look like a reply                            | Only the paired human can author commands; nothing from an agent is ever turned into a command                            |

The single most important property: **the Mac trusts a key, not a server.**
Firebase (or anything) is a dumb, untrusted pipe. The same-Wi-Fi path added later
(see "The direct path") is one more such pipe, with its own rows in the
threat model there.

## Options

### A. Firebase (Firestore + Cloud Messaging + Auth) — recommended

The Mac writes an encrypted snapshot and events to Firestore under your user;
the phone reads it and gets FCM pushes; replies go the other way as signed,
encrypted command documents the Mac listens for.

- ✅ Push notifications on iOS and Android out of the box (FCM → APNs).
- ✅ Works from anywhere; the Mac only makes outbound HTTPS connections.
- ✅ Real-time listeners on both sides; offline caching on the phone.
- ✅ Free at this scale (a few thousand small documents a day).
- ❌ A Google account and a Firebase project to set up (15 minutes, yours).
- ❌ One more service holding data — mitigated by end-to-end encryption.

### B. Keep Telegram as the transport

The phone app talks to the existing Squeak bot.

- ✅ Already works, already pushes.
- ❌ A second bot client on the phone fights the one in Telegram; bot
  messages cannot be end-to-end encrypted; the phone app would be a worse
  Telegram. Telegram stays a channel, not the backbone.

### C. Direct connection (Tailscale / WireGuard to the Mac)

The phone talks straight to Squeak's loopback server over a private network.

- ✅ No cloud at all.
- ❌ Requires Tailscale on both devices and the Mac awake and online; no
  push when the Mac sleeps; iOS background networking limits make "tell me
  when it finishes" unreliable.

## Recommended design (option A)

### Pairing

1. The Mac app shows **"Pair a phone"**: a QR code containing a one-time
   pairing secret, the Mac's public key, and the Firebase project id.
2. The phone app scans it, generates its own Ed25519 key pair in the Secure
   Enclave / Android Keystore, and posts its public key, encrypted to the
   Mac's key, to a pairing document.
3. The Mac shows the phone's name and a 6-digit code; you confirm the code
   matches on both screens. Only then is the device added to the Mac's local
   allow-list (`squeak.db`, never the cloud).

### What goes to the cloud

- `snapshot` — the rendered `/state` for active sessions only, plus each
  session's last message **truncated to what a card shows** and its parsed
  choices. Encrypted with a key shared only between the Mac and paired phones.
- `events` — "needs you" / "done" pushes, carrying only a session handle and
  the three-line card text (so the lock screen can show it), encrypted.
- `commands` — from the phone: `{ sessionId, answersTurn, text, mode?,
messageId?, nonce, expiresAt }`, signed with the device key, encrypted to the
  Mac (and the `kind: "start"`, `"usage"` and `"queue"` commands below).
- Retention: snapshot overwritten in place; events and commands deleted by the
  Mac as soon as they are processed, and expired server-side after 24 hours.

### What the Mac accepts

A command is executed only if **all** hold:

1. Signature verifies against a paired, non-revoked device key.
2. `expiresAt` is in the future (default lifetime 10 minutes) and the nonce
   was never seen.
3. `answersTurn` is the chat's **current** latest turn — a letter tapped for
   yesterday's question is refused.
4. The action is on the allow-list: _reply to an existing Conductor chat_.
   Nothing else in step 4.
5. The same busy rules as Telegram and the Mac window (`ConductorReplier`).

Every accepted and rejected command is logged locally and shown in the Mac
app's device list ("iPhone answered B in orchard · irrigation, 14:02").

### The phone

Home is the attention-ordered list from `DESIGN.md` §8.2; a tap opens the
decision card (§8.4) or the reply composer (§8.5). Sending requires Face ID /
fingerprint. Push notifications use the §8.6 three-line card. Built with the
same tokens (`DESIGN.md` §11); React Native (Expo) is the pragmatic choice for
one codebase on both platforms and first-class FCM support.

## Decisions needed from you

1. **Transport:** Firebase (A, recommended), Telegram (B), or direct (C)?
2. **If Firebase:** create a project at console.firebase.google.com (free
   Spark plan is enough) and share its project id — or tell me to write the
   exact setup steps for you to follow.
3. **Phones:** iPhone, Android, or both? (Changes what gets tested first,
   not the codebase.)
4. **Scope check:** step 4 lets a paired phone _reply to existing Conductor
   chats_ and nothing else. Anything you want in or out?

## As built (2026-09-25)

Decisions: Firebase, iPhone only, a new project, reply-only scope.

- **No push notifications on the phone.** A free Apple ID (SideStore) cannot
  use APNs, so Telegram stays the notification channel; the app is where you
  look and answer. The app polls only while it is on screen.
- **No Firebase Auth.** Access is by capability: the channel id (128 random
  bits) is only in the QR code, everything is AES-256-GCM encrypted, and
  commands are signed. The rules (`firebase/firestore.rules`) allow nothing
  else and were checked against the live database.
- **Presence throttles cost.** The phone writes an encrypted presence ping
  every 20s while open; the Mac polls every 2s then, every 15s otherwise, and
  publishes the snapshot every 3s (open) or 60s (not) when it changed. A change
  in what the phone shows (state, title, detail) publishes within ~300 ms
  regardless, at most once a second; the phone looks for a new view every 2s
  while on screen.
- **Compatibility is pinned by fixtures** both ways (`src/remote/fixtures`,
  `ios/SqueakCore/Tests/…/Fixtures`), and `scripts/e2e-remote.ts` pairs and
  replies over the live project with both real implementations.
- **The .ipa is published as .zip**: new projects on Spark refuse executable
  uploads. SideStore installs from the bytes, not the extension.
- **Queue or steer (2026-10-19).** `ReplyCommand` gains an optional `mode`,
  `"queue"` or `"steer"`, sealed and signed with the rest. Absent means queue,
  and the phone leaves it out for a queued reply, so those commands are
  byte-identical to before. It changes only where Conductor puts a message when
  the agent is mid-turn (behind the turn, or into it), so a steer is still a
  plain reply to an existing chat and every check in `handleCommand` still runs
  unchanged; any other value is refused. Only Conductor's relay route can steer.
  Typed into the window, or run in the background, a steer is queued instead and
  the result says so.
- **The result says what happened.** `CommandResult` gains optional
  `delivery` (`"sent"`, `"queued"` or `"steered"`) and `note` (set when a steer
  fell back to queue). A Mac older than this sends neither, which a phone reads
  as "Sent". The phone shows it as the one delivery line under the bubble.
- **Usage, read-only (2026-10-19).** The snapshot gains an optional `usage`:
  `{ claude, codex }`, each null until the Mac has a reading. Windows are
  `{ usedPercent (0-100), resetsAt }` with Claude `fiveHour` / `sevenDay`, Codex
  `fiveHour` / `weekly`, and `observedAt` per provider so the phone can say how
  old a reading is. Refreshing it from the phone came later (see "Usage
  refresh" below). A change in a reading republishes the snapshot;
  a re-read of the same numbers does not.
- **The Realtime Database, streamed (2026-10-19).** With
  `SQUEAK_REMOTE_DATABASE_URL` set, the channel's documents (same paths, same
  `{ box, sig?, device?, at? }`) live in the project's Realtime Database
  instead of Firestore (`src/remote/rtdb-rest.ts`,
  `SqueakCore/RealtimeDatabase.swift`, rules in `firebase/database.rules.json`,
  checked by `scripts/check-database-rules.sh` on the emulator). Why: it bills
  for bytes stored and downloaded, never per read or write, and its REST API
  streams changes as Server-Sent Events, which `fetch` and `URLSession` read
  without an SDK. The Mac holds one stream each on `state/presence`, `pairing`
  and `commands` and runs a pass within ~50 ms of a phone's write, polling only
  every 60s as a safety net; the phone streams `state/snapshot` and `results`
  and ticks every 20s only to keep presence fresh. A stream event only _wakes_
  a pass: everything is still read through the same verbs and every check in
  `handleCommand` runs unchanged, so a forged write to the stream runs nothing.
  On the emulator (`SQUEAK_E2E_DATABASE_URL=… scripts/e2e-remote.ts`) a reply's
  round trip was 74 ms and a steer's 16 ms.
- **A workflow's film, in sealed chunks (2026-10-21).** A RasanAI animatic or
  film plays on the phone. A signed `media` command names what the card
  waiting now plays (checked against the provider's own view, never the
  phone's copy); the Mac makes a phone copy (`addons/rasanai/phone-media.ts`:
  inside the project only, `avconvert`/`afconvert`, cached) and writes it as
  `media/<id>-<i>` documents, each `{ box }` sealed with the channel key over
  `{ i, n, data }` (384 KB of bytes, under the rules' 900,000-character box).
  The result names `{ id, chunks, bytes, sha256, mime }`; the phone fetches the
  chunks two at a time, checks order, count and hash, and plays the file from
  Caches. Chunks are deleted after 30 minutes, and every chunk is in
  `remote-media.json` before it is written, so a restart still deletes it.
  Only on the Realtime Database. Not Firebase Storage: that would be a second
  service with its own rules for the same untrusted pipe. Measured on this
  Mac behind its proxy: a 5 MB film copy up in 106 s, down in 21 s,
  byte-identical.
  - **Films (2026-10-26).** A film is also named by its own id, not only through a chat's session: `film:` and the
    first 16 hex of sha256(realpath(projectDir)). A phone whose presence `caps` has `films` gets `films` in the
    view; the signed `film` command (`answer`, `chat`, `resume`, `stop`, `installTool`) and the `image`/`media`
    commands with a `filmId` all name a film from the Mac's own list (never a path from the phone), and `answer` is
    checked exactly as a `workflow` answer is, against the files as they are now. See docs/rasanai-plugin.md.
  - **Finding the database.** New pairing codes carry it as `r`. A phone paired
    before the move reads the sealed `state/transport` document the Mac writes
    in Firestore (`{ r }`, sealed with the channel key) and follows it,
    re-checking every five minutes while it is still on Firestore. Both the
    Mac's config and the phone accept only an `https` host under
    `firebasedatabase.app` or `firebaseio.com`: the phone sends signed commands
    wherever this points, so a code or a forged announcement must not be able
    to aim it at another server (a forged one cannot be sealed anyway).
  - **Cutover.** Firestore stays the default. Set the URL only once the phone
    runs a build that can follow (1.6+); an older phone keeps polling Firestore,
    which the Mac then no longer updates. There is no dual-write.

## New chats from the phone (2026-10-19)

The first capability beyond replying: a paired phone can **start a new Conductor
chat** in an existing workspace. This lifts the "no new chats" line from the
original scope, deliberately and only this far.

- **Snapshot.** An optional `workspaces: [{ id, label ("repo · branch"),
defaultAgent }]`: the non-archived, non-hidden workspaces from Conductor's
  registry (the same list as `GET /control/workspaces`), newest first, at most 20. It is absent from a Mac that cannot start chats; the phone then hides
  "New chat" and Settings says the Mac needs updating. A change in the list
  republishes the snapshot.
- **Command.** The same signed envelope as a reply, sealed and signed as one
  box, with `kind: "start"`: `{ v: 1, kind: "start", workspaceId, agent
("claude" | "codex"), text, nonce, expiresAt }`. It has no `sessionId` and no
  `answersTurn`. A reply carries no `kind` (or `"reply"`), so replies are
  byte-identical to before; any other `kind` is refused. The result is
  `{ id, status: "sent", sessionId }` or `{ id, status: "refused", reason }`;
  `sessionId` is Conductor's id for the chat, which the snapshot carries as
  `conductorSessionId` once the chat shows up, and the phone opens it then.
- **What the Mac checks, after every check a reply gets** (paired unrevoked
  device key signed the exact box, not expired and at most 10 minutes ahead,
  fresh nonce, decryptable): the Mac offers new chats at all; `agent` is
  claude or codex; the text is non-empty after trimming and at most 20,000
  characters; the workspace is in the list the Mac publishes **read from the
  registry again for this command**, never the phone's copy (so an archived or
  hidden workspace is refused even if the phone still lists it); one start per
  device per 15 seconds. There is no turn check, since there is no turn. Then
  `ConductorRelayService.startChat`, which validates the workspace once more.
- **The phone** signs behind Face ID, like a reply, says "Starting…" until the
  Mac answers and then until the chat appears in the snapshot, and shows the
  Mac's refusal in words. If the Mac does not answer in 30 seconds it says so
  and warns that the chat may still appear, rather than inviting a resend.

**The threat this adds.** Replying could only steer a chat you had already
started and could see. A paired phone, or whoever holds one unlocked, can now
**start an agent in any listed workspace with that workspace's defaults** —
which for a third of Conductor chats means `bypassPermissions` — and give it
its first instruction. The mitigations are the ones replies already rely on
(a device key the cloud never sees, Face ID, revocation on the Mac, short
expiry, nonces) plus: only workspaces that exist today and are not archived
or hidden; at most one start per device every 15 seconds; no way to choose a
directory, a model, a permission mode or a branch, only a workspace the owner
already made; and every start, accepted or refused, in the Mac app's device
activity. It cannot create a workspace, and it cannot start a chat anywhere
else on the machine. Each of those is a separate, later decision.

- **Verbose: thinking live (2026-10-19).** iPhone Settings › "Show thinking
  live" (on by default on the phone since the queue below; the Mac's
  `SQUEAK_REMOTE_VERBOSE=off` still refuses it). With it on, the phone's sealed presence names the
  session open on screen (`watching`), and the Mac publishes that session's
  whole current turn (`src/remote/live-turn.ts`: up to 50 steps of up to
  4,000 characters, thinking included) to `live/<handle>`, sealed, at most
  once a second and only when it changed. The handle is a hash, not the key.
  It stops, and **deletes the document**, the moment the phone leaves the
  session, backgrounds, or its presence lapses (60s), so a turn's thinking
  does not sit in the database afterwards. Only for a session the phone can
  already see, only with a paired phone, and only on the Realtime Database
  (Firestore's rules have no `live`, and a write a second is what it bills
  for). `SQUEAK_REMOTE_VERBOSE=off` on the Mac refuses it outright. An older
  phone's plain `{ at }` presence keeps working. Measured on the live
  project: the turn arrived 786 ms after the phone opened the session.
  The chat history that comes with it is kept on the phone (2026-10-23,
  `HistoryStore`): the last non-empty history of at most 30 chats, in
  `Caches/squeak-history.json` with `.completeFileProtection`, excluded from
  backup, deleted on unpair, so a chat opened after a relaunch shows its
  history at once instead of only the newest message.
- **Steers in the turn, and Conductor's queue (2026-10-19).** The activity
  feed gains a step kind `you`: a message the user sent into a turn that was
  still running (a steer), shown in place inside the turn rather than starting
  a new one. Claude: a user message after a `tool_use` (or a `tool_result`) and
  before an `end_turn`; `isMeta` entries (skill bodies, image notes) are
  ignored and no longer reset the feed. Codex: a user message between
  `task_started` and `task_complete` once the agent has begun answering. It
  flows through the snapshot's six steps and the live doc unchanged.
  The live doc gains `queue`: `[{ id, text, mode: "queue" | "steer", position }]`,
  Conductor's pending messages for the watched chat (`deliveryStatus:
"pending"` only, in queue order, text up to 2,000 characters), read over
  the loopback relay each tick. Absent means the Mac can't read it (relay
  down, not a Conductor chat), and the phone keeps its own list; `[]` is an
  empty queue. A reply may carry `messageId`, a lowercase UUID the phone
  chooses, sealed and signed with the rest and handed to Conductor as the
  message's id so the phone can find its message in that queue; anything
  else there is refused. A fourth signed command,
  `{ v: 1, kind: "queue", sessionId, messageId, action: "promote" | "cancel", nonce, expiresAt }`,
  steers a queued message in now or deletes it. After the shared signature,
  freshness and nonce checks: the chat must be a Conductor chat in what the
  Mac shows the phone (its own snapshot, never the phone's copy), and the
  message must still be in the queue as the Mac reads it then. There is no
  `answersTurn`: the queued message's id is the anchor, and the Mac reads the
  revision and generation Conductor's write needs itself, so the phone never
  supplies them. It can only move or drop a message the owner already sent;
  it adds no text.
- **Stop from the phone (2026-10-19).** `{ v: 1, kind: "stop", sessionId,
answersTurn?, nonce, expiresAt }`, the same checks, then Conductor's own
  Stop over the relay (`…/sessions/:sid/stop`, which also pauses the queue).
  It must name the chat's current turn (absent means none), so a Stop sent
  during one turn cannot stop the next, and the replier refuses a chat
  Conductor does not call working.
- **What changed, from the phone (2026-10-19).** `{ v: 1, kind: "diff",
sessionId, file?, nonce, expiresAt }`, read-only but signed, since it
  reveals code. The folder and base branch come from the Mac's snapshot of a
  chat the phone is shown, never from the phone. The result carries `diff`
  (the file list, fleet/diff-view.ts) and, when `file` is an index into it,
  `patch: { index, path, text }` (up to 12,000 characters). No Face ID.
- **The work between two messages (2026-11-08).** `{ v: 1, kind: "work", sessionId, messageId, nonce, expiresAt }`,
  read-only but signed (it reveals what the agent did). `messageId` is a history entry's id (its rowid); the Mac
  reads Conductor's rows of a chat the phone is shown and returns the tool calls (and thinking summaries) between the
  text message before it and it: `work: { steps: [{ kind: "tool" | "thinking", text }], more }`, oldest first, plain
  labels as `activity.ts` words them (never raw input), 200 characters each, at most 200 (`more` counts the rest).
  Offered only when the view carries `workSteps`, which is absent with `SQUEAK_REMOTE_VERBOSE=off` or on the shared
  server (src/fleet/work-steps.ts).
- **A photo resent after a lost answer (2026-11-08).** The Mac remembers a finished upload for 15 minutes: a repeated
  chunk of it (same `uploadId`, total and folder) answers with the same `ref` and writes nothing, so the phone may
  resend a chunk once when its result does not come. A photo that arrived while the message after it failed is sent
  again by its `ref`, not uploaded again.
- **Hotspot failover (2026-10-20).** `{ v: 1, kind: "hotspot", action:
"configure" | "join" | "leave", ssid?, password?, enabled?, nonce, expiresAt }`.
  `configure` carries the hotspot's name, its WPA password (8–63 printable
  ASCII) and whether to switch by itself; the password goes to the Mac's login
  Keychain and is never written to a file, a result, or the phone's view, which
  carries `hotspot: { configured, ssid, enabled, onHotspot, last }`. `join`
  switches the Mac to it now and `leave` back to its usual Wi-Fi. Face ID on
  the phone first: it changes how the Mac reaches the internet.
  The Mac app sets the same thing up through the token-gated
  `POST /control/hotspot` (`configure`, `join`, `leave`, and `clear`, which
  also removes the Keychain item); both end in the daemon's one
  `applyHotspot`, and neither echoes or logs the password.
- **Lid actions (2026-10-23).** `{ v: 1, kind: "lidActions", settings:
{ displayOff?, mute?, lowPower?, freezeApps? }, nonce, expiresAt }` changes
  what the Mac does when its lid closes in a lid-closed awake session
  (fleet/lid-actions.ts). After the shared checks the Mac reads `settings`
  strictly: one to four known keys, booleans only, anything else is refused,
  and nothing is applied. It is applied through the daemon's `applyAwake`
  (`{ action: "lid-actions", settings }`), the same path as the Mac app's
  control route. It reaches no agent and carries no words, so no Face ID. The
  phone view gains optional `awakeLidActions: { displayOff, mute, lowPower,
freezeApps }`, `awakeRules: { lowPowerPercent, endPercent, heat }` (the
  effective safety floors; a phone says 40 and 10 only when absent),
  `awakeLastEnd: { reason, at, why? }` and `awakeSleepProblem`. Older phones
  ignore them, so no `caps` entry is needed; a phone hides the switches when
  the Mac sends no `awakeLidActions`.
- **Images from a chat (2026-10-19).** `{ v: 1, kind: "image", sessionId,
source, nonce, expiresAt }` asks for an image the chat's agent showed
  (`![alt](source)` alone in a paragraph). Read-only but signed. After the
  shared checks: the chat must be one the phone is shown; `source` must appear
  in the chat's own messages (its latest answer or its history), so a phone
  cannot name an arbitrary path; and `phone-image.ts` resolves it (symlinks
  followed) to a file inside the chat's workspace folder, an image type, at
  most 30 MB, then sends it shrunk by `sips` to a JPEG of at most 1,600 px
  (`result.image: { mime, data }`, base64, at most 700 KB). The phone asks
  only when you tap, and keeps it in memory only.
- **Plans on the phone (2026-10-19).** A session waiting on ExitPlanMode
  carries `question: { toolUseId, questions: [], plan }` (the plan's text,
  up to 20,000 characters, from `readPendingAsk`). The phone's plan card
  answers it with the existing `answer` command's `plan: { approve: true }`
  or `{ approve: false, note }`, and no `answers`.
- **History in the live doc (2026-10-19).** `history: [{ role: "user" |
"assistant", text, at }]`: the watched chat's own messages, every user
  message and the agent's last message of each turn, the newest eight, each
  up to 2,000 characters (`condenseHistory`, read from `session_messages`).
  It has the same narrowness as the rest of the live doc: only the chat on
  screen (an active one, or one in the phone's Recent list, found by
  `watchableSession`; never an arbitrary key), deleted when the phone leaves
  it, and only for a Conductor chat.
  The phone shows it above the chat, less what it already shows.
- **Usage refresh from the phone (2026-10-19).** A third signed command,
  `{ v: 1, kind: "usage", nonce, expiresAt }`, with no text and no target. It
  passes the same signature, freshness and nonce checks, then runs the Mac's
  own `ClaudeLimitsRefresher`, which fetches usage from Claude's usage endpoint (no tokens spent) at most once
  a minute whoever asks (a second press inside the minute gets the cached
  reading, `throttled: true`). The result says `refreshed`/`throttled`; the
  reading itself arrives in the snapshot, published at once. No Face ID: it
  sends nothing to an agent.

## Add-on command dispatch (2026-11-12)

A phone command kind core does not handle itself belongs to an add-on (`AddonHandle.phoneCommands`; RasanAI's `workflow`
and `film`). The order in `handleCommand` never changes for them: (1) a paired, unrevoked device signed exactly this
box, (2) it decrypts, (3) it is unexpired (≤10 min) and its nonce is new, (4) core's own kinds in turn, and only then
(5) the add-on's kind, where core caps the serialized command at 64,000 characters, refuses with "This Mac can't answer
that from a phone." while the add-on is disabled (and "Not a request this Mac understands." when no add-on has the
kind), and calls `handler(command, { deviceName, now, snapshot })`: never the channel document, the key or the store.
The handler answers `{ ok, said }` or `{ ok: false, reason }` and core writes the sealed result and the log line. The
add-on host refuses, at load or register time, a handler for a kind in `CORE_COMMAND_KINDS` (`src/remote/command-kinds.ts`,
kept equal to what `handleCommand` handles by `command-kinds.test.ts`) or one another add-on already took, so an add-on
cannot shadow `reply`, `awake` or any other core kind. `image` and `media` commands carrying an add-on's own keys
(`AddonPhoneImages.fields`, `AddonPhoneMedia.fields`) are resolved by that add-on (which folder, or why not); the read
and the sealed-chunk upload stay core's.

## Answering an agent's question from the phone (2026-10-19)

**`answer`.** A signed command `{v:1, kind:"answer", sessionId, toolUseId, answers?, plan?, nonce, expiresAt}`
answers an agent's pending `AskUserQuestion` or `ExitPlanMode` (design: `docs/answering-questions.md`).
The Mac keeps every reply check (paired unrevoked key, signature, ≤10 min, fresh nonce) and adds:
unknown fields are refused; the chat's pending tool call must still be `toolUseId`, read fresh from the
transcript; every picked label must exist; single-select takes exactly one pick or `other`; `other` and a
plan note are ≤2,000 characters; one entry per question; one answer per device per 15 s. The phone view
carries the pending question's `toolUseId` so the phone can name exactly the question it answers.

**Threat.** A paired phone can answer a pending question or approve a plan: the same power as a reply, no
more, since the answer is something the agent reads. It cannot approve a permission prompt. While
Conductor's API can't take answers (501 in 0.91.1), the Mac stops the waiting turn first, so a stolen
paired phone could also interrupt a question. Revoking the device removes all of this.

## Squeak's own chats from the phone (2026-11-09)

Native chats (`src/native/`, origin `squeak`, key `squeak-native:<id>`) are answered and started by one signed
command, `kind: "native"`, built in `src/fleet/native-phone.ts` and checked in `RemoteBridge.handleNative`. It rides
the same envelope as every command, so the shared checks hold first and unchanged: a paired, unrevoked device's
signature over the exact box, `expiresAt` within 10 minutes, a nonce seen once. Then, per action:

**`respond`** `{action, sessionKey, requestId, decision: allow|deny, message?, scope?: "session", answers?}`.

- The chat is looked up in the Mac's own snapshot (`active`, origin `squeak`), never from the phone's copy.
- `requestId` must be the session host's CURRENT open request, asked of the host (`GET /native/sessions/<id>/requests`,
  newest) at the moment of the command. A stale tap, a request answered at the Mac or from Telegram, or a chat with
  nothing open is refused ("already answered"); a host that answers 404/409 is the same.
- `scope: "session"` (Allow for this chat; the host derives the rule) only with `allow`, and only for a tool, command
  or file request, never a plan or question. `message` (a note, at most 500 characters) only with `deny`.
- `answers` `[{question: index, picked: label}]` only for a question and only with `allow`; the index must name one of
  the host request's own questions, the label must be one of its options (a multi-select may join labels with
  ", "), one answer per question. The record the agent reads is built on the Mac from the request's own words. An
  `allow` of a question without answers is refused. Free text is not accepted.

**`start`** `{action, projectId, where: newWorkspace|workspace|folder, workspaceId?, agent, model, effort?, permissionMode, text}`.

- The project must be one the Mac lists now (read from `native.db`); `workspace` needs a `workspaceId` that is a ready
  workspace of that project, and its folder comes from the Mac; `folder` is the project's own root, never a path from
  the phone; `newWorkspace` asks the host for a fresh one. `workspaceId` with any other `where` is refused.
- `model` must be one the Mac offers for that agent (`nativeModels`, Conductor's picker list) and `effort` a level it
  takes. `text` is trimmed, non-empty, at most 20,000 characters. One start per device per 15 s.
- `permissionMode` is `default`, `acceptEdits` or `plan`. **`bypassPermissions` (skip approvals) is refused unless the
  Mac allows it: `SQUEAK_REMOTE_NATIVE_BYPASS=1` in Squeak's `.env`, off by default.** The view says which modes the
  Mac accepts (`nativePermissionModes`).
- Answer: `{status: "sent", sessionKey}`; a refusal carries a fixed sentence.

**The view.** For a phone whose presence `caps` name `native` only: each native session with an open request carries
`nativeRequest` `{id, kind, summary, tool?, command?, path?, plan? (≤2,000), questions? (≤4, ≤8 options each),
chatRule}`, clipped display strings, never the whole tool input; and the view carries `nativeProjects` (id, name and
ready workspaces, no folder paths), `nativeModels` and `nativePermissionModes`. All optional: an older phone ignores
them, a phone updated before its Mac shows no native card and no Squeak target. Chats carrying `nativeRequest` are
republished when its id changes.

**Threat.** A paired phone can now approve a tool the agent wanted to run, which is more than answering a question: the
same as clicking Allow in the Mac app. It cannot approve a request it was not shown (the id is the host's current one),
cannot answer a question with words the agent did not offer, cannot name a folder, and cannot start a chat that skips
approvals unless the Mac owner turned that on. Revoking the device removes all of this. Known gap: `start` into an
existing workspace sends the workspace's folder and id, but the host's `POST /native/sessions` links only a new
workspace to the session (`workspaceId` is not read from the body yet).

## Keeping the phone current (2026-10-20)

Measured on the live channel: the database speaks HTTP/1.1 only, the view is
29 KB sealed and rewritten whole on any change, and `results` had 43
documents spanning 22 hours because nothing deleted them.

- **One stream per path, on its own session.** iOS allows four connections
  per host over HTTP/1.1, and the phone held four streams (view, results, the
  Mac's answer, the open chat's turn) with every command opening a fifth, so
  presence pings and commands queued behind streams that never end. Now the
  view and `alive` share one stream on `state` (the phone's own presence echo
  is ignored), every listener on a path shares one connection (`StreamHub`;
  a listener joining an open stream is told to re-read once), and streams run
  on `Channel.streamSession`, a pool apart from requests.
- **Supervised, never silently dead.** A view that cannot be opened no longer
  ends the stream; it asks for a full read and the stream carries on. If any
  stream ends, all restart. A new network (NWPathMonitor) reconnects at once,
  retries back off only to 5 s, and 45 s of silence (keep-alives come every
  30 s) counts as dead.
- **"Synced" means heard.** It is the last stream event or full read, never a
  presence write. Five seconds without the stream, the phone says
  "Reconnecting… showing the view from …". A full read that started before a
  streamed view arrived is dropped rather than put back over it.
- **Results are cleaned up.** The phone deletes a result once read; the Mac
  sweeps any older than 15 minutes every 5 minutes.
- **Presence is timed by the Mac.** A new ping counts from when the Mac saw
  it, not the phone's stamp, so a phone clock running behind still counts as
  open (the first read after a start keeps the stamp: it may be old).
- **Working rows keep up.** While a phone looks, a working chat's new steps
  republish the view within 3 s instead of waiting for the next ping.
- Settings › Connection details shows each stream: up or not, last heard,
  drops, bytes.

## Smaller and in order (2026-10-20)

- **The phone says what it reads.** Its sealed presence carries `caps`
  (`["z", "split"]` from 1.7.17). The Mac writes the new formats only for the
  phone in front of it, only on the Realtime Database, and goes back to the
  original whole, uncompressed documents the moment a presence without them
  arrives, so an older phone keeps working.
- **`z`: compressed.** The box's plaintext is a zero byte then raw DEFLATE of
  the JSON (`seal(key, value, { compress: true })`; Swift inflates with
  `NSData.decompressed(using: .zlib)`). JSON never starts with a zero byte.
- **`split`: the rarely-changing parts apart.** `state/snapshot` leaves out
  `recent`, `recentMore` and `workspaces` and says `split: true`; they are in
  `state/recent` (`{ v, seq, recent, recentMore, workspaces? }`), written first
  and only when they change. A live turn's `history` moves to
  `live/<handle>-h` (`{ v, key, seq, history }`), written only when it
  changes; the turn says `split: true`. Both are deleted when the phone
  leaves. On the live channel this took a view update from 19 KB to 2.4 KB.
- **`seq` on every write** (snapshot, recent, live turn, history): one
  counter, never below the Mac's clock. The phone drops a document numbered
  below the one it shows, unless the gap is over 10 s (a Mac restarted with
  its clock behind). The live turn also carries the session's `state` and
  `turnId`; for the chat on screen, the newer of the view and the live turn
  says what it is doing.

## Honest delivery of a reply

A bubble on the phone says "Sent" only when the Mac's result says `sent`, and the Mac says `sent` only
once the chat shows the message (`ConductorReplier.confirmRelayDelivery`: a `session_messages` user row, the chat
starting, or, mid-turn, the message in Conductor's queue). The relay's 2xx alone is not proof (a paused queue
answers 2xx). The result statuses are `sent`, `refused` (nothing started) and `unconfirmed` (the route took it, nothing
proved it arrived: never resent by the app, the person checks the chat). The phone waits 30 s, then deletes the
command from the channel (so it can never run later), gives a Mac that had just read it 12 s more, and only
then says "Not sent. Nothing started." (command taken back) or "Couldn't confirm" (the delete failed too).
Unsettled sends are kept in `OutboxStore` (Caches, complete file protection, no backup, cleared on unpair) so a relaunch
never loses the text; Send again reuses the Conductor message id, Edit puts the text back in the composer.

## The direct path: same Wi-Fi, no cloud (2026-10-23)

Option C above, built differently from how it was first sketched: not Tailscale, and not instead of the cloud.
When the phone and the Mac are on the same network the phone talks to the Mac **directly**, and whenever that
fails for any reason it is on the cloud again within the same call. Everything that makes the cloud path safe is
kept, because the direct path is just another untrusted pipe: the same sealed boxes, the same device signatures,
the same `handleCommand`.

**How it is built.**

- **The Mac.** `LocalChannelServer` (`src/remote/local-channel.ts`) listens on every IPv4 interface (port from
  `SQUEAK_REMOTE_LOCAL_PORT`, else a free one) while at least one unrevoked phone is paired; `SQUEAK_REMOTE_LOCAL=off`
  never starts it. It serves the channel's documents **exactly as the Realtime Database holds them**, from memory, in
  the database's own REST dialect with the channel id left out of the path:
  `GET /state/snapshot.json`, `PUT /state/presence.json`, `PUT|DELETE /commands/<id>.json`, `DELETE /results/<id>.json`,
  and an event stream (`GET /state.json` with `accept: text/event-stream`, also `results`, `live`). Nothing else is
  served: no pairing (a phone is only ever paired through the cloud, behind the human's approval), no media, no other
  collection, and a phone cannot write what the Mac writes.
- **A store mirror, not a second path.** `MirrorStore` (`mirror-store.ts`) wraps the store the bridge already uses.
  Every write the bridge makes (view, recent, live turn, `alive`, results) also lands in the in-memory `DocTree` the
  server reads, so both transports show the same sealed documents and there is one code path for what the Mac says.
  What a phone writes locally (presence, commands) is merged into what the bridge reads (`get`/`list`), so a local
  command goes through **every** check in `handleCommand` unchanged, and the results the bridge writes reach both
  transports. A write on either side wakes the bridge's pass (`watch`), and a cloud read that fails is not fatal while
  a phone is local, so a Mac without internet still answers a phone beside it.
- **Once, even on both.** After the bridge handles a command it deletes it, and `MirrorStore` remembers that id for
  15 minutes and hides later copies, so the same command arriving on the other transport after the first ran neither
  runs again nor makes the Mac write "already received" over the real result. If a _different_ id carries the same
  nonce, the nonce check refuses it as ever. A phone's local delete (taking a command back) removes only the local
  copy, so a withdrawn command can still be sent through the cloud.
- **The phone.** `LocalRouter` / `RoutedBackend` (`SqueakCore/LocalRoute.swift`) sit behind the `ChannelBackend`
  the channel already uses, so no caller changed. `RouteMachine` is the pure rule set: prefer local when a probe
  (an authenticated read of `state/alive`, 1 s timeout) succeeds; any failed or slow local call, or two missed
  5-second heartbeats, returns to the cloud at once; from the cloud, local is probed again every 30 s, when the
  network changes (NWPathMonitor), and when the Mac's address becomes known. Streams follow the route (a local stream
  that drops demotes the route, and the stream moves to the cloud's). The phone finds the Mac two ways: Bonjour
  `_squeak._tcp` (the TXT tag must equal this channel's own tag) resolved to an IPv4 address, and the `local`
  field of the Mac's sealed view (`{ port, hosts, tag }`: private IPv4 addresses on `en*` interfaces), for when
  Bonjour is blocked. The phone tries only private-range or loopback addresses and only when the tag matches.
- **A command goes out on exactly one transport.** Sent locally, it is not sent to the cloud. If the local write
  fails with an error that proves nothing was sent (connection refused, no network), it goes through the cloud. If it
  fails ambiguously (a timeout: the Mac may have it), the phone first deletes it from the Mac, and only a confirmed
  delete lets it go through the cloud; if the Mac cannot be asked either, it is **not** sent again anywhere and the
  caller gets the failure, so the app's existing outbox logic (withdraw, "Couldn't confirm", never resend) takes
  over. Withdrawing a command goes to the transport it was sent on, and to both when that is not known.
- **Left on the cloud.** Pairing, and a film's media chunks (384 KB each: not worth holding in the Mac's memory
  twice), always use the cloud. The web client stays on the cloud: a browser cannot browse Bonjour or call
  `http://` from an https page.
- **Presence on two paths.** The phone's presence is sealed, so the Mac cannot compare two pings by their own stamp.
  The newer of the two is whichever the Mac received locally (stamped on arrival) or first saw change in the cloud
  most recently.

**Request authentication** (`local-auth.ts`, `SqueakCore/LocalAuth.swift`; both pinned by
`Fixtures/local-auth.json`, regenerated by `scripts/make-local-fixture.ts`). Every request carries
`x-squeak-ts`, `x-squeak-nonce` (16 random bytes, hex) and `x-squeak-mac`: base64 HMAC-SHA256, under a key derived from
the channel key (HKDF-SHA256, no salt, info `squeak-local-v1`), of
`squeak-local-v1 \n METHOD \n target-as-sent \n ts \n nonce \n sha256(body)`. The Mac refuses a stamp more than 60 s
from its own clock, a MAC that does not match (constant-time), and a nonce it has seen (remembered for the window).
Every refusal is the same bare `401`, whatever the reason; a path or verb outside the allow-list is a `404` only after
authentication. A response carries `x-squeak-rmac`, a MAC over `squeak-local-v1-resp \n request-nonce \n status \n
sha256(body)`: the phone believes a successful answer only if it proves it was made for **this** request, so a host on
the LAN cannot replay an old document as if the Mac had just said it. An event stream's first answer carries that MAC
(for an empty body); its events only ever say "something changed" and never carry data, and the phone reads what
changed through signed requests.

**Limits.** Bodies at most 1,000,000 bytes (the database's box limit is 900,000 characters); documents must have
exactly the database rules' shape; at most 8 open streams (4 per address), 32 requests in flight, 600 requests a minute
per address, and an address that fails authentication 20 times in a minute is refused for the rest of it; header and
request timeouts of 10 and 20 s; the mirror holds at most 32 MB; commands, results and live turns nothing deletes are
dropped after 15, 30 and 30 minutes. No CORS header is ever sent.

**Discovery.** `LocalAdvertiser` runs macOS's own `dns-sd -R Squeak _squeak._tcp local <port> t=<tag> v=1`
(no dependency), restarts it with backoff if it dies, moves it when the channel is reset, and stops it with the server
(or when the last phone is revoked). The only TXT data is `t`, the first 8 bytes of
`HMAC-SHA256(channel key, "local-id")` in hex: it names no one and cannot be turned into the key, but it is stable,
so someone on the same network can tell that a Mac running Squeak is there. The service name is just "Squeak".

**Why plain HTTP is acceptable here, and where it is not.** The content is sealed (AES-256-GCM under a key the LAN never
sees) and every command is signed by a key in the phone's Secure Enclave, so a LAN observer reads only sizes, timing,
paths (`/commands/<id>`, never the channel id), the paired device's id and a MAC, and a LAN attacker can neither forge
nor alter content. Adding TLS with a pinned self-signed certificate would hide those too, but would put a certificate
lifecycle on every Mac and phone for no new authority, and iOS gives a Local Network connection to a private address
an ATS exemption (`NSAllowsLocalNetworking`) for exactly this. Not accepted: anything unauthenticated, anything that
puts the channel key or channel id on the wire, anything outside the allow-list.

| Threat on the direct path                                        | Mitigation                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A host on the same network reads or sends                        | Every request needs a MAC under a key only the Mac and paired phones hold; a command still needs a paired device's signature; documents are sealed. A stranger gets a bare 401                                                        |
| A captured request is sent again                                 | 60 s window plus a remembered nonce; commands also keep their own expiry and nonce checks                                                                                                                                             |
| A host impersonates the Mac and replays an old view              | A response MAC binds the request's nonce; without the key an impostor cannot make one, and the phone falls back to the cloud                                                                                                          |
| A host (or a forged view) aims the phone at a server it controls | The phone tries only private-range addresses, only from the Mac's own sealed view or a Bonjour result whose tag matches, and sends nothing the key is not needed to read: a signed request reveals neither the key nor the channel id |
| Flooding the Mac                                                 | Per-address rate and failure limits, stream and in-flight caps, size caps, timeouts                                                                                                                                                   |
| The channel id leaks from the LAN                                | It is never in a local path or header, so a sniffer cannot address the cloud channel                                                                                                                                                  |
| A command runs twice (both transports, or a retry)               | One transport per command, a confirmed take-back before a cloud resend, the Mac's handled-id memory, and the nonce check                                                                                                              |
| Reading the Mac's other state                                    | Nothing but the channel's `state`, `results`, `live` and `commands` is served, and only what the bridge itself wrote                                                                                                                  |

**What the owner must do.** The iPhone asks once for **Local Network** access ("Squeak talks to your Mac directly
when you're on the same Wi-Fi."); declining keeps everything on the cloud. If the Mac's firewall is on, macOS asks once
whether `node` may accept incoming connections: allow it, or leave the path off. Networks that isolate clients (many
guest and public Wi-Fi) simply never answer the probe and the phone stays on the cloud. A phone whose clock is more
than a minute off the Mac's is refused locally and stays on the cloud.

**Shown on the phone.** Settings › Your Mac and Connection details say "Connected · same Wi-Fi" or
"Connected · via cloud".

**Measured.** `SQUEAK_E2E_LOCAL=1 npx tsx scripts/e2e-remote.ts` (an in-memory database as the cloud, the real
`LocalChannelServer` on 127.0.0.1, the real phone code): pairing through the "cloud", then a reply's round trip in
62 ms, a steer's 62 ms, a start's 4 ms and a usage refresh's 8 ms with the cloud seeing none of those commands; then the
Mac's local server is stopped and the phone's next reply goes through the cloud, once.

## Earlier messages, page by page (2026-10-24)

Reading a chat's history is paged by SQLite rowid, newest first, in chunks (200 rows, then 2000) until enough
messages turn up, so a turn of hundreds of tool rows no longer hides its own prompt. A message carries
`cursor` (its rowid, a string); a result carries `nextBefore` (string or null) and `complete`.

- **Mac route:** `GET /control/session/<id>/transcript?limit=N&before=<cursor>` returns
  `{ messages: [{ id, cursor?, role, text, at, turnId, workBefore? }], complete, nextBefore }`. `before` is digits
  only (a positive integer); anything else is a 400. Token-gated, no CORS, like the other control routes.
- **Phone command (signed, read-only):** `{ v: 1, kind: "history", key, before?: "<cursor>", n?: 1...12,
nonce, expiresAt }`. It runs through `handleCommand` (device signature, expiry, nonce) but has no turn check, since
  it changes nothing. `key` must be a session the Mac shows the phone (active, or in Recent with a Conductor chat);
  `n` above 12 is clamped. One page at a time per chat. Needs a streaming store (the Realtime Database), like the
  live turn. The result is `{ id, status: "sent", doc }`, or `refused`.
- **Answer document:** `live/<handle>-h<before|latest>` (`historyPageDoc(key, before)`; `handle` is `liveHandle(key)`),
  sealed like every live document: `{ v: 1, key, before, entries: HistoryEntry[], nextBefore, complete, seq }`. An
  entry is `{ id?, role, text, at, workBefore? }` (`id` is the rowid of the entry's last message, text clipped to
  2000). `nextBefore` is what to send as the next `before`. The document is deleted after 30 minutes with the media
  chunks (`remote-media.json` ledger, also swept at start). The direct path serves it unchanged.
- **Phone view:** each session may carry `lastUser: { text, at }` (the newest user message, 200 characters), so an
  answer typed at the laptop shows while the chat is closed on the phone. A `steer` reply is refused while the chat
  waits on a question or plan in Conductor.

## Subagent feed (2026-10-25)

What one Claude subagent of an open chat is doing, for a phone that tapped it. Same rules as the live turn
(verbose gate, presence, sealed, one document, deleted on leaving), narrower: one subagent at a time.
`src/remote/subagent-feed.ts`; the reader is `src/fleet/subagent-activity.ts`.

**Where the steps come from.** Claude Code writes each subagent to
`<project>/<session-id>/subagents/agent-<agentId>.jsonl` (entries like the main transcript, all
`isSidechain: true`) and `agent-<agentId>.meta.json` with `toolUseId`. The parent's launch result names the
same id (`toolUseResult.agentId`, also the `agentId:` line of the result text) for async and foreground
agents. Verified on real transcripts; a meta file is the fallback. The reader accepts only
`^[A-Za-z0-9]{6,40}$` agent ids and `^[A-Za-z0-9_-]{8,80}$` task ids, and the file must be a regular file
inside that session's own `subagents` directory. Steps are labels (`describeClaudeTool`), never raw input.

**The view.** Each `background` item of an agent may carry two new optional fields (older Macs omit them):

```json
{
  "id": "toolu_01…",
  "kind": "agent",
  "label": "Survey the tests",
  "status": "running",
  "background": true,
  "agentId": "a1b2c3d4e5f607182",
  "hasSteps": true
}
```

`hasSteps` is present (always `true`) only when the subagent's transcript can be read now. A phone shows a
tap target only then. A Mac whose `/state` reader or verbose is off never publishes the feed; the command is
refused.

**The command** (sealed like every command: `{ box, sig, device }`; same nonce, expiry, signature checks).
Exactly these keys, no others:

```json
{
  "v": 1,
  "kind": "subagent",
  "key": "<session key open on screen>",
  "taskId": "toolu_01…",
  "nonce": "…",
  "expiresAt": 0
}
```

`taskId: null` stops the feed. Otherwise the Mac refuses unless: verbose is allowed, the key is the chat the
phone's presence `watching` names and the phone is open, that chat is an active Claude chat, and the task is
one of its subagents as the Mac reads them right now. Result: `{ "id", "status": "sent", "doc": "<handle>-s" }`
(a stop has no `doc`), or `{ "id", "status": "refused", "reason" }`.

**The document** `live/<handle>-s` (`handle` is `liveHandle(key)`, so the doc is the live turn's id plus `-s`),
sealed with the channel key, overwritten in place at most once a second and only when changed:

```json
{
  "v": 1,
  "key": "<session key>",
  "taskId": "toolu_01…",
  "agentId": "a1b2c3d4e5f607182|null",
  "label": "Survey the tests",
  "status": "running|done|failed|stopped",
  "available": true,
  "total": 4,
  "steps": [{ "kind": "thinking|note|tool|background|you", "text": "…", "at": "ISO|null" }],
  "seq": 123
}
```

`steps` is the newest 50, oldest first, each text up to 4,000 characters; `total` is how many the subagent has
had. `available: false` means its transcript is not readable yet (`steps` empty). A phone checks `taskId`
against the one it picked and keeps the higher `seq`. Choosing another subagent of the same chat overwrites the
document. It is deleted when the phone sends `taskId: null`, leaves the chat, or its presence lapses.

**Mac HTTP:** `GET /control/session/<sessionKey>/subagent/<toolUseId>/activity` (token-gated, no CORS header)
returns `{ taskId, agentId, label, status, available, steps, total, startedAt, endedAt }` (steps clipped
as the main feed's are); 404 for a task the session does not have. The existing `/activity` route's
`background` items carry `agentId` and `hasSteps` too.

## New chat presets (2026-10-30)

Best / Balanced / Save usage are one setting on the daemon, edited from the Mac app (Settings, General), the phone
and the web; the surfaces only draw. Code: `src/fleet/chat-presets.ts` (`ChatPresetsStore`), saved in
`<support dir>/chat-presets.json` (0600, atomic write). It stores only what a person changed: a name per preset
(shared by both agents) and, per agent and preset, a whole setup (`modelId`, `level`, `code`, `run`, `planFirst`)
that replaces the built-in one. Absent means the built-in rule, so a Mac nobody edited behaves as before.

- `GET /control/presets` and `POST /control/presets` (token-gated, no CORS header): one change per POST, strictly
  `{ agent, preset, change: { setup } | { reset: true } }` or `{ preset, change: { name } }`; the answer is the document.
- The phone view carries `presets` (`{ names, setups }`; absent on an older Mac). The signed `presets` command is the
  same request with the usual envelope, ends in the same `applyPresets`, and needs no Face ID: it touches no chat.
- A setup naming a model the Mac does not list (or a level it does not take) is refused when the Mac can check; a
  worker must be one of `SPLIT_WORKERS`; Codex setups cannot delegate.
- Mac app: keeps a local copy and a queue of unsent edits (`ChatPresetSync`), migrates presets customised before
  this once (the daemon's entries win), and uses the built-in defaults when the daemon is down.
- Exact wire format for phone and web clients: view JSON, command JSON and refusals are in the code's tests
  (`chat-presets.test.ts`, `remote-bridge.test.ts`).

## Faster queue, and the send default

A message to a working chat shows as a queued card sooner: `LiveTurnPublisher.nudge()` publishes the live doc at
once (coalesced: nudges during a publish cost exactly one more run) when the relay accepts a reply, when the
queue shows the message, and after a queue action, instead of waiting for the 1 s tick. The relay confirmation
polls every 150 ms for the first 2 s, then 500 ms, same 6 s cap, same ambiguity rules. `readCommands` handles
`reply` commands before other kinds in a batch (the kind is read from the box for ordering only; every command
still goes through `handleCommand`'s checks) and writes the result before deleting the command (best effort; the
nonce is already remembered, so a leftover cannot run twice). `POST /control/session/<id>/queue/<mid>/promote|cancel`
no longer pre-reads the queue: the relay re-reads it and refuses an id that is not pending (404 "already went").

**Send default** (`src/fleet/send-default.ts`, `<support dir>/send-default.json`, 0600): what a reply to a working
chat does when it names no mode, `"queue"` (default) or `"steer"`. A reply that names its mode keeps it; an idle
chat just sends. Applies to the phone's replies and the Mac app's `/control` replies (not Telegram).

- `GET /control/send-default` -> `{ "mode": "queue" | "steer" }`; `POST` with exactly `{ "mode": ... }` answers the
  same, or 400 `{ error }`. Token-gated, no CORS header. `/state` carries `sendDefault`.
- Phone view: optional `sendDefault: "queue" | "steer"` (absent on an older Mac).
- Signed command `{ v: 1, kind: "sendDefault", mode, nonce, expiresAt }`, exactly these keys; ends in the same
  `applySendDefault` as the route.

## Notification settings (2026-10-25)

What Telegram and Cliq may push, edited from the Mac app and the phone. It only filters pushes, per channel:
a held-back card stays on the radar and in every app, and `/snooze` and `/radar` are untouched. Absent
settings are today's behaviour exactly. Code: `src/fleet/notify-settings.ts` (`shouldPushTo` keeps
`shouldPush` as the base rule and only narrows it, except `finished: "all"`), saved in
`<support dir>/notify-settings.json` (0600, atomic write; unknown keys ignored on read). Only kinds that
push today have a switch: errors and context pressure never push, so they have none.

**Settings, per channel** (`telegram`, `cliq`), also the shape of the phone view's `notify`:

```json
{
  "telegram": {
    "muted": false,
    "approval": true,
    "question": true,
    "stalled": true,
    "quota": true,
    "finished": "conductor",
    "quiet": null
  },
  "cliq": {
    "muted": false,
    "approval": true,
    "question": true,
    "stalled": true,
    "quota": true,
    "finished": "conductor",
    "quiet": { "from": "22:00", "to": "07:00" }
  },
  "channels": { "telegram": true, "cliq": false }
}
```

- `muted`: nothing is pushed to the channel, quota alerts included.
- `approval`: a session blocked on an approval or a question. `question`: a finish that ends on a question.
  `stalled`: a session that seems stuck. `quota`: the account-wide Codex quota alert.
- `finished`: `"conductor"` (today: Conductor chats only), `"all"` (every agent's finish), `"off"`.
- `quiet`: `{ "from": "HH:MM", "to": "HH:MM" }` 24 h, the Mac's local time, `from` inclusive, `to` exclusive,
  may cross midnight; `from` and `to` must differ; `null` is none. Quiet hours hold back finishes, a finish
  that ends on a question, and stalls. A blocked approval or question still pushes, and so does the quota
  alert. A held-back push is dropped, not delayed.
- `channels` (view only) says which channels this Mac has set up (`telegram`: a bot token; `cliq`: a webhook), so
  a surface can grey out the other.

**One change, strictly.** `change` holds exactly one key with its exact type: `muted`, `approval`, `question`,
`stalled`, `quota` (booleans), `finished` (`"conductor" | "all" | "off"`), `quiet` (`{ from, to }` or `null`).
Anything else (an unknown key, two keys, a string for a boolean, a bad clock time, an extra field) is refused.

**Mac app route** (token-gated, no CORS header): `GET /control/notify` answers the object above;
`POST /control/notify` with `{ "channel": "telegram" | "cliq", "change": { "<key>": value } }` (exactly those two
keys) answers the object above after the change, or `400 { "error": "Not a notification setting this Mac understands." }`.

**The phone command** (sealed like every command: `{ box, sig, device }`; same nonce, expiry and signature
checks). Exactly these keys, no others:

```json
{ "v": 1, "kind": "notify", "channel": "cliq", "change": { "finished": "off" }, "nonce": "…", "expiresAt": 0 }
```

Result: `{ "id", "status": "sent" }`, or `{ "id", "status": "refused", "reason" }`. The phone view carries
`notify` only on a Mac that offers it (older Macs omit it, so a phone hides the page); the view changes and the
phone re-reads it. Both the route and the command end in the same `applyNotify`.

## Claude account (2026-11-08)

Switch which Claude account new chats use, from the Mac app's Usage section or the phone's Usage page. It drives the
user's own `claude-swap` CLI (`~/.local/bin/claude-swap`, else on `PATH`), which keeps each account's metadata in
`~/.claude/accounts/<name>.json` and its tokens in the Keychain item `Claude Code-credentials:<name>`; the active account
is the saved file whose `emailAddress` matches `oauthAccount.emailAddress` in `~/.claude.json`. The daemon
(`src/fleet/claude-accounts.ts`) reads those two JSON files only (never the Keychain, never a token) and switches by
running the script with `execFile`, absolute path, exactly `["use", name]`, 20 s timeout, no shell, one at a time. `name`
must match `^[A-Za-z0-9._-]{1,40}$` and be in the saved list. New `claude` processes (Conductor's too) use the new account;
running chats keep the old one until they restart. A failure is one of a few fixed sentences, never the script's output.

**The view's `claudeAccounts`** (only when `available`: the script exists and at least two accounts are saved, and never
on the shared server): `{ "available": true, "current": "work" | null, "accounts": [{ "name", "email", "plan" }] }`, where
`plan` is Claude's `organizationType` (`claude_pro`, `claude_team`, `claude_max`). Older Macs omit it, so a phone hides the
section.

**Mac app route** (token-gated, no CORS header): `GET /control/claude-accounts` answers the object above (with
`available: false` when it cannot switch); `POST /control/claude-accounts` with `{ "use": "<name>" }` (exactly that key)
answers `{ "current", "state" }`, or `400 { "error": "<fixed sentence>" }`.

**The phone command** (sealed like every command; same nonce, expiry and signature checks). Exactly these keys:

```json
{ "v": 1, "kind": "claudeAccount", "use": "home", "nonce": "…", "expiresAt": 0 }
```

Result: `{ "id", "status": "sent", "current": "home" }`, or `{ "id", "status": "refused", "reason" }` (unknown name, extra
key, not available, shared server). The phone asks Face ID after its own confirmation ("Switch Claude to <name>? New chats
use it; chats already running keep the current account until they restart."). Both the route and the command end in the
same `applyClaudeAccount`, which afterwards asks the Claude usage refresher to refresh (it reads Claude Code's own sign-in,
so it now reports the new account; its one-a-minute guard may answer from the cache).

## Web accounts (2026-11-10)

Only when the channel lives on Catalyst (`location.provider === "catalyst"`); on Firebase none of this exists. The
account (Catalyst Hosted login) identifies the person; device keys authorise; the Mac approves every new device, with
one owner-chosen exception (below); the relay never holds anything that opens the channel (the channel key and relay
key reach a browser only sealed to a key it made, after the Mac adds it).

**The exception: your own devices.** A device whose request carries the `userId` of the account this Mac is linked to is
added without the six-digit code, through the exact approve path (`via: "account"`, `addedAutomatically: true` on its
`devices` entry in `/control/remote/status`): Catalyst vouches for the account. Every such add is told at once: an
activity line (device, email, time), a Telegram and Cliq card ("New device added: <name> (signed in as <email>). Not
you? Revoke it in Squeak > Settings > Channels." Always sent, never muted: it is a security event) and the Mac app's
notification, and it is revocable like any device. "Ask before adding my own devices" (`askOwnDevices`, saved with the
account in `remote.json`, cleared on unlink; `GET /control/remote/account` carries it, `POST
/control/remote/account/settings` `{ askOwnDevices: boolean }` sets it, strict) restores the code. Requests from any
other account are still dropped, and pond guests always need the Mac's approval.

- **Link.** A paired phone sends the signed command `accountLink` with exactly `{ ticket }` (a string, at most 512
  characters), after every `handleCommand` check. The Mac calls the relay's `POST /account/link` `{ ticket, macId,
name }` (relay key; `macId` = the channel id; `name` = the Mac's name), gets `{ userId, email }`, and saves
  `account: { userId, email, linkedAt }` in `remote.json` (0600). The phone view carries `account: { email }` only when
  linked. A bad ticket (relay 400) is a refusal. `accountUnlink` (`{}`), `POST /control/remote/account/unlink`
  and `reset()` call `POST /account/unlink` `{ macId }`; the config is cleared only when the relay let go.
  `GET /control/remote/account` answers `{ linked, email?, signInUrl? }` (token-gated, no CORS; `signInUrl` =
  `<Catalyst app origin>/app/index.html`, present only on a Catalyst location). The Mac app's own sign-in (web/app sign-in
  callback, docs/web-app.md) ends in `POST /control/remote/account/link` `{ ticket }` (<= 512 characters): it runs the same
  `linkTicket` as the `accountLink` command and answers `{ ok: true, email }` or `{ ok: false, reason }`; with no channel yet
  it makes one (Catalyst only), and on Firebase or no cloud answers `Squeak isn't set up for the cloud yet.`
- **Device requests.** The relay writes `channels/<id>/devreqs/<reqId>` = `{ v: 1, reqId, userId, email, name,
publicKey, boxKey, at }` and announces it. On each pass (and on a `devreqs` notice) the Mac lists them and deletes
  any whose `userId` is not the linked account's, older than 10 minutes, or malformed (`publicKey` and `boxKey` must
  be on-curve uncompressed P-256 points, x963, base64). The rest are the linked account's own devices and are added without a code
  unless `askOwnDevices`; then they join the same pending list as a QR pairing request
  (with `via: "account"`, `email`), with the same six-digit code (`pairingCode(publicKey)`: first four bytes of
  SHA-256 of the key, mod 10^6), whether or not the pairing window is open.
- **Answer.** Approve adds the device (`via: "account"`), seals the QR payload (`{ v, c, k, n, cu, ck }`, no `p`) to
  `boxKey` with the ponds' ECDH seal (`sealToMember`: ephemeral key, HKDF `squeak-pond-key-v1`, AES-GCM), writes
  `devresults/<reqId>` = `{ box }` and deletes the request. Reject writes `{ denied: true }` and deletes it.
  Requests and answers are the relay's plain documents (`listDocs`/`putDoc`/`deleteDoc` in `src/cloud/account.ts`),
  not the store's sealed `box` documents.

### Profile photo (web accounts)

The owner's photo lives on the relay (`PUT|GET|DELETE /account/avatar`, docs/cloud-layer.md, "Accounts"); the account token
now also owns that photo (it still mints no token or ticket). While linked the daemon fetches it with the relay key
(`GET /account/avatar?userId=`) on link, at start, every 10 minutes and on demand, and keeps it as `account-avatar.jpg` in the
support dir (0600, rewritten only when the bytes change, deleted on a 404, on unlink and on reset; a relay that cannot be
reached leaves the cached copy). `GET /control/remote/account` gains optional `avatarAt` (the cached file's change time, ms);
token-gated `GET /control/remote/account/avatar[?refresh=1]` answers the JPEG (`no-store`, `nosniff`, no CORS) or 404.

## Telegram avatar (2026-10-26)

Set the Telegram bot's profile photo to Squeak's logo from the Mac app or the phone. Telegram's `setMyProfilePhoto`
(Bot API 9.4, 9 Feb 2026) takes `photo`, an `InputProfilePhotoStatic` (`{"type":"static","photo":"attach://<part>"}`),
uploaded as multipart/form-data; the file must be a **JPG** and cannot be a file id or URL. The daemon sends
`brand/logo/png/squeak-bot-avatar-640.jpg` (640 x 640, the full duck at 65% on Ink, DESIGN.md §6.1 avatar), found two
folders above `dist/telegram`, which is the same place in the checkout and in the app-bundled daemon.

- **Phone view:** optional `telegramAvatar: true`, present only on a daemon that offers it. Absent: hide the button.
- **Phone command:** `{ v: 1, kind: "telegramAvatar", nonce, expiresAt }`, exactly these keys, signed and sealed like every
  command. The result is `{ id, status: "sent" }` on success, or `{ id, status: "refused", reason }` where `reason` is one of:
  `Telegram is not set up`, `Try again in a minute` (one try per 30 s, shared with the Mac app's route),
  `Squeak's logo file is missing from this install`, `Telegram refused the photo`, `Telegram could not be reached`,
  `This Mac can't set the Telegram photo from a phone.`, `Not a request this Mac understands.`
- **Mac route:** token-gated `POST /control/telegram/avatar` on the ingress, no CORS header; body empty, `{}` or exactly
  `{"which":"logo"}`. `200 {"message":"Done"}`, `400 {"error": <sentence above>}`, `429` for the rate limit, `405`
  for other methods, `503` from a daemon without it (an older one: hide the button).
- Both end in `TelegramAvatar.apply` (`src/telegram/avatar.ts`). Never show or log the token or Telegram's own words.

## Channel setup from a phone (2026-10-30)

Telegram and Zoho Cliq setup, which was only in the Mac app's Settings › Channels, is also on the iPhone and the web.
Protocol: `.context/channels-setup-protocol.md`; writer: `src/squeak/channels-setup.ts`.

- **Two signed command kinds**, `telegram` and `cliq`: `{ v: 1, kind, change: { <exactly one key> }, nonce, expiresAt }`,
  checked like every command (device key, <= 10 min, new nonce), then `RemoteBridge.handleChannelSetup` refuses any other
  key set and the writer reads the change again strictly. Telegram: `token`, `off`, `startLink`, `stopLink`, `link`,
  `unlink`, `test`; Cliq: `webhook`, `removeWebhook`, `owner { email, id }`. The bot picture is the existing
  `telegramAvatar` command.
- **The Mac app writes `.env` itself** (`EnvFile`, then restarts the service), so there was no daemon function to share.
  `ChannelsSetup` is the daemon's own writer for the same keys (`SQUEAK_BOT_TOKEN`, `SQUEAK_ALLOWED_CHAT_IDS`,
  `SQUEAK_CLIQ_WEBHOOK_URL`, `SQUEAK_CLIQ_OWNER_EMAIL`, `SQUEAK_CLIQ_OWNER_ID`): other lines kept, file 0600. A save
  restarts the daemon 4 s after the answer is written (launchd KeepAlive brings it back), because `.env` is read at start.
- **Secrets**: a bot token or webhook URL exists only inside the sealed, signed command, then in `.env`. It is never
  logged (the audit line names the key, not the value), never put in a result (a refusal is a fixed sentence), never in
  `/state`, and never in the phone view, which carries only `channelsSetup`: `tokenSet`/`webhookSet` booleans (no last
  four), the bot's username, linked chats with names, the owner email and ID, the last test, link candidates, and
  whether the service is restarting. Tests pin this (`channels-setup.test.ts`, `remote-bridge.test.ts`,
  `phone-interop.test.ts`). Absent on an older Mac: phones hide the page.
- **Owner check**: everything that sends data to a third party or grants an account access (set a token or webhook, turn
  off or remove, link or unlink a chat, change the Cliq owner) needs Face ID or the passcode on the iPhone, always,
  whatever "Ask for Face ID to send" says (as the PIN reset), and an explicit confirm on the web that says the browser
  can't check it's you. The Mac can check only the device key's signature, as for the voice PIN reset: Face ID is the
  phone's job. Test message, start/stop linking and reads need none. Turn off and Remove webhook ask a confirm first.
- **Linking** mirrors the Mac's sheet: `startLink` opens a 10-minute window (the phone shows "send any message to
  @bot"), the view lists chats that messaged the bot (`linking.candidates`, only while the window is open), `link` takes
  one of them (the Mac refuses an id nobody saw, so a phone cannot allow an arbitrary chat), Done sends `stopLink`. With
  no allow list the bot was open to anyone and never listed them; strangers are now remembered then too, so the first
  chat can be linked.
- **Differences from the Mac app, on purpose**: `unlink` refuses the last chat (the Mac's save would leave the bot open to
  anyone; a phone must turn Telegram off instead); the Cliq webhook must be one of Cliq's own data-centre hosts (the
  Mac app's check is looser).

## Phone calls (2026-10-28)

Squeak can ring you when an agent waits on you and take a call in (docs/voice.md). The phone sets who it rings and
starts a test call; neither reaches an agent, so there is no Face ID.

The phone view carries `voice` when the Mac offers it (absent on an older Mac: the page is hidden):

```json
{
  "mode": "gateway",
  "callee": "35210",
  "defaultCallee": null,
  "lastTest": { "at": 0, "status": "answered", "letter": "A" }
}
```

`mode` is `gateway` (the Home Assistant add-on places the call), `direct` (the Mac does) or `off`; `callee` is the
extension set from an app (null until one is); `lastTest` appears once a test was asked for, with `status`
`ringing`, `answered` (and the key pressed), `unanswered` or `failed` (and why). An answered test may carry an optional
`quality: { verdict: "good"|"fair"|"poor", jitterMs?, lossPct?, rttMs? }` (add-on 0.11.2 and newer, from baresip's
`callstat` at the call's end; absent when baresip gave no usable numbers). Fair is jitter over 30 ms, loss over 1% or a
round trip over 300 ms; poor is over 60 ms, 5% or 400 ms (what G.711 without loss concealment and a typical jitter
buffer tolerate; ITU-T G.114 for the round trip). The apps add "Line quality: poor." to the test line when it is there;
older ones ignore the key.

The view's `voice` also carries `hold`: `{ holdAtMac, graceSeconds, awayAfterSeconds, sawItAwayAfterSeconds, maxHoldMinutes }`
(all present; absent on an older Mac, so the phone hides the group). The signed `voice` command takes `{ hold: { ...some of
those keys } }`: exactly the one outer key, whole integers in range (15 to 600, 30 to 900, 30 to 1800, 1 to 120), merged onto the
saved rules. Rules in docs/voice.md, "When to call".

The command is one signed envelope, exactly these keys:

```json
{ "v": 1, "kind": "voice", "change": { "callee": "35210" }, "nonce": "…", "expiresAt": 0 }
```

`change` is exactly one of `{ "callee": "<2 to 6 digits>" }`, `{ "callee": null }` (clears it, an explicit null) or
`{ "test": true }`. The extension is read again strictly in `src/voice/settings.ts` and ends in the same function as
the Mac app's `POST /control/voice`; an outside number is refused here and again by the gateway. A test starts a call
with a made-up question and answers `sent` at once (`refused` with a reason if one is already ringing or phone calls
are not set up); how it went arrives in `voice.lastTest`.

A third `change` shape changes the pin the gateway asks for (never logged, never stored on the Mac):
`{ "pin": { "current": "4821", "next": "135790" } }`, both 4 to 12 digits, exactly these keys. The Mac relays it to the
Home Assistant add-on, which checks the current pin (five wrong guesses lock changes for ten minutes) and answers; the
command's answer is that outcome. A Mac whose calls are placed directly refuses: its pin is in its own config.

### New chats from calls: the model pick (2026-11-01)

The view's `voice` also carries `newChatModel` (`{ id, level? }` or `null`: the workspace's usual model) and `chatModels`
(`[{ id, label, agent, levels, defaultLevel? }]`, Conductor's model presets; both absent on an older Mac, so a phone hides
the picker). The signed `voice` command takes `{ "newChatModel": { "id": "...", "level"?: "..." } | null }`, exactly that
one key and those fields; it ends in `VoiceSettingsStore.apply` like the Mac app's `POST /control/voice`, which refuses an
`id` not in `listChatModels` and a `level` not in that model's `levels` with a fixed sentence. The phone call flow that uses
it (key 0 in a workspace's chat menu, `newchat` and `start` messages) is in docs/voice.md, "A new chat from a call".

### Voice parity with the Mac app (2026-10-30)

The phone can do what the Mac app's Voice settings do, including hearing a sample (below). Wire details for the apps:
`.context/voice-parity-protocol.md`.

- The view's `voice` already carries `natural` (`installed`, `enabled`, `voice`; now also `voices: [{ id, label }]`, the
  picker list), `favorites` (`[{ n, workspace, label }]`, the Quick workspaces, `n` = keypad digit 1 to 9) and
  `workspaces` (`[{ key, label }]`, what a favourite may name). `voice.calls` (the newest 20 calls with their steps) is
  large, so it is written only for a phone whose presence `caps` name `calls`.
- Two more `change` shapes, each exactly one key, ending in the Mac route's own stores (`NaturalSettingsStore.apply`,
  `VoiceFavoritesStore.apply`): `{ "natural": { "enabled"?: bool, "voice"?: "af_heart" } }` and
  `{ "favorites": [{ "n": 1, "workspace": "<key>" }] }` (replaces the list). A phone may only name a workspace this Mac
  offers or already saved; the realistic voice must be installed. Logic and tests: `src/voice/phone-voice.ts`.
- **Voice engines** (`.context/voice-engines-spec.md`): `natural` may also carry `"engine"` (`kokoro` | `qwen3` | `ming` |
  `chatterbox`) and `"emotion"` (`off` | `subtle` | `strong`), both optional, through the same `apply` as the Mac. A phone
  can only pick an installed engine; installs and removals happen on the Mac only, never by a phone command. The view's
  `natural` gains `engine`, `emotion` and `engines[]` (`id`, `label`, `summary`, `size`, `installed`, `emotion`, `voices`,
  `voice`, `licence`), all optional, so an older phone ignores them.
- **Voice sample** (Play sample, iPhone and web): the signed command `{ v: 1, kind: "voiceSample", voice, nonce,
expiresAt }`, exactly those keys, no Face ID (it touches no chat and carries no words). `voice` must match
  `^[a-z]{2}_[a-z]+$` and be in the voices of the engine it is made with (`natural.voices`, or the chosen engine's list).
  An optional `engine` key is sent only to a Mac that lists `natural.engines`. The realistic voice must be installed. The Mac makes the sample
  through the function behind `POST /control/voice/preview` (an 8 kHz mono 16-bit WAV, ~5 s, ~80-100 KB) and leaves it
  as sealed `media` chunks through the same writer and ledger as a film (`uploadMedia`: 384 KB chunks, `remote-media.json`,
  deleted after 30 min). The answer is `{ status: "sent", media: { id, chunks, bytes, sha256, mime: "audio/wav" } }`,
  read by the same `Channel.media` / `fetchMediaBytes` a film uses (hash checked), or `{ status: "refused", reason }`
  with a fixed sentence. One at a time, and one per 5 s per device. Realtime Database only: the direct same-Wi-Fi
  path and the shared server carry no media, so the Mac sets `voice.natural.sample: true` in the phone view only when
  it can make one and has a streaming store and its own server; a phone shows Play sample only when it is true (an
  older Mac omits it, so the button is hidden). The phone plays it with `AVAudioPlayer` (`.playback`, like films, so
  the silent switch does not mute it); the web plays a Blob in an `Audio` element, started from the tap with a silent
  clip so the later `play()` is allowed. Tests: `remote-bridge.test.ts` ("voice sample"), `phone-interop.test.ts`,
  `VoiceSampleCommandTests`, `web/test/voice-sample.test.js`.
- Calls: `{ id, at, kind, reason?, label?, outcome, letter?, sent?, durationMs, failure?, events }`, `events` at most 40
  lines `{ at, source, kind, text }` of at most 200 characters. The Mac route's data, clipped; no PIN is ever written
  to the history or the trace.

## Squeak hosts the cloud; signing in sets it up (2026-11-11)

Nobody hosts their own cloud any more. Squeak runs one relay for everyone (`cloud/catalyst-relay/`, the Catalyst app
whose address is `HOSTED_RELAY_URL` in `src/cloud/hosted.ts`, `SQUEAK_CLOUD_URL` overrides it), and using the phone, the
web or Cliq needs a Squeak account: **signing in on the Mac is the setup.** There is no Firebase project to create,
no Catalyst deploy and no shared server to choose.

- The Mac app signs in on the web and hands the daemon an account token (`POST /control/remote/account/link`
  `{ token }`). The daemon calls the relay's `POST /account/macs/provision` with it and keeps the Mac's own key in
  `cloud.json` (0600, never logged). The Mac's id on the relay is its existing channel id when that is 22+ url-safe
  characters, else a new random one the phone channel then takes. The key is confined to that Mac's own channel and the
  ponds it claims, under a daily request and byte limit per account.
- `GET /control/cloud` carries `hosted: { state: "needs-sign-in" | "connecting" | "ready" | "error", email?, error?,
legacy?, moving? }` (also `/state` `.cloud.hosted`); `POST /control/cloud/hosted/connect` `{}` restarts provisioning
  (202, or 409 `not-signed-in`). A 401 from the relay (the Mac was removed from the account) clears the key and goes
  back to needing a sign-in. A fresh install with nothing configured waits in `needs-sign-in`; it never falls back to
  a shared server.
- **Existing installs** (their own Firebase, the old shared server, or their own Catalyst relay) keep working unchanged,
  and `hosted.legacy` (`firebase`, `shared`, `catalyst-own`) says which. Once the owner signs in, the daemon provisions,
  then runs the signed `move` so paired phones follow (the old store is read for the usual window), and `legacy`
  becomes `null`. The Firebase and old-Catalyst read paths stay for phones that have not updated.
- Self-hosting is removed: `/control/cloud/catalyst/*`, `/control/cloud/firebase/rename` and `/control/cloud/select`
  answer 410 `{ error: "self-hosting-removed" }`. The shared server's code (`SQUEAK_REMOTE_SHARED`,
  `shared-limits.ts`, `firebase/shared/`) is removed: a Mac still configured for it logs one line at start, keeps its
  config, reports `legacy: "shared"` and runs unthrottled like any Firebase Mac until sign-in moves it to hosted.

The older Firebase and shared-server instructions are in git history (2026-10-29).

## Archiving a chat from the phone (2026-11-13)

A swipe on a chat row (trailing, "Archive", muted) and an "Archive" item beside Rename hide the chat in Squeak. It is the
same thing the Mac's right-click menu and Chat menu (⇧⌘A) do, through one daemon path (`fleet/thread-archive.ts`):

- **Signed command kind `archive`**: `{ v: 1, kind: "archive", sessionId, archived: boolean, nonce, expiresAt }`, the same
  envelope as `rename` and `close`. Strict: any other key, a non-boolean `archived`, or a malformed id is refused. Signature,
  expiry (10 min) and nonce are checked before the handler runs, as for every command. `sessionId` is the handle the
  chat's view gives (`handleOf`), never a fleet key the phone made up: the Mac resolves it to a chat in its own snapshot
  that the phone is shown (an archive), or to one it holds as archived (an unarchive), and passes the fleet key on.
- **What it does by kind**: a Squeak chat is archived by the session host (`POST /native/sessions/<id>/archive`, which
  refuses a working or waiting chat); every other chat (Conductor, terminal, Codex, desktop, headless) is hidden in
  Squeak only, in `<support dir>/archived-sessions.json` (`{ v: 1, archived: { <fleet key>: { archivedAt } } }`, newest 5,000
  kept). Conductor's database and an agent's files are never touched. A working or waiting chat is refused with
  "Stop the chat before archiving it."
- **Archived means retired**: the daemon marks it `retired` with `archivedAt`, so it leaves `active`, `others`, attention,
  pushes (Telegram, Cliq) and the phone's Recent list. `/state` lists it under `archived` (newest archived first, at most
  500, each session carrying `archived: true` and `archivedAt`), which the Mac's Archived page reads. Token-gated
  `POST /control/session/<fleet key>/archive` with exactly `{ archived: boolean }` is the Mac's way in.
- **Optional, so old phones and Macs keep working**: a Mac lists `archiveChat` among a chat's `actions` only when it can
  (an archiver is wired and the chat is not working or waiting); a phone offers the swipe only then, so an older Mac never
  shows it and an older phone ignores the action. The existing `archive` action is the workspace archive and is unchanged.
- **Per-person hides stay on the Mac app**: a thread someone else started in a shared pond is hidden from this person's
  view only (UserDefaults `sharedThreadHides`), never from the starter or the pond; the phone has no such list.
