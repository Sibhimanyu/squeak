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
  const deps = {
    key: KEY,
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
    queueMicrotask(() => {
      if (typeof init.body === "string") req.emit("data", Buffer.from(init.body));
      req.emit("end");
    });
    await done;
    return new Response(status === 204 ? null : text || "{}", { status });
  };
  return { fetch: fetchLike, rows, calls, failing };
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
        displayName: name,
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
  let code = "";
  // A refused join writes nothing, so a missing file reads as empty.
  const pondsFile = (m: { dir: string }) => {
    const f = path.join(m.dir, "flotilla", "ponds.json");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  };

  beforeAll(async () => {
    pondId = (await A.service.createPond({ name: "Site" })).id;
    code = (await A.service.invite(pondId, "member")).code;
  });

  it("an invite holds the relay's URL, the pond, its key, a secret and a join-only token: no relay key", () => {
    const body = JSON.parse(Buffer.from(code.slice("squeak-pond:".length), "base64url").toString("utf8"));
    expect(code).not.toContain(KEY);
    expect(Buffer.from(code.slice("squeak-pond:".length), "base64url").toString("utf8")).not.toContain(KEY);
    expect(body.l).toEqual({ provider: "catalyst", relayUrl: RELAY_URL });
    expect(Object.keys(body).sort()).toEqual(["e", "jt", "k", "kv", "l", "n", "o", "p", "r", "s", "v"]);
    expect(body.jt).toMatch(/^pj\./);
  });

  it("the join token writes a join request and nothing else", async () => {
    const body = JSON.parse(Buffer.from(code.slice("squeak-pond:".length), "base64url").toString("utf8"));
    const joinOnly = new CatalystStore({ baseUrl: RELAY_URL, pondToken: body.jt, fetch: relay.fetch });
    const doc = { box: "1.x", sig: "s", device: "d", at: 1 };
    await expect(joinOnly.set(`channels/${pondId}/threads/t1`, doc)).rejects.toThrow(/403/);
    await expect(joinOnly.set(`channels/${pondId}/members/m1`, doc)).rejects.toThrow(/403/);
    await expect(joinOnly.set(`channels/${pondId}/keys/m1`, doc)).rejects.toThrow(/403/);
    await expect(joinOnly.set(`channels/${"Z".repeat(22)}/joins/r1`, doc)).rejects.toThrow(/403/);
    await joinOnly.set(`channels/${pondId}/joins/probe`, doc);
    await joinOnly.delete(`channels/${pondId}/joins/probe`);
  });

  it("a joiner keeps no relay key, and the approval delivers a pond token sealed to their key", async () => {
    expect(await B.service.join(code, "Aarav")).toEqual({ pondId, status: "pending" });
    expect(pondsFile(B)).not.toContain(KEY);
    expect(JSON.parse(pondsFile(B)).ponds[pondId]).toMatchObject({
      location: { provider: "catalyst", relayUrl: RELAY_URL },
    });
    const joins = (await A.service.view(pondId)).joins;
    expect(joins).toHaveLength(1);
    await A.service.decideJoin(pondId, joins[0]!.requestId, { approve: true });
    await B.service.refresh(pondId);
    const held = JSON.parse(pondsFile(B)).ponds[pondId];
    expect(held.status).toBe("active");
    expect(held.token.value).toMatch(/^pm\./);
    expect(pondsFile(B)).not.toContain(KEY);
    // Everything B does from here runs on the pond token.
    expect((await B.service.view(pondId)).members.map((m) => m.name).sort()).toEqual(["Aarav", "Sibhi"]);
    await B.service.setPresence(pondId, { viewing: "t" });
    const asB = new CatalystStore({ baseUrl: RELAY_URL, pondToken: held.token.value, fetch: relay.fetch });
    const doc = { box: "1.x", sig: "s", device: "d", at: 1 };
    await expect(asB.set(`channels/${pondId}/members/x`, doc)).rejects.toThrow(/403/);
    await expect(asB.set(`channels/${pondId}/pond/meta`, doc)).rejects.toThrow(/403/);
    await asB.set(`channels/${pondId}/threads/mine`, doc);
    await asB.delete(`channels/${pondId}/threads/mine`);
  });

  it("a web guest gets a guest token: it cannot start threads", async () => {
    const link = await A.service.invite(pondId, "viewer");
    await W.service.join(link.code, "Webby");
    const request = (await A.service.view(pondId)).joins[0]!;
    expect(request).toMatchObject({ name: "Webby", nest: null, client: "web" });
    await A.service.decideJoin(pondId, request.requestId, { approve: true });
    await W.service.refresh(pondId);
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
      displayName: "Sibhi",
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
    await expect(A.service.removeMember(pondId, bId)).rejects.toThrow(/would not end/);
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
    await expect(B.service.view(pondId)).rejects.toThrow();
    // The web guest is untouched.
    const guest = JSON.parse(pondsFile(W)).ponds[pondId].token.value as string;
    await new CatalystStore({ baseUrl: RELAY_URL, pondToken: guest, fetch: relay.fetch }).get(
      `channels/${pondId}/pond/meta`,
    );
  });

  it("without a relay an invite for a Catalyst store is refused rather than carrying the key", async () => {
    const lone = new FlotillaService({
      store: ownerStore,
      supportDir: dir(),
      displayName: "X",
      nest: "x",
      location: ownerLocation,
      storeFor,
    });
    const id = (await lone.createPond({ name: "Lone" })).id;
    await expect(lone.invite(id)).rejects.toThrow(/Catalyst/);
  });

  it("an invite naming Catalyst without a join token, or an old one carrying a key, is refused", async () => {
    const fresh = mk("Late", "late-mac");
    const forged = (l: unknown, jt?: string): string =>
      "squeak-pond:" +
      Buffer.from(
        JSON.stringify({
          v: 1,
          p: pondId,
          k: "a",
          kv: 1,
          o: "o",
          n: "n",
          s: "s",
          e: Date.now() + 1e6,
          r: "member",
          l,
          ...(jt ? { jt } : {}),
        }),
      ).toString("base64url");
    await expect(
      fresh.service.join(forged({ provider: "catalyst", relayUrl: RELAY_URL, relayKey: KEY }), "x"),
    ).rejects.toThrow(/not valid/);
    await expect(
      fresh.service.join(forged({ provider: "catalyst", relayUrl: "https://evil.example/x" }, "pj.a"), "x"),
    ).rejects.toThrow(/not valid/);
    expect(pondsFile(fresh)).not.toContain(KEY);
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

  it("an invite carries the database address, and a join and approval need no relay", async () => {
    const location = { provider: "firebase", databaseUrl: "https://squeak-x-default-rtdb.firebaseio.com" };
    const make = (name: string, owner: boolean) =>
      new FlotillaService({
        store: new RtdbRest(url),
        supportDir: dir(),
        displayName: name,
        nest: `${name}-mac`,
        ...(owner ? { location } : {}),
        storeFor: () => new RtdbRest(url),
      });
    const A = make("A", true);
    const B = make("B", false);
    const pond = await A.createPond({ name: "FB" });
    const { code } = await A.invite(pond.id);
    const body = JSON.parse(Buffer.from(code.slice("squeak-pond:".length), "base64url").toString("utf8"));
    expect(body.l).toEqual(location);
    expect(body.jt).toBeUndefined();
    await B.join(code, "B");
    const [request] = (await A.view(pond.id)).joins;
    await A.decideJoin(pond.id, request!.requestId, { approve: true });
    await B.refresh(pond.id);
    expect((await B.view(pond.id)).members).toHaveLength(2);
    await A.removeMember(pond.id, B.me.id);
    await B.refresh(pond.id);
    await expect(B.view(pond.id)).rejects.toThrow();
  });
});
