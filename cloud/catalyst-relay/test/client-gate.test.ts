// The old-Mac refusal (#133): Pond routes answer 426 "Update Squeak to keep using shared Ponds" to a Mac below the version this
// release ships (or an old Mac that sends no client header but its own key), and to nobody else. The iPhone app and the voice
// add-on (a grant's key under x-squeak-relay, no client header) and the web keep every route they had. Real HTTP, in-process.
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createServer } = require("../appsail/server.js");
const { createRelay } = require(`${fn}handler.js`);
const { createClientGate, isPondRoute, parseClient } = require(`${fn}client-gate.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const MAC_KEY = "m".repeat(43);
const POND = "P".repeat(32);
const SENTENCE = "Update Squeak to keep using shared Ponds";
const servers: Array<{ close: () => void; closeAllConnections?: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function boot(minMacVersion?: string) {
  const rows = new Map<string, string>();
  const deps = {
    key: KEY,
    minMacVersion,
    store: {
      ready: async () => true,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: { channelId: async () => "c", publish: async () => undefined, token: async () => ({}) },
    people: createPeople({ tables: createMemoryTables(schema) }),
    currentUser: async () => null,
  };
  const server = createServer({ handle: createRelay(deps), log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (route: string, headers: Record<string, string>, method = "GET") =>
    fetch(`${base}${route}`, { method, headers });
}

const POND_ROUTES = [
  `/ponds/${POND}/people`,
  `/ponds/${POND}/invites`,
  `/ponds/${POND}/members/someone/role`,
  "/invites",
  "/account/ponds",
  "/account/pond-devices",
  `/changes?pond=${POND}&since=0`,
  "/blob?id=abc",
  "/live/token",
  `/doc?path=channels/${POND}/room/r1`,
  `/doc?path=channels/${POND}/tcmds/c1`,
  `/list?prefix=channels/${POND}/rposts`,
];

describe("old Mac apps on Pond routes", () => {
  it("refuses a Mac below the minimum, and a Mac that sends no client header, with 426 and the sentence", async () => {
    const call = await boot();
    for (const route of POND_ROUTES) {
      for (const headers of [
        { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": "mac/2.34.8" },
        { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": "mac/1.9.0" },
        { "x-squeak-mac-key": MAC_KEY },
      ]) {
        const r = await call(route, headers);
        expect([route, r.status]).toEqual([route, 426]);
        expect(await r.json()).toEqual({ error: "update-required", message: SENTENCE });
      }
    }
  });

  it("lets the current Mac, a newer one and a dev build through (whatever the route then says)", async () => {
    const call = await boot();
    for (const client of ["mac/2.35.0", "mac/2.35.1", "mac/3.0.0", "mac/2.35.0-beta", "mac/dev"]) {
      for (const route of POND_ROUTES) {
        const r = await call(route, { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": client });
        expect([client, route, r.status === 426]).toEqual([client, route, false]);
      }
    }
  });

  it("never refuses the iPhone app or the voice add-on: a grant's key under x-squeak-relay, no client header, its own routes", async () => {
    const call = await boot();
    const phone = { "x-squeak-relay": MAC_KEY };
    for (const route of [
      `/doc?path=channels/${POND}/state/d1`,
      `/doc?path=channels/${POND}/commands/c1`,
      `/doc?path=channels/${POND}/live/l1`,
      `/doc?path=channels/${POND}/media/m1`,
      `/doc?path=channels/${POND}/voice/v1`,
      `/doc?path=channels/${POND}/pairing/p1`,
      `/doc?path=channels/${POND}/devreqs/d1`,
      `/doc?path=channels/${POND}/hist/h1`,
      `/list?prefix=channels/${POND}/results`,
      "/token",
      "/account/devices",
      "/account/avatar",
    ]) {
      expect([route, (await call(route, phone)).status === 426]).toEqual([route, false]);
    }
    // Even a phone-shaped call to a Pond route is the relay's own rules to answer, not this gate's.
    expect((await call(`/changes?pond=${POND}&since=0`, phone)).status).not.toBe(426);
    // And an old Mac's own phone-channel traffic (a Mac key, no header) is not a Pond route either.
    expect((await call(`/doc?path=channels/${POND}/state/d1`, { "x-squeak-mac-key": MAC_KEY })).status).not.toBe(426);
    expect((await call("/token", { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": "mac/2.30.0" })).status).not.toBe(
      426,
    );
  });

  it("never refuses the web: an account token and no client header on the People sheet's routes", async () => {
    const call = await boot();
    for (const route of [`/ponds/${POND}/people`, "/invites", "/account/ponds", "/invites/preview?code=x"]) {
      expect([route, (await call(route, { "x-squeak-account": "t" })).status === 426]).toEqual([route, false]);
    }
  });

  it("answers the public invite page's preview to anyone", async () => {
    const call = await boot();
    expect((await call("/invites/preview?code=x", {})).status).not.toBe(426);
  });

  it("takes its minimum from SQUEAK_MIN_MAC_VERSION; 'off' turns the gate off", async () => {
    const raised = await boot("2.36.0");
    expect(
      (await raised(`/ponds/${POND}/people`, { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": "mac/2.35.0" })).status,
    ).toBe(426);
    const lowered = await boot("2.30.0");
    expect(
      (await lowered(`/ponds/${POND}/people`, { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": "mac/2.34.8" })).status,
    ).not.toBe(426);
    const off = await boot("off");
    expect((await off(`/ponds/${POND}/people`, { "x-squeak-mac-key": MAC_KEY })).status).not.toBe(426);
  });
});

describe("the gate's parts", () => {
  it("reads mac/<version>, tolerates a dev build, and rejects junk", () => {
    expect(parseClient("mac/2.34.8")).toEqual({ kind: "mac", version: [2, 34, 8] });
    expect(parseClient("mac/2.35")).toEqual({ kind: "mac", version: [2, 35, 0] });
    expect(parseClient("mac/dev")).toEqual({ kind: "mac", version: null });
    expect(parseClient("ios/1.30.0")).toEqual({ kind: "ios", version: [1, 30, 0] });
    expect(parseClient("nonsense")).toBeNull();
    expect(parseClient(undefined)).toBeNull();
  });

  it("knows a Pond route from a phone-channel one", () => {
    const u = (s: string) => new URL(s, "http://relay");
    expect(isPondRoute("/doc", u(`/doc?path=channels/${POND}/room/x`))).toBe(true);
    expect(isPondRoute("/doc", u(`/doc?path=channels/${POND}/state/x`))).toBe(false);
    expect(isPondRoute("/list", u(`/list?prefix=channels/${POND}/rtasks`))).toBe(true);
    expect(isPondRoute("/token", u("/token"))).toBe(false);
    expect(isPondRoute("/account/macs/provision", u("/account/macs/provision"))).toBe(false);
  });

  it("only another client kind is never an old Mac", () => {
    const gate = createClientGate();
    const req = (h: Record<string, string>) => ({ headers: h });
    const url = new URL(`/ponds/${POND}/people`, "http://relay");
    expect(gate(req({ "x-squeak-client": "ios/0.1.0" }), `/ponds/${POND}/people`, url)).toBe(false);
    expect(gate(req({ "x-squeak-client": "mac/2.34.8" }), `/ponds/${POND}/people`, url)).toBe(true);
  });
});
