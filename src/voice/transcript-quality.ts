/**
 * Whether a transcript is worth reading back as a message. Whisper answers silence and line noise with a few stock
 * strings ("you", "Thank you.", "."), and a hiss or a cough comes back as "uh". Sending those to an agent is never
 * what the person meant, so the call asks first: `silence` says nothing was heard, `unclear` offers to record again
 * (or send it anyway), `ok` goes through the normal read-back.
 */
export type TranscriptQuality = "ok" | "unclear" | "silence";

/** Whisper's usual output for silence or noise, lowercase and without punctuation. */
const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "bye",
  "bye bye",
  "goodbye",
  "blank audio",
  "silence",
  "music",
  "applause",
  "laughter",
  "inaudible",
]);

/** Under this a recording is a blip, not a sentence. */
export const MIN_CLEAR_MS = 1_500;
const SHORT_WORDS = 2;
const SHORT_CHARS = 8;

const normalise = (text: string): string =>
  text
    .toLowerCase()
    // Whisper's bracketed markers, [BLANK_AUDIO] or (silence), keep their words.
    .replace(/[_-]/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function judgeTranscript(text: string, durationMs: number): TranscriptQuality {
  const plain = normalise(text);
  if (plain === "" || SILENCE_HALLUCINATIONS.has(plain)) return "silence";
  const words = plain.split(" ").length;
  if (words <= SHORT_WORDS && plain.length < SHORT_CHARS) return "unclear";
  if (durationMs < MIN_CLEAR_MS) return "unclear";
  return "ok";
}
