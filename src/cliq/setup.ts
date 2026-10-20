import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { databaseUrl as remoteDatabaseUrl } from "../squeak/config.js";

/** Longest message a handler forwards; the relay's rules cap a record at 12000 characters. */
export const CLIQ_MAX_MESSAGE_CHARS = 4000;

/**
 * Set keys in an env file in place, appending the ones it lacks. Every
 * other line — comments, keys this does not know — is kept as it was.
 */
export function setEnvValues(envPath: string, values: Record<string, string>): void {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n") : [];
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const match = /^\s*#?\s*([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (updated.length > 0 && updated[updated.length - 1] === "") {
    updated.pop();
  }
  for (const [key, value] of pending) {
    updated.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, `${updated.join("\n")}\n`, { mode: 0o600 });
  // `mode` only applies to a new file; this one holds secrets either way.
  fs.chmodSync(envPath, 0o600);
}

interface RelaySettings {
  projectId: string;
  relayId: string;
  secret: string;
  /** The Realtime Database, when the relay lives there (SQUEAK_REMOTE_DATABASE_URL). */
  databaseUrl?: string | null;
}

/**
 * The Deluge that ends every handler: sign the record and post it to the
 * relay. Both stores answer a create with a `name`: Firestore the document's,
 * the Realtime Database the new key.
 */
function postToRelay(settings: RelaySettings, failure: string): string {
  if (settings.databaseUrl) {
    return `box = record.toString();
sig = zoho.encryption.hmacsha256("${settings.secret}",box,"hex");
payload = {"box":box,"sig":sig,"at":zoho.currenttime.toLong()};
response = invokeurl
[
	url :"${settings.databaseUrl}/cliq/${settings.relayId}/inbox.json"
	type :POST
	parameters:payload.toString()
	headers:{"Content-Type":"application/json"}
];
if(response.get("name") == null)
{
	${failure}
}`;
  }
  const url = `https://firestore.googleapis.com/v1/projects/${settings.projectId}/databases/(default)/documents/cliq/${settings.relayId}/inbox`;
  return `box = record.toString();
sig = zoho.encryption.hmacsha256("${settings.secret}",box,"hex");
payload = {"fields":{"box":{"stringValue":box},"sig":{"stringValue":sig},"at":{"integerValue":zoho.currenttime.toLong().toString()}}};
response = invokeurl
[
	url :"${url}"
	type :POST
	parameters:payload.toString()
	headers:{"Content-Type":"application/json"}
];
if(response.get("name") == null)
{
	${failure}
}`;
}

/** The three handlers, with this Mac's relay filled in (docs/cliq.md explains each). */
export function cliqHandlerScripts(settings: RelaySettings): string {
  const messageHandler = `record = Map();
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
if(message.length() > ${CLIQ_MAX_MESSAGE_CHARS})
{
	return {"text":"That is over ${CLIQ_MAX_MESSAGE_CHARS} characters. Send it from Squeak on the Mac instead."};
}
${postToRelay(settings, `return {"text":"Squeak could not queue that: " + response};`)}
return Map();`;

  const buttonFunction = `key = arguments.get("key");
if(key == "reply")
{
	inputs = list();
	inputs.add({"type":"textarea","name":"text","label":"Reply","placeholder":"What should the agent do?","mandatory":true,"max_length":"${CLIQ_MAX_MESSAGE_CHARS}"});
	return {"type":"form","title":"Reply","name":"squeakreply","button_label":"Send","inputs":inputs,"action":{"type":"invoke.function","name":"squeakreply"}};
}
record = Map();
record.put("kind","button");
record.put("arg",key);
record.put("msgid",message.get("id"));
record.put("userid",user.get("id"));
record.put("sentat",zoho.currenttime.toLong());
${postToRelay(settings, `return {"type":"banner","text":"Squeak could not queue that tap.","status":"failure"};`)}
return {"type":"banner","text":"Sent to your Mac","status":"success"};`;

  const formFunction = `record = Map();
record.put("kind","reply");
record.put("body",form.get("values").get("text"));
record.put("msgid",message.get("id"));
record.put("userid",user.get("id"));
record.put("sentat",zoho.currenttime.toLong());
${postToRelay(settings, `return {"type":"banner","text":"Squeak could not queue that reply.","status":"failure"};`)}
return {"type":"banner","text":"Sent to your Mac","status":"success"};`;

  return [
    "Squeak's Cliq handlers. They hold the relay's signing secret: keep this file to yourself.",
    "",
    "===== 1. Bots → Squeak → Edit Handlers → Message handler (replace everything) =====",
    messageHandler,
    "",
    "===== 2. Integrations → Functions → Create: name squeakbutton, type Button =====",
    buttonFunction,
    "",
    "===== 3. Integrations → Functions → Create: name squeakreply, type Form =====",
    formFunction,
    "",
  ].join("\n");
}

/**
 * `squeak cliq-relay [--rotate]`: make (or keep) the relay id and signing
 * secret, save them to `.env`, and write the three handlers with them filled
 * in to a private file for pasting into Cliq. The secret is never printed.
 */
export function runCliqRelay(envPath: string, env: Record<string, string>, args: string[]): string[] {
  const projectId = env.SQUEAK_REMOTE_PROJECT?.trim();
  if (!projectId) {
    throw new Error("Set SQUEAK_REMOTE_PROJECT first: the relay lives in that Firebase project.");
  }
  const rotate = args.includes("--rotate");
  const relayId =
    !rotate && env.SQUEAK_CLIQ_RELAY_ID ? env.SQUEAK_CLIQ_RELAY_ID : randomBytes(32).toString("base64url");
  const secret =
    !rotate && env.SQUEAK_CLIQ_RELAY_SECRET ? env.SQUEAK_CLIQ_RELAY_SECRET : randomBytes(32).toString("hex");
  setEnvValues(envPath, { SQUEAK_CLIQ_RELAY_ID: relayId, SQUEAK_CLIQ_RELAY_SECRET: secret });

  const handlersPath = path.join(path.dirname(envPath), "cliq-handlers.txt");
  const databaseUrl = remoteDatabaseUrl(env.SQUEAK_REMOTE_DATABASE_URL);
  fs.writeFileSync(handlersPath, cliqHandlerScripts({ projectId, relayId, secret, databaseUrl }), { mode: 0o600 });
  fs.chmodSync(handlersPath, 0o600);

  return [
    rotate ? "Made a new relay id and secret; paste the handlers into Cliq again." : "Relay saved to .env.",
    `The three Cliq handlers, filled in, are in ${handlersPath}`,
    databaseUrl
      ? "They post to the Realtime Database. Until they are pasted, records still arriving in Firestore are read too."
      : "They post to Firestore. Set SQUEAK_REMOTE_DATABASE_URL and run this again to stream instead of polling.",
    env.SQUEAK_CLIQ_OWNER_ID && env.SQUEAK_CLIQ_OWNER_EMAIL
      ? "Restart Squeak to turn on two-way Cliq."
      : "Set SQUEAK_CLIQ_OWNER_ID and SQUEAK_CLIQ_OWNER_EMAIL too (docs/cliq.md), then restart Squeak.",
  ];
}
