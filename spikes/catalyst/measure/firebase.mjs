// Firebase RTDB baseline: PUT / GET latency and PUT -> SSE "something changed" latency.
// Uses a throwaway channel id (32 random chars) under kind `state` (the rules only allow the
// documented kinds, so `spike` is refused), and deletes it afterwards.
import { readFileSync } from "node:fs";
import { now, summarize, sleep, randId } from "./stats.mjs";

const N = Number(process.env.N ?? 30);
const envFile = `${process.env.HOME}/Library/Application Support/squeak/.env`;
const base = (process.env.SQUEAK_REMOTE_DATABASE_URL ??
  readFileSync(envFile, "utf8").match(/^SQUEAK_REMOTE_DATABASE_URL=(.+)$/m)[1]).trim().replace(/\/+$/, "");
const channel = randId(32);
const url = (p, q = "") => `${base}/${p}.json${q ? `?${q}` : ""}`;
const body = (i) => JSON.stringify({ box: "x".repeat(2000) + i, at: Date.now() });

const put = [], get = [], notice = [];
const doc = (i) => `channels/${channel}/state/d${i % 5}`;
try {
  for (let i = 0; i < N; i++) {
    let t = now();
    const r = await fetch(url(doc(i), "print=silent"), { method: "PUT", body: body(i), headers: { "content-type": "application/json" } });
    if (!r.ok) throw new Error(`put ${r.status} ${await r.text()}`);
    put.push(now() - t);
    t = now();
    const g = await fetch(url(doc(i)));
    await g.json();
    get.push(now() - t);
  }

  // change notice
  const ctl = new AbortController();
  const res = await fetch(url(`channels/${channel}/state`), { headers: { accept: "text/event-stream" }, signal: ctl.signal });
  let waiter = null, buf = "", event = "";
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1], data = /^data: (.*)$/m.exec(raw)?.[1] ?? "";
        if (ev === "put" || ev === "patch") waiter?.(data);
      }
    }
  })().catch(() => {});
  await sleep(1500); // initial put
  for (let i = 0; i < N; i++) {
    const marker = `n${i}-${randId(6)}`;
    const got = new Promise((resolve) => { waiter = (d) => { if (d.includes(marker)) resolve(); }; });
    const t = now();
    await fetch(url(`channels/${channel}/state/doc`, "print=silent"), { method: "PUT", body: JSON.stringify({ box: marker, at: Date.now() }), headers: { "content-type": "application/json" } });
    await Promise.race([got, sleep(8000).then(() => { throw new Error("no event in 8s"); })]);
    notice.push(now() - t);
    await sleep(200);
  }
  ctl.abort();
} finally {
  await fetch(url(`channels/${channel}`, "print=silent"), { method: "DELETE" }).catch(() => {});
}
console.log("firebase base host:", new URL(base).hostname.replace(/^[^.]+/, "<proj>"));
summarize("firebase PUT ms", put);
summarize("firebase GET ms", get);
summarize("firebase PUT->notice ms (put returns first, includes the PUT round trip)", notice);
