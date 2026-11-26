// The Room in the cloud (room-cloud.js, issue #122): a Member's post is a stamped document every Member reads at once, the whole
// Room is kept (no 200-post cap), the oldest are paged out past a byte cap with a note, and the removed kinds are gone.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const { KINDS } = require(`${fn}rules.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const sealed = (box: string) => ({ box, sig: "s", device: "d", at: 1 });

/** A store like Catalyst NoSQL: insert-only claim and ordered range, as feed.js needs. */
function world(over: { roomCapBytes?: number } = {}) {
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
  const people = createPeople({ tables: createMemoryTables(schema) });
  const deps = {
    key: KEY,
    store,
    people,
    ...over,
    streams: { channelId: async () => "chan", publish: async () => undefined, token: async () => ({}) },
  };
  return { rows, store, deps };
}

async function call(deps: unknown, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = headers;
  let status = 0;
  let text = "";
  const res: any = { writeHead: (s: number) => void (status = s), end: (t?: string) => void (text = t ?? "") };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  return { status, json: text ? JSON.parse(text) : undefined };
}

const token = (member: string, scope = "member") => ({
  "x-squeak-pond-token": scoped.issue(KEY, POND, member, Date.now(), 600, scope).token,
});
const op = { "x-squeak-relay": KEY };
const path = (kind: string, id: string) => `/doc?path=${encodeURIComponent(`channels/${POND}/${kind}/${id}`)}`;
const post = (deps: unknown, kind: string, id: string, box: string, headers: Record<string, string>) =>
  call(deps, "PUT", path(kind, id), headers, { doc: sealed(box) });
const feed = (deps: unknown, headers: Record<string, string>, since = 0) =>
  call(deps, "GET", `/changes?pond=${POND}&since=${since}&limit=100`, headers);

describe("Members' posts are visible at once", () => {
  it("another Member reads a Member's post while no Owner's Mac has called, ordered by seq", async () => {
    const { deps } = world();
    // Ann, Bob and Cy are Members; no Mac key is used anywhere in this test: the Owner's Mac is offline.
    for (const [who, id, box] of [
      ["ann", "000a", "ann-1"],
      ["bob", "000b", "bob-1"],
      ["ann", "000c", "ann-2"],
    ] as const)
      expect((await post(deps, "rposts", id, box, token(who))).status).toBe(204);
    const seen = await feed(deps, token("cy"));
    expect(seen.status).toBe(200);
    expect(seen.json.changes.map((c: any) => [c.seq, c.id, c.doc.box])).toEqual([
      [1, "000a", "ann-1"],
      [2, "000b", "bob-1"],
      [3, "000c", "ann-2"],
    ]);
    const listed = await call(
      deps,
      "GET",
      `/list?prefix=${encodeURIComponent(`channels/${POND}/rposts`)}`,
      token("cy"),
    );
    expect(listed.json.items.map((i: any) => [i.id, i.doc.seq])).toEqual([
      ["000a", 1],
      ["000b", 2],
      ["000c", 3],
    ]);
  });

  it("a Member's token can add a post, never overwrite or delete anyone's", async () => {
    const { deps } = world();
    expect((await post(deps, "rposts", "p1", "mine", token("ann"))).status).toBe(204);
    expect((await post(deps, "rposts", "p1", "forged", token("bob"))).status).toBe(409);
    expect((await call(deps, "DELETE", path("rposts", "p1"), token("bob"))).status).toBe(403);
    expect((await call(deps, "GET", path("rposts", "p1"), token("bob"))).json.doc.box).toBe("mine");
    // The Owner's own key still pages and removes.
    expect((await call(deps, "DELETE", path("rposts", "p1"), op)).status).toBe(204);
  });

  it("keeps the whole Room: a joiner reads far more than the old 200 posts, in order", async () => {
    const { deps } = world();
    for (let i = 0; i < 260; i++) await post(deps, "room", `r${String(i).padStart(4, "0")}`, `box-${i}`, op);
    const listed = await call(deps, "GET", `/list?prefix=${encodeURIComponent(`channels/${POND}/room`)}`, token("new"));
    expect(listed.json.items).toHaveLength(260);
    let since = 0;
    let all: any[] = [];
    for (;;) {
      const page = (await feed(deps, token("new"), since)).json;
      all = all.concat(page.changes);
      since = page.next;
      if (!page.more) break;
    }
    expect(all.map((c) => c.seq)).toEqual(Array.from({ length: 260 }, (_, i) => i + 1));
  });
});

describe("the 25 MB cap, scaled down", () => {
  it("pages out the oldest posts by seq, writes a note, and tells every Member through the feed", async () => {
    const { deps, rows } = world({ roomCapBytes: 6000 });
    const box = "x".repeat(300);
    for (let i = 0; i < 40; i++) {
      const who = i % 2 === 0 ? "ann" : "bob";
      expect(
        (
          await post(
            deps,
            i % 5 === 0 ? "room" : "rposts",
            `p${String(i).padStart(3, "0")}`,
            box,
            i % 5 === 0 ? op : token(who),
          )
        ).status,
      ).toBe(204);
    }
    const left = [...rows.keys()].filter((key) => /\/(room|rposts)\u0000/.test(key));
    const bytes = left.reduce((n, key) => n + Buffer.byteLength(rows.get(key)!), 0);
    expect(bytes).toBeLessThanOrEqual(6000);
    expect(left.length).toBeLessThan(40);
    // What is left is the newest: every removed post is older than every kept one.
    const keptSeqs = left.map((key) => JSON.parse(rows.get(key)!).seq as number);
    const oldestKept = Math.min(...keptSeqs);
    const all = (await feed(deps, token("cy"))).json.changes as any[];
    const removed = all.filter((c) => c.doc === null && (c.kind === "room" || c.kind === "rposts"));
    expect(removed.length).toBeGreaterThan(0);
    const written = new Map<string, number>(all.filter((c) => c.doc !== null).map((c) => [`${c.kind}/${c.id}`, c.seq]));
    for (const c of removed) expect(written.get(`${c.kind}/${c.id}`)!).toBeLessThan(oldestKept);
    const note = await call(deps, "GET", path("roomnote", "trim"), token("cy"));
    expect(note.status).toBe(200);
    expect(note.json.doc).toMatchObject({ v: 1, removed: removed.length });
    expect(note.json.doc.before).toBeLessThan(oldestKept);
    // The note reached the feed, so a device following it learns of the page-out without asking.
    expect(all.some((c) => c.kind === "roomnote" && c.doc?.removed === removed.length)).toBe(true);
  });

  it("does not page out a Room that fits, even when overwrites made the counter run high", async () => {
    const { deps, rows } = world({ roomCapBytes: 4000 });
    for (let i = 0; i < 30; i++) await post(deps, "room", "same", "y".repeat(200), op);
    expect([...rows.keys()].some((key) => key.includes("roomnote"))).toBe(false);
    expect((await call(deps, "GET", path("room", "same"), op)).status).toBe(200);
  });

  it("only the relay writes the note: no token and no Mac key can", async () => {
    const { deps } = world();
    expect((await post(deps, "roomnote", "trim", "n", token("ann"))).status).toBe(403);
    expect((await post(deps, "roomnote", "trim", "n", op)).status).toBe(403);
  });
});

describe("kinds that are gone", () => {
  it("ripples, presence documents, grants, claims and Flotilla tasks are not kinds any more", async () => {
    for (const kind of ["ripples", "presence", "grants", "claims", "tasks", "locks"]) {
      expect(KINDS.has(kind)).toBe(false);
      const { deps } = world();
      expect((await post(deps, kind, "d1", "b", op)).status).toBe(400);
      expect((await post(deps, kind, "d1", "b", token("ann"))).status).toBe(403);
    }
  });

  it("the short invite-code routes answer nothing", async () => {
    const { deps } = world();
    expect((await call(deps, "POST", "/ponds/short", op, {})).status).toBe(404);
    expect((await call(deps, "POST", "/ponds/short/redeem", op, {})).status).toBe(404);
  });
});
