import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox, type MemoTarget } from "./memo-inbox.js";
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

type UpBody = UpMessage extends infer U ? (U extends UpMessage ? Omit<U, "id" | "at" | "expiresAt"> : never) : never;

describe("MemoInbox", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let targets: MemoTarget[];
  let transcript: string | Error;
  let busy: Set<string>;
  const sent: Array<{ target: string; text: string }> = [];
  const notes: string[] = [];
  let clock = 1_800_000_000_000;

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    targets = [
      { target: "c1", label: "squeak · voice" },
      { target: "c2", label: "blume · hub" },
    ];
    transcript = "tell it to go with option B";
    busy = new Set();
    sent.length = 0;
    notes.length = 0;
    clock = 1_800_000_000_000;
    inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: {
        transcribe: async () => {
          if (transcript instanceof Error) throw transcript;
          return transcript;
        },
      },
      targets: () => targets,
      canSend: (target) => !busy.has(target),
      send: async (target, text) => {
        sent.push({ target, text });
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      note: (text) => notes.push(text),
      now: () => clock,
    });
  });

  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  async function directory() {
    const doc = await store.get(dirPath(channel));
    return doc ? readDirectory(key, doc, clock) : null;
  }

  async function upload(message: UpBody & { id?: string }) {
    const id = message.id ?? newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, { ...message, id, at: clock, expiresAt: clock + 60_000 } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  }

  const memo = (choice = 1, dirVersion?: string) =>
    ({
      v: 1,
      kind: "memo",
      dirVersion: dirVersion ?? "",
      choice,
      audio: Buffer.from("opus").toString("base64"),
    }) as const;

  it("publishes who can take a message, as numbers, and the one caller allowed", async () => {
    await inbox.publish();
    const dir = await directory();
    expect(dir).toMatchObject({
      caller: "35210",
      items: [
        { n: 1, label: "squeak · voice" },
        { n: 2, label: "blume · hub" },
      ],
    });
    // Nothing in it names a target: the gateway can only say "number 2".
    expect(JSON.stringify(dir)).not.toContain("c2");
  });

  it("publishes again only when the list changes", async () => {
    await inbox.publish();
    const first = (await directory())!.version;
    await store.delete(dirPath(channel));
    await inbox.publish();
    expect(await directory()).toBeNull();
    targets = [{ target: "c9", label: "other" }];
    await inbox.publish();
    expect((await directory())!.version).not.toBe(first);
  });

  it("transcribes a memo for the chat that number was, then sends exactly those words on 'send'", async () => {
    await inbox.publish();
    const version = (await directory())!.version;
    const memoId = newMessageId();
    const heard = await upload({ ...memo(2, version), id: memoId });
    expect(heard).toMatchObject({ status: "transcript", text: "tell it to go with option B", label: "blume · hub" });
    expect(sent).toEqual([]);
    const done = await upload({ v: 1, kind: "send", memoId });
    expect(done).toMatchObject({ status: "sent" });
    expect(sent).toEqual([{ target: "c2", text: "tell it to go with option B" }]);
    expect(notes[0]).toContain("Sent by phone to blume · hub");
  });

  it("sends a memo once, never twice", async () => {
    await inbox.publish();
    const memoId = newMessageId();
    await upload({ ...memo(1, (await directory())!.version), id: memoId });
    await upload({ v: 1, kind: "send", memoId });
    expect(await upload({ v: 1, kind: "send", memoId })).toMatchObject({ status: "refused" });
    expect(sent).toHaveLength(1);
  });

  it("refuses a memo chosen from a list it never published", async () => {
    await inbox.publish();
    expect(await upload(memo(1, "deadbeef0000"))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("out of date"),
    });
    expect(sent).toEqual([]);
  });

  it("says so when it hears nothing or cannot transcribe", async () => {
    await inbox.publish();
    const version = (await directory())!.version;
    transcript = "";
    expect(await upload(memo(1, version))).toMatchObject({ status: "refused", reason: "I did not hear anything." });
    transcript = new Error("whisper broke");
    expect(await upload(memo(1, version))).toMatchObject({ status: "refused", reason: "I could not make that out." });
  });

  it("will not send into a chat that has started working since", async () => {
    await inbox.publish();
    const memoId = newMessageId();
    await upload({ ...memo(1, (await directory())!.version), id: memoId });
    busy.add("c1");
    expect(await upload({ v: 1, kind: "send", memoId })).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("busy"),
    });
    expect(sent).toEqual([]);
  });

  it("ignores a message sealed with another key, an expired one, and a copy of one it already handled", async () => {
    await inbox.publish();
    const version = (await directory())!.version;
    const other = generateChannel().key;
    const forged = newMessageId();
    await store.set(
      upPath(channel, forged),
      sealUp(other, { ...memo(1, version), id: forged, at: clock, expiresAt: clock + 60_000 } as UpMessage),
    );
    const old = newMessageId();
    await store.set(
      upPath(channel, old),
      sealUp(key, { ...memo(1, version), id: old, at: clock - 3_600_000, expiresAt: clock - 3_000_000 } as UpMessage),
    );
    await inbox.pass();
    expect(await store.get(downPath(channel, forged))).toBeNull();
    expect(await store.get(downPath(channel, old))).toBeNull();
    expect(db.tree.list(`channels/${channel}/voiceup`)).toEqual([]);
  });

  it("caps sends per hour", async () => {
    await inbox.publish();
    const version = (await directory())!.version;
    let last = null;
    for (let i = 0; i < 22; i++) {
      const memoId = newMessageId();
      await upload({ ...memo(1, version), id: memoId });
      last = await upload({ v: 1, kind: "send", memoId });
    }
    expect(last).toMatchObject({ status: "refused", reason: expect.stringContaining("Too many") });
    expect(sent).toHaveLength(20);
  });
});
