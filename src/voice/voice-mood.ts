/**
 * What a line of a call should sound like, read from its words (no model, no network). The expressive engines
 * (voice-engines.ts) turn a mood and a level into their own controls; Squeak's own lines are few and fixed in shape,
 * so a handful of rules over them is enough, and one mood covers a whole line (all its sentences).
 */

export type Mood = "urgent" | "cheerful" | "apologetic" | "sympathetic" | "warm" | "neutral";
export type EmotionLevel = "off" | "subtle" | "strong";
export const EMOTION_LEVELS: readonly EmotionLevel[] = ["off", "subtle", "strong"];
export const DEFAULT_EMOTION: EmotionLevel = "subtle";

/** Menus and prompts that only say which key does what: read evenly, whatever words they carry. */
const PLAIN_START = /^(options\b|press\b|please enter\b|speak your\b)/i;
const APOLOGETIC = /\b(sorry|apolog\w*)\b|\bnot right\b|\bdid not hear anything\b|\bdidn't hear anything\b/i;
const URGENT = /\b(waiting for your approval|needs an answer|has a question for you|blocked|heads up)\b/i;
/** Said while the work is still going: the "done" in "call you back when it is done" is not news. */
const PROMISE = /\b(call you back|taking a while)\b/i;
const CHEERFUL = /\b(is done|good news|finished|all the tests pass\w*)\b|^done\b|^sent [a-z]\b|\bwas sent to\b/i;
const SYMPATHETIC =
  /\b(failed|error|oh no|went wrong|could not reach|not sure it was sent|could not get an answer|stopped)\b/i;
const WARM =
  /\b(goodbye|call you back|taking a while|cancelled|still working|one moment|hello|as many answers as i can give)\b/i;

/** The mood of one line, by the first rule that fits: apologetic, urgent, a promise to call back, cheerful, sympathetic, warm, else neutral. */
export function moodOf(text: string): Mood {
  const line = text.replace(/\s+/g, " ").trim();
  if (PLAIN_START.test(line)) return "neutral";
  if (APOLOGETIC.test(line)) return "apologetic";
  if (URGENT.test(line)) return "urgent";
  if (PROMISE.test(line)) return "warm";
  if (CHEERFUL.test(line)) return "cheerful";
  if (SYMPATHETIC.test(line)) return "sympathetic";
  if (WARM.test(line)) return "warm";
  return "neutral";
}

/** What the engines are told: `off` is neutral for every line. */
export function moodFor(text: string, level: EmotionLevel): { mood: Mood; level: EmotionLevel } {
  return level === "off" ? { mood: "neutral", level } : { mood: moodOf(text), level };
}
