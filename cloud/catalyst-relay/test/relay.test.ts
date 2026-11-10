import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay, VERSION } = require(`${fn}handler.js`);
const { parseDocPath, parseKindPath, validDoc, KINDS } = require(`${fn}rules.js`);

const KEY = "k".repeat(43);
const CH = "A".repeat(32);

function fakes(opts: { channel?: string | null; store?: boolean; publishFails?: boolean } = {}) {
  const rows = new Map<string, string>();
  const published: Array<[string, string]> = [];
  const calls: string[] = [];
  const deps = {
    key: KEY,
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
  opts: { key?: string | null; body?: unknown; raw?: string } = {},
) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = opts.key === null ? {} : { "x-squeak-relay": opts.key ?? KEY };
  let status = 0;
  let text = "";
  const res: any = {
    writeHead: (s: number) => {
      status = s;
    },
    end: (t?: string) => {
      text = t ?? "";
    },
  };
  const done = createRelay(deps)(req, res);
  const payload = opts.raw ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  queueMicrotask(() => {
    if (payload) req.emit("data", Buffer.from(payload));
    req.emit("end");
  });
  await done;
  return { status, json: text ? JSON.parse(text) : undefined, text };
}

const path = (kind = "state", doc = "d1") => `channels/${CH}/${kind}/${doc}`;
const doc = (box = "sealed") => ({ box, sig: "s", device: "phone", at: 5 });

describe("path and kind rules mirror firebase/database.rules.json", () => {
  it("shares one kinds list with the RTDB rules", () => {
    const rules = readFileSync(new URL("../../../firebase/database.rules.json", import.meta.url), "utf8");
    const read = rules.match(/"\.read": "([^"]+)"/)![1]!;
    const fromRules = [...read.matchAll(/\$kind === '(\w+)'/g)].map((m) => m[1]).sort();
    expect([...KINDS].sort()).toEqual(fromRules);
    expect(fromRules.length).toBe(22);
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
    queueMicrotask(() => {
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
