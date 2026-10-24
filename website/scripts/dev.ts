// Serves dist/ on 127.0.0.1:55010 and rebuilds when the page's sources change.
//   npm run dev
// Paths work at both / and /squeak/ (the /squeak prefix maps onto dist/).
// Every rebuild runs scripts/build.ts in a fresh child process, so edits to
// src/content.ts are never served from a cached module.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { site } from "./build.ts";
import { containedPath } from "./serve-paths.ts";

const execFileAsync = promisify(execFile);
const HOST = "127.0.0.1";
const PORT = 55010;
const dist = join(site, "dist");
const TSX = join(site, "node_modules/.bin/tsx");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function resolveFile(urlPath: string): Promise<string | null> {
  const target = containedPath(dist, urlPath, "/squeak");
  if (!target) return null;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) return join(target, "index.html");
  return info ? target : null;
}

// Live reload, dev only: pages served here get a tiny script that reloads them after each
// successful rebuild. Nothing of this reaches dist/.
const reloadClients = new Set<import("node:http").ServerResponse>();
const RELOAD_SNIPPET =
  '<script>new EventSource("/__reload").addEventListener("reload",()=>location.reload())</script>';

const server = createServer(async (request, response) => {
  if (request.url === "/__reload") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write(": hi\n\n");
    reloadClients.add(response);
    request.on("close", () => reloadClients.delete(response));
    return;
  }
  const file = await resolveFile(request.url ?? "/");
  if (!file) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  try {
    let body: Buffer | string = await readFile(file);
    if (extname(file) === ".html") body = body.toString("utf8").replace("</body>", `${RELOAD_SNIPPET}</body>`);
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("read failed");
  }
});

// One build at a time; a change during a build queues exactly one more.
let building: Promise<void> | null = null;
let queued = false;
function runBuild(): Promise<void> {
  if (building) {
    queued = true;
    return building;
  }
  building = execFileAsync(TSX, ["scripts/build.ts"], { cwd: site })
    .then(() => {
      for (const client of reloadClients) client.write("event: reload\ndata: 1\n\n");
    })
    .catch((error: { stderr?: string; message: string }) => {
      console.error(`rebuild failed (still serving last good dist/): ${(error.stderr || error.message).trim()}`);
    })
    .finally(() => {
      building = null;
      if (queued) {
        queued = false;
        void runBuild();
      }
    });
  return building;
}

// Only the page's own sources; dist/ and node_modules/ are not watched.
const WATCHED = /^(index\.template\.html|styles\.css|motion\.js|ducks\.js|webgl\.js|scroll-score\.json|release\.json|src[\\/]|assets[\\/])/;
let timer: NodeJS.Timeout | undefined;
watch(site, { recursive: true }, (_event, name) => {
  if (!name || !WATCHED.test(String(name))) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runBuild(), 150);
});

await runBuild();
server.listen(PORT, HOST, () => {
  console.log(`serving http://${HOST}:${PORT}/ (also /squeak/) from dist/`);
});
