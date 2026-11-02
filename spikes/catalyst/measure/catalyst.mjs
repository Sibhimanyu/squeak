// Catalyst measurements. Env: RELAY_URL (https://<project-domain>/server/squeak_relay), RELAY_KEY, N (default 30).
//   COLD=1 node measure/catalyst.mjs   -> only the cold-start probe (run after >=15 min idle)
import { DataStreamsWebSocket } from "@zcatalyst/datastreams";
import { now, summarize, sleep, randId } from "./stats.mjs";

const N = Number(process.env.N ?? 30);
const base = (process.env.RELAY_URL ?? "").replace(/\/+$/, "");
const key = process.env.RELAY_KEY ?? "";
if (!base) { console.error("set RELAY_URL and RELAY_KEY"); process.exit(2); }
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; } };

// cold start: first request after idle vs the next one; X-Cold / X-Loaded-Ago come from the function itself
{
  const t = now(); const r = await fetch(`${base}/ping`); const b = await j(r);
  const cold = now() - t;
  const t2 = now(); await (await fetch(`${base}/ping`)).text(); const warm = now() - t2;
  console.log(JSON.stringify({ first_ping_ms: +cold.toFixed(0), second_ping_ms: +warm.toFixed(0), xcold: r.headers.get("x-cold"), loadedAgoMs: r.headers.get("x-loaded-ago"), serverTiming: r.headers.get("server-timing"), body: b }));
}
if (process.env.COLD) process.exit(0);

const channel = randId(32);
const docUrl = (d) => `${base}/doc?path=${encodeURIComponent(`channels/${channel}/state/${d}`)}`;
const put = [], get = [], notice = [], fn = [];
const box = (i) => "x".repeat(2000) + i;
const parseFn = (r) => Number(/dur=(\d+)/.exec(r.headers.get("server-timing") ?? "")?.[1]);

try {
  for (let i = 0; i < N; i++) {
    const d = `d${i % 5}`;
    let t = now();
    let r = await fetch(docUrl(d), { method: "PUT", body: JSON.stringify({ box: box(i) }) });
    if (!r.ok) throw new Error(`put ${r.status} ${JSON.stringify(await j(r))}`);
    put.push(now() - t); fn.push(parseFn(r)); await r.text();
    t = now();
    r = await fetch(docUrl(d));
    const b = await j(r);
    if (b.box !== box(i)) throw new Error(`get mismatch ${r.status} ${JSON.stringify(b).slice(0, 100)}`);
    get.push(now() - t);
  }

  // change notice through Data Streams
  const tokenRes = await fetch(`${base}/token`, { method: "POST", headers: { "x-relay-key": key }, body: JSON.stringify({ connectionName: `spk-${randId(10)}` }) });
  const { token } = await j(tokenRes);
  if (!token) throw new Error(`token: ${tokenRes.status}`);
  const ws = new DataStreamsWebSocket({ url: token.url, zuid: token["wss-id"], key: token.key });
  let waiter = null;
  await new Promise((resolve, reject) => {
    ws.on("open", () => { ws.subscribe("0"); resolve(); });
    ws.on("error", (e) => { if (e.code !== 1000) reject(new Error(`ws error ${e.code ?? ""} ${e.message ?? e.error}`)); });
    ws.on("message", (ev) => { try { waiter?.(JSON.parse(ev.data)); } catch {} ws.sendAck(); });
    setTimeout(() => reject(new Error("ws open timeout")), 15000);
  });
  console.log("subscriber host:", token.url);
  await sleep(1500);
  for (let i = 0; i < N; i++) {
    const got = new Promise((resolve) => { waiter = (m) => { if (m.p === `channels/${channel}/state`) resolve(); }; });
    const t = now();
    const r = await fetch(docUrl("notice"), { method: "PUT", body: JSON.stringify({ box: `n${i}` }) });
    await r.text();
    await Promise.race([got, sleep(10000).then(() => { throw new Error("no notice in 10s"); })]);
    notice.push(now() - t);
    await sleep(400); // the subscriber acks each message before the next arrives
  }
  try { ws.unsubscribe(); } catch {}
  await sleep(800); ws.close();
} finally {
  for (let k = 0; k < 5; k++) await fetch(docUrl(`d${k}`), { method: "DELETE" }).then((r) => r.text()).catch(() => {});
  await fetch(docUrl("notice"), { method: "DELETE" }).then((r) => r.text()).catch(() => {});
}
summarize("catalyst PUT ms (incl. NoSQL write + publishData)", put);
summarize("catalyst PUT in-function ms", fn.filter(Number.isFinite));
summarize("catalyst GET ms", get);
summarize("catalyst PUT->notice ms (put response + ws delivery)", notice);
process.exit(0);
