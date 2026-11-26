/* eslint-disable @typescript-eslint/no-explicit-any -- reaches the service's private store and the relay's untyped CommonJS */
// The Room in the cloud (issue #122) over the REAL relay code: a store that numbers writes (feed.js), so the order is the cloud's.
// Members read each other's posts at once with the Owner's Mac away; the Owner's Mac applies them in seq order when it is back;
// a key rotation rewrites nothing; a newcomer reads what came before them; the cap pages out the oldest with a note; a Duck's words
// keep 30 days and a Private Duck is never uploaded; a Member's Duck request waits as long as the Owner's Mac is away.
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatalystStore, type StreamSocket } from "../cloud/catalyst-store.js";
import { macClientHeaders } from "../cloud/client-version.js";
import { createCloudStore } from "../cloud/config.js";
import { Room } from "../native/room.js";
import { RoomTasks } from "../native/room-tasks.js";
import { NativeStore } from "../native/store.js";
import type { SessionRow } from "../native/types.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId } from "./crypto.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { FakeHost, session } from "./journey-support.js";
import { HttpPondRelay } from "./relay.js";
import { RoomSync } from "./room-sync.js";
import { FlotillaService } from "./service.js";
import { DUCK_HISTORY_MS } from "./types.js";

const require = createRequire(import.meta.url);
const fn = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createServer } = require("../../cloud/catalyst-relay/appsail/server.js");

const RELAY_KEY = "k".repeat(43);
const BASE = "https://squeak-relay.development.catalystappsail.in";
const CAP = 20_000;

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
  deps = {
    channelId: async () => "shared-stream-1",
    pondChannelId: async () => null,
    publish: async () => undefined,
    token: async (id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `${id}|${name}`, "wss-id": "w1" }),
  };
  socket = (): StreamSocket => ({ onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} });
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
/** Every Mac's clock, so a request can wait hours without the test waiting. */
const clock = { t: Date.now() };
/** Whether the live connections say the Owner's Mac is running. */
const ownerAway = { v: false };

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  const common = {
    key: RELAY_KEY,
    store: numberingStore(),
    streams: streams.deps,
    hosted: true,
    sharedNotice: true,
    log: () => {},
    usageCache: new Map(),
    ownerCache: new Map(),
    roomCapBytes: CAP,
  };
  const asFunction = (req: any, res: any) => {
    const who = req.headers["x-test-user"];
    const user = who ? (JSON.parse(String(who)) as TestUser) : null;
    return createRelay({ ...common, currentUser: async () => user })(req, res);
  };
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

const toLocal =
  (origin: string) =>
  (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    return fetch(`${origin}${u.pathname}${u.search}`, init);
  };

async function signIn(user: TestUser) {
  const tokenRes = await fetch(`${functionUrl}/account/app-token`, {
    method: "POST",
    headers: { "x-test-user": JSON.stringify(user), "content-type": "application/json" },
    body: "{}",
  });
  const { token } = (await tokenRes.json()) as { token: string };
  const macId = `mac${randomId(16)}`;
  const provisioned = await fetch(`${deviceUrl}/account/macs/provision`, {
    method: "POST",
    headers: { "x-squeak-account": token, "content-type": "application/json" },
    body: JSON.stringify({ macId, name: `${user.name}'s Mac` }),
  });
  const { key } = (await provisioned.json()) as { key: string };
  return { macId, key };
}

type Mac = Awaited<ReturnType<typeof mac>>;
async function mac(user: TestUser) {
  const { key } = await signIn(user);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-cloud-"));
  dirs.push(dir);
  const doFetch = toLocal(deviceUrl);
  const location = { provider: "catalyst" as const, relayUrl: BASE, relayKey: key, hosted: true as const };
  const relay = new HttpPondRelay(BASE, key, doFetch, true);
  const account = {
    name: () => user.name,
    email: () => user.email,
    names: async (ids: string[]) => relay.names(ids),
  };
  let ownerId = "";
  const service = new FlotillaService({
    account,
    store: createCloudStore(location, { fetch: doFetch, socket: streams.socket }),
    supportDir: dir,
    nest: `${user.name}-mac`,
    location,
    relay,
    now: () => clock.t,
    wakeDebounceMs: 0,
    wakeMinIntervalMs: 0,
    presenceOf: async () => (ownerId ? [{ memberId: ownerId, online: !ownerAway.v }] : []),
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
      return createCloudStore(at as typeof location, { fetch: doFetch, socket: streams.socket });
    },
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return {
    dir,
    service,
    host,
    bridge,
    key,
    name: user.name,
    tellOwner: (id: string) => void (ownerId = id),
  };
}

/** The Owner's host side: a real Room, Tasks and store, wired to the sync. */
function ownerHost(service: FlotillaService) {
  const store = new NativeStore(":memory:");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "room-cloud-folder-"));
  dirs.push(folder);
  const project = store.createProject({ name: "site", rootPath: folder, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sibhi", now: () => clock.t });
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }),
    send: async () => undefined,
    newThread: async () => ({}) as SessionRow,
    call: async () => '{"job":false,"text":""}',
    enabled: () => false,
    now: () => clock.t,
  });
  const sync = new RoomSync({ service, room, jobs, store, now: () => clock.t, debounceMs: 1 });
  sync.start();
  return { store, project, room, jobs, sync };
}

function memberSync(who: Mac) {
  const store = new NativeStore(":memory:");
  const room = new Room({ store, now: () => clock.t });
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }),
    send: async () => undefined,
    newThread: async () => ({}) as SessionRow,
    enabled: () => false,
  });
  return new RoomSync({ service: who.service, room, jobs, store, now: () => clock.t, debounceMs: 1 });
}

const user = (name: string): TestUser => ({
  userId: `u-${name.toLowerCase()}`,
  email: `${name.toLowerCase()}@example.com`,
  name,
});

async function admit(owner: Mac, pondId: string, who: Mac, email: string) {
  void email;
  await admitMember(owner.service, who.service, pondId, "member", { id: user(who.name).userId });
}

/** What the cloud holds of one kind, read with a Mac's own key (the relay's list route). */
async function cloudList(who: Mac, pondId: string, kind: string): Promise<Array<{ id: string; doc: any }>> {
  const r = await fetch(`${deviceUrl}/list?prefix=${encodeURIComponent(`channels/${pondId}/${kind}`)}`, {
    headers: { "x-squeak-mac-key": who.key, ...macClientHeaders() },
  });
  return ((await r.json()) as { items: Array<{ id: string; doc: any }> }).items;
}

const said = <T extends { author: { name: string } }>(posts: T[]): T[] =>
  posts.filter((p) => p.author.name !== "Squeak");

describe("the Room in the cloud, over the real relay", () => {
  let A: Mac;
  let B: Mac;
  let C: Mac;
  let pondId = "";
  let host: ReturnType<typeof ownerHost>;
  let bSync: RoomSync;
  let cSync: RoomSync;

  beforeAll(async () => {
    A = await mac(user("Sibhi"));
    B = await mac(user("Aarav"));
    C = await mac(user("Chris"));
    host = ownerHost(A.service);
    pondId = (await A.service.createPond({ name: "Site", projectId: host.project.id })).id;
    for (const m of [A, B, C]) m.tellOwner(A.service.me.id);
    await admit(A, pondId, B, "aarav@example.com");
    await admit(A, pondId, C, "chris@example.com");
    bSync = memberSync(B);
    cSync = memberSync(C);
    await host.sync.idle();
  });

  it("a Member's post is readable by another Member while the Owner's Mac is away, in the cloud's order", async () => {
    ownerAway.v = true;
    clock.t += 1000;
    await bSync.post(pondId, "one");
    await cSync.post(pondId, "two");
    await bSync.post(pondId, "three");
    const page = await cSync.page(pondId);
    expect(page.ownerOffline).toBeDefined();
    const mine = said(page.posts).filter((p) => ["one", "two", "three"].includes(p.text));
    expect(mine.map((p) => p.text)).toEqual(["one", "two", "three"]);
    // The numbers are the cloud's: strictly rising, taken from the relay, not from anyone's clock.
    expect(mine.every((p, i, all) => i === 0 || p.seq > all[i - 1]!.seq)).toBe(true);
    expect(mine.map((p) => p.author.name)).toEqual(["Aarav", "Chris", "Aarav"]);
    // Nothing reached the Owner's Mac: Ducks have not heard any of it.
    expect(host.store.roomPosts(host.project.id, { limit: 100 }).some((r) => r.text === "one")).toBe(false);
  });

  it("the Owner's Mac applies the waiting posts in seq order when it comes online, once, and keeps them in the cloud", async () => {
    ownerAway.v = false;
    await A.service.pass(pondId);
    await host.sync.idle();
    const mine = host.store
      .roomPosts(host.project.id, { limit: 100 })
      .filter((r) => r.authorKind === "person" && r.authorName !== "Sibhi")
      .map((r) => r.text);
    expect(mine).toEqual(["one", "two", "three"]);
    // A replay applies nothing twice.
    await A.service.pass(pondId);
    await host.sync.idle();
    expect(host.store.roomPosts(host.project.id, { limit: 100 }).filter((r) => r.text === "one")).toHaveLength(1);
    // The Members' signed documents stay: they are the Room's record in the cloud.
    expect((await cloudList(A, pondId, "rposts")).length).toBeGreaterThanOrEqual(3);
    // Members see each post once (their own document, not also an Owner copy).
    const page = await cSync.page(pondId);
    expect(said(page.posts).filter((p) => p.text === "one")).toHaveLength(1);
  });

  it("a key rotation leaves every old document untouched; a Member holding both versions reads old and new", async () => {
    const before = new Map((await cloudList(A, pondId, "room")).map((d) => [d.id, d.doc]));
    const beforePosts = new Map((await cloudList(A, pondId, "rposts")).map((d) => [d.id, d.doc]));
    const D = await mac(user("Dana"));
    D.tellOwner(A.service.me.id);
    await admit(A, pondId, D, "dana@example.com");
    await A.service.removeMember(pondId, D.service.me.id);
    await B.service.refresh(pondId);
    await C.service.refresh(pondId);
    // Nothing written before the rotation was written again: same boxes, same numbers.
    for (const d of await cloudList(A, pondId, "room")) if (before.has(d.id)) expect(d.doc).toEqual(before.get(d.id));
    for (const d of await cloudList(A, pondId, "rposts"))
      if (beforePosts.has(d.id)) expect(d.doc).toEqual(beforePosts.get(d.id));
    const oldBox = [...beforePosts.values()][0].box as string;
    expect(oldBox.startsWith("1.")).toBe(true);
    // New writes use the new key; B reads both.
    await bSync.post(pondId, "four");
    const fresh = (await cloudList(A, pondId, "rposts")).find((d) => !beforePosts.has(d.id))!;
    expect(fresh.doc.box.startsWith("2.")).toBe(true);
    const texts = said((await cSync.page(pondId)).posts).map((p) => p.text);
    expect(texts).toEqual(expect.arrayContaining(["one", "two", "three", "four"]));
  });

  it("someone who joins after reads the whole Room, old key versions included", async () => {
    const E = await mac(user("Eli"));
    E.tellOwner(A.service.me.id);
    await admit(A, pondId, E, "eli@example.com");
    const eSync = memberSync(E);
    const texts = said((await eSync.page(pondId)).posts).map((p) => p.text);
    expect(texts).toEqual(expect.arrayContaining(["one", "two", "three", "four"]));
    const keys = JSON.parse(fs.readFileSync(path.join(E.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId].keys;
    expect(Object.keys(keys).sort()).toEqual(["1", "2"]);
  });

  it("past the cap the cloud pages out the oldest with a note, and the Owner's Mac does not send them again", async () => {
    for (let i = 0; i < 90; i++) {
      clock.t += 10;
      host.room.personPost(host.project.id, `bulk ${i} ${"x".repeat(120)}`);
    }
    await host.sync.idle();
    const page = await bSync.page(pondId, { limit: 200 });
    expect(page.earlier?.line).toMatch(/no longer kept/);
    const texts = said(page.posts).map((p) => p.text);
    expect(texts.at(-1)).toBe(`bulk 89 ${"x".repeat(120)}`);
    expect(texts).not.toContain("one"); // the oldest went first
    const bytes = [...(await cloudList(A, pondId, "room")), ...(await cloudList(A, pondId, "rposts"))].reduce(
      (n, d) => n + JSON.stringify(d.doc).length,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(CAP);
    // A restarted Owner's Mac (a fresh sync) learns what the cloud holds and writes nothing it already paged out.
    const held = (await cloudList(A, pondId, "room")).length;
    const again = new RoomSync({
      service: A.service,
      room: host.room,
      jobs: host.jobs,
      store: host.store,
      now: () => clock.t,
      debounceMs: 1,
    });
    await again.publish(pondId);
    expect((await cloudList(A, pondId, "room")).length).toBe(held);
  });

  it("a Duck's words keep 30 days and a Private Duck is never uploaded", async () => {
    A.host.sessions.set("s1", session("s1", { title: "Open Duck" }));
    A.host.sessions.set("s2", session("s2", { title: "Secret Duck" }));
    const open = await A.bridge.share(pondId, "s1");
    const secret = await A.bridge.share(pondId, "s2", { private: true });
    const sealedAt = (pondEvents: Array<{ id: string }>) => pondEvents.map((d) => d.id);
    const first = A.service.allocSeq(pondId, open.id, 1);
    await A.service.publishEvents(pondId, open.id, [
      { seq: first, at: clock.t - DUCK_HISTORY_MS - 3_600_000, type: "agent", text: "ancient" },
    ]);
    const second = A.service.allocSeq(pondId, open.id, 1);
    await A.service.publishEvents(pondId, open.id, [{ seq: second, at: clock.t, type: "agent", text: "recent" }]);
    const ids = sealedAt(await cloudList(A, pondId, "tevents"));
    expect(ids).toContain(`${open.id}-${second}`);
    expect(ids).not.toContain(`${open.id}-${first}`);
    // A Private Duck: nothing about it, thread or events, ever reaches the cloud.
    const quiet = A.service.allocSeq(pondId, secret.id, 1);
    await A.service.publishEvents(pondId, secret.id, [{ seq: quiet, at: clock.t, type: "agent", text: "hush" }]);
    expect(sealedAt(await cloudList(A, pondId, "tevents")).some((id) => id.startsWith(`${secret.id}-`))).toBe(false);
    expect((await cloudList(A, pondId, "threads")).map((d) => d.id)).not.toContain(secret.id);
  });

  it("a Member's Duck request waits in the cloud for a Mac that is away for hours, then applies in order", async () => {
    ownerAway.v = true;
    const { requestId } = await B.service.requestStart(pondId, { text: "Fix the footer", agent: "claude", model: "m" });
    // Not a 5-minute command: a numbered document in the Pond's queue.
    expect(await cloudList(A, pondId, "tcmds")).toEqual([]);
    const queued = (await cloudList(A, pondId, "rposts")).filter((d) => typeof d.doc.seq === "number");
    expect(queued.length).toBeGreaterThan(0);
    clock.t += 3 * 3_600_000;
    ownerAway.v = false;
    await A.bridge.runCommands(pondId);
    const waiting = (await A.service.view(pondId)).starts ?? [];
    expect(waiting.map((s) => s.requestId)).toEqual([requestId]);
    expect(waiting[0]).toMatchObject({ name: "Aarav", text: "Fix the footer" });
    // Applied once: another pass changes nothing.
    await A.bridge.runCommands(pondId);
    expect((await A.service.view(pondId)).starts).toHaveLength(1);
  });
});
