import { describe, expect, it } from "vitest";

import { CatalystDb } from "../js/catalyst-db.js";
import { chooseEntry, GUEST_PENDING, GUEST_RECORD } from "../js/entry.js";
import { RECORD } from "../js/guest-pond.js";
import { KeyStore } from "../js/key-store.js";
import { parsePairingLink } from "../js/pairing-link.js";
import { PENDING } from "../js/guest.js";
import { beginPairing, channelFor } from "../js/pairing.js";
import { RtdbClient } from "../js/rtdb.js";
import { fakeRelay, KEY, RELAY_URL } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

const key = Buffer.alloc(32, 5).toString("base64");
const CHANNEL = "p1pYhre8xC41Wr3hbYtgCg";
const link = (payload) => `squeak://pair?d=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
const catalyst = { v: 1, c: CHANNEL, k: key, n: "Sibhi's Mac", cu: RELAY_URL, ck: KEY };

describe("a Catalyst pairing link", () => {
  it("reads the relay and its key, with no Firebase project", () => {
    expect(parsePairingLink(link(catalyst))).toEqual({
      provider: "catalyst",
      project: "",
      channelId: CHANNEL,
      key,
      macName: "Sibhi's Mac",
      databaseUrl: null,
      relayUrl: RELAY_URL,
      relayKey: KEY,
    });
  });

  it("refuses a relay off Catalyst, a half pair, or a bad key", () => {
    for (const bad of [
      { ...catalyst, cu: "https://evil.example/server/squeak_relay" },
      { ...catalyst, cu: "https://squeak.catalystserverless.in.evil.example/x" },
      { ...catalyst, cu: "http://squeak.catalystserverless.in/server/squeak_relay" },
      { ...catalyst, cu: "https://u:p@squeak.catalystserverless.in/x" },
      { ...catalyst, cu: "https://squeak.catalystserverless.in:8443/x" },
      { ...catalyst, ck: "short" },
      { ...catalyst, ck: undefined },
      { ...catalyst, cu: undefined },
    ]) {
      expect(() => parsePairingLink(link(bad)), JSON.stringify(bad)).toThrow();
    }
  });

  it("still needs a project for a Firebase code", () => {
    expect(() => parsePairingLink(link({ v: 1, c: CHANNEL, k: key, n: "x" }))).toThrow();
  });
});

describe("CatalystDb over the real relay handler", () => {
  it("gets, sets and deletes documents with the relay key, and reads a missing one as null", async () => {
    const relay = fakeRelay();
    const db = new CatalystDb({ baseUrl: RELAY_URL, key: KEY, fetch: relay.fetch });
    const path = `channels/${CHANNEL}/state/snapshot`;
    expect(await db.get(path)).toBeNull();
    await db.set(path, { box: "sealed" });
    expect(await db.get(path)).toEqual({ box: "sealed" });
    expect(relay.requests.every((r) => r.headers["x-squeak-relay"] === KEY)).toBe(true);
    expect(relay.published.length).toBeGreaterThan(0);
    await db.delete(path);
    expect(await db.get(path)).toBeNull();
  });

  it("refuses a relay it should not talk to", () => {
    expect(() => new CatalystDb({ baseUrl: "https://evil.example/x", key: KEY })).toThrow();
    expect(() => new CatalystDb({ baseUrl: RELAY_URL, key: "no" })).toThrow();
  });

  it("wakes listeners on open and on a notice, and says dropped when the socket closes", async () => {
    const relay = fakeRelay();
    const sockets = [];
    const socket = (url) => {
      const s = { url, sent: [], send: (t) => s.sent.push(t), close() {} };
      sockets.push(s);
      setTimeout(() => s.onmessage({ data: JSON.stringify([{ mtype: "0" }]) }), 0);
      return s;
    };
    const db = new CatalystDb({
      baseUrl: RELAY_URL,
      key: KEY,
      fetch: relay.fetch,
      socket,
      retryMinMs: 5,
      retryMaxMs: 5,
    });
    const events = [];
    const stop = db.watch("channels/x/state", (e) => events.push(e.kind));
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets[0].url).toContain("wss://in1-dms.zoho.in/wsconnect");
    expect(events).toContain("open");
    expect(events).toContain("change");
    const before = events.length;
    sockets[0].onmessage({ data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { streamingId: "9" } } }) });
    expect(events.length).toBeGreaterThan(before);
    expect(JSON.parse(sockets[0].sent.at(-1))).toEqual({ type: "ack", streamingId: "9" });
    sockets[0].onclose();
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toContain("dropped");
    expect(sockets.length).toBeGreaterThan(1);
    stop();
  });
});

describe("pairing on a Catalyst Mac", () => {
  it("saves the provider, relay and key with the pending device, and writes the sealed request through the relay", async () => {
    const relay = fakeRelay();
    const store = new KeyStore(fakeIndexedDB());
    const { record, channel } = await beginPairing(link(catalyst), {
      store,
      name: "Web · Chrome",
      fetchImpl: relay.fetch,
    });
    expect(channel.db).toBeInstanceOf(CatalystDb);
    const saved = await store.load();
    expect(saved).toMatchObject({ state: "pending", provider: "catalyst", relayUrl: RELAY_URL, relayKey: KEY });
    expect(saved.deviceId).toBe(record.deviceId);
    expect(
      await relay
        .fetch(`${RELAY_URL}/doc?path=${encodeURIComponent(`channels/${CHANNEL}/pairing/${record.deviceId}`)}`, {
          headers: { "x-squeak-relay": KEY },
        })
        .then((r) => r.status),
    ).toBe(200);
  });

  it("loads a record from before Catalyst (no provider) as a Firebase one", async () => {
    const store = new KeyStore(fakeIndexedDB());
    await store.save({
      state: "paired",
      deviceId: "d".repeat(22),
      channelId: CHANNEL,
      project: "squeak-5c9gvo",
      databaseUrl: "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app",
      macName: "Mac",
      channelKey: null,
    });
    const record = await store.load();
    expect(record.provider).toBeUndefined();
    expect(channelFor(record).db).toBeInstanceOf(RtdbClient);
  });
});

describe("the entry page's routing", () => {
  const vault = (records = {}) => ({
    load: async () => records.device ?? null,
    read: async (name) => records[name] ?? null,
  });

  it("names the same guest records the guest page keeps", () => {
    expect(GUEST_RECORD).toBe(RECORD);
    expect(GUEST_PENDING).toBe(PENDING);
  });

  it("sends an invite fragment to the guest page, even with a device stored", async () => {
    expect(await chooseEntry({ hash: "#eyJ2IjoxfQ", vault: vault({ device: { state: "paired" } }) })).toBe("guest");
  });

  it("sends a pair fragment, a stored device, and an empty browser to the owner app", async () => {
    expect(await chooseEntry({ hash: "#pair=abc", vault: vault() })).toBe("owner");
    expect(await chooseEntry({ hash: "", vault: vault({ device: { state: "paired" } }) })).toBe("owner");
    expect(await chooseEntry({ hash: "", vault: vault() })).toBe("owner");
    expect(await chooseEntry({ hash: "#", vault: vault() })).toBe("owner");
  });

  it("returns a guest's browser to the guest page when it holds only guest records", async () => {
    expect(await chooseEntry({ hash: "", vault: vault({ guest: { status: "active" } }) })).toBe("guest");
    expect(await chooseEntry({ hash: "", vault: vault({ "pending-invite": { pondId: "p" } }) })).toBe("guest");
  });

  it("falls to the owner app when storage fails", async () => {
    const broken = { load: async () => Promise.reject(new Error("no")), read: async () => null };
    expect(await chooseEntry({ hash: "", vault: broken })).toBe("owner");
  });
});
