/* eslint-disable @typescript-eslint/no-explicit-any -- fake http request and response objects for the relay handler */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatalystStore } from "../cloud/catalyst-store.js";
import type { CloudStore } from "../cloud/store.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { HttpPondRelay } from "./relay.js";
import { FlotillaService } from "./service.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { named } from "./named-account.test-fixture.js";

// The real relay handler (cloud/catalyst-relay) in process, over an in-memory store: the test double for the relay.
const require = createRequire(import.meta.url);
const { createRelay } = require("../../cloud/catalyst-relay/functions/squeak_relay/handler.js") as {
  createRelay(deps: unknown): (req: unknown, res: unknown) => Promise<void>;
};

const KEY = "relay-key-".padEnd(43, "k");
const RELAY_URL = "https://squeak.catalystserverless.in/server/squeak_relay";

function relayFetch() {
  const rows = new Map<string, string>();
  const calls: string[] = [];
  const failing = new Set<string>();
  const signedIn: { user: { userId: string; email: string; name: string } | null } = { user: null };
  const deps = {
    key: KEY,
    currentUser: async () => signedIn.user,
    store: {
      ready: async () => true,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: {
      channelId: async () => "chan",
      pondChannelId: async () => "pond-chan",
      publish: async () => undefined,
      token: async (_id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `tok-${name}`, "wss-id": "w1" }),
    },
  };
  const handler = createRelay(deps);
  const fetchLike = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    calls.push(`${init.method ?? "GET"} ${u.pathname.replace("/server/squeak_relay", "")}`);
    if ([...failing].some((f) => u.pathname.endsWith(f))) return new Response("{}", { status: 503 });
    const req: any = new EventEmitter();
    req.method = init.method ?? "GET";
    req.url = u.pathname + u.search;
    req.headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    let status = 0;
    let text = "";
    const res: any = { writeHead: (s: number) => (status = s), end: (t?: string) => (text = t ?? "") };
    const done = handler(req, res);
    setImmediate(() => {
      if (typeof init.body === "string") req.emit("data", Buffer.from(init.body));
      req.emit("end");
    });
    await done;
    return new Response(status === 204 ? null : text || "{}", { status });
  };
  return { fetch: fetchLike, rows, calls, failing, signedIn };
}

const dirs: string[] = [];
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-scoped-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const nostore = {
  get: async () => null,
  set: async () => undefined,
  list: async () => [],
  delete: async () => undefined,
  watch: () => () => undefined,
} as unknown as CloudStore;

describe("a Catalyst pond hands out scoped tokens, never the relay key", () => {
  const relay = relayFetch();
  const ownerStore = new CatalystStore({ baseUrl: RELAY_URL, relayKey: KEY, fetch: relay.fetch });
  const ownerLocation = { provider: "catalyst", relayUrl: RELAY_URL, relayKey: KEY };
  const storeFor = (loc: unknown, token?: string | null): CloudStore => {
    const l = loc as typeof ownerLocation;
    if (token) return new CatalystStore({ baseUrl: l.relayUrl, pondToken: token, fetch: relay.fetch });
    if (l.relayKey) return new CatalystStore({ baseUrl: l.relayUrl, relayKey: l.relayKey, fetch: relay.fetch });
    throw new Error("no access");
  };
  const mk = (name: string, nest: string | null, owner = false): { dir: string; service: FlotillaService } => {
    const d = dir();
    return {
      dir: d,
      service: new FlotillaService({
        store: owner ? ownerStore : nostore,
        supportDir: d,
        account: named(name),
        nest,
        ...(owner ? { location: ownerLocation, relay: new HttpPondRelay(RELAY_URL, KEY, relay.fetch) } : {}),
        storeFor,
      }),
    };
  };
  const A = mk("Sibhi", "sibhi-mac", true);
  const B = mk("Aarav", "aarav-mac");
  const W = mk("Webby", null);
  let pondId = "";
  // A Mac that holds no pond yet writes no file, so a missing one reads as empty.
  const pondsFile = (m: { dir: string }) => {
    const f = path.join(m.dir, "flotilla", "ponds.json");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  };

  beforeAll(async () => {
    pondId = (await A.service.createPond({ name: "Site", projectId: "proj-Site" })).id;
  });

  it("a member keeps no relay key, and holds a pond token that is theirs alone", async () => {
    await admitMember(A.service, B.service, pondId, "member");
    expect(pondsFile(B)).not.toContain(KEY);
    expect(JSON.parse(pondsFile(B)).ponds[pondId]).toMatchObject({
      location: { provider: "catalyst", relayUrl: RELAY_URL },
    });
    const held = JSON.parse(pondsFile(B)).ponds[pondId];
    expect(held.status).toBe("active");
    expect(held.token.value).toMatch(/^pm\./);
    // Everything B does from here runs on the pond token.
    expect((await B.service.view(pondId)).members).toHaveLength(2);
    await B.service.setPresence(pondId, { viewing: "t" });
    const asB = new CatalystStore({ baseUrl: RELAY_URL, pondToken: held.token.value, fetch: relay.fetch });
    const doc = { box: "1.x", sig: "s", device: "d", at: 1 };
    await expect(asB.set(`channels/${pondId}/members/x`, doc)).rejects.toThrow(/403/);
    await expect(asB.set(`channels/${pondId}/pond/meta`, doc)).rejects.toThrow(/403/);
    await asB.set(`channels/${pondId}/threads/mine`, doc);
    await asB.delete(`channels/${pondId}/threads/mine`);
  });

  it("a member with no machine (a browser) gets a guest-scope token: it cannot start threads", async () => {
    await admitMember(A.service, W.service, pondId, "viewer");
    const held = JSON.parse(pondsFile(W)).ponds[pondId];
    expect(held.token.value).toMatch(/^pt\./);
    const asW = new CatalystStore({ baseUrl: RELAY_URL, pondToken: held.token.value, fetch: relay.fetch });
    await expect(asW.set(`channels/${pondId}/threads/x`, { box: "1.x", sig: "s", device: "d", at: 1 })).rejects.toThrow(
      /403/,
    );
  });

  it("the owner renews a token before it lapses, and the member keeps reading", async () => {
    const before = relay.calls.filter((c) => c === "POST /pond-token").length;
    const near = new FlotillaService({
      store: ownerStore,
      supportDir: A.dir,
      account: named("Sibhi"),
      nest: "sibhi-mac",
      location: ownerLocation,
      relay: new HttpPondRelay(RELAY_URL, KEY, relay.fetch),
      storeFor,
      now: () => Date.now() + 28 * 24 * 3600_000,
    });
    await near.refresh(pondId);
    expect(relay.calls.filter((c) => c === "POST /pond-token").length).toBeGreaterThan(before);
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).members).toHaveLength(3);
  });

  it("a removal that cannot revoke fails and leaves the member in", async () => {
    relay.failing.add("/pond-revoke");
    const bId = B.service.me.id;
    await expect(A.service.removeMember(pondId, bId)).rejects.toThrow(/couldn't end that member/);
    relay.failing.delete("/pond-revoke");
    expect((await A.service.view(pondId)).members.map((m) => m.id)).toContain(bId);
  });

  it("a removed member's token stops working", async () => {
    const held = JSON.parse(pondsFile(B)).ponds[pondId].token.value as string;
    const asB = new CatalystStore({ baseUrl: RELAY_URL, pondToken: held, fetch: relay.fetch });
    await asB.get(`channels/${pondId}/pond/meta`);
    await A.service.removeMember(pondId, B.service.me.id);
    await expect(asB.get(`channels/${pondId}/pond/meta`)).rejects.toThrow(/401/);
    await expect(
      asB.set(`channels/${pondId}/presence/x`, { box: "1.x", sig: "s", device: "d", at: 1 }),
    ).rejects.toThrow(/401/);
    // The removed member is told, in a sentence and a status: never a 401.
    expect((await B.service.view(pondId)).pond).toMatchObject({
      status: "removed",
      statusLine: expect.stringContaining("You were removed from"),
    });
    expect((await B.service.list())[0]).toMatchObject({ status: "removed" });
    // The web guest is untouched.
    const guest = JSON.parse(pondsFile(W)).ponds[pondId].token.value as string;
    await new CatalystStore({ baseUrl: RELAY_URL, pondToken: guest, fetch: relay.fetch }).get(
      `channels/${pondId}/pond/meta`,
    );
  });
});

describe("a Firebase store keeps working, with no tokens", () => {
  let rtdb: FakeRtdb;
  let url = "";
  beforeAll(async () => {
    rtdb = new FakeRtdb();
    url = await rtdb.start();
  });
  afterAll(async () => {
    await rtdb.stop();
  });

  it("a member is let in and removed with no relay", async () => {
    const location = { provider: "firebase", databaseUrl: "https://squeak-x-default-rtdb.firebaseio.com" };
    const make = (name: string, owner: boolean) =>
      new FlotillaService({
        store: new RtdbRest(url),
        supportDir: dir(),
        account: named(name),
        nest: `${name}-mac`,
        ...(owner ? { location } : {}),
        storeFor: () => new RtdbRest(url),
      });
    const A = make("A", true);
    const B = make("B", false);
    const pond = await A.createPond({ name: "FB", projectId: "proj-FB" });
    await admitMember(A, B, pond.id, "member");
    expect((await B.view(pond.id)).members).toHaveLength(2);
    await A.removeMember(pond.id, B.me.id);
    await B.refresh(pond.id);
    expect((await B.view(pond.id)).pond.status).toBe("removed");
  });
});
