// AppSail entry for the relay: THE relay server (#118). Every relay route is answered here, in this process, by the same
// handler the Catalyst function still runs during the dual-run (functions/squeak_relay/handler.js, the shared core).
// This file is transport only: it hosts the handler, answers /health, and adds CORS for the web app's account routes
// (the one thing a browser on another origin needs). No relay rule lives here.
// In production `handle` is the staged function entry (index.js: it wires @zcatalyst/* from the request's x-zc-* headers,
// which AppSail's gateway sends too); tests pass `createRelay(fakes)` instead.
const http = require("node:http");

/**
 * TEMPORARY bridge, off unless `accountUrl` is set (SQUEAK_ACCOUNT_URL): the function stays the only place that can mint
 * live-update tokens until `squeak-live` (#121) replaces them. Delete this with the function (docs/cloud-cutover.md).
 * Live-update tokens. A Custom Logic Data Streams channel issues token pairs only to its own access-control function
 * (squeak_relay), so AppSail cannot mint them itself (verified live: 500). These two routes are passed through to the
 * function with the caller's own credential header, unchanged; every other route stays here. Only a (re)connect pays it.
 */
const TOKEN_ROUTES = new Set(["/token", "/pond-stream"]);
const FORWARD_HEADERS = [
  "content-type",
  "x-squeak-relay",
  "x-squeak-mac-key",
  "x-squeak-pond-token",
  "x-squeak-join-attest",
];
const TOKEN_BODY_MAX = 4096;

function routeOf(req) {
  return (new URL(req.url || "/", "http://relay").pathname.replace(PREFIX, "") || "/").replace(/\/+$/, "") || "/";
}

async function forwardToken(req, res, accountUrl, fetchImpl) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > TOKEN_BODY_MAX) {
      res.writeHead(413, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    chunks.push(c);
  }
  const headers = {};
  for (const h of FORWARD_HEADERS) if (typeof req.headers[h] === "string") headers[h] = req.headers[h];
  const r = await fetchImpl(`${accountUrl}${routeOf(req)}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    signal: AbortSignal.timeout(20_000),
  });
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, {
    "Content-Type": r.headers.get("content-type") || "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** A server whose every request goes to `handle(req, res)`; /health is answered here so the platform probe never needs a key. */
function createServer({
  handle,
  log = (s) => console.error(s),
  noCatalystUsers = false,
  accountUrl,
  fetchImpl = fetch,
  webOrigins = DEFAULT_WEB_ORIGINS,
}) {
  const allowedOrigin = originMatcher(webOrigins);
  return http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/_health")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"status":"ok"}');
      return;
    }
    // CORS: only for the web app's origins, only on its account routes. Control and device routes never get a header.
    const origin = req.headers.origin;
    if (typeof origin === "string" && isAccountCorsRoute(routeOf(req)) && allowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "x-squeak-account, content-type",
          "Access-Control-Max-Age": "600",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
    }
    if (accountUrl && TOKEN_ROUTES.has(routeOf(req))) {
      forwardToken(req, res, accountUrl, fetchImpl).catch((e) => {
        log(`relay: token pass-through failed ${(e && e.message) || e}`);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"error":"token"}');
      });
      return;
    }
    if (noCatalystUsers && needsCatalystUser(req)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          error: "signin-on-account-origin",
          message: "Sign in and account routes are served by Squeak's account origin, not this relay.",
          ...(accountUrl ? { accountUrl } : {}),
        }),
      );
      return;
    }
    Promise.resolve(handle(req, res)).catch((e) => {
      log(`relay: unhandled ${(e && e.message) || e}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

const PREFIX = /^\/server\/squeak_relay/;

/** The web app's home on Catalyst Slate. Preview origins are added by the owner (SQUEAK_WEB_PREVIEW_ORIGINS), never guessed. */
const DEFAULT_WEB_ORIGINS = ["https://squeak.onslate.in"];
/** Exact origins; a `*` stands for one run of letters, digits and dashes inside a host label (never a dot, never the scheme). */
function originMatcher(patterns) {
  const res = patterns.map(
    (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+")}$`),
  );
  return (origin) => res.some((r) => r.test(origin));
}
/**
 * The routes the web app calls from another origin with its account token (x-squeak-account), plus the public invite
 * preview. Everything else (/doc /list /ping /token /pond-* /ponds/short, key-proved device traffic, the cookie routes)
 * is the daemon's or a device's and has no CORS.
 */
const ACCOUNT_CORS_ROUTES = new Set([
  "/me",
  "/invites/preview",
  "/account/macs",
  "/account/device-request",
  "/account/ponds",
  "/account/pond-leaves",
  "/account/pond-devices",
  "/account/avatar",
  "/ponds/short/redeem",
]);
function isAccountCorsRoute(route) {
  if (ACCOUNT_CORS_ROUTES.has(route)) return true;
  return (
    route.startsWith("/account/macs/") && route !== "/account/macs/cliq-token" && route !== "/account/macs/hist-token"
  );
}
/**
 * Routes that need a signed-in Catalyst user (the browser's session cookie). They are served by the function only, where
 * Catalyst can say who the user is; on AppSail the cookie is meaningless and no x-zc-* header is ever trusted for identity.
 *   tokenOnly   a Squeak account token (x-squeak-account, signed by the relay, never a Catalyst session) is the only way in
 *   tokenOrKey  the same, or the relay/Mac key (GET /account/avatar?userId=, PUT/DELETE by a Mac)
 * Everything else (/doc /list /ping /token /pond-* /account/link /account/unlink /account/macs/cliq-token, /account/macs/hist-token, a Cliq PUT) is
 * device traffic: it proves itself with a key, a pond token or a signed token, never with Catalyst identity.
 */
const COOKIE_ONLY = new Set([
  "/account/zoho-photo",
  "/account/zoho-photo/start",
  "/account/zoho-photo/callback",
  "/account/link-ticket",
  "/account/app-token",
  "/account/handoff",
]);
function needsCatalystUser(req) {
  const route = routeOf(req);
  const h = req.headers;
  const token = h["x-squeak-account"] !== undefined;
  const key = h["x-squeak-relay"] !== undefined || h["x-squeak-mac-key"] !== undefined;
  if (COOKIE_ONLY.has(route)) return true;
  if (
    route === "/me" ||
    route === "/account/macs" ||
    route === "/account/macs/provision" ||
    route === "/account/device-request"
  )
    return !token;
  if (route === "/account/macs/cliq-token" || route === "/account/macs/hist-token") return false;
  if (route.startsWith("/account/macs/")) return !token;
  if (route === "/account/avatar") return !token && !key;
  if (route === "/ponds/short/redeem") return !token && !key;
  return false;
}

function main() {
  // The staged function entry sits beside this file (appsail/build.sh copies it); same module the function deploys.
  const handle = require("./index.js");
  const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT) || 9000;
  const origins = [
    ...DEFAULT_WEB_ORIGINS,
    ...String(process.env.SQUEAK_WEB_PREVIEW_ORIGINS || "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.startsWith("https://")),
  ];
  const server = createServer({
    handle,
    // Dual-run: SQUEAK_NO_CATALYST_USER=1 keeps the sign-in routes on the function. At cutover it is unset and this server
    // answers them itself; SQUEAK_ACCOUNT_URL is then only the live-token bridge (see the comment above forwardToken).
    noCatalystUsers: process.env.SQUEAK_NO_CATALYST_USER === "1",
    accountUrl: process.env.SQUEAK_ACCOUNT_URL,
    webOrigins: origins,
  });
  // SSE-free relay: requests are short; keep sockets from lingering past the platform's 30 s request limit.
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, () => console.error(`squeak relay (appsail) on ${port}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = { createServer, needsCatalystUser };
if (require.main === module) main();
