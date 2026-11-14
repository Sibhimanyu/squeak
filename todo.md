# Squeak — open items

Open items, pruned 2026-11-14: finished and moot entries (Electron, Conductor relay cutover, plan cards,
Cliq handler paste, shipped iPhone UX/keep-awake plans) were removed. Anything below is unverified against today's code.

## Needs you (the owner)

- [ ] **Try hold-to-steer once on the phone** (hold Send on a working chat): the
      menu has never been opened by a test (simulators can't long-press).

## Not built yet

- [ ] **Re-probe Conductor's own answer route** after each Conductor update:
      `answer-question` / `respond-to-plan` return 501 on 0.91.1 (the Mac
      remembers this per version).
- [ ] **iPhone UI ideas not done:** drop the Home filter control (sections already
      group), swipe actions on rows (answer A/B/C or reply without opening), show
      the last 3–4 exchanges in a chat (costs ~5–10 KB per chat opened).
- [ ] **Recent chats show 4 of 9 open Conductor chats from the last week** before
      "Show more": check why the other few are left out (retired flag, transcript
      time vs Conductor time) rather than assume they don't qualify.
- [ ] **"Use my Google photo" button** (web Account page), for Google sign-ins. Catalyst never
      hands us the Google picture, so they get initials until they upload. Same shape as the
      Zoho button (2026-11-11, relay `/account/zoho-photo/*`): one-time Google OAuth with the
      owner's "Squeak" Google Cloud project (`openid profile`), read `picture` from userinfo,
      park the bytes, browser runs them through `avatar.js` and PUTs `/account/avatar`.

## iPhone UX plan (chat ushuaia-c6, 2026-10-19), worked top to bottom

- [ ] **8. Answer from the notification** — blocked: the app is installed unsigned through SideStore, which cannot carry Apple's push entitlement (`aps-environment`). Needs a paid Developer account and a push-capable build (TestFlight/ad hoc), or keep Telegram's cards for this. Owner's call.: actionable push with A/B/C and reply
      (needs APNs from the Mac — its own project).
- [ ] **9. Live Activity / Dynamic Island** — blocked on the same push decision (without push it goes stale the moment the app is suspended). while an agent works (needs push too).

## Stay awake plan (Insomnia-style, chat ushuaia keep-awake, 2026-10-19), worked top to bottom

Modelled on Insomnia (github.com/krishhgg/Insomnia, MIT). Done already: the Mac
stays awake while agents work and always while plugged in; a "Keep Mac awake"
switch in the menu bar and iPhone Settings (`keep-awake.json`, command `awake`).

- [ ] Not planned unless asked: tmux
      "continue" nudge (overlaps terminal replies), browser relaunch.

## From chat ushuaia-f7 (Mac app, service, releases)

Not built yet:

- [ ] **Answering Codex questions** — the answer service's `readAsk` only reads
      Claude transcripts.
- [ ] **New chat in a new workspace (phase 2)** — relay `POST /workspaces` body is
      unknown; reverse-engineer it from Conductor's bundle first (`.context/re/`).
- [ ] **Turn on the iPhone channel from Settings** (`SQUEAK_REMOTE_PROJECT`) — the
      iPhone tab only explains it.
- [ ] **Remember linked Telegram chat names** across restarts (memory only now).
- [ ] **New duck artwork** (DESIGN.md §12): mood sprites and the iPhone tab-bar duck
      are still the old round-eyed art; §8.7 empty/offline states want moods.
- [ ] `macos/README.md` is behind the last releases (new chats, answering,
      channels, keep-awake).

Never tried by hand (do once):

- [ ] Start a real new chat (Mac ⌘N and iPhone) — the first real relay create.
- [ ] Answer a real question / approve a real plan from the Mac card (2.1.0).
- [ ] Claude usage **Refresh** (makes a real Claude call).
- [ ] A real **Queue** vs **Steer now** send from the Mac.
- [ ] The glass menu-bar panel on screen; the menu bar reading "Squeak" when the
      window opens; the window staying off another app's full-screen Space.
- [ ] Telegram / Cliq / iPhone pairing from Settings › Channels and › iPhone.
- [ ] Verbose mode on the phone.

Open design questions:

- [ ] Usage bars neutral, or the needs-you colour past 90%?
- [ ] "Today's cost": whole-session cost on its last day (now) or a per-day sum?
- [ ] Offline menu-bar duck dimmed to 45% — does that count as recolouring?
- [ ] Sidebar needs-you count: white on `#F87171` is ~2.8:1 in dark mode.
- [ ] Permission prompts (allow this tool call?) from the phone — out of scope so far.

Housekeeping:

- [ ] `output/` in this worktree — not from ushuaia-f7; check what it is.
- [ ] SNOF: remote branches named `squeak-*`, and workspaces `brasilia` /
      `no-stale-when-unread` still contain `ios/SqueakKit` — rebase on `main`.
- [ ] Heresay: the Squeak 2.0 brief disappeared from `heresay briefs`; check the
      dashboard. Updates `nudge` and `design-apple` were offered, not applied.
