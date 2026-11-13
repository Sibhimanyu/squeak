import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HookIngressServer } from "../fleet/hook-ingress.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { makePairingCode, readPairGrant, readPairingCode, sealPairGrant } from "../voice/pair-protocol.js";
import { readClaimGrant, sealClaimGrant } from "../voice/claim-protocol.js";
import { pairingFor, readSavedPairing, savedLocation, writeSavedPairing } from "../voice/addon-pairing.js";
import {
  activeLocation,
  catalystLocation,
  createCloudStore,
  readCloudConfig,
  relayUrlOf,
  writeCloudConfig,
} from "./config.js";
import { CloudControl } from "./control.js";
import { CatalystStore } from "./catalyst-store.js";
import { readLocation, relayBaseUrl, sameLocation, type CloudLocation } from "./location.js";
import { movePath, readAddonMove, readPhoneMove, sealAddonMove, sealPhoneMove, watchAddonMove } from "./move.js";
import { SwitchableStore } from "./switchable-store.js";

const dirs: string[] = [];
const fakes: FakeRtdb[] = [];
const servers: HookIngressServer[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-cloud-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const RELAY = "https://squeak-1234.development.catalystserverless.in/server/squeak_relay";
const RELAY_KEY = crypto.randomBytes(32).toString("base64url");
const CHANNEL = crypto.randomBytes(16).toString("base64url");
const CHANNEL_KEY = crypto.randomBytes(32).toString("base64");
const FIREBASE = {
  provider: "firebase",
  databaseUrl: "https://squeak-x-default-rtdb.asia-southeast1.firebasedatabase.app",
} as const;
const CATALYST: CloudLocation = { provider: "catalyst", relayUrl: RELAY, relayKey: RELAY_KEY };

async function fakeStore(): Promise<{ fake: FakeRtdb; store: RtdbRest }> {
  const fake = new FakeRtdb();
  fakes.push(fake);
  return { fake, store: new RtdbRest(await fake.start()) };
}

describe("relay URL and location checks", () => {
  it("accepts only an https Catalyst host and normalizes it", () => {
    expect(relayBaseUrl(`${RELAY}/`)).toBe(RELAY);
    expect(relayBaseUrl("https://x.catalystappsail.com/server/squeak_relay?a=1#b")).toBe(
      "https://x.catalystappsail.com/server/squeak_relay",
    );
    for (const bad of [
      "http://x.catalystserverless.in/server/squeak_relay",
      "https://catalystserverless.in.evil.com/server/squeak_relay",
      "https://evil.com/server/squeak_relay",
      "https://u:p@x.catalystserverless.in/server/squeak_relay",
      "https://x.catalystserverless.in:8443/server/squeak_relay",
      "https://x.catalystserverless.xyz/server/squeak_relay",
      42,
    ]) {
      expect(relayBaseUrl(bad)).toBeNull();
    }
  });

  it("reads a location from move fields and rejects a mismatch", () => {
    expect(readLocation({ provider: "catalyst", c: RELAY, ck: RELAY_KEY })).toEqual(CATALYST);
    expect(readLocation({ provider: "firebase", r: FIREBASE.databaseUrl })).toEqual(FIREBASE);
    expect(readLocation({ provider: "catalyst", c: RELAY, ck: "short" })).toBeNull();
    expect(readLocation({ provider: "catalyst", r: FIREBASE.databaseUrl })).toBeNull();
    expect(readLocation({ provider: "firebase", r: "https://evil.com" })).toBeNull();
    expect(sameLocation(CATALYST, { ...CATALYST })).toBe(true);
    expect(sameLocation(CATALYST, FIREBASE)).toBe(false);
  });
});

describe("cloud.json and the factory", () => {
  it("is absent by default: Firebase from the environment", () => {
    const dir = tmp();
    expect(readCloudConfig(dir)).toBeNull();
    expect(activeLocation(null, FIREBASE.databaseUrl)).toEqual(FIREBASE);
    expect(activeLocation(null, null)).toBeNull();
  });

  it("is written 0600 and atomically, and read back with bad fields dropped", () => {
    const dir = tmp();
    writeCloudConfig(dir, {
      active: "catalyst",
      firebase: { databaseUrl: FIREBASE.databaseUrl, projectId: "squeak-x" },
      catalyst: {
        projectId: "123",
        projectName: "squeak",
        dc: "in",
        appUrl: "https://squeak-1234.development.catalystserverless.in",
        relayKey: RELAY_KEY,
        deployedVersion: "1",
      },
    });
    const file = path.join(dir, "cloud.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["cloud.json"]);
    const config = readCloudConfig(dir)!;
    expect(config.active).toBe("catalyst");
    expect(relayUrlOf(config.catalyst)).toBe(RELAY);
    expect(activeLocation(config, null)).toEqual(CATALYST);
    fs.writeFileSync(
      file,
      JSON.stringify({ active: 7, catalyst: { dc: 5, relayKey: 1 }, firebase: { databaseUrl: 3 } }),
    );
    expect(readCloudConfig(dir)).toEqual({
      active: "firebase",
      catalyst: { projectId: null, projectName: null, dc: "in", appUrl: null, relayKey: null, deployedVersion: null },
    });
  });

  it("falls back to Firebase when Catalyst is chosen but not deployed", () => {
    const config = { active: "catalyst" as const, firebase: { databaseUrl: FIREBASE.databaseUrl, projectId: null } };
    expect(activeLocation(config, null)).toEqual(FIREBASE);
    expect(catalystLocation(undefined)).toBeNull();
  });

  it("makes an RtdbRest or a CatalystStore", () => {
    expect(createCloudStore(FIREBASE)).toBeInstanceOf(RtdbRest);
    expect(createCloudStore(CATALYST)).toBeInstanceOf(CatalystStore);
    expect(createCloudStore({ active: "firebase" }, { envDatabaseUrl: FIREBASE.databaseUrl })).toBeInstanceOf(RtdbRest);
    expect(() => createCloudStore({ active: "firebase" })).toThrow("not set up");
  });
});

describe("SwitchableStore", () => {
  it("reads the old store for a while after a switch, and writes only the new one", async () => {
    const a = await fakeStore();
    const b = await fakeStore();
    const store = new SwitchableStore(a.store, FIREBASE);
    await store.set("channels/c/commands/1", { box: "old" });
    const woke: number[] = [];
    store.watch("channels/c/commands", () => woke.push(1));
    store.switchTo(b.store, CATALYST);
    expect(store.location).toEqual(CATALYST);
    await store.set("channels/c/commands/2", { box: "new" });
    expect(b.fake.tree.get("channels/c/commands/2")?.box).toBe("new");
    expect(a.fake.tree.get("channels/c/commands/2")).toBeNull();
    expect((await store.get("channels/c/commands/1"))?.box).toBe("old");
    expect((await store.list("channels/c/commands")).map((i) => i.id).sort()).toEqual(["1", "2"]);
    await store.delete("channels/c/commands/1");
    expect(a.fake.tree.get("channels/c/commands/1")).toBeNull();
    expect(woke.length).toBeGreaterThan(0);
    store.endPrevious();
    expect(store.readingOld).toBe(false);
  });
});

describe("the move document", () => {
  it("is sealed with the channel key for a phone and bound to its id for the add-on", () => {
    const phone = sealPhoneMove(CHANNEL_KEY, CATALYST, 123);
    expect(phone.at).toBe(123);
    expect(readPhoneMove(CHANNEL_KEY, phone)).toEqual({ location: CATALYST, at: 123 });
    expect(readPhoneMove(crypto.randomBytes(32).toString("base64"), phone)).toBeNull();
    const addon = sealAddonMove(CHANNEL_KEY, FIREBASE, 456);
    expect(readAddonMove(CHANNEL_KEY, addon)).toEqual({ location: FIREBASE, at: 456 });
    // The phone's copy has no HMAC; the add-on refuses it. A doc forged under another id is refused too.
    expect(readAddonMove(CHANNEL_KEY, phone)).toBeNull();
    expect(readAddonMove(CHANNEL_KEY, { ...addon, sig: "0".repeat(64) })).toBeNull();
    expect(movePath(CHANNEL)).toBe(`channels/${CHANNEL}/state/move`);
  });

  it("is refused when it names a host outside the allow-list", () => {
    const evil = sealPhoneMove(
      CHANNEL_KEY,
      { provider: "catalyst", relayUrl: "https://evil.com/x", relayKey: RELAY_KEY },
      1,
    );
    expect(readPhoneMove(CHANNEL_KEY, evil)).toBeNull();
  });

  it("is acted on by the add-on once, only when verified and newer", async () => {
    const { fake, store } = await fakeStore();
    const moves: number[] = [];
    let last = 0;
    const stop = watchAddonMove({
      store,
      channel: CHANNEL,
      key: CHANNEL_KEY,
      lastAt: () => last,
      onMove: (move) => {
        last = move.at;
        moves.push(move.at);
      },
      pollMs: 20,
    });
    // Unverified: another key's seal, and a plain phone-style doc.
    fake.tree.set(movePath(CHANNEL), sealAddonMove(crypto.randomBytes(32).toString("base64"), CATALYST, 10));
    await new Promise((r) => setTimeout(r, 80));
    expect(moves).toEqual([]);
    fake.tree.set(movePath(CHANNEL), sealAddonMove(CHANNEL_KEY, CATALYST, 20));
    await until(() => moves.length === 1);
    // The same or an older move is not replayed.
    fake.tree.set(movePath(CHANNEL), sealAddonMove(CHANNEL_KEY, FIREBASE, 20));
    fake.tree.set(movePath(CHANNEL), sealAddonMove(CHANNEL_KEY, FIREBASE, 5));
    await new Promise((r) => setTimeout(r, 80));
    expect(moves).toEqual([20]);
    stop();
  });
});

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("pairing grants", () => {
  it("keeps the Firebase code and grant exactly as before", () => {
    const made = makePairingCode(FIREBASE.databaseUrl, 1000);
    const read = readPairingCode(made.code)!;
    expect(read).toEqual({ databaseUrl: FIREBASE.databaseUrl, secret: made.secret, rendezvous: made.rendezvous });
    const doc = sealPairGrant(made.secret, { v: 1, channel: CHANNEL, key: CHANNEL_KEY, at: 1000 });
    expect(readPairGrant(made.secret, doc, 1000)).toEqual({ v: 1, channel: CHANNEL, key: CHANNEL_KEY, at: 1000 });
  });

  it("carries the relay as cu and ck for Catalyst, in the code and in the grant", () => {
    const made = makePairingCode(CATALYST, 1000);
    const body = JSON.parse(Buffer.from(made.code.slice(4), "base64url").toString("utf8")) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["ck", "cu", "s"]);
    expect(body.cu).toBe(RELAY);
    const read = readPairingCode(made.code)!;
    expect(read.location).toEqual(CATALYST);
    expect(read.databaseUrl).toBe("");
    const doc = sealPairGrant(made.secret, {
      v: 1,
      channel: CHANNEL,
      key: CHANNEL_KEY,
      at: 1000,
      cu: RELAY,
      ck: RELAY_KEY,
    });
    expect(readPairGrant(made.secret, doc, 1000)).toMatchObject({ cu: RELAY, ck: RELAY_KEY });
    const evil = sealPairGrant(made.secret, {
      v: 1,
      channel: CHANNEL,
      key: CHANNEL_KEY,
      at: 1000,
      cu: "https://evil.com/x",
      ck: RELAY_KEY,
    });
    expect(readPairGrant(made.secret, evil, 1000)).toBeNull();
    // A code with a relay but a bad key is no code.
    const forged = "SQ1-" + Buffer.from(JSON.stringify({ cu: RELAY, ck: "x", s: made.secret })).toString("base64url");
    expect(readPairingCode(forged)).toBeNull();
  });

  it("seals the claim grant with cu and ck for Catalyst and databaseUrl for Firebase", () => {
    const code = "K7M2-QX9P";
    const pair = crypto.generateKeyPairSync("x25519");
    const publicKey = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }))
      .subarray(-32)
      .toString("base64url");
    const request = { name: "Squeak Voice", version: "1", publicKey, at: 1000 };
    for (const grant of [
      { databaseUrl: FIREBASE.databaseUrl, channel: CHANNEL, key: CHANNEL_KEY },
      { databaseUrl: "", relayUrl: RELAY, relayKey: RELAY_KEY, channel: CHANNEL, key: CHANNEL_KEY },
    ]) {
      const doc = sealClaimGrant(code, request, grant, 1000);
      expect(readClaimGrant(code, pair.privateKey, doc, 1000)).toEqual(grant);
    }
  });

  it("saves a pairing for the add-on across a move and reads old files", () => {
    const dir = tmp();
    const file = path.join(dir, "pairing.json");
    fs.writeFileSync(file, JSON.stringify({ databaseUrl: FIREBASE.databaseUrl, channel: CHANNEL, key: CHANNEL_KEY }));
    const old = readSavedPairing(file)!;
    expect(savedLocation(old)).toEqual(FIREBASE);
    writeSavedPairing(file, pairingFor(old, CATALYST, 99));
    const moved = readSavedPairing(file)!;
    expect(savedLocation(moved)).toEqual(CATALYST);
    expect(moved.movedAt).toBe(99);
    expect(moved.channel).toBe(CHANNEL);
    expect(
      savedLocation({
        databaseUrl: "",
        channel: CHANNEL,
        key: CHANNEL_KEY,
        relayUrl: "https://evil.com",
        relayKey: RELAY_KEY,
      }),
    ).toBeNull();
  });
});

describe("CloudControl", () => {
  async function setup(opts: { connect?: boolean } = {}) {
    const dir = tmp();
    const a = await fakeStore();
    const b = await fakeStore();
    writeCloudConfig(dir, {
      active: "firebase",
      firebase: { databaseUrl: FIREBASE.databaseUrl, projectId: "squeak-x" },
      hosted: { provider: "catalyst", url: RELAY, macKey: RELAY_KEY, macId: CHANNEL, hosted: true },
    });
    const store = new SwitchableStore(a.store, FIREBASE);
    const announced: CloudLocation[] = [];
    const control = new CloudControl({
      supportDir: dir,
      hosted: {
        view: () => ({ state: "needs-sign-in", legacy: "firebase" }) as never,
        connect: () => opts.connect ?? false,
        moveNow: () => opts.connect ?? false,
        setRelay: async () => ({ ok: false }),
      },
      store,
      firebase: () => ({ databaseUrl: FIREBASE.databaseUrl, projectId: "squeak-x" }),
      makeStore: (location) => (location.provider === "catalyst" ? b.store : a.store),
      announceMove: async (target) => {
        announced.push(target);
      },
      noticeTimeoutMs: 2000,
    });
    return { dir, a, b, store, control, announced };
  }

  it("tests a provider on a throwaway channel and deletes everything it wrote", async () => {
    const { control, a } = await setup();
    const result = await control.test("firebase");
    expect(result.ok).toBe(true);
    expect(result.writeMs).not.toBeNull();
    expect(result.readMs).not.toBeNull();
    expect(result.noticeMs).not.toBeNull();
    const puts = a.fake.requests.filter((r) => r.startsWith("PUT"));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(/^PUT \/channels\/[A-Za-z0-9_-]{22}\/state\/test$/);
    expect(a.fake.requests.some((r) => r.startsWith("DELETE"))).toBe(true);
    expect(a.fake.tree.list(puts[0]!.slice(5, puts[0]!.lastIndexOf("/")))).toHaveLength(0);
    const view = (await control.view()) as { firebase: { lastTest: { ok: boolean } } };
    expect(view.firebase.lastTest.ok).toBe(true);
  });

  it("moves onto the hosted relay: announces on the old store, switches, saves, and reads the old store for stragglers", async () => {
    const { control, store, a, b, announced, dir } = await setup();
    await a.store.set("channels/c/commands/1", { box: "straggler" });
    const target: CloudLocation = { provider: "catalyst", relayUrl: RELAY, relayKey: RELAY_KEY, hosted: true };
    expect(await control.moveTo(target)).toEqual({ ok: true });
    expect(announced).toEqual([target]);
    expect(store.location).toEqual(target);
    expect(readCloudConfig(dir)!.active).toBe("hosted");
    expect((await store.get("channels/c/commands/1"))?.box).toBe("straggler");
    await store.set("channels/c/state/x", { box: "n" });
    expect(b.fake.tree.get("channels/c/state/x")?.box).toBe("n");
  });

  describe("routes", () => {
    async function ingress(opts: { connect?: boolean } = {}) {
      const s = await setup(opts);
      const probe = net.createServer();
      const port = await new Promise<number>((resolve) =>
        probe.listen(0, "127.0.0.1", () => {
          const p = (probe.address() as net.AddressInfo).port;
          probe.close(() => resolve(p));
        }),
      );
      const tokenPath = path.join(s.dir, "hook-token");
      const server = new HookIngressServer({ port, tokenPath, onEvent: () => undefined });
      await server.start();
      servers.push(server);
      server.setControl({
        sessionMessage: () => ({}),
        reply: async () => ({}),
        cloud: { handle: (method, route, body) => s.control.handle(method, route, body) },
      });
      const auth = { "x-squeak-token": fs.readFileSync(tokenPath, "utf8").trim(), "content-type": "application/json" };
      const base = `http://127.0.0.1:${port}/control/cloud`;
      return { ...s, auth, base };
    }

    it("is token-gated, has no CORS header and answers the contract's shapes", async () => {
      const { base, auth } = await ingress();
      expect((await fetch(base)).status).toBe(403);
      expect((await fetch(`${base}/hosted/connect`, { method: "POST", body: "{}" })).status).toBe(403);
      const view = await fetch(base, { headers: auth });
      expect(view.status).toBe(200);
      expect(view.headers.get("access-control-allow-origin")).toBeNull();
      const body = (await view.json()) as {
        active: string;
        hosted: Record<string, unknown>;
        firebase: Record<string, unknown>;
        catalyst: { configured: boolean };
      };
      expect(body.active).toBe("firebase");
      expect(body.hosted).toEqual({ state: "needs-sign-in", legacy: "firebase" });
      expect(body.firebase).toMatchObject({ configured: true, projectId: "squeak-x", lastTest: null });
      expect(JSON.stringify(body)).not.toContain(RELAY_KEY);
    });

    it("connect: 409 without an account, 202 with one, strict body", async () => {
      const none = await ingress();
      const refused = await fetch(`${none.base}/hosted/connect`, { method: "POST", headers: none.auth, body: "{}" });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "not-signed-in" });
      const some = await ingress({ connect: true });
      expect(
        (await fetch(`${some.base}/hosted/connect`, { method: "POST", headers: some.auth, body: "{}" })).status,
      ).toBe(202);
      expect(
        (await fetch(`${some.base}/hosted/connect`, { method: "POST", headers: some.auth, body: '{"x":1}' })).status,
      ).toBe(400);
    });

    it("move-now: 409 without an account, 202 with one, strict body", async () => {
      const none = await ingress();
      const refused = await fetch(`${none.base}/move-now`, {
        method: "POST",
        headers: none.auth,
        body: "{}",
      });
      expect(refused.status).toBe(409);
      const some = await ingress({ connect: true });
      expect((await fetch(`${some.base}/move-now`, { method: "POST", headers: some.auth, body: "{}" })).status).toBe(
        202,
      );
      expect(
        (await fetch(`${some.base}/move-now`, { method: "POST", headers: some.auth, body: '{"x":1}' })).status,
      ).toBe(400);
      expect((await fetch(`${some.base}/move-now`, { method: "POST", body: "{}" })).status).toBe(403);
    });

    it("answers the self-hosting routes with 410", async () => {
      const { base, auth } = await ingress();
      const gone = async (method: string, route: string) => {
        const response = await fetch(`${base}${route}`, {
          method,
          headers: auth,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect([response.status, await response.json()]).toEqual([410, { error: "self-hosting-removed" }]);
      };
      await gone("GET", "/catalyst/projects");
      await gone("POST", "/catalyst/project");
      await gone("POST", "/catalyst/deploy");
      await gone("POST", "/catalyst/check");
      await gone("POST", "/firebase/rename");
      await gone("POST", "/select");
    });

    it("answers bad bodies and unknown routes with fixed sentences", async () => {
      const { base, auth } = await ingress();
      const post = (route: string, body: unknown) =>
        fetch(`${base}${route}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      expect((await post("/test", { provider: "azure" })).status).toBe(400);
      expect((await post("/test", { provider: "firebase", extra: 1 })).status).toBe(400);
      expect((await fetch(`${base}/nope`, { headers: auth })).status).toBe(404);
      expect((await fetch(base, { method: "DELETE", headers: auth })).status).toBe(405);
      const bad = await fetch(`${base}/test`, { method: "POST", headers: auth, body: "{nope" });
      expect(bad.status).toBe(400);
    });

    it("tests through the route", async () => {
      const { base, auth } = await ingress();
      const tested = await fetch(`${base}/test`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "firebase" }),
      });
      expect(await tested.json()).toMatchObject({ ok: true });
    });
  });
});
