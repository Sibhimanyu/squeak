/* eslint-disable @typescript-eslint/no-explicit-any -- reaches the service's private store and the relay's untyped CommonJS */
// The multiplayer journey (journey.e2e.test.ts) again, but over the REAL relay code instead of a fake RTDB: the relay's own
// handler.js is served over HTTP in-process (AppSail's server.js for device traffic, the function-style server for sign-in),
// with in-memory NoSQL and Data Streams adapters standing in only for Catalyst's storage and stream services. Each person
// signs in as a test user, gets a per-Mac key, and uses the same HttpPondRelay / CatalystStore / FlotillaService /
// FlotillaBridge a daemon builds (src/flotilla/index.ts), with its own support directory and host double.
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatalystStore, type StreamSocket } from "../cloud/catalyst-store.js";
import { createCloudStore } from "../cloud/config.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FakeHost, session } from "./journey-support.js";
import { HttpPondRelay, RelayRefused } from "./relay.js";
import { FlotillaService } from "./service.js";

// The stashed own-thread mode (docs/ponds.md): these tests exercise it, so it is on here.
process.env.SQUEAK_POND_OWN_THREADS = "on";

const require = createRequire(import.meta.url);
const fn = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createServer } = require("../../cloud/catalyst-relay/appsail/server.js");

const RELAY_KEY = "k".repeat(43);
const BASE = "https://squeak-relay.development.catalystappsail.in";
const SHARED_CHANNEL = "shared-stream-1";

/** Catalyst's NoSQL table as the relay's `store` dep sees it. */
function memoryStore() {
  const rows = new Map<string, string>();
  return {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
    del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
    list: async (pk: string) =>
      [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.slice(pk.length + 1), json })),
  };
}

/** Catalyst Data Streams in memory: `publish` reaches every open fake socket subscribed with a token for that channel. */
class MemoryStreams {
  readonly sockets = new Set<FakeSocket>();
  readonly published: Array<[string, string]> = [];
  private n = 0;
  deps = {
    channelId: async () => SHARED_CHANNEL,
    pondChannelId: async () => null,
    publish: async (id: string, text: string) => {
      this.published.push([id, text]);
      for (const s of this.sockets) if (s.channel === id) s.deliver(text, ++this.n);
    },
    token: async (id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `${id}|${name}`, "wss-id": "w1" }),
  };
  socket = (url: string): StreamSocket => new FakeSocket(this, url);
}

class FakeSocket implements StreamSocket {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly channel: string;
  constructor(
    private readonly hub: MemoryStreams,
    url: string,
  ) {
    this.channel = decodeURIComponent(new URL(url).searchParams.get("key") ?? "").split("|")[0]!;
    hub.sockets.add(this);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ mtype: "0" }) }), 0);
  }
  send(): void {}
  close(): void {
    this.hub.sockets.delete(this);
  }
  deliver(text: string, n: number): void {
    this.onmessage?.({
      data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { data: text, streamingId: String(n) } } }),
    });
  }
}

interface TestUser {
  userId: string;
  email: string;
  name: string;
}

const servers: Array<ReturnType<typeof createServer>> = [];
let deviceUrl = "";
let functionUrl = "";
const streams = new MemoryStreams();
const dirs: string[] = [];

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  const store = memoryStore();
  const common = {
    key: RELAY_KEY,
    store,
    streams: streams.deps,
    hosted: true,
    sharedNotice: true,
    log: () => {},
    usageCache: new Map(),
    ownerCache: new Map(),
  };
  // The function: Hosted login. Whoever the test names in x-test-user is the signed-in Catalyst user.
  const asFunction = (req: any, res: any) => {
    const who = req.headers["x-test-user"];
    const user = who ? (JSON.parse(String(who)) as TestUser) : null;
    return createRelay({ ...common, currentUser: async () => user })(req, res);
  };
  // AppSail: no Catalyst user, ever (index.js, SQUEAK_NO_CATALYST_USER=1).
  const asAppSail = (req: any, res: any) => createRelay({ ...common, currentUser: async () => null })(req, res);
  functionUrl = await listen(createServer({ handle: asFunction, log: () => {} }));
  deviceUrl = await listen(createServer({ handle: asAppSail, log: () => {}, noCatalystUsers: true }));
});
afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The daemon's `fetch` for a Catalyst address: the https relay URL goes to the local server. */
const toLocal =
  (origin: string) =>
  (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    return fetch(`${origin}${u.pathname}${u.search}`, init);
  };

/** A signed-in person: an app token minted by the function, then a per-Mac key from the device origin's provision route. */
async function signIn(user: TestUser) {
  const tokenRes = await fetch(`${functionUrl}/account/app-token`, {
    method: "POST",
    headers: { "x-test-user": JSON.stringify(user), "content-type": "application/json" },
    body: "{}",
  });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };
  const macId = `mac${randomId(16)}`;
  const provisioned = await fetch(`${deviceUrl}/account/macs/provision`, {
    method: "POST",
    headers: { "x-squeak-account": token, "content-type": "application/json" },
    body: JSON.stringify({ macId, name: `${user.name}'s Mac` }),
  });
  expect(provisioned.status).toBe(200);
  const { key } = (await provisioned.json()) as { key: string };
  return { macId, key };
}

type Mac = Awaited<ReturnType<typeof mac>>;
async function mac(user: TestUser, nest: string | null = `${user.name}-mac`) {
  const { key } = await signIn(user);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-relay-"));
  dirs.push(dir);
  const doFetch = toLocal(deviceUrl);
  const location = { provider: "catalyst" as const, relayUrl: BASE, relayKey: key, hosted: true as const };
  const relay = new HttpPondRelay(BASE, key, doFetch, true);
  // As src/flotilla/index.ts wires a hosted Mac.
  const account = {
    name: () => user.name,
    email: () => user.email,
    attest: async () => (await relay.attest()).token,
    names: async (ids: string[]) => relay.names(ids),
  };
  const stores: CatalystStore[] = [];
  const service = new FlotillaService({
    account,
    store: createCloudStore(location, { fetch: doFetch, socket: streams.socket }),
    supportDir: dir,
    nest,
    location,
    inviteLinkBase: "https://x.test/join",
    relay,
    wakeDebounceMs: 0,
    wakeMinIntervalMs: 0,
    storeFor: (loc, pondToken, joinAttest) => {
      const at = loc as { provider: string; relayUrl: string; relayKey?: string };
      if (pondToken) {
        const s = new CatalystStore({
          baseUrl: at.relayUrl,
          pondToken,
          ...(joinAttest ? { joinAttest } : {}),
          fetch: doFetch,
          socket: streams.socket,
        });
        stores.push(s);
        return s;
      }
      if (!("relayKey" in at)) throw new Error("This pond has no access on this Mac yet.");
      return createCloudStore(at as typeof location, { fetch: doFetch, socket: streams.socket });
    },
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { dir, service, host, bridge, name: user.name, key, relay };
}

/** A signed command built by hand, as a hostile or buggy member would, written through that member's own store. */
async function rawCommand(who: Mac, pondId: string, body: Record<string, unknown>) {
  const identity = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "identity.json"), "utf8")).identity;
  const pond = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId];
  const id = randomId(12);
  const docPath = `channels/${pondId}/tcmds/${id}`;
  const now = Date.now();
  const cmd = { id, issuedAt: now, expiresAt: now + 60_000, nonce: randomId(12), ...body };
  const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, cmd)}`;
  const doc = { box, sig: signText(identity.privateKey, signedText(docPath, box)), device: who.service.me.id, at: now };
  const store = (who.service as any).storeOf((who.service as any).activePond(pondId));
  if (!store) throw new Error("no store for the member's pond");
  await store.set(docPath, doc);
}

describe("the multiplayer journey over the real relay", () => {
  let A: Mac;
  let B: Mac;
  let pondId = "";
  let shared = "";
  let own = "";
  let oldToken = "";

  beforeAll(async () => {
    A = await mac({ userId: "u-sibhi", email: "sibhi@example.com", name: "Sibhi" });
    B = await mac({ userId: "u-aarav", email: "aarav@example.com", name: "Aarav" });
  });

  it("1. create, publish, account invite, join, approve: the member sees the pond", async () => {
    const pond = await A.service.createPond({
      name: "Site",
      projectId: "p1",
      gitRemote: "git@github.com:acme/site.git",
    });
    pondId = pond.id;
    // Pinned to Aarav's account: another account's join attestation would be refused by the relay.
    const made = await A.service.invite(pondId, "member", "aarav@example.com");
    await B.service.join(made.link!);
    const [join] = (await A.service.view(pondId)).joins;
    expect(join).toMatchObject({ name: "Aarav", nest: "Aarav-mac" });
    await A.service.decideJoin(pondId, join!.requestId, { approve: true });
    await B.service.refresh(pondId);
    const view = await B.service.view(pondId);
    expect(view.me.role).toBe("member");
    expect(view.members.map((m) => m.name).sort()).toEqual(["Aarav", "Sibhi"]);
  });

  it("2. the member messages the owner's shared thread: the owner sees it in order with the author", async () => {
    A.host.sessions.set("a1", session("a1", { title: "Owner thread" }));
    A.host.say("a1", "user/text", { text: "Start" }, "user");
    shared = (await A.bridge.share(pondId, "a1")).id;
    await A.bridge.flush();
    const seen = (await B.service.threads(pondId)).find((t) => t.id === shared)!;
    expect(seen).toMatchObject({ mode: "shared", starterName: "Sibhi" });
    await B.bridge.message(pondId, shared, "first");
    await B.bridge.message(pondId, shared, "second");
    await A.bridge.runCommands(pondId);
    expect(A.host.sent.map((s) => [s.text, s.author?.name])).toEqual([
      ["first", "Aarav"],
      ["second", "Aarav"],
    ]);
  });

  it("3. the member answers the owner's question under a hold", async () => {
    A.host.ask("a1", "q1");
    await A.bridge.flush();
    expect(await B.bridge.hold(pondId, "q1")).toMatchObject({ ok: true });
    expect(await A.service.heldBy(pondId, "q1")).toMatchObject({ byName: "Aarav" });
    expect((await B.bridge.answer(pondId, shared, "q1", "3000")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
    expect(A.host.responded.map((r) => r.requestId)).toEqual(["q1"]);
  });

  it("4. the member's own thread shows on the owner's side as theirs, with its Nest", async () => {
    B.host.sessions.set("b1", session("b1", { title: "Aarav's thread" }));
    B.host.say("b1", "user/text", { text: "Do it" }, "user");
    own = (await B.bridge.share(pondId, "b1", { mode: "own" })).id;
    B.host.say("b1", "assistant", { message: { content: [{ type: "text", text: "On it." }] } });
    await B.bridge.flush();
    const seen = (await A.service.threads(pondId)).find((t) => t.id === own)!;
    expect(seen).toMatchObject({ mode: "own", starterName: "Aarav", nest: "Aarav-mac" });
    expect((await A.service.readEvents(pondId, own, 0)).events.map((e) => e.type)).toContain("agent");
  });

  it("5. the owner messages the member's thread; it runs on the member's Mac, attributed", async () => {
    expect(await A.bridge.message(pondId, own, "Also add tests")).toMatchObject({ ok: true, state: "queued" });
    expect(await B.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "message" })]);
    expect(B.host.sent).toEqual([
      { id: "b1", text: "Also add tests", mode: "queue", author: { id: A.service.me.id, name: "Sibhi" } },
    ]);
  });

  it("6. the owner restricts the member live: refused at the starter's Mac even if their client sends it", async () => {
    await A.service.changeRole(pondId, B.service.me.id, "viewer");
    expect(await B.bridge.message(pondId, shared, "still here")).toMatchObject({ ok: false, state: "refused" });
    await rawCommand(B, pondId, { kind: "message", threadId: shared, text: "forged" });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "Viewers can read but not send." }),
    ]);
    expect(A.host.sent.map((s) => s.text)).not.toContain("forged");
    await A.service.changeRole(pondId, B.service.me.id, "member");
    expect((await B.bridge.message(pondId, shared, "back")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
  });

  it("6b. a notice over Data Streams wakes the member's watch, and the hosted notice names no path", async () => {
    const store = (B.service as any).storeOf((B.service as any).activePond(pondId));
    const woke: string[] = [];
    const stop = store.watch(`channels/${pondId}`, (source?: string) => woke.push(source ?? "stream"));
    await new Promise((r) => setTimeout(r, 50));
    woke.length = 0;
    streams.published.length = 0;
    A.host.say("a1", "assistant", { message: { content: [{ type: "text", text: "ping" }] } });
    await A.bridge.flush();
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(woke).toContain("stream");
    expect(streams.published.length).toBeGreaterThan(0);
    for (const [, text] of streams.published) expect(text).not.toContain(pondId);
  });

  it("6c. a member's token reaches only its own pond and never the relay-owned kinds", async () => {
    const token = (B.service as any).activePond(pondId).token?.value as string;
    expect(token).toBeTruthy();
    const call = (route: string, method = "GET", body?: unknown) =>
      fetch(`${deviceUrl}${route}`, {
        method,
        headers: { "x-squeak-pond-token": token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const other = "o".repeat(30);
    expect(
      (await call(`/list?prefix=${encodeURIComponent(`channels/${other}/threads`)}`)).status,
    ).toBeGreaterThanOrEqual(400);
    const doc = { box: "x", at: 1 };
    for (const kind of ["joinids", "devreqs", "devresults", "hist"]) {
      const r = await call(`/doc?path=${encodeURIComponent(`channels/${pondId}/${kind}/d1`)}`, "PUT", { doc });
      expect(r.status, kind).toBeGreaterThanOrEqual(400);
    }
    expect((await call(`/list?prefix=${encodeURIComponent(`channels/${pondId}/threads`)}`)).status).toBe(200);
  });

  it("7. the member leaves; the owner's Mac removes them and the relay turns their token away", async () => {
    oldToken = (B.service as any).activePond(pondId).token?.value as string;
    await B.service.leave(pondId);
    await A.service.refresh(pondId);
    expect((await A.service.view(pondId)).members.map((m) => m.name)).toEqual(["Sibhi"]);
    const res = await fetch(`${deviceUrl}/list?prefix=${encodeURIComponent(`channels/${pondId}/threads`)}`, {
      headers: { "x-squeak-pond-token": oldToken },
    });
    expect(res.status).toBe(401);
  });

  it("8. joins on the web, then their Mac picks up the pond by signing in: no invite, code or approval", async () => {
    const carol = { userId: "u-carol", email: "carol@example.com", name: "Carol" };
    const web = await mac(carol, null);
    await web.service.join((await A.service.invite(pondId, "member", carol.email)).link!);
    const [join] = (await A.service.view(pondId)).joins;
    await A.service.decideJoin(pondId, join!.requestId, { approve: true });
    await web.service.refresh(pondId);
    expect((await web.service.view(pondId)).me.role).toBe("member");
    // later she signs in on her Mac: it asks, the owner's Mac adds the device, the pond appears
    const laptop = await mac(carol);
    expect(await laptop.service.syncAccountPonds()).toBe(1);
    await A.service.refresh(pondId);
    await laptop.service.refresh(pondId);
    const view = await laptop.service.view(pondId);
    expect(view.me.role).toBe("member");
    expect(view.members.filter((m) => m.name === "Carol")).toHaveLength(1);
    expect((await laptop.bridge.message(pondId, shared, "from my Mac")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
    expect(A.host.sent.at(-1)).toMatchObject({ text: "from my Mac", author: { name: "Carol" } });
  });

  it("the relay refuses what a Mac key may not do", async () => {
    const wrong = new HttpPondRelay(BASE, "z".repeat(43), toLocal(deviceUrl), true);
    await expect(wrong.attest()).rejects.toBeInstanceOf(RelayRefused);
  });
});
