// The daemon reads a Pond through the change feed (change-feed.ts) against the real relay handler (cloud/catalyst-relay),
// so the cost budget is measured on the actual routes: after the first open, listing a Pond is one feed read.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { CatalystStore } from "./catalyst-store.js";
import { FEED_KINDS } from "./change-feed.js";

const require = createRequire(import.meta.url);
const relayDir = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${relayDir}handler.js`) as { createRelay: (deps: unknown) => Handler };
const relayFeed = require(`${relayDir}feed.js`) as { FEED_KINDS: Set<string> };

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const KEY = "k".repeat(43);
const POND = "P".repeat(32);

function relayStore(withFeed: boolean) {
  const rows = new Map<string, string>();
  const key = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const sorted = (pk: string) =>
    [...rows]
      .filter(([k]) => k.startsWith(`${pk}\u0000`))
      .map(([k, json]) => ({ doc: k.split("\u0000")[1]!, json }))
      .sort((a, b) => (a.doc < b.doc ? -1 : 1));
  const store: Record<string, unknown> = {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(key(pk, doc)) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(key(pk, doc), json),
    del: async (pk: string, doc: string) => void rows.delete(key(pk, doc)),
    list: async (pk: string) => sorted(pk),
  };
  if (withFeed) {
    store.claim = async (pk: string, doc: string, json: string) => {
      if (rows.has(key(pk, doc))) return false;
      rows.set(key(pk, doc), json);
      return true;
    };
    store.range = async (pk: string, after: string | null, limit: number) =>
      sorted(pk)
        .filter((r) => after === null || r.doc > after)
        .slice(0, limit);
  }
  return store;
}

/** A fetch that runs the real relay handler in-process and keeps the route of every request. */
function relayFetch(withFeed = true) {
  const handle = createRelay({
    key: KEY,
    store: relayStore(withFeed),
    streams: { channelId: async () => "c", publish: async () => undefined, token: async () => ({}) },
  });
  const requests: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    requests.push(u.pathname.replace("/server/squeak_relay", ""));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = new EventEmitter();
    req.method = init.method ?? "GET";
    req.url = u.pathname + u.search;
    req.headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    let status = 0;
    let text = "";
    const res = { writeHead: (s: number) => void (status = s), end: (t?: string) => void (text = t ?? "") };
    const done = handle(req, res);
    setImmediate(() => {
      if (typeof init.body === "string") req.emit("data", Buffer.from(init.body));
      req.emit("end");
    });
    await done;
    return new Response(status === 204 ? null : text, { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, requests };
}

const open = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) =>
  new CatalystStore({ baseUrl: "https://relay.test/server/squeak_relay", relayKey: KEY, fetch: fetchImpl });
const room = (id: string) => `channels/${POND}/room/${id}`;

describe("a device reads a Pond through the change feed", () => {
  it("lists the same kinds the relay stamps", () => {
    expect([...FEED_KINDS].sort()).toEqual([...relayFeed.FEED_KINDS].sort());
  });

  it("costs one feed read to list a Pond again, and sees other devices' writes, edits and deletes", async () => {
    const { fetchImpl, requests } = relayFetch();
    const mine = open(fetchImpl);
    const theirs = open(fetchImpl);
    await mine.set(room("a"), { box: "a1" });
    await mine.set(room("b"), { box: "b1" });

    // first open: the end of the log, the list, and a catch-up read
    expect((await theirs.list(`channels/${POND}/room`)).map((d) => d.id)).toEqual(["a", "b"]);

    // reopening a Pond already seen: exactly one request, a feed read
    requests.length = 0;
    expect((await theirs.list(`channels/${POND}/room`)).map((d) => d.id)).toEqual(["a", "b"]);
    expect(requests).toEqual(["/changes"]);

    // nothing changed twice over is still one read each
    requests.length = 0;
    await theirs.list(`channels/${POND}/room`);
    await theirs.list(`channels/${POND}/room`);
    expect(requests).toEqual(["/changes", "/changes"]);

    // another device writes, edits and deletes: the next list shows it, still through the feed alone
    await mine.set(room("c"), { box: "c1" });
    await mine.set(room("a"), { box: "a2" });
    await mine.delete(room("b"));
    requests.length = 0;
    const now = await theirs.list(`channels/${POND}/room`);
    expect(now).toEqual([
      { id: "a", doc: { box: "a2" } },
      { id: "c", doc: { box: "c1" } },
    ]);
    expect(requests).toEqual(["/changes"]);
  });

  it("seeds each kind once: a second kind of the same Pond costs one list, then feed reads only", async () => {
    const { fetchImpl, requests } = relayFetch();
    const mine = open(fetchImpl);
    const theirs = open(fetchImpl);
    await mine.set(room("a"), { box: "a1" });
    await mine.set(`channels/${POND}/tasks/t1`, { box: "t1" });
    await theirs.list(`channels/${POND}/room`);
    requests.length = 0;
    expect((await theirs.list(`channels/${POND}/tasks`)).map((d) => d.id)).toEqual(["t1"]);
    expect(requests.filter((r) => r === "/list")).toHaveLength(1);
    requests.length = 0;
    await theirs.list(`channels/${POND}/tasks`);
    await theirs.list(`channels/${POND}/room`);
    expect(requests).toEqual(["/changes", "/changes"]);
  });

  it("keeps listing plainly for kinds that are not Pond content", async () => {
    const { fetchImpl, requests } = relayFetch();
    const store = open(fetchImpl);
    await store.set(`channels/${POND}/state/x`, { box: "s" });
    requests.length = 0;
    await store.list(`channels/${POND}/state`);
    await store.list(`channels/${POND}/state`);
    expect(requests).toEqual(["/list", "/list"]);
  });

  it("falls back to the plain list, once, on a relay without a feed", async () => {
    const { fetchImpl, requests } = relayFetch(false);
    const store = open(fetchImpl);
    await store.set(room("a"), { box: "a1" });
    requests.length = 0;
    expect((await store.list(`channels/${POND}/room`)).map((d) => d.id)).toEqual(["a"]);
    expect((await store.list(`channels/${POND}/room`)).map((d) => d.id)).toEqual(["a"]);
    // one probe of the feed, then plain lists: it does not keep asking
    expect(requests).toEqual(["/changes", "/list", "/list"]);
  });

  it("keeps two concurrent lists of one Pond consistent (no page applied twice or out of order)", async () => {
    const { fetchImpl } = relayFetch();
    const mine = open(fetchImpl);
    const theirs = open(fetchImpl);
    for (let i = 0; i < 5; i++) await mine.set(room(`d${i}`), { box: `v${i}` });
    await theirs.list(`channels/${POND}/room`);
    for (let i = 0; i < 5; i++) await mine.set(room(`d${i}`), { box: `w${i}` });
    await mine.delete(room("d0"));
    const [a, b] = await Promise.all([theirs.list(`channels/${POND}/room`), theirs.list(`channels/${POND}/room`)]);
    expect(a).toEqual(b);
    expect(a.map((d) => d.doc.box)).toEqual(["w1", "w2", "w3", "w4"]);
  });
});
