import http from "node:http";
import type { AddressInfo } from "node:net";

import type { GatewayLogLine } from "./gateway-log-protocol.js";

/**
 * The add-on's page in Home Assistant's sidebar (ingress; docs: .context/claim-flow-contract.md). It answers only the
 * Supervisor's ingress gateway, carries no secret (never a key, channel, database address or PIN, only whether a PIN
 * is set), loads nothing from outside and sets no cookie.
 */

export interface PanelSources {
  version: string;
  paired(): boolean;
  code(): { code: string; expiresAt: number } | null;
  registration(): { registered: boolean; error?: string };
  pin(): "set" | "off" | "none";
  log(): GatewayLogLine[];
}

export interface PanelState {
  version: string;
  paired: boolean;
  code?: string;
  codeExpiresAt?: number;
  sipRegistered: boolean;
  sipError?: string;
  pin: "set" | "off" | "none";
  log: GatewayLogLine[];
}

const ALLOWED = new Set(["172.30.32.2", "::ffff:172.30.32.2", "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function panelState(sources: PanelSources): PanelState {
  const paired = sources.paired();
  const code = paired ? null : sources.code();
  const registration = sources.registration();
  return {
    version: sources.version,
    paired,
    ...(code ? { code: code.code, codeExpiresAt: code.expiresAt } : {}),
    sipRegistered: registration.registered,
    ...(registration.error ? { sipError: registration.error.slice(0, 200) } : {}),
    pin: sources.pin(),
    log: sources
      .log()
      .slice(-50)
      .map((l) => ({ at: l.at, level: l.level, text: l.text })),
  };
}

export function startPanel(
  sources: PanelSources,
  options: { port?: number; host?: string } = {},
): Promise<{ port: number; stop(): void }> {
  const server = http.createServer((req, res) => {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (!ALLOWED.has(req.socket.remoteAddress ?? "")) {
      res.writeHead(403, { ...headers, "content-type": "text/plain" });
      return void res.end("Forbidden");
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method !== "GET") {
      res.writeHead(405, { ...headers, "content-type": "text/plain" });
      return void res.end("Method not allowed");
    }
    try {
      if (path.endsWith("/api/state")) {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        return void res.end(JSON.stringify(panelState(sources)));
      }
      if (path === "/" || path === "" || path.endsWith("/")) {
        res.writeHead(200, {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        });
        return void res.end(PAGE);
      }
    } catch {
      res.writeHead(500, { ...headers, "content-type": "text/plain" });
      return void res.end("Error");
    }
    res.writeHead(404, { ...headers, "content-type": "text/plain" });
    res.end("Not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8099, options.host ?? "0.0.0.0", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        stop: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Squeak Voice</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--card:#f2f2f5;--mute:#5c5c66;--ok:#12805c;--bad:#b3261e;--btn:#1b1b1f;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#f2f2f5;--card:#1e1e22;--mute:#a0a0aa;--ok:#4cc79a;--bad:#ff8a80;--btn:#f2f2f5;--btnfg:#121214}}
body{margin:0;padding:20px;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto}
h1{font-size:22px;margin:0 0 16px}
section{background:var(--card);border-radius:14px;padding:16px;margin:0 0 14px}
.code{font:600 40px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.08em;margin:8px 0}
.mute{color:var(--mute)}.ok{color:var(--ok)}.bad{color:var(--bad)}
button{min-height:44px;padding:0 20px;border:0;border-radius:10px;background:var(--btn);color:var(--btnfg);font:600 16px system-ui;cursor:pointer}
pre{font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;margin:8px 0 12px}
</style></head><body><main>
<h1>Squeak Voice</h1>
<section><strong id="status">Loading</strong><div id="version" class="mute"></div></section>
<section id="codebox" hidden>
<div>Type this in Squeak for Mac: Settings &gt; Phone calls &gt; Add gateway.</div>
<div class="code" id="code"></div>
<button id="copycode" type="button">Copy</button>
</section>
<section><div id="sip"></div><div id="pin"></div></section>
<section><strong>Recent</strong><pre id="log"></pre><button id="copylog" type="button">Copy</button></section>
</main>
<script>
var $=function(i){return document.getElementById(i)};
function copy(text,btn){var done=function(){btn.textContent="Copied";setTimeout(function(){btn.textContent="Copy"},1500)};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,fallback)}else fallback();
function fallback(){var t=document.createElement("textarea");t.value=text;document.body.appendChild(t);t.select();try{document.execCommand("copy")}catch(e){}document.body.removeChild(t);done()}}
var PIN={set:"A PIN is set.",off:"The PIN is turned off.",none:"No PIN is set yet. Set one in Squeak for Mac, Settings > Phone calls."};
function render(s){
$("status").textContent=s.paired?"Paired with your Mac":"Not paired yet";
$("status").className=s.paired?"ok":"";
$("version").textContent="Add-on "+s.version;
$("codebox").hidden=s.paired||!s.code;
if(s.code)$("code").textContent=s.code;
$("sip").textContent=s.sipRegistered?"Registered with your PBX":"Can't register: "+(s.sipError||"no answer yet");
$("sip").className=s.sipRegistered?"ok":"bad";
$("pin").textContent=PIN[s.pin]||"";
$("log").textContent=s.log.map(function(l){return new Date(l.at).toLocaleTimeString()+"  "+(l.level==="warn"?"! ":"")+l.text}).join("\\n")||"Nothing yet.";}
var last=null;
function tick(){fetch("api/state",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){last=s;render(s)}).catch(function(){})}
$("copycode").onclick=function(){if(last&&last.code)copy(last.code,$("copycode"))};
$("copylog").onclick=function(){copy($("log").textContent,$("copylog"))};
tick();setInterval(tick,3000);
</script></body></html>`;
