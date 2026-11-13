import { describe, expect, it } from "vitest";
import { Channel } from "../js/channel.js";
import { importChannelKey, seal } from "../js/channel-crypto.js";
import { noticeKind, watchPond } from "../js/guest-relay.js";
import { PROBLEM_AFTER_MS, Sync } from "../js/sync.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A channel whose reads the test controls (as in sync.test.js). */
function fakeChannel() {
  const listeners = new Map();
  let clock = 1_000;
  const channel = {
    now: () => clock,
    advance: (ms) => (clock += ms),
    statePath: "state",
    resultsPath: "results",
    reads: 0,
    fail: false,
    view: async () => {
      channel.reads++;
      if (channel.fail) throw new Error("boom");
      return structuredClone(channel.next);
    },
    alive: async () => ({ at: channel.now() }),
    touchPresence: async () => {},
    next: { v: 1, sessions: [{ key: "a" }], seq: 1 },
    db: {
      watch(path, listener) {
        listeners.set(path, listener);
        return () => listeners.delete(path);
      },
    },
    emit(path, event) {
      listeners.get(path)?.(event);
    },
  };
  return channel;
}

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    fire(ms) {
      for (const [id, t] of [...pending]) {
        if (t.ms === ms) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    has: (ms) => [...pending.values()].some((t) => t.ms === ms),
  };
}

describe("F1: a pass that found nothing new does not redraw", () => {
  it("calls onState once for two identical views, and keeps aliveAt current in place", async () => {
    const channel = fakeChannel();
    let calls = 0;
    const sync = new Sync({ channel, signingKey: null, onState: () => calls++, timers: globalThis });
    sync.start();
    await sleep(120);
    const held = sync.state;
    const firstRev = sync.state.rev;
    const callsAfterFirst = calls;
    channel.advance(5_000);
    sync.wake();
    await sleep(120);
    expect(calls).toBe(callsAfterFirst);
    expect(sync.state.rev).toBe(firstRev);
    // The page holds the old state object: it still reads the newest alive time.
    expect(held.aliveAt).toBe(channel.now());
    channel.next = { v: 1, sessions: [{ key: "a" }, { key: "b" }], seq: 2 };
    sync.wake();
    await sleep(120);
    expect(calls).toBe(callsAfterFirst + 1);
    expect(sync.state.view.sessions).toHaveLength(2);
    sync.stop();
  });
});

describe("F3: own presence echo", () => {
  it("ignores a Catalyst notice that names the presence document", async () => {
    const channel = fakeChannel();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers: globalThis });
    sync.start();
    await sleep(120);
    const before = channel.reads;
    channel.emit("state", { kind: "change", path: "/", doc: "presence" });
    await sleep(120);
    expect(channel.reads).toBe(before);
    channel.emit("state", { kind: "change", path: "/", doc: "snapshot" });
    await sleep(120);
    expect(channel.reads).toBe(before + 1);
    channel.emit("state", { kind: "change", path: "/" });
    await sleep(120);
    expect(channel.reads).toBe(before + 2);
    sync.stop();
  });

  it("reads the document a notice names, tolerating old notices", () => {
    expect(noticeKind(JSON.stringify({ p: "channels/c/state", k: "presence" }))).toBe("presence");
    expect(noticeKind({ t: "x", k: "alive" })).toBe("alive");
    expect(noticeKind(JSON.stringify({ p: "channels/c/state" }))).toBeNull();
    expect(noticeKind("not json")).toBeNull();
    expect(noticeKind(undefined)).toBeNull();
  });
});

describe("F4: a status shows only once a problem has lasted", () => {
  it("one failed pass that the retry heals never sets error", async () => {
    const channel = fakeChannel();
    const timers = manualTimers();
    const states = [];
    const sync = new Sync({ channel, signingKey: null, onState: (s) => states.push(s.error), timers });
    sync.start();
    timers.fire(50);
    await sleep(20);
    channel.fail = true;
    await sync.pass();
    expect(sync.state.error).toBeNull();
    expect(timers.has(1_500)).toBe(true);
    channel.fail = false;
    await sync.pass();
    expect(sync.state.error).toBeNull();
    expect(states.every((e) => e === null)).toBe(true);
    sync.stop();
  });

  it("failing past the threshold shows the error, and the next good pass clears it", async () => {
    const channel = fakeChannel();
    const timers = manualTimers();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    timers.fire(50);
    await sleep(20);
    channel.fail = true;
    await sync.pass();
    channel.advance(PROBLEM_AFTER_MS + 1);
    await sync.pass();
    expect(sync.state.error).toMatch(/Could not reach/);
    channel.fail = false;
    await sync.pass();
    expect(sync.state.error).toBeNull();
    sync.stop();
  });

  it("a dropped stream reads as down only after the wait, and a reconnect inside it never does", async () => {
    const channel = fakeChannel();
    const timers = manualTimers();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    channel.emit("state", { kind: "open" });
    expect(sync.state.streamUp).toBe(true);
    channel.emit("state", { kind: "dropped" });
    expect(sync.state.streamUp).toBe(true);
    channel.emit("state", { kind: "open" });
    timers.fire(PROBLEM_AFTER_MS);
    expect(sync.state.streamUp).toBe(true);
    channel.emit("state", { kind: "dropped" });
    timers.fire(PROBLEM_AFTER_MS);
    expect(sync.state.streamUp).toBe(false);
    sync.stop();
  });
});

describe("F2: a failed read of the recent document keeps the last good one", () => {
  async function rig() {
    const key = await importChannelKey(Buffer.alloc(32, 3).toString("base64"));
    const docs = new Map();
    let failRecent = false;
    const db = {
      get: async (path) => {
        if (path.endsWith("/recent") && failRecent) throw new Error("timeout");
        return docs.get(path) ?? null;
      },
    };
    const channel = new Channel({ channelId: "A".repeat(22), deviceId: "dev-1", key, db });
    const put = async (name, body) => docs.set(channel.path("state", name), { box: await seal(key, body) });
    return { channel, put, failRecent: (on) => (failRecent = on), docs };
  }

  it("does not blank Recent, workspaces or icons when the read fails or finds nothing", async () => {
    const { channel, put, failRecent, docs } = await rig();
    await put("snapshot", { v: 1, split: true, sessions: [], seq: 1 });
    await put("recent", { recent: [{ key: "r1" }], workspaces: [{ id: "w" }], projectIcons: { a: "b" } });
    const first = await channel.view();
    expect(first.recent).toEqual([{ key: "r1" }]);
    failRecent(true);
    const second = await channel.view();
    expect(second.recent).toEqual([{ key: "r1" }]);
    expect(second.workspaces).toEqual([{ id: "w" }]);
    expect(second.projectIcons).toEqual({ a: "b" });
    failRecent(false);
    docs.delete(channel.path("state", "recent"));
    expect((await channel.view()).recent).toEqual([{ key: "r1" }]);
  });

  it("first load with no recent document is still just empty", async () => {
    const { channel, put } = await rig();
    await put("snapshot", { v: 1, split: true, sessions: [], seq: 1 });
    expect((await channel.view()).recent).toBeUndefined();
  });
});

describe("F6: stream reconnect", () => {
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
    }
    send(text) {
      this.sent.push(text);
    }
    close() {}
  }

  it("treats -1 (switch host) as reconnect now, not a failure", async () => {
    const sockets = [];
    const errors = [];
    const watch = watchPond({
      store: { streamToken: async () => ({ url: "in1-dms.zoho.in", key: "k", wssId: "w" }) },
      wake: () => {},
      pollMs: 600_000,
      retryMinMs: 60_000,
      onError: (e) => errors.push(e),
      socket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    while (!sockets[0]) await sleep(5);
    sockets[0].onmessage({ data: JSON.stringify({ mtype: "0" }) });
    sockets[0].onmessage({ data: JSON.stringify({ mtype: "-1" }) });
    while (!sockets[1]) await sleep(5);
    expect(errors).toEqual([]);
    watch.stop();
  });

  it("hands a notice's document to wake", async () => {
    const sockets = [];
    const infos = [];
    const watch = watchPond({
      store: { streamToken: async () => ({ url: "in1-dms.zoho.in", key: "k", wssId: "w" }) },
      wake: (info) => infos.push(info),
      pollMs: 600_000,
      socket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    while (!sockets[0]) await sleep(5);
    sockets[0].onmessage({
      data: JSON.stringify({
        mtype: "650",
        msg: { opr: "event", data: { streamingId: 1, data: JSON.stringify({ p: "channels/c/state", k: "presence" }) } },
      }),
    });
    await sleep(10);
    expect(infos.at(-1)).toEqual({ doc: "presence" });
    watch.stop();
  });
});
