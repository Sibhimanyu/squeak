import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { addonSupports, NEW_CHAT_ADDON } from "./addon-update.js";
import {
  handleIncoming,
  inboundPrompts,
  newChatPrompt,
  newChatReadBack,
  type InboundDependencies,
} from "./inbound-flow.js";
import { MemoInbox, NEW_CHAT_SAYS, spokenModelLabel, type MemoInboxDependencies } from "./memo-inbox.js";
import {
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  readUp,
  sealDirectory,
  sealDown,
  sealUp,
  upPath,
  type DirectoryDoc,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";
import type { IncomingCall, PhoneCall } from "./phone.js";
import { NEW_CHAT_LEVEL_REFUSAL, NEW_CHAT_MODEL_GONE_REFUSAL, VoiceSettingsStore } from "./settings.js";
import { talkFlow } from "./talk-flow.js";
import type { Uplink } from "./uplink.js";

const { channelId: channel, key } = generateChannel();
const NOW = 1_800_000_000_000;

describe("the version gate", () => {
  it("offers a new chat only to an add-on of 0.18.0 or newer", () => {
    expect(NEW_CHAT_ADDON).toBe("0.18.0");
    expect(addonSupports("0.17.0", NEW_CHAT_ADDON)).toBe(false);
    expect(addonSupports("0.17.9", NEW_CHAT_ADDON)).toBe(false);
    expect(addonSupports("0.18.0", NEW_CHAT_ADDON)).toBe(true);
    expect(addonSupports("0.19.1", NEW_CHAT_ADDON)).toBe(true);
    expect(addonSupports(null, NEW_CHAT_ADDON)).toBe(false);
    expect(addonSupports("unknown", NEW_CHAT_ADDON)).toBe(false);
  });
});

describe("the new chat messages (readUp, readDirectory, readDown)", () => {
  const read = (message: Record<string, unknown>, opts: { at?: number; sealKey?: string; now?: number } = {}) => {
    const id = "m1";
    const at = opts.at ?? NOW;
    const doc = sealUp(opts.sealKey ?? key, { v: 1, id, at, expiresAt: at + 60_000, ...message } as UpMessage);
    return readUp(key, id, doc, opts.now ?? NOW);
  };
  const newchat = { kind: "newchat", dirVersion: "v1", workspace: 2, audio: "QUJD" };
  const start = { kind: "start", memoId: "memo1" };

  it("accepts a well-formed newchat and start", () => {
    expect(read(newchat)).toMatchObject({ ok: true, message: { kind: "newchat", workspace: 2, dirVersion: "v1" } });
    expect(read(start)).toMatchObject({ ok: true, message: { kind: "start", memoId: "memo1" } });
    expect(read({ ...start, callId: "call-abc1", audio: "QUJD" })).toMatchObject({
      ok: true,
      message: { callId: "call-abc1", audio: "QUJD" },
    });
  });

  it("refuses what another key sealed, what expired, and what comes from the future", () => {
    for (const message of [newchat, start]) {
      expect(read(message, { sealKey: generateChannel().key })).toMatchObject({ ok: false });
      expect(read(message, { at: NOW - 3_600_000 })).toEqual({ ok: false, reason: "expired" });
      expect(read(message, { at: NOW + 3_600_000 })).toEqual({ ok: false, reason: "expired" });
    }
  });

  it("refuses an id that is not the document's, and a message that lives too long", () => {
    const doc = sealUp(key, { v: 1, id: "m1", at: NOW, expiresAt: NOW + 60_000, ...newchat } as UpMessage);
    expect(readUp(key, "other", doc, NOW)).toMatchObject({ ok: false });
    const long = sealUp(key, { v: 1, id: "m1", at: NOW, expiresAt: NOW + 3_600_000, ...start } as UpMessage);
    expect(readUp(key, "m1", long, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a newchat with a bad workspace, version or recording", () => {
    for (const bad of [
      { ...newchat, workspace: 0 },
      { ...newchat, workspace: 10 },
      { ...newchat, workspace: 1.5 },
      { ...newchat, workspace: "1" },
      { ...newchat, dirVersion: "" },
      { ...newchat, dirVersion: "x".repeat(65) },
      { ...newchat, dirVersion: 3 },
      { ...newchat, audio: "" },
      { ...newchat, audio: "A".repeat(450_001) },
      { ...newchat, audio: 7 },
    ]) {
      expect(read(bad)).toMatchObject({ ok: false });
    }
  });

  it("refuses a start with a bad memo id, call id or recording", () => {
    for (const bad of [
      { ...start, memoId: "" },
      { ...start, memoId: "x".repeat(65) },
      { ...start, memoId: 4 },
      { ...start, callId: "a b" },
      { ...start, callId: "ab" },
      { ...start, callId: 5 },
      { ...start, audio: "" },
      { ...start, audio: "A".repeat(450_001) },
      { ...start, audio: 1 },
    ]) {
      expect(read(bad)).toMatchObject({ ok: false });
    }
  });

  it("reads a directory's newChat index strictly", () => {
    const doc = (newChat: unknown): DirectoryDoc | null => {
      const sealed = sealDirectory(key, {
        v: 1,
        at: NOW,
        version: "v1",
        caller: "1",
        items: [],
        workspaces: [{ n: 1, label: "a", chats: [], newChat: newChat as number }],
      });
      return readDirectory(key, sealed, NOW);
    };
    expect(doc(3)?.workspaces?.[0]?.newChat).toBe(3);
    expect(doc(undefined)?.workspaces?.[0]).not.toHaveProperty("newChat");
    for (const bad of [0, 10, 1.5, "1", null]) expect(doc(bad)).toBeNull();
  });

  it("reads the transcript's model and the newchat outcome, and drops what does not check out", () => {
    const down = (body: Record<string, unknown>): DownMessage | null => readDown(key, "d1", sealDownRaw(body));
    expect(down({ status: "transcript", text: "hi", label: "a", model: "Opus 5.5" })).toMatchObject({
      model: "Opus 5.5",
    });
    expect(down({ status: "transcript", text: "hi", label: "a", model: 5 })).not.toHaveProperty("model");
    expect(down({ status: "newchat", outcome: "started", text: "Started.", hold: true })).toMatchObject({
      outcome: "started",
      hold: true,
    });
    expect(down({ status: "newchat", outcome: "declined", text: "No.", hold: true })).not.toHaveProperty("hold");
    expect(down({ status: "newchat", outcome: "maybe", text: "x" })).toBeNull();
    expect(down({ status: "newchat", outcome: "started", text: " " })).toBeNull();
  });
});

function sealDownRaw(body: Record<string, unknown>) {
  return sealDown(key, { v: 1, id: "d1", at: NOW, ...body } as unknown as DownMessage);
}

describe("MemoInbox: a new chat from a call", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let clock = NOW;
  let heard = "";
  let supported = true;
  let model: { id: string; level?: string; agent: "claude" | "codex"; label: string } | null = null;
  let startResult: { ok: true; sessionId: string } | { ok: false; reason: string } = { ok: true, sessionId: "sess-9" };
  let holdSupported = false;
  const starts: Array<Parameters<NonNullable<MemoInboxDependencies["newChat"]>["start"]>[0]> = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const traces: Array<[string, string]> = [];
  const known: Record<string, string> = { "ws-a": "cond-a", "ws-b": "cond-b" };

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    clock = NOW;
    heard = "add a dark mode toggle";
    supported = true;
    model = null;
    startResult = { ok: true, sessionId: "sess-9" };
    holdSupported = false;
    starts.length = 0;
    sent.length = 0;
    notes.length = 0;
    traces.length = 0;
    inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => heard },
      targets: () => [
        { target: "c1", label: "chat one", workspace: "ws-a", workspaceLabel: "squeak" },
        { target: "c2", label: "chat two", workspace: "ws-b", workspaceLabel: "blume" },
        { target: "c3", label: "chat three", workspace: "/tmp/not-conductor", workspaceLabel: "elsewhere" },
      ],
      canSend: () => true,
      send: async (target, text) => {
        sent.push(`${target}:${text}`);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      note: (text) => notes.push(text),
      favorites: () => [{ n: 1, workspace: "ws-b", label: "blume" }],
      converse: async () => ({ intent: "unclear", spoken: "" }),
      hold: {
        supported: () => holdSupported,
        state: () => null,
        ended: () => "done",
        peek: () => null,
      },
      newChat: {
        supported: () => supported,
        workspaceId: (workspaceKey) => known[workspaceKey] ?? null,
        model: () => model,
        start: async (args) => {
          starts.push(args);
          return startResult;
        },
      },
      trace: (kind, text) => traces.push([kind, text]),
      now: () => clock,
    });
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  async function directory(): Promise<DirectoryDoc> {
    const doc = await store.get(dirPath(channel));
    return readDirectory(key, doc!, clock)!;
  }
  async function upload(body: Record<string, unknown>, id = newMessageId()): Promise<DownMessage | null> {
    await store.set(
      upPath(channel, id),
      sealUp(key, { v: 1, id, at: clock, expiresAt: clock + 60_000, ...body } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  }
  const audio = Buffer.from("opus").toString("base64");

  async function readBack(workspaceIndex = 1) {
    await inbox.publish();
    const dir = await directory();
    const id = newMessageId();
    const down = await upload({ kind: "newchat", dirVersion: dir.version, workspace: workspaceIndex, audio }, id);
    return { id, dir, down };
  }

  it("gives a workspace Conductor knows a newChat index, and none to one it does not", async () => {
    await inbox.publish();
    const dir = await directory();
    const spaces = dir.workspaces!;
    // Favourite blume is first, then the automatic ones: squeak (known) and elsewhere (not a Conductor workspace).
    expect(spaces.map((w) => [w.label, w.newChat])).toEqual([
      ["blume", 1],
      ["squeak", 2],
      ["elsewhere", undefined],
    ]);
  });

  it("offers it to no add-on older than 0.18.0, and publishes again once it can", async () => {
    supported = false;
    await inbox.publish();
    const before = await directory();
    expect(before.workspaces!.every((w) => w.newChat === undefined)).toBe(true);
    supported = true;
    await inbox.publish();
    const after = await directory();
    expect(after.version).not.toBe(before.version);
    expect(after.workspaces!.some((w) => w.newChat !== undefined)).toBe(true);
  });

  it("offers it to nobody when the Mac has no way to start a chat", async () => {
    const bare = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => heard },
      targets: () => [{ target: "c1", label: "chat one", workspace: "ws-a" }],
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      note: () => undefined,
      favorites: () => [{ n: 1, workspace: "ws-a", label: "squeak" }],
      now: () => clock,
    });
    await bare.publish();
    expect((await directory()).workspaces!.every((w) => w.newChat === undefined)).toBe(true);
    const id = newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, {
        v: 1,
        id,
        at: clock,
        expiresAt: clock + 60_000,
        kind: "newchat",
        dirVersion: (await directory()).version,
        workspace: 1,
        audio,
      } as UpMessage),
    );
    await bare.pass();
    expect(readDown(key, id, (await store.get(downPath(channel, id)))!)).toMatchObject({
      status: "refused",
      reason: NEW_CHAT_SAYS.unavailable,
    });
  });

  it("reads back the words with the workspace and the model, and starts nothing", async () => {
    model = { id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M" };
    const { down } = await readBack(1);
    expect(down).toMatchObject({
      status: "transcript",
      text: "add a dark mode toggle",
      label: "blume",
      model: "Opus 5.5, 1M",
    });
    expect(starts).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("says the usual model when none is set", async () => {
    const { down } = await readBack(1);
    expect(down?.status === "transcript" && down.model).toBeFalsy();
    expect(newChatReadBack("add a dark mode toggle.", "blume", undefined)).toBe(
      "I'll start a new chat in blume with its usual model: add a dark mode toggle. Say yes to start it, or no.",
    );
  });

  it("starts exactly once, with the chosen model and the words read back, on the keypad's yes", async () => {
    model = { id: "opus-5-5-1m", level: "high", agent: "claude", label: "Opus 5.5" };
    const { id } = await readBack(2);
    const down = await upload({ kind: "start", memoId: id });
    expect(down).toMatchObject({ status: "newchat", outcome: "started", text: expect.stringContaining("Started") });
    expect(starts).toEqual([
      {
        workspaceId: "cond-a",
        text: "add a dark mode toggle",
        model: { id: "opus-5-5-1m", agent: "claude", level: "high" },
      },
    ]);
    expect(notes[0]).toContain("Started by phone in squeak");
    // The same start again, or a start for the same read-back, runs nothing more.
    expect(await upload({ kind: "start", memoId: id })).toMatchObject({
      status: "refused",
      reason: NEW_CHAT_SAYS.gone,
    });
    expect(starts).toHaveLength(1);
  });

  it("starts with no model when none is set (the workspace's usual)", async () => {
    const { id } = await readBack(1);
    await upload({ kind: "start", memoId: id });
    expect(starts).toEqual([{ workspaceId: "cond-b", text: "add a dark mode toggle" }]);
  });

  it("does not start on a copy of the same start message", async () => {
    const { id } = await readBack(1);
    const startId = newMessageId();
    await upload({ kind: "start", memoId: id }, startId);
    // Putting the same document back (a replay) is dropped: its id was handled.
    await store.set(
      upPath(channel, startId),
      sealUp(key, { v: 1, id: startId, at: clock, expiresAt: clock + 60_000, kind: "start", memoId: id } as UpMessage),
    );
    await inbox.pass();
    expect(starts).toHaveLength(1);
  });

  it("starts nothing for a memo id it never read back, or for another workspace's list", async () => {
    await inbox.publish();
    expect(await upload({ kind: "start", memoId: "never-heard" })).toMatchObject({ status: "refused" });
    const dir = await directory();
    const stale = await upload({ kind: "newchat", dirVersion: "old-version", workspace: 1, audio });
    expect(stale).toMatchObject({ status: "refused", reason: NEW_CHAT_SAYS.stale });
    const beyond = await upload({ kind: "newchat", dirVersion: dir.version, workspace: 9, audio });
    expect(beyond).toMatchObject({ status: "refused", reason: NEW_CHAT_SAYS.stale });
    expect(starts).toEqual([]);
  });

  it("drops a read-back that aged out", async () => {
    const { id } = await readBack(1);
    clock += 11 * 60_000;
    expect(await upload({ kind: "start", memoId: id })).toMatchObject({
      status: "refused",
      reason: NEW_CHAT_SAYS.gone,
    });
    expect(starts).toEqual([]);
  });

  it("refuses nothing-heard and unreadable recordings without keeping anything to start", async () => {
    heard = "";
    await inbox.publish();
    const dir = await directory();
    const id = newMessageId();
    expect(await upload({ kind: "newchat", dirVersion: dir.version, workspace: 1, audio }, id)).toMatchObject({
      status: "refused",
    });
    expect(await upload({ kind: "start", memoId: id })).toMatchObject({ status: "refused" });
    expect(starts).toEqual([]);
  });

  it("says a fixed sentence when the start fails, and traces the real reason", async () => {
    startResult = { ok: false, reason: "That workspace doesn't exist or is archived." };
    const { id } = await readBack(1);
    expect(await upload({ kind: "start", memoId: id })).toMatchObject({
      status: "refused",
      reason: "Your Mac could not start the chat.",
    });
    expect(traces.some(([kind, text]) => kind === "warn" && text.includes("archived"))).toBe(true);
    expect(notes).toEqual([]);
  });

  it("says the same sentence when the start throws", async () => {
    const { id } = await readBack(1);
    (inbox as unknown as { deps: MemoInboxDependencies }).deps.newChat!.start = async () => {
      throw new Error("relay down");
    };
    expect(await upload({ kind: "start", memoId: id })).toMatchObject({ reason: NEW_CHAT_SAYS.failed });
  });

  it("caps new chats per hour", async () => {
    let last: DownMessage | null = null;
    for (let i = 0; i < 7; i++) {
      const { id } = await readBack(1);
      last = await upload({ kind: "start", memoId: id });
    }
    expect(last).toMatchObject({ status: "refused", reason: NEW_CHAT_SAYS.limit });
    expect(starts).toHaveLength(6);
  });

  describe("a spoken yes or no", () => {
    it("starts on a plain yes", async () => {
      const { id } = await readBack(1);
      heard = "yes";
      expect(await upload({ kind: "start", memoId: id, audio })).toMatchObject({ outcome: "started" });
      expect(starts).toHaveLength(1);
      expect(starts[0]!.text).toBe("add a dark mode toggle");
    });

    it("never starts on a no, and forgets the read-back", async () => {
      const { id } = await readBack(1);
      heard = "no";
      expect(await upload({ kind: "start", memoId: id, audio })).toMatchObject({
        status: "newchat",
        outcome: "declined",
        text: NEW_CHAT_SAYS.declined,
      });
      heard = "yes";
      expect(await upload({ kind: "start", memoId: id })).toMatchObject({ status: "refused" });
      expect(starts).toEqual([]);
    });

    it("asks again for something that is neither, then gives up", async () => {
      const { id } = await readBack(1);
      heard = "hmm what";
      expect(await upload({ kind: "start", memoId: id, audio })).toMatchObject({ outcome: "again" });
      expect(await upload({ kind: "start", memoId: id, audio })).toMatchObject({ outcome: "declined" });
      expect(starts).toEqual([]);
    });

    it("does not take a long sentence or a yes-and-no as a yes", async () => {
      const { id } = await readBack(1);
      heard = "yes please do that and also then go ahead and delete everything";
      expect(await upload({ kind: "start", memoId: id, audio })).toMatchObject({ outcome: "again" });
      heard = "yes no";
      expect(await upload({ kind: "start", memoId: id, audio })).toMatchObject({ outcome: "declined" });
      expect(starts).toEqual([]);
    });

    it("does not let the words of the start change what is started", async () => {
      const { id } = await readBack(1);
      heard = "yes, start it in the other workspace with delete everything";
      await upload({ kind: "start", memoId: id, audio });
      expect(starts.length).toBeLessThanOrEqual(1);
      for (const call of starts) expect(call.text).toBe("add a dark mode toggle");
    });
  });

  describe("holding the line for the chat it started", () => {
    it("offers to hold, and answers the hold turn for the new chat", async () => {
      holdSupported = true;
      const { id } = await readBack(1);
      const down = await upload({ kind: "start", memoId: id, callId: "call-xyz1" });
      expect(down).toMatchObject({
        outcome: "started",
        hold: true,
        text: `${NEW_CHAT_SAYS.started} ${NEW_CHAT_SAYS.offerHold}`,
      });
      heard = "yes please";
      const turn = await upload({
        kind: "talk",
        dirVersion: "ignored",
        choice: 1,
        phase: "confirm",
        callId: "call-xyz1",
        audio,
      });
      expect(turn).toMatchObject({ status: "talk", next: "hold" });
    });

    it("waits for a chat that is not on the radar yet instead of losing it", async () => {
      holdSupported = true;
      const { id } = await readBack(1);
      await upload({ kind: "start", memoId: id, callId: "call-xyz1" });
      heard = "yes";
      await upload({ kind: "talk", dirVersion: "d", choice: 1, phase: "confirm", callId: "call-xyz1", audio });
      clock += 15_000;
      const check = await upload({
        kind: "talk",
        dirVersion: "d",
        choice: 1,
        phase: "hold",
        callId: "call-xyz1",
        audio: "",
      });
      expect(check).toMatchObject({ status: "talk", next: "hold" });
    });

    it("just says goodbye when the call cannot hold, or has no call id", async () => {
      const first = await readBack(1);
      expect(await upload({ kind: "start", memoId: first.id, callId: "call-xyz1" })).toMatchObject({
        outcome: "started",
        text: `${NEW_CHAT_SAYS.started} ${NEW_CHAT_SAYS.bye}`,
      });
      holdSupported = true;
      const second = await readBack(1);
      const down = await upload({ kind: "start", memoId: second.id });
      expect(down?.status === "newchat" && down.hold).toBeUndefined();
    });
  });

  it("spokenModelLabel makes a model fit to be said", () => {
    expect(spokenModelLabel("Opus 5.5 · 1M")).toBe("Opus 5.5, 1M");
    expect(spokenModelLabel("GPT 5.6 Terra")).toBe("GPT 5.6 Terra");
  });
});

/* ------------------------------------------------------------------------------------------- the call */

class FakeCall implements PhoneCall {
  open = true;
  readonly peer = "35210";
  readonly closed = new Promise<void>(() => undefined);
  said: string[] = [];
  redactKeys = false;
  private recs: Array<{ durationMs: number; ended?: "key" | "limit" | "silence" | "no-speech" } | null>;
  constructor(
    private keys: Array<string | null>,
    records: Array<{ durationMs: number; ended?: "key" | "limit" | "silence" | "no-speech" } | null>,
  ) {
    this.recs = records;
  }
  async say(text: string): Promise<void> {
    this.said.push(text);
  }
  async key(): Promise<string | null> {
    const next = this.keys.shift();
    return next === undefined ? null : next;
  }
  async beep(): Promise<void> {
    this.said.push("<beep>");
  }
  async record(): Promise<{
    file: string;
    durationMs: number;
    ended: "key" | "limit" | "silence" | "no-speech";
  } | null> {
    const next = this.recs.shift();
    return next ? { file: "/tmp/new-chat.wav", durationMs: next.durationMs, ended: next.ended ?? "silence" } : null;
  }
  async hangup(): Promise<void> {
    this.open = false;
  }
}

const dir: DirectoryDoc = {
  v: 1,
  at: NOW,
  version: "v1",
  caller: "35210",
  items: [],
  workspaces: [
    { n: 1, label: "squeak", chats: [{ n: 1, label: "chat one", choice: 1 }], newChat: 1 },
    {
      n: 2,
      label: "blume",
      chats: [
        { n: 1, label: "chat two", choice: 2 },
        { n: 2, label: "chat three", choice: 3 },
      ],
      newChat: 2,
    },
    { n: 3, label: "empty", chats: [], newChat: 3 },
    { n: 4, label: "plain", chats: [{ n: 1, label: "chat four", choice: 4 }] },
  ],
};

function flow(
  call: FakeCall,
  options: { transcript?: DownMessage | null; startReply?: DownMessage | null; directory?: DirectoryDoc } = {},
) {
  const log = {
    newChats: [] as Array<{ workspace: number; dirVersion: string }>,
    starts: [] as Array<{ memoId: string; callId?: string | undefined; spoken: boolean }>,
    memos: 0,
    talks: [] as unknown[],
    sends: 0,
    memoIds: [] as string[],
  };
  const transcript: DownMessage | null =
    options.transcript === undefined
      ? {
          v: 1,
          id: "x",
          at: 0,
          status: "transcript",
          text: "add a dark mode toggle",
          label: "blume",
          model: "Opus 5.5",
        }
      : options.transcript;
  const started: DownMessage = {
    v: 1,
    id: "s",
    at: 0,
    status: "newchat",
    outcome: "started",
    text: "Started. It's working on it. Goodbye.",
  };
  const uplink: Omit<Uplink, "talk"> = {
    memo: async () => {
      log.memos += 1;
      return null;
    },
    send: async () => {
      log.sends += 1;
      return null;
    },
    ask: async () => null,
    status: async () => null,
    newChat: async (memoId, workspace, dirVersion) => {
      log.memoIds.push(memoId);
      log.newChats.push({ workspace, dirVersion });
      return transcript;
    },
    start: async (memoId, opts) => {
      log.starts.push({ memoId, callId: opts.callId, spoken: opts.audio !== undefined });
      return options.startReply === undefined ? started : options.startReply;
    },
  };
  const incoming: IncomingCall = {
    peer: "35210",
    uri: "sip:35210@pbx",
    answer: async () => call,
    reject: async () => undefined,
  };
  const deps: InboundDependencies = {
    pin: () => null,
    directory: async () => options.directory ?? dir,
    uplink,
    encode: async () => Buffer.from("opus"),
    talk: async (_call, info) => {
      log.talks.push(info);
      return "ended";
    },
  };
  return { incoming, deps, log };
}

describe("call in: a new chat", () => {
  const speech = { durationMs: 3000 };
  const yes = { durationMs: 700 };

  it("offers 0 in a workspace's chat menu, and not in one that cannot start a chat", async () => {
    const withIt = new FakeCall(["2", "#"], []);
    const t = flow(withIt);
    await handleIncoming(t.incoming, t.deps);
    expect(withIt.said.join(" | ")).toContain("Press 0 for a new chat.");
    const without = new FakeCall(["4", "#"], []);
    const u = flow(without);
    await handleIncoming(u.incoming, u.deps);
    expect(without.said.join(" | ")).not.toContain("new chat");
  });

  it("makes the same offer to a Mac before add-on 0.18.0 never publishes: no newChat, no 0", async () => {
    const old: DirectoryDoc = {
      ...dir,
      workspaces: dir.workspaces!.map((w) => ({ n: w.n, label: w.label, chats: w.chats })),
    };
    const call = new FakeCall(["2", "0", "#"], []);
    const t = flow(call, { directory: old });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.join(" | ")).not.toContain("new chat");
    expect(t.log.newChats).toEqual([]);
  });

  it("reads the menu of a one-chat workspace that can start a chat, so 0 can be reached", async () => {
    const call = new FakeCall(["1", "#"], []);
    const t = flow(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.some((s) => s.startsWith("squeak. Which chat?") && s.includes("Press 0 for a new chat."))).toBe(
      true,
    );
  });

  it("is offered in a workspace with no chat that can take a message", async () => {
    const call = new FakeCall(["3", "0", "1"], [speech, yes]);
    const t = flow(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[1]).toContain("Press 0 for a new chat.");
    expect(t.log.newChats).toEqual([{ workspace: 3, dirVersion: "v1" }]);
  });

  it("records, reads back with the model, and starts on the keypad's 1 (exactly once)", async () => {
    const call = new FakeCall(["2", "0", null, "1"], [speech, { durationMs: 200, ended: "no-speech" }]);
    const t = flow(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said).toContain(newChatPrompt("blume"));
    expect(call.said).toContain(
      "I'll start a new chat in blume with Opus 5.5: add a dark mode toggle. Say yes to start it, or no.",
    );
    expect(t.log.newChats).toEqual([{ workspace: 2, dirVersion: "v1" }]);
    expect(t.log.starts).toHaveLength(1);
    expect(t.log.starts[0]).toMatchObject({ memoId: t.log.memoIds[0], spoken: false });
    expect(call.said.at(-1)).toBe("Started. It's working on it. Goodbye.");
    expect(t.log.sends).toBe(0);
    expect(t.log.memos).toBe(0);
  });

  it("starts on a spoken yes, sending the recording of the answer with the call's id", async () => {
    const call = new FakeCall(["2", "0", null], [speech, yes]);
    const t = flow(call);
    await handleIncoming(t.incoming, t.deps);
    expect(t.log.starts).toHaveLength(1);
    expect(t.log.starts[0]).toMatchObject({ spoken: true, callId: expect.stringMatching(/^[A-Za-z0-9_-]{4,}$/) });
  });

  it("goes on to the hold offer as a talk turn in confirm when the Mac made one", async () => {
    const call = new FakeCall(["2", "0", null], [speech, yes]);
    const t = flow(call, {
      startReply: {
        v: 1,
        id: "s",
        at: 0,
        status: "newchat",
        outcome: "started",
        hold: true,
        text: "Started. It's working on it. Want me to stay on the line while it works? Say yes to hold, or no to hang up.",
      },
    });
    await handleIncoming(t.incoming, t.deps);
    expect(t.log.talks).toEqual([
      { callId: t.log.starts[0]!.callId, label: "blume", from: { dirVersion: "v1", choice: 1 }, phase: "confirm" },
    ]);
    expect(call.said.at(-1)).toContain("stay on the line");
  });

  it("starts nothing on a hash, whether pressed while it is read back or as the answer", async () => {
    const pressed = new FakeCall(["2", "0", "#"], [speech]);
    const a = flow(pressed);
    await handleIncoming(a.incoming, a.deps);
    expect(a.log.starts).toEqual([]);
    expect(pressed.said.at(-1)).toBe("Cancelled. Goodbye.");
    const spoken = new FakeCall(["2", "0", null], [speech, { durationMs: 300, ended: "key" }]);
    const b = flow(spoken);
    await handleIncoming(b.incoming, b.deps);
    expect(b.log.starts).toEqual([]);
    expect(spoken.said.at(-1)).toBe("Cancelled. Goodbye.");
  });

  it("starts nothing when the keypad is not answered, or answered with a digit that means nothing", async () => {
    const quiet = new FakeCall(["2", "0", null, null, null], [speech, { durationMs: 100, ended: "no-speech" }]);
    const a = flow(quiet);
    await handleIncoming(a.incoming, a.deps);
    expect(a.log.starts).toEqual([]);
    const stray = new FakeCall(["2", "0", "7", "#"], [speech]);
    const b = flow(stray);
    await handleIncoming(b.incoming, b.deps);
    expect(b.log.starts).toEqual([]);
  });

  it("hears the read-back again on star, and still starts only once", async () => {
    const call = new FakeCall(["2", "0", "*", "1"], [speech]);
    const t = flow(call);
    await handleIncoming(t.incoming, t.deps);
    const readBacks = call.said.filter((s) => s.startsWith("I'll start a new chat"));
    expect(readBacks).toHaveLength(2);
    expect(t.log.starts).toHaveLength(1);
  });

  it("does not start for a no", async () => {
    const call = new FakeCall(["2", "0", null], [speech, yes]);
    const t = flow(call, {
      startReply: {
        v: 1,
        id: "s",
        at: 0,
        status: "newchat",
        outcome: "declined",
        text: "Okay, I won't start it. Goodbye.",
      },
    });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.at(-1)).toBe("Okay, I won't start it. Goodbye.");
    expect(t.log.talks).toEqual([]);
  });

  it("asks for yes or no again when the Mac could not tell", async () => {
    const call = new FakeCall(["2", "0", null, null], [speech, yes, yes]);
    let tries = 0;
    const t = flow(call);
    t.deps.uplink.start = async (_memoId, opts) => {
      tries += 1;
      t.log.starts.push({ memoId: "m", spoken: opts.audio !== undefined });
      return tries === 1
        ? { v: 1, id: "s", at: 0, status: "newchat", outcome: "again", text: NEW_CHAT_SAYS.again }
        : {
            v: 1,
            id: "s",
            at: 0,
            status: "newchat",
            outcome: "started",
            text: "Started. It's working on it. Goodbye.",
          };
    };
    await handleIncoming(t.incoming, t.deps);
    expect(call.said).toContain(NEW_CHAT_SAYS.again);
    expect(t.log.starts).toHaveLength(2);
    expect(call.said.at(-1)).toContain("Started");
  });

  it("says the Mac's fixed sentence when the start fails", async () => {
    const call = new FakeCall(["2", "0", "1"], [speech]);
    const t = flow(call, {
      startReply: { v: 1, id: "s", at: 0, status: "refused", reason: "Your Mac could not start the chat." },
    });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.slice(-2)).toEqual(["Your Mac could not start the chat.", "Goodbye."]);
  });

  it("says it is not sure when the start got no answer, and never sends it again", async () => {
    const call = new FakeCall(["2", "0", "1"], [speech]);
    const t = flow(call, { startReply: null });
    await handleIncoming(t.incoming, t.deps);
    expect(t.log.starts).toHaveLength(1);
    expect(call.said.at(-1)).toContain("not sure the chat was started");
  });

  it("says so, and starts nothing, when the Mac does not answer the recording", async () => {
    const call = new FakeCall(["2", "0"], [speech]);
    const t = flow(call, { transcript: null });
    await handleIncoming(t.incoming, t.deps);
    expect(t.log.starts).toEqual([]);
    expect(call.said.at(-1)).toContain("no chat was started");
  });

  it("speaks a refusal of the recording (an out-of-date list) and ends", async () => {
    const call = new FakeCall(["2", "0"], [speech]);
    const t = flow(call, {
      transcript: { v: 1, id: "x", at: 0, status: "refused", reason: "That list is out of date. Call again." },
    });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.slice(-2)).toEqual(["That list is out of date. Call again.", "Goodbye."]);
    expect(t.log.starts).toEqual([]);
  });

  it("never offers a start for words too few to trust", async () => {
    const call = new FakeCall(["2", "0", "#"], [{ durationMs: 4000 }]);
    const t = flow(call, {
      transcript: { v: 1, id: "x", at: 0, status: "transcript", text: "uh", label: "blume" },
    });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.join(" | ")).toContain("I only heard: uh");
    expect(t.log.starts).toEqual([]);
  });

  it("makes the new chat prompts ahead of time, only for workspaces that can start one", () => {
    const prompts = inboundPrompts(dir, false);
    expect(prompts).toContain(newChatPrompt("squeak"));
    expect(prompts).toContain(newChatPrompt("empty"));
    expect(prompts).not.toContain(newChatPrompt("plain"));
    expect(inboundPrompts({ ...dir, workspaces: dir.workspaces!.slice(3) }, false).join(" ")).not.toContain("new chat");
  });
});

describe("talkFlow continuing a hold offer", () => {
  it("makes its first turn a confirm when told to", async () => {
    const call = new FakeCall([], [{ durationMs: 900 }]);
    const phases: string[] = [];
    await talkFlow(
      call,
      {
        encode: async () => Buffer.from("x"),
        uplink: {
          talk: async (_callId, phase) => {
            phases.push(phase);
            return { v: 1, id: "t", at: 0, status: "talk", text: "Okay, I'll stay on the line.", next: "end" };
          },
        },
      },
      { callId: "call-xyz1", label: "blume", from: { dirVersion: "v1", choice: 1 }, phase: "confirm" },
    );
    expect(phases).toEqual(["confirm"]);
  });
});

describe("the setting: New chats from calls use", () => {
  let file: string;
  const models = [
    { id: "opus-5-5-1m", levels: ["low", "medium", "high"] },
    { id: "haiku-4-5", levels: [] as string[] },
  ];
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-nc-")), "voice-settings.json");
  });
  const store = (list = models) => new VoiceSettingsStore(file, Date.now, () => list);

  it("saves a preset and a level it takes, and survives a restart", () => {
    const s = store();
    expect(s.apply({ newChatModel: { id: "opus-5-5-1m", level: "high" } })).toMatchObject({
      ok: true,
      settings: { newChatModel: { id: "opus-5-5-1m", level: "high" } },
    });
    expect(store().settings.newChatModel).toEqual({ id: "opus-5-5-1m", level: "high" });
    expect(s.apply({ newChatModel: { id: "haiku-4-5" } })).toMatchObject({ ok: true });
  });

  it("clears it with null", () => {
    const s = store();
    s.apply({ newChatModel: { id: "opus-5-5-1m" } });
    const cleared = s.apply({ newChatModel: null });
    expect(cleared).toMatchObject({ ok: true });
    expect(s.settings.newChatModel).toBeUndefined();
    expect(store().settings.newChatModel).toBeUndefined();
  });

  it("refuses a model this Mac does not offer, and a level the model does not take", () => {
    const s = store();
    expect(s.apply({ newChatModel: { id: "gpt-9" } })).toEqual({ ok: false, reason: NEW_CHAT_MODEL_GONE_REFUSAL });
    expect(s.apply({ newChatModel: { id: "opus-5-5-1m", level: "max" } })).toEqual({
      ok: false,
      reason: NEW_CHAT_LEVEL_REFUSAL,
    });
    expect(s.apply({ newChatModel: { id: "haiku-4-5", level: "low" } })).toEqual({
      ok: false,
      reason: NEW_CHAT_LEVEL_REFUSAL,
    });
    expect(s.settings.newChatModel).toBeUndefined();
  });

  it("refuses a malformed change, and extra keys beside it", () => {
    const s = store();
    for (const bad of [
      { newChatModel: "opus-5-5-1m" },
      { newChatModel: {} },
      { newChatModel: { id: 5 } },
      { newChatModel: { id: "opus 5" } },
      { newChatModel: { id: "x".repeat(61) } },
      { newChatModel: { id: "opus-5-5-1m", level: 3 } },
      { newChatModel: { id: "opus-5-5-1m", level: "HIGH!" } },
      { newChatModel: { id: "opus-5-5-1m", agent: "claude" } },
      { newChatModel: [] },
      { newChatModel: null, callee: "101" },
    ]) {
      expect(s.apply(bad)).toMatchObject({ ok: false });
    }
    expect(s.settings.newChatModel).toBeUndefined();
  });

  it("cannot set a model when the models cannot be read, but can still clear one", () => {
    const unread = new VoiceSettingsStore(file, Date.now, () => {
      throw new Error("no conductor");
    });
    expect(unread.apply({ newChatModel: { id: "opus-5-5-1m" } })).toMatchObject({ ok: false });
    expect(new VoiceSettingsStore(file).apply({ newChatModel: { id: "opus-5-5-1m" } })).toMatchObject({ ok: false });
    expect(unread.apply({ newChatModel: null })).toMatchObject({ ok: true });
  });

  it("keeps the pick through the other settings, and they keep it", () => {
    const s = store();
    s.apply({ newChatModel: { id: "opus-5-5-1m", level: "low" } });
    s.apply({ callee: "202" });
    s.apply({ persona: { style: "friendly" } });
    s.apply({ hold: { graceSeconds: 60 } });
    s.apply({ pause: "1h" });
    expect(s.settings).toMatchObject({ callee: "202", newChatModel: { id: "opus-5-5-1m", level: "low" } });
    s.apply({ newChatModel: { id: "haiku-4-5" } });
    expect(s.settings).toMatchObject({ callee: "202", persona: { style: "friendly" }, hold: { graceSeconds: 60 } });
    expect(s.settings.pause).toBeDefined();
  });

  it("drops a damaged saved pick on load", () => {
    fs.writeFileSync(file, JSON.stringify({ callee: "101", newChatModel: { id: 4 } }));
    expect(new VoiceSettingsStore(file).settings.newChatModel).toBeUndefined();
  });
});
