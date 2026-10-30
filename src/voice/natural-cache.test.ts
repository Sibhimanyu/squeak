import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assembleLine, normalizeText, SentenceCache, splitSentences } from "./natural-cache.js";
import { fixedPhrases, NaturalVoice, type NaturalSettings } from "./natural-voice.js";

const dirs: string[] = [];
const voices: NaturalVoice[] = [];
afterEach(() => {
  for (const v of voices.splice(0)) v.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-nat-cache-"));
  dirs.push(d);
  return d;
}

/** A fake Kokoro worker: 24 kHz audio 100 samples per character, a per-request log, optional delay and crash. */
function fakeVoice(
  opts: { delayMs?: number; model?: string; slowWord?: string; slowMs?: number } = {},
  settings: NaturalSettings = { enabled: true, voice: "af_heart" },
) {
  const dir = tmp();
  const worker = path.join(dir, "worker.cjs");
  const log = path.join(dir, "requests.jsonl");
  fs.writeFileSync(
    worker,
    `
    const fs = require("node:fs");
    const os = require("node:os");
    const readline = require("node:readline");
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ started: process.pid, nice: os.getPriority(0) }) + "\\n");
    console.log(JSON.stringify({ready:true}));
    readline.createInterface({input:process.stdin}).on("line", line => {
      const r = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text: r.text, voice: r.voice, pid: process.pid, nice: os.getPriority(0) }) + "\\n");
      const n = r.text.length * 300;
      const wav = Buffer.alloc(44 + n * 2);
      wav.write("data", 36);
      wav.writeUInt32LE(n * 2, 40);
      for (let i = 0; i < n; i++) wav.writeInt16LE(8000, 44 + i * 2);
      setTimeout(() => { fs.writeFileSync(r.out, wav); console.log(JSON.stringify({id:r.id,ok:true})); }, ${opts.slowWord ? `r.text.includes(${JSON.stringify(opts.slowWord)}) ? ${opts.slowMs ?? 0} : ` : ""}${opts.delayMs ?? 0});
    });
  `,
  );
  fs.writeFileSync(path.join(dir, "model"), opts.model ?? "m1");
  const natural = new NaturalVoice(
    { dir, python: process.execPath, worker, model: path.join(dir, "model"), voices: worker },
    () => settings,
    { cacheDir: path.join(dir, "cache"), backgroundIdleMs: 50 },
  );
  voices.push(natural);
  const requests = (): Array<{ text?: string; voice?: string; nice: number; pid?: number; started?: number }> =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return { natural, dir, requests, settings };
}

describe("splitSentences", () => {
  it("splits at sentence ends, joins short fragments and cuts long runs at commas", () => {
    expect(splitSentences("Hello, this is Squeak. Blume needs an answer. Which way should we go?")).toEqual([
      "Hello, this is Squeak.",
      "Blume needs an answer.",
      "Which way should we go?",
    ]);
    expect(splitSentences("Sent A. Goodbye.")).toEqual(["Sent A. Goodbye."]);
    expect(splitSentences("  ")).toEqual([]);
    const long = Array.from({ length: 12 }, (_, i) => `part number ${i} of it`).join(", ") + ".";
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 175)).toBe(true);
    expect(normalizeText(parts.join(" "))).toBe(long);
  });
});

describe("assembleLine", () => {
  it("pads once and puts a natural gap between pieces", () => {
    const a = new Int16Array(800).fill(1);
    const b = new Int16Array(400).fill(2);
    const line = assembleLine([a, b], 300, 250, 120);
    expect(line.length).toBe(2400 + 800 + 960 + 400 + 2000);
    expect(line[2400]).toBe(1);
    expect(line[2400 + 800 + 10]).toBe(0);
    expect(line[2400 + 800 + 960]).toBe(2);
    expect(assembleLine([a], 300, 250).length).toBe(2400 + 800 + 2000);
  });
});

describe("SentenceCache", () => {
  it("evicts the least recently used pieces past its bound, and keys by voice, speed and text", () => {
    const dir = tmp();
    const cache = new SentenceCache(dir, "t", 20_000, 2);
    const keys = ["a", "b", "c", "d"].map((t) => cache.key("af_heart", 1, t));
    expect(new Set(keys).size).toBe(4);
    expect(cache.key("af_heart", 1, "x  y")).toBe(cache.key("af_heart", 1, "x y"));
    expect(cache.key("am_adam", 1, "a")).not.toBe(keys[0]);
    expect(cache.key("af_heart", 1.1, "a")).not.toBe(keys[0]);
    const pcm = new Int16Array(3000); // 6044 bytes a file
    const base = Date.now() / 1000 - 100;
    keys.forEach((k, i) => {
      cache.put(k, pcm);
      fs.utimesSync(path.join(dir, `${k}.wav`), base + i, base + i);
    });
    cache.put(cache.key("af_heart", 1, "e"), pcm);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith(".wav"));
    expect(left.length).toBeLessThan(5);
    expect(left).toContain(`${cache.key("af_heart", 1, "e")}.wav`);
    expect(left).not.toContain(`${keys[0]}.wav`);
    expect(new SentenceCache(dir, "t").get(keys[0]!)).toBeNull();
  });

  it("does not reuse pieces under another engine version", () => {
    const dir = tmp();
    const v1 = new SentenceCache(dir, "v1");
    v1.put(v1.key("af_heart", 1, "hi there"), new Int16Array(100));
    const v2 = new SentenceCache(dir, "v2");
    expect(v2.get(v2.key("af_heart", 1, "hi there"))).toBeNull();
    expect(v1.get(v1.key("af_heart", 1, "hi there"))).toHaveLength(100);
  });
});

describe("NaturalVoice sentence cache", () => {
  it("renders each sentence once, then answers from disk, even in a new process", async () => {
    const { natural, dir, requests } = fakeVoice();
    const text = "Hello, this is Squeak. Blume needs an answer.";
    const first = await natural.clip(text);
    expect(first?.text).toBe(text);
    expect(requests().filter((r) => r.text)).toHaveLength(2);
    await natural.clip(text);
    await natural.clip("Hello, this is Squeak. Something else entirely.");
    expect(
      requests()
        .filter((r) => r.text)
        .map((r) => r.text),
    ).toEqual(["Hello, this is Squeak.", "Blume needs an answer.", "Something else entirely."]);
    expect(natural.cacheHitRate).toBeGreaterThan(0.3);
    natural.stop();
    const again = new NaturalVoice(
      {
        dir,
        python: process.execPath,
        worker: path.join(dir, "worker.cjs"),
        model: path.join(dir, "model"),
        voices: path.join(dir, "worker.cjs"),
      },
      () => ({ enabled: true, voice: "af_heart" }),
      { cacheDir: path.join(dir, "cache") },
    );
    voices.push(again);
    const before = requests().length;
    expect((await again.clip(text))?.mulaw).toBe(first?.mulaw);
    expect(requests().length).toBe(before); // nothing rendered, not even a worker started
  });

  it("assembles a cached line with the gap and pads, in a few milliseconds", async () => {
    const { natural } = fakeVoice();
    const text = "Press star to hear this again. Goodbye now, friend.";
    await natural.wav(text);
    const t0 = performance.now();
    const made = await natural.wav(text);
    expect(performance.now() - t0).toBeLessThan(250);
    // 2 pieces of 100 chars-ish at 300 samples/char@24k -> 100/char@8k, plus 300 + 120 + 250 ms of silence.
    const chars = "Press star to hear this again.".length + "Goodbye now, friend.".length;
    expect(made?.durationMs).toBe(Math.round(((chars * 100 + 2400 + 960 + 2000) / 8000) * 1000));
  });

  it("changes nothing for another voice, and a replaced model invalidates the cache", async () => {
    const a = fakeVoice();
    await a.natural.clip("Hello, this is Squeak.");
    await a.natural.clip("Hello, this is Squeak.", { voice: "am_adam" });
    expect(
      a
        .requests()
        .filter((r) => r.text)
        .map((r) => r.voice),
    ).toEqual(["af_heart", "am_adam"]);
    a.natural.stop();
    fs.writeFileSync(path.join(a.dir, "model"), "a much bigger replacement model");
    const b = new NaturalVoice(
      {
        dir: a.dir,
        python: process.execPath,
        worker: path.join(a.dir, "worker.cjs"),
        model: path.join(a.dir, "model"),
        voices: path.join(a.dir, "worker.cjs"),
      },
      () => ({ enabled: true, voice: "af_heart" }),
      { cacheDir: path.join(a.dir, "cache") },
    );
    voices.push(b);
    const before = a.requests().filter((r) => r.text).length;
    await b.clip("Hello, this is Squeak.");
    expect(a.requests().filter((r) => r.text).length).toBe(before + 1);
  });

  it("reports the first sentence before the rest is made", async () => {
    const { natural } = fakeVoice({ delayMs: 60 });
    const times: number[] = [];
    const t0 = performance.now();
    const clip = await natural.clip("One sentence here. Two sentences here. Three sentences here.", {
      onSentence: ({ index, total }) => {
        expect(total).toBe(3);
        expect(index).toBe(times.length);
        times.push(performance.now() - t0);
      },
    });
    expect(clip).not.toBeNull();
    expect(times).toHaveLength(3);
    expect(times[0]!).toBeLessThan(times[2]! - 50);
  });

  it("deduplicates the same sentence asked twice at once", async () => {
    const { natural, requests } = fakeVoice({ delayMs: 30 });
    await Promise.all([natural.clip("Same words here."), natural.clip("Same words here.")]);
    expect(requests().filter((r) => r.text)).toHaveLength(1);
  });

  it("returns null when the worker cannot make a sentence, and caches nothing for it", async () => {
    const { natural } = fakeVoice();
    const off = new NaturalVoice(
      { dir: "/nonexistent", python: "/nope", worker: "/nope", model: "/nope", voices: "/nope" },
      () => ({ enabled: true, voice: "af_heart" }),
    );
    voices.push(off);
    expect(await off.clip("Hello there.")).toBeNull();
    expect(await natural.clip("")).toBeNull();
  });
});

describe("priority and warm-up", () => {
  it("warms the worker before any call, with a tiny render", async () => {
    const { natural, requests } = fakeVoice();
    expect(requests()).toHaveLength(0);
    expect(await natural.warm()).toBe(true);
    const seen = requests();
    expect(seen[0]?.started).toBeTypeOf("number");
    expect(seen[1]?.text).toBe("Hello.");
    const pid = seen[0]!.started;
    await natural.clip("Hello, this is Squeak.");
    expect(requests().every((r) => !r.pid || r.pid === pid)).toBe(true); // the same process served the call
  });

  it("restarts a kept-warm worker that dies", async () => {
    const dir = tmp();
    const worker = path.join(dir, "w.cjs");
    const marks = path.join(dir, "marks");
    fs.writeFileSync(
      worker,
      `const fs=require("node:fs");const readline=require("node:readline");
      fs.appendFileSync(${JSON.stringify(marks)}, "s");
      console.log(JSON.stringify({ready:true}));
      readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);
        const n=2400;const wav=Buffer.alloc(44+n*2);wav.write("data",36);wav.writeUInt32LE(n*2,40);
        fs.writeFileSync(r.out,wav);console.log(JSON.stringify({id:r.id,ok:true}));
        if(fs.readFileSync(${JSON.stringify(marks)},"utf8").length===1) setTimeout(()=>process.exit(1),20);
      });`,
    );
    const natural = new NaturalVoice(
      { dir, python: process.execPath, worker, model: worker, voices: worker },
      () => ({ enabled: true, voice: "af_heart" }),
      { cacheDir: path.join(dir, "cache"), restartDelayMs: 10 },
    );
    voices.push(natural);
    await natural.warm();
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.readFileSync(marks, "utf8").length).toBe(2);
  });

  it("renders background work niced and ringing-call work at normal priority", async () => {
    const { natural, requests } = fakeVoice();
    const result = await natural.prewarm(["Hello, this is Squeak. Goodbye for now, friend."]);
    expect(result).toEqual({ rendered: 2, cached: 0 });
    await natural.clip("A question for the person.");
    const byText = Object.fromEntries(requests().flatMap((r) => (r.text ? [[r.text, r.nice]] : [])));
    expect(byText["Hello, this is Squeak."]).toBe(10);
    expect(byText["Goodbye for now, friend."]).toBe(10);
    expect(byText["A question for the person."]).toBe(0);
    // Pre-rendered pieces are then instant for a call, and prewarming again does nothing.
    const before = requests().length;
    await natural.clip("Hello, this is Squeak. Goodbye for now, friend.", { priority: "urgent" });
    expect(requests().length).toBe(before);
    expect(await natural.prewarm(["Hello, this is Squeak. Goodbye for now, friend."])).toEqual({
      rendered: 0,
      cached: 2,
    });
  });

  it("does not make an urgent call wait behind background renders", async () => {
    // Only the background sentences are slow (600 ms each, one after the other), so the urgent line has 1.2 s of slack.
    const { natural } = fakeVoice({ slowWord: "Background", slowMs: 600 });
    let backgroundDone = false;
    const background = natural
      .prewarm(["Background one is long enough.", "Background two is long enough."])
      .then(() => {
        backgroundDone = true;
      });
    await new Promise((r) => setTimeout(r, 20));
    await natural.clip("An urgent sentence goes here.");
    // The urgent line ran beside the background renders, not after them (a wall-clock limit is flaky under load).
    expect(backgroundDone).toBe(false);
    await background;
  });

  it("lists the fixed phrases the flows say", () => {
    const phrases = fixedPhrases();
    expect(phrases).toContain("Hello, this is Squeak.");
    expect(phrases).toContain("Goodbye.");
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});
