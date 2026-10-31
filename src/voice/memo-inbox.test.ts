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
  let favs: Array<{ n: number; workspace: string; label: string }>;
  let voiceKey: string;
  const traces: Array<[string, string]> = [];
  const sent: Array<{ target: string; text: string }> = [];
  const notes: string[] = [];
  let clock = 1_800_000_000_000;

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    targets = [
      { target: "c1", label: "squeak · voice", workspace: null },
      { target: "c2", label: "blume · hub", workspace: null },
    ];
    transcript = "tell it to go with option B";
    busy = new Set();
    favs = [];
    voiceKey = "kokoro:af_heart:none";
    traces.length = 0;
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
      favorites: () => favs,
      voiceKey: () => voiceKey,
      trace: (kind, text) => traces.push([kind, text]),
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
    targets = [{ target: "c9", label: "other", workspace: null }];
    await inbox.publish();
    expect((await directory())!.version).not.toBe(first);
  });

  it("publishes again when the Mac's voice changes, so the add-on gets prompts in the new voice", async () => {
    await inbox.publish();
    const first = (await directory())!.version;
    voiceKey = "qwen3:designed_warm_woman:strong";
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

  describe("favourite workspaces", () => {
    const chat = (n: number, workspace: string | null): MemoTarget => ({
      target: `t${n}`,
      label: `chat ${n}`,
      workspace,
    });

    it("lists workspaces first, with chat choices counted across the whole directory", async () => {
      targets = [chat(1, "wa"), chat(2, "wb"), chat(3, "wa"), chat(4, null)];
      favs = [
        { n: 2, workspace: "wb", label: "blume · hub" },
        { n: 1, workspace: "wa", label: "squeak · main" },
        { n: 5, workspace: "wz", label: "quiet" },
      ];
      await inbox.publish();
      const dir = (await directory())!;
      expect(dir.workspaces).toEqual([
        {
          n: 1,
          label: "squeak · main",
          chats: [
            { n: 1, label: "chat 1", choice: 1 },
            { n: 2, label: "chat 3", choice: 2 },
          ],
        },
        { n: 2, label: "blume · hub", chats: [{ n: 1, label: "chat 2", choice: 3 }] },
        { n: 5, label: "quiet", chats: [] },
      ]);
      expect(dir.items).toEqual([{ n: 1, label: "chat 4", choice: 4 }]);
    });

    it("sends a memo naming a favourite chat's choice to that chat, even past nine", async () => {
      targets = Array.from({ length: 12 }, (_, i) => chat(i + 1, i < 9 ? "wa" : "wb"));
      favs = [
        { n: 1, workspace: "wa", label: "a" },
        { n: 2, workspace: "wb", label: "b" },
      ];
      await inbox.publish();
      const dir = (await directory())!;
      const choice = dir.workspaces![1]!.chats[2]!.choice!;
      expect(choice).toBe(12);
      const memoId = newMessageId();
      expect(await upload({ ...memo(choice, dir.version), id: memoId })).toMatchObject({
        status: "transcript",
        label: "chat 12",
      });
      await upload({ v: 1, kind: "send", memoId });
      expect(sent).toEqual([{ target: "t12", text: "tell it to go with option B" }]);
      expect(traces.map(([k]) => k)).toEqual(["step", "heard", "step", "said", "step"]);
    });

    it("still resolves a stale version, and truncates long workspace names at a word", async () => {
      targets = [chat(1, "wa")];
      favs = [{ n: 1, workspace: "wa", label: "word ".repeat(30).trim() }];
      await inbox.publish();
      const old = (await directory())!;
      expect(old.workspaces![0]!.label.length).toBeLessThanOrEqual(60);
      expect(old.workspaces![0]!.label.endsWith("word")).toBe(true);
      targets = [chat(1, "wa"), chat(2, "wa")];
      await inbox.publish();
      expect((await directory())!.version).not.toBe(old.version);
      expect(await upload(memo(1, old.version))).toMatchObject({ status: "transcript", label: "chat 1" });
    });

    describe("automatic workspaces", () => {
      const wchat = (n: number, workspace: string | null, workspaceLabel?: string): MemoTarget => ({
        target: `t${n}`,
        label: `chat ${n}`,
        workspace,
        ...(workspaceLabel ? { workspaceLabel } : {}),
      });

      it("groups chats by workspace, newest first, when there are no favourites", async () => {
        targets = [wchat(1, "wb", "blume, hub"), wchat(2, "wa", "squeak, main"), wchat(3, "wb", "blume, hub")];
        await inbox.publish();
        const dir = (await directory())!;
        expect(dir.workspaces).toEqual([
          {
            n: 1,
            label: "blume, hub",
            chats: [
              { n: 1, label: "chat 1", choice: 1 },
              { n: 2, label: "chat 3", choice: 2 },
            ],
          },
          { n: 2, label: "squeak, main", chats: [{ n: 1, label: "chat 2", choice: 3 }] },
        ]);
        expect(dir.items).toEqual([]);
      });

      it("keeps the flat menu for one workspace and no favourites", async () => {
        targets = [wchat(1, "wa"), wchat(2, "wa")];
        await inbox.publish();
        const dir = (await directory())!;
        expect(dir.workspaces).toBeUndefined();
        expect(dir.items).toHaveLength(2);
      });

      it("puts automatic workspaces after favourites on the lowest free digits", async () => {
        targets = [wchat(1, "wx"), wchat(2, "wa"), wchat(3, "wy"), wchat(4, null)];
        favs = [
          { n: 1, workspace: "wa", label: "squeak main" },
          { n: 3, workspace: "wz", label: "quiet" },
        ];
        await inbox.publish();
        const dir = (await directory())!;
        expect(dir.workspaces!.map((w) => w.n)).toEqual([1, 3, 2, 4]);
        expect(dir.workspaces![2]!.chats).toEqual([{ n: 1, label: "chat 1", choice: 2 }]);
        expect(dir.items).toEqual([{ n: 1, label: "chat 4", choice: 4 }]);
      });

      it("leaves workspaces past nine in the flat menu, and its version is stable", async () => {
        targets = Array.from({ length: 11 }, (_, i) => wchat(i + 1, `w${i}`));
        await inbox.publish();
        const dir = (await directory())!;
        expect(dir.workspaces).toHaveLength(9);
        expect(dir.workspaces!.map((w) => w.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(dir.items.map((i) => i.label)).toEqual(["chat 10", "chat 11"]);
        const memoId = newMessageId();
        expect(await upload({ ...memo(dir.items[1]!.choice!, dir.version), id: memoId })).toMatchObject({
          label: "chat 11",
        });
        await store.delete(dirPath(channel));
        clock += 1000;
        await inbox.publish();
        expect(await directory()).toBeNull();
        clock += 40 * 60_000;
        await inbox.publish();
        expect((await directory())!.version).toBe(dir.version);
      });
    });
  });
});
