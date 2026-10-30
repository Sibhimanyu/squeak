import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import type { CallResult } from "./baresip-line.js";
import type { Clip } from "./clips.js";
import type { CallScript } from "./dialog.js";
import { VoiceGateway } from "./gateway.js";
import { renderCallClips } from "./natural-voice.js";
import { addonSupports } from "./addon-update.js";
import { RelayLine } from "./relay-line.js";
import { CachedSpeaker, type Speaker } from "./tts.js";

const script: CallScript = {
  greeting: "Squeak. squeak · voice has a question for you.",
  question: "Which one? Press 1 for A.",
  options: [{ letter: "A", title: "merge" }],
};
const clipOf = (text: string): Clip => ({ text, mulaw: Buffer.alloc(80, 0xff).toString("base64") });
const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("a call that rings while the Mac's voice is still being made", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  const { channelId: channel, key } = generateChannel();
  let gateway: VoiceGateway;
  const seeded: string[] = [];
  let atRing: string[] = [];
  let answerCall = deferred<CallResult>();
  let rang = deferred();
  const trace: string[] = [];

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    seeded.length = 0;
    atRing = [];
    answerCall = deferred<CallResult>();
    rang = deferred();
    trace.length = 0;
    gateway = new VoiceGateway({
      store,
      channel,
      key,
      callee: "101",
      pin: () => null,
      seed: (clips) => seeded.push(...clips.map((c) => c.text)),
      line: {
        call: async () => {
          atRing = [...seeded];
          rang.resolve();
          return answerCall.promise;
        },
      },
    });
    gateway.start();
  });
  afterEach(async () => {
    gateway.stop();
    await db.stop();
  });

  it("dials at once, before any clip exists, then hands each clip over as it is made", async () => {
    const release = deferred();
    const line = new RelayLine({
      store,
      channel,
      key,
      lateClips: () => true,
      trace: (text) => trace.push(text),
      clips: async (_script, _answerable, onClip) => {
        await release.promise;
        onClip?.(clipOf("Squeak. hello"));
        await tick(150);
        onClip?.(clipOf("Which one?"));
        return [clipOf("Squeak. hello"), clipOf("Which one?")];
      },
    });
    const call = line.call(script, true);
    await rang.promise;
    // The phone is already ringing and nothing of the Mac's voice has been made: the add-on speaks plain on answer.
    expect(atRing).toEqual([]);
    release.resolve();
    await tick(500);
    expect(seeded).toEqual(["Squeak. hello", "Which one?"]);
    answerCall.resolve({ status: "answered", letter: "A" });
    expect(await call).toEqual({ status: "answered", letter: "A" });
    expect(trace[0]).toContain("Dialling started");
    expect(trace.some((line) => line.startsWith("Voice clip 1 sent"))).toBe(true);
    // Nothing outlives the call.
    expect(db.tree.get(`channels/${channel}/voicedir`) ?? null).toBeNull();
  });

  it("uses the Mac's voice when the render finishes during the ring (before it is answered)", async () => {
    const line = new RelayLine({
      store,
      channel,
      key,
      lateClips: () => true,
      clips: async (_s, _a, onClip) => {
        onClip?.(clipOf("Squeak. hello"));
        return [clipOf("Squeak. hello")];
      },
    });
    const call = line.call(script, true);
    await rang.promise;
    await tick(400);
    expect(seeded).toEqual(["Squeak. hello"]);
    answerCall.resolve({ status: "unanswered" });
    expect(await call).toEqual({ status: "unanswered" });
  });

  it("goes the old way for an add-on that cannot take clips late: the request carries them", async () => {
    let requested = false;
    const line = new RelayLine({
      store,
      channel,
      key,
      lateClips: () => false,
      clips: async (_s, _a, onClip) => {
        requested = onClip === undefined;
        return [clipOf("Squeak. hello")];
      },
    });
    answerCall.resolve({ status: "unanswered" });
    await line.call(script, true);
    expect(requested).toBe(true);
    expect(trace).toEqual([]);
  });

  it("a clip that cannot be sent never stops the call", async () => {
    const broken = new RelayLine({
      store,
      channel,
      key,
      lateClips: () => true,
      clips: async () => {
        throw new Error("render failed");
      },
    });
    answerCall.resolve({ status: "answered", letter: "A" });
    expect(await broken.call(script, true)).toEqual({ status: "answered", letter: "A" });
  });
});

describe("the add-on's speech cache with a clip that arrives late", () => {
  const made: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "late-clip-"));
  afterEach(() => made.splice(0));

  const speakerOf = (gate: Promise<void> | null): Speaker => ({
    speak: async (text: string) => {
      made.push(text);
      if (gate) await gate;
      const file = path.join(dir, `plain-${made.length}.wav`);
      fs.writeFileSync(file, "x");
      return { file, durationMs: 100 };
    },
    dispose: () => undefined,
  });

  it("speaks the plain voice at once when no clip is there (no silence on answer)", async () => {
    const cache = new CachedSpeaker(speakerOf(null));
    const said = await cache.speakDetailed("Squeak. hello");
    expect(said.source).toBe("add-on");
    expect(made).toEqual(["Squeak. hello"]);
  });

  it("keeps the Mac's clip when it arrives while the plain one is being made, and uses it after", async () => {
    const gate = deferred();
    const cache = new CachedSpeaker(speakerOf(gate.promise));
    const pending = cache.speakDetailed("Squeak. hello");
    await tick(10);
    const mac = path.join(dir, "mac-0.wav");
    fs.writeFileSync(mac, "mac");
    cache.seed("Squeak. hello", { file: mac, durationMs: 500 });
    gate.resolve();
    expect((await pending).file).toBe(mac);
    expect((await cache.speakDetailed("Squeak. hello")).source).toBe("mac");
  });

  it("uses a clip seeded before the line is spoken, without making one", async () => {
    const cache = new CachedSpeaker(speakerOf(null));
    const mac = path.join(dir, "mac-1.wav");
    fs.writeFileSync(mac, "mac");
    cache.seed("Which one?", { file: mac, durationMs: 500 });
    expect((await cache.speakDetailed("Which one?")).source).toBe("mac");
    expect(made).toEqual([]);
  });
});

describe("rendering and versions", () => {
  it("hands each clip over the moment it is made, greeting first", async () => {
    const got: string[] = [];
    const natural = { usable: true, clip: async (text: string): Promise<Clip | null> => clipOf(text) };
    const clips = await renderCallClips(natural, script, "none", 5000, Date.now, (clip) => got.push(clip.text));
    expect(got[0]).toContain("has a question for you");
    expect(clips?.map((c) => c.text)).toEqual(got);
  });

  it("knows which add-on versions take clips late", () => {
    expect(addonSupports("0.11.0", "0.11.0")).toBe(true);
    expect(addonSupports("0.12.3", "0.11.0")).toBe(true);
    expect(addonSupports("0.10.0", "0.11.0")).toBe(false);
    expect(addonSupports(undefined, "0.11.0")).toBe(false);
    expect(addonSupports("junk", "0.11.0")).toBe(false);
  });
});
