// AppSail entry for the relay. The behaviour is the SAME handler the Catalyst function runs (functions/squeak_relay):
// this file only turns a Node http server into the (req, res) call the function receives, and answers /health.
// In production `handle` is the staged function entry (index.js, unchanged: it wires @zcatalyst/* from the request's x-zc-*
// headers, which AppSail's gateway sends too); tests pass `createRelay(fakes)` instead. No relay rule lives here.
const http = require("node:http");

/** A server whose every request goes to `handle(req, res)`; /health is answered here so the platform probe never needs a key. */
function createServer({ handle, log = (s) => console.error(s), diag }) {
  return http.createServer((req, res) => {
    // Sign-in TEST only (main() passes diag): /me always answers JSON, with the NAMES (never values) of what arrived.
    if (diag && req.method === "GET" && /^\/me(\?|$)/.test(req.url)) {
      meWithDiagnostics(req, res, handle, diag, log);
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/_health")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"status":"ok"}');
      return;
    }
    Promise.resolve(handle(req, res)).catch((e) => {
      log(`relay: unhandled ${(e && e.message) || e}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

/** Header names that can carry a session or a Catalyst identity; cookie names only. */
const AUTHISH = /^(x-zc-|x-zcsrf|authorization|cookie$|x-forwarded|x-catalyst|origin$|host$|referer$)/i;
function meWithDiagnostics(req, res, handle, diag, log) {
  const chunks = [];
  const w = res.write.bind(res), e = res.end.bind(res), wh = res.writeHead.bind(res);
  let status = 200;
  res.writeHead = (code) => { status = code; return res; };
  res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
  res.end = async (c) => {
    if (c) chunks.push(Buffer.from(c));
    const text = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const d = {
      headerNames: Object.keys(req.headers).filter((k) => AUTHISH.test(k)).sort(),
      cookieNames: String(req.headers.cookie || "").split(";").map((x) => x.split("=")[0].trim()).filter(Boolean).sort(),
    };
    try { d.sdk = await diag(req); } catch (err) { d.sdk = { threw: String((err && err.message) || err).slice(0, 200) }; }
    log(`me-diag status ${status} ${JSON.stringify(d)}`);
    const out = Buffer.from(JSON.stringify(status === 200 && body ? { ...body, diag: d } : { error: "signin", status, diag: d }));
    wh(status === 200 ? 200 : status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": out.length });
    e(out);
  };
  Promise.resolve(handle(req, res)).catch((err) => { log(`relay: unhandled ${(err && err.message) || err}`); if (!res.headersSent) res.writeHead(500); res.end(); });
}

/** What the SDK and the REST lookup say about this request's user (non-secret values, shapes and messages only). */
async function sdkDiag(req) {
  const { zcAuth, UserManagement } = require("@zcatalyst/auth");
  const out = {
    userType: String(req.headers["x-zc-user-type"] || "").slice(0, 20),
    userCredType: String(req.headers["x-zc-user-cred-type"] || "").slice(0, 20),
    userTokenPresent: !!req.headers["x-zc-user-cred-token"],
    userTokenEmpty: req.headers["x-zc-user-cred-token"] === "",
    userIdPresent: !!req.headers["x-zc-user-id"],
  };
  const shape = (o) => (o && typeof o === "object" ? Object.keys(o).slice(0, 12).join(",") : String(o));
  // 1. the SDK exactly as the relay uses it (admin-scope app; the user call goes out with user credentials)
  try {
    const app = await zcAuth.init(req);
    const u = await new UserManagement(app).getCurrentUser();
    out.sdk = u ? { keys: shape(u) } : null;
  } catch (e) { out.sdkThrew = String((e && e.message) || e).slice(0, 200); }
  // 2. the browser's own session cookie (validated by Catalyst, not by us) on the project-user call
  const cookie = req.headers.cookie;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const project = req.headers["x-zc-projectid"];
  const csrf = (/(?:^|;\s*)ZD_CSRF_TOKEN=([^;]+)/.exec(cookie || "") || [])[1];
  const tries = {
    plain: { cookie },
    csrf: { cookie, ...(csrf ? { "X-ZCSRF-TOKEN": `zd_csrparam=${csrf}` } : {}) },
  };
  out.rest = {};
  for (const [name, headers] of Object.entries(tries)) {
    try {
      const r = await fetch(`https://${host}/baas/v1/project/${project}/project-user/current`, { headers, redirect: "manual" });
      const t = await r.text();
      let j = null;
      try { j = JSON.parse(t); } catch { j = null; }
      out.rest[name] = { status: r.status, type: String(r.headers.get("content-type") || "").slice(0, 40), keys: shape(j), dataKeys: shape(j && j.data), len: t.length };
    } catch (e) { out.rest[name] = { threw: String((e && e.message) || e).slice(0, 120) }; }
  }
  // 3. the SDK with the cookie handed over as x-zc-cookie in user scope (how the SDK reads a browser session)
  if (cookie) {
    try {
      const app = await zcAuth.init({ headers: { ...req.headers, "x-zc-cookie": cookie, "x-zc-user-type": "user" } }, { scope: "user" });
      const u = await new UserManagement(app).getCurrentUser();
      out.sdkCookie = u ? { keys: shape(u) } : null;
    } catch (e) { out.sdkCookieThrew = String((e && e.message) || e).slice(0, 200); }
  }
  return out;
}

function main() {
  // The staged function entry sits beside this file (appsail/build.sh copies it); same module the function deploys.
  const handle = require("./index.js");
  const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT) || 9000;
  const server = createServer({ handle, diag: process.env.SQUEAK_ME_DIAG === "1" ? sdkDiag : undefined });
  // SSE-free relay: requests are short; keep sockets from lingering past the platform's 30 s request limit.
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, () => console.error(`squeak relay (appsail) on ${port}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = { createServer };
if (require.main === module) main();
