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
Firebase (or anything) is a dumb, untrusted pipe.

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
- `commands` — from the phone: `{ sessionId, answersTurn, text, mode?, nonce,
expiresAt }`, signed with the device key, encrypted to the Mac.
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
  live" (off by default). With it on, the phone's sealed presence names the
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
- **Usage refresh from the phone (2026-10-19).** A third signed command,
  `{ v: 1, kind: "usage", nonce, expiresAt }`, with no text and no target. It
  passes the same signature, freshness and nonce checks, then runs the Mac's
  own `ClaudeLimitsRefresher`, which spends one small real call at most once
  a minute whoever asks (a second press inside the minute gets the cached
  reading, `throttled: true`). The result says `refreshed`/`throttled`; the
  reading itself arrives in the snapshot, published at once. No Face ID: it
  sends nothing to an agent.
