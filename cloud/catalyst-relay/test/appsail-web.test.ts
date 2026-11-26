// The relay as one AppSail server for the web app (#118): CORS for exactly the Slate origin on account routes (control
// routes stay without it), the unauthenticated invite preview, and the handoff's provider hint. Real HTTP, in-process.
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createServer } = require("../appsail/server.js");
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const SLATE = "https://squeak.onslate.in";
const PREVIEW = "https://preview-7-squeak.onslate.in";
const servers: Array<{ close: () => void; closeAllConnections?: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function boot(over: Record<string, unknown> = {}, serverOpts: Record<string, unknown> = {}) {
  const rows = new Map<string, string>();
  const people = createPeople({ tables: createMemoryTables(schema) });
  const deps = {
    key: KEY,
    store: {
      ready: async () => true,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: { channelId: async () => "c", publish: async () => undefined, token: async () => ({}) },
    people,
    currentUser: async () => null,
    ...over,
  };
  const server = createServer({ handle: createRelay(deps), log: () => {}, ...serverOpts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, people, deps };
}

const appToken = () => scoped.issueAppToken(KEY, "u1", "pat@example.com", Date.now(), 60_000).token as string;

describe("CORS: the Slate origin on account routes, nothing on control routes", () => {
  it("answers /me for the Slate origin with exactly that origin, the account header and no credentials", async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/me`, { headers: { origin: SLATE, "x-squeak-account": appToken() } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(SLATE);
    expect(r.headers.get("vary")).toMatch(/Origin/i);
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers a preflight for account routes, naming x-squeak-account", async () => {
    const { base } = await boot();
    for (const route of ["/me", "/invites/preview?code=x", "/account/macs", "/ponds/short/redeem"]) {
      const r = await fetch(`${base}${route}`, {
        method: "OPTIONS",
        headers: {
          origin: SLATE,
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-squeak-account",
        },
      });
      expect(r.status, route).toBe(204);
      expect(r.headers.get("access-control-allow-origin"), route).toBe(SLATE);
      expect(r.headers.get("access-control-allow-headers")?.toLowerCase(), route).toContain("x-squeak-account");
      expect(r.headers.get("access-control-allow-methods"), route).toMatch(/GET/);
    }
  });

  it("allows a preview origin only when it is configured, and never any other origin", async () => {
    const plain = await boot();
    const asks = (base: string, origin: string) => fetch(`${base}/me`, { headers: { origin } });
    expect((await asks(plain.base, PREVIEW)).headers.get("access-control-allow-origin")).toBeNull();
    const withPreview = await boot({}, { webOrigins: [SLATE, PREVIEW, "https://pr-*-squeak.onslate.in"] });
    expect((await asks(withPreview.base, PREVIEW)).headers.get("access-control-allow-origin")).toBe(PREVIEW);
    expect(
      (await asks(withPreview.base, "https://pr-12-squeak.onslate.in")).headers.get("access-control-allow-origin"),
    ).toBe("https://pr-12-squeak.onslate.in");
    for (const bad of [
      "https://evil.example",
      "https://squeak.onslate.in.evil.example",
      "http://squeak.onslate.in",
      "https://pr-1.evil-squeak.onslate.in",
      "https://pr-1/x-squeak.onslate.in",
      "null",
    ]) {
      const r = await asks(withPreview.base, bad);
      expect(r.headers.get("access-control-allow-origin"), bad).toBeNull();
    }
    const pre = await fetch(`${plain.base}/me`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect(pre.status).not.toBe(204);
  });

  it("gives control and device routes no CORS header, even to the Slate origin, preflight included", async () => {
    const { base } = await boot();
    const routes: Array<[string, string]> = [
      ["GET", "/doc?path=channels/a/state/x"],
      ["GET", "/list?prefix=channels/a/state"],
      ["GET", "/ping"],
      ["POST", "/token"],
      ["POST", "/pond-token"],
      ["POST", "/pond-revoke"],
      ["POST", "/pond-stream"],
      ["POST", "/ponds/short"],
      ["POST", "/account/link"],
      ["POST", "/account/macs/cliq-token"],
      ["GET", "/account/handoff?return=https://squeak.onslate.in/"],
      ["GET", "/health"],
      ["GET", "/control/state"],
    ];
    for (const [method, route] of routes) {
      const r = await fetch(`${base}${route}`, { method, headers: { origin: SLATE, "x-squeak-relay": KEY } });
      const p = await fetch(`${base}${route}`, {
        method: "OPTIONS",
        headers: { origin: SLATE, "access-control-request-method": method },
      });
      for (const x of [r, p]) {
        for (const h of ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods"])
          expect(x.headers.get(h), `${method} ${route} ${h}`).toBeNull();
      }
      expect(p.status, route).not.toBe(204);
    }
  });
});

describe("GET /invites/preview", () => {
  async function seeded() {
    const w = await boot();
    const { people } = w;
    await people.upsertAccount({ userId: "owner1", email: "ola@example.com", name: "Ola Lindqvist" });
    await people.upsertAccount({ userId: "mem1", email: "mo@example.com", name: "Mo Chen" });
    await people.createPond({ pondId: POND, ownerUserId: "owner1", name: "Pier 9" });
    await people.addMember({ pondId: POND, userId: "mem1", role: "member" });
    await people.createInvite({
      inviteId: "inv-abcdefghijklmnop",
      pondId: POND,
      email: "pat@example.com",
      role: "member",
      invitedBy: "owner1",
      expiresAt: Date.now() + 3_600_000,
    });
    return w;
  }
  const get = (base: string, code: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/invites/preview?code=${encodeURIComponent(code)}`, { headers });

  it("tells a signed-out visitor the Pond, the inviter, the first names of its members and the state, and no secrets", async () => {
    const { base } = await seeded();
    const r = await get(base, "inv-abcdefghijklmnop", { origin: SLATE });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe(SLATE);
    const j = await r.json();
    expect(j).toMatchObject({ pond: "Pier 9", inviter: "Ola", state: "pending" });
    expect(j.members).toEqual(["Ola", "Mo"]);
    expect(typeof j.expiresAt).toBe("number");
    const text = JSON.stringify(j);
    for (const secret of ["example.com", "owner1", "mem1", POND, "inv-abcdefghijklmnop"])
      expect(text).not.toContain(secret);
  });

  it("is a plain 404 for an unknown code, a malformed one, a missing one, and when there are no people tables", async () => {
    const { base } = await seeded();
    for (const code of ["nope", "", "x".repeat(200), "../etc"]) expect((await get(base, code)).status, code).toBe(404);
    expect((await fetch(`${base}/invites/preview`)).status).toBe(404);
    const bare = await boot({ people: undefined });
    expect((await get(bare.base, "inv-abcdefghijklmnop")).status).toBe(404);
  });

  it("names no members once the invite is no longer pending, and only answers GET", async () => {
    const { base, people } = await seeded();
    await people.settleInvite("inv-abcdefghijklmnop", "declined");
    const j = await (await get(base, "inv-abcdefghijklmnop")).json();
    expect(j.state).toBe("declined");
    expect(j.members).toEqual([]);
    expect((await fetch(`${base}/invites/preview?code=x`, { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("is rate limited, so a code cannot be guessed at speed", async () => {
    const { base } = await seeded();
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await get(base, `guess-${i}-aaaaaaaaaaaa`)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe("sign-in handoff provider hint", () => {
  const loc = async (query: string) => {
    const { base } = await boot();
    const r = await fetch(`${base}/account/handoff?return=${encodeURIComponent(`${SLATE}/`)}${query}`, {
      redirect: "manual",
    });
    return { status: r.status, location: r.headers.get("location") ?? "" };
  };

  it("carries a known provider to hosted login and back through the retry URL", async () => {
    for (const p of ["zoho", "google", "email"]) {
      const r = await loc(`&provider=${p}`);
      expect(r.status).toBe(302);
      expect(r.location.startsWith("/__catalyst/auth/login?redirect_url=")).toBe(true);
      expect(r.location).toContain(`&provider=${p}`);
      const again = decodeURIComponent(/redirect_url=([^&]+)/.exec(r.location)![1]!);
      expect(again).toBe(`/account/handoff?return=${encodeURIComponent(`${SLATE}/`)}&provider=${p}&n=1`);
    }
  });

  it("ignores an unknown provider and the old no-hint call", async () => {
    for (const q of ["&provider=evil%26x%3D1", "&provider=", ""]) {
      const r = await loc(q);
      expect(r.status).toBe(302);
      expect(r.location).not.toContain("provider");
    }
  });
});
