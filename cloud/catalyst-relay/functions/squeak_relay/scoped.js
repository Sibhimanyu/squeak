// Pond-scoped access (docs/ponds.md, "Web guests" and "Scoped tokens"): a token the relay issues for ONE pond's channel and
// nothing else, revocable on removal. Nobody but an owner's Mac holds RELAY_KEY, which opens every channel in the store.
// The token is stateless (an HMAC under RELAY_KEY) plus a revocation list in the store. Three scopes, three prefixes, and
// the prefix is inside the MAC so one cannot be turned into another:
//
//   pt.<pondId>.<memberId>.<expiresAtSeconds>.<mac>   guest   (a web member): presence, tcmds, joins, holds, ripples
//   pm.<pondId>.<memberId>.<expiresAtSeconds>.<mac>   member  (a Mac member): the guest kinds plus threads and tevents
//   pj.<pondId>.<inviteId>.<expiresAtSeconds>.<mac>   join    (carried by an invite): writes the join request only
//
// Reads are of sealed documents in the pond's own channel for every scope; writes never reach members, keys or pond.
const crypto = require("node:crypto");

const POND = /^[A-Za-z0-9_-]{22,64}$/;
const MEMBER = /^[A-Za-z0-9_-]{1,64}$/;
/** What a guest's token may write: its own presence, commands, join request, holds and ripples. Never members, keys, threads or tevents. */
const GUEST_WRITE = new Set(["presence", "tcmds", "joins", "holds", "ripples"]);
/** A Mac member also starts threads, so it writes its threads and their event batches. */
const MEMBER_WRITE = new Set([...GUEST_WRITE, "threads", "tevents"]);
/** An invite's token writes the join request and nothing else. */
const JOIN_WRITE = new Set(["joins"]);
const SCOPES = {
  guest: { prefix: "pt", domain: "squeak-pond-token", write: GUEST_WRITE },
  member: { prefix: "pm", domain: "squeak-pond-token-member", write: MEMBER_WRITE },
  join: { prefix: "pj", domain: "squeak-pond-token-join", write: JOIN_WRITE },
};
const BY_PREFIX = Object.fromEntries(Object.entries(SCOPES).map(([scope, v]) => [v.prefix, scope]));
const MAX_TTL_SEC = 30 * 24 * 3600;

const mac = (key, scope, pondId, memberId, exp) =>
  crypto
    .createHmac("sha256", String(key))
    .update(`${SCOPES[scope].domain}\n${pondId}\n${memberId}\n${exp}`)
    .digest("base64url");

function issue(key, pondId, memberId, nowMs, ttlSec, scope = "guest") {
  if (!key || typeof scope !== "string" || !Object.hasOwn(SCOPES, scope) || !POND.test(pondId) || !MEMBER.test(memberId)) return null;
  const ttl = Math.min(Math.max(Number(ttlSec) || 24 * 3600, 60), MAX_TTL_SEC);
  const exp = Math.floor(nowMs / 1000) + ttl;
  return {
    token: `${SCOPES[scope].prefix}.${pondId}.${memberId}.${exp}.${mac(key, scope, pondId, memberId, exp)}`,
    expiresAt: exp * 1000,
  };
}

/** { pondId, memberId, scope } for a good, unexpired token (revocation is checked by the caller against the store), else null. */
function verify(key, token, nowMs) {
  if (!key || typeof token !== "string") return null;
  const p = token.split(".");
  if (p.length !== 5) return null;
  const scope = BY_PREFIX[p[0]];
  const [, pondId, memberId, expText, given] = p;
  if (!scope || !POND.test(pondId) || !MEMBER.test(memberId) || !/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  if (exp * 1000 <= nowMs) return null;
  const want = Buffer.from(mac(key, scope, pondId, memberId, exp));
  const have = Buffer.from(String(given));
  if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) return null;
  return { pondId, memberId, scope };
}

/** A Data Streams channel name for a pond: no pond id in it, 20 characters of its hash. */
const pondStreamName = (pondId) => "p" + crypto.createHash("sha256").update(pondId).digest("hex").slice(0, 19);

module.exports = { issue, verify, pondStreamName, GUEST_WRITE, MEMBER_WRITE, JOIN_WRITE, SCOPES, POND, MEMBER };
