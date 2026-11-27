// `squeak-live`: the AppSail service that holds the devices' open streams (docs/cloud-layer.md, "Live notices"). Separate from the
// relay app on purpose: an open stream counts toward the platform's 100 concurrent requests per instance, so streams must not
// share that budget with ordinary calls, and a relay redeploy must not drop every device (docs/cloud-spike-2026-11.md).
//
//   GET  /live?pond=<id>[&pond=<id>...]   SSE. Headers: x-squeak-account (account token) or x-squeak-mac-key, x-squeak-device.
//                                         Events: hello {ponds, refused, maxAgeMs}, notice {pond, seq, kind}, typing {pond, user},
//                                         removed {pond}, bye {} (the hub ends the stream at 40 s; the device has opened the next).
//   POST /typing  {pond}                  passed to the Pond's watchers, never stored.
//   GET  /presence?pond=<id>              the Pond's members: online (a renewed stream within a cycle) and last seen.
//   GET  /health
// The behaviour is in hub.js; this file only speaks HTTP and proves who is calling.
const http = require("node:http");
// Staged beside this file in the bundle (live/build.sh); in the repo it is the relay's own module.
const { createClientGate, UPDATE_MESSAGE } = (() => {
  try {
    return require("./client-gate");
  } catch {
    return require("../functions/squeak_relay/client-gate");
  }
})();

const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const NO_STORE = { "Cache-Control": "no-store" };

/** Who is calling: { userId } for an account token or a Mac key, else null. `scoped` and `tenants` are the relay's own modules. */
function createAuth({ key, scoped, tenants, now = Date.now }) {
  return async function auth(req) {
    const account = req.headers["x-squeak-account"];
    if (typeof account === "string") {
      const t = scoped.verifyAppToken(key, account, now());
      return t ? { userId: t.userId } : null;
    }
    const mac = req.headers["x-squeak-mac-key"];
    if (typeof mac === "string") {
      const m = await tenants.authenticate(mac);
      return m ? { userId: m.userId } : null;
    }
    return null;
  };
}

function createLiveServer({ hub, auth, people, lastSeen, minMacVersion, log = (s) => console.error(s) }) {
  const oldMac = createClientGate(minMacVersion);
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", ...NO_STORE });
    res.end(JSON.stringify(body));
  };

  async function live(req, res, url) {
    const who = await auth(req);
    if (!who) return json(res, 401, { error: "signin" });
    const device = req.headers["x-squeak-device"];
    if (typeof device !== "string" || !DEVICE.test(device)) return json(res, 400, { error: "device" });
    const ponds = url.searchParams
      .getAll("pond")
      .flatMap((p) => p.split(","))
      .filter(Boolean);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    const write = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : ": hb\n\n");
    };
    let conn = null;
    let gone = false;
    req.on("close", () => {
      gone = true;
      if (conn) hub.finish(conn, false);
    });
    conn = await hub.open({
      userId: who.userId,
      deviceId: device,
      ponds,
      send: write,
      end: () => res.end(),
    });
    if (gone) hub.finish(conn, false);
  }

  async function typing(req, res) {
    const who = await auth(req);
    if (!who) return json(res, 401, { error: "signin" });
    let text = "";
    for await (const c of req) {
      text += c;
      if (text.length > 1024) return json(res, 413, {});
    }
    let body;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      return json(res, 400, { error: "body" });
    }
    if (typeof body.pond !== "string") return json(res, 400, { error: "pond" });
    return json(res, (await hub.typing(who.userId, body.pond)) ? 204 : 403, {});
  }

  async function presence(req, res, url) {
    const who = await auth(req);
    if (!who) return json(res, 401, { error: "signin" });
    const pond = url.searchParams.get("pond") || "";
    if (!(await people.isMember(pond, who.userId))) return json(res, 403, {});
    const out = [];
    for (const m of await people.membersOf(pond)) {
      const p = hub.presenceOf(m.userId);
      out.push({
        userId: m.userId,
        online: p.online,
        lastSeen: p.online ? null : ((await lastSeen.read(m.userId)) ?? null),
      });
    }
    return json(res, 200, { members: out });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://live");
    const route = url.pathname.replace(/\/+$/, "") || "/";
    let run;
    if (oldMac(req, route, url)) return json(res, 426, { error: "update-required", message: UPDATE_MESSAGE });
    if (req.method === "GET" && (route === "/health" || route === "/_health")) {
      return json(res, 200, { status: "ok", ...hub.stats() });
    }
    if (req.method === "GET" && route === "/live") run = live(req, res, url);
    else if (req.method === "POST" && route === "/typing") run = typing(req, res);
    else if (req.method === "GET" && route === "/presence") run = presence(req, res, url);
    else return json(res, 404, {});
    run.catch((e) => {
      log(`live: unhandled ${(e && e.message) || e}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // Streams live for tens of seconds; the platform's own cut is the limit, not Node's request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

function main() {
  // The relay's own modules are staged beside this file (live/build.sh): one copy of the rules.
  const scoped = require("./scoped");
  const { createTenants } = require("./tenants");
  const { zcAuth } = require("@zcatalyst/auth");
  const wiring = require("./index.js");
  const { adminAppOf } = require("./app-access");
  const { createDataStreamsFanout } = require("./fanout");
  const { createHub } = require("./hub");
  const key = process.env.RELAY_KEY;
  const relay = process.env.SQUEAK_RELAY_URL; // the relay's base URL: it mints the Data Streams token and publishes (it owns the SDK grant)
  const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT) || 9000;
  const post = async (path, body) => {
    const r = await fetch(`${relay}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-relay": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`relay ${path} ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  // The AppSail gateway sends the project's x-zc-* headers with each request, not at boot (zcAuth.init with none throws, and
  // getDefaultCredentials needs a self-client token this service does not have). So the project-scoped app is taken from the
  // latest request's headers, before that request is handled, and the store and people tables read it at the moment of use.
  let current = null;
  const getApp = () => {
    if (!current) throw new Error("no Catalyst credentials yet: no request has arrived");
    return current;
  };
  const store = wiring.storeFor(getApp);
  const people = wiring.peopleFor(getApp, { removalNotice: false });
  const tenants = createTenants({ store });
  const lastSeen = {
    write: (userId, at) => store.put("lastseen", userId, JSON.stringify({ at })),
    read: async (userId) => {
      const j = await store.get("lastseen", userId);
      return j ? JSON.parse(j).at : null;
    },
  };
  const fanout = createDataStreamsFanout({
    token: () => post("/live/token", { name: `live-${process.pid}-${Date.now()}` }),
    publish: (text) => post("/live/publish", { text }),
    log: (s) => console.error(s),
  });
  const hub = createHub({ people, fanout, lastSeen, log: (s) => console.error(s) });
  hub.start();
  const server = createLiveServer({
    hub,
    auth: createAuth({ key, scoped, tenants }),
    people,
    lastSeen,
    minMacVersion: process.env.SQUEAK_MIN_MAC_VERSION,
  });
  // Take the project app from this request's headers before the handler runs (the first request must not race the init).
  const handler = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    try {
      current = await adminAppOf(zcAuth, req);
    } catch (e) {
      console.error(`live: no project credentials on this request (${(e && e.code) || (e && e.message) || e})`);
    }
    handler(req, res);
  });
  server.listen(port, () => console.error(`squeak live on ${port}`));
  process.on("SIGTERM", () => {
    hub.stop();
    server.close(() => process.exit(0));
  });
}

module.exports = { createLiveServer, createAuth };
if (require.main === module) main();
