// The relay's request handling, with every Catalyst service passed in (`deps`), so tests run it with fakes and the
// deployed function (index.js) wires the real SDK. Contract: docs/cloud-layer.md, "Catalyst: how the five operations map".
//
//   GET    /doc?path=            -> 200 {doc} | 404
//   PUT    /doc?path=  {doc}     -> 204 (then a change notice {p:"channels/<id>/<kind>"})
//   DELETE /doc?path=            -> 204 (then the notice)
//   GET    /list?prefix=         -> 200 {items:[{id,doc}]}
//   GET    /me                   -> 200 {userId, email, name, avatarAt?} (Catalyst Hosted-login user, no relay key) | bare 401
//   PUT|DELETE|GET /account/avatar (cookie or x-squeak-account token; GET also relay key + ?userId=): the account's photo,
//                         a JPEG of at most 64 KB kept under the relay-owned pk "avatars" (no /doc or /list path reaches it)
//   GET    /account/zoho-photo/start (cookie) -> 302 to Zoho's consent for profile.userphoto.READ; GET .../callback (Zoho's
//                         redirect, same cookie) reads THEIR OWN photo once, parks it 10 min under the relay-owned pk
//                         "zoho-photo" and 302s to the app with #zoho-photo=ready|denied|failed|blocked; GET /account/zoho-photo
//                         (cookie) hands the bytes over once and deletes them. Needs deps.zoho (env SQUEAK_ZOHO_*), else 503
//                         These three use the signed-in account (cookie) only, never a Mac key. Relay-owned pks ("avatars", "avatar-writes",
//                         "zoho-photo", and the tenants.js "mac-keys", "mac-owners", "mac-user/<id>") are never reachable by /doc or /list:
//                         parseDocPath/parseKindPath accept only channels/<id>/<kind>
//   POST   /account/link-ticket (cookie) | POST /account/link, /account/unlink (relay key) | GET /account/macs (cookie)
//   POST   /account/app-token (cookie only) -> {token, expiresAt, email, name}; header x-squeak-account: <token> stands in for
//                         the cookie on /me, /account/macs, /account/device-request and /account/avatar (so it lists Macs,
//                         requests devices and owns the photo; it still mints neither tokens nor tickets)
//   POST|GET /account/device-request (cookie): see docs/cloud-layer.md, "Accounts"
//   GET    /ping                 -> 200 {ok, store, channel, channelId?, version}
//   POST   /token    {name}      -> 200 {url, key, wssId}
//   POST   /pond-token {pondId, memberId, ttlSec, scope?}  (relay key) -> 200 {token, expiresAt}: a pond-scoped token;
//                      scope "guest" (default), "member" or "join" (an invite's: writes the join request only)
//   POST   /pond-revoke {pondId, memberId}         (relay key) -> 204
//   POST   /account/macs/provision {macId, name?} (cookie or x-squeak-account) -> 200 {macId, key, ...}: creates or rotates the
//                      Mac's own key (shown once, only its hash kept; at most 10 Macs per account: 409 too-many-macs)
//   DELETE /account/macs/<macId> (cookie or x-squeak-account, the owner) -> 204: revokes that key
//   with header x-squeak-mac-key (a per-Mac key, tenants.js; /token gives the shared stream, whose hosted notices are opaque tags) instead of the relay key: /doc, /list, /ping, /token,
//   /pond-token, /pond-revoke, /account/link, /account/unlink and GET /account/avatar?userId= for that Mac's own channels
//   only (403 elsewhere), and per-account daily request/byte limits (429 {error:"quota"})
//   with header x-squeak-pond-token instead of the relay key: /doc and /list inside that one pond only (guest writes
//   limited to the scope's kinds in scoped.SCOPES), and POST /pond-stream {name} -> that pond's own Data Streams token pair
//
// Every other request needs header x-squeak-relay equal to RELAY_KEY (the operator's, opens everything; constant-time
// compare) or a valid x-squeak-mac-key; anything else is a bare 401.
const crypto = require("node:crypto");
const { CHANNEL, DOC, MAX_BODY, NAME, parseDocPath, parseKindPath, validDoc } = require("./rules");
const scoped = require("./scoped");
const { createTenants, HEADER: MAC_HEADER } = require("./tenants");

const VERSION = require("./package.json").version;
const PREFIX = /^\/server\/squeak_relay/;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
/** Constant-time equality of two secrets (both hashed first, so lengths do not leak). */
const sameKey = (given, expected) =>
  typeof expected === "string" &&
  expected.length > 0 &&
  typeof given === "string" &&
  crypto.timingSafeEqual(digest(given), digest(expected));

/**
 * Kinds no pond token may touch. joinids (the signed-in user behind a join request) and devreqs (a signed-in account's
 * request to add a device to its Mac) are written only by the relay itself; devresults is written by the Mac (relay key).
 */
const RELAY_OWNED_KINDS = new Set(["joinids", "devreqs", "devresults"]);
const isRelayOwned = (kind) => RELAY_OWNED_KINDS.has(kind);
/** The relay key itself never PUTs these two: the relay alone writes them (devresults is the Mac's answer, so it may). */
const NO_KEY_PUT = new Set(["joinids", "devreqs"]);
const TICKET_TTL_MS = 10 * 60 * 1000;
const APP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_REQUESTS = 3;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const B64_ANY_200 = /^[A-Za-z0-9+/_-]{1,200}={0,2}$/;
const B64URL_200 = /^[A-Za-z0-9_-]{1,200}$/;
const NO_STORE = { "Cache-Control": "no-store" };
/** The profile photo: relay-owned partition keys (not channels/..., so parseDocPath/parseKindPath can never name them). */
const AVATAR_PK = "avatars";
const AVATAR_RATE_PK = "avatar-writes";
const AVATAR_MAX_BYTES = 64 * 1024;
/** base64 of the largest photo, plus the JSON around it. */
const AVATAR_MAX_BODY = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024;
const AVATAR_WRITES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The Zoho photo hand-over: a relay-owned pk (like "avatars", no /doc or /list path names it), kept ten minutes. */
const ZOHO_PK = "zoho-photo";
const ZOHO_TTL_MS = 10 * 60 * 1000;
const ZOHO_PHOTO_MAX_BYTES = 256 * 1024; // base64 of this stays under a NoSQL item's ~400 KB
const ZOHO_FETCH_MS = 10_000;
const ZOHO_SCOPE = "profile.userphoto.READ";
/** Zoho's accounts hosts (one per data centre); an `accounts-server` the callback names is trusted only if it is one. */
const ZOHO_ACCOUNTS = /^accounts\.zoho\.(com|in|eu|com\.au|jp|com\.cn|sa|ca)$/;
const ZOHO_APP_PATH = "/app/index.html";
const normEmail = (e) => String(e).trim().toLowerCase();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const send = (res, status, body, headers) => {
  if (body === undefined) {
    if (headers) res.writeHead(status, headers);
    else res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
const readBody = (req, max) =>
  new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(tooLarge());
        return;
      }
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
const readJson = async (req, max) => {
  const raw = await readBody(req, max);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
};

/**
 * deps = {
 *   key: string | undefined,                    // RELAY_KEY
 *   store: { get(pk, doc) -> string|null, put(pk, doc, json), del(pk, doc), list(pk) -> [{doc, json}], ready() -> bool },
 *   streams: { channelId() -> string|null, publish(channelId, text), token(channelId, name) -> {url, key, "wss-id"} },
 *   currentUser?: () -> {userId, email, name} | null,   // the signed-in Catalyst user of THIS request (user scope), never throws
 *   signin?: "required",                         // GUEST_SIGNIN: a join request needs a signed-in user
 *   log?: (sentence) => void,
 * }
 */
function createRelay(deps) {
  const log = deps.log || (() => {});
  const tenants = createTenants({
    store: deps.store,
    now: deps.now,
    limits: deps.limits,
    batch: deps.quotaBatch,
    usageCache: deps.usageCache,
    ownerCache: deps.ownerCache,
  });

  /**
   * Wakes the watchers after a write. Self-hosted: {"p":"channels/<id>/<kind>"}. Hosted (SQUEAK_RELAY_HOSTED=1, one shared
   * stream for every tenant): {"t":"<tag>"} only, no path and no kind, so a subscriber learns nothing about other tenants
   * (scoped.noticeTag). A notice only wakes a pass; the reader re-reads through the store.
   */
  async function publishNotice(pk) {
    const text = deps.hosted ? JSON.stringify({ t: scoped.noticeTag(pk.split("/")[1]) }) : JSON.stringify({ p: pk });
    // A pond's writes also wake that pond's own stream, the only one a web guest may subscribe to.
    try {
      const pondId = pk.split("/")[1];
      const pondStream = deps.streams.pondChannelId ? await deps.streams.pondChannelId(pondId, false) : null;
      if (pondStream) await deps.streams.publish(pondStream, text);
    } catch {
      log("pond notice not published");
    }
    // The write already happened; a failed notice only costs the watchers up to the 60 s safety poll.
    try {
      const channelId = await deps.streams.channelId();
      if (channelId) await deps.streams.publish(channelId, text);
    } catch {
      log("notice not published");
    }
  }

  /** The signed-in user of this request or null: any failure of the SDK reads as anonymous. */
  async function whoIsThis() {
    try {
      const u = deps.currentUser ? await deps.currentUser() : null;
      if (!u || typeof u.email !== "string" || !u.email || typeof u.userId !== "string" || !u.userId) return null;
      return { userId: u.userId, email: u.email, name: typeof u.name === "string" ? u.name : "" };
    } catch {
      return null;
    }
  }

  /**
   * A guest's join request (the \`joins\` kind under a pj. token). Account identifies, never grants: this only decides
   * whether the request is accepted and records who signed it in; the owner still approves on the Mac.
   * Returns a refusal ({status, body}) or null, and writes/clears the relay-owned \`joinids\` beside the request.
   */
  async function joinIdentity(who, parsed, method) {
    if (method === "DELETE") {
      await deps.store.del(`channels/${parsed.channel}/joinids`, parsed.doc).catch(() => undefined);
      return null;
    }
    const pin = who.scope === "join" ? await deps.store.get(`pins/${who.pondId}`, who.memberId) : null;
    const pinned = pin ? JSON.parse(pin).email : null;
    const user = await whoIsThis();
    if (!user && (pinned || deps.signin === "required")) return { status: 401, body: { error: "signin" } };
    if (pinned && normEmail(user.email) !== normEmail(pinned)) return { status: 403, body: { error: "email" } };
    return { user };
  }

  /** A web guest: one pond's channel, by a scoped token, never the relay key. */
  async function handleGuest(req, res, url, route, method, given) {
    const who = scoped.verify(deps.key, given, Date.now());
    if (!who) return send(res, 401);
    const revoked = await deps.store.get(`revoked/${who.pondId}`, who.memberId);
    if (revoked !== null && revoked !== undefined) return send(res, 401);
    const inPond = (parsed) => parsed && parsed.channel === who.pondId;
    if (route === "/pond-stream") {
      if (method !== "POST") return send(res, 405, {});
      const body = await readJson(req, 1024);
      if (typeof body.name !== "string" || !NAME.test(body.name)) return send(res, 400, { error: "name" });
      // A pond's own channel when one exists, else the shared squeak_notice channel: Catalyst makes channels in the
      // console only, so most ponds share it. A notice there names only a path ("channels/<id>/<kind>"), never
      // content, so a guest on it learns that other channels changed, not what they hold.
      const own = deps.streams.pondChannelId ? await deps.streams.pondChannelId(who.pondId, false) : null;
      const id = own ?? (await deps.streams.channelId().catch(() => null));
      if (!id) return send(res, 503, { error: "channel" });
      const pair = await deps.streams.token(id, body.name);
      return send(res, 200, { url: pair.url, key: pair.key, wssId: pair["wss-id"] });
    }
    if (route === "/doc") {
      const parsed = parseDocPath(url.searchParams.get("path"));
      if (!inPond(parsed) || isRelayOwned(parsed.kind)) return send(res, 403, {});
      if (method === "GET") {
        const json = await deps.store.get(parsed.pk, parsed.doc);
        if (json === null || json === undefined) return send(res, 404, {});
        return send(res, 200, { doc: JSON.parse(json) });
      }
      if ((method === "PUT" || method === "DELETE") && scoped.SCOPES[who.scope].write.has(parsed.kind)) {
        let identity = null;
        if (parsed.kind === "joins") {
          const verdict = await joinIdentity(who, parsed, method);
          if (verdict && verdict.status) return send(res, verdict.status, verdict.body);
          identity = verdict && verdict.user;
        }
        if (method === "PUT") {
          const body = await readJson(req, MAX_BODY);
          if (!validDoc(body.doc)) return send(res, 400, { error: "doc" });
          await deps.store.put(parsed.pk, parsed.doc, JSON.stringify(body.doc));
          if (parsed.kind === "joins") {
            // Always rewritten or cleared, so the email shown is that of whoever wrote the request now.
            const idPk = `channels/${parsed.channel}/joinids`;
            if (identity) {
              const value = {
                v: 1,
                userId: identity.userId,
                email: identity.email,
                name: identity.name,
                at: Date.now(),
              };
              await deps.store.put(idPk, parsed.doc, JSON.stringify(value));
            } else {
              await deps.store.del(idPk, parsed.doc).catch(() => undefined);
            }
          }
        } else {
          await deps.store.del(parsed.pk, parsed.doc);
        }
        await publishNotice(parsed.pk);
        return send(res, 204);
      }
      return send(res, 403, {});
    }
    if (route === "/list" && method === "GET") {
      const parsed = parseKindPath(url.searchParams.get("prefix"));
      if (!inPond(parsed) || isRelayOwned(parsed.kind)) return send(res, 403, {});
      const rows = await deps.store.list(parsed.pk);
      return send(res, 200, { items: rows.map((r) => ({ id: r.doc, doc: JSON.parse(r.json) })) });
    }
    return send(res, 404, {});
  }

  const gone = (pk, doc) => deps.store.del(pk, doc).catch(() => undefined);
  const parseOr = (json) => {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };

  /**
   * Who an account route's caller is. A native app's x-squeak-account token wins when present, and a bad or expired one
   * is nobody (never the cookie then). Only routes that pass allowToken accept it: a token mints neither tokens nor tickets.
   */
  async function accountUser(req, allowToken) {
    const given = req.headers["x-squeak-account"];
    if (allowToken && given !== undefined) {
      const t = scoped.verifyAppToken(deps.key, Array.isArray(given) ? "" : given, Date.now());
      return t ? { userId: t.userId, email: t.email, name: "" } : null;
    }
    return whoIsThis();
  }

  /** Routes a signed-in account reaches by Hosted login's cookie. Each answer is no-store; nobody signed in is a bare 401. */
  async function handleAccountCookie(req, res, url, route, method) {
    const user = await accountUser(req, route !== "/account/link-ticket" && route !== "/account/app-token");
    if (!user) return send(res, 401, undefined, NO_STORE);
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (route === "/account/macs/provision") {
      if (method !== "POST") return out(405, {});
      const body = await readJson(req, 1024);
      const r = await tenants.provision(user, body);
      // A provisioned Mac has no sign-in ticket, so the link rows are written here.
      if (r.status === 200 && CHANNEL.test(r.body.macId)) await linkMac(user, r.body.macId, body.name);
      return out(r.status, r.body);
    }
    if (route.startsWith("/account/macs/")) {
      if (method !== "DELETE") return out(405, {});
      const status = await tenants.revoke(user, route.slice("/account/macs/".length));
      if (status === 204) {
        const id = route.slice("/account/macs/".length);
        const link = parseOr(await deps.store.get("maclinks", id));
        if (CHANNEL.test(id) && link && link.userId === user.userId) await unlinkMac(id);
        return send(res, 204, undefined, NO_STORE);
      }
      return out(status, {});
    }
    if (route === "/account/avatar") return handleAvatar(req, res, user, method, out);
    if (route === "/account/app-token") {
      if (method !== "POST") return out(405, {});
      const issued = scoped.issueAppToken(deps.key, user.userId, user.email, Date.now(), APP_TOKEN_TTL_MS);
      if (!issued) return out(400, { error: "user" });
      return out(200, { token: issued.token, expiresAt: issued.expiresAt, email: user.email, name: user.name.trim() });
    }
    if (route === "/account/link-ticket") {
      if (method !== "POST") return out(405, {});
      const issued = scoped.issueTicket(deps.key, user.userId, user.email, Date.now(), TICKET_TTL_MS);
      if (!issued) return out(400, { error: "user" });
      return out(200, issued);
    }
    if (route === "/account/macs") {
      if (method !== "GET") return out(405, {});
      const rows = await deps.store.list(`accounts/${user.userId}`);
      const macs = [];
      for (const r of rows) {
        const link = parseOr(await deps.store.get("maclinks", r.doc));
        if (!link || link.userId !== user.userId) continue;
        const d = parseOr(r.json);
        if (d) macs.push({ macId: r.doc, name: d.name, linkedAt: d.linkedAt });
      }
      return out(200, { macs });
    }
    // /account/device-request
    if (method === "POST") {
      const body = await readJson(req, 4096);
      if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return out(400, { error: "mac" });
      if (typeof body.name !== "string") return out(400, { error: "name" });
      // Standard base64 (older cached web pages) or base64url; stored as base64url, the one form every reader takes.
      const keys = {};
      for (const k of ["publicKey", "boxKey"]) {
        if (typeof body[k] !== "string" || !B64_ANY_200.test(body[k])) return out(400, { error: "key" });
        keys[k] = body[k].replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
        if (!B64URL_200.test(keys[k])) return out(400, { error: "key" });
      }
      const link = parseOr(await deps.store.get("maclinks", body.macId));
      if (!link || link.userId !== user.userId) return out(403, { error: "mac" });
      const pk = `channels/${body.macId}/devreqs`;
      const now = Date.now();
      let open = 0;
      for (const r of await deps.store.list(pk)) {
        const d = parseOr(r.json);
        if (!d || typeof d.at !== "number" || d.at + REQUEST_TTL_MS <= now) await gone(pk, r.doc);
        else if (d.userId === user.userId) open++;
      }
      if (open >= MAX_OPEN_REQUESTS) return out(429, { error: "busy" });
      const reqId = crypto.randomBytes(18).toString("base64url");
      const value = {
        v: 1,
        reqId,
        userId: user.userId,
        email: user.email,
        name: body.name.trim().slice(0, 100),
        publicKey: keys.publicKey,
        boxKey: keys.boxKey,
        at: now,
      };
      await deps.store.put(pk, reqId, JSON.stringify(value));
      await publishNotice(pk);
      return out(200, { reqId, expiresAt: now + REQUEST_TTL_MS });
    }
    if (method === "GET") {
      const macId = url.searchParams.get("macId");
      const id = url.searchParams.get("id");
      if (typeof macId !== "string" || !CHANNEL.test(macId) || typeof id !== "string" || !DOC.test(id))
        return out(400, { error: "ids" });
      const reqPk = `channels/${macId}/devreqs`;
      const resPk = `channels/${macId}/devresults`;
      const request = parseOr(await deps.store.get(reqPk, id));
      if (!request) return out(410, { error: "gone" });
      if (request.userId !== user.userId) return out(403, { error: "user" });
      const raw = await deps.store.get(resPk, id);
      if (raw !== null && raw !== undefined) {
        const result = parseOr(raw);
        await gone(resPk, id);
        await gone(reqPk, id);
        return out(200, { result });
      }
      if (typeof request.at !== "number" || request.at + REQUEST_TTL_MS <= Date.now()) {
        await gone(reqPk, id);
        return out(410, { error: "gone" });
      }
      return out(202, {});
    }
    return out(405, {});
  }

  // ---- "Use my Zoho photo": the person's own photo, read once with a one-time consent (never stored token) ----
  const zohoState = (userId, nonce, exp) =>
    crypto
      .createHmac("sha256", String(deps.key))
      .update(`squeak-zoho-photo\n${userId}\n${nonce}\n${exp}`)
      .digest("base64url");
  const zohoBack = (res, result) =>
    send(res, 302, undefined, { Location: `${ZOHO_APP_PATH}#zoho-photo=${result}`, ...NO_STORE });
  /** A Zoho accounts origin (https only, a known data-centre host) or null. */
  const zohoOrigin = (value) => {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:" && !u.port && !u.username && ZOHO_ACCOUNTS.test(u.hostname) ? u.origin : null;
    } catch {
      return null;
    }
  };
  const imageType = (b) => {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return "image/png";
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
    if (
      b.length >= 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP"
    )
      return "image/webp";
    return null;
  };
  const zohoFetch = (url, init) =>
    (deps.fetch || globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(ZOHO_FETCH_MS) });
  const redirectUriFor = (req) => {
    if (deps.zoho.redirectUri) return deps.zoho.redirectUri;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `https://${String(host).split(",")[0].trim()}/server/squeak_relay/account/zoho-photo/callback`;
  };

  /** /account/zoho-photo/start, /callback and the hand-over GET /account/zoho-photo: cookie only (no token, key or pond token). */
  async function handleZohoPhoto(req, res, url, route, method) {
    if (req.headers["x-squeak-relay"] !== undefined || req.headers["x-squeak-pond-token"] !== undefined)
      return send(res, 401, undefined, NO_STORE);
    if (method !== "GET") return send(res, 405, {}, NO_STORE);
    const user = await whoIsThis();
    if (!user) return send(res, 401, undefined, NO_STORE);
    if (route === "/account/zoho-photo") {
      const row = parseOr(await deps.store.get(ZOHO_PK, user.userId));
      await gone(ZOHO_PK, user.userId); // once: a read spends it, fresh or stale
      if (!row || typeof row.data !== "string" || typeof row.at !== "number" || row.at + ZOHO_TTL_MS <= Date.now())
        return send(res, 404, {}, NO_STORE);
      const bytes = Buffer.from(row.data, "base64");
      const type = imageType(bytes);
      if (!type) return send(res, 404, {}, NO_STORE);
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      return res.end(bytes);
    }
    const z = deps.zoho;
    if (!z || !z.clientId || !z.clientSecret) return send(res, 503, { error: "unconfigured" }, NO_STORE);
    const home = zohoOrigin(z.accounts) || "https://accounts.zoho.in";
    if (route === "/account/zoho-photo/start") {
      const nonce = crypto.randomBytes(16).toString("base64url");
      const exp = Date.now() + ZOHO_TTL_MS;
      const state = `${user.userId}.${nonce}.${exp}.${zohoState(user.userId, nonce, exp)}`;
      const q = new URLSearchParams({
        scope: ZOHO_SCOPE,
        client_id: z.clientId,
        response_type: "code",
        access_type: "online",
        prompt: "consent",
        redirect_uri: redirectUriFor(req),
        state,
      });
      return send(res, 302, undefined, { Location: `${home}/oauth/v2/auth?${q}`, ...NO_STORE });
    }
    // /account/zoho-photo/callback
    const p = String(url.searchParams.get("state") || "").split(".");
    const [stateUser, nonce, expText, given] = p;
    const exp = Number(expText);
    const want = p.length === 4 && /^\d{1,15}$/.test(expText) ? Buffer.from(zohoState(stateUser, nonce, exp)) : null;
    const have = Buffer.from(String(given || ""));
    if (
      !want ||
      want.length !== have.length ||
      !crypto.timingSafeEqual(want, have) ||
      exp <= Date.now() ||
      stateUser !== user.userId
    )
      return zohoBack(res, "failed");
    if (url.searchParams.get("error"))
      return zohoBack(res, url.searchParams.get("error") === "access_denied" ? "denied" : "blocked");
    const code = url.searchParams.get("code");
    if (!code || code.length > 512) return zohoBack(res, "failed");
    const given_server = url.searchParams.get("accounts-server");
    const accounts = given_server ? zohoOrigin(given_server) : home;
    if (!accounts) return zohoBack(res, "failed");
    try {
      const tokenRes = await zohoFetch(`${accounts}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: z.clientId,
          client_secret: z.clientSecret,
          redirect_uri: redirectUriFor(req),
          code,
        }).toString(),
        redirect: "error",
      });
      const tokenBody = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      const token = tokenBody && typeof tokenBody.access_token === "string" ? tokenBody.access_token : null;
      if (!token) return zohoBack(res, "blocked");
      // Zoho's profile API lives on profile.zoho.<dc> beside accounts.zoho.<dc> (docs: profiles-useractions-readoperations).
      const photoRes = await zohoFetch(
        `${accounts.replace("//accounts.", "//profile.")}/api/v1/user/self/photo?photo_size=medium`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          redirect: "error",
        },
      );
      if (!photoRes.ok) return zohoBack(res, "blocked");
      const declared = Number(photoRes.headers.get("content-length"));
      if (declared > ZOHO_PHOTO_MAX_BYTES) return zohoBack(res, "failed");
      let bytes = Buffer.from(await photoRes.arrayBuffer());
      // Zoho's docs say the photo comes back "Base64 encoded": accept that spelling too, never anything but an image.
      if (!imageType(bytes)) {
        const text = bytes
          .toString("latin1")
          .trim()
          .replace(/^data:[^,]*,/, "");
        if (BASE64.test(text) && text.length >= 8) bytes = Buffer.from(text, "base64");
      }
      if (bytes.length > ZOHO_PHOTO_MAX_BYTES || !imageType(bytes)) return zohoBack(res, "failed");
      await deps.store.put(
        ZOHO_PK,
        user.userId,
        JSON.stringify({ v: 1, at: Date.now(), data: bytes.toString("base64") }),
      );
      return zohoBack(res, "ready");
    } catch {
      log("zoho photo: fetch failed"); // never the code, the token or a body
      return zohoBack(res, "failed");
    }
  }

  const avatarOf = async (userId) => parseOr(await deps.store.get(AVATAR_PK, userId));

  /** The photo's bytes, as the one thing this relay sends that is not JSON. Never cached, never sniffed. */
  function sendAvatar(res, row) {
    const bytes = Buffer.from(row.data, "base64");
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    res.end(bytes);
  }

  /** \`/account/avatar\` for a signed-in account (cookie or token): PUT a JPEG, DELETE it, GET it back. */
  async function handleAvatar(req, res, user, method, out) {
    if (method === "GET") {
      const row = await avatarOf(user.userId);
      if (!row || typeof row.data !== "string") return out(404, {});
      return sendAvatar(res, row);
    }
    if (method === "DELETE") {
      await gone(AVATAR_PK, user.userId);
      return send(res, 204, undefined, NO_STORE);
    }
    if (method !== "PUT") return out(405, {});
    let body;
    try {
      body = await readJson(req, AVATAR_MAX_BODY);
    } catch (e) {
      if (e && e.status === 413) return out(413, { error: "size" });
      throw e;
    }
    if (!body || typeof body.data !== "string" || typeof body.type !== "string") return out(400, { error: "image" });
    if (body.data.length > AVATAR_MAX_BODY || Math.floor((body.data.length * 3) / 4) > AVATAR_MAX_BYTES + 3)
      return out(413, { error: "size" });
    if (!BASE64.test(body.data)) return out(400, { error: "image" });
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length > AVATAR_MAX_BYTES) return out(413, { error: "size" });
    if (body.type !== "image/jpeg" || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      return out(400, { error: "image" });
    const now = Date.now();
    const rate = parseOr(await deps.store.get(AVATAR_RATE_PK, user.userId));
    const fresh = !rate || typeof rate.since !== "number" || rate.since + HOUR_MS <= now;
    const used = fresh ? 0 : Number(rate.n) || 0;
    if (used >= AVATAR_WRITES_PER_HOUR) return out(429, { error: "busy" });
    await deps.store.put(AVATAR_RATE_PK, user.userId, JSON.stringify({ since: fresh ? now : rate.since, n: used + 1 }));
    await deps.store.put(
      AVATAR_PK,
      user.userId,
      JSON.stringify({ v: 1, type: "image/jpeg", data: body.data, at: now }),
    );
    return out(200, { at: now });
  }

  /** The Mac reads a linked user's photo with the relay key: GET /account/avatar?userId=. */
  async function handleAvatarMac(res, url, method, mac) {
    if (method !== "GET") return send(res, 405, {});
    const id = url.searchParams.get("userId");
    if (typeof id !== "string" || !USER_ID.test(id)) return send(res, 400, { error: "user" }, NO_STORE);
    if (mac && id !== mac.userId) return send(res, 403, {}, NO_STORE);
    const row = await avatarOf(id);
    if (!row || typeof row.data !== "string") return send(res, 404, {}, NO_STORE);
    return sendAvatar(res, row);
  }

  /** Records that `user` owns this Mac (what /account/link writes): "Your Macs" and device requests read these rows. Idempotent. */
  async function linkMac(user, macId, name) {
    const old = parseOr(await deps.store.get("maclinks", macId));
    if (old && old.userId !== user.userId && USER_ID.test(String(old.userId)))
      await gone(`accounts/${old.userId}`, macId);
    const had = parseOr(await deps.store.get(`accounts/${user.userId}`, macId));
    const label = typeof name === "string" ? name.trim().slice(0, 100) : (had && had.name) || "";
    await deps.store.put(
      `accounts/${user.userId}`,
      macId,
      JSON.stringify({ macId, name: label, linkedAt: (had && had.linkedAt) || Date.now() }),
    );
    await deps.store.put("maclinks", macId, JSON.stringify({ userId: user.userId, email: user.email }));
  }

  /** Drops a Mac's link and pending device requests (what /account/unlink does). */
  async function unlinkMac(macId) {
    const link = parseOr(await deps.store.get("maclinks", macId));
    if (link && USER_ID.test(String(link.userId))) await gone(`accounts/${link.userId}`, macId);
    await gone("maclinks", macId);
    for (const kind of ["devreqs", "devresults"]) {
      const pk = `channels/${macId}/${kind}`;
      for (const r of await deps.store.list(pk)) await gone(pk, r.doc);
    }
  }

  /** The Mac's side of an account link (relay key): confirm a ticket, or drop a link. */
  async function handleAccountMac(req, res, route, method, mac) {
    if (method !== "POST") return send(res, 405, {});
    const body = await readJson(req, 4096);
    if (route === "/account/link") {
      const t = scoped.verifyTicket(deps.key, body.ticket, Date.now());
      if (!t) return send(res, 400, { error: "ticket" });
      if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return send(res, 400, { error: "mac" });
      if (mac && (body.macId !== mac.macId || t.userId !== mac.userId)) return send(res, 403, {});
      if (typeof body.name !== "string") return send(res, 400, { error: "name" });
      await linkMac({ userId: t.userId, email: t.email }, body.macId, body.name);
      return send(res, 200, { userId: t.userId, email: t.email });
    }
    // /account/unlink
    if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return send(res, 400, { error: "mac" });
    if (mac && body.macId !== mac.macId) return send(res, 403, {});
    await unlinkMac(body.macId);
    return send(res, 204);
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", "http://relay");
      const route = url.pathname.replace(PREFIX, "") || "/";
      const method = req.method || "GET";
      if (route === "/me") {
        if (method !== "GET") return send(res, 405, {});
        const user = await accountUser(req, true);
        if (!user) return send(res, 401, undefined);
        const photo = await avatarOf(user.userId).catch(() => null);
        const avatarAt = photo && typeof photo.at === "number" && typeof photo.data === "string" ? photo.at : undefined;
        return send(
          res,
          200,
          { userId: user.userId, email: user.email, name: user.name.trim(), ...(avatarAt ? { avatarAt } : {}) },
          NO_STORE,
        );
      }
      // The Zoho photo routes belong to the signed-in account (cookie): never a Mac key, never the relay key.
      if (
        route === "/account/zoho-photo" ||
        route === "/account/zoho-photo/start" ||
        route === "/account/zoho-photo/callback"
      )
        return await handleZohoPhoto(req, res, url, route, method);
      const relayGiven = req.headers["x-squeak-relay"];
      let macGiven = req.headers[MAC_HEADER];
      // Phones, the voice add-on and the daemon send a grant's key as x-squeak-relay: anything that is not the operator's
      // key (compared first, constant time) is looked up as a Mac key.
      if (macGiven === undefined && relayGiven !== undefined && !sameKey(relayGiven, deps.key)) macGiven = relayGiven;
      else if (macGiven !== undefined && relayGiven !== undefined) return send(res, 401);
      let mac = null;
      if (macGiven !== undefined && route !== "/account/macs/provision") {
        // A per-Mac key (tenants.js); it counts against its account's day.
        mac = await tenants.authenticate(Array.isArray(macGiven) ? "" : macGiven);
        if (!mac) return send(res, 401);
        if (!(await tenants.chargeRequest(mac))) return send(res, 429, { error: "quota" });
      }
      const forbidden = () => send(res, 403, {});
      if (route === "/account/avatar") {
        const keyGiven = req.headers["x-squeak-relay"];
        if (mac) return await handleAvatarMac(res, url, method, mac);
        if (keyGiven !== undefined) {
          if (!sameKey(keyGiven, deps.key)) return send(res, 401);
          return await handleAvatarMac(res, url, method);
        }
        // a pond token is never an account
        if (req.headers["x-squeak-pond-token"] !== undefined) return send(res, 401);
        return await handleAccountCookie(req, res, url, route, method);
      }
      if (
        route === "/account/link-ticket" ||
        route === "/account/app-token" ||
        route === "/account/macs" ||
        route === "/account/macs/provision" ||
        route.startsWith("/account/macs/") ||
        route === "/account/device-request"
      )
        return await handleAccountCookie(req, res, url, route, method);
      const given = req.headers["x-squeak-pond-token"];
      if (!mac && given !== undefined && !req.headers["x-squeak-relay"])
        return await handleGuest(req, res, url, route, method, given);
      if (!mac && !sameKey(req.headers["x-squeak-relay"], deps.key)) return send(res, 401);

      if (route === "/account/link" || route === "/account/unlink")
        return await handleAccountMac(req, res, route, method, mac);

      if (route === "/pond-token" || route === "/pond-revoke") {
        if (method !== "POST") return send(res, 405, {});
        const body = await readJson(req, 1024);
        if (typeof body.pondId !== "string" || typeof body.memberId !== "string")
          return send(res, 400, { error: "ids" });
        if (mac && !(await tenants.channelAllowed(mac, body.pondId))) return forbidden();
        if (route === "/pond-revoke") {
          if (!scoped.POND.test(body.pondId) || !scoped.MEMBER.test(body.memberId))
            return send(res, 400, { error: "ids" });
          await deps.store.put(`revoked/${body.pondId}`, body.memberId, JSON.stringify({ at: Date.now() }));
          return send(res, 204);
        }
        const issued = scoped.issue(
          deps.key,
          body.pondId,
          body.memberId,
          Date.now(),
          body.ttlSec,
          body.scope === undefined ? "guest" : body.scope,
        );
        if (!issued) return send(res, 400, { error: "ids" });
        if (body.email !== undefined) {
          const email = typeof body.email === "string" ? normEmail(body.email) : "";
          if (body.scope !== "join" || !EMAIL.test(email)) return send(res, 400, { error: "email" });
          await deps.store.put(`pins/${body.pondId}`, body.memberId, JSON.stringify({ email }));
        }
        // A new token for a member lifts an earlier revocation (a removed guest who is invited again).
        await deps.store.del(`revoked/${body.pondId}`, body.memberId);
        if (deps.streams.pondChannelId) await deps.streams.pondChannelId(body.pondId, true).catch(() => null);
        return send(res, 200, issued);
      }

      if (route === "/ping") {
        if (method !== "GET") return send(res, 405, {});
        const store = (await deps.store.ready().catch(() => false)) ? "ready" : "missing";
        const channelId = await deps.streams.channelId().catch(() => null);
        return send(res, 200, {
          ok: true,
          store,
          channel: channelId ? "ready" : "missing",
          // the shared stream's id is the operator's business, not a tenant's
          ...(channelId && !mac ? { channelId } : {}),
          version: VERSION,
        });
      }

      if (route === "/token") {
        if (method !== "POST") return send(res, 405, {});
        const body = await readJson(req, 1024);
        if (typeof body.name !== "string" || !NAME.test(body.name)) return send(res, 400, { error: "name" });
        const channelId = await deps.streams.channelId();
        if (!channelId) return send(res, 503, { error: "channel" });
        const pair = await deps.streams.token(channelId, body.name);
        return send(res, 200, { url: pair.url, key: pair.key, wssId: pair["wss-id"] });
      }

      if (route === "/doc") {
        const parsed = parseDocPath(url.searchParams.get("path"));
        if (!parsed) return send(res, 400, { error: "path" });
        if (mac && !(await tenants.channelAllowed(mac, parsed.channel))) return forbidden();
        if (method === "GET") {
          const json = await deps.store.get(parsed.pk, parsed.doc);
          if (json === null || json === undefined) return send(res, 404, {});
          return send(res, 200, { doc: JSON.parse(json) });
        }
        if (method === "PUT") {
          if (NO_KEY_PUT.has(parsed.kind)) return send(res, 403, {});
          const body = await readJson(req, MAX_BODY);
          // A Mac's answer to a device request is a sealed box or a bare refusal `{denied: true}`.
          const deniedAnswer =
            parsed.kind === "devresults" && body.doc && Object.keys(body.doc).length === 1 && body.doc.denied === true;
          if (!deniedAnswer && !validDoc(body.doc)) return send(res, 400, { error: "doc" });
          const stored = JSON.stringify(body.doc);
          if (mac && !(await tenants.chargeBytes(mac, Buffer.byteLength(stored))))
            return send(res, 429, { error: "quota" });
          await deps.store.put(parsed.pk, parsed.doc, stored);
          await publishNotice(parsed.pk);
          return send(res, 204);
        }
        if (method === "DELETE") {
          await deps.store.del(parsed.pk, parsed.doc);
          await publishNotice(parsed.pk);
          return send(res, 204);
        }
        return send(res, 405, {});
      }

      if (route === "/list") {
        if (method !== "GET") return send(res, 405, {});
        const parsed = parseKindPath(url.searchParams.get("prefix"));
        if (!parsed) return send(res, 400, { error: "prefix" });
        if (mac && !(await tenants.channelAllowed(mac, parsed.channel))) return forbidden();
        const rows = await deps.store.list(parsed.pk);
        return send(res, 200, { items: rows.map((r) => ({ id: r.doc, doc: JSON.parse(r.json) })) });
      }

      return send(res, 404, {});
    } catch (e) {
      const status = e && e.status === 413 ? 413 : e && e.status === 400 ? 400 : 500;
      log("request failed");
      return send(res, status, { error: status === 500 ? "server" : status === 413 ? "too large" : "bad request" });
    }
  };
}

module.exports = { createRelay, sameKey, VERSION };
