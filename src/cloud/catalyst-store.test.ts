import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { CatalystStore, noticeMatches, type StreamSocket } from "./catalyst-store.js";

const KEY = "relay-key-relay-key-1234";
const POND_TOKEN = "pm.pond.member.9999999999.mac";

interface Fake {
  url: string;
  docs: Map<string, unknown>;
  requests: string[];
  stop(): Promise<void>;
}

/** An in-process stand-in for the `squeak_relay` function: the contract's routes, key-checked. */
async function fakeRelay(): Promise<Fake> {
  const docs = new Map<string, unknown>();
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL((req.url ?? "/").replace("/server/squeak_relay", ""), "http://relay");
    requests.push(`${req.method} ${url.pathname}`);
    const asKey = req.headers["x-squeak-relay"] === KEY;
    const asPond = req.headers["x-squeak-pond-token"] === POND_TOKEN && !req.headers["x-squeak-relay"];
    // A pond token opens documents and the pond's own stream, never the store-wide `/token`.
    if (!asKey && !(asPond && url.pathname !== "/token")) {
      res.writeHead(401);
      return void res.end();
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      const path = url.searchParams.get("path") ?? "";
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/doc" && req.method === "GET") {
        return docs.has(path) ? json(200, { doc: docs.get(path) }) : (res.writeHead(404), void res.end());
      }
      if (url.pathname === "/doc" && req.method === "PUT") {
        docs.set(path, body.doc);
        return void (res.writeHead(204), res.end());
      }
      if (url.pathname === "/doc" && req.method === "DELETE") {
        docs.delete(path);
        return void (res.writeHead(204), res.end());
      }
      if (url.pathname === "/list") {
        const prefix = `${url.searchParams.get("prefix")}/`;
        const items = [...docs]
          .filter(([p]) => p.startsWith(prefix))
          .map(([p, doc]) => ({ id: p.slice(prefix.length), doc }));
        return json(200, { items });
      }
      if (url.pathname === "/pond-stream" && asPond)
        return json(200, { url: "in1-dms.zoho.in", key: "pk", wssId: `pw-${String(body.name)}` });
      if (url.pathname === "/token")
        return json(200, { url: "in1-dms.zoho.in", key: "tk", wssId: `w-${String(body.name)}` });
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/server/squeak_relay`,
    docs,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class FakeSocket implements StreamSocket {
  sent: string[] = [];
  closed = false;
  onopen: StreamSocket["onopen"] = null;
  onmessage: StreamSocket["onmessage"] = null;
  onclose: StreamSocket["onclose"] = null;
  onerror: StreamSocket["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  say(frames: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frames) });
  }
}

const relays: Fake[] = [];
afterEach(async () => {
  while (relays.length) await relays.pop()!.stop();
});

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("CatalystStore documents", () => {
  it("gets, sets, lists and deletes through the relay with the key header", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const store = new CatalystStore({ baseUrl: relay.url, relayKey: KEY });
    expect(await store.get("channels/abc/state/x")).toBeNull();
    await store.set("channels/abc/state/x", { box: "b1", sig: "s", device: "d", at: 5.9 });
    expect(relay.docs.get("channels/abc/state/x")).toEqual({ box: "b1", sig: "s", device: "d", at: 5 });
    await store.set("channels/abc/state/y", { box: "b2" });
    expect(await store.get("channels/abc/state/x")).toEqual({ box: "b1", sig: "s", device: "d", at: 5 });
    const list = await store.list("channels/abc/state");
    expect(list.map((item) => item.id).sort()).toEqual(["x", "y"]);
    await store.delete("channels/abc/state/x");
    await store.delete("channels/abc/state/x");
    expect(await store.get("channels/abc/state/x")).toBeNull();
  });

  it("fails with a fixed sentence, never the body, on a wrong key", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const store = new CatalystStore({ baseUrl: relay.url, relayKey: "wrong-wrong-wrong-1234" });
    await expect(store.get("channels/abc/state/x")).rejects.toThrow("catalyst get failed: 401");
  });
});

describe("CatalystStore with a pond token", () => {
  it("sends the token instead of the relay key, and reads and writes through it", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const seen: Array<Record<string, string>> = [];
    const store = new CatalystStore({
      baseUrl: relay.url,
      pondToken: POND_TOKEN,
      fetch: async (url, init) => {
        seen.push(init?.headers as Record<string, string>);
        return fetch(url, init);
      },
    });
    await store.set("channels/abc/joins/r1", { box: "b", sig: "s", device: "d", at: 1 });
    expect(await store.get("channels/abc/joins/r1")).toMatchObject({ box: "b" });
    expect((await store.list("channels/abc/joins")).map((i) => i.id)).toEqual(["r1"]);
    expect(seen.every((h) => h["x-squeak-pond-token"] === POND_TOKEN && !("x-squeak-relay" in h))).toBe(true);
  });

  it("is refused when the token is wrong, and needs exactly one credential", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const store = new CatalystStore({ baseUrl: relay.url, pondToken: "pm.wrong" });
    await expect(store.get("channels/abc/state/x")).rejects.toThrow("catalyst get failed: 401");
    expect(() => new CatalystStore({ baseUrl: relay.url })).toThrow(/one of them/);
    expect(() => new CatalystStore({ baseUrl: relay.url, relayKey: KEY, pondToken: POND_TOKEN })).toThrow(
      /one of them/,
    );
  });

  it("subscribes through the pond's own stream, never the store-wide token route", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const sockets: FakeSocket[] = [];
    const store = new CatalystStore({
      baseUrl: relay.url,
      pondToken: POND_TOKEN,
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const stop = store.watch("channels/abc/tcmds", () => undefined);
    await until(() => sockets.length === 1);
    expect(relay.requests).toContain("POST /pond-stream");
    expect(relay.requests).not.toContain("POST /token");
    stop();
  });
});

describe("CatalystStore watch", () => {
  it("subscribes live, acks each notice, fans out by path prefix and unsubscribes before closing", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const sockets: FakeSocket[] = [];
    const store = new CatalystStore({
      baseUrl: relay.url,
      relayKey: KEY,
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      pollMs: 60_000,
    });
    const commands: number[] = [];
    const results: number[] = [];
    const stopCommands = store.watch("channels/abc/commands", () => commands.push(1));
    const stopResults = store.watch("channels/abc/results", () => results.push(1));
    await until(() => sockets.length === 1);
    // One subscriber for both watchers.
    expect(sockets[0]!.url).toMatch(/^wss:\/\/in1-dms\.zoho\.in\/wsconnect\?prd=CY&zuid=w-sq[a-z0-9]+&key=tk$/);
    await until(() => commands.length === 1 && results.length === 1); // each watch's own first wake
    sockets[0]!.say([{ mtype: "0", msg: { sid: "s", uid: "u" } }]);
    expect(sockets[0]!.sent).toContain(JSON.stringify({ type: "con", value: "subscribe", streamingId: "0" }));
    const before = { c: commands.length, r: results.length };
    sockets[0]!.say([
      {
        mtype: "650",
        msg: { opr: "event", data: { data: JSON.stringify({ p: "channels/abc/commands" }), streamingId: "7" } },
      },
    ]);
    expect(sockets[0]!.sent).toContain(JSON.stringify({ type: "ack", streamingId: "7" }));
    expect(commands.length).toBe(before.c + 1);
    expect(results.length).toBe(before.r);
    // A notice for another channel wakes neither.
    sockets[0]!.say([
      {
        mtype: "650",
        msg: { opr: "event", data: { data: JSON.stringify({ p: "channels/zzz/commands" }), streamingId: "8" } },
      },
    ]);
    expect(commands.length).toBe(before.c + 1);
    stopCommands();
    expect(sockets[0]!.closed).toBe(false);
    stopResults();
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ type: "con", value: "unsubscribe" }));
    await until(() => sockets[0]!.closed);
  });

  it("releases and takes a fresh token when the server drops the session, then wakes everyone", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const sockets: FakeSocket[] = [];
    const store = new CatalystStore({
      baseUrl: relay.url,
      relayKey: KEY,
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      retryMinMs: 10,
      retryMaxMs: 20,
    });
    let wakes = 0;
    const stop = store.watch("channels/abc/state", () => wakes++);
    await until(() => sockets.length === 1);
    sockets[0]!.say([{ mtype: "0", msg: {} }]);
    sockets[0]!.say([{ mtype: "-11", msg: {} }]);
    await until(() => sockets.length === 2);
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ type: "con", value: "unsubscribe" }));
    expect(sockets[1]!.url).not.toBe(sockets[0]!.url);
    const before = wakes;
    sockets[1]!.say([{ mtype: "0", msg: {} }]);
    expect(wakes).toBeGreaterThan(before);
    stop();
  });

  it("refuses a token naming a host outside Data Streams", async () => {
    const relay = await fakeRelay();
    relays.push(relay);
    const sockets: FakeSocket[] = [];
    const store = new CatalystStore({
      baseUrl: relay.url,
      relayKey: KEY,
      fetch: async (url, init) => {
        if (url.endsWith("/token")) {
          return new Response(JSON.stringify({ url: "evil.example.com", key: "k", wssId: "w" }), { status: 200 });
        }
        return fetch(url, init);
      },
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      retryMinMs: 5_000,
    });
    const errors: string[] = [];
    const stop = store.watch("channels/abc/state", () => undefined, { onError: (e) => errors.push(e.message) });
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unexpected host");
    expect(sockets).toHaveLength(0);
    stop();
  });

  it("matches a notice to a doc or a collection watch", () => {
    expect(noticeMatches("channels/a/state/presence", "channels/a/state")).toBe(true);
    expect(noticeMatches("channels/a/state", "channels/a/state")).toBe(true);
    expect(noticeMatches("channels/a", "channels/a/state")).toBe(true);
    expect(noticeMatches("channels/a/commands", "channels/a/state")).toBe(false);
    expect(noticeMatches("channels/ab/state", "channels/a/state")).toBe(false);
  });
});
