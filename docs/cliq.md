# Squeak in Zoho Cliq

Squeak can post every push card to a Cliq bot, and — once the pieces below
are in place — take commands, button taps and replies back from it.

## How it works

Cliq cannot call the Mac: button taps, messages and forms run *handlers*
(Deluge scripts) on Zoho's servers, and the Mac sits behind NAT on loopback.
So nothing on the Mac listens. Instead:

```
card ──► bot /message ──► you tap / reply / type
                               │
                     bot handler (Deluge) writes a record
                               ▼
                   Cliq database "squeakinbox"
                               │
      Squeak polls it every 5s (OAuth), deletes each record, then acts
```

- **Cards go out** through the bot's `/message` endpoint with the webhook
  token (`SQUEAK_CLIQ_WEBHOOK_URL`). Not `/incoming`: that runs the bot's
  incoming-webhook handler, and with none written it answers 200 with the
  subscriber list and shows nothing.
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
- The database holds up to 1000 characters of text per record, so a longer
  reply is refused in Cliq rather than cut short.

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

### 2. A Zoho OAuth client for the Mac

1. Open <https://api-console.zoho.in> → **Add Client → Self Client → Create**.
   Note the **Client ID** and **Client Secret**.
2. **Generate Code** tab. Scope:
   ```
   ZohoCliq.StorageData.ALL,ZohoCliq.Storage.CREATE,ZohoCliq.Storage.READ
   ```
   Time duration 10 minutes, any description, **Create**. Copy the code.
3. Within those minutes, on the Mac:
   ```bash
   node ~/conductor/repos/squeak/dist/squeak/cli.js cliq-auth <client-id> <client-secret> <code>
   ```
   It trades the code for a refresh token, creates the `squeakinbox`
   database, and writes `SQUEAK_CLIQ_CLIENT_ID`, `…_SECRET` and
   `…_REFRESH_TOKEN` to `.env`.

   If it cannot create the database, make it by hand: **Integrations →
   Databases → Create**, name `squeakinbox`, fields `kind`, `arg`, `msgid`,
   `userid` (Limited text), `sentat` (Number), `body` (Large text).
4. Add who may act, to `.env`:
   ```
   SQUEAK_CLIQ_OWNER_ID=<your Zoho user id>
   SQUEAK_CLIQ_OWNER_EMAIL=<your Cliq login email>
   ```
   Your user id is the number the bot's `/message` call returns in
   `user_ids`.

### 3. A connection for the handlers

**Integrations → Connections → Create Connection → Zoho Cliq**. Connection
name and link name `squeakinbox`, scope `ZohoCliq.StorageData.CREATE`.
Connect it. The handlers below write through it.

### 4. The three handlers

**Bot → Squeak → Message handler** (runs for anything you type to the bot):

```deluge
record = Map();
record.put("kind","message");
record.put("body",message);
record.put("userid",user.get("id"));
record.put("sentat",zoho.currenttime.toLong());
if(message_details != null && message_details.get("message") != null)
{
	replied = message_details.get("message").get("replied_message");
	if(replied != null)
	{
		record.put("msgid",replied.get("id"));
	}
}
if(message.length() > 1000)
{
	return {"text":"That is over 1000 characters, more than Cliq's database holds. Send it from Squeak on the Mac instead."};
}
response = zoho.cliq.createRecord("squeakinbox",record,"squeakinbox");
if(response.get("status") != "SUCCESS")
{
	return {"text":"Squeak could not queue that: " + response.get("message")};
}
return Map();
```

**Integrations → Functions → Create Function**, name `squeakbutton`, type
**Button** (every card button runs this):

```deluge
key = arguments.get("key");
if(key == "reply")
{
	inputs = list();
	inputs.add({"type":"textarea","name":"text","label":"Reply","placeholder":"What should the agent do?","mandatory":true,"max_length":"1000"});
	return {"type":"form","title":"Reply","name":"squeakreply","button_label":"Send","inputs":inputs,"action":{"type":"invoke.function","name":"squeakreply"}};
}
record = Map();
record.put("kind","button");
record.put("arg",key);
record.put("msgid",message.get("id"));
record.put("userid",user.get("id"));
record.put("sentat",zoho.currenttime.toLong());
response = zoho.cliq.createRecord("squeakinbox",record,"squeakinbox");
if(response.get("status") != "SUCCESS")
{
	return {"type":"banner","text":"Squeak could not queue that tap.","status":"failure"};
}
return {"type":"banner","text":"Sent to your Mac","status":"success"};
```

**Create Function**, name `squeakreply`, type **Form** (the Reply form's Send):

```deluge
record = Map();
record.put("kind","reply");
record.put("body",form.get("values").get("text"));
record.put("msgid",message.get("id"));
record.put("userid",user.get("id"));
record.put("sentat",zoho.currenttime.toLong());
response = zoho.cliq.createRecord("squeakinbox",record,"squeakinbox");
if(response.get("status") != "SUCCESS")
{
	return {"type":"banner","text":"Squeak could not queue that reply.","status":"failure"};
}
return {"type":"banner","text":"Sent to your Mac","status":"success"};
```

### 5. Restart Squeak

`launchctl kickstart -k gui/$(id -u)/com.squeak.daemon`, or `ship.sh` when
the code changed. Type `radar` to the bot: the answer comes back within five
seconds. `grep -i cliq ~/Library/Logs/squeak/squeak.log` shows any failure.

## Limits

- Records API: 30 requests a minute per user. The poll uses 12, plus one
  delete per thing you did.
- A poll every five seconds means up to five seconds before anything happens.
- A card's buttons stay visible after use (a message posted through the API
  cannot be edited from here); the turn check is what stops a second tap.
- More than three lettered options do not fit as buttons (Cliq's five-button
  limit, less Reply and Full message); reply with the letter instead.
