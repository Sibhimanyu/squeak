// The access rules, mirroring firebase/database.rules.json exactly:
// channels/<22-64 [A-Za-z0-9_-]>/<kind>/<doc: 1-80 [A-Za-z0-9_-]>, kinds from kinds.json (the one list the
// relay and its tests share), a document is {box, sig?, device?, at?} and nothing else.
const KINDS = new Set(require("./kinds.json"));
const CHANNEL = /^[A-Za-z0-9_-]{22,64}$/;
const DOC = /^[A-Za-z0-9_-]{1,80}$/;
/** `box` must be shorter than this (characters), as in the RTDB rule. */
const MAX_BOX = 900000;
/** Largest request body the relay reads: a maximal box plus the JSON around it. */
const MAX_BODY = 1_000_000;
/** Data Streams connection names: 20 characters at most, no "." or ":". */
const NAME = /^[^.:\s]{1,20}$/;

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

/** The RTDB `.validate` rules for one document. */
function validDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  for (const key of Object.keys(doc)) if (!["box", "sig", "device", "at"].includes(key)) return false;
  if (typeof doc.box !== "string" || doc.box.length >= MAX_BOX) return false;
  if (doc.sig !== undefined && !(typeof doc.sig === "string" && doc.sig.length < 512)) return false;
  if (doc.device !== undefined && !(typeof doc.device === "string" && doc.device.length < 64)) return false;
  if (doc.at !== undefined && !(typeof doc.at === "number" && Number.isFinite(doc.at))) return false;
  return true;
}

module.exports = { KINDS, MAX_BOX, MAX_BODY, NAME, parseDocPath, parseKindPath, validDoc };
