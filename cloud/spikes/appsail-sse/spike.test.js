// node --test cloud/spikes/appsail-sse/spike.test.js   (local only; the connection-count run is load.js)
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { createHub } = require("./server.js");

const post = (port, path, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ port, path, method: "POST", headers: { "x-key": "spike" } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode, body: t }));
    });
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });

/** A device: one GET, parsed events collected. */
function device(port, acct, ponds) {
  const events = [];
  let comments = 0;
  const req = http.get(
    { port, path: `/events?ponds=${ponds.join(",")}`, headers: { "x-account": acct }, agent: false },
    (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(":")) {
            comments++;
            continue;
          }
          const ev = /event: (.*)/.exec(block)?.[1];
          const data = JSON.parse(/data: (.*)/.exec(block)[1]);
          events.push({ ev, data });
        }
      });
    },
  );
  req.on("error", () => {});
  return { events, comments: () => comments, close: () => req.destroy() };
}
const until = async (f, ms = 3000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function start(opts) {
  const hub = createHub(opts);
  await new Promise((r) => hub.server.listen(0, r));
  return { hub, port: hub.server.address().port };
}

test("subscription is checked against membership; notices reach only the Pond's watchers", async () => {
  const { hub, port } = await start();
  await post(port, "/members", { pond: "P1", acct: "alice" });
  await post(port, "/members", { pond: "P2", acct: "bob" });
  const a = device(port, "alice", ["P1", "P2"]); // P2 is not hers
  const b = device(port, "bob", ["P2"]);
  await until(() => a.events.length && b.events.length);
  assert.deepStrictEqual(a.events[0].data, { granted: ["P1"], denied: ["P2"] });
  await post(port, "/publish", { pond: "P2", kind: "room" });
  await post(port, "/publish", { pond: "P1", kind: "room" });
  await until(() => a.events.length === 2 && b.events.length === 2);
  assert.strictEqual(a.events[1].data.pond, "P1");
  assert.strictEqual(b.events[1].data.pond, "P2");
  a.close();
  b.close();
  hub.closeAll();
  hub.server.close();
});

test("removing a member closes that Pond's subscription at once; her other Ponds stay", async () => {
  const { hub, port } = await start();
  await post(port, "/members", { pond: "P1", acct: "alice" });
  await post(port, "/members", { pond: "P3", acct: "alice" });
  const a = device(port, "alice", ["P1", "P3"]);
  await until(() => a.events.length === 1);
  await post(port, "/members/remove", { pond: "P1", acct: "alice" });
  await until(() => a.events.some((e) => e.ev === "removed"));
  await post(port, "/publish", { pond: "P1", kind: "room" });
  await post(port, "/publish", { pond: "P3", kind: "room" });
  await until(() => a.events.filter((e) => e.ev === "notice").length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(a.events.filter((e) => e.ev === "notice")[0].data.pond, "P3");
  a.close();
  hub.closeAll();
  hub.server.close();
});

test("heartbeat comments keep bytes flowing on an idle stream", async () => {
  const { hub, port } = await start({ heartbeatMs: 50 });
  await post(port, "/members", { pond: "P1", acct: "alice" });
  const a = device(port, "alice", ["P1"]);
  await until(() => a.comments() >= 4);
  a.close();
  hub.closeAll();
  hub.server.close();
});

test("a platform max-age cut ends the stream cleanly; the client can reopen", async () => {
  const { hub, port } = await start({ maxAgeMs: 100 });
  await post(port, "/members", { pond: "P1", acct: "alice" });
  const a = device(port, "alice", ["P1"]);
  await until(() => a.events.some((e) => e.ev === "bye"));
  const b = device(port, "alice", ["P1"]);
  await until(() => b.events.length === 1);
  b.close();
  hub.closeAll();
  hub.server.close();
});

test("closed connections are released (no leak)", async () => {
  const { hub, port } = await start();
  await post(port, "/members", { pond: "P1", acct: "alice" });
  const ds = Array.from({ length: 20 }, () => device(port, "alice", ["P1"]));
  await until(() => hub.conns.size === 20);
  ds.forEach((d) => d.close());
  await until(() => hub.conns.size === 0);
  assert.strictEqual(hub.stats.opened, hub.stats.closed);
  hub.server.close();
});
