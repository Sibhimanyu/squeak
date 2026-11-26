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
import { FlotillaService, type AccountPort } from "./service.js";

// Invite by email (docs/ponds.md), against the real relay handler over an in-memory store and a fake mail sender.
const require = createRequire(import.meta.url);
const { createRelay } = require("../../cloud/catalyst-relay/functions/squeak_relay/handler.js") as {
  createRelay(deps: unknown): (req: unknown, res: unknown) => Promise<void>;
};

const KEY = "relay-key-".padEnd(43, "k");
const RELAY_URL = "https://squeak.catalystserverless.in/server/squeak_relay";

function world() {
  const rows = new Map<string, string>();
  const mailbox: Array<{ to: string; subject: string; text: string }> = [];
  const mail = { down: false };
  const deps = {
    mail: {
      send: async (m: { to: string; subject: string; text: string }) => {
        if (mail.down) throw new Error("sdk detail");
        mailbox.push(m);
      },
    },
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
  return { rows, fetch: fetchLike, account, mailbox, mail };
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
      nest: `${label}-mac`,
      ...(account ? { account } : {}),
      ...(owner ? { location, relay: new HttpPondRelay(RELAY_URL, KEY, w.fetch) } : {}),
      storeFor,
      now: () => clock,
    });
  };
  return { w, ownerAccount, mk, advance: (ms: number) => (clock += ms) };
}

const codeOf = (text: string): string => /join#([A-Za-z0-9_-]+)/.exec(text)![1]!;

describe("invite by email", () => {
  it("the matching account is let in at once, by name from its account, and the owner is told", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    const joined: string[] = [];
    A.on("member-joined", (_id: string, name: string) => joined.push(name));
    const r = await A.inviteByEmail(pond.id, [" Bea@Example.COM "], "member");
    expect(r).toEqual({ sent: ["bea@example.com"], failed: [] });
    expect(w.mailbox).toHaveLength(1);
    expect(w.mailbox[0]!.subject).toBe("Sibhi R invited you to Site on Squeak");
    const link = /https:\/\/squeak\.onslate\.in\/join#\S+/.exec(w.mailbox[0]!.text)![0];
    // no pond key rides in the emailed code
    const body = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString("utf8"));
    expect(body).toMatchObject({ k: "", kv: 0, em: "bea@example.com" });
    // different case, as the account holds it
    const bea = w.account("uB", "BEA@example.com", "Bea Lee");
    const B = mk("Bea", false, bea.port);
    await B.join(link);
    await A.refresh(pond.id);
    const view = await A.view(pond.id);
    expect(view.joins).toEqual([]);
    expect(view.members.map((m) => m.name).sort()).toEqual(["Bea Lee", "Sibhi R"]);
    expect(JSON.stringify(view.ripples)).toContain("joined");
    expect(joined).toEqual(["Bea Lee"]);
    expect(view.invites?.[0]?.state).toBe("accepted");
    // the key reached them: they are active
    await B.refresh(pond.id);
    expect((await B.list()).find((p) => p.id === pond.id)?.status).toBe("active");
  });

  it("another account is refused by the relay and nothing is left to approve", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    await A.inviteByEmail(pond.id, ["bea@example.com"]);
    const link = /https:\/\/squeak\.onslate\.in\/join#\S+/.exec(w.mailbox[0]!.text)![0];
    const eve = w.account("uE", "eve@example.com", "Eve");
    await expect(mk("Eve", false, eve.port).join(link)).rejects.toThrow();
    await A.refresh(pond.id);
    const view = await A.view(pond.id);
    expect(view.joins).toEqual([]);
    expect(view.members).toHaveLength(1);
  });

  it("signed out is refused too", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    await A.inviteByEmail(pond.id, ["bea@example.com"]);
    const link = /https:\/\/squeak\.onslate\.in\/join#\S+/.exec(w.mailbox[0]!.text)![0];
    await expect(mk("Anon", false, null).join(link)).rejects.toThrow();
    await A.refresh(pond.id);
    expect((await A.view(pond.id)).members).toHaveLength(1);
  });

  it("an ordinary (unbound) invite is never auto-approved, whoever signs in", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    const { code } = await A.invite(pond.id, "member");
    await mk("Bea", false, w.account("uB", "bea@example.com", "Bea").port).join(code);
    await A.refresh(pond.id);
    const view = await A.view(pond.id);
    expect(view.members).toHaveLength(1);
    expect(view.joins).toHaveLength(1);
  });

  it("mail trouble and limits come back as failed entries with a sentence, and leave no live invite", async () => {
    const { w, ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    w.mail.down = true;
    const down = await A.inviteByEmail(pond.id, ["a@example.com"]);
    expect(down.sent).toEqual([]);
    expect(down.failed).toHaveLength(1);
    expect(down.failed[0]!.reason).not.toContain("sdk");
    w.mail.down = false;
    const ten = Array.from({ length: 9 }, (_, i) => `u${i}@example.com`);
    expect((await A.inviteByEmail(pond.id, ten)).sent).toHaveLength(9);
    const over = await A.inviteByEmail(pond.id, ["one-more@example.com"]);
    expect(over.sent).toEqual([]);
    expect(over.failed[0]!.reason).toContain("Too many");
    const pending = ((await A.view(pond.id)).invites ?? []).filter((i) => i.state === "pending");
    expect(pending).toHaveLength(9);
  });

  it("is strict: bad addresses, too many, viewers only as roles, and only an owner", async () => {
    const { ownerAccount, mk } = setup();
    const A = mk("Sibhi", true, ownerAccount.port);
    const pond = await A.createPond({ name: "Site", projectId: "proj-Site" });
    await expect(A.inviteByEmail(pond.id, [])).rejects.toThrow();
    await expect(A.inviteByEmail(pond.id, ["nope"])).rejects.toThrow("doesn't look like an email");
    await expect(
      A.inviteByEmail(
        pond.id,
        Array.from({ length: 11 }, (_, i) => `u${i}@example.com`),
      ),
    ).rejects.toThrow("at most");
    await expect(A.inviteByEmail(pond.id, ["a@example.com"], "owner" as never)).rejects.toThrow();
    void codeOf;
  });
});
