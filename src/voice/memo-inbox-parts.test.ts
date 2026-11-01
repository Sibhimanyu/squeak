import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox } from "./memo-inbox.js";
import {
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  sealUp,
  sealUpPart,
  upAudioId,
  upPartHash,
  upPath,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";
import type { Transcriber } from "./transcribe.js";

const { channelId: channel, key } = generateChannel();

describe("MemoInbox: a recording that arrives in pieces", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let clock = 1_800_000_000_000;
  const traces: Array<[string, string]> = [];
  const transcribed: string[] = [];
  let pieces = true;
  let wholeSeen: string[] = [];

  /** Each piece's "opus" is its words; decoding is the identity and the transcript is the words joined. */
  const transcriber = (): Transcriber => ({
    transcribe: async (audio) => {
      wholeSeen.push(audio.toString());
      return "from the whole recording";
    },
    ...(pieces
      ? {
          decode: async (opus: Buffer) => opus,
          transcribePcm: async (pcm: Buffer) => {
            transcribed.push(pcm.toString());
            return pcm.toString().trim();
          },
        }
      : {}),
  });

  const make = (wait = 2_000): MemoInbox =>
    new MemoInbox({
      store,
      channel,
      key,
      transcriber: transcriber(),
      targets: () => [{ target: "c1", label: "squeak · voice", workspace: null }],
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      note: () => undefined,
      trace: (kind, text) => traces.push([kind, text]),
      now: () => clock,
      partsWaitMs: wait,
      partsPollMs: 20,
    });

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    clock = 1_800_000_000_000;
    traces.length = 0;
    transcribed.length = 0;
    wholeSeen = [];
    pieces = true;
    inbox = make();
    await inbox.publish();
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  const version = async (): Promise<string> => readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;

  const writePiece = (stream: string, index: number, words: string, at = clock) =>
    store.set(upPath(channel, upAudioId(stream, index)), sealUpPart(key, stream, index, Buffer.from(words), at));

  async function send(id: string, body: Record<string, unknown>): Promise<void> {
    const message = {
      v: 1,
      id,
      at: clock,
      expiresAt: clock + 60_000,
      kind: "memo",
      dirVersion: await version(),
      choice: 1,
      ...body,
    };
    await store.set(upPath(channel, id), sealUp(key, message as UpMessage));
  }
  const answer = async (id: string): Promise<DownMessage | null> => {
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  };
  const hashes = (words: string[]): string[] => words.map((w) => upPartHash(Buffer.from(w)));
  const left = async (): Promise<string[]> =>
    (await store.list(`channels/${channel}/voiceup`)).map((entry) => entry.id);

  it("says it takes pieces only with a transcriber that decodes them", async () => {
    expect(readDirectory(key, (await store.get(dirPath(channel)))!, clock)).toMatchObject({ upParts: true });
    inbox.stop();
    pieces = false;
    inbox = make();
    await store.delete(dirPath(channel));
    await inbox.publish();
    expect(readDirectory(key, (await store.get(dirPath(channel)))!, clock)).not.toHaveProperty("upParts");
  });

  it("joins pieces that arrived out of order, in the order the message names", async () => {
    const id = newMessageId();
    const words = ["tell it ", "to go ", "with B"];
    await writePiece(id, 2, words[2]!);
    await writePiece(id, 0, words[0]!);
    await writePiece(id, 1, words[1]!);
    await send(id, { audioParts: hashes(words) });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({ status: "transcript", text: "tell it to go with B" });
    expect(transcribed).toEqual(["tell it to go with B"]);
    expect(traces).toContainEqual(["step", expect.stringMatching(/Recording received \(1 KB in 3 pieces\)/)]);
    // The pieces and the message are used up.
    expect((await left()).filter((name) => name.startsWith("upaudio-"))).toEqual([]);
  });

  it("waits for a piece that arrives late", async () => {
    const id = newMessageId();
    const words = ["one ", "two"];
    await writePiece(id, 0, words[0]!);
    await send(id, { audioParts: hashes(words) });
    const running = inbox.pass();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writePiece(id, 1, words[1]!);
    await running;
    expect(await answer(id)).toMatchObject({ status: "transcript", text: "one two" });
  });

  it("refuses when a piece never comes, never a partial transcript", async () => {
    inbox.stop();
    inbox = make(150);
    await inbox.publish();
    const id = newMessageId();
    await writePiece(id, 0, "one ");
    await send(id, { audioParts: hashes(["one ", "two"]) });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({
      status: "refused",
      reason: "The recording did not arrive whole. Try again.",
    });
    expect(transcribed).toEqual([]);
  });

  it("refuses a piece whose hash does not match", async () => {
    const id = newMessageId();
    await writePiece(id, 0, "one ");
    await writePiece(id, 1, "TAMPERED");
    await send(id, { audioParts: hashes(["one ", "two"]) });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({ status: "refused" });
    expect(transcribed).toEqual([]);
  });

  it("refuses a piece sealed for another stream", async () => {
    const id = newMessageId();
    const other = newMessageId();
    await writePiece(id, 0, "one ");
    // A document for another stream copied under this stream's id does not open.
    const copied = sealUpPart(key, other, 1, Buffer.from("two"), clock);
    await store.set(upPath(channel, upAudioId(id, 1)), copied);
    await send(id, { audioParts: hashes(["one ", "two"]) });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({ status: "refused" });
  });

  it("still takes the whole recording as one audio, as before", async () => {
    const id = newMessageId();
    await send(id, { audio: Buffer.from("opus").toString("base64") });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({ status: "transcript", text: "from the whole recording" });
    expect(wholeSeen).toEqual(["opus"]);
    expect(traces).toContainEqual(["step", "Recording received (1 KB)"]);
  });

  it("refuses pieces when it cannot decode them", async () => {
    inbox.stop();
    pieces = false;
    inbox = make();
    await inbox.publish();
    const id = newMessageId();
    await writePiece(id, 0, "one ");
    await send(id, { audioParts: hashes(["one "]) });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({ status: "refused", reason: "I could not make that out." });
  });

  it("never treats a piece as a message, and leaves it for its message", async () => {
    const id = newMessageId();
    await writePiece(id, 0, "one ");
    await inbox.pass();
    expect(await left()).toEqual([upAudioId(id, 0)]);
    expect(await store.list(`channels/${channel}/voicedown`)).toEqual([]);
    // Later the message arrives and uses it: the early piece was not claimed as a message.
    await send(id, { audioParts: hashes(["one "]) });
    await inbox.pass();
    expect(await answer(id)).toMatchObject({ status: "transcript", text: "one" });
  });

  it("sweeps pieces older than ten minutes, and all of them at start", async () => {
    await writePiece("old", 0, "x", clock - 11 * 60_000);
    await writePiece("fresh", 0, "y", clock);
    await inbox.pass();
    expect(await left()).toEqual([upAudioId("fresh", 0)]);
    await writePiece("again", 0, "z");
    inbox.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await left()).toEqual([]);
  });
});
