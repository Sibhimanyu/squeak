// GET /account/overview and the two invitation verbs the web's Ponds screen calls (docs/web-app-v2.md): metadata only (the
// cloud never reads content, ADR 0005), from the account's index rows, the people tables and the feed's newest row.
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createServer } = require("../appsail/server.js");
const { createRelay } = require(`${fn}handler.js`);
const { createFeed } = require(`${fn}feed.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const SLATE = "https://squeak.onslate.in";
const POND_A = "A".repeat(32);
const POND_B = "B".repeat(32);
const POND_C = "C".repeat(32);
const POND_D = "D".repeat(32);
const SEALED = (box: string) => ({ box, sig: "s", device: "d", at: 1 });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const servers: Array<{ close: () => void; closeAllConnections?: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function boot() {
  const rows = new Map<string, string>();
  const k = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const listOf = (pk: string) =>
    [...rows]
      .filter(([key]) => key.startsWith(`${pk}\u0000`))
      .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json }))
      .sort((a, b) => (a.doc < b.doc ? -1 : 1));
  const store = {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(k(pk, doc)) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(k(pk, doc), json),
    del: async (pk: string, doc: string) => void rows.delete(k(pk, doc)),
    list: async (pk: string) => listOf(pk),
    claim: async (pk: string, doc: string, json: string) => {
      if (rows.has(k(pk, doc))) return false;
      rows.set(k(pk, doc), json);
      return true;
    },
    range: async (pk: string, after: string | null, limit: number) =>
      listOf(pk)
        .filter((r) => after === null || r.doc > after)
        .slice(0, limit),
  };
  const people = createPeople({ tables: createMemoryTables(schema) });
  const deps = {
    key: KEY,
    store,
    streams: { channelId: async () => "c", publish: async () => undefined, token: async () => ({}) },
    people,
    currentUser: async () => null,
  };
  const server = createServer({ handle: createRelay(deps), log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const feed = createFeed(store);
  const index = (userId: string, pondId: string, row: Record<string, unknown>) =>
    store.put(`acctponds/${userId}`, pondId, JSON.stringify({ v: 1, ownerKey: `key-${pondId[0]}`, at: 5, ...row }));
  return { base, store, people, feed, index };
}

const tokenOf = (userId: string, email: string) =>
  scoped.issueAppToken(KEY, userId, email, Date.now(), 60_000).token as string;
const get = (base: string, route: string, token?: string, init: RequestInit = {}) =>
  fetch(`${base}${route}`, {
    ...init,
    headers: {
      ...(token ? { "x-squeak-account": token } : {}),
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });

describe("GET /account/overview", () => {
  it("lists the account's Ponds newest activity first, with counts and feed heads, and nothing of any content", async () => {
    const { base, store, feed, index, people } = await boot();
    await people.upsertAccount({ userId: "owen", email: "owen@example.com", name: "Owen" });
    // A: Owen's, shared (two members), one Duck, three changes. B: Owen's, alone, no Duck, one change, written later.
    await index("owen", POND_A, { name: "Alpha", ownerName: "Owen", ownerUserId: "owen", role: "owner" });
    await index("owen", POND_B, { name: "Beta", ownerName: "Owen", ownerUserId: "owen", role: "owner" });
    // C: someone else's, Owen is a viewer. D: one Owen has left. Neither is listed twice or leaks.
    await index("owen", POND_C, { name: "Gamma", ownerName: "Dana", ownerUserId: "dana", role: "viewer" });
    await index("owen", POND_D, { name: "Delta", ownerName: "Dana", left: true });
    await store.put(`channels/${POND_A}/members`, "m1", JSON.stringify(SEALED("secret-member-1")));
    await store.put(`channels/${POND_A}/members`, "m2", JSON.stringify(SEALED("secret-member-2")));
    await store.put(`channels/${POND_A}/threads`, "t1", JSON.stringify(SEALED("secret-duck")));
    await store.put(`channels/${POND_B}/members`, "m1", JSON.stringify(SEALED("secret-member-1")));
    await feed.append(POND_A, { kind: "members", id: "m1", doc: SEALED("x") });
    await feed.append(POND_A, { kind: "threads", id: "t1", doc: SEALED("x") });
    await feed.append(POND_A, { kind: "rposts", id: "p1", doc: SEALED("x") });
    await sleep(15);
    await feed.append(POND_B, { kind: "rposts", id: "p1", doc: SEALED("x") });
    await store.put(`channels/${POND_C}/members`, "m1", JSON.stringify(SEALED("c")));
    await store.put(`channels/${POND_C}/members`, "m2", JSON.stringify(SEALED("c")));

    const res = await get(base, "/account/overview", tokenOf("owen", "owen@example.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ponds: Array<Record<string, any>>; invitations: unknown[] };
    expect(body.ponds.map((p) => p.pondId)).toEqual([POND_B, POND_A, POND_C]);
    const [b, a, c] = body.ponds;
    expect(a).toEqual({
      pondId: POND_A,
      name: "Alpha",
      ownerName: "Owen",
      ownerKey: "key-A",
      mine: true,
      role: "owner",
      shared: true,
      lastActivityAt: expect.any(Number),
      seqHead: 3,
      counts: { members: 2, ducks: 1 },
    });
    expect(b).toMatchObject({
      pondId: POND_B,
      mine: true,
      shared: false,
      seqHead: 1,
      counts: { members: 1, ducks: 0 },
    });
    expect(b.lastActivityAt).toBeGreaterThan(a.lastActivityAt);
    expect(a.lastActivityAt).toBeGreaterThan(1_000_000_000_000);
    expect(c).toMatchObject({ pondId: POND_C, mine: false, role: "viewer", ownerName: "Dana", shared: true });
    expect(body.invitations).toEqual([]);
    // no content anywhere in the answer
    expect(JSON.stringify(body)).not.toMatch(/secret|"box"|"sig"/);
  });

  it("is the account's own and nobody else's: no sign-in, a forged token, a pond token and the operator's key are refused", async () => {
    const { base, index } = await boot();
    await index("owen", POND_A, { name: "Alpha", ownerName: "Owen" });
    expect((await get(base, "/account/overview")).status).toBe(401);
    expect((await get(base, "/account/overview", "at.owen.9999999999999.YQ.forged")).status).toBe(401);
    expect((await get(base, "/account/overview", undefined, { headers: { "x-squeak-relay": KEY } })).status).toBe(401);
    const other = await get(base, "/account/overview", tokenOf("eve", "eve@example.com"));
    expect(await other.json()).toEqual({ ponds: [], invitations: [] });
    expect((await get(base, "/account/overview", tokenOf("owen", "o@example.com"), { method: "POST" })).status).toBe(
      405,
    );
  });

  it("answers the Slate origin, preflight included, and no other", async () => {
    const { base } = await boot();
    const ok = await get(base, "/account/overview", tokenOf("owen", "owen@example.com"), {
      headers: { origin: SLATE },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(SLATE);
    const pre = await fetch(`${base}/account/overview`, {
      method: "OPTIONS",
      headers: {
        origin: SLATE,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-squeak-account",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-squeak-account");
    const join = await fetch(`${base}/account/invitations/abc123/join`, {
      method: "OPTIONS",
      headers: {
        origin: SLATE,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-squeak-account",
      },
    });
    expect(join.headers.get("access-control-allow-origin")).toBe(SLATE);
    const evil = await fetch(`${base}/account/overview`, { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("invitations: overview, join and decline", () => {
  async function invited() {
    const w = await boot();
    await w.people.upsertAccount({ userId: "dana", email: "dana@example.com", name: "Dana" });
    await w.people.createPond({ pondId: POND_A, ownerUserId: "dana", name: "Alpha" });
    await w.people.createInvite({
      inviteId: "inv1",
      pondId: POND_A,
      email: "pat@example.com",
      role: "member",
      invitedBy: "dana",
      expiresAt: Date.now() + 60_000,
    });
    return w;
  }

  it("shows a pending invitation to the invited address only", async () => {
    const { base } = await invited();
    const mine = await get(base, "/account/overview", tokenOf("pat", "pat@example.com"));
    const body = (await mine.json()) as { invitations: Array<Record<string, unknown>> };
    expect(body.invitations).toEqual([
      { inviteId: "inv1", pondName: "Alpha", inviterName: "Dana", at: expect.any(Number) },
    ]);
    const other = await get(base, "/account/overview", tokenOf("eve", "eve@example.com"));
    expect(((await other.json()) as any).invitations).toEqual([]);
  });

  it("join records the membership, settles the invite and drops it from the overview", async () => {
    const { base, people } = await invited();
    const token = tokenOf("pat", "pat@example.com");
    const joined = await get(base, "/account/invitations/inv1/join", token, { method: "POST" });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ pondId: POND_A });
    expect(await people.isMember(POND_A, "pat")).toBe(true);
    expect((await people.getInvite("inv1")).state).toBe("joined");
    expect(((await (await get(base, "/account/overview", token)).json()) as any).invitations).toEqual([]);
    // a second press says it is settled, never joins twice
    expect((await get(base, "/account/invitations/inv1/join", token, { method: "POST" })).status).toBe(409);
  });

  it("decline settles it with 204 and joins nothing", async () => {
    const { base, people } = await invited();
    const token = tokenOf("pat", "pat@example.com");
    expect((await get(base, "/account/invitations/inv1/decline", token, { method: "POST" })).status).toBe(204);
    expect((await people.getInvite("inv1")).state).toBe("declined");
    expect(await people.isMember(POND_A, "pat")).toBe(false);
    expect((await get(base, "/account/invitations/inv1/join", token, { method: "POST" })).status).toBe(409);
  });

  it("refuses another address, a stranger, no sign-in, a wrong verb and an unknown invitation", async () => {
    const { base, people } = await invited();
    const eve = tokenOf("eve", "eve@example.com");
    expect((await get(base, "/account/invitations/inv1/join", eve, { method: "POST" })).status).toBe(403);
    expect((await get(base, "/account/invitations/inv1/decline", eve, { method: "POST" })).status).toBe(403);
    expect((await get(base, "/account/invitations/inv1/join", undefined, { method: "POST" })).status).toBe(401);
    expect((await get(base, "/account/invitations/nope/join", eve, { method: "POST" })).status).toBe(404);
    expect((await get(base, "/account/invitations/inv1/join", tokenOf("pat", "pat@example.com"))).status).toBe(405);
    expect((await people.getInvite("inv1")).state).toBe("pending");
    expect(await people.isMember(POND_A, "eve")).toBe(false);
  });
});
