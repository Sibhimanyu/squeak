/* eslint-disable @typescript-eslint/no-explicit-any -- the relay is untyped CommonJS and its req/res are test carriers */
// Pictures and files in the cloud (blobs.js, issue #123): sealed blobs in a bucket, referenced from a post by id. The bucket is
// the in-memory double; NoSQL is the same ordered store the other relay tests use.
import { createCipheriv, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const { createMemoryBucket } = require(`${fn}blob-memory.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const OTHER = "Q".repeat(32);
const ID = "b".repeat(22);
const sealed = (box: string) => ({ box, sig: "s", device: "d", at: 1 });

/** What a device sends: `<version>.` then nonce, AES-256-GCM ciphertext and tag. The relay holds no key. */
function seal(plain: Buffer, version = "1"): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", randomBytes(32), nonce);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from(`${version}.`), nonce, body, c.getAuthTag()]);
}

function world(over: Record<string, unknown> = {}) {
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
  const bucket = createMemoryBucket();
  const clock = { t: 1_000_000 };
  const deps = {
    key: KEY,
    store,
    people,
    blobBucket: bucket,
    now: () => clock.t,
    streams: { channelId: async () => "chan", publish: async () => undefined, token: async () => ({}) },
    ...over,
  };
  return { rows, store, people, bucket, deps, clock };
}

async function call(
  deps: unknown,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer | Record<string, unknown>,
) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = headers;
  let status = 0;
  let out: Buffer | string = "";
  const res: any = {
    writeHead: (s: number) => void (status = s),
    end: (t?: Buffer | string) => void (out = t ?? ""),
  };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  const bytes = Buffer.isBuffer(out) ? out : Buffer.from(out);
  let json: any;
  try {
    json = bytes.length && bytes[0] === 0x7b ? JSON.parse(bytes.toString("utf8")) : undefined;
  } catch {
    json = undefined;
  }
  return { status, bytes, json };
}

const op = { "x-squeak-relay": KEY };
const member = (who: string, pond = POND, scope = "member") => ({
  "x-squeak-pond-token": scoped.issue(KEY, pond, who, Date.now(), 600, scope).token,
});
const account = (userId: string) => ({
  "x-squeak-account": scoped.issueAppToken(KEY, userId, `${userId}@example.com`, Date.now(), 60_000).token,
});
const blobUrl = (id = ID, extra = "") => `/blob?pond=${POND}&id=${id}${extra}`;
const up = (deps: unknown, headers: Record<string, string>, bytes: Buffer, id = ID, doc = "p1", kind = "rposts") =>
  call(deps, "PUT", blobUrl(id, `&kind=${kind}&doc=${doc}`), headers, bytes);

async function withPond(over: Record<string, unknown> = {}) {
  const w = world(over);
  await w.people.upsertAccount({ userId: "u1", email: "u1@example.com", name: "Owner" });
  await w.people.upsertAccount({ userId: "u2", email: "u2@example.com", name: "Member" });
  await w.people.upsertAccount({ userId: "u3", email: "u3@example.com", name: "Outsider" });
  await w.people.createPond({ pondId: POND, ownerUserId: "u1", name: "Pond" });
  await w.people.addMember({ pondId: POND, userId: "u2", role: "member" });
  return w;
}

describe("a sealed blob round trip", () => {
  it("stores what a Member sealed and hands the same bytes to every member, in a bucket and not in NoSQL", async () => {
    const { deps, bucket, rows } = await withPond();
    const plain = Buffer.from("PLAINTEXT-MARKER-picture-bytes-that-must-not-appear");
    const box = seal(plain);
    expect((await up(deps, member("ann"), box)).status).toBe(204);

    // Another Member's token, a member account and the Owner's key all read the same sealed bytes back.
    for (const who of [member("bob"), account("u2"), account("u1"), op]) {
      const got = await call(deps, "GET", blobUrl(), who);
      expect(got.status).toBe(200);
      expect(got.bytes.equals(box)).toBe(true);
    }
    // The bytes are in the bucket; NoSQL holds only a small metadata row (no bytes).
    expect([...bucket.objects.values()].some((b: Buffer) => b.equals(box))).toBe(true);
    const meta = [...rows].filter(([key]) => key.startsWith("blobs/"));
    expect(meta).toHaveLength(1);
    expect(JSON.parse(meta[0]![1])).toMatchObject({ v: 1, size: box.length, kind: "rposts", doc: "p1" });
    expect(meta[0]![1].length).toBeLessThan(200);
  });

  it("the Owner's key can also keep a blob for a Room post and remove it", async () => {
    const { deps } = await withPond();
    expect((await up(deps, op, seal(Buffer.from("x".repeat(500))), ID, "r1", "room")).status).toBe(204);
    expect((await call(deps, "DELETE", blobUrl(), op)).status).toBe(204);
    expect((await call(deps, "GET", blobUrl(), op)).status).toBe(404);
  });
});

describe("plaintext never reaches the relay", () => {
  it("refuses bytes that are not sealed (a picture as it is) and keeps no plaintext anywhere", async () => {
    const { deps, bucket, rows } = await withPond();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    const r = await up(deps, member("ann"), png);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("blob-unsealed");
    expect(bucket.objects.size).toBe(0);
    expect([...rows.keys()].some((key) => key.startsWith("blobs/"))).toBe(false);
  });

  it("a sealed upload leaves no plaintext in the bucket or any NoSQL row", async () => {
    const { deps, bucket, rows } = await withPond();
    const plain = Buffer.from("SECRET-PHOTO-OF-THE-WHITEBOARD ".repeat(40));
    await up(deps, member("ann"), seal(plain));
    const everything = [
      ...[...bucket.objects.values()].map((b: Buffer) => b.toString("latin1")),
      ...rows.values(),
      ...rows.keys(),
    ].join("\n");
    expect(everything).not.toContain("SECRET-PHOTO");
  });
});

describe("who may fetch", () => {
  it("refuses a non-member: an account outside the Pond, another Pond's token, an invite token, no credential", async () => {
    const { deps } = await withPond();
    await up(deps, member("ann"), seal(Buffer.from("hello".repeat(30))));
    expect((await call(deps, "GET", blobUrl(), account("u3"))).status).toBe(403);
    expect((await call(deps, "GET", blobUrl(), member("zed", OTHER))).status).toBe(403);
    expect((await call(deps, "GET", blobUrl(), member("inv", POND, "join"))).status).toBe(403);
    expect((await call(deps, "GET", blobUrl(), {})).status).toBe(401);
    expect((await call(deps, "GET", blobUrl(), { "x-squeak-relay": "wrong" })).status).toBe(401);
    expect((await call(deps, "GET", blobUrl(), { "x-squeak-account": "at.bad" })).status).toBe(401);
    const noTables = { ...deps, people: undefined };
    expect((await call(noTables, "GET", blobUrl(), account("u2"))).status).toBe(403);
  });

  it("a removed member can no longer fetch: their token is revoked and their account is out of the Pond", async () => {
    const { deps, people } = await withPond();
    await up(deps, member("ann"), seal(Buffer.from("hello".repeat(30))));
    expect((await call(deps, "GET", blobUrl(), member("ann"))).status).toBe(200);
    expect((await call(deps, "GET", blobUrl(), account("u2"))).status).toBe(200);

    expect((await call(deps, "POST", "/pond-revoke", op, { pondId: POND, memberId: "ann" })).status).toBe(204);
    await people.removeMember({ pondId: POND, userId: "u2", reason: "removed" });
    expect((await call(deps, "GET", blobUrl(), member("ann"))).status).toBe(401);
    expect((await call(deps, "GET", blobUrl(), account("u2"))).status).toBe(403);
    // The removed member's token cannot add one either.
    expect((await up(deps, member("ann"), seal(Buffer.from("again".repeat(30))), "c".repeat(22))).status).toBe(401);
  });

  it("an account can read but never write, and a Member's token cannot delete or write for the Owner's kind", async () => {
    const { deps } = await withPond();
    const box = seal(Buffer.from("hello".repeat(30)));
    expect((await up(deps, account("u2"), box)).status).toBe(403);
    expect((await up(deps, member("ann"), box, ID, "r1", "room")).status).toBe(400);
    expect((await up(deps, member("ann"), box)).status).toBe(204);
    expect((await call(deps, "DELETE", blobUrl(), member("ann"))).status).toBe(403);
    expect((await call(deps, "GET", blobUrl(), op)).status).toBe(200);
  });

  it("a blob never changes: its id cannot be written twice", async () => {
    const { deps } = await withPond();
    expect((await up(deps, member("ann"), seal(Buffer.from("one".repeat(30))))).status).toBe(204);
    expect((await up(deps, member("bob"), seal(Buffer.from("two".repeat(30))))).status).toBe(409);
  });
});

describe("limits", () => {
  it("refuses a blob over the size limit with a plain sentence, before storing any of it", async () => {
    const { deps, bucket } = await withPond({ blobMaxBytes: 1000 });
    const r = await up(deps, member("ann"), seal(Buffer.alloc(2000, 1)));
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "blob-too-large", message: "A picture or file can be at most 6 MB." });
    expect(bucket.objects.size).toBe(0);
    expect((await up(deps, member("ann"), seal(Buffer.alloc(500, 1)))).status).toBe(204);
  });

  it("counts each Pond's blobs against its own cap, and says so plainly", async () => {
    const { deps } = await withPond({ blobCapBytes: 1500 });
    const one = seal(Buffer.alloc(600, 1));
    expect((await up(deps, member("ann"), one, "a".repeat(22), "p1")).status).toBe(204);
    expect((await up(deps, member("ann"), one, "b".repeat(22), "p2")).status).toBe(204);
    const over = await up(deps, member("ann"), one, "c".repeat(22), "p3");
    expect(over.status).toBe(413);
    expect(over.json).toEqual({
      error: "blob-quota",
      message: "This Pond has used its 200 MB of pictures and files.",
    });
    // Another Pond is not affected.
    const elsewhere = await call(
      deps,
      "PUT",
      `/blob?pond=${OTHER}&id=${"d".repeat(22)}&kind=rposts&doc=p1`,
      member("ann", OTHER),
      one,
    );
    expect(elsewhere.status).toBe(204);
  });

  it("when full, frees blobs whose post never arrived (older than an hour) before refusing", async () => {
    const { deps, clock, bucket } = await withPond({ blobCapBytes: 1500 });
    const one = seal(Buffer.alloc(600, 1));
    await up(deps, member("ann"), one, "a".repeat(22), "never-posted");
    await up(deps, member("ann"), one, "b".repeat(22), "p2");
    // p2's post is stored; "never-posted" has none. Within the hour nothing is swept.
    await call(deps, "PUT", `/doc?path=${encodeURIComponent(`channels/${POND}/rposts/p2`)}`, member("ann"), {
      doc: sealed("box"),
    });
    expect((await up(deps, member("ann"), one, "c".repeat(22), "p3")).status).toBe(413);
    clock.t += 2 * 3_600_000;
    expect((await up(deps, member("ann"), one, "c".repeat(22), "p3")).status).toBe(204);
    expect(bucket.objects.size).toBe(2);
    expect((await call(deps, "GET", blobUrl("a".repeat(22)), op)).status).toBe(404);
    expect((await call(deps, "GET", blobUrl("b".repeat(22)), op)).status).toBe(200);
  });

  it("is off with a plain 503 until a bucket is wired", async () => {
    const { deps } = await withPond({ blobBucket: undefined });
    expect((await up(deps, member("ann"), seal(Buffer.from("x".repeat(60))))).status).toBe(503);
  });
});

describe("cleanup", () => {
  const post = (deps: unknown, kind: string, id: string, headers: Record<string, string>) =>
    call(deps, "PUT", `/doc?path=${encodeURIComponent(`channels/${POND}/${kind}/${id}`)}`, headers, {
      doc: sealed("x".repeat(300)),
    });

  it("a post paged out of the Room takes its blobs with it", async () => {
    const { deps, bucket, rows } = await withPond({ roomCapBytes: 3000 });
    const one = seal(Buffer.alloc(300, 1));
    await up(deps, op, one, "a".repeat(22), "r000", "room");
    await post(deps, "room", "r000", op);
    await up(deps, member("ann"), one, "b".repeat(22), "p000", "rposts");
    await post(deps, "rposts", "p000", member("ann"));
    expect(bucket.objects.size).toBe(2);
    // The Room grows past its cap: the oldest posts (by seq) are paged out, and their pictures go from Stratus.
    for (let i = 1; i < 30; i++) await post(deps, "room", `r${String(i).padStart(3, "0")}`, op);
    expect(rows.has("channels/" + POND + "/room\u0000r000")).toBe(false);
    expect(bucket.objects.size).toBe(0);
    expect((await call(deps, "GET", blobUrl("a".repeat(22)), op)).status).toBe(404);
    expect([...rows.keys()].some((key) => key.startsWith("blobs/"))).toBe(false);
  });

  it("deleting a post deletes its blobs; other posts' blobs stay", async () => {
    const { deps, bucket } = await withPond();
    const one = seal(Buffer.alloc(300, 1));
    await up(deps, op, one, "a".repeat(22), "r1", "room");
    await up(deps, op, one, "b".repeat(22), "r2", "room");
    await post(deps, "room", "r1", op);
    await post(deps, "room", "r2", op);
    expect((await call(deps, "DELETE", `/doc?path=${encodeURIComponent(`channels/${POND}/room/r1`)}`, op)).status).toBe(
      204,
    );
    expect(bucket.objects.size).toBe(1);
    expect((await call(deps, "GET", blobUrl("b".repeat(22)), op)).status).toBe(200);
  });

  it("clean start removes every blob of the Pond", async () => {
    const { deps, bucket, rows } = await withPond({ cleanStart: true });
    await up(deps, op, seal(Buffer.alloc(300, 1)), "a".repeat(22), "r1", "room");
    const done = await call(deps, "POST", "/admin/clean-start", op, { confirm: "wipe-cloud-ponds", pondIds: [POND] });
    expect(done.status).toBe(200);
    expect(bucket.objects.size).toBe(0);
    expect([...rows.keys()].some((key) => key.startsWith("blobs/"))).toBe(false);
  });
});
