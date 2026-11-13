// AppSail entry for the relay. The behaviour is the SAME handler the Catalyst function runs (functions/squeak_relay):
// this file only turns a Node http server into the (req, res) call the function receives, and answers /health.
// In production `handle` is the staged function entry (index.js, unchanged: it wires @zcatalyst/* from the request's x-zc-*
// headers, which AppSail's gateway sends too); tests pass `createRelay(fakes)` instead. No relay rule lives here.
const http = require("node:http");

/** A server whose every request goes to `handle(req, res)`; /health is answered here so the platform probe never needs a key. */
function createServer({ handle, log = (s) => console.error(s), noCatalystUsers = false, accountUrl }) {
  return http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/_health")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"status":"ok"}');
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
/**
 * Routes that need a signed-in Catalyst user (the browser's session cookie). They are served by the function only, where
 * Catalyst can say who the user is; on AppSail the cookie is meaningless and no x-zc-* header is ever trusted for identity.
 *   tokenOnly   a Squeak account token (x-squeak-account, signed by the relay, never a Catalyst session) is the only way in
 *   tokenOrKey  the same, or the relay/Mac key (GET /account/avatar?userId=, PUT/DELETE by a Mac)
 * Everything else (/doc /list /ping /token /pond-* /account/link /account/unlink /account/macs/cliq-token, a Cliq PUT) is
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
  const route =
    (new URL(req.url || "/", "http://relay").pathname.replace(PREFIX, "") || "/").replace(/\/+$/, "") || "/";
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
  if (route === "/account/macs/cliq-token") return false;
  if (route.startsWith("/account/macs/")) return !token;
  if (route === "/account/avatar") return !token && !key;
  if (route === "/ponds/short/redeem") return !token && !key;
  return false;
}

function main() {
  // The staged function entry sits beside this file (appsail/build.sh copies it); same module the function deploys.
  const handle = require("./index.js");
  const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT) || 9000;
  const server = createServer({ handle, noCatalystUsers: true, accountUrl: process.env.SQUEAK_ACCOUNT_URL });
  // SSE-free relay: requests are short; keep sockets from lingering past the platform's 30 s request limit.
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, () => console.error(`squeak relay (appsail) on ${port}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = { createServer, needsCatalystUser };
if (require.main === module) main();
