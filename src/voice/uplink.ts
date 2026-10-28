import type { RtdbRest } from "../remote/rtdb-rest.js";
import {
  downPath,
  newMessageId,
  readDown,
  sealUp,
  UP_TTL_MS,
  upPath,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";

/** The gateway's line to the Mac during a call: a memo up, what the Mac heard back; "send it" up, the outcome back. */
export interface Uplink {
  /** Null when the Mac did not answer in time. */
  memo(memoId: string, choice: number, dirVersion: string, audio: Buffer): Promise<DownMessage | null>;
  send(memoId: string): Promise<DownMessage | null>;
}

export type UplinkStore = Pick<RtdbRest, "get" | "set" | "delete" | "watch">;

export interface RelayUplinkOptions {
  store: UplinkStore;
  channel: string;
  key: string;
  now?: () => number;
  /** How long to wait for the Mac: transcribing takes a few seconds, and the phone line is waiting. */
  memoWaitMs?: number;
  sendWaitMs?: number;
}

const POLL_MS = 5000;

export class RelayUplink implements Uplink {
  private readonly now: () => number;

  constructor(private readonly options: RelayUplinkOptions) {
    this.now = options.now ?? Date.now;
  }

  memo(memoId: string, choice: number, dirVersion: string, audio: Buffer): Promise<DownMessage | null> {
    const at = this.now();
    return this.exchange(
      {
        v: 1,
        id: memoId,
        at,
        expiresAt: at + UP_TTL_MS,
        kind: "memo",
        dirVersion,
        choice,
        audio: audio.toString("base64"),
      },
      this.options.memoWaitMs ?? 45_000,
    );
  }

  send(memoId: string): Promise<DownMessage | null> {
    const at = this.now();
    return this.exchange(
      { v: 1, id: newMessageId(), at, expiresAt: at + UP_TTL_MS, kind: "send", memoId },
      this.options.sendWaitMs ?? 30_000,
    );
  }

  private async exchange(message: UpMessage, waitMs: number): Promise<DownMessage | null> {
    const { store, channel, key } = this.options;
    try {
      await store.set(upPath(channel, message.id), sealUp(key, message));
    } catch {
      return null;
    }
    const deadline = this.now() + waitMs;
    try {
      return await new Promise<DownMessage | null>((resolve) => {
        let settled = false;
        let reading = false;
        let again = false;
        const finish = (answer: DownMessage | null): void => {
          if (settled) return;
          settled = true;
          unwatch();
          clearInterval(poll);
          resolve(answer);
        };
        const check = async (): Promise<void> => {
          if (settled) return;
          if (reading) {
            again = true;
            return;
          }
          reading = true;
          try {
            const doc = await store.get(downPath(channel, message.id));
            const answer = doc ? readDown(key, message.id, doc) : null;
            if (answer) return finish(answer);
          } catch {
            // The next event or poll tries again; the deadline ends it.
          } finally {
            reading = false;
            if (again) {
              again = false;
              void check();
            }
          }
          if (this.now() > deadline) finish(null);
        };
        const unwatch = store.watch(`channels/${channel}/voicedown`, () => void check());
        const poll = setInterval(() => void check(), POLL_MS);
        poll.unref?.();
        const stop = setTimeout(() => finish(null), waitMs);
        stop.unref?.();
      });
    } finally {
      await Promise.allSettled([
        store.delete(upPath(channel, message.id)),
        store.delete(downPath(channel, message.id)),
      ]);
    }
  }
}
