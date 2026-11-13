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
  if (
    !key ||
    typeof scope !== "string" ||
    !Object.hasOwn(SCOPES, scope) ||
    !POND.test(pondId) ||
    !MEMBER.test(memberId)
  )
    return null;
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

/**
 * The opaque tag a hosted relay publishes instead of a path: first 22 characters of base64url(SHA-256("squeak-notice-v1:" +
 * channelId)). Channel ids are secret to other tenants, so a tag names nothing to anyone who lacks the id; every client
 * computes it itself (no server secret). Pinned vector: tests.
 */
const noticeTag = (channelId) =>
  crypto.createHash("sha256").update(`squeak-notice-v1:${channelId}`).digest("base64url").slice(0, 22);

// An account-link ticket (docs/cloud-layer.md, "Accounts"): al.<userId>.<expMs>.<emailB64url>.<mac>, HMAC under RELAY_KEY
// over its own prefix and fields. The signed-in user's email rides inside (signed), so the relay stores nothing at issue.
const TICKET_USER = /^[A-Za-z0-9_-]{1,64}$/;
// One signed shape for two jobs, told apart by prefix and by the domain tag inside the MAC, so neither verifies as the other.
const KINDS_SIGNED = { al: "squeak-account-link", at: "squeak-account-app", ja: "squeak-join-attest" };
const ticketMac = (key, prefix, userId, exp, emailB64) =>
  crypto
    .createHmac("sha256", String(key))
    .update(`${KINDS_SIGNED[prefix]}\n${userId}\n${exp}\n${emailB64}`)
    .digest("base64url");

function issueSigned(prefix, key, userId, email, nowMs, ttlMs) {
  if (!key || typeof userId !== "string" || !TICKET_USER.test(userId) || typeof email !== "string" || !email)
    return null;
  const exp = nowMs + ttlMs;
  const emailB64 = Buffer.from(email, "utf8").toString("base64url");
  return {
    value: `${prefix}.${userId}.${exp}.${emailB64}.${ticketMac(key, prefix, userId, exp, emailB64)}`,
    expiresAt: exp,
  };
}

/** { userId, email } for a genuine, unexpired value of this prefix, else null. */
function verifySigned(prefix, key, text, nowMs) {
  if (!key || typeof text !== "string") return null;
  const p = text.split(".");
  if (p.length !== 5 || p[0] !== prefix) return null;
  const [, userId, expText, emailB64, given] = p;
  if (!TICKET_USER.test(userId) || !/^\d{1,15}$/.test(expText) || !/^[A-Za-z0-9_-]{1,400}$/.test(emailB64)) return null;
  const exp = Number(expText);
  if (exp <= nowMs) return null;
  const want = Buffer.from(ticketMac(key, prefix, userId, exp, emailB64));
  const have = Buffer.from(given);
  if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) return null;
  return { userId, email: Buffer.from(emailB64, "base64url").toString("utf8") };
}

function issueTicket(key, userId, email, nowMs, ttlMs) {
  const r = issueSigned("al", key, userId, email, nowMs, ttlMs);
  return r && { ticket: r.value, expiresAt: r.expiresAt };
}
const verifyTicket = (key, ticket, nowMs) => verifySigned("al", key, ticket, nowMs);

/** An account token for a native app (x-squeak-account): at.<userId>.<expMs>.<emailB64url>.<mac>. */
function issueAppToken(key, userId, email, nowMs, ttlMs) {
  const r = issueSigned("at", key, userId, email, nowMs, ttlMs);
  return r && { token: r.value, expiresAt: r.expiresAt };
}
const verifyAppToken = (key, token, nowMs) => verifySigned("at", key, token, nowMs);

/**
 * A join attestation (x-squeak-join-attest): minted for a Mac by its own key (so the relay, not the joiner, says which
 * account it is), good for minutes, and accepted only on a join request. It is not an account token: no account route
 * reads a "ja" value, so it can neither provision a Mac nor mint anything.
 */
function issueJoinAttest(key, userId, email, nowMs, ttlMs) {
  const r = issueSigned("ja", key, userId, email, nowMs, ttlMs);
  return r && { token: r.value, expiresAt: r.expiresAt };
}
const verifyJoinAttest = (key, token, nowMs) => verifySigned("ja", key, token, nowMs);

module.exports = {
  issueTicket,
  verifyTicket,
  issueAppToken,
  verifyAppToken,
  issueJoinAttest,
  verifyJoinAttest,
  issue,
  verify,
  pondStreamName,
  noticeTag,
  GUEST_WRITE,
  MEMBER_WRITE,
  JOIN_WRITE,
  SCOPES,
  POND,
  MEMBER,
};
