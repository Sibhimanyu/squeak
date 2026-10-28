# Voice: Squeak rings you through your PBX

Two ways to place the call. **Gateway (recommended):** a Home Assistant add-on on your LAN places it, and the Mac
asks for each call through Firebase, so the Mac can be on any network. **Direct:** the Mac registers with the PBX
itself, which needs a route to it (home Wi-Fi or a VPN). The gateway wins when both are set up.

## Gateway setup

1. `squeak voice-relay` on the Mac makes the channel and key (saved to `.env`) and prints the add-on options.
2. `scripts/build-voice-addon.sh` builds `dist-addon/squeak-voice`. Copy that folder to Home Assistant's `/addons`
   share (Samba or SSH add-on), then Settings > Add-ons > Add-on store > menu > Check for updates, and install
   Squeak Voice under Local add-ons. Fill in its options (see its Documentation tab) and start it.
3. Deploy the database rules once (`firebase deploy --only database`): they allow the `voice` and `voiceresult`
   kinds in the channel.
4. Restart Squeak (`./scripts/ship.sh`).

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
  with permissions off. Without a PIN a call can tell you but never takes an answer. Two wrong PINs hang up.

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

## Later

Inbound dictation: you dial Squeak's extension, speak, whisper.cpp transcribes the recording and it goes to the chosen
chat as a message. `aufile` already writes what the caller says to a WAV; the parts missing are answering an incoming
call, an end-of-speech rule, the transcription and picking the chat.
