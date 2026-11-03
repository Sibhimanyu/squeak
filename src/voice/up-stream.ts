import fs from "node:fs";

import type { CloudStore } from "../cloud/store.js";
import { MAX_UP_PARTS, sealUpPart, upAudioId, upPartHash, upPath } from "./memo-protocol.js";

/**
 * A recording going up while the person still speaks. The add-on hears the call's audio as the WAV grows; every few
 * seconds of it becomes an independent Opus clip written as its own `upaudio-` document, in order, one at a time and
 * never in the way of the recording loop. When the recording ends only the last clip is left to send, then the up
 * message names every clip by its hash (`audioParts`). Any clip that fails to go makes `finish` return null, and the
 * caller sends the whole recording as `audio`, as it always has: a message is never lost to this.
 */

const SAMPLE_RATE = 8000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** How much new audio makes a piece. */
export const PIECE_MS = 3000;
const PIECE_BYTES = (PIECE_MS / 1000) * BYTES_PER_SECOND;

export type UpStreamStore = Pick<CloudStore, "set" | "delete">;

export interface UpStreamOptions {
  store: UpStreamStore;
  channel: string;
  key: string;
  /** 8 kHz mono 16-bit PCM to a small Ogg Opus clip that stands alone. */
  encode: (pcm: Buffer) => Promise<Buffer>;
  now?: () => number;
  trace?: (line: string) => void;
}

/** The audio of a finished WAV: what follows its "data" chunk header (the whole rest if the size field is not trusted). */
export function pcmOfWav(wav: Buffer): Buffer {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "data") {
      const start = at + 8;
      const end = size > 0 && start + size <= wav.length ? start + size : wav.length;
      return wav.subarray(start, end);
    }
    at += 8 + size + (size % 2);
  }
  return wav.length > 44 ? wav.subarray(44) : Buffer.alloc(0);
}

export function readPcmOfWav(file: string): Buffer {
  return pcmOfWav(fs.readFileSync(file));
}

export class UpStream {
  private pending: Buffer = Buffer.alloc(0);
  /** Bytes of audio already handed to a piece, so the last piece is exactly what followed them. */
  private cut = 0;
  private enqueued = 0;
  private readonly hashes: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private failed = false;
  private done = false;

  constructor(
    private readonly options: UpStreamOptions,
    readonly streamId: string,
  ) {}

  /** The audio the recording gained. Returns at once; the pieces go out behind it. */
  feed(pcm: Buffer): void {
    if (this.done || this.failed || pcm.length === 0) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    while (this.pending.length >= PIECE_BYTES) {
      const piece = this.pending.subarray(0, PIECE_BYTES);
      this.pending = this.pending.subarray(PIECE_BYTES);
      this.cut += PIECE_BYTES;
      this.enqueue(piece);
    }
  }

  private enqueue(pcm: Buffer): void {
    if (this.enqueued >= MAX_UP_PARTS) {
      this.failed = true;
      return;
    }
    const index = this.enqueued++;
    this.chain = this.chain.then(async () => {
      if (this.failed || this.done) return;
      try {
        const opus = await this.options.encode(pcm);
        const { store, channel, key } = this.options;
        const at = (this.options.now ?? Date.now)();
        await store.set(
          upPath(channel, upAudioId(this.streamId, index)),
          sealUpPart(key, this.streamId, index, opus, at),
        );
        this.hashes[index] = upPartHash(opus);
      } catch {
        this.failed = true;
      }
    });
  }

  /**
   * The recording ended: sends what is left of `pcm` (the whole recording's audio) and returns the pieces' hashes in
   * order, or null when something did not go and the caller must send the whole recording instead (the pieces written
   * so far are deleted).
   */
  async finish(pcm: Buffer): Promise<string[] | null> {
    if (this.done) return null;
    const before = this.enqueued;
    if (this.failed || pcm.length < this.cut) {
      await this.abort();
      return null;
    }
    const rest = pcm.subarray(this.cut, pcm.length - ((pcm.length - this.cut) % 2));
    if (rest.length > 0) this.enqueue(rest);
    await this.chain;
    if (
      this.failed ||
      this.hashes.length !== this.enqueued ||
      this.hashes.length === 0 ||
      this.hashes.some((h) => !h)
    ) {
      await this.abort();
      return null;
    }
    this.done = true;
    const total = this.hashes.length;
    const noun = (n: number) => `${n} piece${n === 1 ? "" : "s"}`;
    this.options.trace?.(
      before > 0 ? `step: Sent ${noun(total)} (${before} while recording)` : `step: Sent ${noun(total)}`,
    );
    return [...this.hashes];
  }

  /** Throws the pieces away (the recording was not used, or went another way). */
  async abort(): Promise<void> {
    this.done = true;
    this.failed = true;
    await this.chain;
    await this.discardWritten();
  }

  /** Deletes every piece's document, written or not: a delete of a missing one is nothing. */
  private async discardWritten(): Promise<void> {
    const { store, channel } = this.options;
    const ids: string[] = [];
    for (let index = 0; index < this.enqueued; index++) ids.push(upAudioId(this.streamId, index));
    await Promise.allSettled(ids.map((id) => store.delete(upPath(channel, id))));
  }
}
