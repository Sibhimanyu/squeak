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

/** What the SDK says about this request's user (names/messages only). */
async function sdkDiag(req) {
  const { zcAuth, UserManagement } = require("@zcatalyst/auth");
  const out = {};
  const app = await zcAuth.init(req);
  try {
    const u = await new UserManagement(app).getCurrentUser();
    out.getCurrentUser = u ? { keys: Object.keys(u).slice(0, 10), hasUserId: !!u.user_id } : null;
  } catch (e) { out.getCurrentUserThrew = String((e && e.message) || e).slice(0, 200); }
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
