// Spike for issue #117: an SSE hub with membership-checked subscriptions. Zero dependencies, local only.
// Not the relay: memberships are an in-memory Map here (the real one reads the Data Store), and "account" is a header
// (the real one verifies x-squeak-account). The shape under test is: one long-lived GET per device, a notice that
// goes only to connections whose account is a member of the notice's Pond, heartbeats, and removal closing a subscription.
const http = require("node:http");

function createHub({ heartbeatMs = 15_000, maxAgeMs = 0, publishKey = "spike" } = {}) {
  /** pondId -> Set<accountId> */
  const members = new Map();
  /** pondId -> Set<conn> */
  const watchers = new Map();
  const conns = new Set();
  const stats = { opened: 0, closed: 0, notices: 0, heartbeats: 0 };
  let seq = 0;

  const isMember = (acct, pond) => !!members.get(pond)?.has(acct);
  const send = (c, event, data, id) => {
    if (c.res.destroyed || c.res.writableEnded) return;
    c.res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  function drop(c, why) {
    if (c.dead) return;
    c.dead = true;
    clearInterval(c.hb);
    clearTimeout(c.age);
    for (const p of c.ponds) watchers.get(p)?.delete(c);
    conns.delete(c);
    stats.closed++;
    if (why && !c.res.writableEnded) {
      send(c, "bye", { why });
      c.res.end();
    }
  }
  function subscribe(c, ponds) {
    const granted = [];
    const denied = [];
    for (const p of ponds) {
      if (isMember(c.acct, p)) {
        c.ponds.add(p);
        if (!watchers.has(p)) watchers.set(p, new Set());
        watchers.get(p).add(c);
        granted.push(p);
      } else denied.push(p);
    }
    return { granted, denied };
  }
  function notice(pond, kind) {
    const n = { pond, seq: ++seq, kind };
    for (const c of watchers.get(pond) ?? []) {
      send(c, "notice", n, String(n.seq));
      stats.notices++;
    }
    return n;
  }
  function remove(acct, pond) {
    members.get(pond)?.delete(acct);
    for (const c of [...(watchers.get(pond) ?? [])]) {
      if (c.acct !== acct) continue;
      c.ponds.delete(pond);
      watchers.get(pond).delete(c);
      send(c, "removed", { pond });
    }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/events") {
      const acct = req.headers["x-account"];
      if (!acct) return void res.writeHead(401).end();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform", // no-transform: stops intermediaries compressing/buffering the stream
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // nginx-style proxies: do not buffer
      });
      res.write(": open\n\n");
      const c = { res, acct, ponds: new Set(), dead: false };
      conns.add(c);
      stats.opened++;
      const { granted, denied } = subscribe(c, (u.searchParams.get("ponds") || "").split(",").filter(Boolean));
      send(c, "hello", { granted, denied });
      c.hb = setInterval(() => {
        res.write(": hb\n\n");
        stats.heartbeats++;
      }, heartbeatMs);
      // A platform that ends requests at N seconds: the client reconnects; the notice it missed comes from the change feed.
      if (maxAgeMs) c.age = setTimeout(() => drop(c, "max-age"), maxAgeMs);
      req.on("close", () => drop(c));
      return;
    }
    if (req.method === "GET" && u.pathname === "/stats") {
      // spike only: the server's own memory, so a load run can read it from outside
      const m = process.memoryUsage();
      return void res
        .writeHead(200)
        .end(JSON.stringify({ conns: conns.size, rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576 }));
    }
    if (req.method === "POST" && req.headers["x-key"] === publishKey) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const b = JSON.parse(body || "{}");
        if (u.pathname === "/members") {
          if (!members.has(b.pond)) members.set(b.pond, new Set());
          members.get(b.pond).add(b.acct);
        } else if (u.pathname === "/members/remove") remove(b.acct, b.pond);
        else if (u.pathname === "/publish") return void res.writeHead(200).end(JSON.stringify(notice(b.pond, b.kind)));
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0; // an SSE request must not hit Node's own request timeout
  return { server, stats, conns, closeAll: () => [...conns].forEach((c) => drop(c, "shutdown")) };
}

module.exports = { createHub };
if (require.main === module) {
  const hub = createHub({
    heartbeatMs: Number(process.env.HB_MS) || 15_000,
    maxAgeMs: Number(process.env.MAX_AGE_MS) || 0,
  });
  hub.server.listen(Number(process.env.PORT) || 9100, () => console.error("sse spike on", hub.server.address().port));
}
