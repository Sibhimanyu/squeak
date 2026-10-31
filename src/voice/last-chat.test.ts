import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { LastChatStore } from "./last-chat.js";
import { LAST_CHAT_FRESH_MS, MemoInbox, type MemoTarget } from "./memo-inbox.js";
import {
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  sealUp,
  upPath,
  type UpMessage,
} from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();

describe("LastChatStore", () => {
  it("remembers the chat across restarts and tolerates a damaged file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "last-chat-"));
    const file = path.join(dir, "voice-last-chat.json");
    expect(new LastChatStore(file).get()).toBeNull();
    new LastChatStore(file).set("c2", 5);
    expect(new LastChatStore(file).get()).toBe("c2");
    fs.writeFileSync(file, "{nope");
    expect(new LastChatStore(file).get()).toBeNull();
  });
});

describe("MemoInbox last chat", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let targets: MemoTarget[];
  let last: string | null;
  const sent: string[] = [];
  const clock = 1_800_000_000_000;

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    targets = [
      { target: "c1", label: "squeak · voice", workspace: null },
      { target: "c2", label: "blume · hub", workspace: null },
    ];
    last = null;
    sent.length = 0;
    inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "go with option B" },
      targets: () => targets,
      canSend: () => true,
      send: async (target) => {
        sent.push(target);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      lastChat: { get: () => last, set: (t) => void (last = t) },
      note: () => undefined,
      now: () => clock,
    });
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  const directory = async () => {
    const doc = await store.get(dirPath(channel));
    return doc ? readDirectory(key, doc, clock) : null;
  };
  async function upload(message: Record<string, unknown>) {
    const id = newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, { ...message, id, at: clock, expiresAt: clock + 60_000 } as unknown as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return { id, down: doc ? readDown(key, id, doc) : null };
  }

  it("forgets a chat used by phone hours ago: the one waiting is offered instead", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-last-")), "last.json");
    const store = new LastChatStore(file);
    store.set("c1", 1_000);
    expect(store.recent(LAST_CHAT_FRESH_MS, 1_000 + LAST_CHAT_FRESH_MS)).toBe("c1");
    expect(store.recent(LAST_CHAT_FRESH_MS, 1_000 + LAST_CHAT_FRESH_MS + 1)).toBeNull();
    expect(store.get()).toBe("c1");
  });

  it("names nothing when no chat was used and none waits (an old directory)", async () => {
    await inbox.publish();
    expect((await directory())!.last).toBeUndefined();
  });

  it("falls back to the newest chat that waits on the person", async () => {
    targets[1]!.waiting = true;
    await inbox.publish();
    expect((await directory())!.last).toEqual({ choice: 2, label: "blume · hub", why: "waiting" });
  });

  it("prefers the last chat used by phone, and ignores one that can no longer take a message", async () => {
    targets[1]!.waiting = true;
    last = "c1";
    await inbox.publish();
    expect((await directory())!.last).toEqual({ choice: 1, label: "squeak · voice", why: "used" });
    last = "gone";
    targets[1]!.waiting = false;
    await inbox.publish();
    expect((await directory())!.last).toBeUndefined();
  });

  it("records a send, a question's status and republishes with it first", async () => {
    await inbox.publish();
    const dir = (await directory())!;
    const memoId = newMessageId();
    const memo = await upload({
      v: 1,
      kind: "memo",
      dirVersion: dir.version,
      choice: 2,
      audio: Buffer.from("opus").toString("base64"),
      id: undefined,
    });
    void memoId;
    expect(memo.down).toMatchObject({ status: "transcript" });
    expect(last).toBeNull(); // recording alone is not use
    await upload({ v: 1, kind: "send", memoId: memo.id });
    expect(sent).toEqual(["c2"]);
    expect(last).toBe("c2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await directory())!.last).toEqual({ choice: 2, label: "blume · hub", why: "used" });
  });

  it("lists a last chat that no menu holds, off every menu, so a memo can name it", async () => {
    targets = Array.from({ length: 8 }, (_, i) => ({ target: `c${i}`, label: `chat ${i}`, workspace: null }));
    last = "c7";
    await inbox.publish();
    const dir = (await directory())!;
    expect(dir.items).toHaveLength(6);
    expect(dir.last).toEqual({ choice: 7, label: "chat 7", why: "used" });
    const memo = await upload({
      v: 1,
      kind: "memo",
      dirVersion: dir.version,
      choice: 7,
      audio: Buffer.from("opus").toString("base64"),
    });
    expect(memo.down).toMatchObject({ status: "transcript", label: "chat 7" });
  });
});
