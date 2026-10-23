import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { open as macOpen } from "../../src/remote/remote-crypto.js";
import { Channel } from "../js/channel.js";
import { generateDeviceKey, importChannelKey } from "../js/channel-crypto.js";
import { arrived, isQueued, queueCards, rows, same, stepPhrase, workingLabel } from "../js/chat-timeline.js";
import { HistoryStore, MAX_AGE_MS, MAX_CHATS, MAX_ENTRIES, OutboxStore } from "../js/chat-stores.js";
import { asksYou, replyBlock, sessionStateWord, setupLine, waitsOnYou } from "../js/format.js";
import { KeyStore } from "../js/key-store.js";
import { foldHistory, reconciled, readTurn } from "../js/live.js";
import { verbosePref } from "../js/prefs.js";
import { Outbox } from "../js/sends.js";
import * as status from "../js/send-state.js";
import { Sync } from "../js/sync.js";
import { fakeIndexedDB } from "./helpers.js";

const swift = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "src", "remote", "fixtures", "swift-command.json"), "utf8"),
);
const NOW = Date.parse("2026-10-23T12:00:00Z");
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("commands made by the browser have the iPhone's exact fields", () => {
  async function made() {
    const key = await importChannelKey(swift.key);
    const { privateKey } = await generateDeviceKey();
    const channel = new Channel({ channelId: swift.channelId, deviceId: "web", key, db: {} });
    return { channel, privateKey };
  }
  const phone = (name) => macOpen(swift.key, swift[name].box);
  const session = { conductorSessionId: "s1", turnId: "turn-1" };
  const shape = (value) => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v]));
  const shapeWithout = (value, ...omit) =>
    Object.fromEntries(Object.entries(shape(value)).filter(([k]) => !omit.includes(k)));

  it("a steered reply, a queued reply with a message id, a stop, a promote", async () => {
    const { channel, privateKey } = await made();
    const open = async ({ document }) => macOpen(swift.key, document.box);
    const steer = await open(await channel.replyDocument(session, "x", privateKey, { mode: "steer" }));
    expect(shape(steer)).toEqual(shape(phone("steerCommand")));
    const queued = await open(
      await channel.replyDocument(session, "x", privateKey, {
        messageId: phone("queuedCommand").messageId,
      }),
    );
    expect(shape(queued)).toEqual(shape(phone("queuedCommand")));
    expect(queued).not.toHaveProperty("mode"); // a queued reply carries no mode at all
    const stop = await open(await channel.stopDocument(session, privateKey));
    expect(shape(stop)).toEqual(shape(phone("stopCommand")));
    const promote = await open(
      await channel.queueDocument("s1", phone("promoteCommand").messageId, "promote", privateKey),
    );
    expect(shape(promote)).toEqual(shape(phone("promoteCommand")));
    expect(shapeWithout(promote)).toEqual(shapeWithout(phone("promoteCommand")));
  });

  it("refuses to build what the Mac would refuse: a bad message id, a bad action, a chat with no Conductor id", async () => {
    const { channel, privateKey } = await made();
    await expect(channel.replyDocument(session, "x", privateKey, { messageId: "NOT-A-UUID" })).rejects.toThrow();
    await expect(
      channel.queueDocument("s1", "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31", "delete", privateKey),
    ).rejects.toThrow();
    await expect(channel.stopDocument({ conductorSessionId: null }, privateKey)).rejects.toThrow();
  });

  it("a stop for a chat with no finished turn leaves the turn out, as the iPhone does", async () => {
    const { channel, privateKey } = await made();
    const { document } = await channel.stopDocument({ conductorSessionId: "s1" }, privateKey);
    expect(macOpen(swift.key, document.box)).not.toHaveProperty("answersTurn");
  });
});

describe("what a send says about itself", () => {
  it("words every state as the iPhone does", () => {
    expect(status.statusLine(status.sending)).toBe("Sending…");
    expect(status.statusLine(status.sent)).toBe("Sent");
    expect(status.statusLine(status.queued("Claude"))).toBe("Queued · Claude reads it after this turn");
    expect(status.statusLine(status.queued("Claude", true))).toBe(
      "Queued · Claude reads it after this turn (steering isn't available here)",
    );
    expect(status.statusLine(status.steered)).toBe("Steered into the current turn");
    expect(status.statusLine(status.read("Claude"))).toBe("Read by Claude");
    expect(status.statusLine(status.refused("that chat has moved on"))).toBe(
      "Not sent. Nothing started. That chat has moved on.",
    );
    expect(status.statusLine(status.notConfirmed)).toBe(
      "Couldn't confirm it arrived. Check the chat before sending again.",
    );
  });

  it("settles to what is proven and only that", () => {
    expect(status.verdict({ status: "sent", delivery: "steered" }, "Claude")).toEqual(status.steered);
    expect(status.verdict({ status: "sent", delivery: "queued", note: "n" }, "Claude")).toEqual(
      status.queued("Claude", true),
    );
    expect(status.verdict({ status: "sent" }, "Claude")).toEqual(status.sent);
    expect(status.verdict({ status: "refused", reason: "nope" }, "Claude")).toEqual(status.refused("nope"));
    expect(status.verdict({ status: "withdrawn" }, "Claude").kind).toBe("refused");
    for (const odd of [{ status: "unconfirmed" }, { status: "unknown" }, {}, null, "sent", { status: 7 }]) {
      expect(status.verdict(odd, "Claude")).toEqual(status.notConfirmed);
    }
    expect([status.refused("x"), status.notConfirmed].map(status.isFailed)).toEqual([true, true]);
    expect([status.sending, status.sent, status.steered].map(status.isFailed)).toEqual([false, false, false]);
  });
});

/** A Sync stand-in whose answers the test decides. */
function fakeSync(answer) {
  const sync = {
    signingKey: null,
    replies: [],
    commands: [],
    channel: {
      results: new Map(),
      deleted: [],
      stopDocument: async () => ({ id: "c", document: {} }),
      queueDocument: async (...args) => ({ id: "q", document: {}, args }),
      result: async (id) => sync.channel.results.get(id) ?? null,
      deleteResult: async (id) => void sync.channel.deleted.push(id),
    },
    reply: async (session, text, options) => {
      sync.replies.push({ session, text, options });
      options.onId?.(`cmd-${sync.replies.length}`);
      return typeof answer === "function" ? answer(sync.replies.length) : answer;
    },
    command: async (make) => {
      sync.commands.push(await make());
      return typeof answer === "function" ? answer(sync.commands.length) : answer;
    },
  };
  return sync;
}

const claude = (overrides = {}) => ({
  key: "k1",
  conductorSessionId: "s1",
  agent: "claude",
  state: "finished",
  turnId: "t1",
  lastActivityAt: "2026-10-23T11:59:00Z",
  ...overrides,
});

describe("Outbox", () => {
  const make = (answer, extra = {}) => {
    const sync = fakeSync(answer);
    const kv = new KeyStore(fakeIndexedDB());
    const store = new OutboxStore(kv);
    let changes = 0;
    const outbox = new Outbox({ sync, store, onChange: () => changes++, ...extra });
    return { sync, store, outbox, kv, changes: () => changes };
  };

  it("shows Sending… at once, then Sent when the Mac says so, and keeps nothing on disk for a delivered message", async () => {
    const { sync, outbox, store } = make({ status: "sent", delivery: "sent" });
    const session = claude();
    const done = outbox.send(session, "  hello  ");
    expect(outbox.list("k1")[0].status).toEqual(status.sending);
    expect(outbox.isSending("k1")).toBe(true);
    expect(store.entries).toHaveLength(1); // on disk before the answer
    await done;
    expect(outbox.list("k1")[0].status).toEqual(status.sent);
    expect(sync.replies[0]).toMatchObject({ text: "hello", options: { mode: "queue" } });
    expect(store.entries).toEqual([]);
  });

  it("an idle chat is simply sent: mode only means something mid-turn", async () => {
    const { sync, outbox } = make({ status: "sent", delivery: "sent" });
    await outbox.send(claude({ state: "finished" }), "x", "steer");
    expect(sync.replies[0].options.mode).toBe("queue");
    await outbox.send(claude({ state: "working" }), "y", "steer");
    expect(sync.replies[1].options.mode).toBe("steer");
    expect(outbox.list("k1")[1].mode).toBe("steer");
  });

  it("queues behind a working turn: Queued, with a message id for the Mac's queue", async () => {
    const { sync, outbox } = make({ status: "sent", delivery: "queued" });
    await outbox.send(claude({ state: "working" }), "later", "queue");
    const [send] = outbox.list("k1");
    expect(send.status).toEqual(status.queued("Claude", false));
    expect(send.queuedBehindTurn).toBe(true);
    expect(sync.replies[0].options.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(send.messageId).toBe(sync.replies[0].options.messageId);
  });

  it("a refusal is Not sent with its reason and offers Send again under the same message id, then Edit puts the text back", async () => {
    let n = 0;
    const { sync, outbox, store } = make(() =>
      ++n === 1 ? { status: "refused", reason: "that chat moved on" } : { status: "sent" },
    );
    const session = claude();
    await outbox.send(session, "hello");
    const [send] = outbox.list("k1");
    expect(status.statusLine(send.status)).toBe("Not sent. Nothing started. That chat moved on.");
    expect(store.entries[0]).toMatchObject({ state: "refused", text: "hello" });
    await outbox.retry(send.id, session);
    expect(outbox.list("k1")[0].status).toEqual(status.sent);
    expect(sync.replies[1].options.messageId).toBe(sync.replies[0].options.messageId);
    // A delivered message cannot be retried or edited.
    await outbox.retry(send.id, session);
    expect(sync.replies).toHaveLength(2);
    outbox.edit(send.id, session);
    expect(outbox.restoredDraft.size).toBe(0);
  });

  it("Edit takes the failed message out of the chat and its text back to the composer", async () => {
    const { outbox } = make({ status: "refused", reason: "no" });
    const session = claude();
    await outbox.send(session, "oops");
    outbox.edit(outbox.list("k1")[0].id, session);
    expect(outbox.list("k1")).toEqual([]);
    expect(outbox.restoredDraft.get("k1")).toBe("oops");
    outbox.draftRestored("k1");
    expect(outbox.restoredDraft.size).toBe(0);
  });

  it("a write that failed (and was taken back) is Not sent; one nobody can vouch for is Couldn't confirm, never sent again by itself", async () => {
    const sync = fakeSync(null);
    sync.reply = async () => {
      throw new Error("offline");
    };
    const outbox = new Outbox({ sync });
    await outbox.send(claude(), "a");
    expect(status.statusLine(outbox.list("k1")[0].status)).toBe(
      "Not sent. Nothing started. Couldn't reach your Mac's server.",
    );
    const lost = make({ status: "unconfirmed" });
    await lost.outbox.send(claude(), "b");
    expect(lost.outbox.list("k1")[0].status).toEqual(status.notConfirmed);
    await pause(20);
    expect(lost.sync.replies).toHaveLength(1);
  });

  it("silence that was taken back is Not sent; a Mac that never answered and could not be undone is Couldn't confirm", async () => {
    const taken = make({ status: "withdrawn" });
    await taken.outbox.send(claude(), "a");
    expect(taken.outbox.list("k1")[0].status.kind).toBe("refused");
    const unknown = make({ status: "unknown" });
    await unknown.outbox.send(claude(), "b");
    expect(unknown.outbox.list("k1")[0].status).toEqual(status.notConfirmed);
  });

  it("refuses an empty message and one over the Mac's limit without sending", async () => {
    const { sync, outbox } = make({ status: "sent" });
    expect(await outbox.send(claude(), "   ")).toBe(false);
    expect(await outbox.send(claude(), "x".repeat(20_001))).toBe(false);
    expect(sync.replies).toEqual([]);
  });

  it("persists unsettled sends and restores them as not confirmed, until the Mac's waiting answer settles them", async () => {
    const first = make({ status: "unknown" });
    let release;
    first.sync.reply = (session, text, options) => {
      options.onId("cmd-9");
      return new Promise((resolve) => (release = resolve));
    };
    void first.outbox.send(claude(), "kept");
    await pause();
    expect(first.store.entries[0]).toMatchObject({ state: "sending", commandId: "cmd-9", text: "kept" });
    await first.store.chain;

    // A reload: a new store reads what was kept.
    const store = new OutboxStore(first.kv);
    const kept = await store.load();
    expect(kept).toHaveLength(1);
    const sync = fakeSync({ status: "sent" });
    const outbox = new Outbox({ sync, store });
    outbox.restore(kept);
    expect(outbox.list("k1")[0].status).toEqual(status.notConfirmed); // never "sending" after a reload
    sync.channel.results.set("cmd-9", { status: "sent", delivery: "queued" });
    await outbox.reconcileRestored(() => claude());
    expect(outbox.list("k1")[0].status).toEqual(status.queued("Claude", false));
    expect(sync.channel.deleted).toEqual(["cmd-9"]);
    release?.({ status: "sent" });
  });

  it("learns from the Mac's queue: a queued message shown there, then gone from it, reads as sent", async () => {
    const { outbox } = make({ status: "unconfirmed" });
    const session = claude({ state: "working" });
    await outbox.send(session, "later");
    const [send] = outbox.list("k1");
    expect(send.status).toEqual(status.notConfirmed);
    outbox.noteQueue("k1", { queue: [{ id: send.messageId, text: "later" }] }, "Claude");
    expect(outbox.list("k1")[0].status).toEqual(status.queued("Claude", false)); // Conductor has it: it did arrive
    outbox.noteQueue("k1", { queue: [] }, "Claude");
    expect(outbox.list("k1")[0].status).toEqual(status.sent);
  });

  it("Stop: nothing says it worked until the Mac does; a refusal is kept with its reason", async () => {
    const ok = make({ status: "sent" });
    const session = claude({ state: "working" });
    expect(await ok.outbox.stop(session)).toBeNull();
    expect(ok.outbox.isStopping("k1", session)).toBe(true);
    expect(ok.outbox.isStopping("k1", claude({ state: "finished" }))).toBe(false); // no longer working: done stopping
    const no = make({ status: "refused", reason: "That turn already ended." });
    expect(await no.outbox.stop(session)).toBe("That turn already ended.");
    expect(no.outbox.isStopping("k1", session)).toBe(false);
    expect(no.outbox.problemFor.get("k1")).toBe("That turn already ended.");
    const silent = make(null);
    expect(await silent.outbox.stop(session)).toBe("Your Mac didn't answer. Is Squeak running?");
  });

  it("Steer now moves a queued card into the turn at once and gives it back, with the reason, if the Mac refuses", async () => {
    const ok = make({ status: "sent" });
    const session = claude({ state: "working" });
    const card = { id: "11111111-1111-4111-8111-111111111111", text: "later" };
    await ok.outbox.steerQueued(card, session);
    expect(ok.outbox.list("k1")[0]).toMatchObject({ mode: "steer", messageId: card.id });
    expect(ok.outbox.list("k1")[0].status).toEqual(status.steered);
    expect(ok.sync.commands[0].args).toEqual(["s1", card.id, "promote", null]);

    const no = make({ status: "refused", reason: "That message already went to the agent." });
    await no.outbox.steerQueued(card, session);
    expect(no.outbox.list("k1")).toEqual([]);
    expect(no.outbox.hiddenQueued.has(card.id)).toBe(false);
    expect(no.outbox.queueProblem.get(card.id)).toBe("That message already went to the agent.");
  });

  it("Delete returns the text for Edit, and puts the card back if refused", async () => {
    const card = { id: "11111111-1111-4111-8111-111111111111", text: "later" };
    const ok = make({ status: "sent" });
    expect(await ok.outbox.removeQueued(card, claude({ state: "working" }))).toBe("later");
    expect(ok.sync.commands[0].args[2]).toBe("cancel");
    const no = make({ status: "refused", reason: "x" });
    expect(await no.outbox.removeQueued(card, claude({ state: "working" }))).toBeNull();
    expect(no.outbox.hiddenQueued.has(card.id)).toBe(false);
  });

  it("dispose wipes memory and stops disk writes", async () => {
    const { outbox, store, kv } = make({ status: "unknown" });
    await outbox.send(claude(), "a");
    await store.chain;
    await outbox.dispose();
    expect(outbox.list("k1")).toEqual([]);
    store.replace([{ key: "k", text: "t", at: Date.now() }]);
    await pause(5);
    expect(await kv.read("outbox")).toMatchObject({ entries: [expect.objectContaining({ text: "a" })] }); // nothing newer written
  });
});

describe("the chat's caches", () => {
  const entry = (n) => [{ role: "user", text: `m${n}`, at: null }];

  it("keeps the newest 30 chats and drops the least recently written", async () => {
    const kv = new KeyStore(fakeIndexedDB());
    let now = 0;
    const history = new HistoryStore(kv, { now: () => ++now, delayMs: 1 });
    for (let i = 0; i < MAX_CHATS + 5; i++) history.record(entry(i), `chat-${i}`);
    await history.flush();
    const again = await new HistoryStore(kv).load();
    expect(Object.keys(again)).toHaveLength(MAX_CHATS);
    expect(again["chat-0"]).toBeUndefined();
    expect(again[`chat-${MAX_CHATS + 4}`]).toEqual(entry(MAX_CHATS + 4));
  });

  it("ignores an empty or unchanged history, and coalesces writes", async () => {
    const kv = new KeyStore(fakeIndexedDB());
    const writes = [];
    const spy = { read: (n) => kv.read(n), write: (n, v) => (writes.push(n), kv.write(n, v)) };
    const history = new HistoryStore(spy, { delayMs: 5 });
    history.record([], "a");
    history.record(entry(1), "a");
    history.record(entry(1), "a");
    history.record(entry(2), "b");
    await pause(30);
    expect(writes).toEqual(["history"]);
  });

  it("opens a chat whole in its first frame: what was kept is what comes back", async () => {
    const kv = new KeyStore(fakeIndexedDB());
    const a = new HistoryStore(kv);
    a.record(entry(1), "k1");
    await a.flush();
    expect(await new HistoryStore(kv).load()).toEqual({ k1: entry(1) });
  });

  it("drops sends older than a day and keeps at most 50", async () => {
    const kv = new KeyStore(fakeIndexedDB());
    const outbox = new OutboxStore(kv, { now: () => NOW });
    const make = (n, at) => ({
      key: "k",
      id: `${n}`,
      text: `t${n}`,
      at,
      messageId: `m${n}`,
      mode: "queue",
      state: "sending",
    });
    outbox.replace(Array.from({ length: MAX_ENTRIES + 10 }, (_, n) => make(n, NOW - 1000)));
    await outbox.chain;
    const loaded = await new OutboxStore(kv, { now: () => NOW }).load();
    expect(loaded).toHaveLength(MAX_ENTRIES);
    expect(loaded[0].id).toBe("10");
    outbox.replace([make(1, NOW - MAX_AGE_MS - 1), make(2, NOW)]);
    await outbox.chain;
    expect((await new OutboxStore(kv, { now: () => NOW }).load()).map((e) => e.id)).toEqual(["2"]);
  });

  it("is wiped by Forget, and a write that was waiting cannot bring the database back", async () => {
    const idb = fakeIndexedDB();
    const kv = new KeyStore(idb);
    await kv.save({ state: "paired" });
    const history = new HistoryStore(kv, { delayMs: 5 });
    const outbox = new OutboxStore(kv);
    history.record(entry(1), "k1");
    outbox.replace([{ key: "k", id: "1", text: "t", at: Date.now(), messageId: "m", mode: "queue", state: "sending" }]);
    await Promise.all([history.dispose(), outbox.dispose()]);
    await kv.forget();
    expect(idb.databases.size).toBe(0);
    history.record(entry(2), "k2");
    outbox.replace([{ key: "k", id: "2", text: "t", at: Date.now(), messageId: "m", mode: "queue", state: "sending" }]);
    await pause(30);
    expect(idb.databases.size).toBe(0); // nothing came back
    expect(await new HistoryStore(kv).load()).toEqual({});
  });

  it("starts empty when what is stored is damaged", async () => {
    const kv = new KeyStore(fakeIndexedDB());
    await kv.write("history", { v: 9, chats: "nonsense" });
    await kv.write("outbox", "nonsense");
    expect(await new HistoryStore(kv).load()).toEqual({});
    expect(await new OutboxStore(kv).load()).toEqual([]);
  });
});

describe("the live turn's shape", () => {
  it("keeps only what is a live turn for this chat", () => {
    expect(readTurn({ v: 1, key: "other", working: true, total: 1, steps: [] }, "k1")).toBeNull();
    expect(readTurn({ v: 2, key: "k1" }, "k1")).toBeNull();
    expect(readTurn(null, "k1")).toBeNull();
    const turn = readTurn(
      {
        v: 1,
        key: "k1",
        working: true,
        state: "working",
        turnId: "t",
        seq: 7,
        total: 3,
        steps: [{ kind: "tool", text: "Read", at: null }, { kind: 3 }, null],
        queue: [{ id: "q", text: "x", mode: "steer", position: 1 }, { id: 5 }],
        history: [
          { role: "assistant", text: "hi", at: null, workBefore: 2 },
          { role: "system", text: "no" },
        ],
      },
      "k1",
    );
    expect(turn).toMatchObject({ working: true, state: "working", seq: 7, total: 3 });
    expect(turn.steps).toEqual([{ kind: "tool", text: "Read", at: null }]);
    expect(turn.queue).toEqual([{ id: "q", text: "x", mode: "steer", position: 1 }]);
    expect(turn.history).toEqual([{ role: "assistant", text: "hi", at: null, workBefore: 2 }]);
  });

  it("folds a split turn's history in from its own document, and only for the same chat", () => {
    const turn = { key: "k1", split: true, steps: [] };
    const hist = { key: "k1", history: [{ role: "user", text: "q", at: null }] };
    expect(foldHistory(turn, hist, "k1").history).toEqual([{ role: "user", text: "q", at: null }]);
    expect(foldHistory(turn, { ...hist, key: "k2" }, "k1").history).toBeUndefined();
    const inline = { key: "k1", history: [{ role: "user", text: "inline", at: null }] };
    expect(foldHistory(inline, null, "k1")).toBe(inline);
  });

  it("corrects the open chat's state and turn only when the live turn is newer than the view", () => {
    const view = {
      seq: 5,
      sessions: [
        { key: "k1", state: "working", turnId: "a" },
        { key: "k2", state: "idle" },
      ],
    };
    const newer = { key: "k1", state: "finished", turnId: "b", seq: 9 };
    expect(reconciled(view, newer).sessions[0]).toMatchObject({ state: "finished", turnId: "b" });
    expect(reconciled(view, newer).sessions[1].state).toBe("idle");
    expect(reconciled(view, { ...newer, seq: 4 })).toBe(view);
    expect(reconciled(view, null)).toBe(view);
    expect(reconciled(view, { key: "k1", state: "finished" })).toBe(view);
  });
});

describe("header words", () => {
  it("names what the chat runs, as the iPhone's setup line", () => {
    expect(setupLine({ model: "Opus 5.5 · 1M", effort: "Medium" })).toBe("Opus 5.5 · 1M · Medium");
    expect(setupLine({ model: "Opus 5.5 · 1M", effort: "Medium", fast: true })).toBe("Opus 5.5 · 1M · Medium · Fast");
    expect(setupLine({})).toBeNull();
    expect(setupLine({ fast: true })).toBe("Fast");
  });

  it("a finished chat that asks needs you, and says what it asks; it can still be replied to", () => {
    const asking = { conductorSessionId: "s1", state: "finished", asks: "Want me to open a PR?" };
    expect(asksYou(asking)).toBe(true);
    expect(waitsOnYou(asking)).toBe(true);
    expect(sessionStateWord(asking)).toBe("needs an answer");
    expect(replyBlock(asking)).toBeNull();
    expect(sessionStateWord({ state: "finished" })).toBe("done");
    expect(asksYou({ state: "working", asks: "x" })).toBe(false);
    expect(replyBlock({ conductorSessionId: "s1", state: "awaiting_input" })).toMatch(/inside Conductor/);
    expect(replyBlock({ conductorSessionId: "s1", state: "idle", open: false })).toMatch(/Closed in Conductor/);
    expect(replyBlock({ state: "idle" })).toMatch(/Not a Conductor session/);
  });
});

describe("the chat timeline", () => {
  const send = (over = {}) => ({
    id: "s",
    text: "hello",
    date: NOW - 1000,
    origin: NOW - 1000,
    answersTurn: "t1",
    status: status.sent,
    messageId: "m1",
    mode: "queue",
    queuedBehindTurn: false,
    seenInQueue: false,
    commandId: null,
    ...over,
  });
  const kinds = (list) => list.map((row) => row.kind);

  it("says what is true for a chat with nothing yet", () => {
    expect(rows({ session: claude({ state: "idle" }), now: NOW })).toEqual([
      { kind: "empty", id: "empty", text: "No messages from this chat yet. Send one below to start." },
    ]);
    expect(rows({ session: { state: "idle" }, now: NOW })[0].text).toBe("No messages from this chat yet.");
  });

  it("shows the whole history oldest first, with the work between messages counted", () => {
    const history = [
      { role: "user", text: "Fix the gate", at: "2026-10-23T09:00:00Z" },
      { role: "assistant", text: "Fixed.", at: "2026-10-23T09:01:00Z", workBefore: 4 },
      { role: "user", text: "Now the fence", at: "2026-10-23T10:00:00Z" },
      { role: "assistant", text: "Done.", at: "2026-10-23T10:05:00Z" },
    ];
    const list = rows({
      session: claude({ message: "Done.", lastActivityAt: "2026-10-23T10:05:00Z" }),
      live: { key: "k1", working: false, total: 0, steps: [], history },
      now: NOW,
    });
    expect(kinds(list)).toEqual(["history", "worked", "history", "history", "agent"]);
    expect(list[1]).toMatchObject({ steps: 4 });
    expect(list.at(-1)).toMatchObject({ kind: "agent", text: "Done.", muted: false });
  });

  it("opens whole from the cache before the Mac has said anything, and a live empty history does not blank it", () => {
    const cached = [{ role: "user", text: "cached", at: null }];
    expect(rows({ session: claude({ message: "m" }), cachedHistory: cached, now: NOW })[0]).toMatchObject({
      text: "cached",
    });
    const live = { key: "k1", working: false, total: 0, steps: [], history: [] };
    expect(rows({ session: claude({ message: "m" }), live, cachedHistory: cached, now: NOW })[0]).toMatchObject({
      text: "cached",
    });
  });

  it("a working chat: the previous answer muted above, your message, and a working row with the steps", () => {
    const session = claude({
      state: "working",
      activity: { total: 2, steps: [{ kind: "tool", text: "Run vitest", at: null }] },
    });
    const list = rows({
      session,
      remembered: { text: "Earlier answer", atISO: "2026-10-23T11:00:00Z", turnId: "t0" },
      sends: [send({ status: status.sent, answersTurn: "t0" })],
      now: NOW,
    });
    expect(kinds(list)).toEqual(["agent", "sent", "working"]);
    expect(list[0].muted).toBe(true);
    expect(list.at(-1)).toMatchObject({ label: "Running tests…" });
  });

  it("the live turn's whole steps replace the snapshot's newest few while verbose is on", () => {
    const session = claude({
      state: "working",
      activity: { total: 1, steps: [{ kind: "tool", text: "Read a", at: null }] },
    });
    const live = {
      key: "k1",
      working: true,
      total: 3,
      steps: [
        { kind: "thinking", text: "hm", at: null },
        { kind: "tool", text: "Read b", at: null },
        { kind: "note", text: "n", at: null },
      ],
    };
    expect(rows({ session, live, now: NOW }).at(-1).steps).toHaveLength(3);
    expect(rows({ session, now: NOW }).at(-1).steps).toHaveLength(1);
  });

  it("a steer lands inside the turn: the steps before it fold, your message sits under them, the turn carries on", () => {
    const session = claude({ state: "working" });
    const live = {
      key: "k1",
      working: true,
      total: 4,
      steps: [
        { kind: "tool", text: "Read a", at: null },
        { kind: "you", text: "go left", at: null },
        { kind: "tool", text: "Edit b", at: null },
      ],
    };
    const list = rows({
      session,
      live,
      sends: [send({ mode: "steer", text: "go left", status: status.steered })],
      now: NOW,
    });
    expect(kinds(list)).toEqual(["folded", "steer", "working"]);
    expect(list[1].status.kind).toBe("read"); // the transcript shows it inside the turn: the agent has it
  });

  it("a failed send shows its refusal and starts no working row", () => {
    const list = rows({
      session: claude({ state: "finished" }),
      sends: [send({ status: status.refused("no") })],
      now: NOW,
    });
    expect(kinds(list)).toEqual(["sent"]);
    expect(list[0].send.status.kind).toBe("refused");
  });

  it("a message nobody could confirm that the chat's own history shows did arrive", () => {
    const history = [{ role: "user", text: "hello", at: new Date(NOW).toISOString() }];
    expect(arrived(send(), history)).toBe(true);
    expect(arrived(send({ origin: NOW + 60_000 }), history)).toBe(false);
    const list = rows({
      session: claude({ state: "finished", message: "ok" }),
      sends: [send({ status: status.notConfirmed })],
      cachedHistory: history,
      now: NOW + 5_000,
    });
    expect(list.find((row) => row.kind === "sent")?.send.status.kind).not.toBe("notConfirmed");
  });

  it("a send that made the Mac report nothing for 90 s stops counting as starting", () => {
    const sends = [send({ status: status.sending, date: NOW - 100_000 })];
    expect(kinds(rows({ session: claude({ state: "idle" }), sends, now: NOW }))).not.toContain("working");
    expect(
      kinds(
        rows({
          session: claude({ state: "idle" }),
          sends: [send({ status: status.sending, date: NOW - 1000 })],
          now: NOW,
        }),
      ),
    ).toContain("working");
  });

  it("queued messages are cards, never rows: Conductor's queue is the truth and this browser's own fill the gap", () => {
    const session = claude({ state: "working" });
    const mine = send({ queuedBehindTurn: true, status: status.queued("Claude"), date: NOW - 1000 });
    const live = { key: "k1", queue: [{ id: "other", text: "from the Mac" }] };
    const cards = queueCards(session, live, [mine], new Set(), NOW);
    expect(cards).toEqual([
      { id: "other", text: "from the Mac", pending: false, actionable: true },
      { id: "m1", text: "hello", pending: true, actionable: false },
    ]);
    expect(queueCards(session, live, [mine], new Set(["other"]), NOW).map((c) => c.id)).toEqual(["m1"]);
    const listed = queueCards(session, { key: "k1", queue: [{ id: "m1", text: "hello" }] }, [mine], new Set(), NOW);
    expect(listed).toEqual([{ id: "m1", text: "hello", pending: false, actionable: true }]);
    expect(kinds(rows({ session, sends: [mine], live, now: NOW }))).not.toContain("sent");
    expect(isQueued(send({ queuedBehindTurn: true, status: status.refused("x") }), session, live, NOW)).toBe(false);
    // Once the Mac stops listing a message it saw, it went to the agent.
    expect(
      isQueued(
        send({ queuedBehindTurn: true, status: status.queued("C"), seenInQueue: true }),
        session,
        { key: "k1", queue: [] },
        NOW,
      ),
    ).toBe(false);
  });

  it("phrases the working row as the Mac's rows do", () => {
    expect(workingLabel([])).toBe("Starting…");
    expect(stepPhrase([{ kind: "thinking", text: "x" }])).toBe("thinking");
    expect(
      stepPhrase([
        { kind: "tool", text: "Edit a.ts" },
        { kind: "tool", text: "Write b.ts" },
      ]),
    ).toBe("editing 2 files");
    expect(stepPhrase([{ kind: "tool", text: "Run the build" }])).toBe("building");
    expect(same("a  b\nc", "a b c")).toBe(true);
    expect(same("a b…", "a b c d")).toBe(true);
    expect(same("a b", "a c")).toBe(false);
  });
});

describe("Sync with a chat open", () => {
  const timers = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout,
  };
  function channelStub() {
    const watches = [];
    const presence = [];
    const channel = {
      now: () => Date.now(),
      statePath: "state",
      resultsPath: "results",
      livePath: "live",
      db: {
        watch(path) {
          watches.push(path);
          return () => watches.splice(watches.indexOf(path), 1);
        },
      },
      view: async () => ({ v: 1, sessions: [], seq: 1 }),
      alive: async () => null,
      touchPresence: async (options) => void presence.push(options),
      liveReads: [],
      liveTurn: async (key) => {
        channel.liveReads.push(key);
        return channel.turn ?? null;
      },
      turn: null,
    };
    return { channel, watches, presence };
  }

  it("is on by default, as on the iPhone, and an explicit off in the stored preference stays off", () => {
    expect(new Sync({ channel: {}, signingKey: null, onState: () => {}, timers }).verbose).toBe(true);
    expect(verbosePref(null)).toBe(true);
    expect(verbosePref(undefined)).toBe(true);
    expect(verbosePref({})).toBe(true);
    expect(verbosePref({ verbose: true })).toBe(true);
    expect(verbosePref({ verbose: false })).toBe(false);
    // anything else that is not an explicit false is the default
    expect(verbosePref({ verbose: "no" })).toBe(true);
  });

  it("names no chat while Show thinking live is turned off, however many are opened", async () => {
    const { channel, presence, watches } = channelStub();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, verbose: false, timers });
    expect(sync.verbose).toBe(false);
    sync.start();
    sync.watch("k1");
    await pause(80);
    expect(presence.every((p) => p.watching === null)).toBe(true);
    expect(channel.liveReads).toEqual([]);
    expect(watches).not.toContain("live"); // no stream for the live turn either
    sync.stop();
  });

  it("with it on, names only the chat on screen, follows one live stream, reads through get, and lets go when closed", async () => {
    const { channel, presence, watches } = channelStub();
    channel.turn = { key: "k1", seq: 5, total: 0, steps: [], working: false };
    const heard = [];
    const sync = new Sync({
      channel,
      signingKey: null,
      onState: () => {},
      onLive: (t) => heard.push(t),
      verbose: true,
      timers,
    });
    sync.start();
    expect(presence.at(-1).watching).toBeNull(); // nothing open yet
    sync.watch("k1");
    await pause(80);
    expect(presence.at(-1).watching).toBe("k1");
    expect(watches.filter((p) => p === "live")).toHaveLength(1);
    expect(sync.state.live).toMatchObject({ key: "k1", seq: 5 });
    // A stale write is not shown over a newer one.
    channel.turn = { key: "k1", seq: 4, total: 0, steps: [], working: false };
    await sync.pass();
    expect(sync.state.live.seq).toBe(5);
    sync.watch("k2");
    expect(sync.state.live).toBeNull(); // a turn kept from another chat is out of date
    await pause(80);
    expect(presence.at(-1).watching).toBe("k2");
    sync.watch(null);
    await pause(30);
    expect(presence.at(-1).watching).toBeNull();
    expect(watches).not.toContain("live");
    sync.stop();
    expect(heard.length).toBeGreaterThan(0);
  });

  it("asks for more recent chats only once more is asked for", async () => {
    const { channel, presence } = channelStub();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, timers });
    sync.start();
    await pause(20);
    expect(presence.at(-1).recent).toBe(10);
    sync.showMoreRecent();
    await pause(20);
    expect(presence.at(-1).recent).toBe(30);
    for (let i = 0; i < 5; i++) sync.showMoreRecent();
    expect(sync.recentWanted).toBe(50);
    sync.stop();
  });

  it("a hidden tab holds no live stream and writes no presence; coming back reconnects", async () => {
    const { channel, presence, watches } = channelStub();
    const sync = new Sync({ channel, signingKey: null, onState: () => {}, verbose: true, timers });
    sync.start();
    sync.watch("k1");
    await pause(60);
    expect(watches).toContain("live");
    sync.stop();
    expect(watches).toEqual([]);
    const before = presence.length;
    sync.watch("k2"); // opened while hidden: nothing is written
    sync.setVerbose(false);
    await pause(30);
    expect(presence.length).toBe(before);
    sync.setVerbose(true);
    sync.start();
    await pause(60);
    expect(presence.at(-1).watching).toBe("k2");
    expect(watches).toContain("live");
    sync.stop();
  });
});
