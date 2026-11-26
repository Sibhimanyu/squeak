// Live notices (issue #121): `squeak-live` holds one stream per device and sends a short notice only to the connections whose
// account is a member of the Pond; instances share notices, removals and presence through one channel. The client side
// (src/cloud/live-notices.ts) is run against the real hub here, over a fake fetch, with fake timers.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveClient, type LiveClientOptions } from "../../../src/cloud/live-notices.js";
import type { FeedChange } from "../../../src/cloud/change-feed.js";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const live = new URL("../live/", import.meta.url).pathname;
const { createHub, MAX_AGE_MS } = require(`${live}hub.js`);
const { createMemoryBus } = require(`${live}fanout.js`);
const { createLiveServer, createAuth } = require(`${live}server.js`);
const { createRelay } = require(`${fn}handler.js`);
const { createLiveNotices, withRemovalNotice } = require(`${fn}live-notice.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const OTHER = "Q".repeat(32);
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** People: who is in which Pond, by a plain set (the real tables are tested in people.test.ts). */
function fakePeople() {
  const inPond = new Set<string>();
  return {
    add: (pond: string, user: string) => inPond.add(`${pond}:${user}`),
    drop: (pond: string, user: string) => inPond.delete(`${pond}:${user}`),
    isMember: async (pond: string, user: string) => inPond.has(`${pond}:${user}`),
    reads: 0,
  };
}

/** A device's end of a stream, without a network: records the events the hub sends it. */
function device(hub: any, userId: string, ponds: string[], deviceId = `dev-${userId}`) {
  const events: Array<{ event: string | null; data: any }> = [];
  let ended = false;
  const ready = hub.open({
    userId,
    deviceId,
    ponds,
    send: (event: string | null, data: unknown) => events.push({ event, data }),
    end: () => void (ended = true),
  });
  return {
    ready,
    events,
    get ended() {
      return ended;
    },
    notices: () => events.filter((e) => e.event === "notice").map((e) => e.data),
  };
}

const noticeText = (pond: string, seq: number, kind = "room") => JSON.stringify({ t: "n", pond, seq, kind });

describe("who gets a notice", () => {
  it("reaches only connections whose account is a member of that Pond", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    people.add(POND, "bob");
    people.add(OTHER, "cat");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const ann = device(hub, "ann", [POND]);
    const bob = device(hub, "bob", [POND, OTHER]); // OTHER is not his
    const cat = device(hub, "cat", [OTHER]);
    const dan = device(hub, "dan", [POND]); // not a member of anything
    await Promise.all([ann.ready, bob.ready, cat.ready, dan.ready]);

    await bus.publish(noticeText(POND, 7));
    await flush();

    expect(ann.notices()).toEqual([{ pond: POND, seq: 7, kind: "room" }]);
    expect(bob.notices()).toEqual([{ pond: POND, seq: 7, kind: "room" }]);
    expect(cat.notices()).toEqual([]);
    expect(dan.notices()).toEqual([]);
    hub.stop();
  });

  it("refuses a subscription to a Pond the account is not in, and says so in hello", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const hub = createHub({ people, fanout: createMemoryBus().instance() });
    const ann = device(hub, "ann", [POND, OTHER]);
    await ann.ready;
    expect(ann.events[0]).toEqual({
      event: "hello",
      data: { ponds: [POND], refused: [OTHER], maxAgeMs: MAX_AGE_MS, heartbeatMs: 15_000 },
    });
    hub.stop();
  });

  it("removing a member closes their Pond subscription at once (the others keep theirs)", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    people.add(POND, "bob");
    people.add(OTHER, "bob");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const ann = device(hub, "ann", [POND]);
    const bobPhone = device(hub, "bob", [POND, OTHER], "bob-phone");
    const bobMac = device(hub, "bob", [POND], "bob-mac");
    await Promise.all([ann.ready, bobPhone.ready, bobMac.ready]);

    // The relay announces the removal; the very next notice must not reach him.
    people.drop(POND, "bob");
    await bus.publish(JSON.stringify({ t: "rm", pond: POND, user: "bob" }));
    await bus.publish(noticeText(POND, 8));
    await bus.publish(noticeText(OTHER, 3));
    await flush();

    expect(ann.notices()).toEqual([{ pond: POND, seq: 8, kind: "room" }]);
    expect(bobPhone.notices()).toEqual([{ pond: OTHER, seq: 3, kind: "room" }]); // still in OTHER
    expect(bobMac.notices()).toEqual([]);
    expect(bobMac.events.some((e) => e.event === "removed" && e.data.pond === POND)).toBe(true);

    // And he cannot come back to it: the next subscription is refused.
    const again = device(hub, "bob", [POND], "bob-phone");
    await again.ready;
    expect(again.events[0]!.data.refused).toEqual([POND]);
    hub.stop();
  });

  it("the relay announces a removal through people.removeMember, and a stamped write as one short notice", async () => {
    const published: Array<{ id: string; text: string }> = [];
    const streams = {
      liveChannelId: async () => "live-chan",
      publish: async (id: string, text: string) => void published.push({ id, text }),
    };
    const notices = createLiveNotices(streams);
    const people = createPeople({ tables: createMemoryTables(schema) });
    const wrapped = withRemovalNotice(people, notices);
    await wrapped.upsertAccount({ userId: "ann", email: "ann@x.co", name: "Ann" });
    await wrapped.upsertAccount({ userId: "bob", email: "bob@x.co", name: "Bob" });
    await wrapped.createPond({ pondId: POND, name: "P", ownerUserId: "ann" });
    await wrapped.addMember({ pondId: POND, userId: "bob", role: "member" });
    await wrapped.removeMember({ pondId: POND, userId: "bob", reason: "removed" });
    expect(published.map((p) => JSON.parse(p.text))).toEqual([{ t: "rm", pond: POND, user: "bob" }]);
    await notices.notice(POND, 4, "room");
    expect(JSON.parse(published[1]!.text)).toEqual({ t: "n", pond: POND, seq: 4, kind: "room" });
    // No live channel (not made yet): nothing is published and nothing throws.
    await createLiveNotices({ publish: async () => undefined }).notice(POND, 1, "room");
  });
});

describe("instances", () => {
  it("fan a notice out across two instances, and a removal and presence with it", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    people.add(POND, "bob");
    const bus = createMemoryBus();
    const wrote: Array<[string, number]> = [];
    const lastSeen = { write: async (u: string, at: number) => void wrote.push([u, at]) };
    const a = createHub({ people, fanout: bus.instance(), instanceId: "A", lastSeen });
    const b = createHub({ people, fanout: bus.instance(), instanceId: "B", lastSeen });
    a.start();
    b.start();
    const onA = device(a, "ann", [POND], "ann-mac");
    const onB = device(b, "bob", [POND], "bob-mac");
    await Promise.all([onA.ready, onB.ready]);
    await flush();

    await bus.publish(noticeText(POND, 1)); // from the relay: no instance involved
    await flush();
    expect(onA.notices()).toHaveLength(1);
    expect(onB.notices()).toHaveLength(1);

    // Presence crosses: B knows ann is online though her stream is on A.
    expect(b.presenceOf("ann")).toEqual({ online: true, devices: 1 });
    expect(a.presenceOf("bob")).toEqual({ online: true, devices: 1 });

    // Typing crosses and is not echoed to the typist.
    expect(await a.typing("ann", POND)).toBe(true);
    await flush();
    expect(onB.events.filter((e) => e.event === "typing")).toHaveLength(1);
    expect(onA.events.filter((e) => e.event === "typing")).toHaveLength(0);

    // A removal published once cuts the connection on the instance that holds it.
    await bus.publish(JSON.stringify({ t: "rm", pond: POND, user: "bob" }));
    await flush();
    expect(onB.events.some((e) => e.event === "removed")).toBe(true);
    a.stop();
    b.stop();
  });
});

describe("presence", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("is online while a stream was renewed within a cycle; last seen is written once when it lapses", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const wrote: Array<[string, number]> = [];
    const hub = createHub({
      people,
      fanout: createMemoryBus().instance(),
      lastSeen: { write: async (u: string, at: number) => void wrote.push([u, at]) },
    });
    hub.start();
    const opened = Date.now();
    const d = device(hub, "ann", [POND]);
    await d.ready;
    expect(hub.presenceOf("ann")).toEqual({ online: true, devices: 1 });

    await vi.advanceTimersByTimeAsync(MAX_AGE_MS); // the hub ends it at 40 s: no replacement came
    expect(d.ended).toBe(true);
    expect(d.events.some((e) => e.event === "bye")).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000); // 44 s: still inside the cycle
    expect(hub.presenceOf("ann").online).toBe(true);
    expect(wrote).toEqual([]);

    await vi.advanceTimersByTimeAsync(7_000); // lapsed
    expect(hub.presenceOf("ann").online).toBe(false);
    expect(wrote).toEqual([["ann", opened]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wrote).toHaveLength(1); // once, never rewritten
    hub.stop();
  });

  it("a renewal keeps a device online, and last seen waits for the account's last device", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const wrote: Array<[string, number]> = [];
    const hub = createHub({
      people,
      fanout: createMemoryBus().instance(),
      lastSeen: { write: async (u: string, at: number) => void wrote.push([u, at]) },
    });
    hub.start();
    await device(hub, "ann", [POND], "phone").ready;
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(35_000);
      await device(hub, "ann", [POND], "mac").ready; // the Mac renews every 35 s; the phone does not
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.presenceOf("ann")).toEqual({ online: true, devices: 1 }); // the phone lapsed, the Mac did not
    expect(wrote).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.presenceOf("ann").online).toBe(false);
    expect(wrote).toHaveLength(1);
    hub.stop();
  });

  it("with two instances, only the one that took the last renewal writes last seen", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const bus = createMemoryBus();
    const wrote: string[] = [];
    const lastSeen = (who: string) => ({ write: async () => void wrote.push(who) });
    const a = createHub({ people, fanout: bus.instance(), instanceId: "A", lastSeen: lastSeen("A") });
    const b = createHub({ people, fanout: bus.instance(), instanceId: "B", lastSeen: lastSeen("B") });
    a.start();
    b.start();
    await device(a, "ann", [POND], "mac").ready;
    await vi.advanceTimersByTimeAsync(35_000);
    await device(b, "ann", [POND], "mac").ready; // the renewal landed on the other instance
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wrote).toEqual(["B"]);
    a.stop();
    b.stop();
  });
});

describe("the device client against the hub", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  /** A fetch that opens streams on the real hub: each call is one request; `fail` makes the service unreachable. */
  function service(hub: any, userId: string) {
    const requests: string[] = [];
    let open = 0;
    let peak = 0;
    const state = { fail: false };
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (state.fail) throw new Error("down");
      const ponds = new URL(url).searchParams.getAll("pond");
      const enc = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      let finished = false;
      const stop = () => {
        if (finished) return;
        finished = true;
        open--;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      open++;
      peak = Math.max(peak, open);
      const conn = await hub.open({
        userId,
        deviceId: "dev",
        ponds,
        send: (event: string | null, data: unknown) =>
          finished ||
          controller.enqueue(enc.encode(event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : ": hb\n\n")),
        end: stop,
      });
      init?.signal?.addEventListener("abort", () => {
        hub.finish(conn, false);
        stop();
      });
      return new Response(body, { status: 200 });
    };
    return { fetchImpl, requests, state, open: () => open, peak: () => peak, kill: () => void (state.fail = true) };
  }

  /** A change feed in memory: every write gets the next seq and notifies the hub like the relay would. */
  function feed(bus: any) {
    const log: FeedChange[] = [];
    const reads: Array<number | "head"> = [];
    return {
      log,
      reads,
      write: async (id: string) => {
        log.push({ seq: log.length + 1, kind: "room", id, doc: { box: id, sig: "s", device: "d", at: 1 } });
        await bus.publish(noticeText(POND, log.length));
      },
      changes: async (_pond: string, since: number | "head") => {
        reads.push(since);
        if (since === "head") return { changes: [], next: log.length, more: false };
        return { changes: log.filter((c) => c.seq > since), next: log.length, more: false };
      },
    };
  }

  function client(extra: Partial<LiveClientOptions> & Pick<LiveClientOptions, "fetch" | "changes">) {
    const seen: number[] = [];
    const states: string[] = [];
    const c = new LiveClient({
      baseUrl: "https://live.test",
      headers: { "x-squeak-account": "t" },
      deviceId: "dev",
      ponds: () => [POND],
      onChanges: (_p, list) => seen.push(...list.map((x) => x.seq)),
      onState: (s) => states.push(s),
      random: () => 1,
      ...extra,
    });
    return { c, seen, states };
  }

  it("hands over at 35 s with no gap: notices written every second through three renewals all arrive, once each", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const svc = service(hub, "ann");
    const f = feed(bus);
    const { c, seen, states } = client({ fetch: svc.fetchImpl, changes: f.changes, cursors: new Map([[POND, 0]]) });
    c.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(c.state).toBe("live");

    for (let t = 0; t < 120; t++) {
      await f.write(`d${t}`);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1)); // every seq, in order, none twice
    expect(states).toEqual(["live"]); // never reconnecting
    expect(svc.requests.filter((u) => u.includes("/live"))).toHaveLength(4); // 0 s, 35 s, 70 s, 105 s
    expect(svc.peak()).toBe(2); // overlapped, never more
    expect(svc.open()).toBe(1);
    c.stop();
    hub.stop();
  });

  it("falls back to a 30 s feed poll while the stream is down, shows Reconnecting, and catches up when it returns", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const svc = service(hub, "ann");
    svc.state.fail = true;
    const f = feed(bus);
    await f.write("early"); // seq 1, before the device ever connected
    const { c, seen, states } = client({ fetch: svc.fetchImpl, changes: f.changes, cursors: new Map([[POND, 1]]) });
    c.start();
    expect(c.state).toBe("reconnecting");

    await f.write("while-down-1");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen).toEqual([]); // not before 30 s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen).toEqual([2]); // the poll read it
    await f.write("while-down-2");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual([2, 3]);
    expect(c.state).toBe("reconnecting");

    svc.state.fail = false; // the service is back: the next retry connects
    await f.write("missed-by-everyone");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(c.state).toBe("live");
    expect(seen).toEqual([2, 3, 4]); // caught up on the first hello, once
    expect(states).toEqual(["live"]); // it started in Reconnecting and said so only when that changed
    // Live again: a poll tick makes no request.
    const reads = f.reads.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.reads.length).toBe(reads);
    c.stop();
    hub.stop();
  });

  it("costs an idle device one open stream and no requests: ten minutes of silence, only stream renewals", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const svc = service(hub, "ann");
    const f = feed(bus);
    const { c } = client({ fetch: svc.fetchImpl, changes: f.changes, cursors: new Map([[POND, 0]]) });
    c.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(f.reads).toEqual([]); // no /changes, no poll, nothing but the stream
    expect(svc.requests.every((u) => u.startsWith("https://live.test/live?"))).toBe(true);
    expect(svc.requests.length).toBe(Math.floor((10 * 60_000) / 35_000) + 1); // one renewal per 35 s
    expect(svc.open()).toBe(1);
    expect(svc.peak()).toBeLessThanOrEqual(2);
    expect(hub.stats().connections).toBe(1);
    c.stop();
    hub.stop();
  });

  it("a Room post costs one notice and one small read per other watching device", async () => {
    // Device side: two other devices watching; each gets the notice and reads the feed once (one page).
    const people = fakePeople();
    people.add(POND, "ann");
    people.add(POND, "bob");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const f = feed(bus);
    const mk = (user: string) => {
      const svc = service(hub, user);
      return { svc, ...client({ fetch: svc.fetchImpl, changes: f.changes, cursors: new Map([[POND, 0]]) }) };
    };
    const ann = mk("ann");
    const bob = mk("bob");
    ann.c.start();
    bob.c.start();
    await vi.advanceTimersByTimeAsync(100);
    await f.write("post1");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reads).toEqual([0, 0]); // one small read each
    expect(ann.seen).toEqual([1]);
    expect(bob.seen).toEqual([1]);
    ann.c.stop();
    bob.c.stop();
    hub.stop();
  });
});

describe("the relay side", () => {
  it("a Room post is one stamped write and one short notice", async () => {
    const published: string[] = [];
    const rows = new Map<string, string>();
    const k = (pk: string, d: string) => `${pk}\u0000${d}`;
    const store = {
      ready: async () => true,
      get: async (pk: string, d: string) => rows.get(k(pk, d)) ?? null,
      put: async (pk: string, d: string, j: string) => void rows.set(k(pk, d), j),
      del: async (pk: string, d: string) => void rows.delete(k(pk, d)),
      list: async () => [],
      claim: async (pk: string, d: string, j: string) => (rows.has(k(pk, d)) ? false : (rows.set(k(pk, d), j), true)),
      range: async (pk: string, after: string | null) =>
        [...rows]
          .filter(([key]) => key.startsWith(`${pk}\u0000`))
          .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json }))
          .filter((r) => after === null || r.doc > after)
          .sort((x, y) => (x.doc < y.doc ? -1 : 1)),
    };
    const relay = createRelay({
      key: KEY,
      store,
      streams: {
        channelId: async () => null,
        liveChannelId: async () => "live-chan",
        publish: async (id: string, text: string) => void published.push(`${id} ${text}`),
        token: async () => ({}),
      },
    });
    const req: any = new EventEmitter();
    req.method = "PUT";
    req.url = `/server/squeak_relay/doc?path=${encodeURIComponent(`channels/${POND}/room/post1`)}`;
    req.headers = { "x-squeak-relay": KEY };
    let status = 0;
    const done = relay(req, { writeHead: (s: number) => void (status = s), end: () => undefined } as any);
    setImmediate(() => {
      req.emit("data", Buffer.from(JSON.stringify({ doc: { box: "b", sig: "s", device: "d", at: 1 } })));
      req.emit("end");
    });
    await done;
    expect(status).toBe(204);
    expect(published).toEqual([`live-chan ${noticeText(POND, 1)}`]);
  });
});

describe("the HTTP service", () => {
  it("authenticates by account token or Mac key, streams events, refuses others", async () => {
    const people = fakePeople();
    people.add(POND, "ann");
    const bus = createMemoryBus();
    const hub = createHub({ people, fanout: bus.instance() });
    hub.start();
    const tenants = {
      authenticate: async (k: string) => (k === "m".repeat(43) ? { userId: "ann", macId: "mac1" } : null),
    };
    const server = createLiveServer({
      hub,
      auth: createAuth({ key: KEY, scoped, tenants }),
      people: { ...people, membersOf: async () => [] },
      lastSeen: { read: async () => null },
      log: () => undefined,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const token = scoped.issueAppToken(KEY, "ann", "ann@x.co", Date.now(), 60_000).token;
      expect((await fetch(`${base}/live?pond=${POND}`, { headers: { "x-squeak-device": "d1" } })).status).toBe(401);
      expect(
        (await fetch(`${base}/live?pond=${POND}`, { headers: { "x-squeak-account": "bad", "x-squeak-device": "d1" } }))
          .status,
      ).toBe(401);
      expect((await fetch(`${base}/live?pond=${POND}`, { headers: { "x-squeak-account": token } })).status).toBe(400);

      const abort = new AbortController();
      const res = await fetch(`${base}/live?pond=${POND}&pond=${OTHER}`, {
        headers: { "x-squeak-account": token, "x-squeak-device": "d1" },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      while (!text.includes("hello")) text += dec.decode((await reader.read()).value);
      expect(text).toContain(`"refused":["${OTHER}"]`);
      await bus.publish(noticeText(POND, 5));
      while (!text.includes("notice")) text += dec.decode((await reader.read()).value);
      expect(text).toContain(`event: notice\ndata: {"pond":"${POND}","seq":5,"kind":"room"}`);

      // A disconnect closes the connection in the hub.
      expect(hub.stats().connections).toBe(1);
      abort.abort();
      for (let i = 0; i < 50 && hub.stats().connections; i++) await new Promise((r) => setTimeout(r, 10));
      expect(hub.stats().connections).toBe(0);

      const mac = await fetch(`${base}/live?pond=${POND}`, {
        headers: { "x-squeak-mac-key": "m".repeat(43), "x-squeak-device": "d2" },
        signal: abort.signal.aborted ? new AbortController().signal : undefined,
      });
      expect(mac.status).toBe(200);
      await mac.body!.cancel();
    } finally {
      hub.stop();
      server.closeAllConnections();
      server.close();
    }
  });
});
