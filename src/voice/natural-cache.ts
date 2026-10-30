import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Sentence-level cache for the Mac's natural voice. A call script is split into sentences, each sentence is rendered
 * once and kept on disk as an 8 kHz mono 16-bit WAV (the phone line's own rate), and a line is assembled from the
 * pieces. The fixed phrases ("Hello, this is Squeak", "Press star to hear this again") are therefore instant, and only
 * the variable parts (a chat's name, the question) are rendered. No fleet imports: pure, testable without a worker.
 */

/** Bump when the rendering or filtering changes in a way that must not reuse older pieces. */
export const CACHE_VERSION = 1;
/** Disk bound for the cache; the least recently used pieces go first (8 KB of WAV per 0.5 s of speech). */
export const CACHE_MAX_BYTES = 40 * 1024 * 1024;
export const LINE_RATE = 8_000;
/** Silence kept between two sentences of one line: a natural pause, not a gap. */
export const SENTENCE_GAP_MS = 120;
/** Fragments shorter than this join the next sentence ("Sent A." + "Goodbye."), which also keeps pieces reusable. */
const MIN_PIECE_CHARS = 14;
/** A sentence longer than this is cut at commas, so the first words come back sooner. */
const MAX_PIECE_CHARS = 170;

/** Whitespace folded, so "Press 1  to send" and "Press 1 to send" are one piece. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The sentences (or short phrases) of a script, in order; joined with a space they say the same words. */
export function splitSentences(text: string): string[] {
  const clean = normalizeText(text);
  if (!clean) return [];
  const raw = clean.split(/(?<=[.!?…])\s+/).filter((part) => part.length > 0);
  const cut: string[] = [];
  for (const part of raw) {
    if (part.length <= MAX_PIECE_CHARS) {
      cut.push(part);
      continue;
    }
    let current = "";
    for (const piece of part.split(/(?<=[,;:])\s+/)) {
      if (current && current.length + 1 + piece.length > MAX_PIECE_CHARS) {
        cut.push(current);
        current = piece;
      } else current = current ? `${current} ${piece}` : piece;
    }
    if (current) cut.push(current);
  }
  const merged: string[] = [];
  let carry = "";
  for (const part of cut) {
    const next = carry ? `${carry} ${part}` : part;
    if (next.length < MIN_PIECE_CHARS) carry = next;
    else {
      merged.push(next);
      carry = "";
    }
  }
  if (carry) {
    if (merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${carry}`;
    else merged.push(carry);
  }
  return merged;
}

/** A plain 16-bit mono WAV. */
export function wavOfPcm(pcm: Int16Array, rate = LINE_RATE): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) data.writeInt16LE(pcm[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The samples of a 16-bit mono WAV, whatever its rate. */
export function pcmOfWav(wav: Buffer): Int16Array {
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

/** Pieces as one line: lead silence, the pieces with a short natural gap, tail silence. One piece = a padded clip. */
export function assembleLine(
  pieces: readonly Int16Array[],
  leadMs: number,
  tailMs: number,
  gapMs = SENTENCE_GAP_MS,
): Int16Array {
  const lead = Math.round((leadMs / 1000) * LINE_RATE);
  const tail = Math.round((tailMs / 1000) * LINE_RATE);
  const gap = Math.round((gapMs / 1000) * LINE_RATE);
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0) + gap * Math.max(0, pieces.length - 1);
  const out = new Int16Array(lead + length + tail);
  let at = lead;
  pieces.forEach((piece, index) => {
    if (index > 0) at += gap;
    out.set(piece, at);
    at += piece.length;
  });
  return out;
}

/** Running totals for the one-line log. */
export interface LineStats {
  sentences: number;
  hits: number;
  /** Milliseconds each rendered (missed) sentence took, in order. */
  renderMs: number[];
}

export class SentenceCache {
  private readonly memory = new Map<string, Int16Array>();
  private total: number | null = null;
  totalHits = 0;
  totalMisses = 0;

  constructor(
    readonly dir: string,
    /** Identifies the engine: a changed model or filter changes every key. */
    readonly versionTag: string,
    private readonly maxBytes = CACHE_MAX_BYTES,
    private readonly memoryEntries = 64,
  ) {}

  key(voice: string, speed: number, text: string): string {
    return createHash("sha256")
      .update(`${CACHE_VERSION}\n${this.versionTag}\n${voice}\n${speed}\n${normalizeText(text)}`)
      .digest("hex")
      .slice(0, 40);
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.wav`);
  }

  has(key: string): boolean {
    return this.memory.has(key) || fs.existsSync(this.file(key));
  }

  get(key: string): Int16Array | null {
    const held = this.memory.get(key);
    if (held) {
      this.memory.delete(key);
      this.memory.set(key, held);
      this.totalHits += 1;
      return held;
    }
    try {
      const file = this.file(key);
      const pcm = pcmOfWav(fs.readFileSync(file));
      if (pcm.length === 0) throw new Error("empty");
      const now = new Date();
      fs.utimesSync(file, now, now); // recently used
      this.remember(key, pcm);
      this.totalHits += 1;
      return pcm;
    } catch {
      this.totalMisses += 1;
      return null;
    }
  }

  put(key: string, pcm: Int16Array): void {
    if (pcm.length === 0) return;
    this.remember(key, pcm);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = this.file(key);
      const tmp = `${file}.${process.pid}.tmp`;
      const wav = wavOfPcm(pcm);
      fs.writeFileSync(tmp, wav, { mode: 0o600 });
      fs.renameSync(tmp, file);
      if (this.total === null) this.total = this.scan().reduce((sum, entry) => sum + entry.size, 0);
      else this.total += wav.length;
      if (this.total > this.maxBytes) this.evict();
    } catch {
      // A cache that cannot write is just slower.
    }
  }

  private remember(key: string, pcm: Int16Array): void {
    this.memory.set(key, pcm);
    while (this.memory.size > this.memoryEntries) this.memory.delete(this.memory.keys().next().value as string);
  }

  private scan(): Array<{ file: string; size: number; used: number }> {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith(".wav"))
        .flatMap((name) => {
          try {
            const file = path.join(this.dir, name);
            const stat = fs.statSync(file);
            return [{ file, size: stat.size, used: stat.mtimeMs }];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  /** Removes the least recently used pieces until the cache is at 80% of its bound. */
  private evict(): void {
    const entries = this.scan().sort((a, b) => a.used - b.used);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const target = this.maxBytes * 0.8;
    for (const entry of entries) {
      if (total <= target) break;
      try {
        fs.rmSync(entry.file, { force: true });
        total -= entry.size;
      } catch {
        // Skip it.
      }
    }
    this.total = total;
    for (const key of [...this.memory.keys()]) if (!fs.existsSync(this.file(key))) this.memory.delete(key);
  }
}
