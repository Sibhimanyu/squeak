import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox, type MemoTarget } from "./memo-inbox.js";
import { dirPath, readDirectory } from "./memo-protocol.js";
import { applyPhoneVoiceChange } from "./phone-voice.js";
import { readCallFlagChange, VoiceSettingsStore } from "./settings.js";

describe("call-in flags in the settings store", () => {
  const fresh = () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voice-settings-")), "voice-settings.json");
    return { file, store: new VoiceSettingsStore(file) };
  };

  it("defaults: no waiting-chat offer, menus by voice", () => {
    const { store } = fresh();
    expect(store.offerWaitingChat()).toBe(false);
    expect(store.menusByVoice()).toBe(true);
  });

  it("reads exactly one key, a strict boolean", () => {
    expect(readCallFlagChange({ offerWaitingChat: true })).toEqual({ key: "offerWaitingChat", value: true });
    expect(readCallFlagChange({ menusByVoice: false })).toEqual({ key: "menusByVoice", value: false });
    for (const bad of [
      { offerWaitingChat: "true" },
      { menusByVoice: 1 },
      { menusByVoice: null },
      { offerWaitingChat: true, menusByVoice: false },
      { offerWaitingChat: true, callee: "101" },
      {},
      [],
      null,
    ]) {
      expect(readCallFlagChange(bad)).toBeNull();
    }
  });

  it("saves, survives other changes and a restart, and refuses a bad request without changing anything", () => {
    const { file, store } = fresh();
    expect(store.apply({ offerWaitingChat: true }).ok).toBe(true);
    expect(store.apply({ menusByVoice: false }).ok).toBe(true);
    expect(store.apply({ callee: "103" }).ok).toBe(true);
    expect(store.apply({ hold: { graceSeconds: 60 } }).ok).toBe(true);
    expect(store.apply({ pause: "1h" }).ok).toBe(true);
    expect(store.apply({ offerWaitingChat: "yes" }).ok).toBe(false);
    expect(store.apply({ offerWaitingChat: true, menusByVoice: true }).ok).toBe(false);
    expect(store.apply({ hold: { graceSeconds: 70 }, menusByVoice: true }).ok).toBe(false);
    const again = new VoiceSettingsStore(file);
    expect(again.offerWaitingChat()).toBe(true);
    expect(again.menusByVoice()).toBe(false);
    expect(again.settings.callee).toBe("103");
    expect(again.pause()).not.toBeNull();
  });

  it("the phone's change object passes through the phone helper untouched and ends in the same apply", () => {
    const { store } = fresh();
    const ctx = {
      natural: { installed: () => true, apply: () => ({ ok: true as const }) },
      favorites: { apply: () => ({ ok: true as const, favorites: [] }) },
      knownWorkspaces: () => new Set<string>(),
      currentFavorites: () => [],
    };
    const change = { menusByVoice: false };
    expect(applyPhoneVoiceChange(change, ctx)).toBeNull();
    expect(store.apply(change).ok).toBe(true);
    expect(store.menusByVoice()).toBe(false);
  });
});

describe("the call-in directory and the flags", () => {
  const { channelId: channel, key } = generateChannel();
  const clock = 1_800_000_000_000;
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let offer = false;
  let voiceMenus = false;
  let targets: MemoTarget[];

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    offer = false;
    voiceMenus = false;
    targets = [
      { target: "c1", label: "squeak · voice", workspace: null },
      { target: "c2", label: "blume · hub", workspace: null },
    ];
    inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "x" },
      targets: () => targets,
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      lastChat: { get: () => "c1", set: () => undefined },
      offerWaitingChat: () => offer,
      pickByVoice: () => voiceMenus,
      note: () => undefined,
      now: () => clock,
    });
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  const directory = async () => readDirectory(key, (await store.get(dirPath(channel)))!, clock)!;

  it("offers the newest chat waiting only while the flag is on, and never the last one used", async () => {
    targets[1]!.waiting = true;
    await inbox.publish();
    expect((await directory()).last).toBeUndefined();
    offer = true;
    await inbox.publish();
    expect((await directory()).last).toMatchObject({ label: "blume · hub", why: "waiting" });
    targets[1]!.waiting = false;
    await inbox.publish();
    expect((await directory()).last).toBeUndefined();
  });

  it("sets pickByVoice only while menus are by voice", async () => {
    await inbox.publish();
    expect((await directory()).pickByVoice).toBeUndefined();
    voiceMenus = true;
    await inbox.publish();
    expect((await directory()).pickByVoice).toBe(true);
    voiceMenus = false;
    await inbox.publish();
    expect((await directory()).pickByVoice).toBeUndefined();
  });
});
