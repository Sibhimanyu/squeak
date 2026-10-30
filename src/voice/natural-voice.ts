import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { logger } from "../utils/logger.js";
import { encodeMulaw, MAX_CLIP_BYTES, type Clip } from "./clips.js";
import { CallDialog, type CallScript } from "./dialog.js";
import type { Speaker } from "./tts.js";

/**
 * A realistic voice for phone calls, made on this Mac: Kokoro-82M running locally (helpers: a Python venv and the
 * model in `<support>/voice-tts/`, put there by `squeak voice-tts-setup`). The Home Assistant add-on can only run
 * espeak-ng or Piper on a small box, so the Mac renders the call's words and sends them with the request
 * (relay-protocol.ts `audio`); a Mac that places the call itself plays them directly. On any failure the plain
 * voice speaks, so a call is never lost to a speech problem.
 */

export const NATURAL_DIR = "voice-tts";
export const DEFAULT_NATURAL_VOICE = "af_heart";
/** Kokoro voice ids are two letters, an underscore and a name (`af_heart`, `am_michael`, `bf_emma`). */
export const NATURAL_VOICE = /^[a-z]{2}_[a-z]+$/;
/** The worker makes about five seconds of speech a second here; a stuck one is killed after this. */
const RENDER_TIMEOUT_MS = 30_000;
/** Most time a call waits for its clips before ringing without the rest. */
export const CLIPS_BUDGET_MS = 25_000;
const SOURCE_RATE = 24_000;
const LINE_RATE = 8_000;

export interface NaturalPaths {
  dir: string;
  python: string;
  model: string;
  voices: string;
  worker: string;
}

export function naturalPaths(supportDir: string): NaturalPaths {
  const dir = path.join(supportDir, NATURAL_DIR);
  return {
    dir,
    python: path.join(dir, "venv", "bin", "python3"),
    model: path.join(dir, "kokoro.onnx"),
    voices: path.join(dir, "voices.bin"),
    worker: path.join(dir, "worker.py"),
  };
}

/** Whether everything the worker needs is on disk. */
export function naturalInstalled(paths: NaturalPaths): boolean {
  return [paths.python, paths.model, paths.voices, paths.worker].every((file) => fs.existsSync(file));
}

export interface NaturalSettings {
  enabled: boolean;
  voice: string;
}

/** `voice-natural.json`: on by default once installed, and which Kokoro voice. */
export class NaturalSettingsStore {
  private current: NaturalSettings = { enabled: true, voice: DEFAULT_NATURAL_VOICE };

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof raw.enabled === "boolean") this.current.enabled = raw.enabled;
      if (typeof raw.voice === "string" && NATURAL_VOICE.test(raw.voice)) this.current.voice = raw.voice;
    } catch {
      // The defaults stand.
    }
  }

  get settings(): NaturalSettings {
    return { ...this.current };
  }

  /** `{ enabled?, voice? }`, at least one, nothing else. */
  apply(request: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      return { ok: false, reason: "That is not a voice setting." };
    }
    const record = request as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.some((key) => key !== "enabled" && key !== "voice")) {
      return { ok: false, reason: "That is not a voice setting." };
    }
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
      return { ok: false, reason: "Turn the natural voice on or off." };
    }
    if (record.voice !== undefined && !(typeof record.voice === "string" && NATURAL_VOICE.test(record.voice))) {
      return { ok: false, reason: "That is not a Kokoro voice name." };
    }
    const next = {
      enabled: (record.enabled as boolean | undefined) ?? this.current.enabled,
      voice: (record.voice as string | undefined) ?? this.current.voice,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch {
      return { ok: false, reason: "This Mac could not save the voice setting." };
    }
    this.current = next;
    return { ok: true };
  }
}

interface Pending {
  resolve: (ok: boolean) => void;
  out: string;
}

/** The worker process, started on first use and kept for the next call; replaced if it dies or hangs. */
export class NaturalVoice {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-natural-"));

  constructor(
    private readonly paths: NaturalPaths,
    private readonly settings: () => NaturalSettings,
  ) {}

  /** Installed and switched on. */
  get usable(): boolean {
    return this.settings().enabled && naturalInstalled(this.paths);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = spawn(this.paths.python, [this.paths.worker, this.paths.model, this.paths.voices], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-500)));
    const ready = new Promise<void>((resolve, reject) => {
      const lines = readline.createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let message: { ready?: boolean; id?: number; ok?: boolean; error?: string } | null;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!message) return;
        if (message.ready) return resolve();
        const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id!);
        if (!message.ok) logger.warn("voice natural speech failed", { error: message.error });
        waiting.resolve(message.ok === true);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        reject(new Error(`the voice worker exited ${code}: ${stderr.trim()}`));
        this.drop(child);
      });
    });
    this.ready = ready;
    ready.catch(() => this.drop(child));
    return ready;
  }

  private drop(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    for (const waiting of this.pending.values()) waiting.resolve(false);
    this.pending.clear();
  }

  /** 24 kHz mono PCM of `text`, or null if the worker could not make it. One at a time. */
  render(text: string): Promise<Int16Array | null> {
    const run = async (): Promise<Int16Array | null> => {
      if (!this.usable) return null;
      try {
        await this.start();
      } catch (error) {
        logger.warn("voice natural speech could not start", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      const child = this.child;
      if (!child?.stdin) return null;
      const id = this.nextId++;
      const out = path.join(this.tmp, `r${id}.wav`);
      const done = new Promise<boolean>((resolve) => this.pending.set(id, { resolve, out }));
      const timer = setTimeout(() => {
        logger.warn("voice natural speech timed out; restarting the worker");
        child.kill("SIGKILL");
      }, RENDER_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({ id, text, voice: this.settings().voice, speed: 1.0, out })}\n`);
      const ok = await done;
      clearTimeout(timer);
      try {
        return ok ? readPcm24k(fs.readFileSync(out)) : null;
      } catch {
        return null;
      } finally {
        fs.rmSync(out, { force: true });
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** The words as a telephone clip: 8 kHz G.711 mu-law. Null if they could not be made. */
  async clip(text: string): Promise<Clip | null> {
    const pcm = await this.render(text);
    if (!pcm) return null;
    return { text, mulaw: encodeMulaw(downsampleToLine(pcm)).toString("base64") };
  }

  /** The words as an 8 kHz WAV file, for a call this Mac places itself. Null if they could not be made. */
  async wav(text: string): Promise<{ file: string; durationMs: number } | null> {
    const pcm = await this.render(text);
    if (!pcm) return null;
    const line = downsampleToLine(pcm);
    const file = path.join(this.tmp, `s${this.nextId++}.wav`);
    fs.writeFileSync(file, wavOfLine(line), { mode: 0o600 });
    return { file, durationMs: Math.round((line.length / LINE_RATE) * 1000) };
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.ready = null;
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

/** Plays the natural voice where it works, the plain one where it does not. */
export class NaturalSpeaker implements Speaker {
  constructor(
    private readonly natural: NaturalVoice,
    private readonly fallback: Speaker,
  ) {}

  async speak(text: string): Promise<{ file: string; durationMs: number }> {
    if (this.natural.usable) {
      const made = await this.natural.wav(text);
      if (made) return made;
    }
    return this.fallback.speak(text);
  }

  dispose(): void {
    this.natural.stop();
    this.fallback.dispose();
  }
}

/** The words a dialog may ask for, most important first, for the Mac to record. */
export function callPrompts(script: CallScript, pin: "ask" | "none" | "both"): string[] {
  const withPin = new CallDialog(script, "0000", true).prompts();
  const withoutPin = new CallDialog(script, null, true).prompts();
  // withPin: [greeting + ask, question, wrong again, wrong goodbye, sent...]; withoutPin: [greeting + question, sent...]
  const [ask, question, again, goodbye, ...sent] = withPin;
  const combined = withoutPin[0]!;
  // Nothing to press: the call only tells, in one piece.
  if (script.options.length === 0) return [combined];
  const order =
    pin === "ask"
      ? [ask, question, again, goodbye, ...sent]
      : pin === "none"
        ? [combined, question, ...sent]
        : [ask, question, combined, again, goodbye, ...sent];
  return [...new Set(order.filter((text): text is string => typeof text === "string" && text.length > 0))];
}

/**
 * The clips for one call, made within `budgetMs` and the request's size cap; whatever is not ready (or does not fit)
 * is left for the add-on's own voice. Undefined when none could be made.
 */
export async function renderCallClips(
  natural: Pick<NaturalVoice, "clip" | "usable">,
  script: CallScript,
  pin: "ask" | "none" | "both",
  budgetMs = CLIPS_BUDGET_MS,
  now: () => number = Date.now,
): Promise<Clip[] | undefined> {
  if (!natural.usable) return undefined;
  const deadline = now() + budgetMs;
  const clips: Clip[] = [];
  let bytes = 0;
  for (const text of callPrompts(script, pin)) {
    if (now() >= deadline) break;
    const clip = await Promise.race([
      natural.clip(text),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - now())).unref()),
    ]);
    if (!clip) continue;
    const size = Math.floor((clip.mulaw.length * 3) / 4);
    if (bytes + size > MAX_CLIP_BYTES) continue;
    bytes += size;
    clips.push(clip);
  }
  return clips.length > 0 ? clips : undefined;
}

/** A Kaiser-free, plain Hamming-windowed sinc low-pass at 3.6 kHz for the 3:1 step from 24 kHz to the line's 8 kHz. */
const TAPS = (() => {
  const length = 97;
  const cutoff = 3600 / SOURCE_RATE;
  const half = (length - 1) / 2;
  const taps = new Float64Array(length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const x = i - half;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    taps[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1)));
    sum += taps[i]!;
  }
  for (let i = 0; i < length; i += 1) taps[i]! /= sum;
  return taps;
})();

/** 24 kHz to the phone line's 8 kHz: low-pass first (nothing above the line's band folds back), then every third sample. */
export function downsampleToLine(pcm: Int16Array): Int16Array {
  const step = SOURCE_RATE / LINE_RATE;
  const half = (TAPS.length - 1) / 2;
  const out = new Int16Array(Math.floor(pcm.length / step));
  for (let n = 0; n < out.length; n += 1) {
    const centre = n * step;
    let acc = 0;
    for (let k = 0; k < TAPS.length; k += 1) {
      const at = centre + k - half;
      if (at >= 0 && at < pcm.length) acc += pcm[at]! * TAPS[k]!;
    }
    out[n] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

/** The samples of a 16-bit mono WAV written by the worker. */
export function readPcm24k(wav: Buffer): Int16Array {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "data") {
      const bytes = Math.min(size, wav.length - at - 8) & ~1;
      const out = new Int16Array(bytes / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = wav.readInt16LE(at + 8 + i * 2);
      return out;
    }
    at += 8 + size + (size % 2);
  }
  return new Int16Array(0);
}

function wavOfLine(pcm: Int16Array): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) data.writeInt16LE(pcm[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(LINE_RATE, 24);
  header.writeUInt32LE(LINE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
