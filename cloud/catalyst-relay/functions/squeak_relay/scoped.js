// Pond-scoped access for web guests (docs/ponds.md, "Web guests"): a token the relay issues when an owner approves a
// guest, good for ONE pond's channel and nothing else, revocable on removal. A web guest never holds RELAY_KEY, which
// opens every channel in the store. The token is stateless (an HMAC under RELAY_KEY) plus a revocation list in the store.
//
//   pt.<pondId>.<memberId>.<expiresAtSeconds>.<mac>      mac = base64url HMAC-SHA256(RELAY_KEY, "squeak-pond-token\n<pondId>\n<memberId>\n<exp>")
const crypto = require("node:crypto");

const POND = /^[A-Za-z0-9_-]{22,64}$/;
const MEMBER = /^[A-Za-z0-9_-]{1,64}$/;
/** What a guest's token may write: its own presence, commands, join request, holds and ripples. Never members, keys, threads or tevents. */
const GUEST_WRITE = new Set(["presence", "tcmds", "joins", "holds", "ripples"]);
const MAX_TTL_SEC = 30 * 24 * 3600;

const mac = (key, pondId, memberId, exp) =>
  crypto
    .createHmac("sha256", String(key))
    .update(`squeak-pond-token\n${pondId}\n${memberId}\n${exp}`)
    .digest("base64url");

function issue(key, pondId, memberId, nowMs, ttlSec) {
  if (!key || !POND.test(pondId) || !MEMBER.test(memberId)) return null;
  const ttl = Math.min(Math.max(Number(ttlSec) || 24 * 3600, 60), MAX_TTL_SEC);
  const exp = Math.floor(nowMs / 1000) + ttl;
  return { token: `pt.${pondId}.${memberId}.${exp}.${mac(key, pondId, memberId, exp)}`, expiresAt: exp * 1000 };
}

/** { pondId, memberId } for a good, unexpired token (revocation is checked by the caller against the store), else null. */
function verify(key, token, nowMs) {
  if (!key || typeof token !== "string") return null;
  const p = token.split(".");
  if (p.length !== 5 || p[0] !== "pt") return null;
  const [, pondId, memberId, expText, given] = p;
  if (!POND.test(pondId) || !MEMBER.test(memberId) || !/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  if (exp * 1000 <= nowMs) return null;
  const want = Buffer.from(mac(key, pondId, memberId, exp));
  const have = Buffer.from(String(given));
  if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) return null;
  return { pondId, memberId };
}

/** A Data Streams channel name for a pond: no pond id in it, 20 characters of its hash. */
const pondStreamName = (pondId) => "p" + crypto.createHash("sha256").update(pondId).digest("hex").slice(0, 19);

module.exports = { issue, verify, pondStreamName, GUEST_WRITE, POND, MEMBER };
