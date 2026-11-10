#!/usr/bin/env node
// Screenshots of the owner web app's preview (`?demo=1`) at three sizes, headless. No window opens and no profile of
// yours is touched: it serves web/ on a free local port and runs Chrome (--headless=new, driven over DevTools so the width is exact) with a throwaway profile.
//
//   node scripts/web-shots.mjs [outDir] [--only=chat,needs] [--light]
//
// outDir defaults to .context/web-shots/. Chrome is found at $CHROME, the standard Mac path, or on PATH.
// Files are named <state>-<width>[-light].png.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? null;
const outDir = resolve(args.find((a) => !a.startsWith("--")) ?? join(root, ".context/web-shots"));
const only = flag("only")?.split(",") ?? null;
const light = args.includes("--light");
const welcomeOnly = args.includes("--welcome");

export const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];

/** Named states: the query the preview reads (js/demo-guard.js). A state may name the sizes it is for. */
export const STATES = {
  home: "",
  chat: "open=c-import",
  "chat-inspector": "open=c-import&inspector=1",
  "chat-sheet": "open=c-import&sheet=inspector",
  "needs-you": "pane=needs",
  settings: "pane=settings",
  usage: "pane=usage",
  palette: "palette=1&q=",
  "palette-filtered": "palette=1&q=stripe",
  "chats-page": "sheet=chats",
  // Stage 2, the open chat: the inspector is a column when wide and the drawer or sheet below that.
  "chat-open": "open=c-import",
  "chat-insp": { wide: "open=c-import&inspector=1", narrow: "open=c-import&sheet=inspector" },
  "chat-ask": "open=c-migration",
  "chat-ask-insp": { wide: "open=c-migration&inspector=1", narrow: "open=c-migration&sheet=inspector" },
  "chat-done": "open=c-fx",
  "chat-done-insp": { wide: "open=c-fx&inspector=1", narrow: "open=c-fx&sheet=inspector" },
  // The screens before pairing (js/welcome-view.js); `--welcome` shoots these alone into <outDir>/welcome/.
  "unpaired-signed-out": "welcome=unpaired-signed-out",
  "your-macs-empty": "welcome=your-macs-empty",
  "your-macs-list": "welcome=your-macs-list",
  waiting: "welcome=waiting",
  qr: "welcome=qr",
  "guest-signin": "welcome=guest-signin",
  "guest-waiting": "welcome=guest-waiting",
  "app-signin": "welcome=app-signin",
};
const WELCOME = Object.keys(STATES).filter((n) => STATES[n].startsWith?.("welcome="));

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("No Chrome found: set CHROME=/path/to/chrome");
  return found;
}

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(webRoot, path === "/" ? "index.html" : path);
    if (!file.startsWith(webRoot) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** A tiny Chrome DevTools client: one browser for the whole run, a fresh tab per picture (so the width is exact, which
 * the --screenshot flag cannot do below Chrome's ~500 px minimum window). */
async function launch(chrome, profile) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) throw new Error("Chrome did not start");
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  return { child, port };
}

async function shoot({ port }, url, file, { width, height }, scheme) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("devtools socket"));
  });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg);
    else events.push(msg.method);
  };
  const call = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? fail(new Error(msg.error.message)) : ok(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  try {
    await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 760,
    });
    await call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    await call("Page.navigate", { url });
    for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++)
      await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 700));
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  } finally {
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
  }
}

async function main() {
  const dir = welcomeOnly ? join(outDir, "welcome") : outDir;
  mkdirSync(dir, { recursive: true });
  const chrome = findChrome();
  const server = await serve();
  const profile = mkdtempSync(join(tmpdir(), "squeak-shots-"));
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await launch(chrome, profile);
  const schemes = welcomeOnly ? ["dark", "light"] : light ? ["light"] : ["dark"];
  try {
    for (const scheme of schemes) {
      for (const [name, raw] of Object.entries(STATES)) {
        if (only && !only.includes(name)) continue;
        if (welcomeOnly && !WELCOME.includes(name)) continue;
        for (const size of SIZES) {
          // The phone's pages are the tab bar and sheets; the desktop-only states skip it.
          if (name === "chat-sheet" && size.width >= 1100) continue;
          if (name === "chat-inspector" && size.width < 1100) continue;
          const query = typeof raw === "string" ? raw : size.width >= 1100 ? raw.wide : raw.narrow;
          const file = join(dir, `${name}-${size.width}${scheme === "light" ? "-light" : ""}.png`);
          await shoot(browser, `${base}?demo=1${query ? `&${query}` : ""}`, file, size, scheme);
          console.log(file);
        }
      }
    }
  } finally {
    browser.child.kill("SIGKILL");
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
