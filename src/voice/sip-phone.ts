import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import {
  accountsFile,
  connectWithRetry,
  delay,
  encodeNetstring,
  freePort,
  NetstringReader,
  parseEvent,
  type LineConfig,
} from "./baresip-line.js";
import type { DialOutcome, IncomingCall, Phone, PhoneCall, RecordEnd } from "./phone.js";
import { CachedSpeaker, wavDurationMs, type Speaker } from "./tts.js";
import { mulawToWav, type Clip } from "./clips.js";
import { ClipStore } from "./clip-store.js";
import { qualityOf, type CallQuality } from "./line-quality.js";

/**
 * The Home Assistant gateway's phone: one `baresip`, registered with the PBX for as long as the gateway runs, so
 * it can ring you and be rung. Same audio arrangement as `baresip-line.ts` (files only: a WAV is played into the
 * call with `ausrc`, and what the other side says is written with `auplay`), proven against a second baresip
 * on one Mac: answering an incoming call, switching the player mid-call to record, valid headers after.
 */

const READY_WAIT_MS = 20_000;
const RING_TIMEOUT_MS = 40_000;
const ANSWER_WAIT_MS = 15_000;
const SETTLE_MS = 150;
const FINALIZE_MS = 400;
const SAMPLE_RATE = 8000;
const BEEP_MS = 300;
/** How long after a clip's end the line goes back to silence (it plays its own last frames out first). */
const IDLE_AFTER_MS = 100;
/** The silence the line rests on between clips: long enough to outlast any wait for a key. */
export const SILENCE_SECONDS = 180;

/** The user part of a SIP URI, however the PBX dresses it: `sip:35210@host`, `"Name" <sip:35210@host;x>`. */
export function userOf(uri: string): string {
  return /sip:([^@;>\s]+)@/.exec(uri)?.[1] ?? "";
}

/**
 * The lines of baresip's `callstat` reply that say how the line is doing (packets, loss, jitter, errors), squeezed
 * to one short line for the log. The layout differs between baresip versions, so this keeps what matches rather than
 * parsing numbers; null when the reply is not a stats block.
 */
export function summarizeCallStats(data: string): string | null {
  const lines = data
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => /packets|lost|jitter|errors|bitrate|rtt/i.test(line));
  return lines.length ? lines.join(" | ").slice(0, 400) : null;
}

/** How often a live call is asked for its stats; the last answer is logged when the call ends. */
const STATS_EVERY_MS = 8_000;

/** End-of-speech rules for a recording: how long a quiet spell after speech ends it, and how long to wait for any. */
export const END_SILENCE_MS = 2_500;
export const NO_SPEECH_MS = 8_000;
const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const MIN_SPEECH_RMS = 300;
/** Consecutive loud frames that count as speech (100 ms), so a click or a pop is not a person. */
const SPEECH_FRAMES = 5;
/** How often the growing recording is looked at. */
const WATCH_EVERY_MS = 100;

/**
 * Energy-based end-of-speech detection on 16-bit mono PCM, fed as the recording grows. Times are wall-clock (`now`):
 * a PBX that stops sending packets in silence leaves the file still, so audio time would stand still with it. The
 * speech threshold follows the line's noise floor (a hissy line is not speech), never below MIN_SPEECH_RMS.
 */
export class SpeechWatcher {
  private floor = Number.POSITIVE_INFINITY;
  private run = 0;
  private carry = Buffer.alloc(0);
  /** When speech was first confirmed, and when it was last loud; null before. */
  speechAt: number | null = null;
  private lastLoudAt = 0;

  constructor(private readonly startedAt: number) {}

  feed(pcm: Buffer, now: number): void {
    const data = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const frameBytes = FRAME_SAMPLES * 2;
    let at = 0;
    for (; at + frameBytes <= data.length; at += frameBytes) {
      let sum = 0;
      for (let i = at; i < at + frameBytes; i += 2) {
        const sample = data.readInt16LE(i);
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / FRAME_SAMPLES);
      const loud = rms > Math.max(MIN_SPEECH_RMS, Number.isFinite(this.floor) ? this.floor * 3 : 0);
      if (!loud) this.floor = Math.min(this.floor, rms === 0 ? this.floor : rms);
      if (loud) {
        this.run += 1;
        if (this.speechAt !== null) this.lastLoudAt = now;
        else if (this.run >= SPEECH_FRAMES) {
          this.speechAt = now;
          this.lastLoudAt = now;
        }
      } else this.run = 0;
    }
    this.carry = Buffer.from(data.subarray(at));
  }

  /** Whether the recording should stop now, and why: speech then quiet, or never any speech. */
  verdict(now: number, noSpeechAfterMs = NO_SPEECH_MS): "silence" | "no-speech" | null {
    if (this.speechAt !== null) return now - this.lastLoudAt >= END_SILENCE_MS ? "silence" : null;
    return now - this.startedAt >= noSpeechAfterMs ? "no-speech" : null;
  }
}

/** A 16-bit mono 8 kHz PCM WAV of `samples`. */
export function wavOf(samples: Int16Array): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
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
  return Buffer.concat([head, data]);
}

function tone(frequency: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < out.length; i++) {
    const fade = Math.min(1, i / 80, (out.length - i) / 80);
    out[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 9000 * fade);
  }
  return out;
}

export function persistentConfigFile(
  config: LineConfig,
  port: number,
  silence: string,
  discard: string,
  listen?: string,
): string {
  return (
    [
      "call_max_calls 1",
      ...(listen ? [`sip_listen ${listen}`] : []),
      `audio_source aufile,${silence}`,
      `audio_player aufile,${discard}`,
      `audio_alert aufile,${discard}.alert`,
      ...(config.modulePath ? [`module_path ${config.modulePath}`] : []),
      "module g711.so",
      "module aufile.so",
      "module account.so",
      "module menu.so",
      "module ctrl_tcp.so",
      `ctrl_tcp_listen 127.0.0.1:${port}`,
    ].join("\n") + "\n"
  );
}

/** The bytes a recording gained since `from`, and where the next look starts. Nothing yet (or no file yet) is empty. */
function readNewAudio(file: string, from: number): { data: Buffer; next: number } {
  try {
    const size = fs.statSync(file).size;
    if (size <= from) return { data: Buffer.alloc(0), next: from };
    const fd = fs.openSync(file, "r");
    try {
      const data = Buffer.alloc(size - from);
      const got = fs.readSync(fd, data, 0, data.length, from);
      return { data: data.subarray(0, got), next: from + got };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { data: Buffer.alloc(0), next: from };
  }
}

export interface CallContext {
  send(command: string, params?: string): void;
  speaker: CachedSpeaker;
  onSpoke?: SipPhoneOptions["onSpoke"];
  dir: string;
  silence: string;
  discard: string;
  beepFile: string;
}

export class LiveCall implements PhoneCall {
  open = true;
  readonly closed: Promise<void>;
  private markClosed!: () => void;
  private readonly keys: string[] = [];
  private waiter: ((key: string | null) => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private recordings = 0;
  private recording = false;
  trace: ((line: string) => void) | null = null;
  redactKeys = false;

  constructor(
    readonly peer: string,
    private readonly ctx: CallContext,
  ) {
    this.closed = new Promise<void>((resolve) => (this.markClosed = resolve));
  }

  pushKey(key: string): void {
    if (!this.open) return;
    // Every digit is written down with where it landed, so a hash that never arrived is visible next time.
    const phase = this.recording ? "recording" : this.waiter ? "menu" : "prompt";
    const shown = this.redactKeys && /^\d$/.test(key) ? "digit" : key;
    try {
      this.trace?.(`dtmf: ${shown} (${phase})`);
    } catch {
      // A log line never matters more than the call.
    }
    if (this.waiter) {
      const waiting = this.waiter;
      this.waiter = null;
      waiting(key);
      return;
    }
    this.keys.push(key);
    for (const listener of [...this.listeners]) listener();
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.waiter?.(null);
    this.waiter = null;
    for (const listener of [...this.listeners]) listener();
    this.markClosed();
  }

  /** Resolves on whichever comes first: the time, a key, or the end of the call. */
  private pause(ms: number, until: { key?: boolean } = {}): Promise<"time" | "key" | "closed"> {
    return new Promise((resolve) => {
      const finish = (why: "time" | "key" | "closed"): void => {
        clearTimeout(timer);
        this.listeners.delete(onChange);
        resolve(why);
      };
      const onChange = (): void => {
        if (!this.open) finish("closed");
        else if (until.key && this.keys.length > 0) finish("key");
      };
      const timer = setTimeout(() => finish("time"), ms);
      this.listeners.add(onChange);
      onChange();
    });
  }

  async say(text: string): Promise<void> {
    if (!this.open || this.keys.length > 0) return;
    const { file, durationMs, source, makeMs } = await this.ctx.speaker.speakDetailed(text);
    if (!this.open || this.keys.length > 0) return;
    this.play(file, durationMs);
    this.ctx.onSpoke?.({ text, source, makeMs, playMs: durationMs });
    const why = await this.pause(durationMs + 250, { key: true });
    // Stop talking over someone who has already pressed their key.
    if (why === "key") this.idle();
  }

  private idleTimer: NodeJS.Timeout | null = null;

  /**
   * Plays a file into the call. A file source stops sending RTP at its end, and the old one second of silence did
   * too, so a long wait or a recording left the far side's jitter buffer starved: the line is put back on the (long)
   * silence file just after each clip would have ended, so packets never stop.
   */
  private play(file: string, durationMs: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.ctx.send("ausrc", `aufile,${file}`);
    this.idleTimer = setTimeout(() => this.idle(), durationMs + IDLE_AFTER_MS);
    this.idleTimer.unref();
  }

  private idle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.open) this.ctx.send("ausrc", `aufile,${this.ctx.silence}`);
  }

  async key(timeoutMs: number): Promise<string | null> {
    const queued = this.keys.shift();
    if (queued !== undefined) return queued;
    if (!this.open) return null;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (key) => {
        clearTimeout(timer);
        resolve(key);
      };
    });
  }

  async beep(): Promise<void> {
    if (!this.open) return;
    this.play(this.ctx.beepFile, BEEP_MS);
    await this.pause(450);
  }

  async record(options: {
    maxMs: number;
    beep?: boolean;
    endOnSilence?: boolean;
  }): Promise<{ file: string; durationMs: number; ended: RecordEnd } | null> {
    if (!this.open) return null;
    const file = path.join(this.ctx.dir, `memo-${this.recordings++}.wav`);
    this.keys.length = 0;
    this.recording = true;
    const began = Date.now();
    this.trace?.("step: Recording started");
    let ended: RecordEnd | "closed";
    try {
      this.ctx.send("auplay", `aufile,${file}`);
      // The beep plays while the recording is already running: starting after it lost the first syllable of what
      // people said right on the beep ("Telegram" came out "egram").
      if (options.beep) {
        this.play(this.ctx.beepFile, BEEP_MS);
        await this.pause(150);
      }
      const watcher = options.endOnSilence ? new SpeechWatcher(began + BEEP_MS) : null;
      let readAt = 44; // the WAV header is written first; what follows is the call's audio
      const deadline = began + options.maxMs;
      let announced = false;
      for (;;) {
        const why = await this.pause(Math.min(WATCH_EVERY_MS, Math.max(0, deadline - Date.now())), { key: true });
        if (why === "closed") {
          ended = "closed";
          break;
        }
        if (why === "key") {
          // Only `#` ends it; any other key is not part of the message.
          if (this.keys.shift() === "#") {
            ended = "key";
            break;
          }
        }
        if (Date.now() >= deadline) {
          ended = "limit";
          break;
        }
        if (!watcher) continue;
        const grown = readNewAudio(file, readAt);
        readAt = grown.next;
        if (grown.data.length) watcher.feed(grown.data, Date.now());
        if (!announced && watcher.speechAt !== null) {
          announced = true;
          this.trace?.(`step: Speech detected ${((watcher.speechAt - began) / 1000).toFixed(1)} s in`);
        }
        const verdict = watcher.verdict(Date.now());
        if (verdict) {
          ended = verdict;
          break;
        }
      }
    } finally {
      this.recording = false;
    }
    if (ended === "closed") return null;
    this.trace?.(
      `step: Recording ended because: ${{ key: "hash", silence: "silence", limit: "cap", "no-speech": "no speech" }[ended]}`,
    );
    // Moving the player to another file is what finishes this one's header.
    this.ctx.send("auplay", `aufile,${this.ctx.discard}`);
    await delay(FINALIZE_MS);
    const durationMs = wavDurationMs(fs.readFileSync(file));
    return { file, durationMs, ended };
  }

  async hangup(): Promise<void> {
    if (!this.open) return;
    this.ctx.send("hangup");
    await Promise.race([this.closed, delay(2000)]);
    // The PBX or the far phone may not have dropped it: say it once more rather than leave the line open.
    if (this.open) {
      this.ctx.send("hangup");
      await Promise.race([this.closed, delay(2000)]);
    }
  }
}

export interface SipPhoneOptions {
  line: LineConfig;
  /** Wrapped in a cache here, so anything prewarmed (or said before) costs nothing at pick-up. */
  speaker: Speaker;
  /** `ip:port` to listen on instead of a random port: for a test where the caller has no PBX to find us. */
  listen?: string;
  /** A quick voice for a line that is missing mid-call (the plain one), so the natural voice never runs during a call. */
  inlineSpeaker?: Speaker | null;
  /** Where the Mac's recordings are kept between runs (`/data/clips` in the add-on); absent: they live in memory only. */
  clipDir?: string;
  /** Told each call's line-quality summary when the call ends (the same text the log line carries). */
  onQuality?: (stats: string, quality: CallQuality | null) => void;
  /** Told each line the call speaks: where its audio came from, how long it took to make here, and how long it plays. */
  onSpoke?: (info: { text: string; source: "mac" | "add-on"; makeMs: number; playMs: number }) => void;
}

export class SipPhone implements Phone {
  private readonly dir: string;
  private readonly files: { silence: string; discard: string; beep: string };
  private child: ChildProcess | null = null;
  private socket: { write(data: Buffer): unknown } | null = null;
  private stopped = true;
  private registered = false;
  private registerError: string | null = null;
  private registrationListener: (() => void) | null = null;
  private readyWaiters: Array<() => void> = [];
  private incomingHandler: ((incoming: IncomingCall) => void) | null = null;
  private current: LiveCall | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private lastStats: string | null = null;
  private statsNoted = false;
  private lastQuality: CallQuality | null = null;
  private inCall = false;
  /** A call that is ringing or being answered: the next CALL_ESTABLISHED is its. */
  private awaiting: { peer: string; settle: (call: LiveCall | null) => void } | null = null;

  private readonly speaker: CachedSpeaker;
  private readonly clipStore: ClipStore | null;
  private warming: Promise<void> = Promise.resolve();

  constructor(private readonly options: SipPhoneOptions) {
    this.speaker = new CachedSpeaker(options.speaker, 120, {
      callActive: () => this.current?.open === true,
      plain: options.inlineSpeaker ?? null,
    });
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-phone-"));
    // What the Mac recorded before the last restart is ready before the first call, not after Firebase catches up.
    this.clipStore = options.clipDir ? new ClipStore(options.clipDir) : null;
    if (this.clipStore) this.seed(this.clipStore.load(), false);
    this.files = {
      silence: path.join(this.dir, "silence.wav"),
      discard: path.join(this.dir, "discard.wav"),
      beep: path.join(this.dir, "beep.wav"),
    };
    fs.writeFileSync(this.files.silence, wavOf(new Int16Array(SAMPLE_RATE * SILENCE_SECONDS)));
    fs.writeFileSync(this.files.beep, wavOf(tone(880, 0.3)));
  }

  private seeded = 0;

  /**
   * The Mac's own recordings of this call's words: written as WAVs and entered in the speech cache, so the dialog
   * plays them when it asks for exactly these words. Anything without a clip is still made here.
   */
  seed(clips: readonly Clip[], keep = true): void {
    if (keep) this.clipStore?.save(clips);
    for (const clip of clips) {
      const mulaw = Buffer.from(clip.mulaw, "base64");
      const file = path.join(this.dir, `mac-${this.seeded++}.wav`);
      fs.writeFileSync(file, mulawToWav(mulaw), { mode: 0o600 });
      this.speaker.seed(clip.text, { file, durationMs: Math.round((mulaw.length / SAMPLE_RATE) * 1000) });
    }
  }

  /** Queued behind any earlier warm-up, one prompt at a time. */
  prewarm(texts: readonly string[]): void {
    this.warming = this.warming
      .then(() => this.speaker.prewarm(texts, () => this.current?.open === true))
      .catch(() => undefined);
  }

  /** Whether the PBX has accepted the registration, and why not when it has not (a fixed-length reason from baresip). */
  registration(): { registered: boolean; error?: string } {
    return this.registered
      ? { registered: true }
      : { registered: false, ...(this.registerError ? { error: this.registerError } : {}) };
  }

  /** Called when registration comes or goes, so the gateway can report it at once. */
  onRegistrationChange(listener: () => void): void {
    this.registrationListener = listener;
  }

  onIncoming(handler: (incoming: IncomingCall) => void): void {
    this.incomingHandler = handler;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.supervise();
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill("SIGTERM");
    const child = this.child;
    setTimeout(() => child?.kill("SIGKILL"), 3000).unref();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Keeps one baresip alive: restarts it, with a growing pause, whenever it goes. */
  private async supervise(): Promise<void> {
    let backoff = 2000;
    while (!this.stopped) {
      const registeredBefore = Date.now();
      try {
        await this.session();
      } catch (error) {
        logger.warn("voice phone session failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (this.stopped) break;
      // A session that lived a while was healthy: start the pause over.
      if (Date.now() - registeredBefore > 60_000) backoff = 2000;
      await delay(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private async session(): Promise<void> {
    const runDir = path.join(this.options.line.dir, "phone");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const port = await freePort();
    fs.writeFileSync(path.join(runDir, "accounts"), accountsFile(this.options.line), { mode: 0o600 });
    fs.writeFileSync(
      path.join(runDir, "config"),
      persistentConfigFile(this.options.line, port, this.files.silence, this.files.discard, this.options.listen),
      { mode: 0o600 },
    );
    const child = spawn(this.options.line.baresipPath, ["-f", runDir, "-c"], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-1500);
    };
    child.stderr?.on("data", keep);
    child.stdout?.on("data", keep);
    this.child = child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const socket = await connectWithRetry(port, child);
      this.socket = socket;
      const reader = new NetstringReader();
      socket.on("data", (chunk: Buffer) => {
        for (const payload of reader.push(chunk)) {
          const event = parseEvent(payload);
          if (event) this.onEvent(event.type, event.param);
          else this.onReply(payload);
        }
      });
      socket.on("error", () => child.kill("SIGTERM"));
      await exited;
    } finally {
      child.kill("SIGKILL");
      this.child = null;
      this.socket = null;
      if (this.registered) {
        this.registered = false;
        this.registrationListener?.();
      }
      this.current?.end();
      this.current = null;
      this.awaiting?.settle(null);
      this.awaiting = null;
      const last = tail.trim().split("\n").slice(-2).join(" ");
      if (!this.stopped) logger.warn("voice phone stopped", { last });
    }
  }

  private send = (command: string, params?: string): void => {
    this.socket?.write(encodeNetstring({ command, ...(params ? { params } : {}) }));
  };

  private context(): CallContext {
    return {
      send: this.send,
      speaker: this.speaker,
      onSpoke: this.options.onSpoke,
      dir: this.dir,
      silence: this.files.silence,
      discard: this.files.discard,
      beepFile: this.files.beep,
    };
  }

  private onEvent(type: string, param: string): void {
    switch (type) {
      case "REGISTER_OK": {
        const changed = !this.registered;
        if (changed) logger.info("voice phone registered");
        this.registered = true;
        this.registerError = null;
        if (changed) this.registrationListener?.();
        for (const wake of this.readyWaiters.splice(0)) wake();
        return;
      }
      case "REGISTER_FAIL":
        this.registered = false;
        this.registerError = (param || "no reason").slice(0, 200);
        this.registrationListener?.();
        logger.warn("voice phone could not register", { reason: param || "no reason" });
        return;
      case "CALL_INCOMING":
        this.onIncoming_(param);
        return;
      case "CALL_ESTABLISHED": {
        const waiting = this.awaiting;
        if (!waiting) return;
        this.awaiting = null;
        const call = new LiveCall(waiting.peer, this.context());
        this.current = call;
        this.inCall = true;
        this.startStats();
        waiting.settle(call);
        return;
      }
      case "CALL_DTMF_START":
        if (param) this.current?.pushKey(param.trim().slice(0, 1));
        return;
      case "CALL_CLOSED":
        this.stopStats(this.inCall);
        this.inCall = false;
        this.current?.end();
        this.current = null;
        this.awaiting?.settle(null);
        this.awaiting = null;
        return;
      default:
    }
  }

  /** Asks the live call for its line stats now and then, so a breaking call leaves a number in the log. */
  private startStats(): void {
    this.stopStats();
    this.lastStats = null;
    this.statsTimer = setInterval(() => this.send("callstat"), STATS_EVERY_MS);
    this.statsTimer.unref();
    this.statsNoted = false;
    const first = setTimeout(() => this.send("callstat"), 3_000);
    first.unref();
  }

  /** Stops asking; at a call's end (`report`) the last answer is logged, or "no data" so its absence says something. */
  private stopStats(report = false): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (report) {
      logger.info("voice call line quality", { stats: this.lastStats ?? "no data" });
      this.options.onQuality?.(this.lastStats ?? "no data", this.lastQuality);
    }
    this.lastStats = null;
    this.lastQuality = null;
  }

  /** A command's answer (events are handled elsewhere): only the stats block is kept. */
  private onReply(payload: string): void {
    try {
      const value = JSON.parse(payload) as { response?: unknown; data?: unknown };
      if (value.response === true && typeof value.data === "string") {
        const summary = summarizeCallStats(value.data);
        if (summary) {
          this.lastStats = summary;
          this.lastQuality = qualityOf(value.data) ?? this.lastQuality;
        } else if (this.inCall && !this.statsNoted && value.data.trim()) {
          // Once per call: what baresip's reply looked like when it was not a stats block, so "no data" can be diagnosed.
          this.statsNoted = true;
          logger.info("voice call stats reply not recognised", { head: value.data.replace(/\s+/g, " ").slice(0, 200) });
        }
      }
    } catch {
      // Not JSON: nothing to keep.
    }
  }

  private onIncoming_(uri: string): void {
    const handler = this.incomingHandler;
    if (!handler || this.current || this.awaiting) {
      this.send("hangup");
      return;
    }
    const peer = userOf(uri);
    handler({
      peer,
      uri,
      answer: () =>
        new Promise<PhoneCall>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.awaiting = null;
            reject(new Error("the call was not answered in time"));
          }, ANSWER_WAIT_MS);
          this.awaiting = {
            peer,
            settle: (call) => {
              clearTimeout(timer);
              if (!call) return reject(new Error("the caller hung up"));
              void delay(SETTLE_MS).then(() => resolve(call));
            },
          };
          this.send("accept");
        }),
      reject: async () => {
        this.send("hangup");
      },
    });
  }

  private async ready(): Promise<boolean> {
    if (this.registered) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== wake);
        resolve(false);
      }, READY_WAIT_MS);
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.readyWaiters.push(wake);
    });
  }

  async dial(callee: string): Promise<DialOutcome> {
    if (!/^[\w.+*#-]+$/.test(callee))
      return { status: "failed", reason: "The number to call is not one Squeak will dial." };
    if (this.current || this.awaiting) return { status: "failed", reason: "The line is busy with another call." };
    if (!(await this.ready())) return { status: "failed", reason: "The PBX has not accepted Squeak's extension yet." };
    return new Promise<DialOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.send("hangup");
      }, RING_TIMEOUT_MS);
      this.awaiting = {
        peer: callee,
        settle: (call) => {
          clearTimeout(timer);
          if (!call) return resolve({ status: "unanswered" });
          void delay(SETTLE_MS).then(() => resolve({ status: "connected", call }));
        },
      };
      this.send("dial", `sip:${callee}@${this.options.line.host}`);
    });
  }
}
