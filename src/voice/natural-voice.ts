import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { logger } from "../utils/logger.js";
import { encodeMulaw, MAX_CLIP_BYTES, type Clip } from "./clips.js";
import { inboundPrompts, readBackParts } from "./inbound-flow.js";
import {
  assembleLine,
  LINE_RATE,
  pcmOfWav,
  SentenceCache,
  splitSentences,
  wavOfPcm,
  type LineStats,
} from "./natural-cache.js";
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
/** The voices the apps offer in their picker (the daemon accepts any Kokoro name); the Mac app lists the same. */
export const NATURAL_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "af_heart", label: "Heart (female)" },
  { id: "af_bella", label: "Bella (female)" },
  { id: "af_nicole", label: "Nicole (female)" },
  { id: "bf_emma", label: "Emma (British female)" },
  { id: "am_michael", label: "Michael (male)" },
  { id: "am_adam", label: "Adam (male)" },
  { id: "bm_george", label: "George (British male)" },
];
/** The worker makes about five seconds of speech a second here; a stuck one is killed after this. */
const RENDER_TIMEOUT_MS = 30_000;
/** Most time a call waits for its clips before ringing without the rest. */
export const CLIPS_BUDGET_MS = 25_000;
/** An add-on that cannot take clips after dialling gets them in the request, so the ring waits: keep that short. */
export const OLD_ADDON_CLIPS_BUDGET_MS = 6_000;
export const VOICE_PREVIEW_TEXT = "Hello, this is Squeak. Your agent needs an answer. Which way should we go?";
const SOURCE_RATE = 24_000;
/** Silence around every line clip: media takes a moment to start, and the first syllable was eaten ("egram"). */
export const LEAD_SILENCE_MS = 300;
export const TAIL_SILENCE_MS = 250;

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

/** `urgent`: a ringing call waits for it (normal CPU priority). `background`: made ahead at idle (niced). */
export type RenderPriority = "background" | "urgent";
/** Nice value of the background worker: it gives way to builds, agents and the urgent worker. */
export const BACKGROUND_NICE = 10;

/** One Python worker process, started on first use and kept for the next render; replaced if it dies or hangs. */
class WorkerProc {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  /** Whether a start was ever requested (a death before that is not an unexpected one). */
  starts = 0;

  constructor(
    private readonly paths: NaturalPaths,
    private readonly tmp: string,
    private readonly tag: string,
    private readonly nice: number | null,
    /** Called when the process dies by itself (not by `stop`). */
    private readonly onDied?: () => void,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.starts += 1;
    const child = spawn(this.paths.python, [this.paths.worker, this.paths.model, this.paths.voices], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.nice !== null && child.pid) {
      try {
        os.setPriority(child.pid, this.nice);
      } catch {
        // Normal priority is only slower for others.
      }
    }
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
        const mine = this.child === child;
        this.drop(child);
        if (mine && !this.stopping) this.onDied?.();
      });
    });
    this.ready = ready;
    ready.catch(() => this.drop(child));
    return ready;
  }

  private stopping = false;

  private drop(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    for (const waiting of this.pending.values()) waiting.resolve(false);
    this.pending.clear();
  }

  /** 24 kHz mono PCM of `text`, or null if the worker could not make it. One at a time per worker. */
  render(text: string, voice: string, speed: number): Promise<Int16Array | null> {
    const run = async (): Promise<Int16Array | null> => {
      this.stopping = false;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.start(),
          new Promise<never>((_, reject) => {
            startupTimer = setTimeout(() => {
              this.child?.kill("SIGKILL");
              reject(new Error("the voice worker took too long to start"));
            }, RENDER_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        logger.warn("voice natural speech could not start", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        clearTimeout(startupTimer);
      }
      const child = this.child;
      if (!child?.stdin) return null;
      const id = this.nextId++;
      const out = path.join(this.tmp, `${this.tag}${id}.wav`);
      const done = new Promise<boolean>((resolve) => this.pending.set(id, { resolve, out }));
      const timer = setTimeout(() => {
        logger.warn("voice natural speech timed out; restarting the worker");
        child.kill("SIGKILL");
      }, RENDER_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({ id, text, voice, speed, out })}\n`);
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

  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.stopping = true;
    this.child?.kill(signal);
    this.child = null;
    this.ready = null;
  }
}

export interface NaturalVoiceOptions {
  /** Where rendered sentences are kept (default `<natural dir>/cache`). */
  cacheDir?: string;
  cacheMaxBytes?: number;
  /** Wait before restarting a kept-warm worker that died (doubles per failure, five tries). */
  restartDelayMs?: number;
  /** The background worker is stopped this long after its last render. */
  backgroundIdleMs?: number;
  now?: () => number;
}

/** One sentence of a line, told the moment it is ready. */
export interface SentenceReady {
  index: number;
  total: number;
  /** 8 kHz mono PCM16 of just this sentence (no padding). */
  pcm: Int16Array;
  cached: boolean;
}

export interface LineOptions {
  voice?: string;
  priority?: RenderPriority;
  /** Called in order as each sentence is ready, so a line can start before the rest is made. */
  onSentence?: (sentence: SentenceReady) => void;
}

const SPEED = 1.0;
const WARM_TEXT = "Hello.";

/**
 * The natural voice: a sentence cache over up to two Python workers (urgent at normal priority, background niced).
 * Renders for one worker are serial, so the CPU is never hammered by two at once on the same priority.
 */
export class NaturalVoice {
  private readonly urgent: WorkerProc;
  private readonly background: WorkerProc;
  private readonly cache: SentenceCache;
  private readonly tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-natural-"));
  private readonly inflight = new Map<string, Promise<Int16Array | null>>();
  private keepWarm = false;
  private restartFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundBusy = 0;
  private prewarmChain: Promise<unknown> = Promise.resolve();
  private readonly restartDelayMs: number;
  private readonly backgroundIdleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly paths: NaturalPaths,
    private readonly settings: () => NaturalSettings,
    options: NaturalVoiceOptions = {},
  ) {
    this.restartDelayMs = options.restartDelayMs ?? 2_000;
    this.backgroundIdleMs = options.backgroundIdleMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.urgent = new WorkerProc(paths, this.tmp, "u", null, () => this.urgentDied());
    this.background = new WorkerProc(paths, this.tmp, "b", BACKGROUND_NICE);
    this.cache = new SentenceCache(
      options.cacheDir ?? path.join(paths.dir, "cache"),
      engineTag(paths),
      options.cacheMaxBytes,
    );
  }

  /** Installed and switched on. */
  get usable(): boolean {
    return this.settings().enabled && naturalInstalled(this.paths);
  }

  /** Cache hit rate since this daemon started (0..1; null before any look). */
  get cacheHitRate(): number | null {
    const total = this.cache.totalHits + this.cache.totalMisses;
    return total === 0 ? null : this.cache.totalHits / total;
  }

  /**
   * Starts the worker now and renders a tiny sentence, so the first real call does not pay for loading the model;
   * and keeps it alive (a worker that dies is started again). Call after the daemon starts and after setup.
   */
  async warm(): Promise<boolean> {
    if (!this.usable) return false;
    this.keepWarm = true;
    const pcm = await this.urgent.render(WARM_TEXT, this.settings().voice, SPEED);
    if (pcm) this.restartFailures = 0;
    return pcm !== null;
  }

  private urgentDied(): void {
    if (!this.keepWarm || !this.usable || this.restartTimer) return;
    if (this.restartFailures >= 5) return;
    const delay = this.restartDelayMs * 2 ** this.restartFailures;
    this.restartFailures += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.warm();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** 24 kHz mono PCM of `text` (one piece, no cache), or null if the worker could not make it. */
  render(text: string, voice?: string, priority: RenderPriority = "urgent"): Promise<Int16Array | null> {
    if (voice ? !NATURAL_VOICE.test(voice) || !naturalInstalled(this.paths) : !this.usable)
      return Promise.resolve(null);
    const proc = this.procFor(priority);
    return proc.render(text, voice ?? this.settings().voice, SPEED);
  }

  private procFor(priority: RenderPriority): WorkerProc {
    if (priority === "urgent") return this.urgent;
    this.backgroundBusy += 1;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
    return this.background;
  }

  private backgroundDone(): void {
    this.backgroundBusy = Math.max(0, this.backgroundBusy - 1);
    if (this.backgroundBusy > 0) return;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (this.backgroundBusy === 0) this.background.stop();
    }, this.backgroundIdleMs);
    this.backgroundTimer.unref?.();
  }

  /** One sentence as 8 kHz PCM: from the cache, else rendered (and kept). */
  private async sentence(
    text: string,
    voice: string,
    priority: RenderPriority,
  ): Promise<{ pcm: Int16Array; cached: boolean; ms: number } | null> {
    const key = this.cache.key(voice, SPEED, text);
    const hit = this.cache.get(key);
    if (hit) return { pcm: hit, cached: true, ms: 0 };
    const began = this.now();
    const flight = `${priority}:${key}`;
    let made = this.inflight.get(flight);
    if (!made) {
      made = (async () => {
        try {
          const pcm = await this.render(text, voice, priority);
          if (!pcm || pcm.length === 0) return null;
          const line = downsampleToLine(pcm);
          this.cache.put(key, line);
          return line;
        } finally {
          this.inflight.delete(flight);
          if (priority === "background") this.backgroundDone();
        }
      })();
      this.inflight.set(flight, made);
    }
    const pcm = await made;
    return pcm ? { pcm, cached: false, ms: this.now() - began } : null;
  }

  /**
   * The words as one padded 8 kHz line, made of cached sentences plus whatever is missing, which is rendered in
   * order (all queued at once on the worker) so the first sentence is ready first. Null if any sentence failed.
   */
  async line(text: string, options: LineOptions = {}): Promise<Int16Array | null> {
    const voice = options.voice ?? this.settings().voice;
    const priority = options.priority ?? "urgent";
    const parts = splitSentences(text);
    if (parts.length === 0) return null;
    const began = this.now();
    const renders = parts.map((part) => this.sentence(part, voice, priority));
    const pieces: Int16Array[] = [];
    const stats: LineStats = { sentences: parts.length, hits: 0, renderMs: [] };
    let failed = false;
    for (let index = 0; index < renders.length; index += 1) {
      const made = await renders[index]!;
      if (!made) {
        failed = true;
        continue;
      }
      if (made.cached) stats.hits += 1;
      else stats.renderMs.push(made.ms);
      pieces.push(made.pcm);
      options.onSentence?.({ index, total: parts.length, pcm: made.pcm, cached: made.cached });
    }
    const info = {
      priority,
      sentences: stats.sentences,
      cacheHits: stats.hits,
      renderMs: stats.renderMs,
      totalMs: this.now() - began,
      hitRate: this.cacheHitRate === null ? null : Math.round(this.cacheHitRate * 100) / 100,
    };
    if (stats.renderMs.length > 0 || failed) logger.info("voice natural line", info);
    else logger.debug("voice natural line", info);
    if (failed) return null;
    return assembleLine(pieces, LEAD_SILENCE_MS, TAIL_SILENCE_MS);
  }

  /**
   * Renders (niced, in the background) whatever of these phrases is not cached yet, one at a time; resolves when
   * done. Cheap to call again: cached sentences cost a file look.
   */
  prewarm(texts: readonly string[], voice?: string): Promise<{ rendered: number; cached: number }> {
    const run = async (): Promise<{ rendered: number; cached: number }> => {
      let rendered = 0;
      let cached = 0;
      if (!this.usable) return { rendered, cached };
      const useVoice = voice ?? this.settings().voice;
      const seen = new Set<string>();
      for (const text of texts) {
        for (const part of splitSentences(text)) {
          const key = this.cache.key(useVoice, SPEED, part);
          if (seen.has(key)) continue;
          seen.add(key);
          if (this.cache.has(key)) {
            cached += 1;
            continue;
          }
          if (!this.usable) return { rendered, cached };
          const made = await this.sentence(part, useVoice, "background");
          if (made && !made.cached) rendered += 1;
        }
      }
      logger.debug("voice natural prewarm", { rendered, cached });
      return { rendered, cached };
    };
    const result = this.prewarmChain.then(run, run);
    this.prewarmChain = result.catch(() => undefined);
    return result;
  }

  /** A fixed sample through the same engine and telephone filter, without changing call settings. */
  async preview(voice: string): Promise<Buffer | null> {
    const pcm = await this.render(VOICE_PREVIEW_TEXT, voice);
    return pcm?.length ? wavOfPcm(padLine(downsampleToLine(pcm))) : null;
  }

  /** The words as a telephone clip: 8 kHz G.711 mu-law. Null if they could not be made. */
  async clip(text: string, options: LineOptions = {}): Promise<Clip | null> {
    const line = await this.line(text, options);
    if (!line) return null;
    return { text, mulaw: encodeMulaw(line).toString("base64") };
  }

  /** The words as an 8 kHz WAV file, for a call this Mac places itself. Null if they could not be made. */
  async wav(text: string, options: LineOptions = {}): Promise<{ file: string; durationMs: number } | null> {
    const line = await this.line(text, options);
    if (!line) return null;
    const file = path.join(this.tmp, `s${this.fileCounter++}.wav`);
    fs.writeFileSync(file, wavOfPcm(line), { mode: 0o600 });
    return { file, durationMs: Math.round((line.length / LINE_RATE) * 1000) };
  }

  private fileCounter = 1;

  stop(): void {
    this.keepWarm = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.restartTimer = null;
    this.backgroundTimer = null;
    this.urgent.stop();
    this.background.stop();
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

/** The engine's identity for the cache: a replaced model file changes every key. */
function engineTag(paths: NaturalPaths): string {
  try {
    const stat = fs.statSync(paths.model);
    return `${stat.size}-${Math.round(stat.mtimeMs)}`;
  } catch {
    return "none";
  }
}

/**
 * Every sentence the call flows say whatever the chat: the dialog's PIN lines, the call-in prompts and the greeting.
 * Pre-rendered at idle (`NaturalVoice.prewarm`) so they are instant when a call needs them.
 */
export function fixedPhrases(): string[] {
  const dialog = new CallDialog({ greeting: "Hello, this is Squeak.", question: "", options: [] }, "0000", true);
  return [
    ...new Set([
      "Hello, this is Squeak.",
      "Goodbye.",
      "Press star to hear this again",
      ...dialog.prompts().slice(0, 1),
      "That PIN is not right. Try again, then press hash.",
      "That PIN is not right. Goodbye.",
      ...inboundPrompts(null, true),
      ...inboundPrompts(null, false),
    ]),
  ].filter((text) => text.trim().length > 0);
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

/** Most seconds of speech one rebuild of the call-in prompts renders anew (cached ones cost nothing). */
export const PROMPT_RENDER_SECONDS = 60;

/**
 * The Mac's recordings of call-in prompts, remembered by voice and words so a rebuild renders only what is missing.
 * What a rebuild no longer asks for is forgotten, so the cache cannot grow past the current prompts.
 */
export class PromptClipCache {
  private readonly made = new Map<string, Clip>();

  constructor(
    private readonly natural: Pick<NaturalVoice, "clip" | "usable">,
    private readonly voice: () => string,
    private readonly maxSeconds = PROMPT_RENDER_SECONDS,
  ) {}

  async clips(texts: readonly string[]): Promise<Clip[]> {
    if (!this.natural.usable) return [];
    const voice = this.voice();
    const wanted = new Map<string, string>(texts.map((text) => [`${voice}\n${text}`, text]));
    const out: Clip[] = [];
    let renderedBytes = 0;
    for (const [id, text] of wanted) {
      let clip = this.made.get(id);
      if (!clip && renderedBytes < this.maxSeconds * LINE_RATE) {
        clip = (await this.natural.clip(text)) ?? undefined;
        if (clip) {
          this.made.set(id, clip);
          renderedBytes += Math.floor((clip.mulaw.length * 3) / 4);
        }
      }
      if (clip) out.push(clip);
    }
    for (const id of [...this.made.keys()]) if (!wanted.has(id)) this.made.delete(id);
    return out;
  }
}

/** Silence kept between the two halves of a joined clip. */
export const JOIN_GAP_MS = 120;
/** A read-back whose heard part is longer than this is left to the add-on's voice: it would take too long to make. */
export const READ_BACK_HEAD_MAX_CHARS = 300;

/** Two line clips as one saying `text`: the first's tail pad and the second's lead pad go, a short gap stays. */
export function joinClips(first: Clip, second: Clip, text: string, gapMs = JOIN_GAP_MS): Clip {
  const a = Buffer.from(first.mulaw, "base64");
  const b = Buffer.from(second.mulaw, "base64");
  const cutA = Math.min(a.length, Math.round((TAIL_SILENCE_MS / 1000) * LINE_RATE));
  const cutB = Math.min(b.length, Math.round((LEAD_SILENCE_MS / 1000) * LINE_RATE));
  const gap = Buffer.alloc(Math.round((gapMs / 1000) * LINE_RATE), 0xff); // mu-law zero
  return { text, mulaw: Buffer.concat([a.subarray(0, a.length - cutA), gap, b.subarray(cutB)]).toString("base64") };
}

/**
 * The read-back in the Mac's voice, made fast: the suffix ("Press 1 to send it to ...") is fixed per chat, so it is
 * rendered once per voice and kept; a call renders only what was heard and joins the two into one clip.
 */
export class ReadBackClips {
  private readonly tails = new Map<string, Promise<Clip | null>>();

  constructor(
    private readonly natural: Pick<NaturalVoice, "clip" | "usable">,
    private readonly voice: () => string,
  ) {}

  private tailClip(tail: string): Promise<Clip | null> {
    const id = `${this.voice()}\n${tail}`;
    let made = this.tails.get(id);
    if (!made) {
      made = this.natural.clip(tail).catch(() => null);
      this.tails.set(id, made);
      void made.then((clip) => {
        if (!clip && this.tails.get(id) === made) this.tails.delete(id);
      });
      while (this.tails.size > 60) this.tails.delete(this.tails.keys().next().value as string);
    }
    return made;
  }

  /** Renders the suffix for each of these chats ahead of any call. */
  async prepare(labels: readonly string[], ask = false): Promise<void> {
    if (!this.natural.usable) return;
    for (const label of new Set(labels)) await this.tailClip(readBackParts("", label, ask).tail);
  }

  /** One clip saying exactly `readBackSentence(text, label)`; undefined when it should be left to the add-on. */
  async clip(text: string, label: string, ask = false): Promise<Clip | undefined> {
    if (!this.natural.usable) return undefined;
    const { head, tail } = readBackParts(text, label, ask);
    if (head.length > READ_BACK_HEAD_MAX_CHARS) return undefined;
    const [first, second] = await Promise.all([this.natural.clip(head), this.tailClip(tail)]);
    if (!first || !second) return undefined;
    return joinClips(first, second, `${head} ${tail}`);
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
  /** Told each clip the moment it is made, so a call already ringing can have it. */
  onClip?: (clip: Clip) => void,
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
    onClip?.(clip);
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

/** Line audio with a little silence before and after, so a clip starts and ends cleanly. */
export function padLine(line: Int16Array): Int16Array {
  const lead = Math.round((LEAD_SILENCE_MS / 1000) * LINE_RATE);
  const tail = Math.round((TAIL_SILENCE_MS / 1000) * LINE_RATE);
  const out = new Int16Array(lead + line.length + tail);
  out.set(line, lead);
  return out;
}

/** The samples of a 16-bit mono WAV written by the worker. */
export function readPcm24k(wav: Buffer): Int16Array {
  return pcmOfWav(wav);
}
