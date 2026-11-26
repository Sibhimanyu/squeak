// Devices are the account's, never a Pond's (issue #129, docs/spec.md "Devices"): the account lists its own devices,
// removing one cuts its tokens in every Pond at once and leaves a relay-owned note for each Owner's Mac to rotate the key.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const OTHER = "Q".repeat(32);
const KEY_A = Buffer.from("device-a-public-key").toString("base64url");
const KEY_B = Buffer.from("device-b-public-key").toString("base64url");
const KEY_E = Buffer.from("eve-device-public-key").toString("base64url");

function world() {
  const rows = new Map<string, string>();
  const k = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const store = {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(k(pk, doc)) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(k(pk, doc), json),
    del: async (pk: string, doc: string) => void rows.delete(k(pk, doc)),
    list: async (pk: string) =>
      [...rows]
        .filter(([key]) => key.startsWith(`${pk}\u0000`))
        .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json })),
  };
  const published: string[] = [];
  const people = createPeople({ tables: createMemoryTables(schema) });
  const deps = {
    key: KEY,
    store,
    people,
    streams: {
      channelId: async () => "chan",
      publish: async (_id: string, text: string) => void published.push(text),
      token: async () => ({}),
    },
  };
  return { rows, deps, people, published };
}

async function call(deps: unknown, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = headers;
  let status = 0;
  let text = "";
  const res: any = {
    writeHead: (s: number) => void (status = s),
    end: (t?: string) => void (text = t ?? ""),
  };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  return { status, json: text ? JSON.parse(text) : undefined };
}

const token = (userId: string) =>
  scoped.issueAppToken(KEY, userId, `${userId}@example.com`, Date.now(), 3_600_000).token;
const as = (userId: string) => ({ "x-squeak-account": token(userId) });
const register = (deps: unknown, userId: string, publicKey: string, name: string, kind: string) =>
  call(deps, "POST", "/account/devices", as(userId), { publicKey, name, kind });
const list = (deps: unknown, userId: string, self?: string) =>
  call(deps, "GET", `/account/devices${self ? `?deviceId=${self}` : ""}`, as(userId));
const listUnder = (deps: unknown, pond: string, userId: string) =>
  call(
    deps,
    "POST",
    `/ponds/${pond}/members/accounts`,
    { "x-squeak-relay": KEY },
    { ownerKey: "owner-key", name: "Greenroom", add: [userId], remove: [] },
  );

describe("the account's devices", () => {
  it("lists only the caller's own devices, with kind and this-device flag, and refuses anyone not signed in", async () => {
    const { deps } = world();
    const a = await register(deps, "u-aarav", KEY_A, "Aarav's MacBook", "mac");
    const b = await register(deps, "u-aarav", KEY_B, "Aarav's iPhone", "iphone");
    await register(deps, "u-eve", KEY_E, "Eve's Mac", "mac");
    expect(a.status).toBe(200);
    const mine = await list(deps, "u-aarav", a.json.deviceId);
    expect(mine.status).toBe(200);
    expect(mine.json.devices.map((d: any) => [d.name, d.kind, d.thisDevice]).sort()).toEqual([
      ["Aarav's MacBook", "mac", true],
      ["Aarav's iPhone", "iphone", false],
    ]);
    expect(b.json.deviceId).not.toBe(a.json.deviceId);
    expect(mine.json.devices.every((d: any) => typeof d.lastSeenAt === "number")).toBe(true);
    expect((await call(deps, "GET", "/account/devices", {})).status).toBe(401);
    expect((await call(deps, "GET", "/account/devices", { "x-squeak-relay": KEY })).status).toBe(401);
  });

  it("registering twice is one device; another account cannot take its key", async () => {
    const { deps } = world();
    await register(deps, "u-aarav", KEY_A, "Mac", "mac");
    await register(deps, "u-aarav", KEY_A, "Aarav's Mac", "mac");
    expect((await list(deps, "u-aarav")).json.devices.map((d: any) => d.name)).toEqual(["Aarav's Mac"]);
    expect((await register(deps, "u-eve", KEY_A, "Stolen", "mac")).status).toBe(403);
    expect((await register(deps, "u-aarav", "!!", "x", "mac")).status).toBe(400);
    expect((await register(deps, "u-aarav", KEY_B, "x", "fridge")).status).toBe(400);
  });
});

describe("removing a device removes it from every Pond", () => {
  it("refuses its tokens at once in every Pond, leaves a removal note for each Owner's Mac, and keeps the others", async () => {
    const { deps, rows } = world();
    const a = await register(deps, "u-aarav", KEY_A, "Aarav's MacBook", "mac");
    const b = await register(deps, "u-aarav", KEY_B, "Aarav's iPhone", "iphone");
    await listUnder(deps, POND, "u-aarav");
    await listUnder(deps, OTHER, "u-aarav");
    const read = (pond: string, id: string) =>
      call(deps, "GET", `/doc?path=${encodeURIComponent(`channels/${pond}/pond/meta`)}`, {
        "x-squeak-pond-token": scoped.issue(KEY, pond, id, Date.now(), 3600, "join").token,
      });
    expect((await read(POND, a.json.deviceId)).status).not.toBe(401);

    const gone = await call(deps, "DELETE", `/account/devices/${a.json.deviceId}`, as("u-aarav"));
    expect(gone.status).toBe(204);
    expect((await read(POND, a.json.deviceId)).status).toBe(401);
    expect((await read(OTHER, a.json.deviceId)).status).toBe(401);
    expect((await read(POND, b.json.deviceId)).status).not.toBe(401);
    expect((await list(deps, "u-aarav")).json.devices.map((d: any) => d.name)).toEqual(["Aarav's iPhone"]);

    for (const pond of [POND, OTHER]) {
      const note = JSON.parse(rows.get(`channels/${pond}/devreqs\u0000${a.json.deviceId}`)!);
      expect(note).toMatchObject({ v: 1, reqId: a.json.deviceId, userId: "u-aarav", gone: true });
      // nothing else about devices is written into a Pond
      expect(
        [...rows.keys()].filter((key) => key.startsWith(`channels/${pond}/`) && !key.includes("/devreqs")),
      ).toEqual([]);
    }
  });

  it("removes only the caller's own devices, and a removed device cannot ask to join a Pond again", async () => {
    const { deps } = world();
    const a = await register(deps, "u-aarav", KEY_A, "Mac", "mac");
    await listUnder(deps, POND, "u-aarav");
    expect((await call(deps, "DELETE", `/account/devices/${a.json.deviceId}`, as("u-eve"))).status).toBe(404);
    expect((await call(deps, "DELETE", `/account/devices/${a.json.deviceId}`, {})).status).toBe(401);
    expect((await list(deps, "u-aarav")).json.devices).toHaveLength(1);
    expect((await call(deps, "DELETE", `/account/devices/${a.json.deviceId}`, as("u-aarav"))).status).toBe(204);
    expect((await call(deps, "DELETE", `/account/devices/${a.json.deviceId}`, as("u-aarav"))).status).toBe(404);
    const ask = await call(deps, "POST", "/account/pond-devices", as("u-aarav"), {
      pondId: POND,
      publicKey: KEY_A,
      client: "mac",
    });
    expect(ask.status).toBe(403);
  });

  it("a device that asks to join a Pond appears in the account's list without any Pond change", async () => {
    const { deps } = world();
    await listUnder(deps, POND, "u-aarav");
    const ask = await call(deps, "POST", "/account/pond-devices", as("u-aarav"), {
      pondId: POND,
      publicKey: KEY_B,
      client: "ios",
      nest: "Aarav's iPhone",
    });
    expect(ask.status).toBe(200);
    const mine = await list(deps, "u-aarav", ask.json.reqId);
    expect(mine.json.devices).toMatchObject([{ name: "Aarav's iPhone", kind: "iphone", thisDevice: true }]);
  });
});
