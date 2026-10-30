import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const run = promisify(execFile);

/** 8 kHz mono 16-bit: what a phone line carries, and what baresip's `aufile` plays without resampling. */
const SAMPLE_RATE = 8000;

/** Silence added after every clip played into a call, so a late switch to the next file never starves the far jitter buffer. */
export const CLIP_PAD_MS = 300;

/** The format of a WAV's `fmt ` chunk, or null when it is not a WAV at all. */
export function wavFormat(wav: Buffer): { format: number; channels: number; rate: number; bits: number } | null {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return null;
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt " && at + 8 + 16 <= wav.length) {
      return {
        format: wav.readUInt16LE(at + 8),
        channels: wav.readUInt16LE(at + 10),
        rate: wav.readUInt32LE(at + 12),
        bits: wav.readUInt16LE(at + 22),
      };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** True for what a G.711 line carries without resampling: PCM, mono, 8 kHz, 16-bit. */
export function isLineFormat(wav: Buffer): boolean {
  const f = wavFormat(wav);
  return f !== null && f.format === 1 && f.channels === 1 && f.rate === SAMPLE_RATE && f.bits === 16;
}

/**
 * The clip with CLIP_PAD_MS of silence after it, as a new file beside it (the original stays: a speaker may cache it).
 * A file that is not 8 kHz mono PCM16 is logged and returned as it is: playing it makes baresip resample during the
 * call, which is the thing to find, not to hide.
 */
export function padClip(made: { file: string; durationMs: number }): { file: string; durationMs: number } {
  try {
    const wav = fs.readFileSync(made.file);
    if (!isLineFormat(wav)) {
      logger.warn("voice clip is not 8 kHz mono PCM16: the line would resample it during a call", {
        file: path.basename(made.file),
        format: wavFormat(wav),
      });
      return made;
    }
    let at = 12;
    let dataAt = -1;
    let dataSize = 0;
    while (at + 8 <= wav.length) {
      const size = wav.readUInt32LE(at + 4);
      if (wav.toString("ascii", at, at + 4) === "data") {
        dataAt = at + 8;
        dataSize = Math.min(size, wav.length - dataAt);
        break;
      }
      at += 8 + size + (size % 2);
    }
    if (dataAt < 0) return made;
    const pad = Buffer.alloc(Math.round((SAMPLE_RATE * 2 * CLIP_PAD_MS) / 1000));
    const data = Buffer.concat([wav.subarray(dataAt, dataAt + dataSize), pad]);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(SAMPLE_RATE, 24);
    head.writeUInt32LE(SAMPLE_RATE * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    const file = `${made.file}.pad.wav`;
    fs.writeFileSync(file, Buffer.concat([head, data]), { mode: 0o600 });
    return { file, durationMs: made.durationMs + CLIP_PAD_MS };
  } catch {
    return made;
  }
}

/** Speech as a WAV file the line can play. Injected in tests. */
export interface Speaker {
  /** Writes `text` to a new WAV file and returns its path and length. */
  speak(text: string): Promise<{ file: string; durationMs: number }>;
  dispose(): void;
}

/**
 * Length of a 16-bit mono 8 kHz PCM WAV, read from its `data` chunk: `afconvert` writes a plain
 * header but `ffmpeg` adds a `LIST` chunk, so the header size is not a constant.
 */
export function wavDurationMs(wav: Buffer): number {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "data") return Math.round((Math.min(size, wav.length - at - 8) / (SAMPLE_RATE * 2)) * 1000);
    at += 8 + size + (size % 2);
  }
  return 0;
}

/** macOS `say`, then `afconvert` to a telephone WAV. The text goes in on stdin, never as an argument. */
export class MacSpeaker implements Speaker {
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-voice-"));
  private count = 0;

  constructor(private readonly voice: string | null = null) {}

  async speak(text: string): Promise<{ file: string; durationMs: number }> {
    const base = path.join(this.dir, `p${this.count++}`);
    const args = ["-o", `${base}.aiff`, "-f", "-", ...(this.voice ? ["-v", this.voice] : [])];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("say", args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`say exited ${code}: ${stderr.trim()}`))));
      child.stdin.end(text);
    });
    await run("afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", `${base}.aiff`, `${base}.wav`]);
    fs.rmSync(`${base}.aiff`, { force: true });
    return { file: `${base}.wav`, durationMs: wavDurationMs(fs.readFileSync(`${base}.wav`)) };
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * `espeak-ng` then `ffmpeg` to a telephone WAV: what the Home Assistant add-on uses, since `say` is
 * macOS-only. Plain, but it is a phone line.
 */
export class EspeakSpeaker implements Speaker {
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-voice-"));
  private count = 0;

  async speak(text: string): Promise<{ file: string; durationMs: number }> {
    const began = Date.now();
    const base = path.join(this.dir, `p${this.count++}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("espeak-ng", ["--stdin", "-s", "150", "-w", `${base}.raw.wav`], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`espeak-ng exited ${code}: ${stderr.trim()}`)),
      );
      child.stdin.end(text);
    });
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      `${base}.raw.wav`,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-bitexact",
      `${base}.wav`,
    ]);
    fs.rmSync(`${base}.raw.wav`, { force: true });
    logSpeechTime("plain", text, began);
    return { file: `${base}.wav`, durationMs: wavDurationMs(fs.readFileSync(`${base}.wav`)) };
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

let speechSlowHook: ((ms: number) => void) | null = null;

/** Lets the gateway note a slow prompt where the apps can see it; the logger line stays. */
export function setSpeechSlowHook(fn: ((ms: number) => void) | null): void {
  speechSlowHook = fn;
}

/**
 * How long a prompt took to make, in the log: a slow machine shows here (and a long one during a live call is what
 * makes the line break up), so the cure is a number, not a guess. Never the words themselves.
 */
function logSpeechTime(engine: "plain" | "natural", text: string, began: number): void {
  const ms = Date.now() - began;
  const fields = { engine, ms, chars: text.length };
  if (ms > 3000) {
    logger.warn("voice speech was slow to make: a call that speaks while this runs can break up", fields);
    speechSlowHook?.(ms);
  } else logger.debug("voice speech made", fields);
}

/** Longest Piper may take for one prompt. */
const PIPER_TIMEOUT_MS = 25_000;

export interface PiperPaths {
  binary: string;
  model: string;
  /** Longest Piper may take for one prompt; a test shortens it. */
  timeoutMs?: number;
}

/**
 * Piper, a local neural voice, then `ffmpeg` to a telephone WAV. Much more natural than `espeak-ng`, and the
 * text never leaves the machine. Any failure (a missing binary, a bad model) falls back to the plain voice, so
 * a call is never lost to a speech problem.
 */
export class PiperSpeaker implements Speaker {
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-voice-"));
  private count = 0;

  constructor(
    private readonly paths: PiperPaths,
    private readonly fallback: Speaker,
  ) {}

  /** The same words are spoken again on "press star": say them once. */
  private readonly spoken = new Map<string, { file: string; durationMs: number }>();

  async speak(text: string): Promise<{ file: string; durationMs: number }> {
    const cached = this.spoken.get(text);
    if (cached && fs.existsSync(cached.file)) return cached;
    const made = await this.synthesize(text);
    if (made.file.startsWith(this.dir)) this.spoken.set(text, made);
    return made;
  }

  private async synthesize(text: string): Promise<{ file: string; durationMs: number }> {
    const began = Date.now();
    const base = path.join(this.dir, `p${this.count++}`);
    try {
      await new Promise<void>((resolve, reject) => {
        // A little slower and with a pause between sentences: easier to follow over a phone line.
        // At the lowest priority: Piper uses every core it can get, and a call's audio is paced by a thread that must
        // never wait behind it (a slow machine broke the line up while a prompt was being made).
        const child = spawn(
          "nice",
          [
            "-n",
            "15",
            this.paths.binary,
            "--model",
            this.paths.model,
            "--output_file",
            `${base}.raw.wav`,
            "--length_scale",
            "1.08",
            "--sentence_silence",
            "0.3",
          ],
          { stdio: ["pipe", "ignore", "pipe"] },
        );
        let stderr = "";
        // A slow machine must not hold a ringing call: past this, the plain voice answers instead.
        const limit = setTimeout(() => child.kill("SIGKILL"), this.paths.timeoutMs ?? PIPER_TIMEOUT_MS);
        child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-500)));
        child.on("error", (error) => {
          clearTimeout(limit);
          reject(error);
        });
        // "exit", not "close": a killed shell script leaves its children holding the pipes open.
        child.on("exit", (code) => {
          clearTimeout(limit);
          if (code === 0) resolve();
          else reject(new Error(`piper exited ${code}: ${stderr.trim()}`));
        });
        child.stdin.on("error", () => undefined);
        // One line is one utterance for Piper.
        child.stdin.end(`${text.replace(/\s+/g, " ").trim()}\n`);
      });
      await run("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        `${base}.raw.wav`,
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-bitexact",
        `${base}.wav`,
      ]);
      fs.rmSync(`${base}.raw.wav`, { force: true });
      const durationMs = wavDurationMs(fs.readFileSync(`${base}.wav`));
      if (durationMs <= 0) throw new Error("piper made no audio");
      logSpeechTime("natural", text, began);
      return { file: `${base}.wav`, durationMs };
    } catch {
      return this.fallback.speak(text);
    }
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.fallback.dispose();
  }
}

/**
 * Remembers what it has said: the same prompt on the next call (or the next time round a menu) is a file that
 * already exists, not a second of silence while the voice is made. Dynamic prompts (a read-back) pass through and
 * the oldest are dropped, with their files, past `limit`.
 */
export class CachedSpeaker implements Speaker {
  private readonly made = new Map<string, { file: string; durationMs: number; seeded?: boolean }>();

  constructor(
    private readonly inner: Speaker,
    private readonly limit = 120,
    private readonly live: {
      /** True while a call is up: nothing slow may be made then. */
      callActive: () => boolean;
      /** A quick voice for a line that is missing mid-call (the plain one); absent: the main voice, logged. */
      plain?: Speaker | null;
    } = { callActive: () => false },
  ) {}

  async speak(text: string): Promise<{ file: string; durationMs: number }> {
    const { file, durationMs } = await this.speakDetailed(text);
    return { file, durationMs };
  }

  /** `speak`, and where it came from: the Mac's seeded clip or one made here (and how long that took; 0 for a hit). */
  async speakDetailed(
    text: string,
  ): Promise<{ file: string; durationMs: number; source: "mac" | "add-on"; makeMs: number }> {
    const hit = this.made.get(text);
    if (hit && fs.existsSync(hit.file)) {
      // Most recently used last, so the dropped one is the stalest.
      this.made.delete(text);
      this.made.set(text, hit);
      return { file: hit.file, durationMs: hit.durationMs, source: hit.seeded ? "mac" : "add-on", makeMs: 0 };
    }
    const began = Date.now();
    const result = padClip(await this.make(text));
    const makeMs = Date.now() - began;
    // The Mac's clip may have arrived while this was being made (it follows a call that is already ringing): keep it.
    const seeded = this.made.get(text);
    if (seeded?.seeded && fs.existsSync(seeded.file)) {
      if (seeded.file !== result.file) fs.rmSync(result.file, { force: true });
      return { file: seeded.file, durationMs: seeded.durationMs, source: "mac", makeMs };
    }
    this.made.set(text, result);
    while (this.made.size > this.limit) {
      const oldest = this.made.keys().next().value as string;
      const gone = this.made.get(oldest);
      this.made.delete(oldest);
      if (gone) fs.rmSync(gone.file, { force: true });
    }
    return { ...result, source: "add-on", makeMs };
  }

  /**
   * Makes a line the cache lacks. Never the slow natural voice while a call is up: a missing line then comes from the
   * plain voice (quick), and is logged, since that means a clip should have been ready.
   */
  private make(text: string): Promise<{ file: string; durationMs: number }> {
    if (!this.live.callActive()) return this.inner.speak(text);
    logger.warn("voice line made during a call: it was not ready in advance", {
      chars: text.length,
      voice: this.live.plain ? "plain" : "main",
    });
    return (this.live.plain ?? this.inner).speak(text);
  }

  /** Files someone else made for these words (the Mac's voice, sent with a call) count as already said. */
  seed(text: string, made: { file: string; durationMs: number }): void {
    // The old file is left: a clip that arrives mid-call may replace a line that is about to play.
    this.made.delete(text);
    this.made.set(text, { ...padClip(made), seeded: true });
  }

  /** Makes each prompt now (one at a time, so a small machine is not swamped); a failure is left for the call to meet. */
  async prewarm(texts: readonly string[], pause?: () => boolean): Promise<void> {
    for (const text of texts) {
      // Making speech uses the cores the call's audio thread needs: wait until the line is free.
      while (pause?.() || this.live.callActive()) await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.made.has(text) && fs.existsSync(this.made.get(text)!.file)) continue;
      await this.speak(text).catch(() => undefined);
    }
  }

  dispose(): void {
    this.inner.dispose();
  }
}
