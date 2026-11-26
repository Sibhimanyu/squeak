/* eslint-disable @typescript-eslint/no-explicit-any -- the relay is untyped CommonJS served in-process */
// The real relay (handler.js, with the people tables, the change feed and a Stratus bucket in memory, and the live hub on its
// notice bus) served over HTTP in-process, and Macs wired the way a daemon builds them (src/flotilla/index.ts): HttpPondRelay,
// HttpPondInvites, CatalystStore, FlotillaService, FlotillaBridge. Used by the journeys that must prove the Owner's Mac and an
// invited person's devices agree through the relay's one invite record. Every request a device makes is counted (`requests`),
// the relay's own clock can run ahead (`skew`), and the Owner's Mac can be marked away (`owner`).
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";

import { randomId } from "./crypto.js";
import type { StreamSocket } from "../cloud/catalyst-store.js";
import { buildMac, type RelayMac, type TestUser } from "./relay-mac.test-fixture.js";
export type { RelayMac, TestUser };

const require = createRequire(import.meta.url);
const fn = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const live = new URL("../../cloud/catalyst-relay/live/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const { createMemoryBucket } = require(`${fn}blob-memory.js`);
const { createLiveNotices, withRemovalNotice } = require(`${fn}live-notice.js`);
const peopleSchema = require(`${fn}people-schema.json`);
const { createServer } = require("../../cloud/catalyst-relay/appsail/server.js");
const { createHub } = require(`${live}hub.js`);
const { createMemoryBus } = require(`${live}fanout.js`);

const RELAY_KEY = "k".repeat(43);
export const BASE = "https://squeak-relay.development.catalystappsail.in";
const SHARED_CHANNEL = "shared-stream-1";
const LIVE_CHANNEL = "squeak_live";

/** Catalyst NoSQL as the relay's store sees it, with the insert-only `claim` and ordered `range` the change feed needs. */
function numberingStore() {
  const rows = new Map<string, string>();
  const k = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const inPk = (pk: string) =>
    [...rows]
      .filter(([key]) => key.startsWith(`${pk}\u0000`))
      .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json }))
      .sort((a, b) => (a.doc < b.doc ? -1 : 1));
  return {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(k(pk, doc)) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(k(pk, doc), json),
    del: async (pk: string, doc: string) => void rows.delete(k(pk, doc)),
    list: async (pk: string) => inPk(pk),
    claim: async (pk: string, doc: string, json: string) => {
      if (rows.has(k(pk, doc))) return false;
      rows.set(k(pk, doc), json);
      return true;
    },
    range: async (pk: string, after: string | null, limit: number) =>
      inPk(pk)
        .filter((r) => after === null || r.doc > after)
        .slice(0, limit),
  };
}

class MemoryStreams {
  readonly sockets = new Set<FakeSocket>();
  /** Every message the relay published, to either channel: the cost budget "one notice per write". */
  readonly published: Array<[string, string]> = [];
  readonly bus = createMemoryBus();
  private n = 0;
  deps = {
    channelId: async () => SHARED_CHANNEL,
    liveChannelId: async () => LIVE_CHANNEL,
    pondChannelId: async () => null,
    publish: async (id: string, text: string) => {
      this.published.push([id, text]);
      if (id === LIVE_CHANNEL) return this.bus.publish(text);
      for (const s of this.sockets) if (s.channel === id) s.deliver(text, ++this.n);
    },
    token: async (id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `${id}|${name}`, "wss-id": "w1" }),
  };
  socket = (url: string): StreamSocket => new FakeSocket(this, url);
}

class FakeSocket implements StreamSocket {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly channel: string;
  constructor(
    private readonly hub: MemoryStreams,
    url: string,
  ) {
    this.channel = decodeURIComponent(new URL(url).searchParams.get("key") ?? "").split("|")[0]!;
    hub.sockets.add(this);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ mtype: "0" }) }), 0);
  }
  send(): void {}
  close(): void {
    this.hub.sockets.delete(this);
  }
  deliver(text: string, n: number): void {
    this.onmessage?.({
      data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { data: text, streamingId: String(n) } } }),
    });
  }
}

export interface Seen {
  who: string;
  method: string;
  route: string;
}

/** One relay (with people tables and a mail sink), and the Macs signed in to it. `stop()` closes it and removes the files. */
export class RelayWorld {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  /** Every request a Mac or browser made to the relay, in order: the journey's cost budgets count these. */
  readonly requests: Seen[] = [];
  /** Milliseconds the relay's own clock runs ahead (invites expire by it). */
  skew = 0;
  /** Who the Owner's Mac is and whether it is running, as every Mac's presence read says. */
  readonly owner = { id: "", away: false };
  readonly streams = new MemoryStreams();
  readonly bucket = createMemoryBucket();
  /** The live hub (`squeak-live`) on the relay's people tables and its notice bus. */
  hub!: ReturnType<typeof createHub>;
  private readonly servers: Array<ReturnType<typeof createServer>> = [];
  readonly dirs: string[] = [];
  deviceUrl = "";
  private functionUrl = "";

  /** The relay's address for the calls a Mac makes with its own key (the journey's `relayUrl`). */
  get relayUrl(): string {
    return this.deviceUrl;
  }

  /** What only an in-process relay can do (people-journey.test-fixture.ts, `JourneyWorld.double`). */
  readonly double = {
    advanceClock: (ms: number) => void (this.skew += ms),
    mailTo: (email: string) => this.sent.filter((m) => m.to.toLowerCase() === email.toLowerCase()).length,
    watch: (userId: string, deviceId: string, ponds: string[]) => this.watch(userId, deviceId, ponds),
    published: () => this.streams.published.filter(([id]) => id === LIVE_CHANNEL).length,
  };

  static async start(): Promise<RelayWorld> {
    const w = new RelayWorld();
    const people = withRemovalNotice(
      createPeople({ tables: createMemoryTables(peopleSchema), now: () => Date.now() + w.skew }),
      createLiveNotices(w.streams.deps),
    );
    w.hub = createHub({ people, fanout: w.streams.bus.instance() });
    w.hub.start();
    const common = {
      key: RELAY_KEY,
      store: numberingStore(),
      streams: w.streams.deps,
      blobBucket: w.bucket,
      now: () => Date.now() + w.skew,
      hosted: true,
      sharedNotice: true,
      log: () => {},
      usageCache: new Map(),
      ownerCache: new Map(),
      people,
      mail: { send: async (m: { to: string; subject: string; text: string }) => void w.sent.push(m) },
    };
    const asFunction = (req: any, res: any) => {
      const who = req.headers["x-test-user"];
      const user = who ? (JSON.parse(String(who)) as TestUser) : null;
      return createRelay({ ...common, currentUser: async () => user })(req, res);
    };
    const asAppSail = (req: any, res: any) => createRelay({ ...common, currentUser: async () => null })(req, res);
    w.functionUrl = await w.listen(createServer({ handle: asFunction, log: () => {} }));
    w.deviceUrl = await w.listen(createServer({ handle: asAppSail, log: () => {}, noCatalystUsers: true }));
    return w;
  }

  private async listen(server: ReturnType<typeof createServer>) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    this.servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.hub.stop();
    for (const s of this.servers) {
      s.closeAllConnections?.();
      s.close();
    }
    for (const d of this.dirs) fs.rmSync(d, { recursive: true, force: true });
  }

  /** The daemon's `fetch` for a Catalyst address: the https relay URL goes to the local server. */
  private toLocal = (input: string, who: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    this.requests.push({ who, method: init?.method ?? "GET", route: u.pathname });
    return fetch(`${this.deviceUrl}${u.pathname}${u.search}`, init);
  };

  /** The requests made since `from` (a `requests.length` taken earlier), optionally by one device. */
  since(from: number, who?: string): Seen[] {
    return this.requests.slice(from).filter((r) => who === undefined || r.who === who);
  }

  /** A signed-in person's account token, as a browser holds it. */
  async accountToken(user: TestUser): Promise<string> {
    const res = await fetch(`${this.functionUrl}/account/app-token`, {
      method: "POST",
      headers: { "x-test-user": JSON.stringify(user), "content-type": "application/json" },
      body: "{}",
    });
    return ((await res.json()) as { token: string }).token;
  }

  /** One call to the relay the way a browser makes it (`x-squeak-account`); not counted as a device's request. */
  async web(token: string, route: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return fetch(`${this.deviceUrl}${route}`, {
      method: init.method ?? "GET",
      headers: { "x-squeak-account": token, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  /** A device's open stream to the live hub: the events it was sent, and whether it was ended. */
  async watch(userId: string, deviceId: string, ponds: string[]) {
    const events: Array<{ event: string | null; data: any }> = [];
    let ended = false;
    await this.hub.open({
      userId,
      deviceId,
      ponds,
      send: (event: string | null, data: unknown) => events.push({ event, data }),
      end: () => void (ended = true),
    });
    return {
      events,
      get ended() {
        return ended;
      },
      notices: () =>
        events.filter((e) => e.event === "notice").map((e) => e.data as { pond: string; seq: number; kind: string }),
      refused: () => (events.find((e) => e.event === "hello")?.data.refused ?? []) as string[],
      removed: () => events.some((e) => e.event === "removed"),
    };
  }

  private async signIn(user: TestUser): Promise<string> {
    const token = await this.accountToken(user);
    const provisioned = await fetch(`${this.deviceUrl}/account/macs/provision`, {
      method: "POST",
      headers: { "x-squeak-account": token, "content-type": "application/json" },
      body: JSON.stringify({ macId: `mac${randomId(16)}`, name: `${user.name}'s Mac` }),
    });
    expect(provisioned.status).toBe(200);
    return ((await provisioned.json()) as { key: string }).key;
  }

  /** A signed-in person's Mac (or, with `nest` null, their browser): the same objects a daemon builds. */
  async mac(user: TestUser, nest: string | null = `${user.name}-mac`, label = `${user.name}:${nest ?? "web"}`) {
    return buildMac({
      user,
      nest,
      label,
      key: await this.signIn(user),
      relayUrl: BASE,
      fetch: (input, init) => this.toLocal(input, label, init),
      socket: this.streams.socket,
      owner: this.owner,
      dirs: this.dirs,
    });
  }
}
