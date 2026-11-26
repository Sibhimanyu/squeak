import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const MAC = "M".repeat(32); // a Mac's own channel: the iPhone's way in, never wiped
const POND = "P".repeat(32);
const OLD_POND = "O".repeat(32); // a pond known only from an account's old index, not from the tables
const sealed = JSON.stringify({ box: "x", at: 1 });
const CONFIRM = { confirm: "wipe-cloud-ponds" };

function world(over: Record<string, unknown> = {}) {
  const rows = new Map<string, string>();
  const put = (pk: string, doc: string, json = sealed) => rows.set(`${pk}|${doc}`, json);
  const store = {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
    del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
    list: async (pk: string) =>
      [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
  };
  const people = createPeople({ tables: createMemoryTables(schema) });
  const deps = {
    key: KEY,
    store,
    streams: { channelId: async () => "c", publish: async () => undefined, token: async () => ({}) },
    people,
    cleanStart: true,
    ...over,
  };
  return { rows, put, deps, people, has: (pk: string, doc: string) => rows.has(`${pk}|${doc}`) };
}

async function post(deps: unknown, body: unknown, headers: Record<string, string> = { "x-squeak-relay": KEY }) {
  const req: any = new EventEmitter();
  req.method = "POST";
  req.url = "/server/squeak_relay/admin/clean-start";
  req.headers = headers;
  let status = 0;
  let text = "";
  const res: any = {
    writeHead: (s: number) => void (status = s),
    end: (t?: string) => void (text = t ?? ""),
  };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  return { status, json: text ? JSON.parse(text) : undefined };
}

describe("POST /admin/clean-start", () => {
  it("wipes Pond documents and the tables but leaves a Mac's own channel and the accounts", async () => {
    const w = world();
    await w.people.upsertAccount({ userId: "u1", email: "a@b.co", name: "A" });
    await w.people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    w.put(`channels/${POND}/room`, "r1");
    w.put(`channels/${POND}/members`, "m1");
    w.put(`channels/${POND}/devreqs`, "d1");
    w.put(`pins/${POND}`, "mem");
    w.put(`revoked/${POND}`, "mem");
    w.put("channel-owners", POND);
    w.put("acctponds/u1", POND);
    w.put("acctponds/u1", OLD_POND);
    w.put(`channels/${OLD_POND}/room`, "r2");
    w.put(`channels/${MAC}/state`, "s1");
    w.put(`channels/${MAC}/commands`, "c1");
    w.put("mac-owners", MAC, JSON.stringify({ userId: "u1" }));
    // an old account index names the Mac's own channel too: it must still be skipped
    w.put("acctponds/u1", MAC);

    const r = await post(w.deps, CONFIRM);
    expect(r.status).toBe(200);
    expect(r.json.people).toMatchObject({ ponds: 1, memberships: 1 });
    expect(r.json.ponds).toBe(2);
    for (const [pk, doc] of [
      [`channels/${POND}/room`, "r1"],
      [`channels/${POND}/members`, "m1"],
      [`channels/${POND}/devreqs`, "d1"],
      [`pins/${POND}`, "mem"],
      [`revoked/${POND}`, "mem"],
      ["channel-owners", POND],
      ["acctponds/u1", POND],
      ["acctponds/u1", OLD_POND],
      [`channels/${OLD_POND}/room`, "r2"],
    ] as const)
      expect(w.has(pk, doc), `${pk}/${doc}`).toBe(false);
    expect(w.has(`channels/${MAC}/state`, "s1")).toBe(true);
    expect(w.has(`channels/${MAC}/commands`, "c1")).toBe(true);
    expect(await w.people.getPond(POND)).toBeNull();
    expect(await w.people.getAccount("u1")).not.toBeNull();
  });

  it("also wipes Ponds the caller names (ones the tables never knew)", async () => {
    const w = world();
    w.put(`channels/${OLD_POND}/room`, "r2");
    const r = await post(w.deps, { ...CONFIRM, pondIds: [OLD_POND, "not a pond id"] });
    expect(r.status).toBe(200);
    expect(w.has(`channels/${OLD_POND}/room`, "r2")).toBe(false);
  });

  it("is idempotent", async () => {
    const w = world();
    expect((await post(w.deps, CONFIRM)).status).toBe(200);
    const again = await post(w.deps, CONFIRM);
    expect(again.status).toBe(200);
    expect(again.json.ponds).toBe(0);
  });

  it("is off unless the relay was started for it, and needs the exact confirmation", async () => {
    expect((await post(world({ cleanStart: false }).deps, CONFIRM)).status).toBe(403);
    expect((await post(world({ cleanStart: undefined }).deps, CONFIRM)).status).toBe(403);
    expect((await post(world().deps, {})).status).toBe(400);
    expect((await post(world().deps, { confirm: "yes" })).status).toBe(400);
  });

  it("is the operator's alone: no key, a wrong key or a Mac key never reach it", async () => {
    const w = world();
    w.put(`channels/${POND}/room`, "r1");
    expect((await post(w.deps, CONFIRM, {})).status).toBe(401);
    expect((await post(w.deps, CONFIRM, { "x-squeak-relay": "z".repeat(43) })).status).toBe(401);
    expect((await post(w.deps, CONFIRM, { "x-squeak-pond-token": "pt.x.y.1.z" })).status).toBe(401);
    expect(w.has(`channels/${POND}/room`, "r1")).toBe(true);
  });

  it("still clears the document store when no people tables are wired", async () => {
    const w = world({ people: undefined });
    w.put(`channels/${OLD_POND}/room`, "r2");
    const r = await post(w.deps, { ...CONFIRM, pondIds: [OLD_POND] });
    expect(r.status).toBe(200);
    expect(r.json.people).toBeNull();
    expect(w.has(`channels/${OLD_POND}/room`, "r2")).toBe(false);
  });
});
