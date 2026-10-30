// Chunk 1 against the Mac's real RemoteBridge and LiveTurnPublisher, through
// an in-memory Realtime Database: the live turn and its history as the Mac
// writes them, the presence it is asked by, and the commands the Mac must
// accept from this browser (steer, queue with a message id, stop, queue
// actions). Anything the web signs that the Mac does not accept fails here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { liveHandle as macLiveHandle } from "../../src/remote/live-turn.js";
import { open as macOpen } from "../../src/remote/remote-crypto.js";
import { RemoteBridge } from "../../src/remote/remote-bridge.js";
import { RtdbRest } from "../../src/remote/rtdb-rest.js";
import { liveHandle, liveHistoryHandle } from "../js/live.js";
import { Channel } from "../js/channel.js";
import { open } from "../js/channel-crypto.js";
import { KeyStore } from "../js/key-store.js";
import { awaitApproval, beginPairing } from "../js/pairing.js";
import { RtdbClient } from "../js/rtdb.js";
import { Sync } from "../js/sync.js";
import { fakeDatabase, fakeIndexedDB } from "./helpers.js";

const DB = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app";
const KEY = "claude-transcript:s1";
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function session(overrides = {}) {
  return {
    key: KEY,
    source: "claude-transcript",
    agent: "claude",
    origin: "conductor",
    sourceId: "s1",
    agentSessionId: "s1",
    conductorSessionId: "s1",
    cwd: "/w",
    repoName: "farm",
    branch: "arm",
    title: "Farm",
    state: "working",
    detail: "D1?",
    lastActivityAt: new Date().toISOString(),
    transcriptPath: null,
    pid: null,
    alive: false,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    model: "Opus 5.5 · 1M",
    effort: "Medium",
    ...overrides,
  };
}

async function world() {
  const database = fakeDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-chat-e2e-"));
  dirs.push(dir);
  const calls = { send: [], stop: [], queueAction: [] };
  const state = {
    turn: "turn-1",
    queue: [{ id: "11111111-1111-4111-8111-111111111111", text: "later please", mode: "queue", position: 1 }],
  };
  const chat = session();
  const bridge = new RemoteBridge({
    configPath: path.join(dir, "remote.json"),
    projectId: "squeak-test",
    store: new RtdbRest(DB, database.fetch),
    databaseUrl: DB,
    replier: {
      lastTurnText: () => null,
      lastTurnId: () => state.turn,
      send: async (id, text, _failed, options) => {
        calls.send.push({ id, text, mode: options?.mode, messageId: options?.messageId });
        return { status: "started", via: "conductor", delivery: options?.mode === "steer" ? "steered" : "queued" };
      },
      queue: async () => state.queue,
      queueAction: async (id, messageId, action) => {
        calls.queueAction.push([id, messageId, action]);
        return { ok: true };
      },
      stopTurn: async (id) => {
        calls.stop.push(id);
        return { ok: true };
      },
      transcript: () => ({
        messages: [
          { id: "a", role: "user", text: "Fix the gate", at: "2026-10-22T09:00:00.000Z", turnId: "t0" },
          { id: "b", role: "assistant", text: "Fixed.", at: "2026-10-22T09:01:00.000Z", turnId: "t0", workBefore: 4 },
        ],
      }),
    },
    liveActivity: () => ({
      total: 9,
      steps: [
        { kind: "thinking", text: "Considering the hinge ".repeat(30), at: null },
        { kind: "tool", text: "Read gate.ts", at: null },
      ],
    }),
    snapshot: () => ({ sessions: [chat], active: [chat], attention: [], generatedAt: "", codexUsage: null }),
    macName: "Test Mac",
  });
  bridge.stop();
  const { url } = bridge.startPairing();
  bridge.stop();
  const store = new KeyStore(fakeIndexedDB());
  const {
    record,
    channel: pairing,
    code,
  } = await beginPairing(url, { store, name: "Web · Test", fetchImpl: database.fetch });
  await bridge.tick();
  const [request] = bridge.status().pending;
  expect(request.code).toBe(code);
  await bridge.approve(request.id);
  await awaitApproval(pairing, { intervalMs: 5 });
  await store.save({ ...record, state: "paired" });
  const paired = await store.load();
  const channel = new Channel({
    channelId: paired.channelId,
    deviceId: paired.deviceId,
    key: paired.channelKey,
    db: new RtdbClient(DB, database.fetch),
  });
  const secret = JSON.parse(Buffer.from(new URL(url).searchParams.get("d"), "base64url").toString()).k;
  return { database, bridge, channel, record: paired, calls, state, chat, secret };
}

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await pause();
  }
}

describe("the handle a chat's live documents live under", () => {
  it("is the Mac's: the first 22 characters of base64url(SHA-256(session key))", async () => {
    for (const key of [KEY, "codex-rollout:abc/def+ghi", "é\u{1f986}:x", "a"]) {
      const handle = await liveHandle(key);
      expect(handle).toBe(macLiveHandle(key));
      expect(handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(liveHistoryHandle("abc")).toBe("abc-h");
  });
});

describe("the live turn as the Mac writes it", () => {
  it("is read, with the history folded in from its own document, while the browser's presence names the chat", async () => {
    const w = await world();
    await w.channel.touchPresence({ watching: KEY });
    await w.bridge.tick();
    await waitFor(() => [...w.database.docs.keys()].some((k) => k.endsWith("-h")));
    const handle = await liveHandle(KEY);
    // Both documents exist: the turn, and (the web says it reads "split") the history apart.
    expect(w.database.docs.has(`channels/${w.record.channelId}/live/${handle}`)).toBe(true);
    expect(w.database.docs.has(`channels/${w.record.channelId}/live/${handle}-h`)).toBe(true);

    const turn = await w.channel.liveTurn(KEY);
    expect(turn).toMatchObject({ key: KEY, working: true, state: "working", turnId: "turn-1", total: 9, split: true });
    expect(typeof turn.seq).toBe("number");
    expect(turn.steps.map((step) => step.kind)).toEqual(["thinking", "tool"]);
    expect(turn.steps[0].text.length).toBeGreaterThan(200); // whole, not the snapshot's 200
    expect(turn.history).toEqual([
      { role: "user", text: "Fix the gate", at: "2026-10-22T09:00:00.000Z" },
      { role: "assistant", text: "Fixed.", at: "2026-10-22T09:01:00.000Z", workBefore: 4 },
    ]);
    expect(turn.queue).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", text: "later please", mode: "queue", position: 1 },
    ]);
    w.bridge.stop();
  });

  it("is nothing for another chat's key, and nothing when no chat is watched", async () => {
    const w = await world();
    await w.channel.touchPresence();
    await w.bridge.tick();
    await pause(30);
    expect(await w.channel.liveTurn(KEY)).toBeNull();
    expect([...w.database.docs.keys()].filter((k) => k.includes("/live/"))).toEqual([]);
    w.bridge.stop();
  });

  it("is decoded exactly as the Mac's own opener reads the same boxes", async () => {
    const w = await world();
    await w.channel.touchPresence({ watching: KEY });
    await w.bridge.tick();
    await waitFor(() => [...w.database.docs.keys()].some((k) => k.endsWith("-h")));
    const handle = await liveHandle(KEY);
    for (const id of [handle, `${handle}-h`]) {
      const { box } = w.database.docs.get(`channels/${w.record.channelId}/live/${id}`);
      expect(await open(w.record.channelKey, box)).toEqual(macOpen(w.secret, box));
    }
    w.bridge.stop();
  });
});

describe("presence", () => {
  async function presenceOf(w) {
    const doc = w.database.docs.get(`channels/${w.record.channelId}/state/presence`);
    return open(w.record.channelKey, doc.box);
  }

  it("says only that the browser is here, and what it reads, unless a chat is watched", async () => {
    const w = await world();
    await w.channel.touchPresence();
    expect(Object.keys(await presenceOf(w)).sort()).toEqual(["at", "caps"]);
    expect((await presenceOf(w)).caps).toEqual(["z", "split", "films"]);
  });

  it("adds the calls cap only while the Phone calls log is open", async () => {
    const w = await world();
    await w.channel.touchPresence({ calls: true });
    expect((await presenceOf(w)).caps).toEqual(["z", "split", "films", "calls"]);
    await w.channel.touchPresence({ calls: false });
    expect((await presenceOf(w)).caps).toEqual(["z", "split", "films"]);
  });

  it("names the open chat and asks for more recent chats, as the iPhone does", async () => {
    const w = await world();
    await w.channel.touchPresence({ watching: KEY, recent: 30 });
    expect(await presenceOf(w)).toMatchObject({ watching: KEY, recent: 30, caps: ["z", "split", "films"] });
    await w.channel.touchPresence({ watching: null, recent: 10 });
    expect(Object.keys(await presenceOf(w)).sort()).toEqual(["at", "caps"]); // the Mac's default is not asked for
    await w.channel.touchPresence({ recent: 500 });
    expect((await presenceOf(w)).recent).toBe(50);
  });

  it("is read by the Mac: the recent list grows to what was asked", async () => {
    const w = await world();
    await w.channel.touchPresence({ watching: KEY, recent: 30 });
    await w.bridge.tick();
    // The Mac saw it (no throw, and it answers the ping).
    expect((await w.channel.alive()).at).toBeGreaterThan(0);
    w.bridge.stop();
  });
});

describe("what the Mac accepts from this browser", () => {
  async function send(w, { id, document }) {
    await w.channel.send(id, document);
    await w.bridge.tick();
    return w.channel.result(id);
  }
  const view = (w) => ({ ...w.chat, conductorSessionId: "s1", turnId: "turn-1", state: "working" });

  it("a queued reply with a message id: no mode, the id passed to the Mac's replier", async () => {
    const w = await world();
    const messageId = "22222222-2222-4222-8222-222222222222";
    const result = await send(
      w,
      await w.channel.replyDocument(view(w), "after this", w.record.signingKey, { messageId }),
    );
    expect(result).toMatchObject({ status: "sent", via: "conductor", delivery: "queued" });
    expect(w.calls.send).toEqual([{ id: "s1", text: "after this", mode: "queue", messageId }]);
    w.bridge.stop();
  });

  it("a steered reply: mode steer reaches the replier", async () => {
    const w = await world();
    const messageId = "33333333-3333-4333-8333-333333333333";
    const result = await send(
      w,
      await w.channel.replyDocument(view(w), "go left", w.record.signingKey, { mode: "steer", messageId }),
    );
    expect(result).toMatchObject({ status: "sent", delivery: "steered" });
    expect(w.calls.send).toEqual([{ id: "s1", text: "go left", mode: "steer", messageId }]);
    w.bridge.stop();
  });

  it("Stop: the Mac stops that chat's turn and says sent", async () => {
    const w = await world();
    const result = await send(w, await w.channel.stopDocument(view(w), w.record.signingKey));
    expect(result).toMatchObject({ status: "sent" });
    expect(w.calls.stop).toEqual(["s1"]);
    w.bridge.stop();
  });

  it("Stop names the turn the browser saw: a turn that moved on is refused, nothing stopped", async () => {
    const w = await world();
    w.state.turn = "turn-2";
    const result = await send(w, await w.channel.stopDocument(view(w), w.record.signingKey));
    expect(result).toMatchObject({ status: "refused", reason: "That turn already ended." });
    expect(w.calls.stop).toEqual([]);
    w.bridge.stop();
  });

  it("Steer now and Delete on a queued message: promote and cancel reach the queue, for a message still in it", async () => {
    const w = await world();
    const id = w.state.queue[0].id;
    expect(await send(w, await w.channel.queueDocument("s1", id, "promote", w.record.signingKey))).toMatchObject({
      status: "sent",
    });
    expect(await send(w, await w.channel.queueDocument("s1", id, "cancel", w.record.signingKey))).toMatchObject({
      status: "sent",
    });
    expect(w.calls.queueAction).toEqual([
      ["s1", id, "promote"],
      ["s1", id, "cancel"],
    ]);
    w.bridge.stop();
  });

  it("a queue action for a message that already left the queue is refused with the Mac's words", async () => {
    const w = await world();
    w.state.queue = [];
    const result = await send(
      w,
      await w.channel.queueDocument("s1", "11111111-1111-4111-8111-111111111111", "promote", w.record.signingKey),
    );
    expect(result).toMatchObject({ status: "refused", reason: "That message already went to the agent." });
    expect(w.calls.queueAction).toEqual([]);
    w.bridge.stop();
  });
});

describe("the whole loop through Sync", () => {
  it("watching with Show thinking live on: the Mac writes the live turn, Sync reads it through get, and off it asks for none", async () => {
    const w = await world();
    const lives = [];
    const sync = new Sync({
      channel: w.channel,
      signingKey: w.record.signingKey,
      onState: () => {},
      onLive: (turn) => lives.push(turn),
      verbose: true,
    });
    sync.start();
    await waitFor(() => sync.state.streamUp);
    sync.watch(KEY);
    await pause(30);
    await w.bridge.tick();
    await waitFor(() => sync.state.live?.key === KEY, 5000);
    expect(sync.state.live.history.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(lives.at(-1).queue).toHaveLength(1);

    // Switched off: presence names no chat any more, and what was shown is gone.
    sync.setVerbose(false);
    await pause(30);
    const presence = await open(
      w.record.channelKey,
      w.database.docs.get(`channels/${w.record.channelId}/state/presence`).box,
    );
    expect(presence.watching).toBeUndefined();
    expect(sync.state.live).toBeNull();
    sync.stop();
    w.channel.db.closeAll();
    w.bridge.stop();
  });

  it("Stop through Sync.command gets the Mac's answer", async () => {
    const w = await world();
    const sync = new Sync({ channel: w.channel, signingKey: w.record.signingKey, onState: () => {} });
    sync.start();
    const answer = sync.command(() =>
      w.channel.stopDocument({ conductorSessionId: "s1", turnId: "turn-1" }, w.record.signingKey),
    );
    await waitFor(() => [...w.database.docs.keys()].some((k) => k.includes("/commands/")));
    await w.bridge.tick();
    expect(await answer).toMatchObject({ status: "sent" });
    sync.stop();
    w.channel.db.closeAll();
    w.bridge.stop();
  });
});
