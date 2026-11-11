// Squeak's hosted relay: per-Mac keys, tenant isolation and per-account daily limits (docs/cloud-layer.md, "Squeak's hosted
// relay: per-Mac keys"). RELAY_KEY stays the operator's and opens everything; a Mac key opens only that Mac's namespace.
//
// Relay-owned partition keys (none has the `channels/<id>/<kind>` shape, so no /doc or /list path can name them):
//   mac-keys       doc <sha256 of the key, base64url> = {userId, macId, createdAt}   (the key itself is never stored)
//   mac-owners     doc <macId> = {userId, hash, name, createdAt, channels}           (one key per Mac; channels = claimed count)
//   mac-user/<id>  doc <macId> = {createdAt}                                         (counts an account's Macs)
//   channel-owners doc <channelId> = {macId, userId, at}                             (first writer wins)
//   usage          doc <userId> = {day, req, bytes}                                  (UTC day; stale day reads as zero)
const crypto = require("node:crypto");
const { CHANNEL } = require("./rules");

const MAC_KEYS = "mac-keys";
const MAC_OWNERS = "mac-owners";
const CHANNEL_OWNERS = "channel-owners";
const USAGE = "usage";
const MAX_MACS = 10;
/** A Mac's own channel plus its ponds'. */
const MAX_CHANNELS = 64;
const MAC_ID = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const PRINTABLE = /^[^\u0000-\u001f\u007f]{0,64}$/u;
const HEADER = "x-squeak-mac-key";
/** Fresh-from-the-store usage is trusted this long before it is read again. */
const USAGE_REFRESH_MS = 60_000;

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("base64url");
const parse = (json) => {
  if (json === null || json === undefined) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * deps = { store, now?, limits?: {requests, bytes}, batch?: number, usageCache?: Map, ownerCache?: Map }
 * `batch`: usage is written to the store every `batch` charges (default 1: exact). The deployed function passes a
 * module-level cache and a batch of 10 (index.js), so a request costs one store read per minute and a write per ten
 * charges, at the price of an under-count of at most batch-1 charges per warm instance.
 */
function createTenants(deps) {
  const store = deps.store;
  const now = deps.now || Date.now;
  const limits = {
    requests: deps.limits && deps.limits.requests > 0 ? deps.limits.requests : 50_000,
    bytes: deps.limits && deps.limits.bytes > 0 ? deps.limits.bytes : 20 * 1024 * 1024,
  };
  const batch = deps.batch && deps.batch > 0 ? deps.batch : 1;
  const usageCache = deps.usageCache || new Map();
  const ownerCache = deps.ownerCache || new Map();

  /** The record behind a presented Mac key, or null (unknown, revoked, malformed). */
  async function authenticate(given) {
    if (typeof given !== "string" || !KEY_SHAPE.test(given)) return null;
    const rec = parse(await store.get(MAC_KEYS, hashKey(given)));
    if (!rec || typeof rec.userId !== "string" || typeof rec.macId !== "string") return null;
    return { userId: rec.userId, macId: rec.macId };
  }

  async function usageOf(userId) {
    const t = now();
    const day = dayOf(t);
    let e = usageCache.get(userId);
    if (!e || e.day !== day || (e.ops === 0 && t - e.loadedAt > USAGE_REFRESH_MS)) {
      const stored = parse(await store.get(USAGE, userId));
      const base = stored && stored.day === day ? stored : { req: 0, bytes: 0 };
      e = { day, req: Number(base.req) || 0, bytes: Number(base.bytes) || 0, ops: 0, loadedAt: t };
      usageCache.set(userId, e);
    }
    return e;
  }
  async function flush(userId, e, force) {
    e.ops += 1;
    if (!force && e.ops < batch) return;
    e.ops = 0;
    e.loadedAt = now();
    await store.put(USAGE, userId, JSON.stringify({ day: e.day, req: e.req, bytes: e.bytes }));
  }
  /** Count one request against the account; false = over the daily limit. */
  async function chargeRequest(mac) {
    const e = await usageOf(mac.userId);
    if (e.req >= limits.requests) return false;
    e.req += 1;
    await flush(mac.userId, e, false);
    return true;
  }
  /** Count bytes about to be written; false = it would pass the daily limit (nothing is counted then). */
  async function chargeBytes(mac, n) {
    const e = await usageOf(mac.userId);
    if (e.bytes + n > limits.bytes) return false;
    e.bytes += n;
    await flush(mac.userId, e, false);
    return true;
  }

  /** May this Mac key touch this channel? Unclaimed channels are claimed by the first Mac to touch them (capped). */
  async function channelAllowed(mac, channel) {
    if (typeof channel !== "string" || !CHANNEL.test(channel)) return false;
    if (channel === mac.macId) return true;
    const cached = ownerCache.get(channel);
    if (cached) return cached === mac.macId;
    const claim = parse(await store.get(CHANNEL_OWNERS, channel));
    if (claim) {
      ownerCache.set(channel, claim.macId);
      return claim.macId === mac.macId;
    }
    const owner = parse(await store.get(MAC_OWNERS, mac.macId));
    if (!owner || owner.userId !== mac.userId || (Number(owner.channels) || 0) >= MAX_CHANNELS) return false;
    await store.put(CHANNEL_OWNERS, channel, JSON.stringify({ macId: mac.macId, userId: mac.userId, at: now() }));
    // Two Macs claiming at once: read back and let whoever the store kept win.
    const kept = parse(await store.get(CHANNEL_OWNERS, channel));
    if (!kept || kept.macId !== mac.macId) return false;
    ownerCache.set(channel, mac.macId);
    await store.put(MAC_OWNERS, mac.macId, JSON.stringify({ ...owner, channels: (Number(owner.channels) || 0) + 1 }));
    return true;
  }

  /** POST /account/macs/provision for a signed-in `user`: create or rotate the Mac's key. Returns {status, body}. */
  async function provision(user, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "body" } };
    if (Object.keys(body).some((k) => k !== "macId" && k !== "name")) return { status: 400, body: { error: "body" } };
    if (typeof body.macId !== "string" || !MAC_ID.test(body.macId)) return { status: 400, body: { error: "mac" } };
    if (body.name !== undefined && (typeof body.name !== "string" || !PRINTABLE.test(body.name)))
      return { status: 400, body: { error: "name" } };
    const macId = body.macId;
    const owner = parse(await store.get(MAC_OWNERS, macId));
    if (owner && owner.userId !== user.userId) return { status: 403, body: { error: "mac" } };
    const ownChannel = CHANNEL.test(macId);
    const claim = ownChannel ? parse(await store.get(CHANNEL_OWNERS, macId)) : null;
    if (claim && (claim.userId !== user.userId || claim.macId !== macId))
      return { status: 403, body: { error: "mac" } };
    if (!owner && (await store.list(`mac-user/${user.userId}`)).length >= MAX_MACS)
      return { status: 409, body: { error: "too-many-macs" } };
    const key = crypto.randomBytes(32).toString("base64url");
    const hash = hashKey(key);
    const createdAt = now();
    const name = (body.name === undefined ? (owner && owner.name) || "" : body.name).trim();
    if (owner && typeof owner.hash === "string") await store.del(MAC_KEYS, owner.hash).catch(() => undefined);
    await store.put(MAC_KEYS, hash, JSON.stringify({ userId: user.userId, macId, createdAt }));
    await store.put(
      MAC_OWNERS,
      macId,
      JSON.stringify({
        userId: user.userId,
        hash,
        name,
        createdAt,
        channels: owner ? Number(owner.channels) || 0 : ownChannel ? 1 : 0,
      }),
    );
    if (!owner) await store.put(`mac-user/${user.userId}`, macId, JSON.stringify({ createdAt }));
    if (ownChannel && !claim)
      await store.put(CHANNEL_OWNERS, macId, JSON.stringify({ macId, userId: user.userId, at: createdAt }));
    return {
      status: 200,
      body: {
        macId,
        key,
        createdAt,
        rotated: Boolean(owner),
        header: HEADER,
        namespace: { channel: ownChannel ? macId : null, maxChannels: MAX_CHANNELS },
        limits: { dailyRequests: limits.requests, dailyBytes: limits.bytes },
      },
    };
  }

  /** DELETE /account/macs/<macId> for a signed-in `user`: the key stops working at once. Returns a status. */
  async function revoke(user, macId) {
    if (typeof macId !== "string" || !MAC_ID.test(macId)) return 400;
    const owner = parse(await store.get(MAC_OWNERS, macId));
    if (!owner) return 404;
    if (owner.userId !== user.userId) return 403;
    if (typeof owner.hash === "string") await store.del(MAC_KEYS, owner.hash);
    await store.del(MAC_OWNERS, macId);
    await store.del(`mac-user/${user.userId}`, macId);
    return 204;
  }

  return { authenticate, chargeRequest, chargeBytes, channelAllowed, provision, revoke, limits };
}

module.exports = { createTenants, HEADER, MAX_MACS, MAX_CHANNELS };
