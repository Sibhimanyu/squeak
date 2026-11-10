import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountTicketError, type AccountRelay } from "../cloud/account.js";
import type { CloudLocation } from "../cloud/location.js";
import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import { generateMemberKey, openFromMember } from "../flotilla/crypto.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { RemoteBridge } from "./remote-bridge.js";
import { pairingCode, seal } from "./remote-crypto.js";

const NOW = Date.parse("2026-11-10T03:00:00.000Z");
const CATALYST: CloudLocation = {
  provider: "catalyst",
  relayUrl: "https://app.catalystserverless.in/server/squeak_relay",
  relayKey: "k".repeat(32),
};
const FIREBASE: CloudLocation = { provider: "firebase", databaseUrl: "https://x.firebaseio.com" };

class MemoryStore {
  readonly docs = new Map<string, ChannelDoc>();
  async get(p: string) {
    return this.docs.get(p) ?? null;
  }
  async set(p: string, doc: ChannelDoc) {
    this.docs.set(p, doc);
  }
  async list(collection: string) {
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(`${collection}/`))
      .map(([p, doc]) => ({ id: p.split("/").pop()!, doc }));
  }
  async delete(p: string) {
    this.docs.delete(p);
  }
}

/** The relay: plain documents in a map, and `/account/*` answers a test sets. */
class FakeRelay implements AccountRelay {
  readonly docs = new Map<string, Record<string, unknown>>();
  link = vi.fn<AccountRelay["link"]>(async () => ({ userId: "u1", email: "o@example.com" }));
  unlink = vi.fn<AccountRelay["unlink"]>(async () => undefined);
  async listDocs(collection: string) {
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(`${collection}/`))
      .map(([p, doc]) => ({ id: p.split("/").pop()!, doc }));
  }
  async putDoc(p: string, doc: Record<string, unknown>) {
    this.docs.set(p, doc);
  }
  async deleteDoc(p: string) {
    this.docs.delete(p);
  }
}

function device() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x963 = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]).toString("base64");
  const sign = (message: string) =>
    crypto.sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return { x963, sign };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup(options: { location?: CloudLocation; relay?: FakeRelay | null } = {}) {
  const added: Array<{ name: string; email: string; text: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-account-"));
  dirs.push(dir);
  const store = new MemoryStore();
  const relay = options.relay === undefined ? new FakeRelay() : options.relay;
  const location = options.location ?? CATALYST;
  let now = NOW;
  const bridge = new RemoteBridge({
    configPath: path.join(dir, "remote.json"),
    projectId: "squeak-test",
    store,
    replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
    snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
    location: () => location,
    accountRelay: () => relay,
    onOwnDeviceAdded: (info) => added.push(info),
    macName: "Test Mac",
    now: () => now,
  });
  const pairing = bridge.startPairing();
  const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
  const phone = device();
  await store.set(`channels/${payload.c}/pairing/iphone-1`, {
    box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
  });
  await bridge.tick();
  await bridge.approve("iphone-1");
  const config = () => JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
  const command = (fields: Record<string, unknown>, signer = phone, nonce = crypto.randomBytes(16).toString("hex")) => {
    const box = seal(payload.k, { v: 1, nonce, expiresAt: now + 60_000, ...fields });
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };
  const run = (fields: Record<string, unknown>, signer = phone) =>
    bridge.handleCommand(config(), "c1", command(fields, signer));
  const channel = `channels/${payload.c}`;
  const request = (id: string, over: Record<string, unknown> = {}) => {
    const web = device();
    const box = generateMemberKey();
    return {
      web,
      box,
      doc: {
        v: 1,
        reqId: id,
        userId: "u1",
        email: "o@example.com",
        name: "Chrome",
        publicKey: web.x963,
        boxKey: box.publicKey,
        at: now,
        ...over,
      },
    };
  };
  return {
    added,
    bridge,
    store,
    relay,
    payload,
    channel,
    config,
    run,
    request,
    advance: (ms: number) => (now += ms),
    dir,
  };
}

describe("web accounts: linking", () => {
  it("links with a ticket from a paired device, saves it and shows the email", async () => {
    const t = await setup();
    const verdict = await t.run({ kind: "accountLink", ticket: "T1" });
    expect(verdict.result).toEqual({ id: "c1", status: "sent" });
    expect(t.relay!.link).toHaveBeenCalledWith("T1", t.payload.c, "Test Mac");
    expect(t.config().account).toMatchObject({ userId: "u1", email: "o@example.com" });
    expect(fs.statSync(path.join(t.dir, "remote.json")).mode & 0o777).toBe(0o600);
    expect(t.bridge.phoneView().account).toEqual({ email: "o@example.com" });
    expect(t.bridge.accountState()).toEqual({
      linked: true,
      askOwnDevices: false,
      email: "o@example.com",
      signInUrl: "https://app.catalystserverless.in/app/index.html",
    });
  });

  it("has no account in the view until linked", async () => {
    const t = await setup();
    expect(t.bridge.phoneView().account).toBeUndefined();
    expect(t.bridge.accountState()).toEqual({
      linked: false,
      signInUrl: "https://app.catalystserverless.in/app/index.html",
    });
  });

  it("refuses an unpaired device and does not call the relay", async () => {
    const t = await setup();
    const verdict = await t.run({ kind: "accountLink", ticket: "T1" }, device());
    expect(verdict.write).toBe(false);
    expect(t.relay!.link).not.toHaveBeenCalled();
  });

  it("refuses a bad ticket, extra keys, an overlong ticket and a replayed nonce", async () => {
    const t = await setup();
    t.relay!.link.mockRejectedValueOnce(new AccountTicketError());
    expect((await t.run({ kind: "accountLink", ticket: "bad" })).result).toMatchObject({ status: "refused" });
    expect(t.config().account).toBeUndefined();
    for (const fields of [
      { kind: "accountLink", ticket: "T", extra: 1 },
      { kind: "accountLink", ticket: "x".repeat(513) },
      { kind: "accountLink", ticket: "" },
      { kind: "accountLink", ticket: 5 },
      { kind: "accountLink" },
    ]) {
      expect((await t.run(fields)).result).toMatchObject({ status: "refused" });
    }
    const nonce = "n".repeat(32);
    const config = t.config();
    const ok = await t.bridge.handleCommand(config, "a", {
      ...(() => {
        const box = seal(t.payload.k, { v: 1, kind: "accountLink", ticket: "T", nonce, expiresAt: NOW + 60_000 });
        return { box };
      })(),
    } as ChannelDoc);
    expect(ok.write).toBe(false); // unsigned
  });

  it("refuses when the channel is on Firebase or the relay is absent", async () => {
    for (const t of [await setup({ location: FIREBASE }), await setup({ relay: null })]) {
      expect((await t.run({ kind: "accountLink", ticket: "T" })).result).toMatchObject({ status: "refused" });
      expect(t.config().account).toBeUndefined();
      expect(t.bridge.phoneView().account).toBeUndefined();
    }
  });

  it("unlinks by signed command and by the control path, clearing the config", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T1" });
    expect((await t.run({ kind: "accountUnlink", extra: 1 })).result).toMatchObject({ status: "refused" });
    expect((await t.run({ kind: "accountUnlink" })).result).toEqual({ id: "c1", status: "sent" });
    expect(t.relay!.unlink).toHaveBeenCalledWith(t.payload.c);
    expect(t.config().account).toBeUndefined();
    await t.run({ kind: "accountLink", ticket: "T2" });
    expect(await t.bridge.unlinkAccount()).toEqual({ ok: true });
    expect(t.bridge.accountState()).toMatchObject({ linked: false });
  });

  it("keeps the link when the relay will not unlink", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T1" });
    t.relay!.unlink.mockRejectedValueOnce(new Error("down"));
    expect(await t.bridge.unlinkAccount()).toMatchObject({ ok: false });
    expect(t.bridge.accountState().linked).toBe(true);
  });
});

describe("web accounts: device requests", () => {
  const putReq = (t: Awaited<ReturnType<typeof setup>>, id: string, over: Record<string, unknown> = {}) => {
    const r = t.request(id, over);
    t.relay!.docs.set(`${t.channel}/devreqs/${id}`, r.doc);
    return r;
  };

  it("lists a valid request as pending, without the pairing window, with the QR derivation's code", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    t.bridge.setAccountSettings({ askOwnDevices: true });
    const r = putReq(t, "r1");
    await t.bridge.tick();
    const status = t.bridge.status() as { pending: Array<Record<string, unknown>>; pairingOpen: boolean };
    expect(status.pairingOpen).toBe(true); // the window of setup; the request needs none (see below)
    expect(status.pending).toEqual([
      expect.objectContaining({
        id: "r1",
        name: "Chrome",
        code: pairingCode(r.web.x963),
        via: "account",
        email: "o@example.com",
      }),
    ]);
  });

  it("reads requests with the pairing window closed", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    t.bridge.setAccountSettings({ askOwnDevices: true });
    t.advance(60 * 60_000);
    putReq(t, "r1", { at: NOW + 60 * 60_000 });
    await t.bridge.tick();
    expect((t.bridge.status() as { pairingOpen: boolean }).pairingOpen).toBe(false);
    expect((t.bridge.status() as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("drops another user's, an expired and a malformed request, and ignores all when unlinked", async () => {
    const t = await setup();
    putReq(t, "r0");
    await t.bridge.tick();
    expect((t.bridge.status() as { pending: unknown[] }).pending).toHaveLength(0);
    expect(t.relay!.docs.has(`${t.channel}/devreqs/r0`)).toBe(true); // unlinked: untouched

    await t.run({ kind: "accountLink", ticket: "T" });
    t.bridge.setAccountSettings({ askOwnDevices: true });
    putReq(t, "other", { userId: "u2" });
    putReq(t, "old", { at: NOW - 11 * 60_000 });
    putReq(t, "badpk", { publicKey: Buffer.alloc(65, 1).toString("base64") });
    putReq(t, "badbox", { boxKey: "AAAA" });
    putReq(t, "noname", { name: "" });
    t.relay!.docs.set(`${t.channel}/devreqs/junk`, { hello: 1 });
    putReq(t, "mismatch", { reqId: "someone-else" });
    await t.bridge.tick();
    expect((t.bridge.status() as { pending: unknown[] }).pending).toHaveLength(1); // r0, now valid for u1
    for (const id of ["other", "old", "badpk", "badbox", "noname", "junk", "mismatch"]) {
      expect(t.relay!.docs.has(`${t.channel}/devreqs/${id}`)).toBe(false);
    }
  });

  it("approve adds the device and seals the exact QR payload to the request's boxKey", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    t.bridge.setAccountSettings({ askOwnDevices: true });
    const r = putReq(t, "r1");
    await t.bridge.tick();
    expect(await t.bridge.approve("r1")).toBe(true);
    expect(t.config().devices.find((d: { id: string }) => d.id === "r1")).toMatchObject({
      name: "Chrome",
      publicKey: r.web.x963,
      via: "account",
    });
    const answer = t.relay!.docs.get(`${t.channel}/devresults/r1`) as { box: string };
    const opened = openFromMember<Record<string, unknown>>(r.box.privateKey, answer.box);
    const qr = JSON.parse(
      Buffer.from(new URL(t.bridge.startPairing().url).searchParams.get("d")!, "base64url").toString(),
    );
    expect(opened).toEqual(qr);
    expect(opened).toMatchObject({
      v: 1,
      c: t.payload.c,
      k: t.payload.k,
      n: "Test Mac",
      cu: CATALYST.relayUrl,
      ck: CATALYST.relayKey,
    });
    expect(opened).not.toHaveProperty("p");
    expect(t.relay!.docs.has(`${t.channel}/devreqs/r1`)).toBe(false);
  });

  it("reject writes denied and deletes the request", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    t.bridge.setAccountSettings({ askOwnDevices: true });
    putReq(t, "r1");
    await t.bridge.tick();
    expect(await t.bridge.reject("r1")).toBe(true);
    expect(t.relay!.docs.get(`${t.channel}/devresults/r1`)).toEqual({ denied: true });
    expect(t.relay!.docs.has(`${t.channel}/devreqs/r1`)).toBe(false);
    expect(t.config().devices.some((d: { id: string }) => d.id === "r1")).toBe(false);
  });

  it("forgets pending account requests on unlink", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    t.bridge.setAccountSettings({ askOwnDevices: true });
    putReq(t, "r1");
    await t.bridge.tick();
    await t.bridge.unlinkAccount();
    expect((t.bridge.status() as { pending: unknown[] }).pending).toHaveLength(0);
  });
});

describe("web accounts: the owner's own devices", () => {
  const putReq = (t: Awaited<ReturnType<typeof setup>>, id: string, over: Record<string, unknown> = {}) => {
    const r = t.request(id, over);
    t.relay!.docs.set(`${t.channel}/devreqs/${id}`, r.doc);
    return r;
  };

  it("adds a same-account device without a code, tells at once, and marks it", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    const r = putReq(t, "r1");
    await t.bridge.tick();
    const status = t.bridge.status() as {
      pending: unknown[];
      devices: Array<Record<string, unknown>>;
      activity: Array<{ device: string; detail: string }>;
    };
    expect(status.pending).toHaveLength(0);
    expect(status.devices.find((d) => d.id === "r1")).toMatchObject({ via: "account", addedAutomatically: true });
    expect(status.devices.find((d) => d.id === "iphone-1")).not.toHaveProperty("via");
    expect(t.config().devices.find((d: { id: string }) => d.id === "r1")).toMatchObject({
      via: "account",
      addedAutomatically: true,
    });
    const answer = t.relay!.docs.get(`${t.channel}/devresults/r1`) as { box: string };
    const opened = openFromMember<Record<string, unknown>>(r.box.privateKey, answer.box);
    expect(opened).toMatchObject({ v: 1, c: t.payload.c, k: t.payload.k });
    expect(t.relay!.docs.has(`${t.channel}/devreqs/r1`)).toBe(false);
    expect(status.activity.some((a) => a.device === "Chrome" && a.detail.includes("o@example.com"))).toBe(true);
    expect(t.added).toEqual([
      {
        name: "Chrome",
        email: "o@example.com",
        text: "New device added: Chrome (signed in as o@example.com). Not you? Revoke it in Squeak › Settings › Channels.",
      },
    ]);
  });

  it("holds it with the code when the owner asks first, and clears the setting on unlink", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    expect(t.bridge.accountState()).toMatchObject({ linked: true, askOwnDevices: false });
    expect(t.bridge.setAccountSettings({ askOwnDevices: true })).toEqual({ ok: true });
    expect(t.bridge.accountState()).toMatchObject({ askOwnDevices: true });
    putReq(t, "r1");
    await t.bridge.tick();
    expect((t.bridge.status() as { pending: unknown[] }).pending).toHaveLength(1);
    expect(t.added).toHaveLength(0);
    await t.run({ kind: "accountUnlink" });
    await t.run({ kind: "accountLink", ticket: "T" });
    expect(t.bridge.accountState()).toMatchObject({ askOwnDevices: false });
  });

  it("still drops another account's request, and the settings are strict", async () => {
    const t = await setup();
    await t.run({ kind: "accountLink", ticket: "T" });
    putReq(t, "x", { userId: "u2" });
    await t.bridge.tick();
    expect(t.config().devices.some((d: { id: string }) => d.id === "x")).toBe(false);
    expect(t.added).toHaveLength(0);
    expect(t.relay!.docs.has(`${t.channel}/devreqs/x`)).toBe(false);
    for (const bad of [null, {}, { askOwnDevices: "yes" }, { askOwnDevices: true, extra: 1 }, [true], { other: true }])
      expect(t.bridge.setAccountSettings(bad).ok).toBe(false);
    expect(t.bridge.accountState().askOwnDevices).toBe(false);
  });
});

describe("web accounts: the Mac app's link route", () => {
  it("links from a ticket through the same path, and says why when it cannot", async () => {
    const t = await setup();
    expect(await t.bridge.linkAccountFromTicket("T1")).toEqual({ ok: true, email: "o@example.com" });
    expect(t.relay!.link).toHaveBeenCalledWith("T1", t.payload.c, "Test Mac");
    expect(t.config().account).toMatchObject({ userId: "u1", email: "o@example.com" });
    for (const bad of ["", "x".repeat(513), 5, undefined]) {
      expect(await t.bridge.linkAccountFromTicket(bad)).toMatchObject({ ok: false });
    }
    t.relay!.link.mockRejectedValueOnce(new AccountTicketError());
    expect(await t.bridge.linkAccountFromTicket("T2")).toEqual({
      ok: false,
      reason: "That sign-in expired. Sign in again.",
    });
    t.relay!.link.mockRejectedValueOnce(new Error("down"));
    expect(await t.bridge.linkAccountFromTicket("T3")).toMatchObject({ ok: false });
  });

  it("refuses without Catalyst, and makes the channel when there is none yet", async () => {
    const firebase = await setup({ location: FIREBASE });
    expect(await firebase.bridge.linkAccountFromTicket("T")).toEqual({
      ok: false,
      reason: "Squeak isn't set up for the cloud yet.",
    });
    expect(firebase.bridge.accountState()).toEqual({ linked: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-account-"));
    dirs.push(dir);
    const relay = new FakeRelay();
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store: new MemoryStore(),
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      location: () => CATALYST,
      accountRelay: () => relay,
      macName: "Fresh Mac",
      now: () => NOW,
    });
    expect(await bridge.linkAccountFromTicket("T")).toEqual({ ok: true, email: "o@example.com" });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    expect(relay.link).toHaveBeenCalledWith("T", saved.channelId, "Fresh Mac");
  });
});
