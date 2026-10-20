# Squeak — open items

Left open at the end of the session of 2026-10-19 (chat `ushuaia-a7`). Newest
context: `.context/rtdb-todo.md` and `.context/re/answering-spike.md`.

## Needs you (the owner)

- [ ] **Paste the Cliq handlers.** `squeak cliq-relay` regenerated them for the
      Realtime Database: `~/Library/Application Support/squeak/cliq-handlers.txt`
      (private, holds the signing secret). Until then Cliq taps still work but
      arrive about once a minute (read from Firestore as `legacy`).
- [ ] **Install the next iPhone build** (1.7.1+, released by `ushuaia-c6`): it
      carries the tappable answer card (2d09729).
- [ ] **Answer "Mac frequent sleep"** (`753312f3…`): still waiting on its
      AskUserQuestion. Answer it in Conductor, or from the phone once 1.7.1 is on it.
- [ ] **Close the throwaway chat "SQUEAK SPIKE TEST"** (`bfd0f757…`, workspace
      ushuaia) in Conductor. No safe way was found to delete it from Squeak.
- [ ] **Try hold-to-steer once on the phone** (hold Send on a working chat): the
      menu has never been opened by a test (simulators can't long-press).

## Not built yet

- [ ] **Answer a question by clicking Conductor's pop-up (route 2).** Squeak
      Hands' `press` mode walks Conductor's whole AX tree with no limit and hung >10 min; the question card only exists while its chat is on screen. Needs a
      bounded search plus the `send` mode's tab navigation (prove the chat via
      AXURL), and a signed Hands rebuild (`ship.sh` does not rebuild Hands).
- [ ] **Plan approvals on the phone.** The answer card handles AskUserQuestion
      only; the `answer` command already has `plan: {approve, note?}` and the Mac
      side supports it (8e0fba3), but the phone has no plan card (ExitPlanMode).
- [ ] **Verify an answer end to end from a real phone** once 1.7.1 is installed
      (the Mac side and the signed command are tested; a phone-made answer to a
      live chat is not).
- [ ] **Re-probe Conductor's own answer route** after each Conductor update:
      `answer-question` / `respond-to-plan` return 501 on 0.91.1 (the Mac
      remembers this per version).
- [ ] **Drop the legacy Firestore read for Cliq** (`CliqRelayInbox.legacy`) once
      the new handlers are pasted and no record has arrived in Firestore for a while.
- [ ] **iPhone UI ideas not done:** drop the Home filter control (sections already
      group), swipe actions on rows (answer A/B/C or reply without opening), show
      the last 3–4 exchanges in a chat (costs ~5–10 KB per chat opened).
- [ ] **Recent chats show 4 of 9 open Conductor chats from the last week** before
      "Show more": check why the other few are left out (retired flag, transcript
      time vs Conductor time) rather than assume they don't qualify.

## iPhone UX plan (chat ushuaia-c6, 2026-10-19), worked top to bottom

- [x] **1. "Read by Claude" receipts.** A bubble's line moves from Sent to "Read by
      Claude" when the agent actually picks the message up (the transcript's user
      entry, or it leaving Conductor's queue), not when the Mac received it.
- [x] **2. Stop while working.** A Stop control beside Send on a working chat,
      through the relay's `…/sessions/:sid/stop`, signed like every command.
- [x] **3. Keep my place.** Drafts survive leaving a chat; reopening returns to
      where you were reading; a "↓ New" pill when something arrives above the fold.
- [x] **4. The last 3–4 exchanges in a chat** (also under "iPhone UI ideas" above).
- [x] **5. What changed on a finished turn.** "3 files · +84/−12" under the reply,
      tapping through to the diff (the Mac's diff-view already pages it).
- [x] **6. Copy / share** any message or step on a long press.
- [x] **7. Swipe actions on Home rows**: A/B/C or Reply without opening the chat.
- [ ] **8. Answer from the notification** — blocked: the app is installed unsigned through SideStore, which cannot carry Apple's push entitlement (`aps-environment`). Needs a paid Developer account and a push-capable build (TestFlight/ad hoc), or keep Telegram's cards for this. Owner's call.: actionable push with A/B/C and reply
      (needs APNs from the Mac — its own project).
- [ ] **9. Live Activity / Dynamic Island** — blocked on the same push decision (without push it goes stale the moment the app is suspended). while an agent works (needs push too).
- [x] **10. Plan approvals on the phone** (also under "Not built yet").
- [x] **11. Say why a control is missing**: a queue card without actions, a
      blocked composer — one line of reason where the tap would be.
- [x] **12. Haptics and motion pass**: a light tap when an open chat's agent
      finishes; every animation checked under Reduce Motion.

## Stay awake plan (Insomnia-style, chat ushuaia keep-awake, 2026-10-19), worked top to bottom

Modelled on Insomnia (github.com/krishhgg/Insomnia, MIT). Done already: the Mac
stays awake while agents work and always while plugged in; a "Keep Mac awake"
switch in the menu bar and iPhone Settings (`keep-awake.json`, command `awake`).

- [x] **1. Timed sessions.** "Stay awake for 1h / 2h / 4h / until a time / until I
      turn it off", started from the menu bar, the Squeak window or the iPhone; a
      countdown on every surface; add time to a running session; ending it takes a
      deliberate gesture. Replaces the on/off switch (an old phone's `awake` on/off
      still works).
- [x] **2. Lid closed.** One admin prompt installs `/etc/sudoers.d/squeak` for exactly
      `pmset -a disablesleep 0|1` and `pmset -b lowpowermode 0|1`, explained in plain
      words first (any process running as you can then use those four commands). A
      lid-closed session needs an end time. Uninstall removes the rule.
- [x] **3. Safety rules.** Battery ≤40% → Low Power Mode; ≤10% → end the session;
      thermal "serious" → Low Power Mode; "critical" → end. Thresholds in settings.
      Every system change is journalled before it is made and undone at session end,
      at daemon start (launchd restarts it), and by a small launchd backstop if Squeak
      is gone for good — a Mac left with `disablesleep 1` never sleeps, even in a bag.
- [x] **4. Lid-closed actions.** When the lid shuts during a session: display off,
      mute, Low Power Mode, optionally SIGSTOP chat apps (Slack, WhatsApp, Discord, Telegram);
      all reversed when it opens. Each one a setting.
- [x] **5. Status on the phone.** Lid state, battery %, power draw and the countdown on
      the iPhone; a push when a safety rule ends a session (Telegram and Cliq: there
      is no APNs yet).
- [x] Hotspot failover (asked for 2026-10-20): `src/fleet/hotspot.ts`, set up and switched from the
      iPhone's Settings; the password only in the Mac's Keychain. Never tried on a real
      network switch: that would cut this Mac off mid-session.
- [ ] Not planned unless asked: tmux
      "continue" nudge (overlaps terminal replies), browser relaunch.

## From chat ushuaia-f7 (Mac app, service, releases)

Not built yet:

- [ ] **Answering Codex questions** — the answer service's `readAsk` only reads
      Claude transcripts.
- [ ] **New chat in a new workspace (phase 2)** — relay `POST /workspaces` body is
      unknown; reverse-engineer it from Conductor's bundle first (`.context/re/`).
- [ ] **Swift relay cutover** — `macos/Sources/SqueakMacCore/Relay/` is ported and
      tested but not wired; the native app still needs the Node service to send.
      Plan in `macos/README.md`.
- [ ] **Relay setup inside the Mac app** — still the terminal CLI
      (`scripts/conductor-relay.ts`); needs a fresh decision.
- [ ] **Turn on the iPhone channel from Settings** (`SQUEAK_REMOTE_PROJECT`) — the
      iPhone tab only explains it.
- [ ] **Remember linked Telegram chat names** across restarts (memory only now).
- [ ] **Retire the Electron app** (`desktop/`): `install-squeak-agents.sh` would
      recreate `com.squeak.duck` for the deleted `~/Applications/Squeak.app`.
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

## Notes for whoever picks this up

- Several chats share this worktree. Commit only your own hunks through a private
  index (`GIT_INDEX_FILE`), never a bare `git commit`; run SqueakCore tests on the
  Mac host (`swift test`) and the simulator before handing iOS work over.
- Rollback for the Realtime Database switch: remove `SQUEAK_REMOTE_DATABASE_URL`
  from `~/Library/Application Support/squeak/.env` (backup `.env.bak-before-rtdb`)
  and restart the daemon.
