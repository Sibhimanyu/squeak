// The access rule, mirroring firebase/database.rules.json: channels/<22-64 [A-Za-z0-9_-]>/<kind>/<doc>.
const KINDS = new Set(["state", "pairing", "commands", "results", "live", "media", "voice", "voiceresult", "voicedir", "voiceup", "voicedown", "voicepair"]);
const CHANNEL = /^[A-Za-z0-9_-]{22,64}$/;
const DOC = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_BOX = 900_000;

/** "channels/<id>/<kind>/<doc>" -> { channel, kind, doc, pk } or null. */
function parseDocPath(path) {
  if (typeof path !== "string") return null;
  const p = path.split("/");
  if (p.length !== 4 || p[0] !== "channels") return null;
  const [, channel, kind, doc] = p;
  if (!CHANNEL.test(channel) || !KINDS.has(kind) || !DOC.test(doc)) return null;
  return { channel, kind, doc, pk: `channels/${channel}/${kind}` };
}

/** "channels/<id>/<kind>" -> { channel, kind, pk } or null. */
function parseKindPath(path) {
  if (typeof path !== "string") return null;
  const p = path.split("/");
  if (p.length !== 3 || p[0] !== "channels") return null;
  const [, channel, kind] = p;
  if (!CHANNEL.test(channel) || !KINDS.has(kind)) return null;
  return { channel, kind, pk: `channels/${channel}/${kind}` };
}

module.exports = { parseDocPath, parseKindPath, MAX_BOX, KINDS };
