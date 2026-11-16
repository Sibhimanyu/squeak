// The AppSail transport serves device traffic only. Every route that needs a signed-in Catalyst user is refused there with
// a JSON 401 that points at the account origin, before the handler runs, whatever cookie or x-zc-* headers arrive.
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createServer } = require("../appsail/server.js");

const ACCOUNT = "https://squeak-60083782173.development.catalystserverless.in/server/squeak_relay";
const servers: Array<{ close: () => void; closeAllConnections?: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function boot() {
  const reached: string[] = [];
  const server = createServer({
    handle: async (req: any, res: any) => {
      reached.push(`${req.method} ${req.url}`);
      res.writeHead(204);
      res.end();
    },
    log: () => {},
    noCatalystUsers: true,
    accountUrl: ACCOUNT,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, reached };
}

/** Routes that read a Catalyst session (cookie), as handler.js routes them: function only. */
const USER_ROUTES: Array<[string, string]> = [
  ["GET", "/me"],
  ["GET", "/account/macs"],
  ["POST", "/account/macs/provision"],
  ["DELETE", "/account/macs/abc"],
  ["POST", "/account/device-request"],
  ["GET", "/account/device-request"],
  ["POST", "/account/link-ticket"],
  ["POST", "/account/app-token"],
  ["GET", "/account/handoff?return=https://squeak.onslate.in/"],
  ["GET", "/account/avatar"],
  ["PUT", "/account/avatar"],
  ["GET", "/account/zoho-photo"],
  ["GET", "/account/zoho-photo/start"],
  ["GET", "/account/zoho-photo/callback"],
];
/** Device traffic: a relay key, a Mac key, a pond token or a Cliq token proves it, never Catalyst identity. */
const DEVICE_ROUTES: Array<[string, string, Record<string, string>]> = [
  ["GET", "/ping", { "x-squeak-mac-key": "k" }],
  ["GET", "/doc?path=channels/a/state/x", { "x-squeak-mac-key": "k" }],
  ["PUT", "/doc?path=channels/a/state/x", { "x-squeak-relay": "k" }],
  ["DELETE", "/doc?path=channels/a/state/x", { "x-squeak-relay": "k" }],
  ["GET", "/list?prefix=channels/a/state", { "x-squeak-relay": "k" }],
  ["POST", "/pond-token", { "x-squeak-relay": "k" }],
  ["POST", "/pond-revoke", { "x-squeak-relay": "k" }],
  ["POST", "/account/link", { "x-squeak-mac-key": "k" }],
  ["POST", "/account/unlink", { "x-squeak-mac-key": "k" }],
  ["POST", "/account/macs/cliq-token", { "x-squeak-mac-key": "k" }],
  ["POST", "/account/macs/hist-token", { "x-squeak-mac-key": "k" }],
  ["PUT", "/doc?path=channels/a/cliq/b", { "x-squeak-cliq": "k" }],
  ["GET", "/account/avatar?userId=u", { "x-squeak-relay": "k" }],
  ["GET", "/account/avatar?userId=u", { "x-squeak-mac-key": "k" }],
];
const FORGED = {
  cookie: "_iamadt_client_1=forged; ZD_CSRF_TOKEN=x",
  "x-zc-user-type": "project-user",
  "x-zc-user-id": "1",
  "x-zc-user-cred-token": "forged",
  "x-zc-user-cred-type": "token",
};

describe("AppSail serves device traffic only", () => {
  for (const prefix of ["", "/server/squeak_relay"]) {
    it(`refuses every Catalyst-user route with JSON 401 pointing at the account origin (prefix "${prefix}")`, async () => {
      const { base, reached } = await boot();
      for (const [method, route] of USER_ROUTES) {
        const r = await fetch(`${base}${prefix}${route}`, {
          method,
          headers: FORGED,
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        expect(r.status, `${method} ${route}`).toBe(401);
        expect(r.headers.get("content-type")).toMatch(/^application\/json/);
        expect(await r.json()).toMatchObject({ error: "signin-on-account-origin", accountUrl: ACCOUNT });
      }
      expect(reached).toEqual([]);
    });
  }

  it("lets device routes through to the handler, forged identity headers or not", async () => {
    const { base, reached } = await boot();
    for (const [method, route, headers] of DEVICE_ROUTES) {
      const r = await fetch(`${base}${route}`, {
        method,
        headers: { ...headers, ...FORGED },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(r.status, `${method} ${route}`).toBe(204);
    }
    expect(reached.length).toBe(DEVICE_ROUTES.length);
  });

  it("lets the account-token routes through (the handler verifies Squeak's own signature, never a session)", async () => {
    const { base, reached } = await boot();
    for (const [method, route] of [
      ["GET", "/me"],
      ["GET", "/account/macs"],
      ["POST", "/account/macs/provision"],
      ["POST", "/account/device-request"],
    ] as const) {
      const r = await fetch(`${base}${route}`, {
        method,
        headers: { "x-squeak-account": "t" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(r.status, route).toBe(204);
    }
    expect(reached.length).toBe(4);
    // but the token never mints tokens or tickets
    for (const route of ["/account/app-token", "/account/link-ticket"]) {
      const r = await fetch(`${base}${route}`, { method: "POST", headers: { "x-squeak-account": "t" }, body: "{}" });
      expect(r.status).toBe(401);
    }
  });

  it("lets a short-code redeem through with a token or a key, and refuses it with a cookie alone", async () => {
    const { base } = await boot();
    for (const headers of [{ "x-squeak-account": "t" }, { "x-squeak-mac-key": "k" }, { "x-squeak-relay": "k" }]) {
      const r = await fetch(`${base}/ponds/short/redeem`, { method: "POST", headers, body: "{}" });
      expect(r.status, JSON.stringify(headers)).toBe(204);
    }
    expect((await fetch(`${base}/ponds/short/redeem`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("answers /health without a key", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("live-update tokens on AppSail", () => {
  async function bootWith(fetchImpl: any) {
    const reached: string[] = [];
    const server = createServer({
      handle: async (req: any, res: any) => {
        reached.push(`${req.method} ${req.url}`);
        res.writeHead(204);
        res.end();
      },
      log: () => {},
      noCatalystUsers: true,
      accountUrl: ACCOUNT,
      fetchImpl,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reached };
  }

  it("passes /token and /pond-stream to the function with the caller's own key, and nothing else", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fake = async (url: string, init: any) => {
      seen.push({ url, headers: init.headers, body: init.body ? Buffer.from(init.body).toString() : "" });
      return new Response('{"url":"wss://x","key":"k","wssId":"w"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { base, reached } = await bootWith(fake);
    const r = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-mac-key": "mk", cookie: "zc=1", "x-zc-user": "u" },
      body: '{"name":"sq1","channel":"c1"}',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "wss://x", key: "k", wssId: "w" });
    await fetch(`${base}/server/squeak_relay/pond-stream`, {
      method: "POST",
      headers: { "x-squeak-pond-token": "pt" },
      body: "{}",
    });
    expect(seen.map((s) => s.url)).toEqual([`${ACCOUNT}/token`, `${ACCOUNT}/pond-stream`]);
    expect(seen[0]!.headers).toEqual({ "content-type": "application/json", "x-squeak-mac-key": "mk" });
    expect(seen[0]!.body).toBe('{"name":"sq1","channel":"c1"}');
    expect(seen[1]!.headers["x-squeak-pond-token"]).toBe("pt");
    expect(Object.keys(seen[1]!.headers).sort()).toEqual(["content-type", "x-squeak-pond-token"]);
    // every other route is served here, never forwarded
    await fetch(`${base}/doc?path=channels/c1/state/alive`, { headers: { "x-squeak-mac-key": "mk" } });
    expect(seen).toHaveLength(2);
    expect(reached).toEqual(["GET /doc?path=channels/c1/state/alive"]);
  });

  it("passes the function's refusal through, and answers 502 when the function cannot be reached", async () => {
    const refusing = await bootWith(async () => new Response("", { status: 401 }));
    expect((await fetch(`${refusing.base}/token`, { method: "POST", body: "{}" })).status).toBe(401);
    const down = await bootWith(async () => {
      throw new Error("offline");
    });
    expect((await fetch(`${down.base}/token`, { method: "POST", body: "{}" })).status).toBe(502);
  });

  it("refuses a body too large for a token request", async () => {
    let called = false;
    const { base } = await bootWith(async () => {
      called = true;
      return new Response("{}");
    });
    const r = await fetch(`${base}/token`, { method: "POST", body: "x".repeat(5000) });
    expect(r.status).toBe(413);
    expect(called).toBe(false);
  });
});
