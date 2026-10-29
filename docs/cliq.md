# Squeak in Zoho Cliq

Squeak can post every push card to a Cliq bot, and — once the pieces below
are in place — take commands, button taps and replies back from it.

## How it works

Cliq cannot call the Mac: button taps, messages and forms run _handlers_
(Deluge scripts) on Zoho's servers, and the Mac sits behind NAT on loopback.
The first design had the handlers write to a Cliq database the Mac read
with Zoho OAuth, but a managed Zoho org refuses a personal Self Client
(`oauth_app_blocked`, seen on zohocorp). Handlers can still post _out_, so
they write to the Firebase project used by the phone channel:

```
card ──► bot /message ──► you tap / reply / type
                               │
             bot handler (Deluge) signs the record, posts it
                               ▼
      Realtime Database cliq/<relay>/inbox
                         (project SQUEAK_REMOTE_PROJECT)
                               │
      Squeak streams it, verifies, deletes each record, then acts
```

The current Mac setup sets `SQUEAK_REMOTE_DATABASE_URL`, so
`squeak cliq-relay` writes handlers that post plain JSON to
`<database>/cliq/<relay>/inbox.json` (it answers with a `name` too, so the
handlers' success check is unchanged), and Squeak streams that inbox: a tap
runs within a fraction of a second, with a once-a-minute poll as a safety
net. Until these handlers are pasted into Cliq, records still arriving in
Firestore are read as well, so nothing is stranded by the move. Older
configurations without `SQUEAK_REMOTE_DATABASE_URL` continue to use Firestore
and poll it every five seconds.

- **Cards go out** through the bot's `/message` endpoint with the webhook
  token (`SQUEAK_CLIQ_WEBHOOK_URL`). Not `/incoming`: that runs the bot's
  incoming-webhook handler, and with none written it answers 200 with the
  subscriber list and shows nothing.
- **Firebase is an untrusted pipe.** Realtime Database rules
  (`firebase/database.rules.json`) let a handler create a `{box, sig, at}`
  record under a relay id of 32+ random characters, and let Squeak read and
  delete it. Legacy Firestore rules (`firebase/firestore.rules`) likewise
  allow record creation, not updates. Each `box` carries an HMAC-SHA256 from
  a secret that exists only in Squeak's `.env` and the three handlers; the
  Mac deletes anything unsigned, altered or already seen (`cliq_seen`)
  without reading it. Unlike the phone channel the text is not encrypted, so
  a command remains in Firebase until Squeak deletes it.
- **Each card's message id is kept** (`cliq_card` in Squeak's state db,
  from `sync_message: true`) with the session it answers and a hash of the
  turn it was about. A tap or a reply names the card it came from, never a
  session guessed from loose text.
- **A record runs at most once.** It is deleted before it is acted on; one
  that cannot be deleted waits for the next poll.
- **Every action is checked** before anything is typed:
  the record's user id must be `SQUEAK_CLIQ_OWNER_ID`; it must be under ten
  minutes old; the card must be one Squeak posted; and the chat's newest turn
  must still be the one on the card — a tap on an old card cannot answer a
  newer question. Then the same replier as Telegram and the Mac window runs,
  with the same busy rules: a working or blocked Conductor chat is refused,
  a terminal agent is only typed into at an empty prompt.
- A handler forwards up to 4000 characters; a longer message is refused in
  Cliq rather than cut short.

What Cliq can do:

| in Cliq                             | does                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| tap **A** / **B** / **C** on a card | sends that letter                                                                                         |
| tap **Reply**, type, **Send**       | sends the text                                                                                            |
| reply to a card                     | sends the text                                                                                            |
| tap **Full message**                | posts the agent's whole last message, with its own buttons                                                |
| ask anything, in plain words        | an answer from what Squeak sees ("anything need me?", "what did greenroom change?", "mute for two hours") |
| "tell _session_ to …"               | a card with the exact text and **Send** / **Cancel**; only Send types it                                  |
| type `radar`                        | what is running now                                                                                       |
| type `snooze` / `unmute`            | silence alerts for an hour / resume (Telegram too)                                                        |
| type `hooks`, `help`                | hook wiring, what this is                                                                                 |

### Chatting

Anything that is not a quick command goes to `fleet/assistant.ts`, which
asks the Mac's own `claude` (Haiku, the user's login, no API key) with a
summary of every active session: state, what it is doing now, its last
message clipped to 1500 characters, what changed on disk. About six seconds
an answer. The CLI runs with no tools, no MCP servers, no settings files (so
no hooks fire — including Squeak's own), and no saved session, so it can
only write an answer and never appears on the radar itself.

It never types into an agent. When you ask it to tell one something, it
proposes the session and the text; Squeak decides whether that session can
take a message now (`canTakeMessageNow`: not working, not on an approval,
not a Conductor chat holding its own question) and if so posts a card with
**Send** / **Cancel**. The text waits in `cliq_pending` and is taken — read
and deleted in one step — by the first Send, which then passes every check
a card's button does, including the turn check against the moment it was
proposed. Session content is fenced off as data in the prompt; the worst a
message planted in an agent's output can do is get a wrong proposal shown to
you, which you do not send.

Cards for sessions that cannot be answered (a blocked Conductor chat, an
agent waiting on an approval) carry no buttons, same as Telegram.

## Setup

Replace `cliq.zoho.in` / `accounts.zoho.in` / `api-console.zoho.in` with your
own data centre's hosts (`.com`, `.eu`, …) throughout.

### 1. The bot and its webhook token (one-way)

1. Cliq → **Integrations → Bots → Create Bot**, access level _Personal_.
   Subscribe to it.
2. **Integrations → Webhook Tokens → Generate New Token.**
3. In Squeak's `.env`:
   ```
   SQUEAK_CLIQ_WEBHOOK_URL=https://cliq.zoho.in/api/v2/bots/<bot-unique-name>/message?zapikey=<token>
   ```
   The bot's unique name is in its **API Endpoint**.

That alone gives you cards. The rest makes them answerable.

### 2. The relay

Answerable Cliq commands and replies need a Firebase project with the Cliq
relay rules. Squeak's shared server intentionally permits only the phone's
`state`, `pairing`, `commands` and `results` paths; it rejects the Cliq relay
path. One-way cards from the bot still work on the shared server, but its
two-way relay does not. To use the relay, choose your own Firebase in **Settings
› iPhone** or move from the shared server to your own project first. Moving
means pairing the iPhone again.

With your own Firebase project configured on the Mac:

```bash
node ~/conductor/repos/squeak/dist/squeak/cli.js cliq-relay
```

It makes the relay id and signing secret, saves them to `.env`
(`SQUEAK_CLIQ_RELAY_ID`, `SQUEAK_CLIQ_RELAY_SECRET`), and writes the three
handlers with both filled in to `Application Support/squeak/cliq-handlers.txt`
(0600). The secret is never printed. `--rotate` makes a new pair; paste the
handlers again after it.

With the current Mac setup, `SQUEAK_REMOTE_DATABASE_URL` is set and the
handlers post to the Realtime Database. Its rules include the Cliq relay and
are deployed during Firebase setup. If you manage an existing personal project,
deploy the current rules with
`(cd firebase && firebase deploy --only database --project <project>)`.
Older configurations without `SQUEAK_REMOTE_DATABASE_URL` use the legacy
Firestore relay; those handlers need the Firestore rules deployed instead.

Add who may act, to `.env`:

```
SQUEAK_CLIQ_OWNER_ID=<your Zoho user id>
SQUEAK_CLIQ_OWNER_EMAIL=<your Cliq login email>
```

Your user id is the number the bot's `/message` call returns in `user_ids`.

The current Realtime Database rules allow the handler to create a signed relay
record and Squeak to read and delete it. Keep the project and rules in sync
before pasting new handlers.

### 3. The three handlers

Paste each block of `cliq-handlers.txt` where its heading says:

- **Bots → Squeak → Edit Handlers → Message handler** — replace the sample
  code Cliq starts every bot with (the "Messaging me for the first time?"
  replies).
- **Integrations → Functions → Create**, name `squeakbutton`, type
  **Button** — every card button runs it; Reply opens a form.
- **Integrations → Functions → Create**, name `squeakreply`, type **Form** —
  the Reply form's Send.

Each builds a record, signs it with `zoho.encryption.hmacsha256(secret,
box, "hex")`, and posts it with `invokeurl`. No Cliq connection is needed:
the Firebase rules allow the post, and the signature is what Squeak verifies.
Current handlers write to Realtime Database; existing handlers keep writing to
Firestore until you paste the regenerated ones.

### 4. Restart Squeak

`launchctl kickstart -k gui/$(id -u)/com.squeak.daemon`, or `ship.sh` when
the code changed. Type `radar` to the bot: the Realtime Database relay usually
answers within a second; the legacy Firestore relay can take up to five
seconds. `grep -i cliq ~/Library/Logs/squeak/squeak.log` shows any failure.

## Limits

- The legacy Firestore relay polls every five seconds (about 17,000 reads a
  day, against 50,000 free). The current Realtime Database relay streams
  changes and polls once a minute as a safety net.
- A card's buttons stay visible after use (a message posted through the API
  cannot be edited from here); the turn check is what stops a second tap.
- More than three lettered options do not fit as buttons (Cliq's five-button
  limit, less Reply and Full message); reply with the letter instead.

## Notification settings

Which cards and quota alerts reach Cliq (and, separately, Telegram) is set in `notify-settings.json`, edited from the Mac app and the phone: mute, approvals, questions, stalls, quota, finishes (Conductor / all / off) and quiet hours. The filter is applied in `CliqChannel` itself, after the monitor's own rules, so a muted card still shows on the radar. See `docs/remote-channel.md`, "Notification settings".

## The bot's logo

Squeak cannot set it: the org blocks Zoho OAuth (`oauth_app_blocked`) and the bot has only a webhook, so there is no
API to call. Set it by hand:

1. In Cliq open **Bots & Tools** (the grid icon, or Profile > Bots & Tools) > **Bots**.
2. Hover the `squeak` bot and choose **Edit** (the pencil).
3. Click the bot's picture, upload the logo, crop to the circle, and **Save**.

Use `brand/logo/png/squeak-bot-avatar-640.jpg` from the repo (the same file is bundled at
`Squeak.app/Contents/Resources/daemon/brand/logo/png/squeak-bot-avatar-640.jpg`): the duck on Ink, already
centred so a circle crop keeps all of it.
