// AppSail entry for the relay. The behaviour is the SAME handler the Catalyst function runs (functions/squeak_relay):
// this file only turns a Node http server into the (req, res) call the function receives, and answers /health.
// In production `handle` is the staged function entry (index.js, unchanged: it wires @zcatalyst/* from the request's x-zc-*
// headers, which AppSail's gateway sends too); tests pass `createRelay(fakes)` instead. No relay rule lives here.
const http = require("node:http");

/** A server whose every request goes to `handle(req, res)`; /health is answered here so the platform probe never needs a key. */
function createServer({ handle, log = (s) => console.error(s) }) {
  return http.createServer((req, res) => {
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

function main() {
  // The staged function entry sits beside this file (appsail/build.sh copies it); same module the function deploys.
  const handle = require("./index.js");
  const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT) || 9000;
  const server = createServer({ handle });
  // SSE-free relay: requests are short; keep sockets from lingering past the platform's 30 s request limit.
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, () => console.error(`squeak relay (appsail) on ${port}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = { createServer };
if (require.main === module) main();
