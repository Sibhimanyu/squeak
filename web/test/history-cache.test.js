import { describe, expect, it } from "vitest";

import { KeyStore } from "../js/key-store.js";
import { CAPABILITIES } from "../js/channel-crypto.js";
import { shape } from "../js/command-shapes.js";
import { applyDelta, HistoryCache, MAX_CACHED_ENTRIES, newestCursor, readDelta } from "../js/history-cache.js";
import { fakeIndexedDB } from "./helpers.js";

function memoryKv() {
  const data = new Map();
  return {
    data,
    read: async (name) => data.get(name) ?? null,
    write: async (name, value) => void data.set(name, value),
    delete: async (name) => void data.delete(name),
  };
}
const timers = { setTimeout: () => 0, clearTimeout: () => undefined };
const entries = (from, to, prefix = "m") =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: String(from + i),
    role: "user",
    text: `${prefix}${from + i}`,
    at: null,
  }));
const cache = (kv, options = {}) => new HistoryCache(kv, { timers, ...options });
const chatRecords = (kv) => [...kv.data.entries()].filter(([name]) => name.startsWith("hc:c:"));

describe("HistoryCache", () => {
  it("round-trips a chat across instances and reads the newest cursor", async () => {
    const kv = memoryKv();
    const a = cache(kv);
    a.record(entries(1, 4), "chat-1");
    await a.flush();
    const b = cache(kv);
    const all = await b.load();
    expect(all["chat-1"]).toEqual(entries(1, 4));
    expect(await b.get("chat-1")).toEqual(entries(1, 4));
    expect(await b.get("nope")).toBeNull();
    expect(newestCursor(all["chat-1"])).toBe("4");
  });

  it("keeps no plaintext in storage and cannot be read with another key", async () => {
    const kv = memoryKv();
    const a = cache(kv);
    a.record(entries(1, 3, "SECRET-WORDS-"), "claude-transcript:very-private");
    await a.flush();
    const names = [...kv.data.keys()].join("");
    expect(names).not.toContain("very-private");
    const [[, record]] = chatRecords(kv);
    expect(Buffer.from(record.ct).includes(Buffer.from("SECRET-WORDS"))).toBe(false);
    expect(JSON.stringify(kv.data.get("hc:index"))).not.toContain("very-private");
    const other = memoryKv();
    for (const [name, value] of kv.data) if (name !== "hc:key") other.data.set(name, value);
    expect(await cache(other).get("claude-transcript:very-private")).toBeNull();
  });

  it("evicts the least recently opened by chat count", async () => {
    const kv = memoryKv();
    let t = 0;
    const a = cache(kv, { maxChats: 3, now: () => ++t });
    for (const k of ["c0", "c1", "c2"]) {
      a.record(entries(1, 2), k);
      await a.flush();
    }
    await a.load(); // index from storage
    await a.get("c0"); // opened last, so c1 is the oldest
    a.record(entries(1, 2), "c3");
    await a.flush();
    const b = cache(kv, { maxChats: 3 });
    await b.load();
    expect(await b.get("c1")).toBeNull();
    for (const k of ["c0", "c2", "c3"]) expect(await b.get(k)).not.toBeNull();
    expect(chatRecords(kv)).toHaveLength(3);
  });

  it("evicts by bytes, oldest first", async () => {
    const kv = memoryKv();
    let t = 0;
    const big = Array.from({ length: 40 }, (_, i) => ({
      id: String(i + 1),
      role: "user",
      text: "x".repeat(2000),
      at: null,
    }));
    const a = cache(kv, { maxBytes: 200_000, now: () => ++t });
    for (const k of ["c0", "c1", "c2"]) {
      a.record(big, k);
      await a.flush();
    }
    const b = cache(kv);
    expect(await b.get("c0")).toBeNull();
    expect(await b.get("c2")).not.toBeNull();
  });

  it("wipe removes every chat and the key; nothing is written after dispose", async () => {
    const kv = memoryKv();
    const a = cache(kv);
    a.record(entries(1, 2), "k");
    await a.flush();
    await a.wipe();
    expect([...kv.data.keys()]).toEqual([]);
    await a.dispose();
    a.record(entries(1, 2), "k");
    await a.flush();
    expect([...kv.data.keys()]).toEqual([]);
  });

  it("drops the old plaintext cache on load and caps entries per chat", async () => {
    const kv = memoryKv();
    kv.data.set("history", { v: 1, chats: [{ key: "old", at: 1, history: entries(1, 2) }] });
    const a = cache(kv);
    await a.load();
    expect(kv.data.has("history")).toBe(false);
    a.record(entries(1, MAX_CACHED_ENTRIES + 20), "big");
    await a.flush();
    expect((await a.get("big")).length).toBe(MAX_CACHED_ENTRIES);
  });

  it("KeyStore.delete deletes one value and leaves the rest", async () => {
    const store = new KeyStore(fakeIndexedDB());
    await store.write("a", { n: 1 });
    await store.write("b", { n: 2 });
    await store.delete("a");
    expect(await store.read("a")).toBeNull();
    expect(await store.read("b")).toEqual({ n: 2 });
  });
});

describe("delta merge", () => {
  it("appends only what is new, and tells when the Mac has more", () => {
    const held = entries(1, 5);
    const merged = applyDelta(held, { entries: entries(5, 8), nextAfter: null, reset: false });
    expect(merged.history.map((e) => e.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(merged.more).toBe(false);
    expect(applyDelta(held, { entries: entries(6, 55), nextAfter: "55", reset: false }).more).toBe(true);
    expect(applyDelta(held, { entries: [], nextAfter: null, reset: false }).history).toEqual(held);
  });

  it("a reset page replaces the tail from where it overlaps, else everything", () => {
    expect(
      applyDelta(entries(1, 10), { entries: entries(8, 12), nextAfter: null, reset: true }).history.map((e) => e.id),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    expect(applyDelta(entries(1, 5), { entries: entries(100, 103), nextAfter: null, reset: true }).history).toEqual(
      entries(100, 103),
    );
  });

  it("reads a delta document only for the chat and cursor asked", () => {
    const doc = {
      v: 1,
      key: "k",
      after: "7",
      entries: [...entries(8, 9), { role: "x", text: "no" }],
      nextAfter: null,
      reset: false,
    };
    expect(readDelta(doc, "k", "7").entries).toHaveLength(2);
    expect(readDelta(doc, "other", "7")).toBeNull();
    expect(readDelta(doc, "k", "8")).toBeNull();
    expect(newestCursor([{ role: "user", text: "x", at: null }])).toBeNull();
  });

  it("names the cap, and the command takes after only as digits and never with before", () => {
    expect(CAPABILITIES).toContain("histdelta");
    expect(shape("history", { key: "k", after: "12", n: 500 })).toEqual({ key: "k", after: "12", n: 50 });
    expect(() => shape("history", { key: "k", after: "1x" })).toThrow();
    expect(() => shape("history", { key: "k", after: "1", before: "2" })).toThrow();
    expect(shape("history", { key: "k", before: "5", n: 99 })).toEqual({ key: "k", before: "5", n: 12 });
  });
});

describe("the chat cache per Mac", () => {
  it("keeps each Mac's chat records apart and removes only the removed Mac's", async () => {
    const idb = fakeIndexedDB();
    const store = new KeyStore(idb);
    await store.save({ state: "paired", macId: "mA", deviceId: "d1" });
    await store.write("hc:index", { for: "A" });
    await store.write("hc:c:abc", { chat: "A" });
    await store.save({ state: "paired", macId: "mB", deviceId: "d2" });
    expect(await store.read("hc:index")).toBeNull();
    await store.write("hc:index", { for: "B" });
    await store.write("hc:c:abc", { chat: "B" });
    await store.activate("mA");
    expect(await store.read("hc:c:abc")).toEqual({ chat: "A" });
    await store.remove("mA");
    const data = idb.databases.get("squeak-web");
    expect(data.has("mA/hc:index")).toBe(false);
    expect(data.has("mA/hc:c:abc")).toBe(false);
    expect(await store.read("hc:index")).toEqual({ for: "B" });
    expect(await store.read("hc:c:abc")).toEqual({ chat: "B" });
  });
});
