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
   message, and Telegram/Cliq get a note of what was sent. At most 20 messages an hour by phone.

Needs on the Mac: `whisper-cli` and `ffmpeg` (`brew install whisper-cpp ffmpeg`) and a speech model at
`~/Library/Application Support/squeak/whisper/ggml-base.en.bin` (or `SQUEAK_VOICE_WHISPER_MODEL`). Without them
calling in stays off and the log says which is missing. The gateway needs the Firebase rules for `voicedir`,
`voiceup` and `voicedown` (`firebase deploy --only database`).

`scripts/e2e-voice.ts` runs the whole call on one Mac with no PBX: the real SIP phone answers a second baresip that
types the PIN and speaks a message, and Whisper transcribes it.

Trust: whoever holds the channel key and passes the PIN can message a chat, as with the phone app's pairing but
without a device key. The key lives only on the Mac and in the add-on's options.

## Later

Asking questions out loud ("what needs me?") on the same call, through the Cliq assistant; ending a message on
silence instead of hash.

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
