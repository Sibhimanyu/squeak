/* eslint-disable @typescript-eslint/no-explicit-any -- reaches the relay's untyped CommonJS */
// Pictures and files of Room posts in the cloud (issue #123) over the REAL relay code and an in-memory bucket: sealed on the
// sending Mac, kept as blobs the posts name by id, fetched on view, refused with plain sentences, and never readable by a
// removed Member. The Owner's Mac fetches a Member's pictures when it applies their post.
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatalystStore, type StreamSocket } from "../cloud/catalyst-store.js";
import { createCloudStore } from "../cloud/config.js";
import { Room } from "../native/room.js";
import { RoomTasks } from "../native/room-tasks.js";
import { NativeStore } from "../native/store.js";
import type { SessionRow } from "../native/types.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId } from "./crypto.js";
import { FakeHost } from "./journey-support.js";
import { HttpPondRelay } from "./relay.js";
import { RoomSync } from "./room-sync.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { FlotillaService } from "./service.js";
import { FlotillaError } from "./types.js";

const require = createRequire(import.meta.url);
const fn = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createServer } = require("../../cloud/catalyst-relay/appsail/server.js");
const { createMemoryBucket } = require(`${fn}blob-memory.js`);

const RELAY_KEY = "k".repeat(43);
const BASE = "https://squeak-relay.development.catalystappsail.in";

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
const bucket = createMemoryBucket();
const BLOB_MAX = 20_000;
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
    blobBucket: bucket,
    blobMaxBytes: BLOB_MAX,
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

async function admit(owner: Mac, pondId: string, who: Mac, _email: string) {
  await admitMember(owner.service, who.service, pondId, "member");
  await who.service.refresh(pondId);
}

/** What the cloud holds of one kind, read with a Mac's own key (the relay's list route). */
async function cloudList(who: Mac, pondId: string, kind: string): Promise<Array<{ id: string; doc: any }>> {
  const r = await fetch(`${deviceUrl}/list?prefix=${encodeURIComponent(`channels/${pondId}/${kind}`)}`, {
    headers: { "x-squeak-mac-key": who.key },
  });
  return ((await r.json()) as { items: Array<{ id: string; doc: any }> }).items;
}

/** A picture as the Mac sends it: PNG bytes (the signature decides) with a marker nothing but the sender may ever see. */
const picture = (marker: string, size = 400): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(marker.repeat(Math.ceil(size / marker.length)).slice(0, size)),
  ]);
const attach = (...pictures: Buffer[]) => pictures.map((b, i) => ({ name: `p${i}.png`, data: b.toString("base64") }));
/** Every byte the cloud holds as text, to look for plaintext. */
const everythingInBucket = (): string =>
  [...bucket.objects.values()].map((b: Buffer) => b.toString("latin1")).join("\n");

describe("pictures and files in the cloud, over the real relay", () => {
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

  it("the Owner's picture reaches a Member as a sealed blob, fetched on view; the cloud never held the picture", async () => {
    const png = picture("OWNER-SECRET-WHITEBOARD");
    clock.t += 1000;
    host.room.post({
      projectId: host.project.id,
      author: { kind: "person", id: "owner", name: "Sibhi" },
      kind: "message",
      text: "the whiteboard",
      attachments: attach(png),
    });
    await host.sync.idle();

    const [doc] = (await cloudList(A, pondId, "room")).filter((d) => d.doc.box);
    expect(doc).toBeDefined();
    // The post carries a reference only: no blob bytes in the NoSQL document, and no plaintext in the bucket.
    expect(bucket.objects.size).toBe(1);
    expect(everythingInBucket()).not.toContain("OWNER-SECRET-WHITEBOARD");
    expect(JSON.stringify(await cloudList(A, pondId, "room"))).not.toContain("OWNER-SECRET-WHITEBOARD");

    const page = await bSync.page(pondId);
    const post = page.posts.find((p) => p.text === "the whiteboard")!;
    expect(post.blobs).toHaveLength(1);
    expect(post.attachments).toHaveLength(1);
    expect(post.attachments![0]!.url).toBe(`/native/ponds/${pondId}/room/blobs/${post.blobs![0]!.id}`);
    // Viewing fetches and opens it; the bytes are the Owner's.
    const got = await bSync.blob(pondId, post.blobs![0]!.id);
    expect(got!.bytes.equals(png)).toBe(true);
    expect(got!.ref).toMatchObject({ kind: "image", mime: "image/png" });
    // A blob no post names is never handed out.
    expect(await bSync.blob(pondId, "z".repeat(22))).toBeNull();
    // Nothing is sent twice by a later publish.
    await host.sync.publish(pondId);
    expect(bucket.objects.size).toBe(1);
  });

  it("a Member's picture is sealed on their Mac, seen by the other Member, and applied by the Owner's Mac with its bytes", async () => {
    const png = picture("MEMBER-SECRET-SCREENSHOT");
    clock.t += 1000;
    const sent = await bSync.post(pondId, "see this", undefined, attach(png));
    expect(sent.id).toBeTruthy();
    expect(everythingInBucket()).not.toContain("MEMBER-SECRET-SCREENSHOT");

    const seen = (await cSync.page(pondId)).posts.find((p) => p.text === "see this")!;
    expect(seen.blobs).toHaveLength(1);
    expect((await cSync.blob(pondId, seen.blobs![0]!.id))!.bytes.equals(png)).toBe(true);

    await A.service.pass(pondId);
    await host.sync.idle();
    const row = host.store.roomPosts(host.project.id, { limit: 100 }).find((r) => r.text === "see this")!;
    const atts = host.room.attachments.forPosts(host.project.id, [row.id]).get(row.id)!;
    expect(atts).toHaveLength(1);
    expect(host.room.attachments.read(host.project.id, atts[0]!.id)!.bytes.equals(png)).toBe(true);
  });

  it("a picture alone is a post, for a Member and for the Owner", async () => {
    clock.t += 1000;
    await bSync.post(pondId, "", undefined, attach(picture("ALONE-MEMBER")));
    host.room.post({
      projectId: host.project.id,
      author: { kind: "person", id: "owner", name: "Sibhi" },
      kind: "message",
      text: "",
      attachments: attach(picture("ALONE-OWNER")),
    });
    await A.service.pass(pondId);
    await host.sync.idle();
    const page = await cSync.page(pondId);
    expect(page.posts.filter((p) => p.text === "" && p.blobs?.length === 1)).toHaveLength(2);
  });

  it("a too-big picture is refused with a plain sentence and nothing is posted", async () => {
    const before = (await cloudList(A, pondId, "rposts")).length;
    const error = await bSync.post(pondId, "huge", undefined, attach(picture("BIG", BLOB_MAX + 500))).catch((e) => e);
    expect(error).toBeInstanceOf(FlotillaError);
    expect(error.message).toBe("A picture or file can be at most 6 MB.");
    expect((await cloudList(A, pondId, "rposts")).length).toBe(before);
  });

  it("the Owner's post still goes out when the cloud refuses its picture: the picture stays on the Mac", async () => {
    clock.t += 1000;
    host.room.post({
      projectId: host.project.id,
      author: { kind: "person", id: "owner", name: "Sibhi" },
      kind: "message",
      text: "this one is big",
      attachments: attach(picture("HUGE", BLOB_MAX - 1000)),
    });
    // Sealed it fits; make the next one over the limit by sealing overhead.
    host.room.post({
      projectId: host.project.id,
      author: { kind: "person", id: "owner", name: "Sibhi" },
      kind: "message",
      text: "too big for the cloud",
      attachments: attach(picture("HUGE", BLOB_MAX + 100)),
    });
    await host.sync.idle();
    const posts = (await cSync.page(pondId)).posts;
    const big = posts.find((p) => p.text === "too big for the cloud")!;
    expect(big).toBeDefined();
    expect(big.blobs).toBeUndefined();
    const row = host.store.roomPosts(host.project.id, { limit: 100 }).find((r) => r.text === "too big for the cloud")!;
    expect(host.room.attachments.forPosts(host.project.id, [row.id]).get(row.id)).toHaveLength(1);
  });

  it("a removed Member can no longer fetch a blob", async () => {
    const png = picture("FOR-MEMBERS-ONLY");
    clock.t += 1000;
    const sent = await cSync.post(pondId, "members only", undefined, attach(png));
    const post = (await bSync.page(pondId)).posts.find((p) => p.text === "members only")!;
    expect((await bSync.blob(pondId, post.blobs![0]!.id))!.bytes.equals(png)).toBe(true);
    expect(sent.id).toBeTruthy();

    await A.service.removeMember(pondId, B.service.me.id);
    await expect(bSync.blob(pondId, post.blobs![0]!.id)).rejects.toBeInstanceOf(FlotillaError);
  });
});
