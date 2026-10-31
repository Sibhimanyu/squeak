import { summarizeOutcome, stripMarkdown } from "../fleet/card-text.js";
import { parseChoices } from "../fleet/choices.js";
import { chatTitle } from "../fleet/radar.js";
import { shouldPush } from "../fleet/attention.js";
import type { AttentionItem, AttentionKind } from "../fleet/types.js";
import type { CallScript } from "./dialog.js";
import { spokenChat, spokenWorkspace } from "./spoken-labels.js";

export { CallDialog, MAX_PIN_TRIES, type CallScript, type DialogAction } from "./dialog.js";

/**
 * What a phone call says and listens for. Pure, so the wording and the keypad are tested
 * without a PBX: the line (`baresip-line.ts`) only plays what `CallDialog` asks for and feeds it keys.
 */

/** A call wakes a person, so only what is waiting on them: never a finish, a stall or an error. */
export const CALL_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  "blocked_approval",
  "blocked_question",
  "asked_question",
]);

export function shouldCall(item: Pick<AttentionItem, "kind" | "session">): boolean {
  return CALL_KINDS.has(item.kind) && shouldPush(item.kind, item.session);
}

/** The keypad answers up to eight lettered options: 1 is A, 2 is B, and so on. */
export const MAX_KEYPAD_OPTIONS = 8;

function say(text: string): string {
  return stripMarkdown(text)
    .replace(/https?:\/\/\S+/gi, "a link")
    .replace(/\s+/g, " ")
    .trim();
}

/** About 10 seconds of speech: the rest is on the phone, or one key away. */
export const MAX_QUESTION_WORDS = 25;
/** An option is a handful of words, not a sentence. */
export const MAX_OPTION_WORDS = 6;
export const FULL_TEXT_NOTE = "The full text is on your phone.";

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const LEADING_FILLER =
  /^(?:(?:so|okay|ok|sure|great|alright|all right|well|hey|hi|quick question|one thing)\b[,:!.]?\s+)+/i;
const TRAILING_FILLER = /^(?:please\s+)?(?:let me know|thanks|thank you|hope (?:this|that) helps)\b/i;

function tidy(text: string): string {
  return text.replace(/[\s,;:\u2014\u2013-]+$/, "").trim();
}

/** A sentence too long to keep: cut at a clause break in its back half, else at a word. Never mid-word. */
function cutSentence(sentence: string, max: number): string {
  const head = words(sentence).slice(0, max).join(" ");
  const breaks = [...head.matchAll(/[,;:]\s|\s[\u2014\u2013-]\s/g)];
  const late = breaks.filter((m) => (m.index ?? 0) > head.length / 2).pop();
  const cut = late ? head.slice(0, late.index) : head;
  return `${tidy(cut)}.`;
}

/**
 * The question as it is read aloud: filler dropped, at most `max` words, cut at a sentence boundary (a sentence
 * too long to keep alone is cut at a clause or a word, never in the middle of one). When the start does not fit
 * the closing question is kept, since that is what the person has to answer. `cut` says words were left out.
 */
export function clipQuestion(raw: string, max = MAX_QUESTION_WORDS): { text: string; cut: boolean } {
  const flat = say(raw).replace(LEADING_FILLER, "");
  if (words(flat).length <= max) return { text: flat, cut: false };
  let sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).filter(Boolean);
  const kept = sentences.filter((s) => !TRAILING_FILLER.test(s));
  if (kept.length > 0) sentences = kept;
  const fill = (budget: number): string[] => {
    const out: string[] = [];
    let used = 0;
    for (const sentence of sentences) {
      const n = words(sentence).length;
      if (used + n > budget) break;
      out.push(sentence);
      used += n;
    }
    return out;
  };
  const question = [...sentences].reverse().find((s) => s.endsWith("?"));
  const qWords = question ? words(question).length : 0;
  let lead = fill(max);
  if (question && !lead.includes(question) && qWords <= max - 8) {
    lead = [...fill(max - qWords), question];
  }
  if (lead.length === 0) lead = [cutSentence(sentences[0] ?? flat, max)];
  return { text: lead.join(" "), cut: true };
}

/** One option as spoken: the part before a dash, colon or bracket, at most six words, no trailing punctuation. */
export function clipOption(title: string): string {
  const flat = say(title);
  const head = flat.split(/\s[\u2014\u2013-]\s|:\s|\s\(/)[0]?.trim() || flat;
  return tidy(words(head).slice(0, MAX_OPTION_WORDS).join(" ")).replace(/[.!?]+$/, "");
}

function describe(kind: AttentionKind): string {
  switch (kind) {
    case "blocked_approval":
      return "is waiting for your approval";
    case "blocked_question":
      return "needs an answer";
    default:
      return "has a question for you";
  }
}

/**
 * The script for one call. `lastText` is the agent's whole last message (a card's 180-character detail
 * is no use for reading options out); `canAnswer` is whether a reply could go back right now.
 */
export function composeScript(
  item: AttentionItem,
  lastText: string | null,
  canAnswer: boolean,
  /** The add-on can take a message for this chat (9) and read its status (0): said, and named in the script. */
  followUp = false,
): CallScript {
  // The chat's own name as you know it from the sidebar ("App quitting loop"), else its workspace; never the branch
  // or a dot ("squeak · main"), which a voice reads as noise.
  const label = chatTitle(item.session) ? spokenChat(item.session) : spokenWorkspace(item.session);
  const choices = item.kind === "asked_question" || item.kind === "blocked_question" ? parseChoices(lastText) : null;
  const options = (choices?.options ?? []).slice(0, MAX_KEYPAD_OPTIONS);
  const askedRaw = choices?.question ?? summarizeOutcome(lastText, 600);
  const asked = askedRaw ? clipQuestion(askedRaw) : null;
  const greeting = `Hello, this is Squeak. ${label} ${describe(item.kind)}.`;

  const parts: string[] = [];
  if (asked) parts.push(asked.cut ? `${asked.text} ${FULL_TEXT_NOTE}` : asked.text);
  if (canAnswer && options.length > 0) {
    const spoken = options.map((option, index) => {
      const recommended = choices?.recommended === option.letter ? ", recommended" : "";
      return `${index + 1}, ${clipOption(option.title)}${recommended}.`;
    });
    parts.push(`Options. ${spoken.join(" ")}`);
  } else if (item.kind === "blocked_approval") {
    parts.push("Approve it from the Mac or the phone app.");
  } else {
    parts.push("Open Squeak to answer.");
  }
  const follow = followUp && canAnswer;
  if (follow) parts.push("Press 9 to send a message or ask a question about it, or 0 to hear where it stands.");
  parts.push("Press star to hear this again, or hash to hang up.");
  return {
    greeting,
    question: parts.join(" "),
    options: canAnswer ? options : [],
    ...(follow ? { followUp: { label } } : {}),
  };
}
