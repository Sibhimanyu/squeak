import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { Clip } from "./clips.js";
import type { AnswerFollower } from "./answer-audio.js";
import {
  audioPath,
  downPath,
  readAudio,
  replyAudioId,
  newMessageId,
  readDown,
  sealUp,
  UP_TTL_MS,
  upPath,
  type DownMessage,
  type TalkPhase,
  type UpMessage,
} from "./memo-protocol.js";

/** The gateway's line to the Mac during a call: a memo up, what the Mac heard back; "send it" up, the outcome back. */
export interface Uplink {
  /** Null when the Mac did not answer in time. */
  memo(memoId: string, choice: number, dirVersion: string, audio: Buffer): Promise<DownMessage | null>;
  send(memoId: string): Promise<DownMessage | null>;
  /** Treat the recording as a question about its chat: the answer to read aloud. Sends nothing to the chat. */
  ask(memoId: string): Promise<DownMessage | null>;
  /** Where a chat stands, to read aloud. */
  status(choice: number, dirVersion: string): Promise<DownMessage | null>;
  /** One turn of a voice-first call: what the person said (or their yes or no), and what to say and do next. */
  talk(
    callId: string,
    phase: TalkPhase,
    audio: Buffer,
    /** A call in: the chat of the published list this call talks about. Absent: a call out, whose id names its chat. */
    from?: { dirVersion: string; choice: number },
  ): Promise<DownMessage | null>;
  /**
   * Follows the later sentences of an answer the Mac is still making (`audioFollows` on its reply): the documents
   * `replyaudio-<messageId>-<n>`, n from 1. Absent in a test double: the answer is spoken whole.
   */
  followAnswer?(messageId: string, count: number): AnswerFollower;
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
  /** A model answers a question: longer than a transcript, and the Mac gives up on its own sooner. */
  askWaitMs?: number;
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

  ask(memoId: string): Promise<DownMessage | null> {
    const at = this.now();
    return this.exchange(
      { v: 1, id: newMessageId(), at, expiresAt: at + UP_TTL_MS, kind: "ask", memoId },
      this.options.askWaitMs ?? 80_000,
    );
  }

  status(choice: number, dirVersion: string): Promise<DownMessage | null> {
    const at = this.now();
    return this.exchange(
      { v: 1, id: newMessageId(), at, expiresAt: at + UP_TTL_MS, kind: "status", dirVersion, choice },
      // The Mac reads the status out in its own voice before it answers (up to 20 s), so it gets longer than a send.
      this.options.sendWaitMs ?? 45_000,
    );
  }

  talk(
    callId: string,
    phase: TalkPhase,
    audio: Buffer,
    from?: { dirVersion: string; choice: number },
  ): Promise<DownMessage | null> {
    const at = this.now();
    return this.exchange(
      {
        v: 1,
        id: newMessageId(),
        at,
        expiresAt: at + UP_TTL_MS,
        kind: "talk",
        dirVersion: from ? from.dirVersion : callId,
        choice: from ? from.choice : 1,
        ...(from ? { callId } : {}),
        phase,
        audio: audio.toString("base64"),
      },
      // Transcribing, a model working out the answer and the Mac's voice: as long as an ask, and a little more.
      90_000,
    );
  }

  followAnswer(messageId: string, count: number): AnswerFollower {
    const { store, channel, key } = this.options;
    const clips = new Map<number, Clip>();
    const waiters = new Set<() => void>();
    let stopped = false;
    let busy = false;
    let again = false;
    const pull = async (): Promise<void> => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        // In order: the next sentence only, and on while they are there.
        for (let index = 1; index < count && !stopped; index += 1) {
          if (clips.has(index)) continue;
          const docId = replyAudioId(messageId, index);
          const doc = await store.get(audioPath(channel, docId));
          if (!doc) break;
          const read = readAudio(key, docId, doc);
          // A document that does not check out is as good as missing: the add-on speaks that sentence itself.
          if (read && read.version === messageId && read.clips.length === 1) clips.set(index, read.clips[0]!);
          else break;
          for (const wake of [...waiters]) wake();
        }
      } catch {
        // The next event or poll tries again.
      } finally {
        busy = false;
        if (again) {
          again = false;
          void pull();
        }
      }
    };
    const unwatch = store.watch(`channels/${channel}/voicedir`, () => void pull());
    const poll = setInterval(() => void pull(), 1000);
    poll.unref?.();
    void pull();
    return {
      wait: (index, timeoutMs) =>
        new Promise<Clip | null>((resolve) => {
          const have = clips.get(index);
          if (have) return resolve(have);
          const done = (): void => {
            const clip = clips.get(index);
            if (clip || stopped) finish(clip ?? null);
          };
          const finish = (clip: Clip | null): void => {
            clearTimeout(timer);
            waiters.delete(done);
            resolve(clip);
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          timer.unref?.();
          waiters.add(done);
        }),
      stop: () => {
        if (stopped) return;
        stopped = true;
        unwatch();
        clearInterval(poll);
        for (const wake of [...waiters]) wake();
        for (let index = 1; index < count; index += 1) {
          void Promise.resolve(store.delete(audioPath(channel, replyAudioId(messageId, index)))).catch(() => undefined);
        }
      },
    };
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
