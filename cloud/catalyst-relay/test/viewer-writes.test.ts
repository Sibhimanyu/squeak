import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { wrapCreateRelay } from "./transport";

// A Viewer only reads (docs/adr/0006-pond-policy.md): the relay refuses a Viewer's Room post and command at once, not
// after the Owner's Mac drops it. The people tables say who an account is in the Pond; the token names a device of it.

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay: createRelayDirect } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const schema = require(`${fn}people-schema.json`);
const createRelay = wrapCreateRelay(createRelayDirect);

const KEY = "k".repeat(43);
const POND = "P".repeat(22);

async function world() {
  const rows = new Map<string, string>();
  const people = createPeople({ tables: createMemoryTables(schema), now: () => 1000 });
  await people.createPond({ pondId: POND, ownerUserId: "u-owner", name: "P" });
  await people.addMember({ pondId: POND, userId: "u-member", role: "member" });
  await people.addMember({ pondId: POND, userId: "u-viewer", role: "viewer" });
  await people.addDevice({ deviceId: "dev-member", userId: "u-member", name: "Mac", kind: "mac", publicKey: "pk1" });
  await people.addDevice({ deviceId: "dev-viewer", userId: "u-viewer", name: "Web", kind: "web", publicKey: "pk2" });
  const deps = {
    key: KEY,
    cliqKey: "q".repeat(43),
    people,
    store: {
      ready: async () => true,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: {
      channelId: async () => "chan-1",
      publish: async () => undefined,
      token: async () => ({ url: "x", key: "k", "wss-id": "w" }),
    },
  };
  return { deps, people };
}

async function send(deps: unknown, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = headers;
  let status = 0;
  const res: any = { writeHead: (s: number) => (status = s), end: () => undefined };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  return status;
}

const doc = (url: string) => `/doc?path=channels/${POND}/${url}`;
const body = { doc: { box: "sealed", sig: "s", device: "d", at: 5 } };

async function token(deps: unknown, memberId: string): Promise<string> {
  const req: any = new EventEmitter();
  req.method = "POST";
  req.url = "/server/squeak_relay/pond-token";
  req.headers = { "x-squeak-relay": KEY };
  let text = "";
  const res: any = { writeHead: () => undefined, end: (t?: string) => (text = t ?? "") };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify({ pondId: POND, memberId, ttlSec: 3600 })));
    req.emit("end");
  });
  await done;
  return JSON.parse(text).token;
}

describe("a Viewer's writes at the relay", () => {
  it("refuses a Viewer's Room post and command, and still lets a Member write both", async () => {
    const w = await world();
    const viewer = await token(w.deps, "dev-viewer");
    const member = await token(w.deps, "dev-member");
    const as = (t: string) => ({ "x-squeak-pond-token": t });
    expect(await send(w.deps, "PUT", doc("rposts/p1"), as(viewer), body)).toBe(403);
    expect(await send(w.deps, "PUT", doc("tcmds/c1"), as(viewer), body)).toBe(403);
    expect(await send(w.deps, "PUT", doc("rposts/p1"), as(member), body)).toBe(204);
    expect(await send(w.deps, "PUT", doc("tcmds/c1"), as(member), body)).toBe(204);
    // A Viewer still reads.
    expect(await send(w.deps, "GET", doc("rposts/p1"), as(viewer))).toBe(200);
  });

  it("follows a role change at once: a Member made a Viewer is refused, and a Viewer made a Member is let in", async () => {
    const w = await world();
    const member = await token(w.deps, "dev-member");
    const headers = { "x-squeak-pond-token": member };
    expect(await send(w.deps, "PUT", doc("rposts/a"), headers, body)).toBe(204);
    await w.people.setRole({ pondId: POND, userId: "u-member", role: "viewer" });
    expect(await send(w.deps, "PUT", doc("rposts/b"), headers, body)).toBe(403);
    await w.people.setRole({ pondId: POND, userId: "u-member", role: "member" });
    expect(await send(w.deps, "PUT", doc("rposts/c"), headers, body)).toBe(204);
  });

  it("a device the relay cannot place is not refused here (the Owner's Mac drops what a Viewer sent)", async () => {
    const w = await world();
    const stranger = await token(w.deps, "dev-unknown");
    expect(await send(w.deps, "PUT", doc("rposts/x"), { "x-squeak-pond-token": stranger }, body)).toBe(204);
  });
});
