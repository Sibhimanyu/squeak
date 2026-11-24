# Other gotchas

Telegram, the single fleet process, lint, ask-format, call voices.

- **Telegram needs `parse_mode`.** Without it markdown arrives as literal `##`
  and `**`. Everything goes out as HTML via `markdownToTelegramHtml`, with a
  plain-text retry if Telegram rejects the markup.
- **Messages cap at 4096 characters.** Use `splitMarkdown`, never truncate.

- **Only one process may run the fleet.** Two would bind the same hook port
  and send every notification twice. `createFleetRuntime` belongs to the
  daemon alone.
- **Lint configs resolve `files` patterns against the directory eslint runs
  from**, so they must be repo-relative — a config whose patterns match nothing
  passes everything, which is worse than no linter.

- **Agents are told how to ask, so a closing question becomes buttons.** The text lives in
  `src/fleet/ask-format.ts` (`ASK_FORMAT_TEXT`; its examples are run through `parseChoices` in
  `ask-format.test.ts`, so change the parser and the text together). The question goes _above_ the lettered
  options (`A) ...`, `(recommended)` marks one), because that is what the parser reads. `squeak install-hooks`
  writes `<support dir>/ask-format.sh` (a static script printing a `SessionStart` `additionalContext`, no
  network, exits 0) and a `SessionStart` entry in `~/.claude/settings.json`, plus a delimited block
  (`<!-- squeak:ask-format:start/end -->`) in `$CODEX_HOME/AGENTS.md` (`~/.codex`); both back up first and
  `uninstall-hooks` removes only these. `SQUEAK_ASK_FORMAT=off` then `install-hooks` removes it.

- **Call voices were chosen by a measured bake-off; read it before changing one.** `docs/voice-tts-bakeoff.md`
  (2026-10-31, 22 variants of 11 local TTS models on the M5 Pro: Whisper WER on the 8 kHz phone copy, seconds per
  line, memory, what each emotion control does) and the rerunnable harness `scripts/tts-bakeoff/` (`CONTRACT.md` is
  the brief for adding a model; `envs/`, `out/` stay out of git). WER says the words survive the line, never that the
  emotion is right: that needs ears. Qwen3 VoiceDesign re-invents its voice every render; CustomVoice's
  Chinese-native speakers garbled "Squeak".

- **Room moments on Telegram and Cliq** (`src/fleet/room-moments.ts`, host side `src/native/room-moments.ts`, route
  `GET /native/projects/<id>/room/moments?since=<seq>`): exactly three moments leave a Pond's Room, each one short card
  (Pond, Duck or Member, one line) and sent once (`room-moments.json`). A Duck asking a person (a `needs` post, or a
  Duck's @mention of a person who has posted or is a Member; never a Duck-to-Duck mention, a hand-off or the `agents`
  level), a Task becoming `blocked`, and a Member's Task waiting for the Owner's approval, which carries Approve and Drop
  that run the host's own Task actions (`fleet:room:<a|d>:<handle>` on Telegram, `room:<approve|drop>:<handle>` on Cliq;
  Cliq buttons need the two-way relay). They ride the existing rules via `shouldPushRoomMomentTo`: a mute stops all; ask
  is the `question` switch and blocked is the `stalled` switch, both held in quiet hours; approval is the `approval`
  switch and quiet hours do not hold it. Everything else in the Room (status posts, messages, other Task states) sends
  nothing; keep it that way. A Pond's first look only sets its cursor, so history is never announced.
