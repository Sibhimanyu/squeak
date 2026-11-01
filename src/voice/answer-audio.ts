import type { Clip } from "./clips.js";
import type { DownMessage } from "./memo-protocol.js";
import type { PhoneCall } from "./phone.js";

/**
 * Speaking an answer the Mac is still making (`audioFollows`, add-on 0.17.0): the first part's clip is in the answer
 * and plays at once, each later part plays as its document arrives, in order. The line rests on silence while it waits.
 * A part that is not there `ANSWER_GAP_MS` after the previous ended is traced as late; one still missing after
 * `ANSWER_LATE_MS` is spoken by the add-on in its quick plain voice (the speaker never makes a slow voice during a
 * call), and only that part: the next one is followed from the Mac again. Since add-on 0.19.0 the same goes for a
 * read-back (`readBackSpeech`).
 */

/** After the previous part ended, how long before a part that is not there is traced as late. */
export const ANSWER_GAP_MS = 1500;
/** After the previous part ended, how long a part is waited for before the add-on speaks it itself. */
export const ANSWER_LATE_MS = 8000;

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
  /** Overrides `ANSWER_GAP_MS` (tests). */
  gapMs?: number;
  /** Overrides `ANSWER_LATE_MS` (tests). */
  lateMs?: number;
}

/** What `say` needs of a reply: an answer or talk with its first clip and, perhaps, the sentences that follow. */
export type SpokenReply = Extract<DownMessage, { status: "answer" | "talk" | "newchat" | "transcript" }>;

export async function speakReply(call: PhoneCall, reply: SpokenReply, deps: SpeakReplyDependencies): Promise<void> {
  const parts = reply.audioFollows?.parts;
  const follower = parts && reply.audio ? deps.uplink?.followAnswer?.(reply.id, parts.length) : undefined;
  if (reply.audio) deps.seed?.([reply.audio]);
  if (!parts || !follower) {
    deps.trace?.(`said: ${reply.text}`);
    await call.say(reply.text);
    return;
  }
  deps.trace?.(`said: ${reply.text}`);
  await speakFollowed(call, parts, follower, deps);
}

/** Says `parts` in order: the first at once, each later one as the Mac's clip arrives (or, late, in the add-on's voice). */
async function speakFollowed(
  call: PhoneCall,
  parts: readonly string[],
  follower: AnswerFollower,
  deps: SpeakReplyDependencies,
): Promise<void> {
  const gap = deps.gapMs ?? ANSWER_GAP_MS;
  const late = Math.max(gap, deps.lateMs ?? ANSWER_LATE_MS);
  try {
    await call.say(parts[0]!);
    for (let index = 1; index < parts.length && call.open; index += 1) {
      // Someone who has pressed a key is not waiting for the rest.
      if (keyed(call)) return;
      const began = Date.now();
      let clip: Clip | null = null;
      // In short looks, so a key pressed while the line rests on silence is noticed at once.
      while (!clip && Date.now() - began < late && call.open && !keyed(call)) {
        const slice = Math.min(KEY_LOOK_MS, late - (Date.now() - began));
        const lookedAt = Date.now();
        clip = await follower.wait(index, slice);
        // A follower that gives up before its time (stopped, or a test double) will not have it later.
        if (!clip && Date.now() - lookedAt < slice - 50) break;
      }
      if (keyed(call) || !call.open) return;
      const waited = Date.now() - began;
      if (clip && clip.text !== parts[index]) clip = null;
      if (clip) {
        if (waited > gap) deps.trace?.(`step: Sentence ${index + 1} was late (${(waited / 1000).toFixed(1)} s)`);
        deps.seed?.([clip]);
      } else {
        deps.trace?.(`step: Sentence ${index + 1} spoken by the add-on`);
      }
      await call.say(parts[index]!);
    }
  } finally {
    follower.stop();
  }
}

/** How often a wait for a late part looks for a pressed key. */
const KEY_LOOK_MS = 400;

/**
 * The words of a refusal, ready to say. The Mac's clip of exactly these words (add-on 0.20.0) is given to the phone first,
 * so the refusal is in the Mac's voice; without one the add-on's own voice says it.
 */
export function refusalWords(
  heard: Extract<DownMessage, { status: "refused" }>,
  deps: Pick<SpeakReplyDependencies, "seed">,
): string {
  if (heard.audio && heard.audio.text === heard.reason) deps.seed?.([heard.audio]);
  return heard.reason;
}

/** The words with every run of whitespace folded to one space, as the Mac's parts are cut. */
export const foldWords = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Says a read-back, and says it again for star. With the Mac's parts (`audioFollows` on the transcript, parts that
 * joined are exactly `readBack`) the first time follows them as they are made; after that, and with no parts, it says
 * the words part by part again from the clips the phone already holds (or, without any, the whole text as one). The
 * returned function resolves when the words are done or a key is pressed.
 */
export function readBackSpeech(
  call: PhoneCall,
  heard: Extract<DownMessage, { status: "transcript" }>,
  readBack: string,
  deps: SpeakReplyDependencies,
): () => Promise<void> {
  const parts = heard.audioFollows?.parts;
  const matches = Boolean(parts && heard.audio && foldWords(parts.join(" ")) === foldWords(readBack));
  let first = true;
  let partwise = false;
  return async () => {
    deps.trace?.(`said: ${readBack}`);
    if (!parts || !matches) {
      await call.say(readBack);
      return;
    }
    if (first) {
      first = false;
      const follower = deps.uplink?.followAnswer?.(heard.id, parts.length);
      if (heard.audio) deps.seed?.([heard.audio]);
      if (follower) {
        partwise = true;
        return speakFollowed(call, parts, follower, deps);
      }
      await call.say(readBack);
      return;
    }
    if (!partwise) {
      await call.say(readBack);
      return;
    }
    // Again: every clip that came is seeded already, and a part the add-on had to say is in its own cache.
    for (const part of parts) {
      if (!call.open || keyed(call)) return;
      await call.say(part);
    }
  };
}

const keyed = (call: PhoneCall): boolean => call.keyPending === true;
