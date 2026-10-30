import { describe, expect, it } from "vitest";

import { CALLS_LEASE_MS, isStale, LATE_RESULT_MS, RESULT_TIMEOUT_MS, Sync } from "../js/sync.js";

/** A channel whose reads the test controls. */
function fakeChannel() {
  const listeners = new Map();
  const channel = {
    now: () => Date.now(),
    statePath: "state",
    resultsPath: "results",
    reads: 0,
    view: async () => {
      channel.reads++;
      await channel.gate;
      return channel.next;
    },
    alive: async () => null,
    touchPresence: async () => {},
    gate: null,
    next: null,
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

const timers = {
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout,
};
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe("isStale", () => {
  it("drops a write numbered a little below what is shown, never a big jump back or a missing number", () => {
    expect(isStale(1_000, 1_500)).toBe(true);
    expect(isStale(1_500, 1_000)).toBe(false);
    expect(isStale(1_000, 1_000)).toBe(false);
    expect(isStale(undefined, 1_000)).toBe(false);
    expect(isStale(1_000, 60_000)).toBe(false);
  });
});

describe("Sync", () => {
  it("is woken by a stream event, and reads through the store rather than using the event", async () => {
    const channel = fakeChannel();
    channel.next = { v: 1, sessions: [], seq: 1 };
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    await tick();
    expect(channel.reads).toBe(1);
    channel.next = { v: 1, sessions: [{ key: "a" }], seq: 2 };
    channel.emit("state", { kind: "change", path: "/snapshot", data: { forged: true } });
    await tick();
    expect(sync.state.view.sessions).toEqual([{ key: "a" }]);
    sync.stop();
  });

  it("ignores the echo of its own presence ping", async () => {
    const channel = fakeChannel();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    await tick();
    channel.emit("state", { kind: "change", path: "/presence" });
    await tick();
    expect(channel.reads).toBe(1);
    sync.stop();
  });

  it("runs another pass for a change that landed during one, and folds a burst into one", async () => {
    const channel = fakeChannel();
    let release;
    channel.gate = new Promise((resolve) => (release = resolve));
    channel.next = { v: 1, sessions: [], seq: 1 };
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    await tick();
    expect(channel.reads).toBe(1); // the first pass is held open
    for (let i = 0; i < 5; i++) channel.emit("state", { kind: "change", path: "/snapshot" });
    await tick();
    expect(channel.reads).toBe(1); // none started on top of it
    channel.gate = null;
    release();
    await tick(300);
    expect(channel.reads).toBe(2); // exactly one more, for all five
    sync.stop();
  });

  it("keeps the newer view when an older one arrives out of order", async () => {
    const channel = fakeChannel();
    channel.next = { v: 1, sessions: [{ key: "new" }], seq: 5_000 };
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    await tick();
    channel.next = { v: 1, sessions: [{ key: "old" }], seq: 4_000 };
    await sync.pass();
    expect(sync.state.view.sessions).toEqual([{ key: "new" }]);
    sync.stop();
  });

  it("polls on its own safety interval and pings presence, and a stopped one does neither", async () => {
    const channel = fakeChannel();
    const calls = [];
    const fake = { ...timers, setInterval: (fn, ms) => (calls.push(ms), calls.length), clearInterval: () => {} };
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers: fake });
    sync.start();
    expect(calls).toEqual([20_000, 60_000, 1_500]);
    sync.stop();
    const before = channel.reads;
    await sync.pass();
    expect(channel.reads).toBe(before);
  });

  it("tracks whether the stream is up", async () => {
    const channel = fakeChannel();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    channel.emit("state", { kind: "open" });
    expect(sync.state.streamUp).toBe(true);
    channel.emit("state", { kind: "dropped" });
    expect(sync.state.streamUp).toBe(false);
    sync.stop();
  });
});

describe("Sync.reply", () => {
  /** A channel and clock the test drives; `answers` is what the Mac has written. */
  function replyRig({ deleteOk = true, sendFails = false } = {}) {
    let clock = 1_000_000;
    const channel = {
      ...fakeChannel(),
      now: () => clock,
      deleted: [],
      answer: null,
      replyDocument: async () => ({ id: "cmd-1", document: { box: "b" } }),
      send: async () => {
        if (sendFails) throw new Error("offline");
      },
      result: async () => channel.answer,
      deleteResult: async () => {},
      deleteCommand: async (id) => (channel.deleted.push(id), deleteOk),
    };
    let poll = () => {};
    const fake = { ...timers, setInterval: (fn, ms) => (ms === 1_500 && (poll = fn), 0) };
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers: fake });
    sync.start();
    const advance = async (ms) => {
      await tick(10);
      clock += ms;
      poll();
      await tick(10);
    };
    return { sync, channel, advance };
  }

  it.each(["sent", "answered", "refused", "unconfirmed"])("hands back what the Mac wrote: %s", async (status) => {
    const { sync, channel } = replyRig();
    channel.answer = { status, reason: "no" };
    expect(await sync.reply({}, "hi")).toEqual({ status, reason: "no" });
    expect(channel.deleted).toEqual([]);
    sync.stop();
  });

  it("takes a silent command back at 30 s, waits the grace, and reports nothing started if it stays silent", async () => {
    const { sync, channel, advance } = replyRig();
    const done = sync.reply({}, "hi");
    await advance(RESULT_TIMEOUT_MS + 1);
    expect(channel.deleted).toEqual(["cmd-1"]);
    await advance(LATE_RESULT_MS + 1);
    expect(await done).toEqual({ status: "withdrawn" });
    sync.stop();
  });

  it("lets a late answer inside the grace win over the withdrawal", async () => {
    const { sync, channel, advance } = replyRig();
    const done = sync.reply({}, "hi");
    await advance(RESULT_TIMEOUT_MS + 1);
    channel.answer = { status: "sent", delivery: "sent" };
    await advance(2_000);
    expect(await done).toEqual({ status: "sent", delivery: "sent" });
    sync.stop();
  });

  it("says it could not confirm when the command could not be taken back", async () => {
    const { sync, channel, advance } = replyRig({ deleteOk: false });
    const done = sync.reply({}, "hi");
    await advance(RESULT_TIMEOUT_MS + 1);
    expect(channel.deleted).toEqual(["cmd-1"]);
    await advance(1_001);
    expect(await done).toEqual({ status: "unconfirmed" });
    sync.stop();
  });

  it("on a failed write takes the command back before saying nothing was sent, and never resends", async () => {
    const ok = replyRig({ sendFails: true });
    await expect(ok.sync.reply({}, "hi")).rejects.toThrow("offline");
    expect(ok.channel.deleted).toEqual(["cmd-1"]);
    const stuck = replyRig({ sendFails: true, deleteOk: false });
    expect(await stuck.sync.reply({}, "hi")).toEqual({ status: "unconfirmed" });
    ok.sync.stop();
    stuck.sync.stop();
  });
});

describe("the calls cap", () => {
  it("is asked for only while the Phone calls log holds its lease, and ends with it", async () => {
    const channel = fakeChannel();
    let clock = 1_000_000;
    channel.now = () => clock;
    const sent = [];
    channel.touchPresence = async (options) => void sent.push(options.calls);
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    await tick();
    expect(sync.callsWanted).toBe(false);
    sync.wantCalls(true);
    await tick();
    expect(sent.at(-1)).toBe(true);
    clock += CALLS_LEASE_MS - 1;
    expect(sync.callsWanted).toBe(true);
    clock += 2;
    expect(sync.callsWanted).toBe(false); // not renewed: the next ping drops the cap
    sync.wantCalls(true);
    sync.wantCalls(false);
    await tick();
    expect(sent.at(-1)).toBe(false);
    sync.stop();
  });
});
