import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "./remote-crypto.js";
import {
  HIST_CHAT_PAGES,
  HIST_INDEX_DOC,
  HIST_PAGE_ENTRIES,
  HIST_RETENTION_MS,
  HistCapError,
  HistoryCloudSync,
  histPageDoc,
  relayHistStore,
  type HistCandidate,
  type HistIndex,
  type HistPage,
  type HistStore,
} from "./history-cloud.js";
import type { TranscriptReader } from "./history-delta.js";
import type { TranscriptMessage } from "../fleet/transcript.js";

const KEY = crypto.randomBytes(32).toString("base64");
const DAY = 24 * 3600_000;

function chat(count: number, atOf: (i: number) => string | null = () => null, start = 1000) {
  const rows: TranscriptMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    cursor: String(start + i * 3),
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `t${i}`,
    at: atOf(i),
    turnId: null,
  }));
  const read: TranscriptReader = (limit, before) => {
    const eligible = rows.filter((m) => before === null || Number(m.cursor) < before);
    const page = eligible.slice(-limit);
    return { messages: page, nextBefore: eligible.length > limit ? page[0]!.cursor! : null };
  };
  return { rows, read };
}

function rig(opts: { now?: number } = {}) {
  const docs = new Map<string, string>();
  const ops: string[] = [];
  const store: HistStore = {
    async get(doc) {
      return docs.get(doc) ?? null;
    },
    async put(doc, box) {
      ops.push(`put ${doc}`);
      docs.set(doc, box);
    },
    async delete(doc) {
      ops.push(`del ${doc}`);
      docs.delete(doc);
    },
  };
  let now = opts.now ?? Date.parse("2026-11-15T12:00:00Z");
  let seq = 0;
  let cands: HistCandidate[] = [];
  const make = () =>
    new HistoryCloudSync({
      store,
      seal: (v) => seal(KEY, v),
      open: <T>(box: string) => open<T>(KEY, box),
      candidates: () => cands,
      now: () => now,
      nextSeq: () => ++seq,
    });
  return {
    docs,
    ops,
    make,
    set: (c: HistCandidate[]) => (cands = c),
    tick: (ms: number) => (now += ms),
    now: () => now,
    index: () => open<HistIndex>(KEY, docs.get(HIST_INDEX_DOC)!),
    page: (key: string, first: string) => open<HistPage>(KEY, docs.get(histPageDoc(key, first))!),
  };
}

const cand = (key: string, read: TranscriptReader, activityAt: number): HistCandidate => ({ key, read, activityAt });

describe("HistoryCloudSync", () => {
  it("uploads a chat as sealed pages named by handle and first-entry cursor, plus an index", async () => {
    const r = rig();
    const c = chat(120);
    r.set([cand("conductor:a", c.read, r.now())]);
    const sync = r.make();
    await sync.run();
    const index = r.index();
    expect(index.chats).toHaveLength(1);
    const entry = index.chats[0]!;
    expect(entry.pages.map((p) => p.f)).toEqual([c.rows[0]!.cursor, c.rows[50]!.cursor, c.rows[100]!.cursor]);
    expect(entry.newest).toBe(c.rows[119]!.cursor);
    expect(entry.complete).toBe(true);
    // sealed: no plaintext in any stored box, and every page opens under the channel key only
    for (const box of r.docs.values()) {
      expect(() => open(crypto.randomBytes(32).toString("base64"), box)).toThrow();
    }
    const page = r.page("conductor:a", c.rows[50]!.cursor!);
    expect(page.entries).toHaveLength(HIST_PAGE_ENTRIES);
    expect(page.entries[0]!.id).toBe(c.rows[50]!.cursor);
    expect(page.key).toBe("conductor:a");
  });

  it("writes only what is new: the tail page grows, finished pages are not touched", async () => {
    const r = rig();
    const c = chat(120);
    const activity = r.now();
    r.set([cand("k", c.read, activity)]);
    const sync = r.make();
    await sync.run();
    r.ops.length = 0;
    // nothing moved: nothing is written
    r.tick(60_000);
    await sync.run();
    expect(r.ops).toEqual([]);
    // 5 entries more: the last page (20 entries) is rewritten with them, nothing else
    for (let i = 0; i < 5; i++)
      c.rows.push({ id: `n${i}`, cursor: String(5000 + i), role: "user", text: `new${i}`, at: null, turnId: null });
    r.set([cand("k", c.read, activity + 1000)]);
    await sync.run();
    expect(r.ops.filter((o) => o.startsWith("put")).sort()).toEqual(
      [`put ${histPageDoc("k", c.rows[100]!.cursor!)}`, `put ${HIST_INDEX_DOC}`].sort(),
    );
    const entry = r.index().chats[0]!;
    expect(entry.newest).toBe("5004");
    expect(r.page("k", c.rows[100]!.cursor!).entries).toHaveLength(25);
    // enough to fill the tail and start a new page: the full page is written once, the next one new
    for (let i = 0; i < 40; i++)
      c.rows.push({ id: `p${i}`, cursor: String(6000 + i), role: "user", text: `more${i}`, at: null, turnId: null });
    r.set([cand("k", c.read, activity + 2000)]);
    await sync.run();
    expect(r.index().chats[0]!.pages).toHaveLength(4);
    expect(r.index().chats[0]!.newest).toBe("6039");
  });

  it("a restarted Mac picks the index up from the cloud and continues without rewriting", async () => {
    const r = rig();
    const c = chat(60);
    const activity = r.now();
    r.set([cand("k", c.read, activity)]);
    await r.make().run();
    r.ops.length = 0;
    await r.make().run();
    expect(r.ops).toEqual([]);
  });

  it("keeps at most HIST_CHAT_PAGES pages of a long chat, newest, and deletes the older ones", async () => {
    const r = rig();
    const c = chat(HIST_CHAT_PAGES * HIST_PAGE_ENTRIES + 90);
    r.set([cand("k", c.read, r.now())]);
    await r.make().run();
    const entry = r.index().chats[0]!;
    expect(entry.pages).toHaveLength(HIST_CHAT_PAGES);
    expect(entry.complete).toBe(false);
    expect(entry.newest).toBe(c.rows.at(-1)!.cursor);
    const docs = [...r.docs.keys()].filter((d) => d !== HIST_INDEX_DOC);
    expect(docs).toHaveLength(HIST_CHAT_PAGES);
  });

  it("deletes a chat's pages when it is archived (no longer a candidate) and the index stops naming it", async () => {
    const r = rig();
    const a = chat(60);
    const b = chat(10, () => null, 9000);
    r.set([cand("a", a.read, r.now()), cand("b", b.read, r.now())]);
    const sync = r.make();
    await sync.run();
    expect(r.docs.size).toBe(1 + 2 + 1);
    r.set([cand("b", b.read, r.now())]);
    r.tick(60_000);
    await sync.run();
    expect(r.index().chats.map((x) => x.key)).toEqual(["b"]);
    expect([...r.docs.keys()].sort()).toEqual([HIST_INDEX_DOC, histPageDoc("b", b.rows[0]!.cursor!)].sort());
    // the index was rewritten before the pages went, so a reader never follows a name to nothing for long
    const i = r.ops.lastIndexOf(`put ${HIST_INDEX_DOC}`);
    expect(r.ops.findIndex((o, n) => n > i && o.startsWith("del"))).toBeGreaterThan(i);
  });

  it("drops chats and pages older than 30 days", async () => {
    const r = rig();
    const old = r.now() - 40 * DAY;
    const c = chat(120, (i) => new Date(i < 60 ? old : r.now()).toISOString(), 1000);
    r.set([cand("k", c.read, r.now())]);
    const sync = r.make();
    await sync.run();
    // the first page ends at entry 49, 40 days old: not kept; the second ends at 99 (mixed): kept by its newest entry
    const entry = r.index().chats[0]!;
    expect(entry.pages.some((p) => p.t > 0 && r.now() - p.t > HIST_RETENTION_MS)).toBe(false);
    expect(entry.complete).toBe(false);
    // a month passes with no activity: the chat leaves the candidates by age and everything is deleted
    r.tick(31 * DAY);
    await sync.run();
    expect(r.index().chats).toEqual([]);
    expect([...r.docs.keys()]).toEqual([HIST_INDEX_DOC]);
  });

  it("turning it off deletes every page and the index", async () => {
    const r = rig();
    const c = chat(120);
    r.set([cand("k", c.read, r.now())]);
    const sync = r.make();
    await sync.run();
    expect(r.docs.size).toBeGreaterThan(3);
    await sync.purge();
    expect(r.docs.size).toBe(0);
    // purge from a fresh Mac that only knows the cloud's index
    r.set([cand("k", c.read, r.now())]);
    await r.make().run();
    expect(r.docs.size).toBeGreaterThan(3);
    await r.make().purge();
    expect(r.docs.size).toBe(0);
  });

  it("limits the work of one run and carries on in the next", async () => {
    const r = rig();
    const many = Array.from({ length: 9 }, (_, i) => cand(`c${i}`, chat(5, () => null, 100 + i).read, r.now() - i));
    r.set(many);
    const sync = r.make();
    const first = await sync.run();
    expect(first?.wrote).toBe(6);
    expect(first?.more).toBe(true);
    const second = await sync.run();
    expect(second?.wrote).toBe(3);
    expect(r.index().chats).toHaveLength(9);
  });

  it("backs off after the account's cap answers, and does not hammer the relay", async () => {
    const r = rig();
    const c = chat(10);
    r.set([cand("k", c.read, r.now())]);
    let full = true;
    const sync = new HistoryCloudSync({
      store: {
        get: async () => null,
        put: async () => {
          if (full) throw new HistCapError("cap");
        },
        delete: async () => undefined,
      },
      seal: (v) => seal(KEY, v),
      open: <T>(box: string) => open<T>(KEY, box),
      candidates: () => [cand("k", c.read, r.now())],
      now: () => r.now(),
      nextSeq: () => 1,
    });
    expect(await sync.run()).toBeNull();
    full = false;
    expect(await sync.run()).toBeNull(); // still inside the hour
    r.tick(3600_001);
    expect((await sync.run())?.wrote).toBe(1);
  });

  it("rebuilds a chat that moved on further than the reader can follow, deleting the old pages", async () => {
    const r = rig();
    const c = chat(30);
    const activity = r.now();
    r.set([cand("k", c.read, activity)]);
    const sync = r.make();
    await sync.run();
    const oldPage = histPageDoc("k", c.rows[0]!.cursor!);
    expect(r.docs.has(oldPage)).toBe(true);
    for (let i = 0; i < 500; i++)
      c.rows.push({
        id: `n${i}`,
        cursor: String(9000 + i),
        role: i % 2 ? "user" : "assistant",
        text: `n${i}`,
        at: null,
        turnId: null,
      });
    r.set([cand("k", c.read, activity + 5000)]);
    r.tick(60_000);
    await sync.run();
    const entry = r.index().chats[0]!;
    expect(entry.newest).toBe("9499");
    expect(entry.pages).toHaveLength(HIST_CHAT_PAGES);
    expect(r.docs.has(oldPage)).toBe(false);
  });
});

describe("relayHistStore", () => {
  it("reads by id, writes and deletes with the write token, registers it, and tells a full account", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    let status = 204;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        ...(init.body ? { body: String(init.body) } : {}),
      });
      if (init.method === "GET") return new Response(JSON.stringify({ doc: { box: "BOX" } }), { status: 200 });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const store = relayHistStore({
      baseUrl: "https://relay.example/",
      key: "MACKEY",
      keyHeader: "x-squeak-mac-key",
      channel: "ch".repeat(12),
      token: "tok",
      fetch: fake,
    });
    expect(await store.get("idx")).toBe("BOX");
    await store.put("p1", "SEALED");
    await store.delete("p1");
    await store.register("old");
    expect(calls[0]!.url).toBe(`https://relay.example/doc?path=channels%2F${"ch".repeat(12)}%2Fhist%2Fidx`);
    expect(calls[1]!.headers["x-squeak-hist"]).toBe("tok");
    expect(calls[1]!.headers["x-squeak-mac-key"]).toBe("MACKEY");
    expect(JSON.parse(calls[1]!.body!).doc.box).toBe("SEALED");
    expect(calls[2]!.method).toBe("DELETE");
    expect(JSON.parse(calls[3]!.body!)).toMatchObject({ token: "tok", previous: "old" });
    status = 413;
    await expect(store.put("p2", "X")).rejects.toBeInstanceOf(HistCapError);
  });
});
