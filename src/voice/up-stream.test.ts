import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { readUp, readUpPart, upAudioId, upPartHash, upPath } from "./memo-protocol.js";
import type { PhoneCall } from "./phone.js";
import { recordForUpload } from "./recording-upload.js";
import { PIECE_MS, pcmOfWav, UpStream } from "./up-stream.js";
import { RelayUplink } from "./uplink.js";
import { wavOf } from "./sip-phone.js";

const { channelId: channel, key } = generateChannel();
const SECOND = 16_000; // bytes of 8 kHz 16-bit mono audio
const pcmOf = (seconds: number, fill = 1): Buffer => Buffer.alloc(Math.round(seconds * SECOND), fill);
/** A stand-in for Opus that still tells pieces apart: its length and first byte. */
const encode = async (pcm: Buffer): Promise<Buffer> => Buffer.from(`opus:${pcm.length}:${pcm[0] ?? 0}`);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("UpStream: a recording goes up while it is made", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  const traces: string[] = [];
  const stored = async (): Promise<string[]> =>
    (await store.list(`channels/${channel}/voiceup`)).map((entry) => entry.id).sort();
  const make = (id: string, over: Partial<ConstructorParameters<typeof UpStream>[0]> = {}): UpStream =>
    new UpStream({ store, channel, key, encode, trace: (line) => traces.push(line), ...over }, id);

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    traces.length = 0;
  });
  afterEach(async () => {
    await db.stop();
  });

  it("writes a piece for every three seconds, in order, before the recording ends", async () => {
    expect(PIECE_MS).toBe(3000);
    const stream = make("s1");
    // 7.5 s heard in half-second looks.
    for (let i = 0; i < 15; i++) stream.feed(pcmOf(0.5, i + 1));
    await tick();
    expect(await stored()).toEqual([upAudioId("s1", 0), upAudioId("s1", 1)]);
    const first = readUpPart(key, upAudioId("s1", 0), (await store.get(upPath(channel, upAudioId("s1", 0))))!)!;
    expect(first.opus.toString()).toBe(`opus:${3 * SECOND}:1`);
    const second = readUpPart(key, upAudioId("s1", 1), (await store.get(upPath(channel, upAudioId("s1", 1))))!)!;
    expect(second.opus.toString()).toBe(`opus:${3 * SECOND}:7`);

    // The recording ends: the file holds all of it, and only what was not yet cut goes as the last piece.
    const whole = Buffer.concat(Array.from({ length: 15 }, (_, i) => pcmOf(0.5, i + 1)));
    const hashes = await stream.finish(whole);
    expect(hashes).toHaveLength(3);
    expect(hashes![0]).toBe(upPartHash(first.opus));
    expect(hashes![2]).toBe(upPartHash(Buffer.from(`opus:${1.5 * SECOND}:13`)));
    expect(await stored()).toHaveLength(3);
    expect(traces).toEqual(["step: Sent 2 pieces while recording"]);
  });

  it("sends a short recording as its one last piece", async () => {
    const stream = make("s2");
    stream.feed(pcmOf(1));
    const hashes = await stream.finish(pcmOf(1.2));
    expect(hashes).toEqual([upPartHash(Buffer.from(`opus:${1.2 * SECOND}:1`))]);
  });

  it("returns null and deletes what it wrote when a write fails", async () => {
    let writes = 0;
    const flaky = {
      set: async (p: string, d: never) => {
        if (++writes === 2) throw new Error("offline");
        await store.set(p, d);
      },
      delete: (p: string) => store.delete(p),
    };
    const stream = make("s3", { store: flaky as never });
    stream.feed(pcmOf(9));
    expect(await stream.finish(pcmOf(10))).toBeNull();
    expect(await stored()).toEqual([]);
  });

  it("returns null when an encode fails, and when nothing was heard", async () => {
    const broken = make("s4", {
      encode: async () => {
        throw new Error("ffmpeg");
      },
    });
    broken.feed(pcmOf(4));
    expect(await broken.finish(pcmOf(4))).toBeNull();
    expect(await make("s5").finish(Buffer.alloc(0))).toBeNull();
  });

  it("abort removes the pieces already sent", async () => {
    const stream = make("s6");
    stream.feed(pcmOf(7));
    await tick();
    expect((await stored()).length).toBe(2);
    await stream.abort();
    expect(await stored()).toEqual([]);
  });

  it("keeps an odd trailing byte out of the last piece", async () => {
    const stream = make("s7");
    const hashes = await stream.finish(Buffer.alloc(SECOND + 1, 2));
    expect(hashes).toEqual([upPartHash(Buffer.from(`opus:${SECOND}:2`))]);
  });
});

describe("pcmOfWav", () => {
  it("returns the samples of a WAV", () => {
    const samples = new Int16Array([1, 2, 3, 4]);
    expect(pcmOfWav(wavOf(samples))).toEqual(Buffer.from(samples.buffer));
  });
});

describe("RelayUplink and recordForUpload", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let dir: string;
  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-upstream-"));
  });
  afterEach(async () => {
    await db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const uplink = (enabled: boolean): RelayUplink =>
    new RelayUplink({ store, channel, key, partsEnabled: () => enabled, encodePcm: encode, memoWaitMs: 400 });

  /** A call that "hears" nine seconds in three-second looks, then hands back a WAV of it. */
  const callOf = (seconds: number): PhoneCall => {
    const file = path.join(dir, "memo.wav");
    return {
      record: async (options: { onAudio?: (pcm: Buffer) => void }) => {
        for (let i = 0; i < seconds; i += 1) options.onAudio?.(pcmOf(1, 5));
        await tick();
        fs.writeFileSync(file, wavOf(new Int16Array(pcmOf(seconds, 5).buffer)));
        return { file, durationMs: seconds * 1000, ended: "silence" as const };
      },
    } as unknown as PhoneCall;
  };
  const wholeEncode = async (): Promise<Buffer> => Buffer.from("whole");

  it("opens no stream for a Mac whose list lacks the flag", () => {
    expect(uplink(false).openStream("m1")).toBeNull();
    expect(uplink(true).openStream("m1")).not.toBeNull();
  });

  it("sends the whole recording as audio when there is no stream", async () => {
    const up = uplink(false);
    const upload = await recordForUpload(callOf(5), { uplink: up, encode: wholeEncode }, { maxMs: 1000 }, "m1");
    expect(await upload!.audio()).toEqual(Buffer.from("whole"));
    expect(await store.list(`channels/${channel}/voiceup`)).toEqual([]);
  });

  it("sends pieces while recording, then a message naming them, and cleans up after the exchange", async () => {
    const up = uplink(true);
    const upload = await recordForUpload(callOf(7), { uplink: up, encode: wholeEncode }, { maxMs: 1000 }, "m1");
    const audio = await upload!.audio();
    expect(Buffer.isBuffer(audio)).toBe(false);
    const parts = (audio as { parts: string[] }).parts;
    expect(parts).toHaveLength(3);
    expect((await store.list(`channels/${channel}/voiceup`)).map((entry) => entry.id).sort()).toEqual([
      upAudioId("m1", 0),
      upAudioId("m1", 1),
      upAudioId("m1", 2),
    ]);
    // The message carries hashes and no audio; the Mac never answers here, so the exchange times out and cleans up.
    const seen: unknown[] = [];
    const stop = store.watch(`channels/${channel}/voiceup`, () => undefined);
    const running = up.memo("m1", 1, "v1", { parts });
    await tick();
    for (const { id, doc } of await store.list(`channels/${channel}/voiceup`)) {
      if (id === "m1") seen.push(readUp(key, id, doc, Date.now()));
    }
    stop();
    expect(await running).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: true, message: { kind: "memo", audioParts: parts } });
    expect(seen[0]).not.toHaveProperty("message.audio");
    expect(await store.list(`channels/${channel}/voiceup`)).toEqual([]);
  });

  it("falls back to the whole recording when a piece cannot be sent", async () => {
    const failing = new RelayUplink({
      store,
      channel,
      key,
      partsEnabled: () => true,
      encodePcm: async () => {
        throw new Error("ffmpeg");
      },
    });
    const upload = await recordForUpload(callOf(7), { uplink: failing, encode: wholeEncode }, { maxMs: 1000 }, "m1");
    expect(await upload!.audio()).toEqual(Buffer.from("whole"));
    expect(await store.list(`channels/${channel}/voiceup`)).toEqual([]);
  });

  it("discards the pieces when the recording is not used, or the caller hangs up", async () => {
    const up = uplink(true);
    const upload = await recordForUpload(callOf(7), { uplink: up, encode: wholeEncode }, { maxMs: 1000 }, "m2");
    await tick();
    expect((await store.list(`channels/${channel}/voiceup`)).length).toBe(2);
    upload!.discard();
    await tick();
    expect(await store.list(`channels/${channel}/voiceup`)).toEqual([]);

    const hungUp = { record: async (o: { onAudio?: (pcm: Buffer) => void }) => (o.onAudio?.(pcmOf(7)), null) };
    expect(
      await recordForUpload(hungUp as unknown as PhoneCall, { uplink: up, encode: wholeEncode }, { maxMs: 1 }, "m3"),
    ).toBeNull();
    await tick();
    expect(await store.list(`channels/${channel}/voiceup`)).toEqual([]);
  });
});
