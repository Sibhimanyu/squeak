import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { encodeMulaw, mulawToLinear, mulawToWav, readClips } from "./clips.js";
import {
  callPrompts,
  downsampleToLine,
  NaturalSettingsStore,
  NaturalVoice,
  naturalPaths,
  type NaturalSettings,
  readPcm24k,
  refreshWorker,
  renderCallClips,
} from "./natural-voice.js";
import { WORKER_MARKER } from "./natural-worker-mlx.js";
import { VOICE_ENGINES, type EngineId } from "./voice-engines.js";
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
    expect(callPrompts(script, "ask")[0]).toContain("enter your PIN");
    expect(callPrompts(script, "none")[0]).toBe(`${script.greeting} ${script.question}`);
    expect(callPrompts({ ...script, options: [] }, "ask")).toEqual([`${script.greeting} ${script.question}`]);
    expect(callPrompts(script, "both").length).toBeGreaterThan(callPrompts(script, "ask").length);
  });
});

describe("renderCallClips", () => {
  it("skips prompts that fail and returns undefined when none work or the voice is off", async () => {
    const clip = async (text: string) => (text.includes("PIN is not right") ? null : { text, mulaw: "AAAA" });
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
  const fileIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nat-")), "n.json");

  it("defaults on, validates, and persists", () => {
    const file = fileIn();
    const store = new NaturalSettingsStore(file);
    expect(store.settings).toEqual({
      enabled: true,
      engine: "kokoro",
      emotion: "subtle",
      voices: {},
      voice: "af_heart",
    });
    expect(store.apply({ voice: "../x" }).ok).toBe(false);
    expect(store.apply({ other: 1 }).ok).toBe(false);
    expect(store.apply({ enabled: false, voice: "am_michael" }).ok).toBe(true);
    expect(new NaturalSettingsStore(file).settings).toMatchObject({ enabled: false, voice: "am_michael" });
  });

  it("reads the first form of the file as Kokoro, and keeps writing Kokoro's voice for an older daemon", () => {
    const file = fileIn();
    fs.writeFileSync(file, JSON.stringify({ enabled: false, voice: "bm_george" }));
    const store = new NaturalSettingsStore(file);
    expect(store.settings).toMatchObject({ enabled: false, engine: "kokoro", voice: "bm_george" });
    expect(store.apply({ engine: "qwen3", voice: "aiden", emotion: "strong" })).toEqual({ ok: true });
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ engine: "qwen3", emotion: "strong", voice: "bm_george" });
    expect(written.voices).toEqual({ kokoro: "bm_george", qwen3: "aiden" });
    expect(new NaturalSettingsStore(file).settings).toMatchObject({ engine: "qwen3", voice: "aiden" });
  });

  it("takes a voice for the engine set with it, else the current one, and each engine keeps its own", () => {
    const store = new NaturalSettingsStore(fileIn());
    expect(store.apply({ engine: "ming" })).toEqual({ ok: true });
    expect(store.settings.voice).toBe("US_Emma");
    expect(store.apply({ voice: "af_heart" }).ok).toBe(false); // a Kokoro name is not a Ming voice
    expect(store.apply({ voice: "UK_George" })).toEqual({ ok: true });
    expect(store.apply({ engine: "kokoro", voice: "am_adam" })).toEqual({ ok: true });
    expect(store.apply({ engine: "ming" })).toEqual({ ok: true });
    expect(store.settings.voice).toBe("UK_George");
    expect(store.apply({ engine: "ming", voice: "nobody" }).ok).toBe(false);
  });

  it("refuses an unknown engine or emotion, and a switch to an engine that is not installed", () => {
    const store = new NaturalSettingsStore(fileIn(), (engine) => engine === "kokoro");
    expect(store.apply({ engine: "elevenlabs" }).ok).toBe(false);
    expect(store.apply({ emotion: "loud" }).ok).toBe(false);
    expect(store.apply({ emotion: "off" })).toEqual({ ok: true });
    expect(store.apply({ engine: "qwen3" })).toEqual({
      ok: false,
      reason: "Set up Qwen3-TTS (expressive) on the Mac first.",
    });
    expect(store.settings.engine).toBe("kokoro");
  });
});

describe("engines in one NaturalVoice", () => {
  /** A worker that records each request and writes a tone, one file per engine so the tests can tell which ran. */
  function fakeEngines() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-engines-test-"));
    const record = path.join(dir, "requests.jsonl");
    const worker = path.join(dir, "worker.cjs");
    fs.writeFileSync(
      worker,
      `
      const fs = require("node:fs");
      const readline = require("node:readline");
      console.log(JSON.stringify({ready:true}));
      readline.createInterface({input:process.stdin}).on("line", line => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ ...request, pid: process.pid, worker: process.argv[1], model: process.argv[2] }) + "\\n");
        const wav = Buffer.alloc(44 + 9600);
        wav.write("data", 36);
        wav.writeUInt32LE(9600, 40);
        fs.writeFileSync(request.out, wav);
        console.log(JSON.stringify({id:request.id,ok:true}));
      });
    `,
    );
    const weights = path.join(dir, "weights.bin");
    fs.writeFileSync(weights, "x");
    const pathsFor = (engine: EngineId) => ({
      dir: path.join(dir, engine),
      python: process.execPath,
      worker,
      model: weights,
      voices: weights,
      engine,
    });
    const requests = () =>
      fs.existsSync(record)
        ? fs
            .readFileSync(record, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [];
    return { dir, pathsFor, requests };
  }

  it("sends the mood and level with each render, and neutral/off when emotion is off or the engine has none", async () => {
    const { dir, pathsFor, requests } = fakeEngines();
    const settings: NaturalSettings = { enabled: true, voice: "ryan", engine: "qwen3", emotion: "strong" };
    const natural = new NaturalVoice(pathsFor, () => settings, { cacheDir: path.join(dir, "cache") });
    try {
      await natural.line("Squeak needs an answer.");
      settings.emotion = "off";
      await natural.line("Squeak needs a different answer.");
      settings.engine = "kokoro";
      settings.voice = "af_heart";
      settings.emotion = "strong";
      await natural.line("Squeak needs one more answer.");
      expect(requests().map((r) => [r.mood, r.level])).toEqual([
        ["urgent", "strong"],
        ["neutral", "off"],
        ["neutral", "off"],
      ]);
    } finally {
      natural.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keys the cache by engine, voice, mood and level, so switching never plays the wrong clip", async () => {
    const { dir, pathsFor, requests } = fakeEngines();
    const settings: NaturalSettings = { enabled: true, voice: "ryan", engine: "qwen3", emotion: "subtle" };
    const natural = new NaturalVoice(pathsFor, () => settings, { cacheDir: path.join(dir, "cache") });
    try {
      const say = "Squeak needs an answer.";
      await natural.line(say);
      await natural.line(say);
      expect(requests()).toHaveLength(1); // the second was cached
      settings.emotion = "strong";
      await natural.line(say);
      settings.voice = "aiden";
      await natural.line(say);
      settings.engine = "ming";
      settings.voice = "US_Emma";
      await natural.line(say);
      expect(requests()).toHaveLength(4);
      settings.engine = "qwen3";
      settings.voice = "ryan";
      settings.emotion = "subtle";
      await natural.line(say);
      expect(requests()).toHaveLength(4); // back to the first: still cached
    } finally {
      natural.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs one worker for an MLX engine (urgent and background share it) and stops the old engine on a switch", async () => {
    const { dir, pathsFor, requests } = fakeEngines();
    const settings: NaturalSettings = { enabled: true, voice: "ryan", engine: "qwen3", emotion: "subtle" };
    const natural = new NaturalVoice(pathsFor, () => settings, { cacheDir: path.join(dir, "cache") });
    try {
      await natural.line("Hello there, this is a first line.", { priority: "urgent" });
      await natural.line("Another quite different line here.", { priority: "background" });
      expect(new Set(requests().map((r) => r.pid)).size).toBe(1);
      const first = requests()[0]!.pid as number;
      settings.engine = "kokoro";
      settings.voice = "af_heart";
      await natural.line("Kokoro line, number one here.", { priority: "urgent" });
      await natural.line("Kokoro line, number two here.", { priority: "background" });
      expect(new Set(requests().map((r) => r.pid)).size).toBe(3); // Kokoro keeps its two
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(() => process.kill(first, 0)).toThrow(); // the Qwen3 worker is gone
    } finally {
      natural.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews another engine's voice without changing the current one, then stops its worker", async () => {
    const { dir, pathsFor, requests } = fakeEngines();
    const settings: NaturalSettings = { enabled: true, voice: "af_heart", engine: "kokoro" };
    const natural = new NaturalVoice(pathsFor, () => settings);
    try {
      expect(await natural.preview("US_James", "ming")).not.toBeNull();
      expect(requests()[0]).toMatchObject({ voice: "US_James", mood: "urgent", level: "subtle" });
      expect(await natural.preview("af_heart", "ming")).toBeNull(); // not one of Ming's voices
      expect(await natural.preview("ryan", "kokoro")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(() => process.kill(requests()[0]!.pid as number, 0)).toThrow();
      expect(settings.engine).toBe("kokoro");
    } finally {
      natural.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back (null) when the engine's worker cannot start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-engines-test-"));
    const broken = path.join(dir, "worker.cjs");
    fs.writeFileSync(broken, "process.exit(1)");
    const file = path.join(dir, "w");
    fs.writeFileSync(file, "x");
    const natural = new NaturalVoice(
      (engine) => ({ dir, python: process.execPath, worker: broken, model: file, voices: file, engine }),
      () => ({ enabled: true, voice: "ryan", engine: "qwen3" }),
      { cacheDir: path.join(dir, "cache") },
    );
    try {
      expect(await natural.line("This line will not be made.")).toBeNull();
      expect(await natural.wav("Nor will this one, either.")).toBeNull();
    } finally {
      natural.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe("voice preview", () => {
  it("uses an explicit voice and fixed text through the call worker even when calls use plain speech", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-preview-test-"));
    const worker = path.join(dir, "worker.cjs");
    const record = path.join(dir, "requests.jsonl");
    fs.writeFileSync(
      worker,
      `
      const fs = require("node:fs");
      const readline = require("node:readline");
      console.log(JSON.stringify({ready:true}));
      readline.createInterface({input:process.stdin}).on("line", line => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(record)}, line + "\\n");
        const wav = Buffer.alloc(44 + 4800);
        wav.write("data", 36);
        wav.writeUInt32LE(4800, 40);
        fs.writeFileSync(request.out, wav);
        console.log(JSON.stringify({id:request.id,ok:true}));
      });
    `,
    );
    const settings = { enabled: false, voice: "af_heart" };
    const natural = new NaturalVoice(
      { dir, python: process.execPath, worker, model: worker, voices: worker },
      () => settings,
    );
    try {
      const wav = await natural.preview("am_michael");
      expect(wav?.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav?.readUInt32LE(24)).toBe(8000);
      expect(wav?.length).toBe(1644 + 2 * 4400); // plus 300 ms lead and 250 ms tail of silence
      const request = JSON.parse(fs.readFileSync(record, "utf8").trim()) as { voice: string; text: string };
      expect(request.voice).toBe("am_michael");
      expect(request.text).toContain("Your agent needs an answer");
      expect(settings).toEqual({ enabled: false, voice: "af_heart" });
      expect(await natural.preview("../../bad")).toBeNull();
      expect(fs.readFileSync(record, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      natural.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("read-back clips", () => {
  const mulaw = (bytes: number, fill: number): string => Buffer.alloc(bytes, fill).toString("base64");

  it("joins two clips into one, dropping the join's pads and keeping a short gap", async () => {
    const {
      joinClips,
      TAIL_SILENCE_MS: tailMs,
      LEAD_SILENCE_MS: leadMs,
      JOIN_GAP_MS,
    } = await import("./natural-voice.js");
    const a = { text: "a", mulaw: mulaw(8000, 0x10) };
    const b = { text: "b", mulaw: mulaw(8000, 0x20) };
    const joined = joinClips(a, b, "a b");
    const bytes = Buffer.from(joined.mulaw, "base64").length;
    expect(joined.text).toBe("a b");
    expect(bytes).toBe(8000 - tailMs * 8 + JOIN_GAP_MS * 8 + 8000 - leadMs * 8);
  });

  it("renders only what was heard per call and keeps the suffix", async () => {
    const { ReadBackClips } = await import("./natural-voice.js");
    const { readBackSentence } = await import("./inbound-flow.js");
    const said: string[] = [];
    const natural = {
      usable: true,
      clip: async (text: string) => (said.push(text), { text, mulaw: mulaw(8000, 0x30) }),
    };
    const clips = new ReadBackClips(natural, () => "af_heart");
    await clips.prepare(["Chat A"]);
    const one = await clips.clip("go ahead.", "Chat A");
    const two = await clips.clip("something else", "Chat A");
    expect(one?.text).toBe(readBackSentence("go ahead.", "Chat A"));
    expect(two?.text).toBe(readBackSentence("something else", "Chat A"));
    expect(said.filter((t) => t.startsWith("Press 1"))).toHaveLength(1);
    expect(said.filter((t) => t.startsWith("I heard"))).toHaveLength(2);
    expect(await clips.clip("x".repeat(400), "Chat A")).toBeUndefined();
  });
});

describe("refreshWorker", () => {
  it("replaces an MLX engine's older Squeak script, and leaves a missing or hand-made one alone", () => {
    const support = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-refresh-"));
    const paths = naturalPaths(support, "ming");
    refreshWorker(paths);
    expect(fs.existsSync(paths.worker)).toBe(false);
    fs.mkdirSync(path.dirname(paths.worker), { recursive: true });
    fs.writeFileSync(paths.worker, "print('a script put here by hand')\n");
    refreshWorker(paths);
    expect(fs.readFileSync(paths.worker, "utf8")).toBe("print('a script put here by hand')\n");
    fs.writeFileSync(paths.worker, `${WORKER_MARKER}\n# an older worker\n`);
    refreshWorker(paths);
    expect(fs.readFileSync(paths.worker, "utf8")).toBe(VOICE_ENGINES.ming.worker);
    fs.rmSync(support, { recursive: true, force: true });
  });
});
