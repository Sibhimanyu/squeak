import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { wrapCreateRelay } from "./transport";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { VERSION, createRelay: createRelayDirect } = require(`${fn}handler.js`);
const createRelay = wrapCreateRelay(createRelayDirect);
const { parseDocPath, parseKindPath, validDoc, KINDS } = require(`${fn}rules.js`);

const KEY = "k".repeat(43);
const CH = "A".repeat(32);
const CLIQ = "q".repeat(43);

function fakes(opts: { channel?: string | null; store?: boolean; publishFails?: boolean } = {}) {
  const rows = new Map<string, string>();
  const published: Array<[string, string]> = [];
  const calls: string[] = [];
  const deps = {
    key: KEY,
    cliqKey: CLIQ,
    store: {
      ready: async () => opts.store !== false,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      // the real store inserts, and updates when the item exists: either way the newest write wins
      put: async (pk: string, doc: string, json: string) => {
        calls.push("put");
        rows.set(`${pk}|${doc}`, json);
      },
      del: async (pk: string, doc: string) => {
        calls.push("del");
        rows.delete(`${pk}|${doc}`);
      },
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: {
      channelId: async () => (opts.channel === undefined ? "chan-1" : opts.channel),
      publish: async (id: string, text: string) => {
        calls.push("publish");
        if (opts.publishFails) throw new Error("boom");
        published.push([id, text]);
      },
      token: async (_id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `tok-${name}`, "wss-id": "w1" }),
    },
  };
  return { deps, rows, published, calls };
}

async function call(
  deps: unknown,
  method: string,
  url: string,
  opts: { key?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = { ...(opts.key === null ? {} : { "x-squeak-relay": opts.key ?? KEY }), ...(opts.headers ?? {}) };
  let status = 0;
  let text = "";
  let bytes: Buffer | undefined;
  let headers: Record<string, string> = {};
  const res: any = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      headers = h ?? {};
    },
    end: (t?: string | Buffer) => {
      if (Buffer.isBuffer(t)) bytes = t;
      else text = t ?? "";
    },
  };
  const done = createRelay(deps)(req, res);
  const payload = opts.raw ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  setImmediate(() => {
    if (payload) req.emit("data", Buffer.from(payload));
    req.emit("end");
  });
  await done;
  const out: any = { status, json: text ? JSON.parse(text) : undefined, text };
  if (bytes) Object.assign(out, { bytes, headers });
  else Object.defineProperty(out, "headers", { value: headers, enumerable: false });
  return out;
}

const path = (kind = "state", doc = "d1") => `channels/${CH}/${kind}/${doc}`;
const doc = (box = "sealed") => ({ box, sig: "s", device: "phone", at: 5 });

describe("path and kind rules mirror firebase/database.rules.json", () => {
  it("shares one kinds list with the RTDB rules", () => {
    const rules = readFileSync(new URL("../../../firebase/database.rules.json", import.meta.url), "utf8");
    const read = rules.match(/"\.read": "([^"]+)"/)![1]!;
    const fromRules = [...read.matchAll(/\$kind === '(\w+)'/g)].map((m) => m[1]).sort();
    // joinids is the relay's own (the signed-in user behind a join request): the RTDB has no relay and no such kind.
    expect([...KINDS].sort()).toEqual([...fromRules, "joinids", "devreqs", "devresults", "cliq"].sort());
    expect(fromRules.length).toBe(26);
    for (const kind of [
      "pond",
      "members",
      "joins",
      "threads",
      "tevents",
      "presence",
      "holds",
      "tcmds",
      "ripples",
      "keys",
    ]) {
      expect(parseDocPath(path(kind, "d1"))?.kind).toBe(kind);
    }
  });

  it("takes a Cliq handler's record: the key header, a 43-char relay id, kind cliq, answered 200 {ok:true}", async () => {
    const relayId = "r".repeat(43);
    const docId = "f".repeat(64);
    const p = `channels/${relayId}/cliq/${docId}`;
    const url = (x: string) => `/doc?path=${encodeURIComponent(x)}`;
    expect(parseDocPath(p)?.kind).toBe("cliq");
    const t = fakes();
    const body = { doc: { box: '{"kind":"button"}', sig: "a".repeat(64), at: 1790000000000 } };
    const ok = await call(t.deps, "PUT", url(p), { body });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
    const listed = await call(t.deps, "GET", `/list?prefix=${encodeURIComponent(`channels/${relayId}/cliq`)}`);
    expect(listed.json.items).toEqual([{ id: docId, doc: body.doc }]);
    // The wrong key and a malformed record are refused; other kinds keep their 204.
    expect((await call(t.deps, "PUT", url(p), { body, key: "x" })).status).toBe(401);
    expect((await call(t.deps, "PUT", url(p), { body: { doc: { sig: "s" } } })).status).toBe(400);
    expect((await call(t.deps, "PUT", url(p), { body: { doc: { box: "x", extra: 1 } } })).status).toBe(400);
    expect((await call(t.deps, "PUT", url("channels/short/cliq/d"), { body })).status).toBe(400);
    expect((await call(t.deps, "PUT", url(path()), { body: { doc: doc() } })).status).toBe(204);
    expect((await call(t.deps, "DELETE", url(p))).status).toBe(204);
  });

  it("a Cliq key may PUT one cliq document and nothing else; the relay key is unaffected", async () => {
    const relayId = "r".repeat(43);
    const p = `channels/${relayId}/cliq/${"f".repeat(64)}`;
    const url = (x: string) => `/doc?path=${encodeURIComponent(x)}`;
    const body = { doc: { box: "{}", sig: "a".repeat(64), at: 1 } };
    const cq = { headers: { "x-squeak-cliq": CLIQ }, key: null };
    const t = fakes();
    const put = await call(t.deps, "PUT", url(p), { ...cq, body });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ ok: true });
    expect(t.published).toHaveLength(1);
    for (const [method, u] of [
      ["GET", url(p)],
      ["DELETE", url(p)],
      ["GET", `/list?prefix=${encodeURIComponent(`channels/${relayId}/cliq`)}`],
      ["PUT", url(`channels/${relayId}/state/d1`)],
      ["PUT", url(`channels/${relayId}/devresults/d1`)],
      ["POST", "/pond-token"],
      ["GET", "/me"],
    ] as const) {
      expect((await call(t.deps, method, u, { ...cq, body })).status, `${method} ${u}`).toBe(401);
    }
    expect((await call(t.deps, "PUT", url(p), { body, headers: { "x-squeak-cliq": "wrong" }, key: null })).status).toBe(
      401,
    );
    expect(
      (await call(fakes({}).deps, "PUT", url(p), { body, headers: { "x-squeak-cliq": "" }, key: null })).status,
    ).toBe(401);
    // The relay key still reads, lists and deletes it.
    expect((await call(t.deps, "GET", url(p))).status).toBe(200);
    expect((await call(t.deps, "DELETE", url(p))).status).toBe(204);
    // No CLIQ_KEY set on the function: the header opens nothing.
    const off = fakes();
    (off.deps as { cliqKey?: string }).cliqKey = undefined;
    expect((await call(off.deps, "PUT", url(p), { ...cq, body })).status).toBe(401);
  });

  it("accepts only channels/<22-64>/<kind>/<doc>", () => {
    expect(parseDocPath(path())?.pk).toBe(`channels/${CH}/state`);
    expect(parseDocPath(`channels/short/state/d`)).toBeNull();
    expect(parseDocPath(`channels/${"A".repeat(65)}/state/d`)).toBeNull();
    expect(parseDocPath(path("spike"))).toBeNull();
    expect(parseDocPath(path("state", "a.b"))).toBeNull();
    expect(parseDocPath(path("state", "x".repeat(81)))).toBeNull();
    expect(parseDocPath(`channels/${CH}/state`)).toBeNull();
    expect(parseDocPath(`cliq/${CH}/state/d`)).toBeNull();
    expect(parseDocPath(null)).toBeNull();
    expect(parseKindPath(`channels/${CH}/voicepair`)?.kind).toBe("voicepair");
    expect(parseKindPath(`channels/${CH}`)).toBeNull();
  });

  it("validates a document like the RTDB .validate rules", () => {
    expect(validDoc({ box: "x" })).toBe(true);
    expect(validDoc(doc())).toBe(true);
    expect(validDoc({})).toBe(false);
    expect(validDoc({ box: 1 })).toBe(false);
    expect(validDoc({ box: "x".repeat(900000) })).toBe(false);
    expect(validDoc({ box: "x".repeat(899999) })).toBe(true);
    expect(validDoc({ box: "x", sig: "s".repeat(512) })).toBe(false);
    expect(validDoc({ box: "x", device: "d".repeat(64) })).toBe(false);
    expect(validDoc({ box: "x", at: "5" })).toBe(false);
    expect(validDoc({ box: "x", other: 1 })).toBe(false);
    expect(validDoc([])).toBe(false);
  });
});

describe("the relay key", () => {
  it("answers a bare 401 for a missing, wrong or unset key, on every route", async () => {
    const { deps } = fakes();
    for (const [method, url] of [
      ["GET", "/ping"],
      ["GET", `/doc?path=${path()}`],
      ["PUT", `/doc?path=${path()}`],
      ["DELETE", `/doc?path=${path()}`],
      ["GET", `/list?prefix=channels/${CH}/state`],
      ["POST", "/token"],
    ] as const) {
      for (const key of [null, "wrong", KEY.slice(0, -1), ""]) {
        const r = await call(deps, method, url, { key, body: { doc: doc(), name: "n" } });
        expect(r.status).toBe(401);
        expect(r.text).toBe("");
      }
    }
    const unset = await call({ ...deps, key: undefined }, "GET", "/ping", { key: "anything" });
    expect(unset.status).toBe(401);
    const empty = await call({ ...deps, key: "" }, "GET", "/ping", { key: "" });
    expect(empty.status).toBe(401);
  });
});

describe("documents", () => {
  it("round-trips a document and answers 404 for a missing one", async () => {
    const { deps } = fakes();
    expect((await call(deps, "GET", `/doc?path=${path()}`)).status).toBe(404);
    const put = await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: doc() } });
    expect(put.status).toBe(204);
    expect(put.text).toBe("");
    const got = await call(deps, "GET", `/doc?path=${path()}`);
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ doc: doc() });
  });

  it("overwrites: the second PUT replaces the first", async () => {
    const { deps } = fakes();
    await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: doc("one") } });
    await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: doc("two") } });
    expect((await call(deps, "GET", `/doc?path=${path()}`)).json.doc.box).toBe("two");
  });

  it("deletes, and deleting a missing document is fine", async () => {
    const { deps } = fakes();
    await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: doc() } });
    expect((await call(deps, "DELETE", `/doc?path=${path()}`)).status).toBe(204);
    expect((await call(deps, "GET", `/doc?path=${path()}`)).status).toBe(404);
    expect((await call(deps, "DELETE", `/doc?path=${path()}`)).status).toBe(204);
  });

  it("refuses bad paths, bad documents, bad JSON and oversized bodies without writing", async () => {
    const { deps, rows, calls } = fakes();
    expect((await call(deps, "PUT", `/doc?path=channels/x/state/d`, { body: { doc: doc() } })).status).toBe(400);
    expect((await call(deps, "PUT", `/doc?path=${path("nope")}`, { body: { doc: doc() } })).status).toBe(400);
    expect((await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: { box: 1 } } })).status).toBe(400);
    expect((await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: { box: "x", extra: 1 } } })).status).toBe(
      400,
    );
    expect((await call(deps, "PUT", `/doc?path=${path()}`, { raw: "{nope" })).status).toBe(400);
    expect(
      (await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: { box: "x".repeat(900000) } } })).status,
    ).toBe(400);
    expect(
      (await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: { box: "x".repeat(1_100_000) } } })).status,
    ).toBe(413);
    expect(rows.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("lists a kind's documents as {id, doc}, and only that kind", async () => {
    const { deps } = fakes();
    await call(deps, "PUT", `/doc?path=${path("state", "a")}`, { body: { doc: doc("1") } });
    await call(deps, "PUT", `/doc?path=${path("state", "b")}`, { body: { doc: doc("2") } });
    await call(deps, "PUT", `/doc?path=${path("results", "c")}`, { body: { doc: doc("3") } });
    const r = await call(deps, "GET", `/list?prefix=channels/${CH}/state`);
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([
      { id: "a", doc: doc("1") },
      { id: "b", doc: doc("2") },
    ]);
    expect((await call(deps, "GET", `/list?prefix=channels/${CH}`)).status).toBe(400);
    expect((await call(deps, "GET", `/list?prefix=channels/${CH}/state/a`)).status).toBe(400);
  });
});

describe("change notices", () => {
  it("publishes {p} after a write and after a delete, never before, never for reads", async () => {
    const { deps, published, calls } = fakes();
    await call(deps, "GET", `/doc?path=${path()}`);
    expect(published).toEqual([]);
    await call(deps, "PUT", `/doc?path=${path("commands", "x")}`, { body: { doc: doc() } });
    expect(calls).toEqual(["put", "publish"]);
    expect(published).toEqual([["chan-1", JSON.stringify({ p: `channels/${CH}/commands` })]]);
    await call(deps, "DELETE", `/doc?path=${path("commands", "x")}`);
    expect(calls).toEqual(["put", "publish", "del", "publish"]);
    expect(published).toHaveLength(2);
  });

  it("does not publish a refused write", async () => {
    const { deps, published } = fakes();
    await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: { nope: 1 } } });
    expect(published).toEqual([]);
  });

  it("still answers 204 when the channel is missing or publishing fails", async () => {
    for (const opts of [{ channel: null }, { publishFails: true }]) {
      const { deps, published } = fakes(opts);
      const r = await call(deps, "PUT", `/doc?path=${path()}`, { body: { doc: doc() } });
      expect(r.status).toBe(204);
      expect(published).toEqual([]);
    }
  });
});

describe("/ping", () => {
  it("reports ready store and channel with the version", async () => {
    const { deps } = fakes();
    const r = await call(deps, "GET", "/ping");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, store: "ready", channel: "ready", channelId: "chan-1", version: VERSION });
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports a missing table and a missing channel separately", async () => {
    const r1 = await call(fakes({ store: false }).deps, "GET", "/ping");
    expect(r1.json).toMatchObject({ store: "missing", channel: "ready" });
    const r2 = await call(fakes({ channel: null }).deps, "GET", "/ping");
    expect(r2.json).toMatchObject({ store: "ready", channel: "missing" });
    expect(r2.json).not.toHaveProperty("channelId");
  });

  it("survives the services throwing", async () => {
    const { deps } = fakes();
    deps.store.ready = async () => {
      throw new Error("x");
    };
    deps.streams.channelId = async () => {
      throw new Error("x");
    };
    const r = await call(deps, "GET", "/ping");
    expect(r.json).toMatchObject({ ok: true, store: "missing", channel: "missing" });
  });
});

describe("/token", () => {
  it("returns the token pair for a valid connection name", async () => {
    const { deps } = fakes();
    const r = await call(deps, "POST", "/token", { body: { name: "mac-1_a" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ url: "in1-dms.zoho.in", key: "tok-mac-1_a", wssId: "w1" });
  });

  it("refuses names over 20 characters, with . or :, empty or not a string", async () => {
    const { deps } = fakes();
    for (const name of ["x".repeat(21), "a.b", "a:b", "", 5, null, "a b"]) {
      expect((await call(deps, "POST", "/token", { body: { name } })).status).toBe(400);
    }
    expect((await call(deps, "POST", "/token", { body: {} })).status).toBe(400);
    expect((await call(deps, "POST", "/token", { body: { name: "x".repeat(20) } })).status).toBe(200);
  });

  it("answers 503 while the channel does not exist", async () => {
    const r = await call(fakes({ channel: null }).deps, "POST", "/token", { body: { name: "n" } });
    expect(r.status).toBe(503);
  });
});

describe("pond-scoped access for web guests", () => {
  const { issue, verify } = require(`${fn}scoped.js`);
  const POND = "P".repeat(30);
  const OTHER = "Q".repeat(30);
  const pdoc = (kind: string, doc = "d1", pond = POND) => `/doc?path=channels/${pond}/${kind}/${doc}`;
  const guestReq = (deps: unknown, method: string, url: string, token: string | null, body?: unknown) =>
    callGuest(deps, method, url, token, body);

  async function callGuest(deps: unknown, method: string, url: string, token: string | null, body?: unknown) {
    const req: any = new EventEmitter();
    req.method = method;
    req.url = `/server/squeak_relay${url}`;
    req.headers = token === null ? {} : { "x-squeak-pond-token": token };
    let status = 0;
    let text = "";
    const res: any = { writeHead: (s: number) => (status = s), end: (t?: string) => (text = t ?? "") };
    const done = createRelay(deps)(req, res);
    setImmediate(() => {
      if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
    await done;
    return { status, json: text ? JSON.parse(text) : undefined };
  }

  async function issued(f: ReturnType<typeof fakes>, ttlSec = 3600) {
    const r = await call(f.deps, "POST", "/pond-token", { body: { pondId: POND, memberId: "m1", ttlSec } });
    expect(r.status).toBe(200);
    return r.json.token as string;
  }

  it("issues a token only with the relay key, and it verifies for that pond and member alone", async () => {
    const f = fakes();
    expect(
      (await call(f.deps, "POST", "/pond-token", { key: null, body: { pondId: POND, memberId: "m1" } })).status,
    ).toBe(401);
    const token = await issued(f);
    expect(verify(KEY, token, Date.now())).toEqual({ pondId: POND, memberId: "m1", scope: "guest" });
    expect(verify("x".repeat(43), token, Date.now())).toBeNull();
    expect(verify(KEY, token.replace(POND, OTHER), Date.now())).toBeNull();
    expect(verify(KEY, token, Date.now() + 2 * 3600_000)).toBeNull();
    expect(issue(KEY, "short", "m1", Date.now())).toBeNull();
  });

  it("limits a guest to one pond and to the kinds a guest writes", async () => {
    const f = fakes();
    const token = await issued(f);
    expect((await guestReq(f.deps, "PUT", pdoc("tcmds"), token, { doc: doc() })).status).toBe(204);
    expect((await guestReq(f.deps, "GET", pdoc("tcmds"), token)).status).toBe(200);
    expect((await guestReq(f.deps, "PUT", pdoc("members"), token, { doc: doc() })).status).toBe(403);
    expect((await guestReq(f.deps, "PUT", pdoc("keys"), token, { doc: doc() })).status).toBe(403);
    expect((await guestReq(f.deps, "DELETE", pdoc("threads"), token)).status).toBe(403);
    expect((await guestReq(f.deps, "GET", pdoc("state", "d1", OTHER), token)).status).toBe(403);
    expect((await guestReq(f.deps, "GET", `/list?prefix=channels/${OTHER}/threads`, token)).status).toBe(403);
    expect((await guestReq(f.deps, "GET", `/list?prefix=channels/${POND}/threads`, token)).status).toBe(200);
    expect((await guestReq(f.deps, "GET", "/ping", token)).status).toBe(404);
    expect((await guestReq(f.deps, "POST", "/pond-token", token, { pondId: POND, memberId: "m2" })).status).toBe(404);
  });

  it("refuses a forged token and a revoked one", async () => {
    const f = fakes();
    const token = await issued(f);
    expect((await guestReq(f.deps, "GET", pdoc("threads"), token.slice(0, -2) + "xx")).status).toBe(401);
    expect((await call(f.deps, "POST", "/pond-revoke", { body: { pondId: POND, memberId: "m1" } })).status).toBe(204);
    expect((await guestReq(f.deps, "GET", pdoc("threads"), token)).status).toBe(401);
    // Issuing again (an invite after removal) lifts it.
    const again = await issued(f);
    expect((await guestReq(f.deps, "GET", pdoc("threads"), again)).status).toBe(404);
  });

  it("has three scopes whose tokens are not interchangeable, and writes follow the scope", async () => {
    const f = fakes();
    const mint = async (scope: string, memberId: string) => {
      const r = await call(f.deps, "POST", "/pond-token", { body: { pondId: POND, memberId, scope } });
      expect(r.status).toBe(200);
      return r.json.token as string;
    };
    const join = await mint("join", "jinvite1");
    const member = await mint("member", "m2");
    const guest = await issued(f);
    expect(join.startsWith("pj.") && member.startsWith("pm.") && guest.startsWith("pt.")).toBe(true);
    expect(verify(KEY, member, Date.now())?.scope).toBe("member");
    // A prefix swapped onto another scope's MAC does not verify.
    expect(verify(KEY, "pm." + guest.slice(3), Date.now())).toBeNull();
    expect(verify(KEY, "pt." + join.slice(3), Date.now())).toBeNull();
    // An invite's token writes the join request and nothing else; it can still read sealed documents.
    expect((await guestReq(f.deps, "PUT", pdoc("joins", "r1"), join, { doc: doc() })).status).toBe(204);
    for (const kind of ["tcmds", "presence", "threads", "tevents", "members", "keys", "pond"]) {
      expect((await guestReq(f.deps, "PUT", pdoc(kind), join, { doc: doc() })).status).toBe(403);
    }
    expect((await guestReq(f.deps, "GET", pdoc("keys", "m2"), join)).status).toBe(404);
    // A Mac member also writes its threads and event batches, still never members, keys or pond.
    for (const kind of ["threads", "tevents", "tcmds"]) {
      expect((await guestReq(f.deps, "PUT", pdoc(kind), member, { doc: doc() })).status).toBe(204);
    }
    for (const kind of ["members", "keys", "pond"]) {
      expect((await guestReq(f.deps, "PUT", pdoc(kind), member, { doc: doc() })).status).toBe(403);
    }
    // A web guest still cannot start threads.
    expect((await guestReq(f.deps, "PUT", pdoc("threads"), guest, { doc: doc() })).status).toBe(403);
    // Revoking the invite's id ends its token.
    await call(f.deps, "POST", "/pond-revoke", { body: { pondId: POND, memberId: "jinvite1" } });
    expect((await guestReq(f.deps, "PUT", pdoc("joins", "r2"), join, { doc: doc() })).status).toBe(401);
    // An unknown scope is not issued.
    for (const scope of ["owner", "__proto__", 7])
      expect(
        (await call(f.deps, "POST", "/pond-token", { body: { pondId: POND, memberId: "m3", scope } })).status,
      ).toBe(400);
  });

  it("gives a guest only its own pond's Data Streams token, and wakes that stream", async () => {
    const f = fakes();
    const seen: string[] = [];
    (f.deps.streams as any).pondChannelId = async (pond: string) => {
      seen.push(pond);
      return pond === POND ? "pond-chan" : null;
    };
    const token = await issued(f);
    const r = await guestReq(f.deps, "POST", "/pond-stream", token, { name: "web1" });
    expect(r.json).toEqual({ url: "in1-dms.zoho.in", key: "tok-web1", wssId: "w1" });
    expect((await guestReq(f.deps, "POST", "/pond-stream", token, { name: "a.b" })).status).toBe(400);
    await guestReq(f.deps, "PUT", pdoc("presence"), token, { doc: doc() });
    expect(f.published.some(([id]) => id === "pond-chan")).toBe(true);
    // The store-wide token route is the relay key's alone.
    expect((await guestReq(f.deps, "POST", "/token", token, { name: "x" })).status).toBe(404);
  });

  it("gives a guest the shared notice channel when its pond has no channel of its own", async () => {
    const f = fakes();
    (f.deps.streams as any).pondChannelId = async () => null;
    const tokenFor: string[] = [];
    const original = (f.deps.streams as any).token;
    (f.deps.streams as any).token = async (id: string, name: string) => {
      tokenFor.push(id);
      return original(id, name);
    };
    const token = await issued(f);
    const r = await guestReq(f.deps, "POST", "/pond-stream", token, { name: "web1" });
    expect(r.status).toBe(200);
    expect(tokenFor).toEqual(["chan-1"]);
  });
});

describe("signed-in guests (Catalyst Hosted login)", () => {
  type User = { userId: string; email: string; name: string } | null;
  const POND = "P".repeat(30);
  const ME: User = { userId: "u1", email: "Pat@Example.com", name: " Pat Lee " };

  function setup(user: User, extra: Record<string, unknown> = {}) {
    const f = fakes();
    Object.assign(f.deps, { currentUser: async () => user, ...extra });
    return f;
  }
  async function token(deps: unknown, body: Record<string, unknown> = {}) {
    const r = await call(deps, "POST", "/pond-token", {
      body: { pondId: POND, memberId: "j1", scope: "join", ttlSec: 600, ...body },
    });
    return r;
  }
  async function guest(deps: unknown, tok: string, method: string, url: string, body?: unknown) {
    const req: any = new EventEmitter();
    req.method = method;
    req.url = `/server/squeak_relay${url}`;
    req.headers = { "x-squeak-pond-token": tok };
    let status = 0;
    let text = "";
    const res: any = { writeHead: (s: number) => (status = s), end: (t?: string) => (text = t ?? "") };
    const done = createRelay(deps)(req, res);
    setImmediate(() => {
      if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
    await done;
    return { status, json: text ? JSON.parse(text) : undefined };
  }
  const joinPath = `/doc?path=channels/${POND}/joins/r1`;
  const idsPath = `/doc?path=channels/${POND}/joinids/r1`;

  it("/me answers the user without a relay key, no-store, and a bare 401 for nobody or a throwing SDK", async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    const req: any = new EventEmitter();
    req.method = "GET";
    req.url = "/server/squeak_relay/me";
    req.headers = {};
    let status = 0;
    let text = "";
    const res: any = {
      writeHead: (s: number, h?: Record<string, string>) => {
        status = s;
        headers.push(h);
      },
      end: (t?: string) => (text = t ?? ""),
    };
    const f = setup(ME);
    const done = createRelay(f.deps)(req, res);
    setImmediate(() => req.emit("end"));
    await done;
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ userId: "u1", email: "Pat@Example.com", name: "Pat Lee" });
    expect(headers[0]?.["Cache-Control"]).toBe("no-store");
    const none = await call(setup(null).deps, "GET", "/me", { key: null });
    expect(none.status).toBe(401);
    expect(none.text).toBe("");
    const boom = setup(ME, {
      currentUser: async () => {
        throw new Error("anonymous");
      },
    });
    expect((await call(boom.deps, "GET", "/me", { key: null })).status).toBe(401);
  });

  it("writes joinids beside a join request only when someone is signed in", async () => {
    const f = setup(ME);
    const t = (await token(f.deps)).json.token;
    expect((await guest(f.deps, t, "PUT", joinPath, { doc: doc() })).status).toBe(204);
    const stored = JSON.parse(f.rows.get(`channels/${POND}/joinids|r1`)!);
    expect(stored).toMatchObject({ v: 1, userId: "u1", email: "Pat@Example.com", name: " Pat Lee " });
    expect(typeof stored.at).toBe("number");
    // The Mac's relay key reads and deletes it.
    expect((await call(f.deps, "GET", idsPath)).json.doc.email).toBe("Pat@Example.com");
    expect((await call(f.deps, "DELETE", idsPath)).status).toBe(204);
    // Anonymous (default GUEST_SIGNIN): accepted, and no joinids.
    const anon = setup(null);
    const t2 = (await token(anon.deps)).json.token;
    expect((await guest(anon.deps, t2, "PUT", joinPath, { doc: doc() })).status).toBe(204);
    expect(anon.rows.has(`channels/${POND}/joinids|r1`)).toBe(false);
  });

  it("no client token and not even the relay key can write or read joinids", async () => {
    const f = setup(ME);
    const j = (await token(f.deps)).json.token;
    const g = (await token(f.deps, { scope: "guest" })).json.token;
    const m = (await token(f.deps, { scope: "member" })).json.token;
    for (const t of [j, g, m]) {
      expect((await guest(f.deps, t, "PUT", idsPath, { doc: { box: "x" } })).status).toBe(403);
      expect((await guest(f.deps, t, "DELETE", idsPath)).status).toBe(403);
      expect((await guest(f.deps, t, "GET", idsPath)).status).toBe(403);
      expect((await guest(f.deps, t, "GET", `/list?prefix=channels/${POND}/joinids`)).status).toBe(403);
    }
    expect((await call(f.deps, "PUT", idsPath, { body: { doc: doc() } })).status).toBe(403);
    expect(f.rows.size).toBe(0);
  });

  it("GUEST_SIGNIN=required refuses a join with nobody signed in", async () => {
    const f = setup(null, { signin: "required" });
    const t = (await token(f.deps)).json.token;
    const r = await guest(f.deps, t, "PUT", joinPath, { doc: doc() });
    expect(r).toEqual({ status: 401, json: { error: "signin" } });
    expect(f.rows.has(`channels/${POND}/joins|r1`)).toBe(false);
    const ok = setup(ME, { signin: "required" });
    const t2 = (await token(ok.deps)).json.token;
    expect((await guest(ok.deps, t2, "PUT", joinPath, { doc: doc() })).status).toBe(204);
  });

  it("an invite pinned to an email: match (case-insensitive, trimmed) passes, mismatch 403, anonymous 401", async () => {
    let user: User = null;
    const f = setup(null, { currentUser: async () => user });
    expect((await token(f.deps, { email: " PAT@example.com " })).status).toBe(200);
    expect((await token(f.deps, { memberId: "j2", email: "not-an-email" })).status).toBe(400);
    expect((await token(f.deps, { memberId: "j3", scope: "guest", email: "a@b.co" })).status).toBe(400);
    const t = (await token(f.deps, { memberId: "j4", email: "pat@example.com" })).json.token;
    const r = (u: User) => {
      user = u;
      return guest(f.deps, t, "PUT", joinPath, { doc: doc() });
    };
    expect(await r(null)).toEqual({ status: 401, json: { error: "signin" } });
    expect(await r({ userId: "u9", email: "other@example.com", name: "" })).toEqual({
      status: 403,
      json: { error: "email" },
    });
    expect((await r(ME)).status).toBe(204);
    // An unpinned token on the same relay is untouched by the pin.
    const free = (await token(f.deps, { memberId: "j5" })).json.token;
    user = { userId: "u9", email: "other@example.com", name: "" };
    expect((await guest(f.deps, free, "PUT", joinPath, { doc: doc() })).status).toBe(204);
  });
});

describe("accounts (link tickets, linked Macs, device requests)", () => {
  type User = { userId: string; email: string; name: string } | null;
  const A: User = { userId: "u1", email: "pat@example.com", name: "Pat" };
  const B: User = { userId: "u2", email: "lee@example.com", name: "Lee" };
  const MAC = "M".repeat(30);
  const MAC2 = "N".repeat(30);
  let who: User = A;
  const setup = () => {
    const f = fakes();
    Object.assign(f.deps, { currentUser: async () => who });
    return f;
  };
  const cookie = (d: unknown, m: string, u: string, body?: unknown) => call(d, m, u, { key: null, body });
  const key = (d: unknown, m: string, u: string, body?: unknown) => call(d, m, u, { body });
  const keyless = { key: "wrong" };
  async function link(f: ReturnType<typeof setup>, user: User = A, mac = MAC) {
    who = user;
    const t = (await cookie(f.deps, "POST", "/account/link-ticket")).json.ticket;
    return key(f.deps, "POST", "/account/link", { ticket: t, macId: mac, name: "Pat's Mac" });
  }
  const goodReq = { macId: MAC, name: " Phone ", publicKey: "pk_-1", boxKey: "bk_-2" };

  it("link-ticket needs a cookie user, is no-store, and link needs the relay key", async () => {
    const f = setup();
    who = null;
    const none = await cookie(f.deps, "POST", "/account/link-ticket");
    expect(none.status).toBe(401);
    expect(none.text).toBe("");
    who = A;
    const t = await cookie(f.deps, "POST", "/account/link-ticket");
    expect(t.status).toBe(200);
    expect(t.json.ticket).toMatch(/^al\.u1\.\d+\./);
    expect(t.json.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await call(f.deps, "POST", "/account/link", { ...keyless, body: { ticket: t.json.ticket } })).status).toBe(
      401,
    );
    expect((await call(f.deps, "POST", "/account/link", { key: null, body: {} })).status).toBe(401);
  });

  it("link stores both records with the ticket's email; forged, tampered and expired tickets are 400", async () => {
    const f = setup();
    const r = await link(f);
    expect(r).toMatchObject({ status: 200, json: { userId: "u1", email: "pat@example.com" } });
    expect(JSON.parse(f.rows.get("maclinks|" + MAC)!)).toEqual({ userId: "u1", email: "pat@example.com" });
    expect(JSON.parse(f.rows.get(`accounts/u1|${MAC}`)!)).toMatchObject({ macId: MAC, name: "Pat's Mac" });
    const t = (await cookie(f.deps, "POST", "/account/link-ticket")).json.ticket as string;
    const parts = t.split(".");
    const swapEmail = [...parts.slice(0, 3), Buffer.from("evil@x.co").toString("base64url"), parts[4]].join(".");
    const swapUser = ["al", "u9", ...parts.slice(2)].join(".");
    const forged = `al.u1.${Date.now() + 1e6}.${parts[3]}.${"x".repeat(43)}`;
    const expired = parts.slice();
    expired[2] = String(Date.now() - 1);
    for (const bad of [swapEmail, swapUser, forged, expired.join("."), "", "al.u1", 5]) {
      const x = await key(f.deps, "POST", "/account/link", { ticket: bad, macId: MAC, name: "n" });
      expect(x).toEqual({ status: 400, json: { error: "ticket" }, text: '{"error":"ticket"}' });
    }
    expect((await key(f.deps, "POST", "/account/link", { ticket: t, macId: "short", name: "n" })).status).toBe(400);
  });

  it("a Mac linked to another user is re-linked to the newer one", async () => {
    const f = setup();
    await link(f, A);
    await link(f, B);
    expect(JSON.parse(f.rows.get("maclinks|" + MAC)!).userId).toBe("u2");
    expect(f.rows.has(`accounts/u1|${MAC}`)).toBe(false);
    expect(f.rows.has(`accounts/u2|${MAC}`)).toBe(true);
  });

  it("/account/macs lists only this user's Macs whose maclinks still points at them", async () => {
    const f = setup();
    await link(f, A, MAC);
    await link(f, A, MAC2);
    f.rows.set("maclinks|" + MAC2, JSON.stringify({ userId: "u2", email: "x" }));
    who = A;
    const r = await cookie(f.deps, "GET", "/account/macs");
    expect(r.status).toBe(200);
    expect(r.json.macs.map((m: { macId: string }) => m.macId)).toEqual([MAC]);
    who = B;
    expect((await cookie(f.deps, "GET", "/account/macs")).json.macs).toEqual([]);
    who = null;
    expect((await cookie(f.deps, "GET", "/account/macs")).status).toBe(401);
  });

  it("app tokens: minted by cookie only, accepted by /me, /macs and device-request only, bad token never falls back", async () => {
    const f = setup();
    who = A;
    const m = await cookie(f.deps, "POST", "/account/app-token");
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ email: "pat@example.com", name: "Pat" });
    expect(m.json.token).toMatch(/^at\.u1\.\d+\./);
    expect(m.json.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const tok = m.json.token as string;
    const withTok = (method: string, u: string, body?: unknown, token = tok) =>
      call(f.deps, method, u, { key: null, body, headers: { "x-squeak-account": token } });
    // the cookie user is nobody here: only the token identifies
    who = null;
    expect((await withTok("GET", "/me")).json).toEqual({ userId: "u1", email: "pat@example.com", name: "Pat" });
    expect((await withTok("GET", "/account/macs")).status).toBe(200);
    who = A;
    await link(f, A);
    who = null;
    expect((await withTok("GET", "/account/macs")).json.macs).toHaveLength(1);
    const dr = await withTok("POST", "/account/device-request", goodReq);
    expect(dr.status).toBe(200);
    expect((await withTok("GET", `/account/device-request?macId=${MAC}&id=${dr.json.reqId}`)).status).toBe(202);
    // a token mints neither tokens nor tickets
    expect((await withTok("POST", "/account/app-token")).status).toBe(401);
    expect((await withTok("POST", "/account/link-ticket")).status).toBe(401);
    // token wins over the cookie, and a bad one is a bare 401 even with a good cookie
    who = B;
    expect((await withTok("GET", "/me")).json.userId).toBe("u1");
    const parts = tok.split(".");
    const expired = [...parts.slice(0, 2), String(Date.now() - 1), ...parts.slice(3)].join(".");
    const ticket = (await cookie(f.deps, "POST", "/account/link-ticket")).json.ticket as string;
    const swapped = tok.slice(0, -3) + "AAA";
    for (const bad of [expired, swapped, ticket, "", "at.u1"]) {
      const r = await withTok("GET", "/me", undefined, bad);
      expect(r.status).toBe(401);
      expect(r.text).toBe("");
      expect((await withTok("GET", "/account/macs", undefined, bad)).status).toBe(401);
    }
    // an app token is not a link ticket
    expect((await key(f.deps, "POST", "/account/link", { ticket: tok, macId: MAC, name: "n" })).status).toBe(400);
  });

  it("unlink deletes both records and pending requests", async () => {
    const f = setup();
    await link(f);
    who = A;
    await cookie(f.deps, "POST", "/account/device-request", goodReq);
    f.rows.set(`channels/${MAC}/devresults|zz`, "{}");
    expect((await call(f.deps, "POST", "/account/unlink", { ...keyless, body: { macId: MAC } })).status).toBe(401);
    expect((await key(f.deps, "POST", "/account/unlink", { macId: MAC })).status).toBe(204);
    // only the account's remembered display name stays: it is the account's, not the Mac's
    expect([...f.rows.keys()].filter((k) => !k.startsWith("names|"))).toEqual([]);
  });

  it("device-request: validates, needs the link, writes devreqs and wakes the Mac", async () => {
    const f = setup();
    who = A;
    expect((await cookie(f.deps, "POST", "/account/device-request", goodReq)).json).toEqual({ error: "mac" });
    await link(f, A);
    who = B;
    expect((await cookie(f.deps, "POST", "/account/device-request", goodReq)).status).toBe(403);
    who = A;
    for (const bad of [
      { ...goodReq, publicKey: "a b" },
      { ...goodReq, boxKey: "x".repeat(201) },
      { ...goodReq, boxKey: 5 },
      { ...goodReq, macId: "bad" },
    ])
      expect((await cookie(f.deps, "POST", "/account/device-request", bad)).status).toBe(400);
    f.published.length = 0;
    const r = await cookie(f.deps, "POST", "/account/device-request", {
      ...goodReq,
      name: " ".repeat(2) + "n".repeat(150),
    });
    expect(r.status).toBe(200);
    expect(r.json.reqId.length).toBeGreaterThanOrEqual(16);
    const stored = JSON.parse(f.rows.get(`channels/${MAC}/devreqs|${r.json.reqId}`)!);
    expect(stored).toMatchObject({ v: 1, userId: "u1", email: "pat@example.com", publicKey: "pk_-1", boxKey: "bk_-2" });
    expect(stored.name).toBe("n".repeat(100));
    expect(f.published).toContainEqual(["chan-1", JSON.stringify({ p: `channels/${MAC}/devreqs` })]);
  });

  it("device-request: takes real 65-byte keys as base64url or standard base64 and stores base64url", async () => {
    const f = setup();
    who = A;
    await link(f, A);
    const raw = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xfb)]);
    const std = raw.toString("base64");
    expect(std).toMatch(/[+/=]/);
    const url = raw.toString("base64url");
    for (const [publicKey, boxKey] of [
      [url, url],
      [std, std],
    ]) {
      const r = await cookie(f.deps, "POST", "/account/device-request", { ...goodReq, publicKey, boxKey });
      expect(r.status).toBe(200);
      const stored = JSON.parse(f.rows.get(`channels/${MAC}/devreqs|${r.json.reqId}`)!);
      expect(stored.publicKey).toBe(url);
      expect(stored.boxKey).toBe(url);
    }
    const bad = await cookie(f.deps, "POST", "/account/device-request", { ...goodReq, publicKey: "a=b", boxKey: url });
    expect(bad.status).toBe(400);
  });

  it("device-request: three open at most (429), old ones do not count and are deleted", async () => {
    const f = setup();
    await link(f);
    who = A;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await cookie(f.deps, "POST", "/account/device-request", goodReq)).json.reqId);
    const busy = await cookie(f.deps, "POST", "/account/device-request", goodReq);
    expect(busy).toMatchObject({ status: 429, json: { error: "busy" } });
    const k = `channels/${MAC}/devreqs|${ids[0]}`;
    f.rows.set(k, JSON.stringify({ ...JSON.parse(f.rows.get(k)!), at: Date.now() - 11 * 60_000 }));
    expect((await cookie(f.deps, "POST", "/account/device-request", goodReq)).status).toBe(200);
    expect(f.rows.has(k)).toBe(false);
  });

  it("device-request GET: 202 pending, 200 delivers once and deletes both, 410 gone, 403 other user", async () => {
    const f = setup();
    await link(f);
    who = A;
    const { reqId } = (await cookie(f.deps, "POST", "/account/device-request", goodReq)).json;
    const url = `/account/device-request?macId=${MAC}&id=${reqId}`;
    const pending = await cookie(f.deps, "GET", url);
    expect(pending).toMatchObject({ status: 202, json: {} });
    who = B;
    expect((await cookie(f.deps, "GET", url)).status).toBe(403);
    who = null;
    expect((await cookie(f.deps, "GET", url)).status).toBe(401);
    who = A;
    // the Mac answers with the relay key
    expect(
      (await key(f.deps, "PUT", `/doc?path=channels/${MAC}/devresults/${reqId}`, { doc: { box: "sealed" } })).status,
    ).toBe(204);
    const done = await cookie(f.deps, "GET", url);
    expect(done).toMatchObject({ status: 200, json: { result: { box: "sealed" } } });
    expect([...f.rows.keys()].filter((k) => k.includes("devreqs") || k.includes("devresults"))).toEqual([]);
    expect(await cookie(f.deps, "GET", url)).toMatchObject({ status: 410, json: { error: "gone" } });
    // expired
    const r2 = (await cookie(f.deps, "POST", "/account/device-request", goodReq)).json.reqId;
    const k = `channels/${MAC}/devreqs|${r2}`;
    f.rows.set(k, JSON.stringify({ ...JSON.parse(f.rows.get(k)!), at: Date.now() - 11 * 60_000 }));
    expect((await cookie(f.deps, "GET", `/account/device-request?macId=${MAC}&id=${r2}`)).status).toBe(410);
    expect(f.rows.has(k)).toBe(false);
    // a refusal is a bare {denied: true}; nothing else without a box is accepted
    const r3 = (await cookie(f.deps, "POST", "/account/device-request", goodReq)).json.reqId;
    const put = (doc: unknown) => key(f.deps, "PUT", `/doc?path=channels/${MAC}/devresults/${r3}`, { doc });
    expect((await put({ denied: false })).status).toBe(400);
    expect((await put({ denied: true, extra: 1 })).status).toBe(400);
    expect((await put({ denied: true })).status).toBe(204);
    expect(await cookie(f.deps, "GET", `/account/device-request?macId=${MAC}&id=${r3}`)).toMatchObject({
      status: 200,
      json: { result: { denied: true } },
    });
  });

  it("pond tokens never touch devreqs or devresults; the relay key cannot PUT devreqs but can GET/list/DELETE", async () => {
    const f = setup();
    const POND = "P".repeat(30);
    const toks: string[] = [];
    for (const scope of ["guest", "member", "join"])
      toks.push((await key(f.deps, "POST", "/pond-token", { pondId: POND, memberId: "m1", scope })).json.token);
    const g = async (t: string, method: string, url: string) => {
      const req: any = new EventEmitter();
      req.method = method;
      req.url = `/server/squeak_relay${url}`;
      req.headers = { "x-squeak-pond-token": t };
      let status = 0;
      const res: any = { writeHead: (s: number) => (status = s), end: () => undefined };
      const done = createRelay(f.deps)(req, res);
      setImmediate(() => {
        req.emit("data", Buffer.from(JSON.stringify({ doc: { box: "x" } })));
        req.emit("end");
      });
      await done;
      return status;
    };
    for (const kind of ["devreqs", "devresults"])
      for (const t of toks) {
        for (const m of ["GET", "PUT", "DELETE"])
          expect(await g(t, m, `/doc?path=channels/${POND}/${kind}/r1`)).toBe(403);
        expect(await g(t, "GET", `/list?prefix=channels/${POND}/${kind}`)).toBe(403);
      }
    const p = `/doc?path=channels/${MAC}/devreqs/r1`;
    expect((await key(f.deps, "PUT", p, { doc: doc() })).status).toBe(403);
    f.rows.set(`channels/${MAC}/devreqs|r1`, JSON.stringify({ v: 1 }));
    expect((await key(f.deps, "GET", p)).status).toBe(200);
    expect((await key(f.deps, "GET", `/list?prefix=channels/${MAC}/devreqs`)).json.items).toHaveLength(1);
    expect((await key(f.deps, "DELETE", p)).status).toBe(204);
    expect((await key(f.deps, "PUT", `/doc?path=channels/${MAC}/devresults/r1`, { doc: doc() })).status).toBe(204);
    expect((await key(f.deps, "DELETE", `/doc?path=channels/${MAC}/devresults/r1`)).status).toBe(204);
  });

  describe("profile photo", () => {
    const jpeg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
    const put = (f: ReturnType<typeof setup>, data: Buffer | string, type = "image/jpeg", user: User = A) => {
      who = user;
      return cookie(f.deps, "PUT", "/account/avatar", {
        type,
        data: typeof data === "string" ? data : data.toString("base64"),
      });
    };

    it("stores a JPEG under a relay-owned key, reads it back, and /me gains avatarAt", async () => {
      const f = setup();
      expect((await put(f, jpeg())).json.at).toBeGreaterThan(0);
      expect([...f.rows.keys()].some((k) => k.startsWith("avatars|u1"))).toBe(true);
      who = A;
      const got = await cookie(f.deps, "GET", "/account/avatar");
      expect(got.status).toBe(200);
      expect(got.bytes!.equals(jpeg())).toBe(true);
      expect(got.headers).toMatchObject({
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      expect((await cookie(f.deps, "GET", "/me")).json.avatarAt).toBeGreaterThan(0);
      who = null;
      const tok = (
        await (async () => {
          who = A;
          return cookie(f.deps, "POST", "/account/app-token");
        })()
      ).json.token;
      who = null;
      const viaTok = await call(f.deps, "GET", "/me", { key: null, headers: { "x-squeak-account": tok } });
      expect(viaTok.json.avatarAt).toBeGreaterThan(0);
      const photo = await call(f.deps, "GET", "/account/avatar", { key: null, headers: { "x-squeak-account": tok } });
      expect(photo.bytes!.length).toBe(jpeg().length);
    });

    it("no photo is 404 and /me has no avatarAt; a bad token is a bare 401", async () => {
      const f = setup();
      who = A;
      expect((await cookie(f.deps, "GET", "/account/avatar")).status).toBe(404);
      expect("avatarAt" in (await cookie(f.deps, "GET", "/me")).json).toBe(false);
      who = A;
      const bad = await call(f.deps, "GET", "/account/avatar", { key: null, headers: { "x-squeak-account": "at.u1" } });
      expect(bad.status).toBe(401);
      who = null;
      expect((await cookie(f.deps, "GET", "/account/avatar")).status).toBe(401);
      expect((await cookie(f.deps, "PUT", "/account/avatar", { type: "image/jpeg", data: "/9j/" })).status).toBe(401);
    });

    it("limits: 64 KB, JPEG magic bytes, exact type, base64", async () => {
      const f = setup();
      expect((await put(f, jpeg(64 * 1024 - 4))).status).toBe(200);
      expect(await put(f, jpeg(64 * 1024 - 3))).toMatchObject({ status: 413, json: { error: "size" } });
      expect(await put(f, jpeg(500_000))).toMatchObject({ status: 413, json: { error: "size" } });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
      expect(await put(f, png)).toMatchObject({ status: 400, json: { error: "image" } });
      expect(await put(f, jpeg(), "image/png")).toMatchObject({ status: 400, json: { error: "image" } });
      expect(await put(f, jpeg(), "image/jpeg; charset=x")).toMatchObject({ status: 400 });
      expect(await put(f, "not base64!!")).toMatchObject({ status: 400, json: { error: "image" } });
      expect(await put(f, "")).toMatchObject({ status: 400 });
    });

    it("20 writes per user per hour, then busy; another user is unaffected; DELETE is 204", async () => {
      const f = setup();
      for (let i = 0; i < 20; i++) expect((await put(f, jpeg(10 + i))).status).toBe(200);
      expect(await put(f, jpeg())).toMatchObject({ status: 429, json: { error: "busy" } });
      expect((await put(f, jpeg(), "image/jpeg", B)).status).toBe(200);
      who = A;
      expect((await cookie(f.deps, "DELETE", "/account/avatar")).status).toBe(204);
      expect((await cookie(f.deps, "GET", "/account/avatar")).status).toBe(404);
      expect(f.rows.has("avatars|u1")).toBe(false);
      // the window passing frees the counter
      f.rows.set("avatar-writes|u1", JSON.stringify({ since: Date.now() - 3_700_000, n: 20 }));
      expect((await put(f, jpeg())).status).toBe(200);
    });

    it("the relay key reads any user's photo; no key, a wrong key and a pond token are refused", async () => {
      const f = setup();
      await put(f, jpeg());
      const r = await key(f.deps, "GET", "/account/avatar?userId=u1");
      expect(r.status).toBe(200);
      expect(r.bytes!.equals(jpeg())).toBe(true);
      expect((await key(f.deps, "GET", "/account/avatar?userId=u2")).status).toBe(404);
      expect((await key(f.deps, "GET", "/account/avatar?userId=../x")).status).toBe(400);
      expect((await key(f.deps, "GET", "/account/avatar")).status).toBe(400);
      expect((await call(f.deps, "GET", "/account/avatar?userId=u1", { key: "wrong" })).status).toBe(401);
      const pond = await call(f.deps, "GET", "/account/avatar?userId=u1", {
        key: null,
        headers: { "x-squeak-pond-token": "pj.whatever" },
      });
      expect(pond.status).toBe(401);
      expect(
        (await call(f.deps, "PUT", "/account/avatar?userId=u1", { body: { type: "image/jpeg", data: "/9j/" } })).status,
      ).toBe(405);
    });

    it("no /doc or /list path reaches the photo, with the key or a pond token", async () => {
      const f = setup();
      await put(f, jpeg());
      for (const p of ["avatars/u1", `channels/${CH}/avatars/u1`, "avatars"]) {
        expect((await key(f.deps, "GET", `/doc?path=${p}`)).status).toBe(400);
        expect((await key(f.deps, "PUT", `/doc?path=${p}`, { doc: doc() })).status).toBe(400);
        expect((await key(f.deps, "GET", `/list?prefix=${p}`)).status).toBe(400);
      }
      expect(JSON.parse(f.rows.get("avatars|u1")!)).toMatchObject({ type: "image/jpeg" });
    });
  });
  describe("Use my Zoho photo", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 3)]);
    const zoho = { clientId: "cid", clientSecret: "csecret", accounts: "https://accounts.zoho.in" };
    const hdr = (r: any) => r.headers as Record<string, string>;
    type Fetched = { url: string; init: any };
    function zsetup(over: Partial<typeof zoho> | null = {}, photo: () => Response = () => new Response(png)) {
      const f = setup();
      const fetched: Fetched[] = [];
      Object.assign(f.deps, {
        zoho: over === null ? undefined : { ...zoho, ...over },
        fetch: async (url: string, init: any) => {
          fetched.push({ url, init });
          if (url.includes("/oauth/v2/token")) return new Response(JSON.stringify({ access_token: "tok-secret" }));
          return photo();
        },
      });
      return { ...f, fetched };
    }
    const start = async (f: ReturnType<typeof zsetup>) => {
      who = A;
      const r = await cookie(f.deps, "GET", "/account/zoho-photo/start");
      const loc = new URL(hdr(r).Location!);
      return { r, loc, state: loc.searchParams.get("state")! };
    };
    const cb = (f: ReturnType<typeof zsetup>, state: string, extra = "") =>
      cookie(f.deps, "GET", `/account/zoho-photo/callback?state=${encodeURIComponent(state)}${extra}`);

    it("start: no sign-in is a bare 401, no config is 503, else a 302 to Zoho's consent with a signed state", async () => {
      const f = zsetup();
      who = null as unknown as User;
      const out = await cookie(f.deps, "GET", "/account/zoho-photo/start");
      expect(out.status).toBe(401);
      expect(out.text).toBe("");
      const none = zsetup(null);
      who = A;
      expect(await cookie(none.deps, "GET", "/account/zoho-photo/start")).toMatchObject({
        status: 503,
        json: { error: "unconfigured" },
      });
      const { r, loc } = await start(f);
      expect(r.status).toBe(302);
      expect(loc.origin + loc.pathname).toBe("https://accounts.zoho.in/oauth/v2/auth");
      expect(Object.fromEntries([...loc.searchParams].filter(([k]) => k !== "state"))).toEqual({
        scope: "profile.userphoto.READ",
        client_id: "cid",
        response_type: "code",
        access_type: "online",
        prompt: "consent",
        // fake req has no Host ("undefined"); over the HTTP transport it is the local server
        redirect_uri: expect.stringMatching(/^https:\/\/[^/]+\/server\/squeak_relay\/account\/zoho-photo\/callback$/),
      });
      expect(f.fetched).toHaveLength(0);
    });

    it("happy path: token exchange, the photo with the token, parked once, handed over once", async () => {
      const f = zsetup();
      const { state } = await start(f);
      who = A;
      const r = await cb(f, state, "&code=thecode&accounts-server=https%3A%2F%2Faccounts.zoho.eu");
      expect(hdr(r).Location).toBe("/app/index.html#zoho-photo=ready");
      expect(f.fetched[0]!.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
      expect(String(f.fetched[0]!.init.body)).toContain("grant_type=authorization_code");
      expect(f.fetched[1]!.url).toMatch(/^https:\/\/profile\.zoho\.eu\/api\/v1\/user\/self\/photo/);
      expect(f.fetched[1]!.init.headers.Authorization).toBe("Zoho-oauthtoken tok-secret");
      expect(f.rows.get("zoho-photo|u1")).not.toContain("tok-secret");
      const got = await cookie(f.deps, "GET", "/account/zoho-photo");
      expect(got.status).toBe(200);
      expect(got.bytes!.equals(png)).toBe(true);
      expect(hdr(got)["Content-Type"]).toBe("image/png");
      expect((await cookie(f.deps, "GET", "/account/zoho-photo")).status).toBe(404);
      expect(f.rows.has("zoho-photo|u1")).toBe(false);
    });

    it("a parked photo older than ten minutes is gone, and another user never sees it", async () => {
      const f = zsetup();
      f.rows.set("zoho-photo|u1", JSON.stringify({ v: 1, at: Date.now() - 11 * 60_000, data: png.toString("base64") }));
      who = A;
      expect((await cookie(f.deps, "GET", "/account/zoho-photo")).status).toBe(404);
      f.rows.set("zoho-photo|u1", JSON.stringify({ v: 1, at: Date.now(), data: png.toString("base64") }));
      who = B;
      expect((await cookie(f.deps, "GET", "/account/zoho-photo")).status).toBe(404);
      expect((await key(f.deps, "GET", "/account/zoho-photo")).status).toBe(401);
      expect((await key(f.deps, "GET", "/doc?path=zoho-photo/u1")).status).toBe(400);
    });

    it("a tampered, expired or other user's state is refused and nothing is fetched", async () => {
      const f = zsetup();
      const { state } = await start(f);
      const parts = state.split(".");
      const forged = [
        `u2.${parts[1]}.${parts[2]}.${parts[3]}`,
        `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}.${parts[3]}`,
        "junk",
        "",
      ];
      who = A;
      for (const bad of forged)
        expect(hdr(await cb(f, bad, "&code=c")).Location).toBe("/app/index.html#zoho-photo=failed");
      // genuine state, but the cookie is another person
      who = B;
      expect(hdr(await cb(f, state, "&code=c")).Location).toBe("/app/index.html#zoho-photo=failed");
      // genuine but expired: sign one 11 minutes ago with the relay's own key
      const exp = Date.now() - 1000;
      const mac = (await import("node:crypto"))
        .createHmac("sha256", KEY)
        .update(`squeak-zoho-photo\nu1\nn\n${exp}`)
        .digest("base64url");
      who = A;
      expect(hdr(await cb(f, `u1.n.${exp}.${mac}`, "&code=c")).Location).toBe("/app/index.html#zoho-photo=failed");
      expect(f.fetched).toHaveLength(0);
      expect(f.rows.size).toBe(0);
    });

    it("access_denied says denied, another Zoho error says blocked, neither fetches", async () => {
      const f = zsetup();
      const { state } = await start(f);
      expect(hdr(await cb(f, state, "&error=access_denied")).Location).toBe("/app/index.html#zoho-photo=denied");
      expect(hdr(await cb(f, state, "&error=invalid_scope")).Location).toBe("/app/index.html#zoho-photo=blocked");
      expect(f.fetched).toHaveLength(0);
    });

    it("an accounts-server that is not a Zoho https host is never called", async () => {
      const f = zsetup();
      const { state } = await start(f);
      for (const bad of [
        "https://accounts.zoho.in.evil.example",
        "http://accounts.zoho.in",
        "https://evil.example",
        "https://accounts.zoho.in:8443",
      ]) {
        const r = await cb(f, state, `&code=c&accounts-server=${encodeURIComponent(bad)}`);
        expect(hdr(r).Location).toBe("/app/index.html#zoho-photo=failed");
      }
      expect(f.fetched).toHaveLength(0);
      // with none given, the configured host is used
      await cb(f, state, "&code=c");
      expect(f.fetched[0]!.url).toBe("https://accounts.zoho.in/oauth/v2/token");
    });

    it("a non-image or a photo over 256 KB is failed and nothing is parked", async () => {
      for (const body of [
        () => new Response("<html>hi</html>"),
        () => new Response(Buffer.concat([png, Buffer.alloc(256 * 1024)])),
      ]) {
        const f = zsetup({}, body);
        const { state } = await start(f);
        expect(hdr(await cb(f, state, "&code=c")).Location).toBe("/app/index.html#zoho-photo=failed");
        expect(f.rows.size).toBe(0);
      }
    });

    it("a base64 body is decoded; a Zoho refusal is blocked", async () => {
      const f = zsetup({}, () => new Response(png.toString("base64")));
      const { state } = await start(f);
      expect(hdr(await cb(f, state, "&code=c")).Location).toBe("/app/index.html#zoho-photo=ready");
      const g = zsetup({}, () => new Response("no", { status: 403 }));
      const s2 = await start(g);
      expect(hdr(await cb(g, s2.state, "&code=c")).Location).toBe("/app/index.html#zoho-photo=blocked");
    });
  });
});

describe('names: join attestation and resolving an account id (docs/ponds.md, "Names")', () => {
  const POND = "P".repeat(30);
  const MAC = "M".repeat(30);
  const MAC_KEY = "m".repeat(43);
  let who: { userId: string; email: string; name: string } | null = {
    userId: "u1",
    email: "pat@example.com",
    name: " Pat Lee ",
  };
  function setup() {
    const f = fakes();
    Object.assign(f.deps, { currentUser: async () => who });
    // a provisioned Mac belonging to u2 (tenants.js keeps only the hash of the key)
    const hash = require("node:crypto").createHash("sha256").update(MAC_KEY).digest("base64url");
    f.rows.set(`mac-keys|${hash}`, JSON.stringify({ userId: "u2", macId: MAC, createdAt: 1 }));
    f.rows.set(`maclinks|${MAC}`, JSON.stringify({ userId: "u2", email: "lee@example.com" }));
    return f;
  }
  const asMac = (d: unknown, method: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
    call(d, method, url, { key: null, body, headers: { "x-squeak-mac-key": MAC_KEY, ...extra } });
  async function joinToken(d: unknown) {
    return (
      await call(d, "POST", "/pond-token", { body: { pondId: POND, memberId: "j1", scope: "join", ttlSec: 600 } })
    ).json.token as string;
  }
  async function putJoin(d: unknown, tok: string, headers: Record<string, string> = {}) {
    return call(d, "PUT", `/doc?path=channels/${POND}/joins/r1`, {
      key: null,
      body: { doc: doc() },
      headers: { "x-squeak-pond-token": tok, ...headers },
    });
  }

  it("a cookie sign-in leaves the account's name; a token sign-in is given it back by /me", async () => {
    const f = setup();
    who = { userId: "u1", email: "pat@example.com", name: " Pat Lee " };
    expect((await call(f.deps, "GET", "/me", { key: null })).json.name).toBe("Pat Lee");
    expect(JSON.parse(f.rows.get("names|u1")!)).toMatchObject({ name: "Pat Lee", email: "pat@example.com" });
    const minted = (await call(f.deps, "POST", "/account/app-token", { key: null })).json.token as string;
    who = null;
    const viaToken = await call(f.deps, "GET", "/me", { key: null, headers: { "x-squeak-account": minted } });
    expect(viaToken.json).toMatchObject({ userId: "u1", name: "Pat Lee" });
  });

  it("join-attest needs a Mac key, is no-store and says the Mac's account, never the caller's claim", async () => {
    const f = setup();
    expect((await call(f.deps, "POST", "/account/join-attest", { body: {} })).status).toBe(403); // operator key: no Mac
    expect((await call(f.deps, "POST", "/account/join-attest", { key: null, body: {} })).status).toBe(401);
    expect((await asMac(f.deps, "GET", "/account/join-attest")).status).toBe(405);
    const r = await asMac(f.deps, "POST", "/account/join-attest", {});
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^ja\.u2\.\d+\./);
    expect(r.json.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("a join request with the attestation gets joinids for the Mac's account and the remembered name", async () => {
    const f = setup();
    who = null;
    f.rows.set("names|u2", JSON.stringify({ name: "Lee Chen", email: "lee@example.com", at: 1 }));
    const attest = (await asMac(f.deps, "POST", "/account/join-attest", {})).json.token as string;
    const t = await joinToken(f.deps);
    expect((await putJoin(f.deps, t, { "x-squeak-join-attest": attest })).status).toBe(204);
    expect(JSON.parse(f.rows.get(`channels/${POND}/joinids|r1`)!)).toMatchObject({
      v: 1,
      userId: "u2",
      email: "lee@example.com",
      name: "Lee Chen",
    });
  });

  it("a forged, expired or account-token attestation is signed-out (401 signin), never a silent anonymous join", async () => {
    const f = setup();
    who = null;
    const t = await joinToken(f.deps);
    const attest = (await asMac(f.deps, "POST", "/account/join-attest", {})).json.token as string;
    const forged = attest.replace(/\.[^.]+$/, ".x");
    for (const bad of [forged, "ja.u2.1.bGVl.x", "garbage"]) {
      const r = await putJoin(f.deps, t, { "x-squeak-join-attest": bad });
      expect(r).toMatchObject({ status: 401, json: { error: "signin" } });
    }
    who = { userId: "u1", email: "pat@example.com", name: "Pat" };
    const minted = (await call(f.deps, "POST", "/account/app-token", { key: null })).json.token as string;
    // an account token is not an attestation, and an attestation is not an account token
    expect((await putJoin(f.deps, t, { "x-squeak-join-attest": minted })).status).toBe(401);
    who = null;
    const asAccount = await call(f.deps, "GET", "/me", { key: null, headers: { "x-squeak-account": attest } });
    expect(asAccount.status).toBe(401);
    expect(f.rows.has(`channels/${POND}/joins|r1`)).toBe(false);
  });

  it("a join with the account token (a browser with no cookie) writes joinids from the verified account only", async () => {
    const f = setup();
    who = { userId: "u1", email: "pat@example.com", name: "Pat" };
    const minted = (await call(f.deps, "POST", "/account/app-token", { key: null })).json.token as string;
    // the relay's own record of the account's name (left by the cookie sign-in above), not anything the client sends
    who = null; // no cookie user at all
    const t = await joinToken(f.deps);
    expect((await putJoin(f.deps, t, { "x-squeak-account": minted })).status).toBe(204);
    expect(JSON.parse(f.rows.get(`channels/${POND}/joinids|r1`)!)).toMatchObject({
      v: 1,
      userId: "u1",
      email: "pat@example.com",
      name: "Pat",
    });
  });

  it("a bad, expired or attestation-shaped account token is 401 signin, even with a good cookie behind it", async () => {
    const f = setup();
    who = { userId: "u1", email: "pat@example.com", name: "Pat" };
    const minted = (await call(f.deps, "POST", "/account/app-token", { key: null })).json.token as string;
    const t = await joinToken(f.deps);
    const forged = minted.replace(/\.[^.]+$/, ".x");
    const expired = "at.u1.1.cGF0QGV4YW1wbGUuY29t.x";
    for (const bad of [forged, expired, "garbage"]) {
      expect(await putJoin(f.deps, t, { "x-squeak-account": bad })).toMatchObject({
        status: 401,
        json: { error: "signin" },
      });
    }
    expect(f.rows.has(`channels/${POND}/joins|r1`)).toBe(false);
    // the cookie path is unchanged
    expect((await putJoin(f.deps, t)).status).toBe(204);
    expect(JSON.parse(f.rows.get(`channels/${POND}/joinids|r1`)!)).toMatchObject({ userId: "u1" });
  });

  it("GUEST_SIGNIN=required still refuses an anonymous join, and accepts the token one", async () => {
    const f = setup();
    Object.assign(f.deps, { signin: "required" });
    who = null;
    const t = await joinToken(f.deps);
    expect(await putJoin(f.deps, t)).toMatchObject({ status: 401, json: { error: "signin" } });
    who = { userId: "u1", email: "pat@example.com", name: "Pat" };
    const minted = (await call(f.deps, "POST", "/account/app-token", { key: null })).json.token as string;
    who = null;
    expect((await putJoin(f.deps, t, { "x-squeak-account": minted })).status).toBe(204);
  });

  it("names resolves ids with the relay key or a Mac key, caps the list and never takes a bad id", async () => {
    const f = setup();
    f.rows.set("names|u1", JSON.stringify({ name: "Pat Lee", email: "pat@example.com", at: 1 }));
    f.rows.set("names|u2", JSON.stringify({ name: "Lee Chen", email: "lee@example.com", at: 1 }));
    const op = await call(f.deps, "POST", "/account/names", { body: { ids: ["u1", "u3", "u1"] } });
    expect(op.json).toEqual({ names: { u1: { name: "Pat Lee", email: "pat@example.com" } } });
    const mac = await asMac(f.deps, "POST", "/account/names", { ids: ["u1"] });
    expect(mac.json.names.u1.name).toBe("Pat Lee");
    expect(mac.json.self).toEqual({ userId: "u2", name: "Lee Chen", email: "lee@example.com" });
    expect((await call(f.deps, "POST", "/account/names", { key: null, body: { ids: ["u1"] } })).status).toBe(401);
    expect((await call(f.deps, "POST", "/account/names", { key: "wrong", body: { ids: ["u1"] } })).status).toBe(401);
    expect((await call(f.deps, "POST", "/account/names", { body: { ids: ["../x"] } })).status).toBe(400);
    expect(
      (await call(f.deps, "POST", "/account/names", { body: { ids: Array.from({ length: 51 }, (_, i) => `u${i}`) } }))
        .status,
    ).toBe(400);
    // no pond token reads it, and no /doc path reaches the pk
    const t = await joinToken(f.deps);
    expect(
      (
        await call(f.deps, "POST", "/account/names", {
          key: null,
          body: { ids: ["u1"] },
          headers: { "x-squeak-pond-token": t },
        })
      ).status,
    ).toBe(404);
    expect((await call(f.deps, "GET", "/doc?path=names/u1")).status).toBe(400);
  });
});

describe("sign-in handoff to the web app's own origin", () => {
  const ret = "https://squeak.onslate.in/";
  const at = (r: string, n = "") => `/account/handoff?return=${encodeURIComponent(r)}${n}`;
  const mk = (user: unknown) => {
    const f = fakes();
    (f.deps as any).currentUser = async () => user;
    return f;
  };
  const U = { userId: "u1", email: "pat@example.com", name: "Pat" };
  it("signed in: 302 to the pinned return with an app token in the fragment, never the query", async () => {
    const r = await call(mk(U).deps, "GET", at(ret), { key: null });
    expect(r.status).toBe(302);
    const loc = r.headers.Location as string;
    expect(loc.startsWith("https://squeak.onslate.in/#squeak-token=at.u1.")).toBe(true);
    expect(loc).not.toContain("?");
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(r.headers["Referrer-Policy"]).toBe("no-referrer");
    // the token is an ordinary app token: /me accepts it with no cookie
    const tok = /#squeak-token=([^&]+)/.exec(loc)![1]!;
    const me = await call(mk(null).deps, "GET", "/me", { key: null, headers: { "x-squeak-account": tok } });
    expect(me.json.userId).toBe("u1");
  });
  it("signed out: hosted login that returns here once, then a 401 instead of a loop", async () => {
    const r = await call(mk(null).deps, "GET", at(ret), { key: null });
    expect(r.status).toBe(302);
    const loc = r.headers.Location as string;
    expect(loc.startsWith("/__catalyst/auth/login?redirect_url=")).toBe(true);
    expect(decodeURIComponent(loc.split("redirect_url=")[1]!)).toBe(
      `/server/squeak_relay/account/handoff?return=${encodeURIComponent(ret)}&n=1`,
    );
    expect((await call(mk(null).deps, "GET", at(ret, "&n=1"), { key: null })).status).toBe(401);
  });
  it("refuses any return that is not exactly the pinned origin, signed in or not", async () => {
    for (const bad of [
      "https://evil.example/",
      "https://squeak.onslate.in.evil.example/",
      "https://x.squeak.onslate.in/",
      "http://squeak.onslate.in/",
      "https://squeak.onslate.in:8443/",
      "https://squeak.onslate.in/?a=1",
      "https://squeak.onslate.in/#x",
      "https://squeak.onslate.in/other",
      "https://u@squeak.onslate.in/",
      "//evil.example/",
      "javascript:alert(1)",
      "",
    ]) {
      for (const user of [U, null]) {
        const r = await call(mk(user).deps, "GET", at(bad), { key: null });
        expect(r.status, bad).toBe(400);
        expect(r.headers.Location).toBeUndefined();
      }
    }
    expect((await call(mk(U).deps, "GET", "/account/handoff", { key: null })).status).toBe(400);
    expect((await call(mk(U).deps, "POST", at(ret), { key: null })).status).toBe(405);
    // /index.html is also fine
    expect((await call(mk(U).deps, "GET", at("https://squeak.onslate.in/index.html"), { key: null })).status).toBe(302);
  });
});

describe('short invite codes (docs/ponds.md, "Short codes")', () => {
  const MAC = "M".repeat(30);
  const POND = MAC; // a Mac owns the channel named by its own id
  const MAC_KEY = "m".repeat(43);
  const JOINER_MAC = "J".repeat(30);
  const JOINER_KEY = "j".repeat(43);
  const hash = (k: string) => require("node:crypto").createHash("sha256").update(k).digest("base64url");
  const details = (extra: Record<string, unknown> = {}) => ({
    v: 1,
    p: POND,
    o: "owner-public-key",
    n: "Squeak",
    s: "secret-secret",
    e: 9_999_999_999_999,
    r: "member",
    on: "Pat",
    l: { provider: "catalyst", relayUrl: "https://relay.example/server/squeak_relay" },
    jt: "pj.token",
    ...extra,
  });
  let now = 1_000_000;
  function setup() {
    const f = fakes();
    now = 1_000_000;
    Object.assign(f.deps, { now: () => now });
    f.rows.set(`mac-keys|${hash(MAC_KEY)}`, JSON.stringify({ userId: "owner1", macId: MAC, createdAt: 1 }));
    f.rows.set(`maclinks|${MAC}`, JSON.stringify({ userId: "owner1", email: "o@example.com" }));
    f.rows.set(`mac-keys|${hash(JOINER_KEY)}`, JSON.stringify({ userId: "joiner1", macId: JOINER_MAC, createdAt: 1 }));
    f.rows.set(`maclinks|${JOINER_MAC}`, JSON.stringify({ userId: "joiner1", email: "j@example.com" }));
    return f;
  }
  const owner = (d: unknown, body: unknown) =>
    call(d, "POST", "/ponds/short", { key: null, body, headers: { "x-squeak-mac-key": MAC_KEY } });
  const redeem = (d: unknown, code: unknown, key = JOINER_KEY) =>
    call(d, "POST", "/ponds/short/redeem", { key: null, body: { code }, headers: { "x-squeak-mac-key": key } });
  const make = async (d: unknown) => (await owner(d, { pondId: POND, details: details() })).json.code as string;

  it("makes a six-character code from the unambiguous alphabet, shown K7P-4QD, valid ten minutes", async () => {
    const f = setup();
    const r = await owner(f.deps, { pondId: POND, details: details() });
    expect(r.status).toBe(200);
    expect(r.json.code).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(r.json.code).not.toMatch(/[01OIL]/);
    expect(r.json.expiresAt).toBe(now + 10 * 60_000);
  });

  it("redeems once, in any case and with or without the dash, and returns exactly the details", async () => {
    const f = setup();
    const code = await make(f.deps);
    const r = await redeem(f.deps, code.toLowerCase().replace("-", " "));
    expect(r.status).toBe(200);
    expect(r.json.details).toEqual(details());
    const again = await redeem(f.deps, code);
    expect(again.status).toBe(404);
    expect(again.json).toEqual({ error: "code" });
  });

  it("keeps no pond key and no readable code, and refuses details that carry one", async () => {
    const f = setup();
    const code = await make(f.deps);
    const stored = [...f.rows].filter(([k]) => k.startsWith("shortcodes|"));
    expect(stored.length).toBe(1);
    expect(stored[0]![0]).not.toContain(code.replace("-", ""));
    expect(stored[0]![1]).not.toContain(code.replace("-", ""));
    expect(stored[0]![1]).not.toMatch(/"k"|"kv"/);
    for (const extra of [{ k: "pond-key" }, { kv: 1 }, { other: 1 }]) {
      expect((await owner(f.deps, { pondId: POND, details: details(extra) })).status).toBe(400);
    }
    expect((await owner(f.deps, { pondId: POND, details: details({ p: "Q".repeat(30) }) })).status).toBe(400);
  });

  it("expires after ten minutes, and the lapsed record is gone", async () => {
    const f = setup();
    const code = await make(f.deps);
    now += 10 * 60_000 + 1;
    expect((await redeem(f.deps, code)).status).toBe(404);
    expect([...f.rows.keys()].filter((k) => k.startsWith("shortcodes|"))).toEqual([]);
  });

  it("answers every miss the same: unknown, malformed, wrong length, ambiguous characters", async () => {
    const f = setup();
    await make(f.deps);
    const seen = new Set<string>();
    for (const bad of ["AAAAAA", "K7P", "0O1ILL", 42]) {
      const r = await redeem(f.deps, bad);
      seen.add(`${r.status} ${r.text}`);
    }
    expect([...seen]).toEqual([`404 {"error":"code"}`]);
  });

  it("needs a signed-in account: no key, the operator's key, a pond token and a bad token are all refused", async () => {
    const f = setup();
    const code = await make(f.deps);
    expect((await call(f.deps, "POST", "/ponds/short/redeem", { key: null, body: { code } })).status).toBe(401);
    expect((await call(f.deps, "POST", "/ponds/short/redeem", { body: { code } })).status).toBe(401);
    expect(
      (
        await call(f.deps, "POST", "/ponds/short/redeem", {
          key: null,
          body: { code },
          headers: { "x-squeak-account": "bad" },
        })
      ).status,
    ).toBe(401);
    expect((await redeem(f.deps, code, "z".repeat(43))).status).toBe(401);
    expect((await redeem(f.deps, code)).status).toBe(200); // still there: none of the above spent it
  });

  it("a web account token redeems too", async () => {
    const f = setup();
    Object.assign(f.deps, { currentUser: async () => ({ userId: "web1", email: "w@example.com", name: "Wen" }) });
    const code = await make(f.deps);
    const tok = (await call(f.deps, "POST", "/account/app-token", { key: null })).json.token as string;
    Object.assign(f.deps, { currentUser: async () => null });
    const r = await call(f.deps, "POST", "/ponds/short/redeem", {
      key: null,
      body: { code },
      headers: { "x-squeak-account": tok },
    });
    expect(r.status).toBe(200);
    expect(r.json.details.p).toBe(POND);
  });

  it("only the pond's own owner Mac makes a code; GET is 405", async () => {
    const f = setup();
    const other = "Z".repeat(30);
    f.rows.set(`channel-owners|${other}`, JSON.stringify({ macId: JOINER_MAC, userId: "joiner1", at: 1 }));
    expect((await owner(f.deps, { pondId: other, details: details({ p: other }) })).status).toBe(403);
    expect(
      (await call(f.deps, "GET", "/ponds/short", { key: null, headers: { "x-squeak-mac-key": MAC_KEY } })).status,
    ).toBe(405);
    expect(
      (await call(f.deps, "POST", "/ponds/short", { key: null, body: { pondId: POND, details: details() } })).status,
    ).toBe(401);
  });

  it("limits an account to 10 tries a minute and 30 an hour, right tries included", async () => {
    const f = setup();
    let ok = 0;
    let busy = 0;
    for (let i = 0; i < 12; i++) {
      const code = await make(f.deps);
      const r = await redeem(f.deps, code);
      if (r.status === 200) ok++;
      else if (r.status === 429 && r.json.error === "busy") busy++;
    }
    expect(ok).toBe(10);
    expect(busy).toBe(2);
    now += 60_001; // a new minute: the hour still has room for 20 more
    const code = await make(f.deps);
    expect((await redeem(f.deps, code)).status).toBe(200);
  });

  it("five wrong tries lock the account for ten minutes, even for a right code, then it opens", async () => {
    const f = setup();
    const code = await make(f.deps);
    for (let i = 0; i < 4; i++) expect((await redeem(f.deps, "AAAAA" + "ABCDEFGH"[i])).status).toBe(404);
    expect((await redeem(f.deps, "AAAAAH")).status).toBe(404); // the fifth locks
    const locked = await redeem(f.deps, code);
    expect(locked.status).toBe(429);
    expect(locked.json).toEqual({ error: "locked" });
    // another account is not locked by it, and the owner's code is untouched
    f.rows.set(
      `mac-keys|${hash("x".repeat(43))}`,
      JSON.stringify({ userId: "joiner2", macId: "K".repeat(30), createdAt: 1 }),
    );
    now += 10 * 60_000 - 1; // within the code's own life
    expect((await redeem(f.deps, code, "x".repeat(43))).status).toBe(200);
    now += 2;
    expect((await redeem(f.deps, "AAAAAB")).status).toBe(404); // lock over: a miss again, not a 429
  });

  it("limits an owner to 20 codes an hour", async () => {
    const f = setup();
    let made = 0;
    for (let i = 0; i < 22; i++) if ((await owner(f.deps, { pondId: POND, details: details() })).status === 200) made++;
    expect(made).toBe(20);
    now += 60 * 60_000 + 1;
    expect((await owner(f.deps, { pondId: POND, details: details() })).status).toBe(200);
  });

  it("is invisible to /doc and /list", async () => {
    const f = setup();
    await make(f.deps);
    for (const k of ["shortcodes", "short-rate", "short-tries"]) {
      expect((await call(f.deps, "GET", `/list?prefix=${k}`)).status).toBe(400);
      expect((await call(f.deps, "GET", `/doc?path=${k}/x`)).status).toBe(400);
    }
  });
});
