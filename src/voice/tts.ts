import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 8 kHz mono 16-bit: what a phone line carries, and what baresip's `aufile` plays without resampling. */
const SAMPLE_RATE = 8000;

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
    return { file: `${base}.wav`, durationMs: wavDurationMs(fs.readFileSync(`${base}.wav`)) };
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
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
    const base = path.join(this.dir, `p${this.count++}`);
    try {
      await new Promise<void>((resolve, reject) => {
        // A little slower and with a pause between sentences: easier to follow over a phone line.
        const child = spawn(
          this.paths.binary,
          [
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
