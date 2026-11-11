import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { noticeTag } = require(`${fn}scoped.js`);
const crypto = require("node:crypto");

const KEY = "k".repeat(43);
const MAC_A = "A".repeat(30);
const MAC_B = "B".repeat(30);
const POND = "P".repeat(30);
type User = { userId: string; email: string; name: string } | null;
const U1: User = { userId: "u1", email: "pat@example.com", name: "Pat" };
const U2: User = { userId: "u2", email: "lee@example.com", name: "Lee" };

function setup(opts: { limits?: { requests: number; bytes: number }; hosted?: boolean } = {}) {
  const rows = new Map<string, string>();
  const published: Array<[string, string]> = [];
  const clock = { t: Date.UTC(2026, 10, 11, 12) };
  const state: { who: User } = { who: U1 };
  const deps: any = {
    key: KEY,
    now: () => clock.t,
    limits: opts.limits,
    hosted: opts.hosted,
    currentUser: async () => state.who,
    store: {
      ready: async () => true,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: {
      channelId: async () => "shared",
      publish: async (id: string, text: string) => void published.push([id, text]),
      token: async (id: string, name: string) => ({ url: "u", key: `tok-${id}-${name}`, "wss-id": "w" }),
    },
  };
  return { deps, rows, published, clock, state };
}

async function call(deps: unknown, method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = headers;
  let status = 0;
  let text = "";
  const res: any = { writeHead: (s: number) => (status = s), end: (t?: string) => (text = t ?? "") };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  return { status, json: text ? JSON.parse(text) : undefined, text };
}

const provision = (f: ReturnType<typeof setup>, macId = MAC_A, name?: string) =>
  call(f.deps, "POST", "/account/macs/provision", { cookie: "x" }, { macId, ...(name ? { name } : {}) });
const mk = (key: string) => ({ "x-squeak-mac-key": key });
const doc = { box: "sealed", sig: "s", device: "d", at: 1 };
const put = (f: ReturnType<typeof setup>, key: string, ch: string, kind = "state", d = doc) =>
  call(f.deps, "PUT", `/doc?path=channels/${ch}/${kind}/d1`, mk(key), { doc: d });
const get = (f: ReturnType<typeof setup>, key: string, ch: string, kind = "state") =>
  call(f.deps, "GET", `/doc?path=channels/${ch}/${kind}/d1`, mk(key));

async function twoMacs(f = setup()) {
  f.state.who = U1;
  const a = (await provision(f, MAC_A)).json.key as string;
  f.state.who = U2;
  const b = (await provision(f, MAC_B)).json.key as string;
  return { f, a, b };
}

describe("provisioning a per-Mac key", () => {
  it("returns the key once and stores only its hash", async () => {
    const f = setup();
    const r = await provision(f, MAC_A, "Pat's Mac");
    expect(r.status).toBe(200);
    expect(r.json.macId).toBe(MAC_A);
    expect(r.json.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.json.header).toBe("x-squeak-mac-key");
    expect(r.json.rotated).toBe(false);
    const stored = JSON.stringify([...f.rows]);
    expect(stored).not.toContain(r.json.key);
    const hash = crypto.createHash("sha256").update(r.json.key).digest("base64url");
    expect(f.rows.has(`mac-keys|${hash}`)).toBe(true);
    // nothing returns the key again: a second provision is a new key
    const again = await provision(f, MAC_A);
    expect(again.json.rotated).toBe(true);
    expect(again.json.key).not.toBe(r.json.key);
    expect(JSON.stringify([...f.rows])).not.toContain(again.json.key);
  });

  it("needs a signed-in account (cookie or app token), strict body", async () => {
    const f = setup();
    f.state.who = null;
    expect((await provision(f)).status).toBe(401);
    f.state.who = U1;
    const bad = (b: unknown) => call(f.deps, "POST", "/account/macs/provision", {}, b);
    expect((await bad({ macId: "short" })).status).toBe(400);
    expect((await bad({ macId: MAC_A, extra: 1 })).status).toBe(400);
    expect((await bad({ macId: MAC_A, name: "x".repeat(65) })).status).toBe(400);
    expect((await bad({ macId: MAC_A, name: "bad\nname" })).status).toBe(400);
    expect((await bad({ macId: MAC_A, name: 5 })).status).toBe(400);
    // the relay key alone is not an account
    f.state.who = null;
    expect(
      (await call(f.deps, "POST", "/account/macs/provision", { "x-squeak-relay": KEY }, { macId: MAC_A })).status,
    ).toBe(401);
    // an app token works and is what a Mac holds
    f.state.who = U1;
    const tok = (await call(f.deps, "POST", "/account/app-token", {})).json.token;
    f.state.who = null;
    const viaToken = await call(
      f.deps,
      "POST",
      "/account/macs/provision",
      { "x-squeak-account": tok },
      { macId: MAC_A },
    );
    expect(viaToken.status).toBe(200);
  });

  it("allows 10 Macs per account, then 409; rotating one is not a new Mac", async () => {
    const f = setup();
    for (let i = 0; i < 10; i++) expect((await provision(f, `M${i}`.padEnd(20, "x"))).status).toBe(200);
    const over = await provision(f, "Z".repeat(20));
    expect(over.status).toBe(409);
    expect(over.json).toEqual({ error: "too-many-macs" });
    expect((await provision(f, "M0".padEnd(20, "x"))).status).toBe(200);
    f.state.who = U2;
    expect((await provision(f, "Z".repeat(20))).status).toBe(200);
  });

  it("refuses a macId owned by another account, even after revocation of its key", async () => {
    const { f } = await twoMacs();
    f.state.who = U2;
    expect((await provision(f, MAC_A)).status).toBe(403);
    f.state.who = U1;
    expect((await call(f.deps, "DELETE", `/account/macs/${MAC_A}`, { cookie: "x" })).status).toBe(204);
    f.state.who = U2;
    expect((await provision(f, MAC_A)).status).toBe(403); // the channel claim stays with the first account
  });

  it("rotating invalidates the old key", async () => {
    const f = setup();
    const old = (await provision(f)).json.key;
    expect((await put(f, old, MAC_A)).status).toBe(204);
    const fresh = (await provision(f)).json.key;
    expect((await put(f, old, MAC_A)).status).toBe(401);
    expect((await put(f, fresh, MAC_A)).status).toBe(204);
  });

  it("DELETE revokes (owner only) and the key then gets 401", async () => {
    const { f, a } = await twoMacs();
    f.state.who = U2;
    expect((await call(f.deps, "DELETE", `/account/macs/${MAC_A}`, { cookie: "x" })).status).toBe(403);
    f.state.who = null;
    expect((await call(f.deps, "DELETE", `/account/macs/${MAC_A}`, {})).status).toBe(401);
    f.state.who = U1;
    expect((await get(f, a, MAC_A)).status).toBe(404);
    expect((await call(f.deps, "DELETE", `/account/macs/${MAC_A}`, { cookie: "x" })).status).toBe(204);
    expect((await get(f, a, MAC_A)).status).toBe(401);
    expect((await call(f.deps, "DELETE", `/account/macs/${MAC_A}`, { cookie: "x" })).status).toBe(404);
    // a freed slot: the account can provision again
    expect((await provision(f, MAC_A)).status).toBe(200);
  });

  it("no /doc or /list path reaches the relay-owned partition keys", async () => {
    const { f, a } = await twoMacs();
    for (const pk of ["mac-keys", "mac-owners", "channel-owners", "usage", "mac-user/u1"]) {
      for (const headers of [{ "x-squeak-relay": KEY }, mk(a)]) {
        expect((await call(f.deps, "GET", `/doc?path=${pk}/${MAC_A}`, headers)).status).toBe(400);
        expect((await call(f.deps, "GET", `/list?prefix=${pk}`, headers)).status).toBe(400);
        expect((await call(f.deps, "GET", `/doc?path=channels/${MAC_A}/${pk}/x`, headers)).status).toBe(400);
      }
    }
  });
});

describe("tenant isolation", () => {
  it("a Mac key works in its own channel", async () => {
    const { f, a } = await twoMacs();
    expect((await put(f, a, MAC_A)).status).toBe(204);
    const r = await get(f, a, MAC_A);
    expect(r.status).toBe(200);
    expect(r.json.doc.box).toBe("sealed");
    expect((await call(f.deps, "GET", `/list?prefix=channels/${MAC_A}/state`, mk(a))).json.items).toHaveLength(1);
  });

  it("Mac A cannot read, write, delete, list, or stream Mac B's channel", async () => {
    const { f, a, b } = await twoMacs(setup({ hosted: true }));
    expect((await put(f, b, MAC_B)).status).toBe(204);
    expect((await get(f, a, MAC_B)).status).toBe(403);
    expect((await put(f, a, MAC_B)).status).toBe(403);
    expect((await call(f.deps, "DELETE", `/doc?path=channels/${MAC_B}/state/d1`, mk(a))).status).toBe(403);
    expect((await call(f.deps, "GET", `/list?prefix=channels/${MAC_B}/state`, mk(a))).status).toBe(403);
    expect(f.rows.get(`channels/${MAC_B}/state|d1`)).toContain("sealed");
    // streams: a Mac key gets the shared stream, whose hosted notices are opaque
    const ta = (await call(f.deps, "POST", "/token", mk(a), { name: "n" })).json;
    const tb = (await call(f.deps, "POST", "/token", mk(b), { name: "n" })).json;
    expect(ta.key).toBe("tok-shared-n");
    expect(tb.key).toBe("tok-shared-n");
    // pond tokens and revocations only for its own ponds
    expect((await call(f.deps, "POST", "/pond-token", mk(a), { pondId: MAC_B, memberId: "m1" })).status).toBe(403);
    expect((await call(f.deps, "POST", "/pond-revoke", mk(a), { pondId: MAC_B, memberId: "m1" })).status).toBe(403);
    // account routes only for itself
    expect((await call(f.deps, "POST", "/account/unlink", mk(a), { macId: MAC_B })).status).toBe(403);
    expect((await call(f.deps, "GET", "/account/avatar?userId=u2", mk(a))).status).toBe(403);
    expect((await call(f.deps, "GET", "/account/avatar?userId=u1", mk(a))).status).toBe(404);
  });

  it("a Mac claims its pond channels first-come, another Mac cannot take them, the count is capped", async () => {
    const { f, a, b } = await twoMacs();
    expect((await put(f, a, POND, "pond")).status).toBe(204);
    expect((await get(f, b, POND, "pond")).status).toBe(403);
    expect((await put(f, b, POND, "pond")).status).toBe(403);
    expect((await call(f.deps, "POST", "/pond-token", mk(a), { pondId: POND, memberId: "m1" })).status).toBe(200);
    for (let i = 0; i < 62; i++) expect((await put(f, a, `C${i}`.padEnd(24, "c"))).status).toBe(204);
    expect((await put(f, a, "D".repeat(24))).status).toBe(403);
  });

  it("a Mac key cannot link another Mac's id or another account's ticket", async () => {
    const { f, a } = await twoMacs();
    f.state.who = U2;
    const t2 = (await call(f.deps, "POST", "/account/link-ticket", {})).json.ticket;
    f.state.who = U1;
    const t1 = (await call(f.deps, "POST", "/account/link-ticket", {})).json.ticket;
    expect((await call(f.deps, "POST", "/account/link", mk(a), { ticket: t2, macId: MAC_A, name: "x" })).status).toBe(
      403,
    );
    expect((await call(f.deps, "POST", "/account/link", mk(a), { ticket: t1, macId: MAC_B, name: "x" })).status).toBe(
      403,
    );
    expect((await call(f.deps, "POST", "/account/link", mk(a), { ticket: t1, macId: MAC_A, name: "x" })).status).toBe(
      200,
    );
  });

  it("the operator key still opens every channel; a Mac key plus the relay key is refused", async () => {
    const { f, a } = await twoMacs();
    const op = { "x-squeak-relay": KEY };
    expect((await call(f.deps, "PUT", `/doc?path=channels/${MAC_B}/state/d1`, op, { doc })).status).toBe(204);
    expect((await call(f.deps, "GET", `/doc?path=channels/${MAC_B}/state/d1`, op)).status).toBe(200);
    expect((await call(f.deps, "GET", `/doc?path=channels/${MAC_B}/state/d1`, { ...op, ...mk(a) })).status).toBe(401);
    expect((await get(f, "x".repeat(43), MAC_A)).status).toBe(401);
    expect((await get(f, "short", MAC_A)).status).toBe(401);
  });

  it("a Mac key cannot write the relay-owned kinds the relay key cannot", async () => {
    const { f, a } = await twoMacs();
    expect((await put(f, a, MAC_A, "devreqs")).status).toBe(403);
    expect((await put(f, a, MAC_A, "joinids")).status).toBe(403);
  });

  it("hosted publishes only the opaque tag; self-hosted is unchanged", async () => {
    for (const hosted of [true, false]) {
      const { f, a } = await twoMacs(setup({ hosted }));
      await put(f, a, MAC_A);
      expect(f.published).toEqual([
        ["shared", JSON.stringify(hosted ? { t: noticeTag(MAC_A) } : { p: `channels/${MAC_A}/state` })],
      ]);
      if (hosted) expect(f.published[0]![1]).not.toContain(MAC_A);
    }
  });

  it("pins the tag vector (the same one is in the daemon's tests)", () => {
    expect(noticeTag("A".repeat(30))).toBe("uhjd2c2uhsob5iRwl6Scxr");
    expect(noticeTag(MAC_A)).not.toBe(noticeTag(MAC_B));
  });
});

describe("a Mac key sent as x-squeak-relay, and the account link rows", () => {
  const rel = (key: string) => ({ "x-squeak-relay": key });

  it("is confined exactly like x-squeak-mac-key; the operator key and wrong values behave", async () => {
    const { f, a, b } = await twoMacs();
    const put2 = (key: string, ch: string) =>
      call(f.deps, "PUT", `/doc?path=channels/${ch}/state/d1`, rel(key), { doc });
    expect((await put2(a, MAC_A)).status).toBe(204);
    expect((await put2(a, MAC_B)).status).toBe(403);
    expect((await call(f.deps, "GET", `/list?prefix=channels/${MAC_B}/state`, rel(a))).status).toBe(403);
    expect((await call(f.deps, "POST", "/pond-token", rel(a), { pondId: MAC_B, memberId: "m" })).status).toBe(403);
    expect((await call(f.deps, "GET", "/account/avatar?userId=u2", rel(a))).status).toBe(403);
    expect((await call(f.deps, "POST", "/token", rel(b), { name: "n" })).json.key).toBe("tok-shared-n");
    expect((await put2("x".repeat(43), MAC_A)).status).toBe(401);
    expect((await put2("wrong", MAC_A)).status).toBe(401);
    expect((await put2(KEY, MAC_B)).status).toBe(204);
  });

  it("counts against the account's day like the other header", async () => {
    const f = setup({ limits: { requests: 2, bytes: 1_000_000 } });
    const a = (await provision(f, MAC_A)).json.key;
    const g = () => call(f.deps, "GET", `/doc?path=channels/${MAC_A}/state/d1`, rel(a));
    await g();
    await g();
    expect((await g()).status).toBe(429);
  });

  it("provision writes the link rows (idempotent on rotate), DELETE removes them", async () => {
    const f = setup();
    f.state.who = U1;
    await provision(f, MAC_A, "Pat's Mac");
    expect(JSON.parse(f.rows.get(`accounts/u1|${MAC_A}`)!).name).toBe("Pat's Mac");
    expect(JSON.parse(f.rows.get(`maclinks|${MAC_A}`)!)).toEqual({ userId: "u1", email: "pat@example.com" });
    const macs = (await call(f.deps, "GET", "/account/macs", { cookie: "x" })).json.macs;
    expect(macs).toEqual([expect.objectContaining({ macId: MAC_A, name: "Pat's Mac" })]);
    const linkedAt = macs[0].linkedAt;
    f.clock.t += 1000;
    await provision(f, MAC_A);
    const again = JSON.parse(f.rows.get(`accounts/u1|${MAC_A}`)!);
    expect(again).toMatchObject({ name: "Pat's Mac", linkedAt });
    // device requests work without a sign-in ticket
    const dr = await call(
      f.deps,
      "POST",
      "/account/device-request",
      { cookie: "x" },
      {
        macId: MAC_A,
        name: "Phone",
        publicKey: "pk1",
        boxKey: "bk1",
      },
    );
    expect(dr.status).toBe(200);
    expect((await call(f.deps, "DELETE", `/account/macs/${MAC_A}`, { cookie: "x" })).status).toBe(204);
    expect(f.rows.has(`accounts/u1|${MAC_A}`)).toBe(false);
    expect(f.rows.has(`maclinks|${MAC_A}`)).toBe(false);
    expect([...f.rows.keys()].some((k) => k.startsWith(`channels/${MAC_A}/devreqs`))).toBe(false);
  });
});

describe("phones (pairing credentials) stay working and confined", () => {
  // A paired phone holds the Mac's grant: the Mac's own key as `ck` (a hosted Mac) or a pond token (a web guest).
  it("a phone using its Mac's key reaches that Mac's channel and nothing else", async () => {
    const { f, a, b } = await twoMacs();
    expect((await put(f, a, MAC_A, "commands")).status).toBe(204);
    expect((await put(f, b, MAC_B, "state")).status).toBe(204);
    expect((await get(f, a, MAC_B)).status).toBe(403);
  });

  it("pond tokens still work, in their pond only, with a Mac-issued token", async () => {
    const { f, a } = await twoMacs();
    const token = (await call(f.deps, "POST", "/pond-token", mk(a), { pondId: POND, memberId: "m1" })).json.token;
    const guest = (m: string, u: string, body?: unknown) => call(f.deps, m, u, { "x-squeak-pond-token": token }, body);
    expect((await guest("PUT", `/doc?path=channels/${POND}/presence/p1`, { doc })).status).toBe(204);
    expect((await guest("GET", `/doc?path=channels/${POND}/presence/p1`)).status).toBe(200);
    expect((await guest("GET", `/doc?path=channels/${MAC_B}/state/d1`)).status).toBe(403);
    expect((await guest("PUT", `/doc?path=channels/${POND}/state/p1`, { doc })).status).toBe(403);
  });
});

describe("per-account daily limits", () => {
  it("429 quota past the day's requests, shared by an account's Macs, and it resets next day", async () => {
    const f = setup({ limits: { requests: 5, bytes: 1_000_000 } });
    const a = (await provision(f, MAC_A)).json.key;
    const a2 = (await provision(f, MAC_B)).json.key; // same account U1
    let ok = 0;
    for (let i = 0; i < 3; i++) if ((await get(f, i % 2 ? a : a2, i % 2 ? MAC_A : MAC_B)).status !== 429) ok++;
    expect(ok).toBe(3);
    expect((await get(f, a, MAC_A)).status).not.toBe(429);
    expect((await get(f, a2, MAC_B)).status).not.toBe(429);
    const over = await get(f, a, MAC_A);
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ error: "quota" });
    expect((await get(f, a2, MAC_B)).status).toBe(429);
    // the operator and other accounts are not limited by it
    expect((await call(f.deps, "GET", `/doc?path=channels/${MAC_A}/state/d1`, { "x-squeak-relay": KEY })).status).toBe(
      404,
    );
    f.clock.t += 24 * 3600_000;
    expect((await get(f, a, MAC_A)).status).not.toBe(429);
  });

  it("429 quota past the day's bytes written (nothing is stored), and it resets next day", async () => {
    const f = setup({ limits: { requests: 1000, bytes: 100 } });
    const a = (await provision(f, MAC_A)).json.key;
    const small = { box: "x".repeat(30) };
    expect((await put(f, a, MAC_A, "state", small)).status).toBe(204);
    expect((await put(f, a, MAC_A, "state", small)).status).toBe(204);
    const over = await call(f.deps, "PUT", `/doc?path=channels/${MAC_A}/state/d2`, mk(a), { doc: small });
    expect(over.status).toBe(429);
    expect(f.rows.has(`channels/${MAC_A}/state|d2`)).toBe(false);
    f.clock.t += 24 * 3600_000;
    expect((await put(f, a, MAC_A, "state", small)).status).toBe(204);
  });

  it("batches counter writes when asked, counting in a shared warm cache", async () => {
    const f = setup({ limits: { requests: 1000, bytes: 1_000_000 } });
    f.deps.quotaBatch = 5;
    f.deps.usageCache = new Map();
    const a = (await provision(f, MAC_A)).json.key;
    for (let i = 0; i < 4; i++) await get(f, a, MAC_A);
    expect(f.rows.has("usage|u1")).toBe(false);
    await get(f, a, MAC_A);
    expect(JSON.parse(f.rows.get("usage|u1")!).req).toBe(5);
  });
});
