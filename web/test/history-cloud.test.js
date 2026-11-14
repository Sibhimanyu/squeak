import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { importChannelKey, open } from "../js/channel-crypto.js";
import { liveHandle } from "../js/live.js";
import { cloudPagesToRead, mergeCloud, readCloudIndex, readCloudPage } from "../js/history-cache.js";

// The fixture is the Mac's own output (scripts/make-history-cloud-fixture.ts, src/remote/history-cloud.ts).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/history-cloud.json", import.meta.url), "utf8"));

const id = (n) => String(1000 + n * 3);
const entry = (n) => ({ id: id(n), role: n % 2 ? "assistant" : "user", text: `message ${n}`, at: null });
const range = (from, to) => Array.from({ length: to - from }, (_, i) => entry(from + i));
const page = (from, to) => ({ first: id(from), entries: range(from, to) });
const chat = (pages, newest, complete = false) => ({
  key: "k",
  pages: pages.map(([from]) => ({ f: id(from), t: 0 })),
  newest: id(newest),
  complete,
});

describe("history in the cloud (web)", () => {
  it("opens what the Mac sealed: the index, then every page by handle and first-entry id", async () => {
    const key = await importChannelKey(fixture.key);
    const index = readCloudIndex(await open(key, fixture.indexBox));
    const chatIndex = index.chats.find((c) => c.key === fixture.chatKey);
    expect(chatIndex.pages.map((p) => p.f)).toEqual(["1000", "1150", "1300"]);
    expect(chatIndex.newest).toBe("1357");
    expect(chatIndex.complete).toBe(true);
    const handle = await liveHandle(fixture.chatKey);
    expect(handle).toHaveLength(22);
    const all = [];
    for (const ref of chatIndex.pages) {
      const sealed = await open(key, fixture.pages[ref.f]);
      const read = readCloudPage(sealed, fixture.chatKey, ref.f);
      expect(read.entries[0].id).toBe(ref.f);
      all.push(...read.entries);
    }
    expect(all).toHaveLength(120);
    expect(all.at(-1).text).toBe("message 119");
    // a page for another chat or another first entry is refused
    const sealed = await open(key, fixture.pages["1000"]);
    expect(readCloudPage(sealed, "other", "1000")).toBeNull();
    expect(readCloudPage(sealed, fixture.chatKey, "1150")).toBeNull();
  });

  it("refuses an index that is not v1", () => {
    expect(readCloudIndex(null)).toBeNull();
    expect(readCloudIndex({ v: 2, chats: [] })).toBeNull();
    expect(readCloudIndex({ v: 1, chats: [{ key: 1 }] }).chats).toEqual([]);
  });

  it("a new browser reads every page and lands the whole chat", () => {
    const c = chat([[0], [50], [100]], 119, true);
    expect(cloudPagesToRead([], c)).toHaveLength(3);
    const merged = mergeCloud([], [page(0, 50), page(50, 100), page(100, 120)]);
    expect(merged.changed).toBe(true);
    expect(merged.history).toHaveLength(120);
  });

  it("a held chat reads from the page holding its newest entry, and merges without repeats", () => {
    const c = chat([[0], [50], [100]], 119);
    const held = range(0, 60);
    expect(cloudPagesToRead(held, c).map((p) => p.f)).toEqual([id(50), id(100)]);
    const merged = mergeCloud(held, [page(50, 100), page(100, 120)]);
    expect(merged.history.map((e) => e.id)).toEqual(range(0, 120).map((e) => e.id));
    // again: nothing changes
    expect(mergeCloud(merged.history, [page(50, 100), page(100, 120)]).changed).toBe(false);
  });

  it("a copy that is not newer than what is held is ignored (the browser read the Mac live since)", () => {
    const c = chat([[0], [50], [100]], 119);
    expect(cloudPagesToRead(range(0, 120), c)).toEqual([]);
    expect(cloudPagesToRead(range(0, 125), c)).toEqual([]);
    const held = range(0, 125);
    const merged = mergeCloud(held, [page(100, 120)]);
    expect(merged.changed).toBe(false);
    expect(merged.history).toBe(held);
  });

  it("when the Mac wakes its delta continues from the newest entry with no duplicates", () => {
    const merged = mergeCloud(range(0, 60), [page(50, 100), page(100, 120)]).history;
    expect(merged.at(-1).id).toBe(id(119));
    const after = [...merged, ...range(120, 123)];
    expect(new Set(after.map((e) => e.id)).size).toBe(123);
  });
});
