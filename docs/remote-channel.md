# Step 4 — The remote channel (design, before any code)

> Status: **built** · 2026-09-25 · Roadmap steps 4–5 in `DESIGN.md` §13.
> Firebase project `squeak-5c9gvo` (Firestore in asia-south1), iOS via SideStore.
>
> This is the first step where a device that is not your Mac can make agents
> on your Mac *do things*. That is remote code execution with extra steps: an
> agent running `bypassPermissions` will run whatever a reply asks for. So the
> security model is decided here, on paper, before the first line of code.

## What it has to do

1. **See** — the phone shows what the Squeak window shows: sessions by state,
   the agent's last message, the parsed decision.
2. **Be told** — a push notification when something needs you or a Conductor
   chat finishes (the same events Telegram gets today).
3. **Answer** — tap a letter or send text to one specific chat.
4. **Work when the Mac is not reachable directly** — the phone is on cellular,
   the Mac is behind home NAT. The Mac only ever makes *outbound* connections.

Explicitly **not** in scope for step 4: starting new chats, stopping agents,
approving permission prompts, reading diffs of arbitrary files, anything that
touches a machine other than this Mac. Each is a later, separate decision.

## Threat model

| Threat | What it would mean | Mitigation (below) |
| --- | --- | --- |
| Someone else's phone sends a reply | Arbitrary instructions to a `bypassPermissions` agent on your Mac | Device pairing + per-device keys; Mac verifies every command's signature |
| The cloud provider (or a leaked admin key) forges a command | Same as above, at scale | Commands are **signed on the phone with a key the cloud never sees**; the Mac rejects anything unsigned |
| Replay of an old, legitimately signed "A" | An old decision re-sent to a new question | Each command names the chat **and the turn it answers**, carries a nonce and expiry; the Mac rejects stale or reused ones |
| Conversation text leaks from the cloud | Your code, paths, business details exposed | Store only what the phone must render, encrypted end-to-end; short retention |
| Phone lost or stolen | Holder can answer agents | Revocation from the Mac app in one click; biometric unlock before sending |
| Prompt injection *through* the channel | A message crafted to look like a reply | Only the paired human can author commands; nothing from an agent is ever turned into a command |

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
4. The action is on the allow-list: *reply to an existing Conductor chat*.
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
4. **Scope check:** step 4 lets a paired phone *reply to existing Conductor
   chats* and nothing else. Anything you want in or out?

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
  old a reading is. There is no command to refresh it: Claude's reading costs a
  real call and is taken only when the owner presses Refresh on the Mac, and
  commands stay plain replies. A change in a reading republishes the snapshot;
  a re-read of the same numbers does not.
