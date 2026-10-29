import { describe, expect, it } from "vitest";

import { CommandInputError, shape } from "../js/command-shapes.js";
import { createCommands, outcomeOf, RATE_HINTS } from "../js/commands.js";
import { Sync } from "../js/sync.js";

/** A channel whose results, sends and clock the test controls. */
function fakeChannel({ answer = null, sendFails = false, deletes = true } = {}) {
  let clock = 1_000_000;
  const callbacks = [];
  const channel = {
    sent: [],
    deleted: [],
    answer,
    now: () => clock,
    advance: (ms) => (clock += ms),
    statePath: "state",
    resultsPath: "results",
    view: async () => null,
    alive: async () => null,
    touchPresence: async () => {},
    db: { watch: () => () => {} },
    commandDocument: async (kind, input) => {
      const fields = shape(kind, input);
      return { id: `id-${channel.sent.length + 1}`, document: { kind, fields } };
    },
    send: async (id, document) => {
      if (sendFails) throw new Error("offline");
      channel.sent.push({ id, document });
    },
    result: async (id) => (channel.sent.some((s) => s.id === id) ? channel.answer : null),
    deleteCommand: async (id) => {
      channel.deleted.push(id);
      return deletes;
    },
    deleteResult: async () => {},
  };
  const timers = {
    setInterval: (fn) => callbacks.push(fn),
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout,
  };
  const sync = new Sync({ channel, signingKey: "k", onState: () => {}, timers });
  sync.start();
  /** Runs the result poll until `promise` settles, moving the clock on. */
  const settle = async (promise, step = 13_000) => {
    let done = false;
    promise.finally(() => (done = true)).catch(() => {});
    for (let i = 0; i < 20 && !done; i++) {
      await new Promise((r) => setTimeout(r, 2));
      channel.advance(step);
      for (const fn of callbacks) fn();
    }
    return promise;
  };
  return { channel, sync, settle };
}

describe("commands", () => {
  it("sends a checked command and returns the Mac's answer", async () => {
    const { channel, sync, settle } = fakeChannel({ answer: { status: "sent", sessionId: "abc" } });
    const commands = createCommands({ sync });
    const outcome = await settle(commands.start({ workspaceId: "w", agent: "claude", text: "go" }));
    expect(outcome).toMatchObject({ ok: true, status: "sent", retrySafe: false, unconfirmed: false });
    expect(outcome.result.sessionId).toBe("abc");
    expect(channel.sent).toHaveLength(1);
    sync.stop();
  });

  it("says why when the Mac refuses, and that a retry is safe", async () => {
    const { sync, settle } = fakeChannel({ answer: { status: "refused", reason: "that workspace is gone" } });
    const outcome = await settle(createCommands({ sync }).close({ sessionId: "s" }));
    expect(outcome).toMatchObject({ ok: false, status: "refused", reason: "That workspace is gone.", retrySafe: true });
    sync.stop();
  });

  it("never sends a bad input", async () => {
    const { channel, sync } = fakeChannel();
    const outcome = await createCommands({ sync }).controls({ change: { volume: 500 } });
    expect(outcome).toMatchObject({ ok: false, status: "invalid", retrySafe: true });
    expect(outcome.reason).toMatch(/volume/);
    expect(channel.sent).toHaveLength(0);
    sync.stop();
  });

  it("a silent Mac is withdrawn when the command can be taken back, and is never resent", async () => {
    const { channel, sync, settle } = fakeChannel({ answer: null, deletes: true });
    const outcome = await settle(createCommands({ sync }).awake({ on: true, minutes: 30 }));
    expect(outcome).toMatchObject({ ok: false, status: "withdrawn", retrySafe: true });
    expect(channel.sent).toHaveLength(1);
    expect(channel.deleted).toEqual(["id-1"]);
    sync.stop();
  });

  it("a silent Mac whose command cannot be taken back is unconfirmed and not retry-safe", async () => {
    const { channel, sync, settle } = fakeChannel({ answer: null, deletes: false });
    const outcome = await settle(createCommands({ sync }).awake({ on: true, minutes: 30 }));
    expect(outcome).toMatchObject({ ok: false, status: "unconfirmed", unconfirmed: true, retrySafe: false });
    expect(outcome.reason).toMatch(/Couldn't confirm/);
    expect(channel.sent).toHaveLength(1);
    sync.stop();
  });

  it("a write that failed and was taken back is failed and safe; one that cannot be is unconfirmed", async () => {
    const a = fakeChannel({ sendFails: true, deletes: true });
    expect(await createCommands({ sync: a.sync }).usage()).toMatchObject({
      status: "failed",
      retrySafe: true,
      ok: false,
    });
    const b = fakeChannel({ sendFails: true, deletes: false });
    expect(await createCommands({ sync: b.sync }).usage()).toMatchObject({ status: "unconfirmed", retrySafe: false });
    a.sync.stop();
    b.sync.stop();
  });

  it("reads garbage as unconfirmed, never as sent", () => {
    for (const garbage of [
      null,
      undefined,
      5,
      "sent",
      {},
      { status: 3 },
      { status: "maybe" },
      { status: "unconfirmed" },
    ]) {
      expect(outcomeOf(garbage)).toMatchObject({ ok: false, unconfirmed: true, retrySafe: false });
    }
    expect(outcomeOf({ status: "answered" }).ok).toBe(true);
  });

  it("has a method for every kind and paces what the Mac limits", async () => {
    const { sync } = fakeChannel();
    let clock = 0;
    const commands = createCommands({ sync, now: () => clock });
    for (const kind of [
      "start",
      "answer",
      "attach",
      "history",
      "subagent",
      "diff",
      "close",
      "workspace",
      "setup",
      "usage",
      "stats",
      "awake",
      "lidActions",
      "controls",
      "notify",
      "voice",
      "telegramAvatar",
      "hotspot",
      "workflow",
      "film",
      "media",
      "image",
    ]) {
      expect(typeof commands[kind], kind).toBe("function");
    }
    expect(commands.hint("attach")).toEqual({ limit: 40, perMs: 60_000 });
    expect(RATE_HINTS.start.minGapMs).toBe(15_000);
    expect(commands.waitMs("attach")).toBe(0);
    for (let i = 0; i < 40; i++) commands.sent.set("attach", [...(commands.sent.get("attach") ?? []), clock + i]);
    clock = 1_000;
    expect(commands.waitMs("attach")).toBe(59_000);
    clock = 61_000;
    expect(commands.waitMs("attach")).toBe(0);
    commands.sent.set("start", [61_000]);
    expect(commands.waitMs("start")).toBe(15_000);
    expect(commands.waitMs("controls")).toBe(0);
    sync.stop();
  });

  it("rejects bad shapes with the typed error", () => {
    expect(() => shape("start", {})).toThrow(CommandInputError);
  });
});
