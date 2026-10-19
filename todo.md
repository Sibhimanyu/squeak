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

## Notes for whoever picks this up

- Several chats share this worktree. Commit only your own hunks through a private
  index (`GIT_INDEX_FILE`), never a bare `git commit`; run SqueakCore tests on the
  Mac host (`swift test`) and the simulator before handing iOS work over.
- Rollback for the Realtime Database switch: remove `SQUEAK_REMOTE_DATABASE_URL`
  from `~/Library/Application Support/squeak/.env` (backup `.env.bak-before-rtdb`)
  and restart the daemon.
