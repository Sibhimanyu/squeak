// node --expose-gc load.js <N>: N idle SSE devices on one Pond against a hub in a separate process-free setup.
// Run the hub in its own process (node server.js) to measure the SERVER's memory: this script prints /proc-free numbers by
// asking the hub process via `ps`. For a single-process run (hub + clients) the rss over-counts the server.
const http = require("node:http");
const { createHub } = require("./server.js");

const N = Number(process.argv[2] || 100);
(async () => {
  // argv[3] = port of a separately started node server.js (then read its memory with ps)
  const external = Number(process.argv[3] || 0);
  const hub = external ? { conns: { size: 0 } } : createHub();
  if (!external) await new Promise((r) => hub.server.listen(0, r));
  const port = external || hub.server.address().port;
  let opened = 0;
  const post = (p, b) =>
    new Promise((r) => {
      const q = http.request({ port, path: p, method: "POST", headers: { "x-key": "spike" } }, (res) => {
        res.resume();
        res.on("end", () => r());
      });
      q.end(JSON.stringify(b));
    });
  await post("/members", { pond: "P", acct: "a" });
  let got = 0;
  let errs = 0;
  const base = process.memoryUsage();
  for (let i = 0; i < N; i++) {
    const q = http.get({ port, path: "/events?ponds=P", headers: { "x-account": "a" }, agent: false }, (res) => {
      opened++;
      res.setEncoding("utf8");
      res.on("data", (d) => {
        if (d.includes("event: notice")) got++;
      });
    });
    q.on("error", () => errs++);
    // open in small waves: a burst past the listen backlog stalls the handshakes on this machine
    if (i % 100 === 99) await new Promise((r) => setTimeout(r, 100));
  }
  const t = Date.now();
  while ((external ? opened : hub.conns.size) < N && Date.now() - t < 20000)
    await new Promise((r) => setTimeout(r, 50));
  console.log("connected", external ? opened : hub.conns.size, "errors", errs);
  await new Promise((r) => setTimeout(r, 500));
  if (external) {
    const s = await fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.json());
    console.log("server", JSON.stringify({ conns: s.conns, rssMB: +s.rssMB.toFixed(1), heapMB: +s.heapMB.toFixed(1) }));
  }
  global.gc?.();
  const m = process.memoryUsage();
  const t0 = Date.now();
  await post("/publish", { pond: "P", kind: "room" });
  while (got < N && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 5));
  console.log(
    JSON.stringify({
      N,
      got,
      fanoutMs: Date.now() - t0,
      rssDeltaMB: +((m.rss - base.rss) / 1048576).toFixed(1),
      heapDeltaMB: +((m.heapUsed - base.heapUsed) / 1048576).toFixed(1),
    }),
  );
  process.exit(0);
})();
