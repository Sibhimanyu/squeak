// The relay's request handling, with every Catalyst service passed in (`deps`), so tests run it with fakes and the
// deployed function (index.js) wires the real SDK. Contract: docs/cloud-layer.md, "Catalyst: how the five operations map".
//
//   GET    /doc?path=            -> 200 {doc} | 404
//   PUT    /doc?path=  {doc}     -> 204 (then a change notice {p:"channels/<id>/<kind>"})
//   DELETE /doc?path=            -> 204 (then the notice)
//   GET    /list?prefix=         -> 200 {items:[{id,doc}]}
//   GET    /ping                 -> 200 {ok, store, channel, channelId?, version}
//   POST   /token    {name}      -> 200 {url, key, wssId}
//
// Every request needs header x-squeak-relay equal to RELAY_KEY (constant-time compare); anything else is a bare 401.
const crypto = require("node:crypto");
const { MAX_BODY, NAME, parseDocPath, parseKindPath, validDoc } = require("./rules");

const VERSION = require("./package.json").version;
const PREFIX = /^\/server\/squeak_relay/;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
/** Constant-time equality of two secrets (both hashed first, so lengths do not leak). */
const sameKey = (given, expected) =>
  typeof expected === "string" &&
  expected.length > 0 &&
  typeof given === "string" &&
  crypto.timingSafeEqual(digest(given), digest(expected));

const send = (res, status, body) => {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
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
 *   log?: (sentence) => void,
 * }
 */
function createRelay(deps) {
  const log = deps.log || (() => {});

  async function publishNotice(pk) {
    // The write already happened; a failed notice only costs the watchers up to the 60 s safety poll.
    try {
      const channelId = await deps.streams.channelId();
      if (channelId) await deps.streams.publish(channelId, JSON.stringify({ p: pk }));
    } catch {
      log("notice not published");
    }
  }

  return async function handle(req, res) {
    try {
      if (!sameKey(req.headers["x-squeak-relay"], deps.key)) return send(res, 401);
      const url = new URL(req.url || "/", "http://relay");
      const route = url.pathname.replace(PREFIX, "") || "/";
      const method = req.method || "GET";

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
          const body = await readJson(req, MAX_BODY);
          if (!validDoc(body.doc)) return send(res, 400, { error: "doc" });
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
