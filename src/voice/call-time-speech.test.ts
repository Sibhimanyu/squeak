import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mulawToWav } from "./clips.js";
import { CachedSpeaker, CLIP_PAD_MS, isLineFormat, padClip, wavDurationMs, type Speaker } from "./tts.js";
import { wavOf } from "./sip-phone.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calltime-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function speakerNamed(name: string, made: string[]): Speaker {
  return {
    speak: async (text) => {
      made.push(`${name}:${text}`);
      const file = path.join(dir, `${name}-${made.length}.wav`);
      fs.writeFileSync(file, wavOf(new Int16Array(8000))); // 1 s
      return { file, durationMs: 1000 };
    },
    dispose: () => undefined,
  };
}

describe("clips played into a call", () => {
  it("carry 300 ms of trailing silence, counted in their length", async () => {
    const made: string[] = [];
    const cache = new CachedSpeaker(speakerNamed("main", made));
    const said = await cache.speakDetailed("Hello.");
    expect(said.durationMs).toBe(1000 + CLIP_PAD_MS);
    const wav = fs.readFileSync(said.file);
    expect(wavDurationMs(wav)).toBe(1300);
    // the padding is silence, and the speech before it is untouched
    expect(wav.readInt16LE(wav.length - 2)).toBe(0);
  });

  it("pads a Mac clip once, on arrival, and plays it from the padded file", async () => {
    const cache = new CachedSpeaker(speakerNamed("main", []));
    const mac = path.join(dir, "mac-0.wav");
    fs.writeFileSync(mac, mulawToWav(Buffer.alloc(8000, 0xff))); // 1 s of mu-law silence
    cache.seed("Which one?", { file: mac, durationMs: 1000 });
    const said = await cache.speakDetailed("Which one?");
    expect(said.source).toBe("mac");
    expect(said.durationMs).toBe(1300);
    expect(wavDurationMs(fs.readFileSync(said.file))).toBe(1300);
  });
});

describe("format", () => {
  it("accepts 8 kHz mono PCM16 and does not pad (or hide) anything else", () => {
    expect(isLineFormat(wavOf(new Int16Array(10)))).toBe(true);
    const wrong = wavOf(new Int16Array(10));
    wrong.writeUInt32LE(16000, 24); // 16 kHz
    expect(isLineFormat(wrong)).toBe(false);
    const file = path.join(dir, "wrong.wav");
    fs.writeFileSync(file, wrong);
    expect(padClip({ file, durationMs: 1 })).toEqual({ file, durationMs: 1 });
    expect(isLineFormat(Buffer.from("not a wav"))).toBe(false);
  });
});

describe("no speech is made while a call is up", () => {
  it("a missing line comes from the plain voice, never the natural one", async () => {
    const made: string[] = [];
    let active = false;
    const cache = new CachedSpeaker(speakerNamed("natural", made), 120, {
      callActive: () => active,
      plain: speakerNamed("plain", made),
    });
    await cache.speakDetailed("Before the call.");
    active = true;
    await cache.speakDetailed("Missing mid-call.");
    expect(made).toEqual(["natural:Before the call.", "plain:Missing mid-call."]);
  });

  it("holds a pre-render until the call ends, then makes it", async () => {
    const made: string[] = [];
    let active = true;
    const cache = new CachedSpeaker(speakerNamed("natural", made), 120, { callActive: () => active, plain: null });
    const warming = cache.prewarm(["Menu one."]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(made).toEqual([]);
    active = false;
    await warming;
    expect(made).toEqual(["natural:Menu one."]);
  });

  it("a prepared line costs nothing during the call", async () => {
    const made: string[] = [];
    let active = false;
    const cache = new CachedSpeaker(speakerNamed("natural", made), 120, { callActive: () => active, plain: null });
    await cache.prewarm(["Goodbye."]);
    active = true;
    const said = await cache.speakDetailed("Goodbye.");
    expect(said.makeMs).toBe(0);
    expect(made).toHaveLength(1);
  });
});
