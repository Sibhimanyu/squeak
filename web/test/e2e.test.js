// The browser's protocol modules against the Mac's real RemoteBridge, through
// a Realtime Database that lives in memory (REST and streams both). Like
// scripts/e2e-remote.ts, with the browser in place of the Swift phone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RemoteBridge } from "../../src/remote/remote-bridge.js";
import { RtdbRest } from "../../src/remote/rtdb-rest.js";
import { Channel } from "../js/channel.js";
import { generateDeviceKey, importChannelKey } from "../js/channel-crypto.js";
import { KeyStore } from "../js/key-store.js";
import { awaitApproval, beginPairing, channelFor } from "../js/pairing.js";
import { RtdbClient } from "../js/rtdb.js";
import { Sync } from "../js/sync.js";
import { fakeDatabase, fakeIndexedDB } from "./helpers.js";

const DB = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app";
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function session(overrides = {}) {
  return {
    key: "claude-transcript:s1",
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
    state: "finished",
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
    ...overrides,
  };
}

function world({ renamer, projectIcons } = {}) {
  const database = fakeDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-e2e-"));
  dirs.push(dir);
  const sends = [];
  const state = { turn: "turn-1" };
  const chat = session();
  const bridge = new RemoteBridge({
    configPath: path.join(dir, "remote.json"),
    projectId: "squeak-test",
    store: new RtdbRest(DB, database.fetch),
    databaseUrl: DB,
    replier: {
      lastTurnText: () => "**D1: Arm it?**\n\n**A) Now.** a\n**B) Later.** b",
      lastTurnId: () => state.turn,
      send: async (id, text, _onFailed, options) => {
        sends.push([id, text, options?.mode]);
        return { status: "started", via: "conductor", delivery: "sent" };
      },
    },
    snapshot: () => ({ sessions: [chat], active: [chat], attention: [], generatedAt: "", codexUsage: null }),
    macName: "Test Mac",
    ...(renamer ? { renamer } : {}),
    ...(projectIcons ? { projectIcons } : {}),
  });
  bridge.stop();
  const { url } = bridge.startPairing();
  bridge.stop();
  const store = new KeyStore(fakeIndexedDB());
  return { database, bridge, url, sends, state, store };
}

async function pairedWeb(w) {
  const { record, channel, code } = await beginPairing(w.url, {
    store: w.store,
    name: "Web · Test",
    fetchImpl: w.database.fetch,
  });
  await w.bridge.tick();
  const [request] = w.bridge.status().pending;
  expect(request.code).toBe(code);
  expect(request.name).toBe("Web · Test");
  await w.bridge.approve(request.id);
  const answer = await awaitApproval(channel, { intervalMs: 5 });
  expect(answer).toEqual({ approved: true, mac: "Test Mac" });
  await w.store.save({ ...record, state: "paired" });
  return { record: await w.store.load(), channel };
}

describe("pairing the browser with a real Mac bridge", () => {
  it("shows the same six digits on both screens and is paired once the Mac approves", async () => {
    const w = world();
    const { record } = await pairedWeb(w);
    expect(record.state).toBe("paired");
    expect(record.channelKey.extractable).toBe(false);
    expect(record.signingKey.extractable).toBe(false);
    // The channel secret never reached the database or the saved record as a string.
    const secret = JSON.parse(Buffer.from(new URL(w.url).searchParams.get("d"), "base64url").toString()).k;
    expect(JSON.stringify([...w.database.docs.values()])).not.toContain(secret);
    expect(
      JSON.stringify(record, (_k, v) => (typeof v === "object" && v && "algorithm" in v ? "[CryptoKey]" : v)),
    ).not.toContain(secret);
  });

  it("is told no when the Mac declines", async () => {
    const w = world();
    const { channel } = await beginPairing(w.url, { store: w.store, name: "Web · Test", fetchImpl: w.database.fetch });
    await w.bridge.tick();
    await w.bridge.reject(w.bridge.status().pending[0].id);
    expect(await awaitApproval(channel, { intervalMs: 5 })).toEqual({ approved: false, mac: "Test Mac" });
  });

  it("is refused by the Mac's approval list until approved: no result, not even a refusal", async () => {
    const w = world();
    const { record, channel } = await beginPairing(w.url, {
      store: w.store,
      name: "Web · Test",
      fetchImpl: w.database.fetch,
    });
    const { id, document } = await channel.replyDocument(
      { conductorSessionId: "s1", turnId: "turn-1" },
      "A",
      record.signingKey,
    );
    await channel.send(id, document);
    await w.bridge.tick();
    expect(w.sends).toEqual([]);
    expect(await channel.result(id)).toBeNull();
  });
});

describe("a paired browser", () => {
  it("reads the view the Mac publishes (compressed and split, as the iPhone's caps ask) and replies", async () => {
    const w = world();
    const { record, channel } = await pairedWeb(w);
    await channel.touchPresence();
    await w.bridge.tick();
    const view = await channel.view();
    expect(view.mac).toBe("Test Mac");
    expect(view.sessions[0]).toMatchObject({ conductorSessionId: "s1", state: "finished", turnId: "turn-1" });
    expect(view.sessions[0].message).toContain("Arm it?");
    expect(view.sessions[0].choices.options.map((o) => o.letter)).toEqual(["A", "B"]);
    expect(Array.isArray(view.recent)).toBe(true); // folded back in from state/recent

    const { id, document } = await channel.replyDocument(view.sessions[0], "B", record.signingKey);
    await channel.send(id, document);
    await w.bridge.tick();
    expect(w.sends).toEqual([["s1", "B", "queue"]]);
    expect(await channel.result(id)).toMatchObject({ id, status: "sent", via: "conductor", delivery: "sent" });
  });

  it("folds the recent document's project icons into the view, for Home's marks", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHpyVfQAAAABJRU5ErkJggg==";
    const w = world({ projectIcons: () => ({ farm: png }) });
    const { channel } = await pairedWeb(w);
    await channel.touchPresence();
    await w.bridge.tick();
    expect((await channel.view()).projectIcons).toEqual({ farm: png });
  });

  it("answers the Mac's presence ping and sees it alive", async () => {
    const w = world();
    const { channel } = await pairedWeb(w);
    await channel.touchPresence();
    await w.bridge.tick();
    expect((await channel.alive()).at).toBeGreaterThan(0);
  });

  it("is woken by the stream, reads through the store, and gets the Mac's answer to a reply", async () => {
    const w = world();
    const { record, channel } = await pairedWeb(w);
    const states = [];
    const sync = new Sync({ channel, signingKey: record.signingKey, onState: (s) => states.push(s) });
    sync.start();
    await waitFor(() => sync.state.streamUp);
    await channel.touchPresence();
    await w.bridge.tick();
    await waitFor(() => sync.state.view?.sessions?.length === 1);
    const answer = sync.reply(sync.state.view.sessions[0], "A");
    await waitFor(() => w.database.docs.size > 0 && [...w.database.docs.keys()].some((k) => k.includes("/commands/")));
    await w.bridge.tick();
    expect(await answer).toMatchObject({ status: "sent", delivery: "sent" });
    expect(w.sends).toEqual([["s1", "A", "queue"]]);
    // The result was cleaned up after it was read.
    await waitFor(() => ![...w.database.docs.keys()].some((k) => k.includes("/results/") && !k.includes("pair-")));
    sync.stop();
    channel.db.closeAll();
  });
});

describe("renaming a chat from the browser", () => {
  it("is accepted by the Mac's real bridge: signed, fresh, for a chat it shows, and the new name reaches Conductor", async () => {
    const renamed = [];
    const w = world({ renamer: { rename: (id, title) => (renamed.push([id, title]), true) } });
    const { record, channel } = await pairedWeb(w);
    const view = { conductorSessionId: "s1", label: "farm · arm" };
    const { id, document } = await channel.renameDocument(view, "  Irrigation\tpull   to refresh  ", record.signingKey);
    await channel.send(id, document);
    await w.bridge.tick();
    // One plain line: the Mac trims and folds the whitespace itself.
    expect(renamed).toEqual([["s1", "Irrigation pull to refresh"]]);
    expect(await channel.result(id)).toMatchObject({ id, status: "sent" });
  });

  it("is refused with the Mac's own words when Conductor does not take it, and for a chat it does not show", async () => {
    const w = world({ renamer: { rename: () => false } });
    const { record, channel } = await pairedWeb(w);
    const refused = await channel.renameDocument({ conductorSessionId: "s1" }, "New name", record.signingKey);
    await channel.send(refused.id, refused.document);
    const gone = await channel.renameDocument({ conductorSessionId: "nope" }, "New name", record.signingKey);
    await channel.send(gone.id, gone.document);
    await w.bridge.tick();
    expect(await channel.result(refused.id)).toMatchObject({
      status: "refused",
      reason: "Conductor didn't take the new name.",
    });
    expect(await channel.result(gone.id)).toMatchObject({
      status: "refused",
      reason: "That chat isn't on your phone any more.",
    });
  });

  it("is ignored from a key the Mac never approved", async () => {
    const renamed = [];
    const w = world({ renamer: { rename: (id, title) => (renamed.push([id, title]), true) } });
    const { channel } = await pairedWeb(w);
    const stranger = await generateDeviceKey();
    const { id, document } = await channel.renameDocument({ conductorSessionId: "s1" }, "Hijack", stranger.privateKey);
    await channel.send(id, document);
    await w.bridge.tick();
    expect(renamed).toEqual([]);
    expect(await channel.result(id)).toBeNull();
  });
});

describe("what the Mac refuses from the browser", () => {
  async function replyWith(w, { session: target, text = "B", now, key } = {}) {
    const { record } = await pairedWeb(w);
    const channel = new Channel({
      channelId: record.channelId,
      deviceId: record.deviceId,
      key: record.channelKey,
      db: new RtdbClient(DB, w.database.fetch),
      now,
    });
    const doc = await channel.replyDocument(
      target ?? { conductorSessionId: "s1", turnId: "turn-1" },
      text,
      key ?? record.signingKey,
    );
    return { channel, record, ...doc };
  }

  it("refuses a reply to a turn the chat has moved past", async () => {
    const w = world();
    w.state.turn = "turn-2";
    const { channel, id, document } = await replyWith(w);
    await channel.send(id, document);
    await w.bridge.tick();
    expect(w.sends).toEqual([]);
    expect(await channel.result(id)).toMatchObject({ status: "refused" });
  });

  it("refuses a replayed command (same nonce, new document id)", async () => {
    const w = world();
    const { channel, id, document } = await replyWith(w);
    await channel.send(id, document);
    await w.bridge.tick();
    await channel.send("11111111-1111-4111-8111-111111111111", document);
    await w.bridge.tick();
    expect(w.sends).toHaveLength(1);
    expect(await channel.result("11111111-1111-4111-8111-111111111111")).toMatchObject({ status: "refused" });
  });

  it("refuses a command that expired, and one that lives too long", async () => {
    const w = world();
    const old = await replyWith(w, { now: () => Date.now() - 11 * 60_000 });
    await old.channel.send(old.id, old.document);
    const long = await old.channel.replyDocument(
      { conductorSessionId: "s1", turnId: "turn-1" },
      "B",
      old.record.signingKey,
    );
    const far = new Channel({
      channelId: old.record.channelId,
      deviceId: old.record.deviceId,
      key: old.record.channelKey,
      db: old.channel.db,
      now: () => Date.now() + 30 * 60_000,
    });
    const tooFar = await far.replyDocument({ conductorSessionId: "s1", turnId: "turn-1" }, "B", old.record.signingKey);
    await far.send(tooFar.id, tooFar.document);
    void long;
    await w.bridge.tick();
    expect(await old.channel.result(old.id)).toMatchObject({ status: "refused" });
    expect(await old.channel.result(tooFar.id)).toMatchObject({ status: "refused" });
    expect(w.sends).toEqual([]);
  });

  it("ignores a command signed by a key the Mac never approved, or changed after signing", async () => {
    const w = world();
    const stranger = await generateDeviceKey();
    const first = await replyWith(w, { key: stranger.privateKey });
    await first.channel.send(first.id, first.document);
    const second = await first.channel.replyDocument(
      { conductorSessionId: "s1", turnId: "turn-1" },
      "B",
      first.record.signingKey,
    );
    const tampered = {
      ...second.document,
      box:
        second.document.box.slice(0, 40) +
        (second.document.box[40] === "A" ? "B" : "A") +
        second.document.box.slice(41),
    };
    await first.channel.send(second.id, tampered);
    await w.bridge.tick();
    expect(w.sends).toEqual([]);
    expect(await first.channel.result(first.id)).toBeNull();
    expect(await first.channel.result(second.id)).toBeNull();
  });

  it("is a different channel's problem: a key from another channel opens nothing here", async () => {
    const w = world();
    const { record } = await pairedWeb(w);
    const other = await importChannelKey(Buffer.alloc(32, 3).toString("base64"));
    const db = new RtdbClient(DB, w.database.fetch);
    const channel = new Channel({ channelId: record.channelId, deviceId: "x", key: other, db });
    await expect(channel.view()).resolves.toBeNull(); // nothing published yet
    await w.bridge.tick();
    await channelFor(record, { fetchImpl: w.database.fetch }).touchPresence();
    await w.bridge.tick();
    await expect(channel.view()).rejects.toThrow();
  });
});

async function waitFor(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
