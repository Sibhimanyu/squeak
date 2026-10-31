# Voice: Squeak rings you through your PBX

Two ways to place the call. **Gateway (recommended):** a Home Assistant add-on on your LAN places it, and the Mac
asks for each call through Firebase, so the Mac can be on any network. **Direct:** the Mac registers with the PBX
itself, which needs a route to it (home Wi-Fi or a VPN). The gateway wins when both are set up.

## Gateway setup

1. Build and install the add-on (step 2) and start it. Open the **Squeak Voice** panel in Home Assistant's sidebar: it
   shows a code like `K7M2-QX9P`. In Squeak for Mac: Settings > Phone calls > Add gateway, type the code, approve.
   The add-on posts a sealed request on the shared signalling database (`claim-protocol.ts`, `addon-claim.ts`), the
   Mac seals its channel and key to the add-on's key, and the add-on keeps them in `/data/pairing.json`
   (design: `.context/claim-flow-contract.md`). The panel (`addon-panel.ts`, ingress port 8099, answers only the
   Supervisor at 172.30.32.2) also shows SIP registration, PIN state and the recent log, never a key.
   **Old pairing code:** still works. Make one in Squeak, paste it in the add-on's `pairing_code` option; the add-on
   logs `Pairing: confirm NNNN on your Mac` (`pair-protocol.ts`). Also old: `squeak voice-relay` makes the channel
   and key (saved to `.env`) and prints `database_url`, `channel` and `key` for the add-on's options.
2. `scripts/build-voice-addon.sh` builds `dist-addon/squeak-voice`. Copy that folder to Home Assistant's `/addons`
   share (Samba or SSH add-on), then Settings > Add-ons > Add-on store > menu > Check for updates, and install
   Squeak Voice under Local add-ons. Fill in its SIP options (see its Documentation tab) and start it.
   **Updates:** a local add-on never sees a new version until its folder is copied again. To get updates from Home
   Assistant itself, add `https://github.com/Sibhimanyu/squeak` under Add-on store > menu > Repositories
   (`repository.yaml` at the root makes the repo one); it pulls the prebuilt image for the `version` in
   `config.yaml`, which the "Squeak Voice add-on image" workflow must have built first.
3. Deploy the database rules once (`firebase deploy --only database`): they allow the `voice`, `voiceresult` and `voicepair`
   kinds in the channel.
4. The add-on reports to the Mac every 30 s (a sealed `voiceresult/gwstatus` document: version, whether the PBX accepted
   its registration and why not, the PIN state), which Settings > Phone calls shows.
5. Restart Squeak (`./scripts/ship.sh`).

**Who it rings** is set in Squeak for Mac, Settings > Phone calls (`GET/POST /control/voice`, saved in
`voice-settings.json`), and travels in each sealed request. Only an internal extension (2 to 6 digits) is accepted,
by the daemon and again by the gateway, so a stolen key cannot point the PBX at an outside number. The add-on's
optional `callee` option is only the fallback; with neither, the call fails with a note saying to set one.

How it is kept safe: the request (it holds the agent's question) and the result are sealed with AES-256-GCM and
signed with an HMAC bound to direction and id, under a key only the Mac and the add-on hold
(`relay-protocol.ts`). A request counts only if sealed with the key, naming its own id, fresh (2 min) and new; the
gateway claims it before calling. The Mac accepts a result only for the request it is waiting on and only for a
letter that call offered, then sends it through the same replier and turn check as every other surface. The PIN
and the SIP password live only in the add-on's options.

The add-on image builds baresip 4.12 from source (the version tested here) and uses `espeak-ng` for speech, so its
voice is plainer than the Mac's.

## Phone calls setup in Squeak for Mac

Settings > Voice opens on a **Phone calls setup** list: the gateway paired, the add-on up to date, the extension to
ring, a PIN (or consciously off), the realistic voice and a test call that was answered, each with its own button and a
summary line ("Phone calls are ready" / "2 steps left"). It reads only what the daemon already says
(`GET /control/voice`, the gateway view, the install status); the rules live in `PhoneCallsChecklist` (SqueakMacCore).
The realistic voice is optional (the plain voice speaks without it) and never keeps calls from being "ready".

**Realistic voice from the app.** "Set up realistic voice" runs the same installer as `squeak voice-tts-setup`
(`natural-setup.ts`: a Python 3.10+ venv with kokoro-onnx, then the ~310 MB model and voice list, resumable) inside the
daemon, never the app. Token-gated, no CORS: `POST /control/voice/natural/setup` starts it (one at a time; asking again
joins the run; 400 "already installed" when it is), `GET` answers `{ state: idle | running | ready | failed, step, text,
percent, bytes, totalBytes, code, error }`. A failure is one fixed sentence by `code`: `no-python` (says to
`brew install python`), `no-network` (a retry resumes the download), `no-space` (about 1 GB free is wanted) or `failed`;
paths and command output go only to the daemon's log. The app polls while it runs, so closing Settings does not stop it,
and the toggle and Voice picker appear when the daemon reports `installed`.

**Voice engines.** The realistic voice has four engines (`voice-engines.ts`), each in its own folder of the support
directory so removing one is deleting a folder: `kokoro` (`voice-tts/`, small, plain, no emotion), and three expressive
ones on mlx-audio that run on the Mac's GPU: `qwen3` (Qwen3-TTS CustomVoice, preset speakers, Apache-2.0), `ming` (Ming
3.0 TTS, built-in voices, MIT) and `chatterbox` (clones a reference clip, MIT). Each has `voice-tts-<id>/` with
`venv/` (Python 3.10 to 3.12 for Apple silicon, found among Homebrew's and `~/.local/bin`'s), `worker.py` and its
weights in `model/` (not the global Hugging Face cache). Setup fetches the repo's files with curl (resume, stall
detection, retries; progress in bytes), but first looks for each file in the Hugging Face cache (`$HF_HUB_CACHE`,
`$HF_HOME/hub`, `~/.cache/huggingface/hub`) or a folder named by `SQUEAK_VOICE_WEIGHTS_DIR` (`<repo name>/<file>`) and
hard-links a file of exactly the right size instead ("Using files already on this Mac"); a half download is a `.part`
file, never taken as installed. Chatterbox's reference clips are made with Kokoro at setup (Kokoro is installed first
when missing). The MLX engines run **one** worker (urgent and background share it); Kokoro keeps two.

- Settings `voice-natural.json`: `{ enabled, engine, voices: { <engine>: <voice> }, emotion: off | subtle | strong,
voice }` (`voice` is Kokoro's, still written for a rolled-back daemon; the old `{ enabled, voice }` reads as Kokoro).
  `apply` takes any subset of `enabled`, `voice` (for the engine set in the same request, else the current one),
  `engine` (refused unless installed: "Set up <label> on the Mac first.") and `emotion`; the Mac app's route and the
  phone's signed `natural` command end in the same `applyNatural`, which restarts the engine and prewarms the fixed
  phrases after a change. A phone can switch to an installed engine but never start an install.
- Mood comes from the words (`voice-mood.ts` `moodOf`: urgent, cheerful, apologetic, sympathetic, warm, neutral; one per
  line) and each worker maps `(mood, level)` to its own controls; `off` is neutral for every line. Worker requests
  carry `mood` and `level`; every worker writes 24 kHz mono PCM16. The sentence cache key holds engine, model identity,
  voice, mood and level (Kokoro's keys are unchanged).
- `GET /control/voice` `natural`: the current engine's `installed`, `enabled`, `voice`, `voices` as before, plus
  `engine`, `emotion` and `engines: [{ id, label, summary, size, installed, emotion, voices, voice, licence }]`.
- Routes (token-gated, no CORS): `POST /control/voice/natural/setup` takes an optional `{ engine }` (absent = Kokoro;
  one install at a time across engines), `GET ...setup[?engine=]` answers the status plus `engine`;
  `POST /control/voice/natural/remove` `{ engine }` deletes a folder (never the engine in use, nor Kokoro while it is
  the only one); `POST /control/voice/preview` and the phone's `voiceSample` command take an optional `engine` (default
  current) so a voice can be auditioned before switching. `squeak voice-tts-setup [--engine <id>]` is the terminal form.

## Direct setup

When an agent is waiting on you (blocked on an approval, blocked on a question, or finished on a question), Squeak can
phone you. It reads the question aloud; after your PIN, a key press answers it. Written for 3CX's free edition, but any
SIP extension works.

## How it works

- Squeak registers as an ordinary third-party SIP extension (`src/voice/baresip-line.ts`: `baresip` as a child process,
  one per call, driven over its `ctrl_tcp` module). No 3CX Call Control API, so no paid licence.
- Audio is files only: `say` + `afconvert` make an 8 kHz WAV that baresip's `aufile` plays into the call, and what you
  say is written to a WAV. Nothing plays on this Mac's speakers or listens on its microphone.
- `VoiceChannel` listens to the monitor's `onPush`, like Telegram and Cliq, so snoozes and mutes already apply. It waits
  45 s (you may have answered), checks the card is still waiting, then rings. A key goes back through the same replier
  and only to the turn that was read out; if the chat moved on during the call, nothing is sent.
- Only `blocked_approval`, `blocked_question` and `asked_question` ring. Never a finish, a stall or an error.
- One call per episode, at least 5 minutes between calls, and none in quiet hours.
- **Answering needs `SQUEAK_VOICE_PIN`.** A call goes to whoever picks up, and an answer can start an agent that may run
  with permissions off. Without a PIN a call can tell you but never takes an answer, unless you turned the PIN off on purpose (see "Changing the pin"). Two wrong PINs hang up.

1. `brew install baresip`.
2. In 3CX, add an extension for Squeak (say 900). Note its extension number, Authentication ID and password.
3. Add to Squeak's `.env`:

```
SQUEAK_VOICE_HOST=pbx.example.com        # or host:port; your 3CX FQDN or LAN address
SQUEAK_VOICE_EXTENSION=900
SQUEAK_VOICE_AUTH_ID=...                 # 3CX's Authentication ID, if it differs
SQUEAK_VOICE_PROXY=192.168.68.114:5060   # optional: your 3CX SBC (Outbound Proxy), when the PBX is behind one
SQUEAK_VOICE_PASSWORD=...                # no quotes, backslashes, semicolons or angle brackets
SQUEAK_VOICE_CALLEE=101                  # your phone's 3CX extension
SQUEAK_VOICE_PIN=4821                    # 4 to 12 digits; needed to answer by key
SQUEAK_VOICE_QUIET=22:00-07:00           # optional: no calls then
SQUEAK_VOICE_TRANSPORT=udp               # optional: udp | tcp | tls
SQUEAK_VOICE_VOICE=Samantha              # optional: a `say` voice
```

4. `squeak voice-test` rings your phone with a made-up question and prints the key you pressed. It touches no chat.
5. Restart the daemon (`./scripts/ship.sh` from a worktree).

A wrong value turns voice off with a warning in the log; it never stops the daemon.

## Verified, and not

Tested here: the dialog and keypad, policy, config validation, the channel's checks, baresip's netstring protocol, its
config loading with the `aufile` modules, dialling, answering, switching the audio source mid-call, and DTMF arriving as
`CALL_DTMF_START` events with the digit in `param` (two baresip instances on this Mac, the callee typing digits through
its `stdio` module).

Gateway: the sealed and signed relay, the Mac and gateway round trip through a fake database, claim-before-call and
replay refusal are tested; the add-on image (Dockerfile) and the bundle running on Home Assistant are not.

Not tested against a real PBX: registration with 3CX, and the 3CX app's keypad sending RFC 2833 digits baresip accepts.
`squeak voice-test` is that check.

## Changing the pin

The pin lives in a `PinKeeper` beside the line that places calls: in the add-on's storage (`voice-pin.json`, 0600) when
the Home Assistant gateway calls, in `<support dir>/voice-pin.json` (0600) when this Mac calls directly. The add-on's
`pin` option (or `SQUEAK_VOICE_PIN` on the Mac) is only the starting value; a saved file wins from then on. The Mac app
never stores it. The file is `{ "pin": "4821" }` (a pin is required) or `{ "off": true }` (turned off); neither file
nor option means "none". The add-on starts without a pin and says so in its log.

From either app (Settings > Phone calls > Pin), or the iPhone's signed `voice` command, or `POST /control/voice` with
`{ "pin": PinAction }`:

- **Change** (`change`: current, next): needs the current pin.
- **Turn off** (`disable`: current): needs the current pin. A call then takes a key answer without asking for one, so
  anyone who picks the phone up can reply by key. Calling in also asks nothing.
- **Turn on / set** (`enable`: next): from "off" or "none"; refused while a pin is on.
- **Reset** (`reset`: next, or `null` to leave the requirement off): needs no current pin and is not subject to the
  lockout, so a forgotten pin can be replaced. See the trust note.

Wrong current pins from `change` and `disable` share one lockout: five wrong guesses lock them for ten minutes. A
pin is never logged and never in `/state`; the view only says `pin: "set" | "off" | "none" | "unknown"`.

Through the relay, `change` is the original `pin` request (so an old add-on keeps working); the rest are a sealed
`pinctl` request (`disable` / `enable` / `reset` / `status`) answered with `{ status: "pinctl", ok, state | reason }`.
An add-on from before `pinctl` never answers, and the Mac then says "The Home Assistant add-on is too old to do that:
update it." The Mac asks `status` at start and when the voice view is read with a cache older than a minute; until
the first answer the view says `unknown`.

**Updating the add-on from the Mac** (`addon-update.ts`; Home Assistant docs: contributors.home-assistant.io/apps/guides/communication/,
/apps/supervisor-api/, /apps/reference/configuration/). The Supervisor refuses any add-on updating itself
(`POST /addons/self/update` and `/store/addons/self/update` answer 403 "can't update itself", whatever `hassio_role`;
`supervisor/api/store.py`), so the add-on asks Home Assistant **Core** instead. The sequence, on the Mac's `gwcmd update`:
`POST /store/reload` (role `manager`: re-pulls the repositories, so a version published minutes ago is seen; a failure
is only noted) -> read the repo's config.yaml -> `GET /addons/self/info` (no permission: `slug`, `name`, `version`,
`version_latest`, `update_available`) -> `GET /core/api/states` and pick the `update.*` entity by the add-on's icon path
(`/addons/<slug>/icon`) or its title, for the installed version -> write the reply to the Mac -> `POST
/core/api/services/update/install {entity_id}` (needs `homeassistant_api: true`; through the proxy the add-on acts as a
Home Assistant administrator). Core's call never returns: the Supervisor stops the add-on. A dropped or timed-out install
is "probably updating", reported as ok. Refusals (each one sentence of at most 200 characters, shown by the Mac as is):
Home Assistant has not seen version X yet (reload the list, then Check again), already on the newest version (reload the
list), the permission is missing (update once in Home Assistant, reinstall if it persists: the 0.11.3 add-on is the
first to declare `homeassistant_api`, so 0.11.1 and older cannot be updated from the Mac), a local add-on (copy the files
again), no update entity. The slug of a repository add-on is `<repo hash>_squeak_voice`, a local one `local_squeak_voice`.
**The Mac** (`GatewayUpdateWatch`, pure, injectable clock) goes requested -> updating -> `Updated to X` when the gateway
status reports that version (or newer), or "The add-on didn't update. Open Home Assistant > Settings > Add-ons > Squeak
Voice and press Update (Home Assistant may not have seen the new version yet)." after 2 minutes, 3 once the add-on's
status went quiet (it was seen going down for the update). The daemon treats no reply at all (the add-on was stopped
before it could answer) as ok, so the Mac watches instead of failing. "Check again" runs the add-on's `check` (store
reload, then re-read). Unverified against a real Home Assistant: the entity lookup and the 2-minute figure.

**Trust.** A reset without the old pin is authorised by the Mac, which holds the channel key: a paired device's signed
command (the phone asks Face ID or the passcode first) or the Mac app (after Touch ID or the login password). So
someone holding the channel key alone can reset the pin; the key lives only on the Mac and in the add-on's options, as
before. The earlier rule, that a stolen channel key cannot switch the pin off, no longer holds for exactly this reason.
Changing and turning off still need the current pin.

## Calling in

Dial Squeak's extension (the one in the add-on's options) from your 3CX app, from anywhere.

1. It answers only if the call is from the extension set in Squeak for Mac, Settings > Phone calls: with none set
   nobody can call in. It then asks for the PIN (two tries), unless the app's PIN setting for calls you make is "Don't ask" (the old `call_in_pin: skip` option only seeds it)
   (a call from that one extension is then proof enough). The Mac app sets when each call direction asks for the PIN.
   With the pin turned off from an app it asks nothing; with no pin ever set, calling in is
   refused (unless that setting is "Don't ask").
2. "Which chat?": the chats that can take a message now, those waiting on you first (up to six, by number).
3. "Say your message after the beep, then press hash." (up to two minutes).
4. The recording goes to the Mac as a small Opus file in a sealed, signed message (`voiceup`); the Mac transcribes
   it with Whisper (local, about a third of a second for a sentence) and the gateway reads back what was heard.
5. Press 1 to send, 2 to record again, hash to cancel. "Send" names the recording, never text: the Mac sends the
   words it transcribed itself, through the same replier as every other surface, only if the chat can still take a
   message, and Telegram/Cliq get a note of what was sent. At most 20 messages an hour by phone. After a send the
   call ends ("Done. Your message was sent to ... Goodbye.").

**Asking, with a Mac that answers (add-on 0.11.0 and Squeak for Mac 2.12.16 or newer).** The Mac says it can in the
directory it publishes (`ask: true`); without that flag the steps above are exactly as before.

- Once a chat is chosen: **1** to say a message or ask a question, **3** to hear where it stands (no recording), star
  repeats, hash hangs up. A key that means nothing is ignored; two in a row end the call.
- After the recording is read back: **1** sends it to the chat and hangs up, **2** treats it as a _question_ about the
  chat and reads the answer aloud, **3** records again, star hears it again, hash cancels.
- After an answer: star hears it again, **1** asks or hears something else about the same chat, hash hangs up. At most 3
  answers (questions and status read-outs together) per call, then "That is as many answers as I can give on one call."
  A question that fails or times out is said ("I could not get an answer. You can try again.") and the read-back's keys
  are offered again; two failures end the call.
- Status (`voice/chat-brief.ts`, `statusReadout`, no model): state (working, finished, waiting for an approval or an
  answer, stopped on an error, idle, looks stuck), what it is doing now (the newest step) or its last message, files and
  lines changed and whether they are pushed, helpers and background commands still running, time since its last
  activity. Two to five short sentences, no paths or links.
- A question (`ChatQuestioner`) is answered by the Cliq assistant's own headless runner (`claudeCliRunner`: `claude -p`
  with no tools, no MCP, no settings or hooks, no saved session; 40 s limit) from the chat's facts and recent steps and
  last message only. The reply is made fit to be heard (`spokenAnswer`: no markdown, paths, links or emoji, anything that
  looks like a secret replaced, whole sentences within 600 characters).
- **Read-only.** Two new `voiceup` kinds, `ask` (names the recording) and `status` (names the chat), answered by a new
  `voicedown` status `answer`. `MemoInbox.handleAnswer` never calls `send`, `canSend` or any writer, so a question cannot
  become a message to an agent, type anywhere or change a chat; the recording stays so it can still be sent after being
  asked about. At most 40 answers an hour; the call trace says `key: 2 (ask it as a question)`, `step: Question answered`,
  `step: Status read out`.
- Old with new: an older Mac never sets `ask`, so a new add-on behaves as before; an older add-on never sends `ask` or
  `status`. A new add-on with an older Mac speaks the read-back in its own voice rather than the Mac's.

Needs on the Mac: `whisper-cli` and `ffmpeg` (`brew install whisper-cpp ffmpeg`) and a speech model at
`~/Library/Application Support/squeak/whisper/ggml-base.en.bin` (or `SQUEAK_VOICE_WHISPER_MODEL`). Without them
calling in stays off and the log says which is missing. The gateway needs the Firebase rules for `voicedir`,
`voiceup` and `voicedown` (`firebase deploy --only database`).

`scripts/e2e-voice.ts` runs the whole call on one Mac with no PBX: the real SIP phone answers a second baresip that
types the PIN and speaks a message, and Whisper transcribes it.

Trust: whoever holds the channel key and passes the PIN can message a chat, as with the phone app's pairing but
without a device key. The key lives only on the Mac and in the add-on's options.

## Ringing out: the phone rings first, the voice follows

From add-on 0.11.0 the Mac writes the call request at once (`audioFollows: true`, no clips in it) and makes its natural
voice while the phone rings, writing each clip as its own `voicedir` document (`callaudio-<callId>-<n>`, sealed and
signed like the call-in prompts). The gateway claims the request, starts ringing, and follows those documents for the
length of the call, seeding each into the phone's speech cache as it arrives. Whatever line is spoken before its clip
arrives is spoken by the add-on's own voice (prepared while the phone rang), so the line is never silent on answer, and
a clip that lands in the middle of the plain version is used from the next line. For an add-on before 0.11.0 (the Mac
reads its version from the add-on's status) the clips go in the request as before, but the render is capped at 6 s
instead of waiting up to 25 s before dialling. The ring itself is 40 s (`RING_TIMEOUT_MS`); a "Call not answered" after
about 12 s is the phone or the PBX ending the call, not Squeak giving up. The call trace says when dialling started,
when each clip was sent, and what played first.

### The chat you used last, and recordings it will not send blind

- **Jump straight in** (`DirectoryDoc.last`, optional: `{ choice, label }`). The Mac names the chat you last used by
  phone (a message sent, or a question or status asked; saved in `voice-last-chat.json`, `last-chat.ts`), else the newest
  chat that waits on you, provided it can take a message now. After the PIN (or first, when it is skipped) the call says
  "Hello, this is Squeak. Press 1 for <chat>, the last one you used. Press 2 for another chat." Key 1 goes on as if
  the chat had been picked from a menu (with a Mac that answers: the say/ask/status step), key 2 goes to the workspace
  and chat menus, star repeats, hash hangs up, two wrong keys end the call. `choice` indexes the list version's chats as
  a memo's does; a last chat no menu lists is appended after the menus' chats, never read out in one. An older Mac
  publishes no `last`, and the call starts at the menus as before. The sentence is among the fixed prompts the Mac
  records ahead (`inboundPrompts`), in both the greeting and no-greeting forms.
- **Unclear recordings** (`transcript-quality.ts`, pure). After transcription: nothing, punctuation only, or one of
  Whisper's stock silence strings ("you", "Thank you.", "Thanks for watching", "[BLANK_AUDIO]", ...) is "nothing heard":
  "I didn't hear anything. Press 3 to record again, or hash to cancel." (2 without a Mac that answers: the key is
  whichever one records again). Two words or fewer under eight characters ("uh", "okay"), or a recording under
  1.5 s, is unclear: "I only heard: <text>. Press 3 to record again, 1 to send it anyway, star to hear it again, or hash
  to cancel." Neither is ever sent without a key, and an unclear one offers no "ask it as a question".

## What an outgoing call says, missed calls, and what a call leaves behind

- **A short script** (`script.ts`). The question is capped at about 15 seconds (35 words), cut at a sentence boundary and
  never mid-word (one endless sentence is cut at a clause, else at a word); a filler opener ("Okay, so") and a trailing
  "let me know" are dropped, and when the start does not fit the closing question is kept, since that is what you answer.
  When anything was left out it says "The full text is on your phone." Options are read tersely, "Options. 1, yes both.
  2, only the daemon. 3, only the uninstaller.": the part before a dash or colon, at most six words, "recommended"
  after the agent's pick. "Press star to hear this again, or hash to hang up." stays. The cards on Telegram, Cliq and
  the apps always carry the whole text, unchanged.
- **A missed call is tried once more** (`missed-call.ts`, `policy.ts`). A call that ends unanswered or fails (a busy
  line is not this: it is waited out as before) is dialled again about 2 minutes later, once, and only if the session
  is still waiting on that same question; then it gives up quietly. The retry keeps every rule of a call: paused,
  quiet hours (`voice.quiet`), and the 5 minute gap after any _other_ episode's call (a retry is not held by the gap
  after its own call, since the gap would always outlast the 2 minutes).
- **The question also goes out as a text** after the first miss, to each of Telegram and Cliq whose notify settings
  allow that kind now (`shouldPushTo`: not muted, the `question` / `approval` switch, quiet hours as notify treats
  them) and that did not already get this episode's card. The monitor's own card, pushed when the call was queued, is
  the normal case, so usually nothing more is sent; the text only makes up for a card held back (quiet hours that
  ended, a setting changed since). Never a duplicate.
- **A one-line summary** is saved with each call in `voice-calls.json` (`summary`, at most 160 characters, optional so
  older files read as before) and appears in `GET /control/voice/calls` and the phone's `voice.calls`:
  "Answered: option 1 (Yes, both)" for a key that answered a question, "Sent “xyz…” to App quitting loop" for a call in
  that sent a message (the transcript's start, from the call trace). It never holds a PIN or a key but the option name.
- **After a call in that sent a message, one text** goes to Telegram and Cliq: "Call: sent your message to <chat>:
  “<first 80 characters>”". It is on by default, replaces the earlier longer "Sent by phone" note, and is held for a
  channel that is muted or in its quiet hours. Failures of a call in are still announced as before.

## One conversation per call (calls out, voice first)

A voice-first call keeps one `claude` process (Haiku, no tools, no MCP, no settings) open for its whole length
(`claudeConversationOpener`, `--input-format stream-json`): each turn is a stdin message ended by a `result` event, so
no turn after the first pays a process start and the model remembers what was said earlier on the call. The first turn
carries the chat, the question and the options; later turns carry only what was said, plus an updated CHAT block when
the chat changed. The chat block now includes its last six messages (what you asked, what it answered), so "what did it
do last time" has an answer. Up to 30 turns a call. The process is closed when the call ends (goodbye, a send, giving
up, aged out) and after 5 minutes idle; a dead or stuck one is dropped and the next turn starts fresh with the whole
picture. Sending is unchanged: the model only proposes words, and your spoken yes at the read-back sends them.
Measured against the real CLI: ~1.3-2.2 s a turn after the first.

**Calling in is the same conversation (add-on 0.13.0).** The directory carries `talk: true` when the Mac can converse
(`DirectoryDoc.talk`; with `ask`). After the chat is chosen the add-on says "<chat>. Go ahead: ask me about it, or tell
me what to do." and runs the same `talkFlow`, each turn a `talk` message with a `callId` (the call's own id, so calls
never share a conversation) and `dirVersion` + `choice` naming a chat of the published list; the Mac makes the call's
record on its first turn (`in:<callId>`) and refuses a version or number the list does not hold. A call in has no
script, so the options are read from the lettered options in the chat's last message, if any. The yes before a send, the
hourly limits and the read-only model are unchanged; if the Mac cannot be reached the keypad menus take over. An older
Mac sends no `talk` and an older add-on ignores it, so the keys stay as they were.

## Call me back when you're done (add-on 0.14.0)

On a voice-first call (out or in) the person can end it with "call me back when you're done with the tests", or give an
instruction and ask for the same ("go with B, then call me back"). The model's reply to such an utterance is the
`callback` intent (or `send` with `callback: true`); `MemoInbox` carries it out with `requestCallback`, never the model.

- **Plain request**: the chat must be working (`App.requestCallback`); otherwise the call says "Nothing is running in
  <chat> right now, so there is nothing to wait for." and keeps listening. Otherwise: "Okay, I'll call you back when
  <chat> is done. Goodbye." and the call ends. Nothing is sent to the chat.
- **With a send**: the read-back says "...then call you back when it's done. Say yes to send." Only the yes sends, and
  only a send that went arranges the call back ("Sent. I'll call you back when it's done. Goodbye.").
- **Kept** in `voice-callbacks.json` (0600): chat, spoken name, a clipped note, when. One per chat, 20 at most, 12 hours.
- **Fires** (`VoiceChannel.checkCallbacks`, on every fleet snapshot, `judgeCallback`): when the chat has been seen
  working since the request and is no longer working (finished, idle, error). A request made with a send waits up to
  10 minutes for the chat to start working. If the chat stopped to ask something, the ordinary call for that question
  covers it and the request is dropped. Paused, quiet hours, the 5 minute gap or a call in progress hold it (looked at
  again every minute); it is spent by its one call.
- **The call**: "Hello, this is Squeak. <chat> is done, as you asked." plus the end of its last message, then "Ask me
  anything about it, or tell me what to do next." It is a voice call with no options (`CallDialog` converses without
  options; keys 1 to 8 do nothing, 9 and 0 work). An add-on older than 0.14.0 gets a short call that only tells.
- **Nobody picks up, or it cannot be placed**: Telegram and Cliq get a text with how it ended. Calls are recorded in
  the history with reason `callback`.

## Staying on the line while it works (add-on 0.15.0)

After a message the person approved (the yes at the read-back), a voice-first call no longer just says "Sent. Goodbye."
It asks: "Sent. Want me to stay on the line while it works? Say yes to hold, or no to hang up." A no (or two unclear
answers) hangs up; a call back asked for with the send hangs up too, since that was the choice already made.

- **Hold**: "Okay, I'll stay on the line. Press 1 any time to hear what it's thinking, or hash to hang up." The add-on
  waits on the keypad and checks in with the Mac every 10 s (`talk` turns with phase `hold`, no recording, answered
  `next: "hold"` with an empty text, which says nothing). Every 45 s of quiet it says "Still working. Press 1 to hear
  what it's thinking."
- **Peek (key 1)**: a `peek` turn; the Mac reads the newest steps of the chat in plain words (`thinkingReadout`: "Right
  now: ... Before that: ... Earlier: ...", thinking summaries and notes in their own words, tools as labels, no paths,
  secrets removed, nothing from your own messages). Read-only, no model.
- **When it stops** (finished, asking, blocked, error): the Mac says how it ended (`endedReadout`) and invites a
  question, and the call goes back to listening, so the conversation carries on. A chat that never starts working is
  waited for 60 s, then reported ("I don't see it working yet."). The hold ends after 10 minutes ("You'll get a card
  when it's done") or when the chat disappears. Hash hangs up at any time.
- Offered only to an add-on that runs the hold loop (`HOLD_ADDON`, 0.15.0); older ones hang up after the send as
  before. `MemoInbox` `hold` dependency: `supported`, `state`, `ended`, `peek`.

## Terse by default, and a character you set (Squeak for Mac 2.12.32)

These calls are to the owner, not to a customer, so the default **persona** is terse (`voice-settings.json`
`persona: { style: "terse" | "friendly" | "custom", custom? }`, absent = terse; `GET/POST /control/voice`, Settings >
Phone calls > How it talks).

- **Fixed lines**: a terse call drops "Hello, this is Squeak." and the "Just tell me what to do, or ask me anything about
  it." invitation (the beep says it): an opening is "<chat> has a question for you. <question>", a call back "<chat> is
  done. <how it ended>", a call in no hello before the PIN or the chat menu (`DirectoryDoc.terse`, so the Mac makes the
  same prompts ahead), the conversation's own start just the chat's name, and what a held chat says when it stops no
  longer ends on an invitation. Only Friendly keeps them. The keypad's own wording is untouched.
- **The assistant's voice**: the model's system prompt gets "How you sound (tone and wording only; it never overrides
  the rules above...)" with the persona's text (`personaInstruction`): terse = no greetings, thanks, apologies or offers
  of more help, the answer first; friendly = warm and brief; custom = your own description (at most 300 characters,
  control characters removed). It applies to questions and to a call's conversation, read when that conversation opens.
- **It changes tone, never power**: the rules (answer only from the chat, never invent, never a secret, a send needs
  your spoken yes) come first and a style cannot loosen them. Setting it takes the token and a strict shape (exactly
  `{ persona: { style, custom? } }`); a custom style without text is refused.
- A change applies from the next call. The Mac app saves Terse and Friendly at once; Custom waits for its text and Save.

## How a recording ends, keys, busy lines, and the line itself (add-on 0.11.2)

- A message recording ends on the first of: `#` (hash), 2.5 s of quiet after speech was heard (energy-based, read from
  the WAV as baresip writes it, `SpeechWatcher` in `sip-phone.ts`), the 60 s cap (the line says "I have to stop there"
  and carries on with what it has), or no speech 8 s after the beep ("I didn't hear anything. Press 1 to try again, or
  hash to hang up."). The call log says: `Recording started`, `Speech detected X s in`, and `Recording ended because:
hash | silence | cap | no speech`.
- Every key is logged as `dtmf: <key> (prompt|menu|recording)`. Digits are shown as `digit` while a PIN is typed and in
  an outbound call's dialog; `#` and `*` are always named.
- An outbound "agent has a question" call that finds the line busy (a call in is up) is not failed: the Mac traces
  `Line busy, will ring when the call ends`, tries again every 10 s for up to 3 minutes, then gives up with a trace and
  leaves the question in the app. The existing minimum gap between calls still applies.
- No speech is made during a call. The natural voice runs only in advance (add-on start, a changed directory, ringing),
  and a pre-render waits for a call to end. A line that is missing mid-call comes from the plain voice and logs
  `voice line made during a call`. The line rests on a long silence file between clips, so RTP never stops. Every clip is
  padded with 300 ms of silence, and a clip that is not 8 kHz mono PCM16 is logged (`voice clip is not 8 kHz mono PCM16`).
- At the end of a call the log carries `Line quality: good|fair|poor (<callstat lines>)`; when baresip's reply is not a
  stats block the add-on logs its first 200 characters once (`voice call stats reply not recognised`) so "no data" can
  be diagnosed. See docs/remote-channel.md for `lastTest.quality`.

## Later

## Pairing a gateway (daemon side)

The Mac makes one code (`src/voice/pair-protocol.ts`: the phone channel's database address and a one-time secret,
valid 10 minutes). Control routes, token-gated like `/control/voice`, no CORS header:

- `POST /control/voice/gateway/pair` `{}` opens the window and answers `{ ok, code, expiresAt }`; a second call
  replaces the first. It needs the phone channel's own `SQUEAK_REMOTE_DATABASE_URL` (503 on the shared server).
- `GET /control/voice/gateway` answers `{ pairing: null | { state: waiting|request|done|expired, expiresAt, name?,
version?, verify? }, status: { state: none|stale|ok|sipDown, version?, sipRegistered?, sipError?, at? } }`.
- `POST /control/voice/gateway/approve` `{ approve: boolean }`: yes seals the Mac's channel and key for the add-on
  (`src/voice/pairing-window.ts`); no deletes the request.

If the grant made a new channel and key they are saved to `.env` and the daemon exits about 1.5 s later so launchd
restarts it with the relay; an unchanged pair restarts nothing. Status comes from the add-on's `gwstatus` document
(`gateway-status.ts`, fresh within 90 s), also in `GET /control/voice` as `gateway`. The `voicepair` rules kind
carries the request and grant.
