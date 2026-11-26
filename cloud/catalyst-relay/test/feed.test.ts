// The Pond change feed (feed.js, issue #120): every content write gets the Pond's next seq, /changes returns only what
// changed after a seq, and the counter holds under concurrent writers on a store with no transactions.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createFeed, FEED_KINDS } = require(`${fn}feed.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const { createCleanStart } = require(`${fn}clean-start.js`);
const scoped = require(`${fn}scoped.js`);
const { KINDS } = require(`${fn}rules.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const OTHER = "Q".repeat(32);
const SEALED = (box: string) => ({ box, sig: "s", device: "d", at: 1 });
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A store like Catalyst NoSQL: no transactions, insert refuses an existing key, and every call yields, so writers interleave. */
function world(over: { noFeed?: boolean } = {}) {
  const rows = new Map<string, string>();
  const ops = { range: 0, get: 0, list: 0, claim: 0, put: 0 };
  const k = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const store: Record<string, unknown> = {
    ready: async () => true,
    get: async (pk: string, doc: string) => {
      ops.get++;
      await tick();
      return rows.get(k(pk, doc)) ?? null;
    },
    put: async (pk: string, doc: string, json: string) => {
      ops.put++;
      await tick();
      rows.set(k(pk, doc), json);
    },
    del: async (pk: string, doc: string) => {
      await tick();
      rows.delete(k(pk, doc));
    },
    list: async (pk: string) => {
      ops.list++;
      await tick();
      return [...rows]
        .filter(([key]) => key.startsWith(`${pk}\u0000`))
        .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json }))
        .sort((a, b) => (a.doc < b.doc ? -1 : 1));
    },
  };
  if (!over.noFeed) {
    store.claim = async (pk: string, doc: string, json: string) => {
      ops.claim++;
      await tick();
      if (rows.has(k(pk, doc))) return false;
      await tick(); // the window in which a second writer would also see the row absent, if the store let it
      if (rows.has(k(pk, doc))) return false;
      rows.set(k(pk, doc), json);
      return true;
    };
    store.range = async (pk: string, after: string | null, limit: number) => {
      ops.range++;
      await tick();
      return [...rows]
        .filter(([key]) => key.startsWith(`${pk}\u0000`))
        .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json }))
        .filter((r) => after === null || r.doc > after)
        .sort((a, b) => (a.doc < b.doc ? -1 : 1))
        .slice(0, limit);
    };
  }
  const people = createPeople({ tables: createMemoryTables(schema) });
  const deps = {
    key: KEY,
    store,
    people,
    streams: { channelId: async () => "chan", publish: async () => undefined, token: async () => ({}) },
  };
  return { rows, ops, store, people, deps };
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

const op = { "x-squeak-relay": KEY };
const put = (deps: unknown, kind: string, id: string, box: string, pond = POND) =>
  call(deps, "PUT", `/doc?path=${encodeURIComponent(`channels/${pond}/${kind}/${id}`)}`, op, { doc: SEALED(box) });
const changes = (deps: unknown, query: string, headers: Record<string, string> = op) =>
  call(deps, "GET", `/changes?${query}`, headers);

describe("the sequence number", () => {
  it("is unique, increasing and gapless for concurrent writers on a store with no transactions", async () => {
    const { deps } = world();
    const writes = await Promise.all(Array.from({ length: 24 }, (_, i) => put(deps, "room", `d${i}`, `b${i}`)));
    expect(writes.every((w) => w.status === 204)).toBe(true);
    const all = await changes(deps, `pond=${POND}&since=0`);
    const seqs = all.json.changes.map((c: { seq: number }) => c.seq);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(all.json.changes.map((c: { id: string }) => c.id)).size).toBe(24);
    expect(all.json.more).toBe(false);
  });

  it("is per Pond: two Ponds each count from 1, and concurrent writers to both do not mix", async () => {
    const { deps } = world();
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => put(deps, "rtasks", `a${i}`, "x", POND)),
      ...Array.from({ length: 6 }, (_, i) => put(deps, "rtasks", `b${i}`, "x", OTHER)),
    ]);
    for (const pond of [POND, OTHER]) {
      const r = await changes(deps, `pond=${pond}&since=0`);
      expect(r.json.changes.map((c: { seq: number }) => c.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it("is stable across the hint boundary (a hint every 8 seqs) and with a stale hint", async () => {
    const { deps, rows } = world();
    for (let i = 0; i < 20; i++) await put(deps, "room", `d${i}`, "x");
    rows.delete(`feedhead\u0000${POND}`); // a lost hint costs reads, never correctness
    await Promise.all([put(deps, "room", "x1", "x"), put(deps, "room", "x2", "x")]);
    const r = await changes(deps, `pond=${POND}&since=0&limit=100`);
    expect(r.json.changes.map((c: { seq: number }) => c.seq)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it("is stamped on the stored document too, and the old list route still returns every document", async () => {
    const { deps } = world();
    await put(deps, "room", "d1", "one");
    const list = await call(deps, "GET", `/list?prefix=channels/${POND}/room`, op);
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([{ id: "d1", doc: { ...SEALED("one"), seq: 1 } }]);
  });

  it("is not given to kinds that are not Pond content, and a store without a feed works as before", async () => {
    const a = world();
    await call(a.deps, "PUT", `/doc?path=channels/${POND}/state/snapshot`, op, { doc: SEALED("s") });
    expect((await changes(a.deps, `pond=${POND}&since=0`)).json.changes).toEqual([]);
    for (const kind of FEED_KINDS) expect(KINDS.has(kind)).toBe(true);
    for (const kind of ["joinids", "devreqs", "devresults", "hist", "cliq", "state", "live"])
      expect(FEED_KINDS.has(kind)).toBe(false);

    const b = world({ noFeed: true });
    expect((await put(b.deps, "room", "d1", "one")).status).toBe(204);
    const stored = await call(b.deps, "GET", `/doc?path=channels/${POND}/room/d1`, op);
    expect(stored.json.doc).toEqual(SEALED("one"));
    expect((await changes(b.deps, `pond=${POND}&since=0`)).status).toBe(404);
  });
});

describe("GET /changes", () => {
  it("returns exactly the later documents, in order, with deletes as tombstones", async () => {
    const { deps } = world();
    await put(deps, "room", "a", "1");
    await put(deps, "rtasks", "t", "2");
    await put(deps, "room", "a", "3"); // the same document again: a new change
    await call(deps, "DELETE", `/doc?path=channels/${POND}/rtasks/t`, op);
    const r = await changes(deps, `pond=${POND}&since=1`);
    expect(r.json).toEqual({
      changes: [
        { seq: 2, kind: "rtasks", id: "t", doc: SEALED("2") },
        { seq: 3, kind: "room", id: "a", doc: SEALED("3") },
        { seq: 4, kind: "rtasks", id: "t", doc: null },
      ],
      next: 4,
      more: false,
    });
    expect((await changes(deps, `pond=${POND}&since=4`)).json).toEqual({ changes: [], next: 4, more: false });
    expect((await changes(deps, `pond=${POND}&since=head`)).json).toEqual({ changes: [], next: 4, more: false });
  });

  it("pages: a bounded page, a cursor, and no change lost or repeated across pages", async () => {
    const { deps } = world();
    for (let i = 0; i < 7; i++) await put(deps, "room", `d${i}`, "x");
    const first = await changes(deps, `pond=${POND}&since=0&limit=3`);
    expect(first.json.changes.map((c: { seq: number }) => c.seq)).toEqual([1, 2, 3]);
    expect([first.json.next, first.json.more]).toEqual([3, true]);
    const second = await changes(deps, `pond=${POND}&since=${first.json.next}&limit=3`);
    expect(second.json.changes.map((c: { seq: number }) => c.seq)).toEqual([4, 5, 6]);
    const third = await changes(deps, `pond=${POND}&since=${second.json.next}&limit=3`);
    expect([third.json.changes.map((c: { seq: number }) => c.seq), third.json.more]).toEqual([[7], false]);
    const huge = await changes(deps, `pond=${POND}&since=0&limit=5000`);
    expect(huge.json.changes).toHaveLength(7); // an oversized limit is clamped to the 100-change page, not refused
    expect((await changes(deps, `pond=${POND}&since=0&limit=x`)).status).toBe(400);
    expect((await changes(deps, `pond=${POND}&since=abc`)).status).toBe(400);
  });

  it("refuses a non-member: another account, a removed member, a Relay without the tables, a guest of another Pond", async () => {
    const { deps, people } = world();
    await people.upsertAccount({ userId: "u1", email: "owner@example.com", name: "Owner" });
    await people.upsertAccount({ userId: "u2", email: "guest@example.com", name: "Guest" });
    await people.upsertAccount({ userId: "u3", email: "out@example.com", name: "Out" });
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "Pond" });
    await people.addMember({ pondId: POND, userId: "u2", role: "member" });
    await put(deps, "room", "d1", "x");
    const token = (userId: string, email: string) => ({
      "x-squeak-account": scoped.issueAppToken(KEY, userId, email, Date.now(), 60_000).token,
    });
    const q = `pond=${POND}&since=0`;

    const member = await changes(deps, q, token("u2", "guest@example.com"));
    expect(member.status).toBe(200);
    expect(member.json.changes).toHaveLength(1);
    expect((await changes(deps, q, token("u1", "owner@example.com"))).status).toBe(200);
    expect((await changes(deps, q, token("u3", "out@example.com"))).status).toBe(403);
    expect((await changes(deps, q, { "x-squeak-account": "at.bad" })).status).toBe(401);

    await people.removeMember({ pondId: POND, userId: "u2", reason: "removed" });
    expect((await changes(deps, q, token("u2", "guest@example.com"))).status).toBe(403);

    const noTables = { ...deps, people: undefined };
    expect((await changes(noTables, q, token("u1", "owner@example.com"))).status).toBe(403);

    const guest = { "x-squeak-pond-token": scoped.issue(KEY, POND, "m1", Date.now(), 600, "member").token };
    expect((await changes(deps, q, guest)).status).toBe(200);
    expect((await changes(deps, `pond=${OTHER}&since=0`, guest)).status).toBe(403);
    expect((await changes(deps, q, {})).status).toBe(401);
    expect((await changes(deps, q, { "x-squeak-relay": "wrong" })).status).toBe(401);
  });

  it("costs one feed read to reopen a Pond that was already seen, and one to learn the end", async () => {
    const { deps, ops } = world();
    for (let i = 0; i < 5; i++) await put(deps, "room", `d${i}`, "x");
    // a device that read up to seq 5 comes back: one range read, no list, no per-document get
    const before = { ...ops };
    const r = await changes(deps, `pond=${POND}&since=5`);
    expect(r.json.changes).toEqual([]);
    expect(ops.range - before.range).toBe(1);
    expect(ops.list - before.list).toBe(0);
    expect(ops.get - before.get).toBe(0);
    // and one that is behind gets everything it missed in that one read
    const mid = { ...ops };
    const caught = await changes(deps, `pond=${POND}&since=2`);
    expect(caught.json.changes).toHaveLength(3);
    expect(ops.range - mid.range).toBe(1);
    expect(ops.list - mid.list).toBe(0);
  });
});

describe("the counter on its own", () => {
  it("retries past rows it did not know about and gives up with 503 under endless contention", async () => {
    const { store } = world();
    const feed = createFeed(store);
    // rows 1..3 exist but the hint says nothing: the writer finds the end and takes 4
    for (let n = 1; n <= 3; n++)
      await (store as any).claim(
        `feed/${POND}`,
        String(n).padStart(12, "0"),
        JSON.stringify({ seq: n, kind: "room", id: "x", doc: null }),
      );
    expect(await feed.append(POND, { kind: "room", id: "y", doc: SEALED("y") })).toBe(4);

    const stuck = createFeed({ ...store, claim: async () => false, range: async () => [] });
    await expect(stuck.append(POND, { kind: "room", id: "z", doc: null })).rejects.toMatchObject({ status: 503 });
  });

  it("is cleared by clean start", async () => {
    const { deps, rows } = world();
    await put(deps, "room", "d1", "x");
    await put(deps, "room", "d2", "x");
    expect([...rows.keys()].some((key) => key.startsWith("feed/"))).toBe(true);
    await createCleanStart({ store: deps.store, people: undefined }).run({ pondIds: [POND] });
    expect([...rows.keys()].filter((key) => key.startsWith("feed"))).toEqual([]);
  });
});
