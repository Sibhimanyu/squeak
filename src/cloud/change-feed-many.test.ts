// A whole page reads several kinds and a relay-owned note: one feed read each time, never older than the call.
import { describe, expect, it } from "vitest";

import { CatalystStore } from "./catalyst-store.js";
import { FeedMirror, type FeedChange } from "./change-feed.js";
import type { ChannelDoc } from "./store.js";

const POND = "p1";
const doc = (box: string): ChannelDoc => ({ box });

function world() {
  const log: string[] = [];
  const feed: FeedChange[] = [];
  const plain: Record<string, Array<{ id: string; doc: ChannelDoc }>> = {};
  let note: unknown = null;
  const mirror = new FeedMirror({
    changes: async (_pond, since) => {
      log.push(`changes ${since}`);
      const head = feed.length;
      if (since === "head") return { changes: [], next: head, more: false };
      return { changes: feed.slice(since), next: head, more: false };
    },
    listPlain: async (c) => {
      log.push(`list ${c}`);
      return [...(plain[c] ?? [])];
    },
    getRaw: async (p) => {
      log.push(`raw ${p}`);
      return note;
    },
  });
  const write = (kind: string, id: string, d: ChannelDoc | null, raw?: unknown) => {
    feed.push({ seq: feed.length + 1, kind, id, doc: d, ...(raw !== undefined ? { raw } : {}) });
  };
  return { mirror, log, write, setNote: (n: unknown) => (note = n) };
}

const WANT = [
  `channels/${POND}/members`,
  `channels/${POND}/room`,
  `channels/${POND}/rtasks`,
  `channels/${POND}/rposts`,
];
const NOTE = `channels/${POND}/roomnote/trim`;

describe("FeedMirror.listMany", () => {
  it("a page already seen is one feed read, and sees what changed since, the note included", async () => {
    const w = world();
    await w.mirror.listMany(WANT, [NOTE]);
    w.log.length = 0;
    const same = await w.mirror.listMany(WANT, [NOTE]);
    expect(w.log).toEqual(["changes 0"]);
    expect(same!.raws).toEqual([null]);
    w.log.length = 0;
    w.write("room", "a", doc("1.a"));
    w.write("members", "m", doc("1.m"));
    w.write("roomnote", "trim", null, { removed: 3, before: 9, at: 5 });
    const next = await w.mirror.listMany(WANT, [NOTE]);
    expect(w.log).toEqual(["changes 0"]);
    expect(next!.lists[0]!.map((r) => r.id)).toEqual(["m"]);
    expect(next!.lists[1]!.map((r) => r.id)).toEqual(["a"]);
    expect(next!.raws).toEqual([{ removed: 3, before: 9, at: 5 }]);
  });

  it("the first read seeds each kind and the note once; a later kind is seeded then, not every time", async () => {
    const w = world();
    w.setNote({ removed: 1 });
    await w.mirror.listMany(WANT.slice(0, 2), [NOTE]);
    expect(w.log.filter((l) => l.startsWith("list") || l.startsWith("raw")).length).toBe(3);
    w.log.length = 0;
    const r = await w.mirror.listMany(WANT, [NOTE]);
    expect(w.log.filter((l) => l.startsWith("list"))).toEqual([`list ${WANT[2]}`, `list ${WANT[3]}`]);
    expect(r!.raws).toEqual([{ removed: 1 }]);
  });

  it("answers null for another Pond's mix or a kind the feed does not carry, so the caller reads one by one", async () => {
    const w = world();
    expect(await w.mirror.listMany([WANT[0]!, "channels/p2/room"])).toBeNull();
    expect(await w.mirror.listMany([`channels/${POND}/devreqs`])).toBeNull();
    expect(w.log).toEqual([]);
  });
});

describe("CatalystStore.readMany", () => {
  it("carries the relay's plain page-out note from the feed, so a page needs no document read", async () => {
    const asked: string[] = [];
    let changes: unknown[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const u = new URL(String(url));
      asked.push(u.pathname.replace(/^.*squeak_relay/, ""));
      if (u.pathname.endsWith("/changes")) {
        return new Response(JSON.stringify({ changes, next: changes.length, more: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [], doc: null }), { status: 200 });
    };
    const store = new CatalystStore({
      baseUrl: "https://relay.test/server/squeak_relay",
      macKey: "k".repeat(43),
      fetch: fetchImpl,
    });
    const note = `channels/${POND}/roomnote/trim`;
    await store.readMany(WANT, [note]);
    changes = [{ seq: 1, kind: "roomnote", id: "trim", doc: { v: 1, removed: 4, before: 7, at: 9 } }];
    asked.length = 0;
    const page = await store.readMany(WANT, [note]);
    expect(asked).toEqual(["/changes"]);
    expect(page!.raws).toEqual([{ v: 1, removed: 4, before: 7, at: 9 }]);
  });
});
