import type { Clip } from "./clips.js";
import type { DownMessage } from "./memo-protocol.js";
import type { PhoneCall } from "./phone.js";

/**
 * Speaking an answer the Mac is still making (`audioFollows`, add-on 0.17.0): the first sentence's clip is in the
 * answer and plays at once, each later sentence plays as its document arrives, in order. If the next one is not there
 * when the previous ends, the line rests on silence for `ANSWER_GAP_MS` and then the rest is spoken in the add-on's
 * quick plain voice (the speaker never makes a slow voice during a call), so the call never stalls.
 */

/** How long the line waits for the next sentence before the remainder is spoken here. */
export const ANSWER_GAP_MS = 1500;

/** The later sentences of one answer, as they arrive. */
export interface AnswerFollower {
  /** The clip of sentence `index` (1 and up), at once if it is here, else when it arrives; null after `timeoutMs`. */
  wait(index: number, timeoutMs: number): Promise<Clip | null>;
  /** Stops following and deletes what the Mac wrote for this answer. */
  stop(): void;
}

export interface SpeakReplyDependencies {
  /** Follows an answer's later sentences; absent: only the whole text is spoken (as an add-on before 0.17.0 would). */
  uplink?: { followAnswer?: (messageId: string, count: number) => AnswerFollower };
  /** Gives the phone the Mac's recording of these words, so saying them plays it. */
  seed?: (clips: Clip[]) => void;
  /** The call log: `said: …`, `step: …`. */
  trace?: (line: string) => void;
  gapMs?: number;
}

/** What `say` needs of a reply: an answer or talk with its first clip and, perhaps, the sentences that follow. */
export type SpokenReply = Extract<DownMessage, { status: "answer" | "talk" }>;

export async function speakReply(call: PhoneCall, reply: SpokenReply, deps: SpeakReplyDependencies): Promise<void> {
  const parts = reply.audioFollows?.parts;
  const follower = parts && reply.audio ? deps.uplink?.followAnswer?.(reply.id, parts.length) : undefined;
  if (reply.audio) deps.seed?.([reply.audio]);
  if (!parts || !follower) {
    deps.trace?.(`said: ${reply.text}`);
    await call.say(reply.text);
    return;
  }
  const gap = deps.gapMs ?? ANSWER_GAP_MS;
  try {
    deps.trace?.(`said: ${reply.text}`);
    await call.say(parts[0]!);
    for (let index = 1; index < parts.length && call.open; index += 1) {
      const clip = await follower.wait(index, gap);
      if (!clip || clip.text !== parts[index]) {
        deps.trace?.(`step: Sentence ${index + 1} was late; the rest is spoken by the add-on`);
        await call.say(parts.slice(index).join(" "));
        return;
      }
      deps.seed?.([clip]);
      await call.say(parts[index]!);
    }
  } finally {
    follower.stop();
  }
}
