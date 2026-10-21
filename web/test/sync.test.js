import { describe, expect, it } from "vitest";

import { isStale, Sync } from "../js/sync.js";

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
