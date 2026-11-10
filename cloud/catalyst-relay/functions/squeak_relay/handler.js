// The relay's request handling, with every Catalyst service passed in (`deps`), so tests run it with fakes and the
// deployed function (index.js) wires the real SDK. Contract: docs/cloud-layer.md, "Catalyst: how the five operations map".
//
//   GET    /doc?path=            -> 200 {doc} | 404
//   PUT    /doc?path=  {doc}     -> 204 (then a change notice {p:"channels/<id>/<kind>"})
//   DELETE /doc?path=            -> 204 (then the notice)
//   GET    /list?prefix=         -> 200 {items:[{id,doc}]}
//   GET    /me                   -> 200 {userId, email, name} (Catalyst Hosted-login user, no relay key) | bare 401
//   POST   /account/link-ticket (cookie) | POST /account/link, /account/unlink (relay key) | GET /account/macs (cookie)
//   POST   /account/app-token (cookie only) -> {token, expiresAt, email, name}; header x-squeak-account: <token> stands in for
//                         the cookie on /me, /account/macs and /account/device-request
//   POST|GET /account/device-request (cookie): see docs/cloud-layer.md, "Accounts"
//   GET    /ping                 -> 200 {ok, store, channel, channelId?, version}
//   POST   /token    {name}      -> 200 {url, key, wssId}
//   POST   /pond-token {pondId, memberId, ttlSec, scope?}  (relay key) -> 200 {token, expiresAt}: a pond-scoped token;
//                      scope "guest" (default), "member" or "join" (an invite's: writes the join request only)
//   POST   /pond-revoke {pondId, memberId}         (relay key) -> 204
//   with header x-squeak-pond-token instead of the relay key: /doc and /list inside that one pond only (guest writes
//   limited to the scope's kinds in scoped.SCOPES), and POST /pond-stream {name} -> that pond's own Data Streams token pair
//
// Every request needs header x-squeak-relay equal to RELAY_KEY (constant-time compare); anything else is a bare 401.
const crypto = require("node:crypto");
const { CHANNEL, DOC, MAX_BODY, NAME, parseDocPath, parseKindPath, validDoc } = require("./rules");
const scoped = require("./scoped");

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
const B64URL_200 = /^[A-Za-z0-9_-]{1,200}$/;
const NO_STORE = { "Cache-Control": "no-store" };
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

  async function publishNotice(pk) {
    // A pond's writes also wake that pond's own stream, the only one a web guest may subscribe to.
    try {
      const pondId = pk.split("/")[1];
      const pondStream = deps.streams.pondChannelId ? await deps.streams.pondChannelId(pondId, false) : null;
      if (pondStream) await deps.streams.publish(pondStream, JSON.stringify({ p: pk }));
    } catch {
      log("pond notice not published");
    }
    // The write already happened; a failed notice only costs the watchers up to the 60 s safety poll.
    try {
      const channelId = await deps.streams.channelId();
      if (channelId) await deps.streams.publish(channelId, JSON.stringify({ p: pk }));
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
      for (const k of ["publicKey", "boxKey"])
        if (typeof body[k] !== "string" || !B64URL_200.test(body[k])) return out(400, { error: "key" });
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
        publicKey: body.publicKey,
        boxKey: body.boxKey,
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

  /** The Mac's side of an account link (relay key): confirm a ticket, or drop a link. */
  async function handleAccountMac(req, res, route, method) {
    if (method !== "POST") return send(res, 405, {});
    const body = await readJson(req, 4096);
    if (route === "/account/link") {
      const t = scoped.verifyTicket(deps.key, body.ticket, Date.now());
      if (!t) return send(res, 400, { error: "ticket" });
      if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return send(res, 400, { error: "mac" });
      if (typeof body.name !== "string") return send(res, 400, { error: "name" });
      const old = parseOr(await deps.store.get("maclinks", body.macId));
      if (old && old.userId !== t.userId && USER_ID.test(String(old.userId)))
        await gone(`accounts/${old.userId}`, body.macId);
      const now = Date.now();
      await deps.store.put(
        `accounts/${t.userId}`,
        body.macId,
        JSON.stringify({ macId: body.macId, name: body.name.trim().slice(0, 100), linkedAt: now }),
      );
      await deps.store.put("maclinks", body.macId, JSON.stringify({ userId: t.userId, email: t.email }));
      return send(res, 200, { userId: t.userId, email: t.email });
    }
    // /account/unlink
    if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return send(res, 400, { error: "mac" });
    const link = parseOr(await deps.store.get("maclinks", body.macId));
    if (link && USER_ID.test(String(link.userId))) await gone(`accounts/${link.userId}`, body.macId);
    await gone("maclinks", body.macId);
    for (const kind of ["devreqs", "devresults"]) {
      const pk = `channels/${body.macId}/${kind}`;
      for (const r of await deps.store.list(pk)) await gone(pk, r.doc);
    }
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
        return send(res, 200, { userId: user.userId, email: user.email, name: user.name.trim() }, NO_STORE);
      }
      if (
        route === "/account/link-ticket" ||
        route === "/account/app-token" ||
        route === "/account/macs" ||
        route === "/account/device-request"
      )
        return await handleAccountCookie(req, res, url, route, method);
      const given = req.headers["x-squeak-pond-token"];
      if (given !== undefined && !req.headers["x-squeak-relay"])
        return await handleGuest(req, res, url, route, method, given);
      if (!sameKey(req.headers["x-squeak-relay"], deps.key)) return send(res, 401);

      if (route === "/account/link" || route === "/account/unlink")
        return await handleAccountMac(req, res, route, method);

      if (route === "/pond-token" || route === "/pond-revoke") {
        if (method !== "POST") return send(res, 405, {});
        const body = await readJson(req, 1024);
        if (typeof body.pondId !== "string" || typeof body.memberId !== "string")
          return send(res, 400, { error: "ids" });
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
          ...(channelId ? { channelId } : {}),
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
          await deps.store.put(parsed.pk, parsed.doc, JSON.stringify(body.doc));
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
