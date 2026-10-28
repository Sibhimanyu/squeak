# Voice: Squeak rings you through your PBX

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

## Setup

1. `brew install baresip`.
2. In 3CX, add an extension for Squeak (say 900). Note its extension number, Authentication ID and password.
3. Add to Squeak's `.env`:

```
SQUEAK_VOICE_HOST=pbx.example.com        # or host:port; your 3CX FQDN or LAN address
SQUEAK_VOICE_EXTENSION=900
SQUEAK_VOICE_AUTH_ID=...                 # 3CX's Authentication ID, if it differs
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

Tested here: the dialog and keypad, policy, config validation, the channel's checks, baresip's netstring protocol,
its config loading with the `aufile` modules, dialling, and switching the audio source mid-call.

Not tested against a real PBX: registration with 3CX, and DTMF arriving as `CALL_DTMF_START` events from the 3CX app
(baresip has no command to send a digit, so a loopback could not exercise it). `squeak voice-test` is that check.

## Later

Inbound dictation: you dial Squeak's extension, speak, whisper.cpp transcribes the recording and it goes to the chosen
chat as a message. `aufile` already writes what the caller says to a WAV; the parts missing are answering an incoming
call, an end-of-speech rule, the transcription and picking the chat.
