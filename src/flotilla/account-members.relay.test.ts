/* eslint-disable @typescript-eslint/no-explicit-any -- reaches the service's private store and the relay's untyped CommonJS */
// Members are accounts (docs/ponds.md): a pond member is a Squeak account, not one device. Everything runs over the REAL
// relay code (handler.js served in-process, in-memory NoSQL and Data Streams standing in for Catalyst's services), with the
// HttpPondRelay / CatalystStore / FlotillaService / FlotillaBridge a daemon builds, one support directory per device.
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatalystStore, type StreamSocket } from "../cloud/catalyst-store.js";
import { createCloudStore } from "../cloud/config.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId } from "./crypto.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { FakeHost, session } from "./journey-support.js";
import { HttpPondRelay, RelayRefused } from "./relay.js";
import { FlotillaService } from "./service.js";
import { devicesOf, readMember } from "./types.js";
import { named } from "./named-account.test-fixture.js";

const require = createRequire(import.meta.url);
const fn = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createServer } = require("../../cloud/catalyst-relay/appsail/server.js");
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const peopleSchema = require(`${fn}people-schema.json`);

const RELAY_KEY = "k".repeat(43);
const BASE = "https://squeak-relay.development.catalystappsail.in";
const SHARED_CHANNEL = "shared-stream-1";

/** Catalyst's NoSQL table as the relay's `store` dep sees it. */
const rows = new Map<string, string>();
function memoryStore() {
  return {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
    del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
    list: async (pk: string) =>
      [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.slice(pk.length + 1), json })),
  };
}

/** Catalyst Data Streams in memory: `publish` reaches every open fake socket subscribed with a token for that channel. */
class MemoryStreams {
  readonly sockets = new Set<FakeSocket>();
  readonly published: Array<[string, string]> = [];
  private n = 0;
  deps = {
    channelId: async () => SHARED_CHANNEL,
    pondChannelId: async () => null,
    publish: async (id: string, text: string) => {
      this.published.push([id, text]);
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

interface TestUser {
  userId: string;
  email: string;
  name: string;
}

const servers: Array<ReturnType<typeof createServer>> = [];
let deviceUrl = "";
let functionUrl = "";
const streams = new MemoryStreams();
const dirs: string[] = [];

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  const store = memoryStore();
  const common = {
    key: RELAY_KEY,
    store,
    streams: streams.deps,
    hosted: true,
    people: createPeople({ tables: createMemoryTables(peopleSchema) }),
    sharedNotice: true,
    log: () => {},
    usageCache: new Map(),
    ownerCache: new Map(),
  };
  // The function: Hosted login. Whoever the test names in x-test-user is the signed-in Catalyst user.
  const asFunction = (req: any, res: any) => {
    const who = req.headers["x-test-user"];
    const user = who ? (JSON.parse(String(who)) as TestUser) : null;
    return createRelay({ ...common, currentUser: async () => user })(req, res);
  };
  // AppSail: no Catalyst user, ever (index.js, SQUEAK_NO_CATALYST_USER=1).
  const asAppSail = (req: any, res: any) => createRelay({ ...common, currentUser: async () => null })(req, res);
  functionUrl = await listen(createServer({ handle: asFunction, log: () => {} }));
  deviceUrl = await listen(createServer({ handle: asAppSail, log: () => {}, noCatalystUsers: true }));
});
afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The daemon's `fetch` for a Catalyst address: the https relay URL goes to the local server. */
const toLocal =
  (origin: string) =>
  (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    return fetch(`${origin}${u.pathname}${u.search}`, init);
  };

/** A signed-in person: an app token minted by the function, then a per-Mac key from the device origin's provision route. */
async function signIn(user: TestUser) {
  const tokenRes = await fetch(`${functionUrl}/account/app-token`, {
    method: "POST",
    headers: { "x-test-user": JSON.stringify(user), "content-type": "application/json" },
    body: "{}",
  });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };
  const macId = `mac${randomId(16)}`;
  const provisioned = await fetch(`${deviceUrl}/account/macs/provision`, {
    method: "POST",
    headers: { "x-squeak-account": token, "content-type": "application/json" },
    body: JSON.stringify({ macId, name: `${user.name}'s Mac` }),
  });
  expect(provisioned.status).toBe(200);
  const { key } = (await provisioned.json()) as { key: string };
  return { macId, key };
}

interface DeviceOptions {
  /** null: a browser's way of being a member (no machine of its own). */
  nest?: string | null;
}

type Mac = Awaited<ReturnType<typeof mac>>;
async function mac(user: TestUser, options: DeviceOptions = {}) {
  const { key } = await signIn(user);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-accounts-"));
  dirs.push(dir);
  const doFetch = toLocal(deviceUrl);
  const location = { provider: "catalyst" as const, relayUrl: BASE, relayKey: key, hosted: true as const };
  const relay = new HttpPondRelay(BASE, key, doFetch, true);
  const nest = options.nest === undefined ? `${user.name}-mac` : options.nest;
  const account = {
    name: () => user.name,
    email: () => user.email,
    names: async (ids: string[]) => relay.names(ids),
  };
  const service = new FlotillaService({
    account,
    store: createCloudStore(location, { fetch: doFetch, socket: streams.socket }),
    supportDir: dir,
    nest,
    location,
    relay,
    wakeDebounceMs: 0,
    wakeMinIntervalMs: 0,
    storeFor: (loc, pondToken) => {
      const at = loc as { provider: string; relayUrl: string; relayKey?: string };
      if (pondToken) {
        return new CatalystStore({
          baseUrl: at.relayUrl,
          pondToken,
          fetch: doFetch,
          socket: streams.socket,
        });
      }
      if (!("relayKey" in at)) throw new Error("This pond has no access on this Mac yet.");
      return createCloudStore(at as typeof location, { fetch: doFetch, socket: streams.socket });
    },
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { dir, service, host, bridge, name: user.name, key, relay, user };
}

const SIBHI: TestUser = { userId: "u-sibhi", email: "sibhi@example.com", name: "Sibhi" };
const AARAV: TestUser = { userId: "u-aarav", email: "aarav@example.com", name: "Aarav" };
const DANA: TestUser = { userId: "u-dana", email: "dana@example.com", name: "Dana" };
const EVE: TestUser = { userId: "u-eve", email: "eve@example.com", name: "Eve" };

const pondOf = (who: Mac, id: string): any => (who.service as any).pondsFile.data.ponds[id];
const membersOf = async (who: Mac, id: string): Promise<Map<string, any>> =>
  (who.service as any).members((who.service as any).pond(id));

/** An account's app token, as the function mints it for a signed-in browser. */
async function accountToken(user: TestUser): Promise<string> {
  const res = await fetch(`${functionUrl}/account/app-token`, {
    method: "POST",
    headers: { "x-test-user": JSON.stringify(user), "content-type": "application/json" },
    body: "{}",
  });
  return ((await res.json()) as { token: string }).token;
}
const asAccount = (token: string, route: string, init: RequestInit = {}) =>
  fetch(`${deviceUrl}${route}`, {
    ...init,
    headers: { "x-squeak-account": token, "content-type": "application/json" },
  });

describe("members are accounts: a second device of the same account joins without an invite", () => {
  let A: Mac; // the owner
  let web: Mac; // Aarav's first device: a browser (no machine)
  let laptop: Mac; // Aarav's Mac, signed in later
  let pondId = "";
  let memberId = "";
  let thread = "";
  let third: Mac;

  beforeAll(async () => {
    A = await mac(SIBHI);
    web = await mac(AARAV, { nest: null });
    const pond = await A.service.createPond({
      name: "Site",
      projectId: "p1",
      gitRemote: "git@github.com:acme/site.git",
    });
    pondId = pond.id;
    await admitMember(A.service, web.service, pondId, "member", { id: AARAV.userId });
    memberId = web.service.me.id;
    A.host.sessions.set("a1", session("a1", { title: "Owner thread" }));
    A.host.say("a1", "user/text", { text: "Start" }, "user");
    thread = (await A.bridge.share(pondId, "a1")).id;
    await A.bridge.flush();
  });

  it("the account's ponds are listed to that account only, and nobody else", async () => {
    const mine = await asAccount(await accountToken(AARAV), "/account/ponds");
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { ponds: Array<{ pondId: string; ownerKey: string; name?: string }> };
    expect(body.ponds).toEqual([{ pondId, ownerKey: A.service.me.publicKey, name: "Site", ownerName: "Sibhi" }]);
    // another account sees none of it
    const eve = await asAccount(await accountToken(EVE), "/account/ponds");
    expect(((await eve.json()) as { ponds: unknown[] }).ponds).toEqual([]);
    // no sign-in, a forged token, a pond token and the operator's key are nobody
    expect((await fetch(`${deviceUrl}/account/ponds`)).status).toBe(401);
    expect((await asAccount("at.u-aarav.9999999999999.YQ.forged", "/account/ponds")).status).toBe(401);
    const pondToken = pondOf(web, pondId).token?.value as string;
    const asPond = await fetch(`${deviceUrl}/account/ponds`, { headers: { "x-squeak-pond-token": pondToken } });
    expect(asPond.status).toBe(401);
    expect((await fetch(`${deviceUrl}/account/ponds`, { headers: { "x-squeak-relay": RELAY_KEY } })).status).toBe(401);
  });

  it("only the pond's own Mac may write the account index", async () => {
    const eve = await mac(EVE);
    const wrong = await fetch(`${deviceUrl}/ponds/${pondId}/members/accounts`, {
      method: "POST",
      headers: { "x-squeak-relay": eve.key, "content-type": "application/json" },
      body: JSON.stringify({ ownerKey: eve.service.me.publicKey, add: [EVE.userId], remove: [] }),
    });
    expect(wrong.status).toBe(403);
    const pondToken = pondOf(web, pondId).token?.value as string;
    const asMember = await fetch(`${deviceUrl}/ponds/${pondId}/members/accounts`, {
      method: "POST",
      headers: { "x-squeak-pond-token": pondToken, "content-type": "application/json" },
      body: JSON.stringify({ ownerKey: "x", add: [EVE.userId], remove: [] }),
    });
    expect(asMember.status).toBe(404);
    expect(((await (await asAccount(await accountToken(EVE), "/account/ponds")).json()) as any).ponds).toEqual([]);
  });

  it("a different account cannot ask for a device, a forged account token is refused, a member cannot write the request itself", async () => {
    const eve = await mac(EVE);
    await expect(
      eve.relay.requestDevice({
        pondId,
        publicKey: eve.service.me.publicKey,
        boxKey: eve.service.me.publicKey,
        client: "mac",
        nest: "x",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await eve.service.syncAccountPonds()).toBe(0);
    const forged = await asAccount("at.u-aarav.9999999999999.YQ.forged", "/account/pond-devices", {
      method: "POST",
      body: JSON.stringify({ pondId, publicKey: eve.service.me.publicKey, client: "mac" }),
    });
    expect(forged.status).toBe(401);
    // the relay-owned request kind is closed to a member's pond token
    const pondToken = pondOf(web, pondId).token?.value as string;
    const put = await fetch(`${deviceUrl}/doc?path=${encodeURIComponent(`channels/${pondId}/devreqs/abc`)}`, {
      method: "PUT",
      headers: { "x-squeak-pond-token": pondToken, "content-type": "application/json" },
      body: JSON.stringify({ doc: { box: "x", sig: "y" } }),
    });
    expect(put.status).toBe(403);
    await A.service.refresh(pondId);
    expect([...(await membersOf(A, pondId)).values()]).toHaveLength(2);
  });

  it("signing in on a Mac picks up the pond: added at once, no invite, code or approval, and it can read and send", async () => {
    laptop = await mac(AARAV);
    expect(await laptop.service.syncAccountPonds()).toBe(1);
    expect((await laptop.service.list()).find((p) => p.id === pondId)).toMatchObject({ status: "pending" });
    const told: string[] = [];
    A.service.on("device-added", (_id: string, m: string) => told.push(m));
    await A.service.refresh(pondId);
    await laptop.service.refresh(pondId);
    const summary = (await laptop.service.list()).find((p) => p.id === pondId)!;
    expect(summary.status).toBe("active");
    // a device is never an event in a pond (#129), though the adoption itself still happened
    expect(told).toEqual([]);
    expect(devicesOf((await membersOf(A, pondId)).get(memberId))).toHaveLength(2);
    // the owner sees a person once; nothing about devices (no count, no Ripple) is in the pond
    const view = await A.service.view(pondId);
    const aarav = view.members.filter((m) => m.name === "Aarav");
    expect(aarav).toHaveLength(1);
    expect(aarav[0]).toMatchObject({ role: "member" });
    expect(aarav[0]).not.toHaveProperty("devices");
    expect(aarav[0]).not.toHaveProperty("ownDevices");
    expect(view.ripples.map((r) => r.text).filter((t) => /device/i.test(t))).toEqual([]);
    // the new Mac reads the owner's thread and its message reaches the owner as Aarav
    expect((await laptop.service.threads(pondId)).some((t) => t.id === thread)).toBe(true);
    expect((await laptop.bridge.message(pondId, thread, "from the laptop")).ok).toBe(true);
    expect((await web.bridge.message(pondId, thread, "from the browser")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
    expect(A.host.sent.map((s) => [s.text, s.author?.name, s.author?.id])).toEqual([
      ["from the laptop", "Aarav", memberId],
      ["from the browser", "Aarav", memberId],
    ]);
    // not even on the person's own row
    expect((await laptop.service.view(pondId)).members.find((m) => m.you)).not.toHaveProperty("ownDevices");
    // asking again changes nothing
    expect(await laptop.service.syncAccountPonds()).toBe(0);
  });

  it("the owner's permissions are the member's, so they hold on every device", async () => {
    await A.service.changeRole(pondId, memberId, "viewer");
    expect(await laptop.bridge.message(pondId, thread, "x")).toMatchObject({ ok: false, state: "refused" });
    expect(await web.bridge.message(pondId, thread, "y")).toMatchObject({ ok: false, state: "refused" });
    await A.service.changeRole(pondId, memberId, "member");
    expect((await laptop.bridge.message(pondId, thread, "back")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
  });

  it("the owner's account is listed for its own Pond only (so its other devices can ask), never as a member's", async () => {
    const mineAfter = (await (await asAccount(await accountToken(SIBHI), "/account/ponds")).json()) as any;
    expect(mineAfter.ponds).toEqual([{ pondId, ownerKey: A.service.me.publicKey, name: "Site", ownerName: "Sibhi" }]);
  });

  it("removing one device rotates the pond key; the other device keeps working and the removed one is refused for good", async () => {
    const before = pondOf(A, pondId).current as number;
    const laptopToken = pondOf(laptop, pondId).token?.value as string;
    await A.service.removeDevice(pondId, memberId, laptop.service.me.id);
    expect(pondOf(A, pondId).current).toBe(before + 1);
    expect(devicesOf((await membersOf(A, pondId)).get(memberId)).map((d) => d.client)).toEqual(["web"]);
    await web.service.refresh(pondId);
    expect(pondOf(web, pondId).current).toBe(before + 1);
    expect((await web.bridge.message(pondId, thread, "still me")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
    await laptop.service.refresh(pondId);
    expect((await laptop.service.list()).find((p) => p.id === pondId)?.status).toBe("removed");
    // its token and its way back are closed
    const list = await fetch(`${deviceUrl}/list?prefix=${encodeURIComponent(`channels/${pondId}/threads`)}`, {
      headers: { "x-squeak-pond-token": laptopToken },
    });
    expect(list.status).toBe(401);
    await expect(
      laptop.relay.requestDevice({
        pondId,
        publicKey: laptop.service.me.publicKey,
        boxKey: laptop.service.me.publicKey,
        client: "mac",
        nest: "x",
      }),
    ).rejects.toMatchObject({ status: 403 });
    // a stranger cannot name a device that is not the member's
    await expect(A.service.removeDevice(pondId, memberId, "nope")).rejects.toThrow("No such device");
  });

  it("a member ends one of their own devices; the owner's Mac does it; the last device is the member", async () => {
    const second = await mac(AARAV);
    expect(await second.service.syncAccountPonds()).toBe(1);
    await A.service.refresh(pondId);
    await second.service.refresh(pondId);
    expect((await second.service.list()).find((p) => p.id === pondId)?.status).toBe("active");
    const before = pondOf(A, pondId).current as number;
    await web.service.removeOwnDevice(pondId, second.service.me.id);
    await A.service.refresh(pondId);
    expect(pondOf(A, pondId).current).toBe(before + 1);
    expect(devicesOf((await membersOf(A, pondId)).get(memberId))).toHaveLength(1);
    // no Pond shows it: neither the member's request nor the owner's removal is a Ripple anyone reads (#129)
    for (const svc of [A.service, web.service]) {
      expect((await svc.view(pondId)).ripples.map((r) => r.text).filter((t) => /device/i.test(t))).toEqual([]);
    }
    await web.service.refresh(pondId);
    await expect(web.service.removeOwnDevice(pondId, web.service.me.id)).rejects.toThrow("only device");
  });

  it("removing the first device on its own leaves the others in; the member id stays", async () => {
    third = await mac(AARAV);
    expect(await third.service.syncAccountPonds()).toBe(1);
    await A.service.refresh(pondId);
    await third.service.refresh(pondId);
    await A.service.removeDevice(pondId, memberId, web.service.me.id);
    const m = (await membersOf(A, pondId)).get(memberId);
    expect(m.primaryRetired).toBe(true);
    expect(devicesOf(m).map((d) => d.id)).toEqual([third.service.me.id]);
    await third.service.refresh(pondId);
    expect((await third.bridge.message(pondId, thread, "carrying on")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
    expect(A.host.sent.at(-1)).toMatchObject({ text: "carrying on", author: { id: memberId } });
    await web.service.refresh(pondId);
    expect((await web.service.list()).find((p) => p.id === pondId)?.status).toBe("removed");
  });

  it("removing the member removes every device, rotates the key and drops the account from the index", async () => {
    const fourth = await mac(AARAV);
    expect(await fourth.service.syncAccountPonds()).toBe(1);
    await A.service.refresh(pondId);
    await fourth.service.refresh(pondId);
    const devices = devicesOf((await membersOf(A, pondId)).get(memberId));
    expect(devices).toHaveLength(2);
    const before = pondOf(A, pondId).current as number;
    await A.service.removeMember(pondId, memberId);
    expect(pondOf(A, pondId).current).toBe(before + 1);
    expect((await membersOf(A, pondId)).has(memberId)).toBe(false);
    // every device's token ends at once
    for (const d of devices) {
      const res = await fetch(`${deviceUrl}/list?prefix=${encodeURIComponent(`channels/${pondId}/threads`)}`, {
        headers: { "x-squeak-pond-token": pondOf(d.id === fourth.service.me.id ? fourth : third, pondId).token?.value },
      });
      expect(res.status).toBe(401);
    }
    await fourth.service.refresh(pondId);
    expect((await fourth.service.list()).find((p) => p.id === pondId)?.status).toBe("removed");
    const mineAfter = (await (await asAccount(await accountToken(AARAV), "/account/ponds")).json()) as any;
    expect(mineAfter.ponds).toEqual([]);
  });
});

describe("members are accounts: leaving a pond marks the account's entry", () => {
  it("pond-leaves flags the entry (idempotent), 403 when not listed, owner's add clears it, remove drops it", async () => {
    const A = await mac(SIBHI);
    const pond = await A.service.createPond({ name: "Leave", projectId: "pl", gitRemote: "git@github.com:acme/l.git" });
    const members = (add: string[], remove: string[]) =>
      fetch(`${deviceUrl}/ponds/${pond.id}/members/accounts`, {
        method: "POST",
        headers: { "x-squeak-relay": A.key, "content-type": "application/json" },
        body: JSON.stringify({ ownerKey: A.service.me.publicKey, name: "Leave", add, remove }),
      });
    expect((await members([AARAV.userId], [])).status).toBe(204);
    const token = await accountToken(AARAV);
    const list = async () => ((await (await asAccount(token, "/account/ponds")).json()) as any).ponds as any[];
    const leave = (t: string, pondId: string) =>
      asAccount(t, "/account/pond-leaves", { method: "POST", body: JSON.stringify({ pondId }) });
    expect(await list()).toEqual([{ pondId: pond.id, ownerKey: A.service.me.publicKey, name: "Leave" }]);
    expect((await leave(token, pond.id)).status).toBe(204);
    expect((await leave(token, pond.id)).status).toBe(204);
    expect(await list()).toEqual([{ pondId: pond.id, ownerKey: A.service.me.publicKey, name: "Leave", left: true }]);
    // not listed: 403; signed out: 401
    expect((await leave(await accountToken(EVE), pond.id)).status).toBe(403);
    expect((await fetch(`${deviceUrl}/account/pond-leaves`, { method: "POST", body: "{}" })).status).toBe(401);
    // a fresh add clears the marker
    await members([AARAV.userId], []);
    expect((await list())[0].left).toBeUndefined();
    // remove clears the entry including the marker
    await leave(token, pond.id);
    await members([], [AARAV.userId]);
    expect(await list()).toEqual([]);
  });
});

describe("members are accounts: what must not attach", () => {
  it("a member who joined signed out has no account to attach devices to", async () => {
    const A = await mac(SIBHI);
    const pond = await A.service.createPond({ name: "Open", projectId: "p2" });
    // a signed-out Mac (no account port): the relay has no sign-in behind its request, so the member has no accountId
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-accounts-"));
    dirs.push(dir);
    const doFetch = toLocal(deviceUrl);
    const anon = new FlotillaService({
      store: null,
      supportDir: dir,
      account: named("Anon"),
      nest: "anon-mac",
      storeFor: (loc, pondToken) =>
        new CatalystStore({
          baseUrl: (loc as any).relayUrl,
          pondToken: pondToken!,
          fetch: doFetch,
          socket: streams.socket,
        }),
    });
    await admitMember(A.service, anon, pond.id, "member");
    const member = [...(await membersOf(A, pond.id)).values()].find((m) => m.role === "member");
    expect(member.accountId).toBeUndefined();
    // a request the relay could only have written for some account never matches it: it is dropped, nothing is added
    const id = anon.me.id;
    rows.set(
      `channels/${pond.id}/devreqs|${id}`,
      JSON.stringify({
        v: 1,
        reqId: id,
        userId: "u-anyone",
        email: "",
        name: "",
        publicKey: anon.me.publicKey,
        boxKey: anon.me.publicKey,
        client: "mac",
        nest: null,
        at: Date.now(),
      }),
    );
    await A.service.refresh(pond.id);
    expect(devicesOf((await membersOf(A, pond.id)).get(member.id))).toHaveLength(1);
    expect(rows.has(`channels/${pond.id}/devreqs|${id}`)).toBe(false);
  });

  it("an old request, a key that is not a point and an id that is not the key's are all dropped", async () => {
    const A = await mac(SIBHI);
    const pond = await A.service.createPond({ name: "Strict", projectId: "p3" });
    const web = await mac(AARAV, { nest: null });
    await admitMember(A.service, web.service, pond.id, "member", { id: AARAV.userId });
    const other = await mac(AARAV);
    const mk = (over: Record<string, unknown>) => ({
      v: 1,
      reqId: other.service.me.id,
      userId: AARAV.userId,
      email: AARAV.email,
      name: "Aarav",
      publicKey: other.service.me.publicKey,
      boxKey: other.service.me.publicKey,
      client: "mac",
      nest: "n",
      at: Date.now(),
      ...over,
    });
    const put = (doc: unknown, id = other.service.me.id) =>
      rows.set(`channels/${pond.id}/devreqs|${id}`, JSON.stringify(doc));
    for (const bad of [
      mk({ at: Date.now() - 25 * 60 * 60_000 }),
      mk({ publicKey: Buffer.alloc(65, 1).toString("base64"), boxKey: Buffer.alloc(65, 1).toString("base64") }),
      mk({ reqId: "someone-elses-id" }),
      mk({ client: "toaster" }),
    ]) {
      put(bad, (bad as any).reqId);
      await A.service.refresh(pond.id);
      expect(devicesOf([...(await membersOf(A, pond.id)).values()].find((m) => m.role === "member")!)).toHaveLength(1);
      rows.delete(`channels/${pond.id}/devreqs|${(bad as any).reqId}`);
    }
    // the right one still works
    put(mk({}));
    await A.service.refresh(pond.id);
    expect(devicesOf([...(await membersOf(A, pond.id)).values()].find((m) => m.role === "member")!)).toHaveLength(2);
  });

  it("at most five devices a minute are added to one pond; the rest wait on the relay", async () => {
    const CAP: TestUser = { userId: "u-cap", email: "cap@example.com", name: "Cap" };
    const A = await mac(SIBHI);
    const pond = await A.service.createPond({ name: "Cap", projectId: "p4" });
    const web = await mac(CAP, { nest: null });
    await admitMember(A.service, web.service, pond.id, "member", { id: CAP.userId });
    const devices: Mac[] = [];
    for (let i = 0; i < 7; i++) devices.push(await mac(CAP));
    for (const d of devices) await d.service.syncAccountPonds();
    await A.service.refresh(pond.id);
    const count = async () =>
      devicesOf([...(await membersOf(A, pond.id)).values()].find((m) => m.role === "member")!).length;
    expect(await count()).toBe(1 + 5);
  });
});

describe("members are accounts: older documents", () => {
  it("a member document with one key and no devices is device number one", () => {
    const old = readMember({
      id: "abc",
      name: "Aarav",
      publicKey: "AAAA",
      role: "member",
      nest: "Aarav-mac",
      addedAt: 1,
    });
    expect(old).not.toBeNull();
    expect(devicesOf(old!).map((d) => [d.id, d.publicKey, d.client])).toEqual([["abc", "AAAA", "mac"]]);
    expect(old).not.toHaveProperty("devices");
  });

  it("a device whose id is not its key's, or that repeats, is not read", () => {
    const m = readMember({
      id: "abc",
      name: "A",
      publicKey: "AAAA",
      role: "member",
      nest: null,
      addedAt: 1,
      devices: [
        { id: "forged", publicKey: "BBBB", boxKey: "BBBB", client: "web", addedAt: 2 },
        { id: "x", publicKey: "BBBB", boxKey: "BBBB", client: "toaster", addedAt: 2 },
      ],
    });
    expect(m?.devices ?? []).toEqual([]);
  });
});

// Devices belong to the account (#129): one list in Settings, removing one cuts it off in every Pond and rotates the keys.
describe("your devices: one account-wide list; removing a device removes it from every pond", () => {
  let owner1: Mac;
  let owner2: Mac;
  let web: Mac;
  let laptop: Mac;
  let pond1 = "";
  let pond2 = "";

  beforeAll(async () => {
    owner1 = await mac(SIBHI);
    owner2 = await mac({ userId: "u-vera", email: "vera@example.com", name: "Vera" });
    web = await mac(DANA, { nest: null });
    pond1 = (
      await owner1.service.createPond({ name: "One", projectId: "p1", gitRemote: "git@github.com:acme/one.git" })
    ).id;
    pond2 = (
      await owner2.service.createPond({ name: "Two", projectId: "p2", gitRemote: "git@github.com:acme/two.git" })
    ).id;
    for (const [owner, id] of [
      [owner1, pond1],
      [owner2, pond2],
    ] as const) {
      await admitMember(owner.service, web.service, id, "member", { id: DANA.userId });
    }
    // what each device's periodic account sync does first: list itself under the account
    await web.service.registerSelf();
  });

  it("a new device shows its ponds at once as Connecting until the owner's Mac seals the key", async () => {
    laptop = await mac(DANA);
    expect(await laptop.service.syncAccountPonds()).toBe(2);
    const rows = await laptop.service.list();
    for (const id of [pond1, pond2]) {
      const row = rows.find((p) => p.id === id)!;
      expect(row).toMatchObject({ status: "pending", connecting: true });
    }
    expect(rows.find((p) => p.id === pond1)!.statusLine).toBe("Connecting: waiting for Sibhi\u2019s Mac");
    expect(rows.find((p) => p.id === pond2)!.statusLine).toBe("Connecting: waiting for Vera\u2019s Mac");
    await owner1.service.refresh(pond1);
    await owner2.service.refresh(pond2);
    await laptop.service.refresh(pond1);
    await laptop.service.refresh(pond2);
    for (const id of [pond1, pond2]) {
      const row = (await laptop.service.list()).find((p) => p.id === id)!;
      expect(row.status).toBe("active");
      expect(row).not.toHaveProperty("connecting");
    }
  });

  it("lists the account's devices (this one marked), the same on every device, and nothing of it is in a pond", async () => {
    const mine = await laptop.service.accountDevices();
    expect(mine.map((d) => [d.kind, d.thisDevice]).sort()).toEqual([
      ["mac", true],
      ["web", false],
    ]);
    const fromWeb = await web.service.accountDevices();
    expect(fromWeb.map((d) => d.deviceId).sort()).toEqual(mine.map((d) => d.deviceId).sort());
    expect(fromWeb.find((d) => d.thisDevice)?.kind).toBe("web");
    // another account's devices are never listed
    const theirs = (await owner1.service.accountDevices()).map((d) => d.deviceId);
    for (const d of mine) expect(theirs).not.toContain(d.deviceId);
    expect((await owner1.service.accountDevices()).filter((d) => d.thisDevice)).toHaveLength(1);
    for (const [svc, id] of [
      [owner1.service, pond1],
      [owner2.service, pond2],
    ] as const) {
      const view = await svc.view(id);
      expect(view.ripples.map((r) => r.text).filter((t) => /device/i.test(t))).toEqual([]);
      expect(JSON.stringify(view.members)).not.toMatch(/device/i);
    }
  });

  it("removing a device cuts it off in every pond at once; each owner's Mac rotates the key when it next looks", async () => {
    const laptopId = laptop.service.me.id;
    const tokens = [pond1, pond2].map((id) => pondOf(laptop, id).token?.value as string);
    const before = [pondOf(owner1, pond1).current, pondOf(owner2, pond2).current] as number[];
    await expect(web.service.removeAccountDevice(web.service.me.id)).rejects.toMatchObject({ status: 409 });
    await web.service.removeAccountDevice(laptopId);
    // refused at once, before any owner's Mac is back
    for (const [i, id] of [pond1, pond2].entries()) {
      const res = await fetch(`${deviceUrl}/list?prefix=${encodeURIComponent(`channels/${id}/threads`)}`, {
        headers: { "x-squeak-pond-token": tokens[i]! },
      });
      expect(res.status).toBe(401);
    }
    expect((await web.service.accountDevices()).map((d) => d.deviceId)).not.toContain(laptopId);
    // the owners' Macs come online: the device is dropped and the key rotates; the person's other device keeps reading
    await owner1.service.refresh(pond1);
    await owner2.service.refresh(pond2);
    expect(pondOf(owner1, pond1).current).toBe(before[0]! + 1);
    expect(pondOf(owner2, pond2).current).toBe(before[1]! + 1);
    const m1 = [...(await membersOf(owner1, pond1)).values()].find((m) => m.accountId === DANA.userId);
    expect(devicesOf(m1).map((d) => d.id)).not.toContain(laptopId);
    await web.service.refresh(pond1);
    await web.service.refresh(pond2);
    expect(pondOf(web, pond1).current).toBe(before[0]! + 1);
    // nothing about it is in either pond
    for (const [svc, id] of [
      [owner1.service, pond1],
      [owner2.service, pond2],
    ] as const) {
      expect((await svc.view(id)).ripples.map((r) => r.text).filter((t) => /device/i.test(t))).toEqual([]);
    }
    // it cannot come back, and a stranger cannot remove it again
    await expect(
      laptop.relay.requestDevice({
        pondId: pond1,
        publicKey: laptop.service.me.publicKey,
        boxKey: laptop.service.me.publicKey,
        client: "mac",
        nest: "x",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(web.service.removeAccountDevice(laptopId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the Owner's own devices (their browser, another Mac) are adopted into their Ponds", () => {
  const OWEN: TestUser = { userId: "u-owen", email: "owen@example.com", name: "Owen" };
  let A: Mac;
  let web: Mac;
  let pondId = "";

  beforeAll(async () => {
    A = await mac(OWEN);
    web = await mac(OWEN, { nest: null });
    pondId = (await A.service.createPond({ name: "Mine", projectId: "owen-1" })).id;
    await A.service.refresh(pondId);
  });

  it("the Owner's account is listed for their own Pond, with the Owner Mac's key", async () => {
    const res = await asAccount(await accountToken(OWEN), "/account/ponds");
    const body = (await res.json()) as { ponds: Array<{ pondId: string; ownerKey: string }> };
    expect(body.ponds.find((p) => p.pondId === pondId)).toMatchObject({ ownerKey: A.service.me.publicKey });
  });

  it("the web's overview says mine and owner for the Owner, from what the Owner's Mac indexed", async () => {
    const res = await asAccount(await accountToken(OWEN), "/account/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ponds: Array<Record<string, unknown>> };
    expect(body.ponds.find((p) => p.pondId === pondId)).toMatchObject({
      name: "Mine",
      ownerName: "Owen",
      ownerKey: A.service.me.publicKey,
      mine: true,
      role: "owner",
      shared: false,
    });
  });

  it("the Owner's browser is let in with every key version; the signing key stays on the one Mac", async () => {
    await A.service.rotateKey(pondId);
    expect(pondOf(A, pondId).current).toBe(2);
    expect(await web.service.syncAccountPonds()).toBe(1);
    await A.service.refresh(pondId);
    await web.service.refresh(pondId);
    expect((await web.service.list()).find((p) => p.id === pondId)?.status).toBe("active");
    expect(Object.keys(pondOf(web, pondId).keys).sort()).toEqual(["1", "2"]);
    const owner = (await membersOf(A, pondId)).get(A.service.me.id);
    expect(owner.role).toBe("owner");
    expect(owner.primaryRetired).toBeUndefined();
    expect(devicesOf(owner).map((d) => d.id)).toEqual([A.service.me.id, web.service.me.id]);
    // a later rotation reaches the browser too
    await A.service.rotateKey(pondId);
    await web.service.refresh(pondId);
    expect(pondOf(web, pondId).current).toBe(3);
  });

  it("another account's device is still refused, and the Owner's own Mac is never dropped by a note about it", async () => {
    const eve = await mac(EVE);
    await expect(
      eve.relay.requestDevice({
        pondId,
        publicKey: eve.service.me.publicKey,
        boxKey: eve.service.me.publicKey,
        client: "web",
        nest: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // the Owner ends the browser from Settings: it is dropped and the key rotates; the Owner's Mac stays the Owner
    const before = pondOf(A, pondId).current as number;
    await A.service.removeAccountDevice(web.service.me.id);
    await A.service.refresh(pondId);
    const owner = (await membersOf(A, pondId)).get(A.service.me.id);
    expect(devicesOf(owner).map((d) => d.id)).toEqual([A.service.me.id]);
    expect(pondOf(A, pondId).current).toBe(before + 1);
    await expect(A.service.removeAccountDevice(A.service.me.id)).rejects.toMatchObject({ status: 409 });
  });
});

void RelayRefused;
void randomId;
