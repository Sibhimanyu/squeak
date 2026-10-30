import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { encodeMulaw, mulawToLinear, mulawToWav, readClips } from "./clips.js";
import { callPrompts, downsampleToLine, NaturalSettingsStore, readPcm24k, renderCallClips } from "./natural-voice.js";
import { openBody, readRequest, sealRequest } from "./relay-protocol.js";
import { randomBytes } from "node:crypto";

const script = {
  greeting: "Squeak. Blume needs an answer.",
  question: "Which way? Press 1 for A.",
  options: [{ letter: "A", title: "Merge" }],
};

describe("mu-law clips", () => {
  it("round-trips a tone within G.711 error", () => {
    const pcm = Int16Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 5) * 12000));
    const back = encodeMulaw(pcm);
    for (let i = 0; i < pcm.length; i += 1) {
      expect(Math.abs(mulawToLinear(back[i]!) - pcm[i]!)).toBeLessThan(Math.abs(pcm[i]!) * 0.07 + 40);
    }
  });

  it("makes a WAV the right length", () => {
    const wav = mulawToWav(Buffer.alloc(8000, 0xff));
    expect(wav.length).toBe(44 + 16000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("refuses malformed or oversized clips", () => {
    expect(readClips([{ text: "hi", mulaw: "AAAA" }])).toHaveLength(1);
    expect(readClips([{ text: "", mulaw: "AAAA" }])).toBeUndefined();
    expect(readClips([{ text: "hi", mulaw: "not base64!" }])).toBeUndefined();
    expect(readClips([{ text: "hi", mulaw: "A".repeat(600_000) }])).toBeUndefined();
    expect(readClips("x")).toBeUndefined();
  });
});

describe("audio in a sealed request", () => {
  it("travels sealed and is read back; bad audio is dropped, not fatal", () => {
    const key = randomBytes(32).toString("base64");
    const at = Date.now();
    const base = { v: 1 as const, id: "abc", at, expiresAt: at + 60_000, answerable: true, script };
    const clip = { text: script.greeting, mulaw: Buffer.alloc(80, 0xff).toString("base64") };
    const read = readRequest(key, "abc", sealRequest(key, { ...base, audio: [clip] }), at);
    expect(read.ok && read.request.audio).toEqual([clip]);
    const plain = readRequest(key, "abc", sealRequest(key, base), at);
    expect(plain.ok && plain.request.audio).toBeUndefined();
    expect(openBody(key, "req", "abc", sealRequest(key, base))).toBeTruthy();
  });
});

describe("downsample and wav reading", () => {
  it("takes 24 kHz to a third as many samples and keeps a low tone", () => {
    const pcm = Int16Array.from({ length: 2400 }, (_, i) =>
      Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 10000),
    );
    const out = downsampleToLine(pcm);
    expect(out.length).toBe(800);
    expect(Math.max(...out.slice(100, 700))).toBeGreaterThan(8000);
  });

  it("removes a tone above the line's band", () => {
    const pcm = Int16Array.from({ length: 2400 }, (_, i) =>
      Math.round(Math.sin((2 * Math.PI * 9000 * i) / 24000) * 10000),
    );
    expect(Math.max(...downsampleToLine(pcm).slice(100, 700))).toBeLessThan(500);
  });

  it("reads the samples of a worker WAV", () => {
    const wav = mulawToWav(Buffer.alloc(10, 0xff));
    expect(readPcm24k(wav)).toHaveLength(10);
  });
});

describe("callPrompts", () => {
  it("covers the pin dialog, the pinless one, or only a tell", () => {
    expect(callPrompts(script, "ask")[0]).toContain("enter your pin");
    expect(callPrompts(script, "none")[0]).toBe(`${script.greeting} ${script.question}`);
    expect(callPrompts({ ...script, options: [] }, "ask")).toEqual([`${script.greeting} ${script.question}`]);
    expect(callPrompts(script, "both").length).toBeGreaterThan(callPrompts(script, "ask").length);
  });
});

describe("renderCallClips", () => {
  it("skips prompts that fail and returns undefined when none work or the voice is off", async () => {
    const clip = async (text: string) => (text.includes("pin is not right") ? null : { text, mulaw: "AAAA" });
    const got = await renderCallClips({ usable: true, clip }, script, "ask");
    expect(got?.length).toBeGreaterThan(0);
    expect(got?.every((c) => !c.text.includes("not right"))).toBe(true);
    expect(await renderCallClips({ usable: false, clip }, script, "ask")).toBeUndefined();
    expect(await renderCallClips({ usable: true, clip: async () => null }, script, "ask")).toBeUndefined();
  });

  it("stops at the time budget", async () => {
    let t = 0;
    const got = await renderCallClips(
      { usable: true, clip: async (text) => ((t += 20_000), { text, mulaw: "AAAA" }) },
      script,
      "ask",
      25_000,
      () => t,
    );
    expect(got).toHaveLength(2);
  });
});

describe("NaturalSettingsStore", () => {
  it("defaults on, validates, and persists", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nat-")), "n.json");
    const store = new NaturalSettingsStore(file);
    expect(store.settings).toEqual({ enabled: true, voice: "af_heart" });
    expect(store.apply({ voice: "../x" }).ok).toBe(false);
    expect(store.apply({ other: 1 }).ok).toBe(false);
    expect(store.apply({ enabled: false, voice: "am_michael" }).ok).toBe(true);
    expect(new NaturalSettingsStore(file).settings).toEqual({ enabled: false, voice: "am_michael" });
  });
});

describe("RelayLine with clips", () => {
  it("writes the audio with a long timeout, and sends the call without it if that write fails", async () => {
    const { RelayLine } = await import("./relay-line.js");
    const key = randomBytes(32).toString("base64");
    const writes: Array<{ audio: boolean; timeoutMs?: number }> = [];
    const store = {
      set: async (_path: string, doc: { box: string }, options: { timeoutMs?: number } = {}) => {
        const body = openBody(key, "req", _path.split("/").pop()!, doc as never) as { audio?: unknown };
        writes.push({ audio: Boolean(body.audio), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
        if (body.audio) throw new Error("timed out");
      },
      get: async () => null,
      delete: async () => undefined,
      watch: (_path: string, onChange: () => void) => {
        setTimeout(onChange, 0);
        return () => undefined;
      },
    };
    let t = 0;
    const line = new RelayLine({
      store: store as never,
      channel: "c".repeat(22),
      key,
      clips: async () => [{ text: "hi", mulaw: "AAAA" }],
      now: () => (t += 400_000),
    });
    await line.call(script, true);
    expect(writes).toEqual([{ audio: true, timeoutMs: 90_000 }, { audio: false }]);
  });
});
