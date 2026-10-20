# Squeak in Zoho Cliq

Squeak can post every push card to a Cliq bot, and — once the pieces below
are in place — take commands, button taps and replies back from it.

## How it works

Cliq cannot call the Mac: button taps, messages and forms run *handlers*
(Deluge scripts) on Zoho's servers, and the Mac sits behind NAT on loopback.
The first design had the handlers write to a Cliq database the Mac read
with Zoho OAuth, but a managed Zoho org refuses a personal Self Client
(`oauth_app_blocked`, seen on zohocorp). Handlers can still post *out*, so
they post to Squeak's own Firebase project instead:

```
card ──► bot /message ──► you tap / reply / type
                               │
             bot handler (Deluge) signs the record, posts it
                               ▼
      Firestore cliq/<relay>/inbox   (project SQUEAK_REMOTE_PROJECT)
                               │
      Squeak polls it every 5s, verifies, deletes each record, then acts
```

**Streamed, with the Realtime Database.** With `SQUEAK_REMOTE_DATABASE_URL`
set, `squeak cliq-relay` writes handlers that post plain JSON to
`<database>/cliq/<relay>/inbox.json` (it answers with a `name` too, so the
handlers' success check is unchanged), and Squeak streams that inbox: a tap
runs within a fraction of a second instead of up to five, and it polls only
once a minute as a safety net. Until the new handlers are pasted into Cliq,
records still arriving in Firestore are read as well (`legacy` in
`CliqRelayInbox`), so nothing is stranded by the move. The rules for the
inbox (`firebase/database.rules.json`) are the Firestore ones: create or
delete only, `{box, sig, at}`, a 64-character signature.

- **Cards go out** through the bot's `/message` endpoint with the webhook
  token (`SQUEAK_CLIQ_WEBHOOK_URL`). Not `/incoming`: that runs the bot's
  incoming-webhook handler, and with none written it answers 200 with the
  subscriber list and shows nothing.
- **Firestore is an untrusted pipe**, as for the phone. The rules
  (`firebase/firestore.rules`) only allow creating `{box, sig, at}` records
  under a relay id of 32+ random characters, never updating one. Each
  record's `box` carries an HMAC-SHA256 from a secret that exists only in
  Squeak's `.env` and in the three handlers; the Mac deletes anything
  unsigned, altered or already seen (`cliq_seen`) without reading it.
  Unlike the phone channel the text is not encrypted, so the words of a
  command sit in the Firebase project until the next poll deletes them.
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

| in Cliq | does |
| --- | --- |
| tap **A** / **B** / **C** on a card | sends that letter |
| tap **Reply**, type, **Send** | sends the text |
| reply to a card | sends the text |
| tap **Full message** | posts the agent's whole last message, with its own buttons |
| ask anything, in plain words | an answer from what Squeak sees ("anything need me?", "what did greenroom change?", "mute for two hours") |
| "tell *session* to …" | a card with the exact text and **Send** / **Cancel**; only Send types it |
| type `radar` | what is running now |
| type `snooze` / `unmute` | silence alerts for an hour / resume (Telegram too) |
| type `hooks`, `help` | hook wiring, what this is |

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

1. Cliq → **Integrations → Bots → Create Bot**, access level *Personal*.
   Subscribe to it.
2. **Integrations → Webhook Tokens → Generate New Token.**
3. In Squeak's `.env`:
   ```
   SQUEAK_CLIQ_WEBHOOK_URL=https://cliq.zoho.in/api/v2/bots/<bot-unique-name>/message?zapikey=<token>
   ```
   The bot's unique name is in its **API Endpoint**.

That alone gives you cards. The rest makes them answerable.

### 2. The relay

On the Mac, with `SQUEAK_REMOTE_PROJECT` already set (the phone channel's
Firebase project):

```bash
node ~/conductor/repos/squeak/dist/squeak/cli.js cliq-relay
```

It makes the relay id and signing secret, saves them to `.env`
(`SQUEAK_CLIQ_RELAY_ID`, `SQUEAK_CLIQ_RELAY_SECRET`), and writes the three
handlers with both filled in to `Application Support/squeak/cliq-handlers.txt`
(0600). The secret is never printed. `--rotate` makes a new pair; paste the
handlers again after it.

Add who may act, to `.env`:

```
SQUEAK_CLIQ_OWNER_ID=<your Zoho user id>
SQUEAK_CLIQ_OWNER_EMAIL=<your Cliq login email>
```

Your user id is the number the bot's `/message` call returns in `user_ids`.

The rules for the relay deploy with the rest of Firebase:
`(cd firebase && firebase deploy --only firestore:rules --project <project>)`.

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
Firestore takes the post unauthenticated, and the signature is what counts.

### 4. Restart Squeak

`launchctl kickstart -k gui/$(id -u)/com.squeak.daemon`, or `ship.sh` when
the code changed. Type `radar` to the bot: the answer comes back within five
seconds. `grep -i cliq ~/Library/Logs/squeak/squeak.log` shows any failure.

## Limits

- Firestore's free tier is far above this: a poll every five seconds is
  about 17,000 reads a day, against 50,000 free.
- A poll every five seconds means up to five seconds before anything happens.
- A card's buttons stay visible after use (a message posted through the API
  cannot be edited from here); the turn check is what stops a second tap.
- More than three lettered options do not fit as buttons (Cliq's five-button
  limit, less Reply and Full message); reply with the letter instead.
