/* eslint-disable @typescript-eslint/no-explicit-any -- the relay is untyped CommonJS and its req/res are test carriers */
// Remove and Leave are final at once in the cloud (issue #128, docs/spec.md "Removal is final at once", "Leaving", "Coming back"):
// the membership ends, every device's tokens are refused, reads of the feed and blobs are refused, live subscriptions are
// told to close, and the Owner's Mac finds one relay-owned note to rotate the key. A new invitation brings the same person back.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const { createMemoryBucket } = require(`${fn}blob-memory.js`);
const { createLiveNotices, withRemovalNotice } = require(`${fn}live-notice.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const KEY_PHONE = Buffer.from("asha-phone-public-key").toString("base64url");
const KEY_MAC = Buffer.from("asha-mac-public-key").toString("base64url");

function world() {
  const rows = new Map<string, string>();
  const k = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const inPk = (pk: string) =>
    [...rows]
      .filter(([key]) => key.startsWith(`${pk}\u0000`))
      .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json }))
      .sort((a, b) => (a.doc < b.doc ? -1 : 1));
  const store = {
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
  const published: string[] = [];
  const live: string[] = [];
  const streams = {
    channelId: async () => "chan",
    liveChannelId: async () => "live",
    publish: async (id: string, text: string) => void (id === "live" ? live : published).push(text),
    token: async () => ({}),
  };
  const people = withRemovalNotice(createPeople({ tables: createMemoryTables(schema) }), createLiveNotices(streams));
  const deps = { key: KEY, store, people, streams, blobs: createMemoryBucket() };
  return { rows, deps, people, live };
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
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status, json };
}

const as = (userId: string) => ({
  "x-squeak-account": scoped.issueAppToken(KEY, userId, `${userId}@example.com`, Date.now(), 3_600_000).token,
});

/** Owner u-sam, Member u-asha with a phone and a Mac in the Pond (each with a join token), and one Room document. */
async function pond() {
  const w = world();
  const { deps, people } = w;
  await people.upsertAccount({ userId: "u-sam", email: "sam@example.com", name: "Sam" });
  await people.upsertAccount({ userId: "u-asha", email: "u-asha@example.com", name: "Asha" });
  await people.createPond({ pondId: POND, ownerUserId: "u-sam", name: "Greenroom" });
  await people.addMember({ pondId: POND, userId: "u-asha", role: "member" });
  await call(
    deps,
    "POST",
    `/ponds/${POND}/members/accounts`,
    { "x-squeak-relay": KEY },
    { ownerKey: "owner-key", name: "Greenroom", add: ["u-asha"], remove: [] },
  );
  const tokens: Record<string, string> = {};
  for (const [name, publicKey, client] of [
    ["phone", KEY_PHONE, "ios"],
    ["mac", KEY_MAC, "mac"],
  ] as const) {
    const ask = await call(deps, "POST", "/account/pond-devices", as("u-asha"), { pondId: POND, publicKey, client });
    expect(ask.status).toBe(200);
    tokens[name] = ask.json.token;
  }
  await call(
    deps,
    "PUT",
    `/doc?path=${encodeURIComponent(`channels/${POND}/room/d1`)}`,
    { "x-squeak-relay": KEY },
    { doc: { box: "b", sig: "s", device: "d", at: 1 } },
  );
  return { ...w, tokens };
}

const readWith = (deps: unknown, token: string) =>
  call(deps, "GET", `/doc?path=${encodeURIComponent(`channels/${POND}/pond/meta`)}`, { "x-squeak-pond-token": token });
const feed = (deps: unknown, user: string) => call(deps, "GET", `/changes?pond=${POND}&since=0`, as(user));
const note = (rows: Map<string, string>, act: string, user: string) =>
  rows.get(`channels/${POND}/devreqs\u0000pn-${act}-${user}`);

describe("Leave is final at once", () => {
  it("refuses every device's tokens, the feed and the blobs, closes live subscriptions, and leaves the Owner's Mac one note", async () => {
    const { deps, rows, tokens, live } = await pond();
    expect((await readWith(deps, tokens.phone!)).status).not.toBe(401);
    expect((await feed(deps, "u-asha")).status).toBe(200);

    const left = await call(deps, "POST", "/account/pond-leaves", as("u-asha"), { pondId: POND });
    expect(left.status).toBe(204);

    expect((await readWith(deps, tokens.phone!)).status).toBe(401);
    expect((await readWith(deps, tokens.mac!)).status).toBe(401);
    expect((await feed(deps, "u-asha")).status).toBe(403);
    const blob = await call(deps, "GET", `/blob?pond=${POND}&id=${"b".repeat(22)}`, as("u-asha"));
    expect([401, 403, 503]).toContain(blob.status);
    expect(live.map((l) => JSON.parse(l))).toContainEqual({ t: "rm", pond: POND, user: "u-asha" });
    expect(JSON.parse(note(rows, "leave", "u-asha")!)).toMatchObject({ v: 1, userId: "u-asha", act: "leave" });
    // the account index keeps the row, marked left, for the account's other devices
    const mine = await call(deps, "GET", "/account/ponds", as("u-asha"));
    expect(mine.json.ponds).toMatchObject([{ pondId: POND, left: true }]);
    // the Owner and the account stay what they were
    expect((await feed(deps, "u-sam")).status).toBe(200);
    // again: the same answer, nothing breaks
    expect((await call(deps, "POST", "/account/pond-leaves", as("u-asha"), { pondId: POND })).status).toBe(204);
  });

  it("a Member who is in the people table but not yet in the index leaves too", async () => {
    const { deps, people } = world();
    await people.upsertAccount({ userId: "u-sam", email: "sam@example.com", name: "Sam" });
    await people.createPond({ pondId: POND, ownerUserId: "u-sam", name: "Greenroom" });
    await people.addMember({ pondId: POND, userId: "u-asha", role: "member" });
    expect((await call(deps, "POST", "/account/pond-leaves", as("u-asha"), { pondId: POND })).status).toBe(204);
    expect(await people.isMember(POND, "u-asha")).toBe(false);
    expect((await call(deps, "POST", "/account/pond-leaves", as("u-stranger"), { pondId: POND })).status).toBe(403);
  });
});

describe("Remove is final at once", () => {
  it("only the Owner removes; the person is cut off everywhere and the Owner's Mac gets one note", async () => {
    const { deps, rows, tokens, live } = await pond();
    const url = `/ponds/${POND}/members/u-asha`;
    expect((await call(deps, "DELETE", url, as("u-asha"))).status).toBe(403);
    expect((await call(deps, "DELETE", url, {})).status).toBe(401);
    expect((await feed(deps, "u-asha")).status).toBe(200);

    expect((await call(deps, "DELETE", url, as("u-sam"))).status).toBe(204);

    expect((await readWith(deps, tokens.phone!)).status).toBe(401);
    expect((await readWith(deps, tokens.mac!)).status).toBe(401);
    expect((await feed(deps, "u-asha")).status).toBe(403);
    expect(live.map((l) => JSON.parse(l))).toContainEqual({ t: "rm", pond: POND, user: "u-asha" });
    expect(JSON.parse(note(rows, "remove", "u-asha")!)).toMatchObject({ userId: "u-asha", act: "remove" });
    // a removed person's index row is gone: no device of theirs can ask to come back
    expect((await call(deps, "GET", "/account/ponds", as("u-asha"))).json.ponds).toEqual([]);
    const ask = await call(deps, "POST", "/account/pond-devices", as("u-asha"), {
      pondId: POND,
      publicKey: KEY_PHONE,
      client: "ios",
    });
    expect(ask.status).toBe(403);
    // the Owner cannot be removed, and a stranger is not a member
    expect((await call(deps, "DELETE", `/ponds/${POND}/members/u-sam`, as("u-sam"))).status).toBe(409);
    expect((await call(deps, "DELETE", `/ponds/${POND}/members/u-nobody`, as("u-sam"))).status).toBe(404);
  });

  it("the Owner's Mac listing someone as removed cuts them off the same way", async () => {
    const { deps, tokens } = await pond();
    const r = await call(
      deps,
      "POST",
      `/ponds/${POND}/members/accounts`,
      { "x-squeak-relay": KEY },
      { add: [], remove: ["u-asha"] },
    );
    expect(r.status).toBe(204);
    expect((await readWith(deps, tokens.phone!)).status).toBe(401);
    expect((await feed(deps, "u-asha")).status).toBe(403);
  });
});

describe("Coming back", () => {
  it("a new invitation to the same account lets its devices in again as the same person", async () => {
    const { deps, people, rows, tokens } = await pond();
    await call(deps, "DELETE", `/ponds/${POND}/members/u-asha`, as("u-sam"));
    expect((await readWith(deps, tokens.phone!)).status).toBe(401);

    const inv = await call(deps, "POST", `/ponds/${POND}/invites`, as("u-sam"), {
      emails: ["u-asha@example.com"],
      role: "member",
    });
    expect(inv.json.results[0].ok).toBe(true);
    const join = await call(
      deps,
      "POST",
      `/account/invitations/${inv.json.results[0].invite.inviteId}/join`,
      as("u-asha"),
    );
    expect(join.status).toBe(200);

    expect(await people.isMember(POND, "u-asha")).toBe(true);
    expect((await feed(deps, "u-asha")).status).toBe(200);
    expect(note(rows, "remove", "u-asha")).toBeUndefined();
    // the Owner's Mac lists them again (adds the index row); their devices ask and get tokens, unrevoked
    await call(
      deps,
      "POST",
      `/ponds/${POND}/members/accounts`,
      { "x-squeak-relay": KEY },
      { ownerKey: "owner-key", add: ["u-asha"], remove: [] },
    );
    const ask = await call(deps, "POST", "/account/pond-devices", as("u-asha"), {
      pondId: POND,
      publicKey: KEY_PHONE,
      client: "ios",
    });
    expect(ask.status).toBe(200);
    expect((await readWith(deps, ask.json.token)).status).not.toBe(401);
  });
});

describe("Delete a Pond", () => {
  it("every Member's devices are cut off, and the index keeps a week-long 'deleted' record per Member", async () => {
    const { deps, tokens } = await pond();
    const del = await call(deps, "DELETE", `/ponds/${POND}`, as("u-sam"), { name: "Greenroom" });
    expect(del.status).toBe(204);
    expect((await readWith(deps, tokens.phone!)).status).toBe(401);
    expect((await feed(deps, "u-asha")).status).toBe(403);
    const mine = await call(deps, "GET", "/account/ponds", as("u-asha"));
    expect(mine.json.ponds).toMatchObject([{ pondId: POND, deleted: true }]);
  });
});
