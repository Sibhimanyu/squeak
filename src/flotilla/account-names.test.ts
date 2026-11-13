/* eslint-disable @typescript-eslint/no-explicit-any -- fake http request and response objects for the relay handler */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CatalystStore } from "../cloud/catalyst-store.js";
import type { CloudStore } from "../cloud/store.js";
import { HttpPondRelay } from "./relay.js";
import { FlotillaService, SIGNED_OUT_MEMBER, SIGN_IN_TO_JOIN, type AccountPort } from "./service.js";

// Names come only from sign-in (docs/ponds.md, "Names"), against the real relay handler over an in-memory store.
const require = createRequire(import.meta.url);
const { createRelay } = require("../../cloud/catalyst-relay/functions/squeak_relay/handler.js") as {
  createRelay(deps: unknown): (req: unknown, res: unknown) => Promise<void>;
};

const KEY = "relay-key-".padEnd(43, "k");
const RELAY_URL = "https://squeak.catalystserverless.in/server/squeak_relay";

function world() {
  const rows = new Map<string, string>();
  const deps = {
    key: KEY,
    currentUser: async () => null,
    store: {
      ready: async () => true,
      get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
      list: async (pk: string) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: {
      channelId: async () => "chan",
      pondChannelId: async () => "pond-chan",
      publish: async () => undefined,
      token: async (_id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `tok-${name}`, "wss-id": "w1" }),
    },
  };
  const handler = createRelay(deps);
  const fetchLike = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const req: any = new EventEmitter();
    req.method = init.method ?? "GET";
    req.url = u.pathname + u.search;
    req.headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    let status = 0;
    let text = "";
    const res: any = { writeHead: (s: number) => (status = s), end: (t?: string) => (text = t ?? "") };
    const done = handler(req, res);
    setImmediate(() => {
      if (typeof init.body === "string") req.emit("data", Buffer.from(init.body));
      req.emit("end");
    });
    await done;
    return new Response(status === 204 ? null : text || "{}", { status });
  };
  /** A provisioned Mac of account `userId` (tenants.js keeps the key's hash): its own key and the account's names. */
  let n = 0;
  const account = (userId: string, email: string, name: string | null, claim = name ?? "") => {
    n += 1;
    const macKey = `m${n}`.padEnd(43, "x");
    const macId = `M${n}`.padEnd(30, "x");
    rows.set(`mac-keys|${createHash("sha256").update(macKey).digest("base64url")}`, JSON.stringify({ userId, macId }));
    rows.set(`maclinks|${macId}`, JSON.stringify({ userId, email }));
    if (name) rows.set(`names|${userId}`, JSON.stringify({ name, email, at: 1 }));
    const relay = new HttpPondRelay(RELAY_URL, macKey, fetchLike, true);
    const port: AccountPort = {
      name: () => claim || null,
      email: () => email,
      attest: async () => (await relay.attest()).token,
      names: (ids) => relay.names(ids),
    };
    return { port, relay, macKey };
  };
  return { rows, fetch: fetchLike, account };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const nostore = {
  get: async () => null,
  set: async () => undefined,
  list: async () => [],
  delete: async () => undefined,
  watch: () => () => undefined,
} as unknown as CloudStore;

function setup() {
  const w = world();
  const ownerAccount = w.account("uO", "sibhi@example.com", "Sibhi R");
  const location = { provider: "catalyst", relayUrl: RELAY_URL, relayKey: KEY };
  const storeFor = (loc: unknown, token?: string | null, joinAttest?: string): CloudStore => {
    const l = loc as typeof location;
    if (token)
      return new CatalystStore({
        baseUrl: l.relayUrl,
        pondToken: token,
        ...(joinAttest ? { joinAttest } : {}),
        fetch: w.fetch,
      });
    return new CatalystStore({ baseUrl: l.relayUrl, relayKey: l.relayKey, fetch: w.fetch });
  };
  let clock = Date.now();
  const mk = (label: string, owner: boolean, account: AccountPort | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-names-"));
    dirs.push(dir);
    return new FlotillaService({
      store: owner ? new CatalystStore({ baseUrl: RELAY_URL, relayKey: KEY, fetch: w.fetch }) : nostore,
      supportDir: dir,
      displayName: label,
      nest: `${label}-mac`,
      ...(account ? { account } : {}),
      ...(owner ? { location, relay: new HttpPondRelay(RELAY_URL, KEY, w.fetch) } : {}),
      storeFor,
      now: () => clock,
    });
  };
  return { w, ownerAccount, mk, advance: (ms: number) => (clock += ms) };
}

describe("names come only from sign-in", () => {
  it("joining needs a signed-in Squeak account, and says so plainly; nothing is left behind", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    const { code } = await A.invite(pond.id, "member");
    const signedOut = w.account("uX", "x@example.com", null);
    const refusing: AccountPort = {
      ...signedOut.port,
      attest: async () => {
        const { RelayRefused } = await import("./relay.js");
        throw new RelayRefused(401);
      },
    };
    const B = mk("Aarav", false, refusing);
    await expect(B.join(code)).rejects.toThrow(SIGN_IN_TO_JOIN);
    expect(await B.list()).toEqual([]);
  });

  it("the owner writes the member's name from the relay's account, not from what the joiner sent", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    const { code } = await A.invite(pond.id, "member");
    // the joiner's own Mac claims "Eve the Admin" as its name; the relay knows the account as Aarav Rao
    const acct = w.account("uA", "aarav@example.com", "Aarav Rao", "Eve the Admin");
    const B = mk("Aarav", false, acct.port);
    await (B.join as (code: string, typed?: string) => Promise<unknown>)(code, "Typed Name");
    const [req] = (await A.view(pond.id)).joins;
    expect(req).toMatchObject({ name: "Aarav Rao", verifiedEmail: "aarav@example.com" });
    await A.decideJoin(pond.id, req!.requestId, { approve: true });
    const flock = (await A.view(pond.id)).members;
    expect(flock.map((m) => m.name).sort()).toEqual(["Aarav Rao", "Sibhi R"]);
    expect(w.rows.get(`channels/${pond.id}/joinids|${req!.requestId}`)).toBeUndefined();
  });

  it("a member without a verified account is the Signed-out member; the claimed name is not used", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    const { code } = await A.invite(pond.id, "viewer");
    // a joiner with no attestation at all (an older client): the relay saw nobody sign in
    const old = mk("Old Mac", false, null);
    await old.join(code);
    const [req] = (await A.view(pond.id)).joins;
    expect(req!.name).toBe(SIGNED_OUT_MEMBER);
    await A.decideJoin(pond.id, req!.requestId, { approve: true });
    expect((await A.view(pond.id)).members.map((m) => m.name)).toContain(SIGNED_OUT_MEMBER);
    expect(w.rows.size).toBeGreaterThan(0);
  });

  it("the owner's Mac refreshes names from accounts, at most every 30 minutes", async () => {
    const { w, ownerAccount, mk, advance } = setup();
    let calls = 0;
    const counted: AccountPort = {
      ...ownerAccount.port,
      names: (ids) => {
        calls += 1;
        return ownerAccount.port.names(ids);
      },
    };
    const A = mk("Sibhi", true, counted);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    const { code } = await A.invite(pond.id, "member");
    const acct = w.account("uA", "aarav@example.com", "Aarav Rao");
    const B = mk("Aarav", false, acct.port);
    await B.join(code);
    const [req] = (await A.view(pond.id)).joins;
    await A.decideJoin(pond.id, req!.requestId, { approve: true });
    await A.refresh(pond.id);
    expect(calls).toBe(1);
    // the person changes their name at their sign-in provider; the relay hears it at their next sign-in
    w.rows.set("names|uA", JSON.stringify({ name: "Aarav R. Rao", email: "aarav@example.com", at: 2 }));
    await A.refresh(pond.id);
    expect(calls).toBe(1);
    expect((await A.view(pond.id)).members.map((m) => m.name)).toContain("Aarav Rao");
    advance(31 * 60_000);
    await A.refresh(pond.id);
    expect(calls).toBe(2);
    expect((await A.view(pond.id)).members.map((m) => m.name)).toContain("Aarav R. Rao");
  });

  it("there is no way to rename yourself: no such method, and a typed name is ignored", () => {
    const { mk, ownerAccount } = setup();
    const A = mk("Sibhi", true, ownerAccount.port) as unknown as Record<string, unknown>;
    for (const name of ["rename", "renameMe", "setName", "setDisplayName", "updateProfile"]) {
      expect(typeof A[name]).not.toBe("function");
    }
    expect(FlotillaService.prototype.join.length).toBe(1);
  });
});
