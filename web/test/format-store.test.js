import { describe, expect, it } from "vitest";

import { ago, canReply, describeResult, groups, heading, stateWord } from "../js/format.js";
import { KeyStore, macKey } from "../js/key-store.js";
import { generateDeviceKey, importChannelKey, sign } from "../js/channel-crypto.js";
import { fakeIndexedDB } from "./helpers.js";

describe("words", () => {
  it("uses DESIGN.md's vocabulary", () => {
    expect(["awaiting_approval", "awaiting_input", "working", "finished", "error", "idle", "?"].map(stateWord)).toEqual(
      ["needs approval", "needs an answer", "working", "done", "error", "idle", "idle"],
    );
  });

  it("lets a reply go only to a Conductor chat that is not blocked inside Conductor", () => {
    expect(canReply({ conductorSessionId: "s", state: "finished" })).toBe(true);
    expect(canReply({ conductorSessionId: "s", state: "working" })).toBe(true);
    expect(canReply({ conductorSessionId: "s", state: "awaiting_input" })).toBe(false);
    expect(canReply({ conductorSessionId: null, state: "finished" })).toBe(false);
    expect(canReply({ state: "finished" })).toBe(false);
  });

  it("heads a row with the chat's own title, else its label", () => {
    expect(heading({ title: "T", label: "L" })).toBe("T");
    expect(heading({ label: "L" })).toBe("L");
  });

  it("says how long ago, shortly", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(ago("2026-10-21T11:59:50Z", now)).toBe("now");
    expect(ago("2026-10-21T11:55:00Z", now)).toBe("5m");
    expect(ago("2026-10-21T09:00:00Z", now)).toBe("3h");
    expect(ago("2026-10-18T12:00:00Z", now)).toBe("3d");
    expect(ago("nonsense", now)).toBe("");
  });

  it("describes what the Mac answered, worded as the iPhone words it", () => {
    expect(describeResult({ status: "sent", delivery: "queued" }, "Claude")).toEqual({
      ok: true,
      retry: false,
      text: "Queued · Claude reads it after this turn",
    });
    expect(describeResult({ status: "sent", delivery: "steered" })).toMatchObject({
      ok: true,
      text: "Steered into the current turn",
    });
    expect(describeResult({ status: "sent" })).toEqual({ ok: true, retry: false, text: "Sent" });
    expect(describeResult({ status: "answered" })).toEqual({ ok: true, retry: false, text: "Sent" });
    expect(describeResult({ status: "refused", reason: "that chat has moved on" })).toEqual({
      ok: false,
      retry: true,
      text: "Not sent. Nothing started. That chat has moved on.",
    });
    expect(describeResult({ status: "refused" }).text).toBe("Not sent. Nothing started. Your Mac refused that reply.");
    expect(describeResult({ status: "withdrawn" })).toMatchObject({ ok: false, retry: true });
    expect(describeResult({ status: "withdrawn" }).text).toMatch(
      /^Not sent\. Nothing started\. Your Mac didn't pick it up/,
    );
  });

  it("never reads unconfirmed, unknown or garbage as sent, and never offers to send again", () => {
    const couldnt = {
      ok: false,
      retry: false,
      text: "Couldn't confirm it arrived. Check the chat before sending again.",
    };
    for (const result of [
      { status: "unconfirmed" },
      { status: "unknown" },
      { status: "whatever" },
      { status: 7 },
      {},
      "sent",
      null,
      undefined,
    ]) {
      expect(describeResult(result)).toEqual(couldnt);
    }
  });

  it("lists active sessions, then recent ones not already shown", () => {
    const view = { sessions: [{ key: "a" }], recent: [{ key: "a" }, { key: "b" }] };
    expect(groups(view)).toEqual({ active: [{ key: "a" }], recent: [{ key: "b" }] });
    expect(groups(null)).toEqual({ active: [], recent: [] });
  });
});

describe("KeyStore", () => {
  it("keeps both keys as CryptoKeys that still work, and cannot be read out, after a round trip through IndexedDB", async () => {
    const store = new KeyStore(fakeIndexedDB());
    expect(await store.load()).toBeNull();
    const { privateKey, publicKeyX963 } = await generateDeviceKey();
    const channelKey = await importChannelKey(Buffer.alloc(32, 1).toString("base64"));
    await store.save({ state: "paired", deviceId: "d", channelKey, signingKey: privateKey, publicKeyX963 });
    const loaded = await store.load();
    expect(loaded.state).toBe("paired");
    expect(loaded.signingKey.extractable).toBe(false);
    expect(loaded.channelKey.extractable).toBe(false);
    expect(Buffer.from(await sign(loaded.signingKey, "m"), "base64")).toHaveLength(64);
  });

  it("forgets everything", async () => {
    const idb = fakeIndexedDB();
    const store = new KeyStore(idb);
    await store.save({ state: "paired" });
    await store.forget();
    expect(idb.databases.size).toBe(0);
    expect(await store.load()).toBeNull();
  });

  it("moves the single record an older version kept into the Mac list, keeping its caches where they were", async () => {
    const idb = fakeIndexedDB();
    const old = new KeyStore(idb);
    await old.write("prefs", { grouping: "chats" });
    // what the older version wrote: one record under "device", caches unprefixed
    idb.databases
      .get("squeak-web")
      .set("device", { state: "paired", channelId: "chanA", macName: "Studio", deviceId: "d1" });
    const store = new KeyStore(idb);
    const all = await store.loadAll();
    expect(Object.keys(all.records)).toEqual(["chanA"]);
    expect(all.active).toBe("chanA");
    expect((await store.load()).macName).toBe("Studio");
    expect(idb.databases.get("squeak-web").get("device")).toBeNull();
    expect(await store.read("prefs")).toEqual({ grouping: "chats" });
    // a second load is stable
    expect(Object.keys((await new KeyStore(idb).loadAll()).records)).toEqual(["chanA"]);
  });

  it("holds several Macs, switches between them with their own caches, and removes one", async () => {
    const idb = fakeIndexedDB();
    const store = new KeyStore(idb);
    await store.save({ state: "paired", macId: "mA", macName: "A", deviceId: "d1" });
    await store.write("prefs", { for: "A" });
    await store.save({ state: "paired", macId: "mB", macName: "B", deviceId: "d2" });
    expect((await store.load()).macName).toBe("B");
    expect(await store.read("prefs")).toBeNull();
    await store.write("prefs", { for: "B" });
    expect(await store.activate("mA")).toBe(true);
    expect(await store.read("prefs")).toEqual({ for: "A" });
    expect(await store.activate("nope")).toBe(false);
    const reopened = new KeyStore(idb);
    expect((await reopened.loadAll()).active).toBe("mA");
    const rest = await store.remove("mA");
    expect(rest.active).toBe("mB");
    expect(Object.keys(rest.records)).toEqual(["mB"]);
    expect(await store.read("prefs")).toEqual({ for: "B" });
    expect(idb.databases.get("squeak-web").get("mA/prefs")).toBeNull();
    const none = await store.remove("mB");
    expect(none.active).toBeNull();
    expect(await store.load()).toBeNull();
    await store.save({ state: "paired", macId: "mC" });
    await store.forget();
    expect(await store.loadAll()).toEqual({ active: null, records: {} });
  });

  it("names a Mac by its account id, else its channel, else its device", () => {
    expect(macKey({ macId: "m", channelId: "c" })).toBe("m");
    expect(macKey({ channelId: "c" })).toBe("c");
    expect(macKey({ deviceId: "d" })).toBe("d");
  });
});
