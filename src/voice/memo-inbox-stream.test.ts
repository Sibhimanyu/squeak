import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import type { Clip } from "./clips.js";
import { MemoInbox, type MemoInboxDependencies } from "./memo-inbox.js";
import { splitSentences } from "./natural-cache.js";
import {
  audioPath,
  dirPath,
  downPath,
  newMessageId,
  readAudio,
  readDirectory,
  readDown,
  replyAudioId,
  sealAudio,
  sealUp,
  upPath,
  type UpMessage,
} from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();
const ANSWER = "It is working on the tests. Nothing needs you right now. The build is passing.";
const clipOf = (text: string): Clip => ({ text, mulaw: Buffer.alloc(40, 0xff).toString("base64") });

describe("MemoInbox: an answer goes out after its first sentence", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let streams = true;
  let gate: Promise<void>;
  let open: () => void;
  const order: string[] = [];
  const clock = 1_800_000_000_000;

  const make = (extra: Partial<MemoInboxDependencies> = {}): MemoInbox =>
    new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "x" },
      targets: () => [{ target: "c1", label: "squeak voice", workspace: null }],
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      note: () => undefined,
      now: () => clock,
      describe: () => ANSWER,
      answer: async () => "x",
      speech: async (text) => clipOf(text),
      // The first sentence is ready at once; the others wait for the gate and are made in order.
      speechStream: async (text, onPart) => {
        const parts = splitSentences(text);
        for (const [index, part] of parts.entries()) {
          if (index > 0) await gate;
          order.push(`made:${index}`);
          onPart({ index, total: parts.length, clip: clipOf(part) });
        }
      },
      streamsAnswers: () => streams,
      ...extra,
    });

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    streams = true;
    order.length = 0;
    gate = new Promise<void>((resolve) => (open = resolve));
    inbox = make();
    await inbox.publish();
  });
  afterEach(async () => {
    open();
    inbox.stop();
    await db.stop();
  });

  async function status(): Promise<{ id: string; down: ReturnType<typeof readDown> }> {
    const version = readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;
    const id = newMessageId();
    const body = { kind: "status", dirVersion: version, choice: 1 };
    await store.set(
      upPath(channel, id),
      sealUp(key, { v: 1, id, at: clock, expiresAt: clock + 60_000, ...body } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return { id, down: doc ? readDown(key, id, doc) : null };
  }

  it("replies once the first sentence is ready, then writes the others in order and sealed", async () => {
    const parts = splitSentences(ANSWER);
    expect(parts.length).toBe(3);
    const { id, down } = await status();
    // The later sentences are still held back, yet the reply is out.
    expect(order).toEqual(["made:0"]);
    expect(down).toMatchObject({ status: "answer", text: ANSWER, audioFollows: { parts } });
    expect(down?.status === "answer" && down.audio?.text).toBe(parts[0]);
    expect(await store.get(audioPath(channel, replyAudioId(id, 1)))).toBeNull();

    open();
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const index of [1, 2]) {
      const docId = replyAudioId(id, index);
      const read = readAudio(key, docId, (await store.get(audioPath(channel, docId)))!);
      expect(read).toMatchObject({ version: id, clips: [{ text: parts[index] }] });
    }
    expect(order).toEqual(["made:0", "made:1", "made:2"]);
    // Sealed for its own id: a document moved to another id does not open.
    const moved = (await store.get(audioPath(channel, replyAudioId(id, 1))))!;
    expect(readAudio(key, replyAudioId(id, 2), moved)).toBeNull();
  });

  it("sends one whole clip, with no audioFollows, to an add-on that cannot follow", async () => {
    streams = false;
    const { down } = await status();
    expect(down?.status === "answer" && down.audio?.text).toBe(ANSWER);
    expect(down?.status === "answer" && down.audioFollows).toBeUndefined();
    expect(order).toEqual([]);
  });

  it("sends one whole clip for a single sentence", async () => {
    inbox.stop();
    inbox = make({ describe: () => "It is working." });
    await inbox.publish();
    const { down } = await status();
    expect(down?.status === "answer" && down.audio?.text).toBe("It is working.");
    expect(down?.status === "answer" && down.audioFollows).toBeUndefined();
  });

  it("sweeps answer documents a restart left behind", async () => {
    const stale = replyAudioId("old", 1);
    await store.set(audioPath(channel, stale), sealAudio(key, stale, "old", [clipOf("Hi there friend.")], clock));
    inbox.stop();
    inbox = make({ audioClips: async () => [] });
    await inbox.publish();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await store.get(audioPath(channel, stale))).toBeNull();
  });
});

describe("the version gate and the wire shape", () => {
  it("streams answers only to an add-on from 0.17.0", async () => {
    const { addonSupports, ANSWER_STREAM_ADDON } = await import("./addon-update.js");
    expect(ANSWER_STREAM_ADDON).toBe("0.17.0");
    expect(addonSupports("0.16.1", ANSWER_STREAM_ADDON)).toBe(false);
    expect(addonSupports("0.17.0", ANSWER_STREAM_ADDON)).toBe(true);
    expect(addonSupports("0.18.2", ANSWER_STREAM_ADDON)).toBe(true);
    expect(addonSupports(null, ANSWER_STREAM_ADDON)).toBe(false);
  });

  it("drops audioFollows that does not match its first clip", async () => {
    const { sealDown } = await import("./memo-protocol.js");
    const read = (follows: unknown) =>
      readDown(
        key,
        "m1",
        sealDown(key, {
          v: 1,
          id: "m1",
          at: 1,
          status: "answer",
          text: "A one. B two.",
          audio: clipOf("A one."),
          audioFollows: follows,
        } as never),
      );
    expect(read({ parts: ["A one.", "B two."] })).toMatchObject({ audioFollows: { parts: ["A one.", "B two."] } });
    expect(read({ parts: ["Other.", "B two."] })).not.toHaveProperty("audioFollows");
    expect(read({ parts: ["A one."] })).not.toHaveProperty("audioFollows");
  });
});
