import { stripMarkdown } from "./card-text.js";

/**
 * Reading "pick one of these" out of an agent's last message.
 *
 * Agents that end a turn on a decision write it the same way over and over:
 * a question, then lettered options, often bold, often with a recommendation
 * line above them. Turning those into buttons lets the answer be one tap on a
 * lock screen instead of opening Conductor to type a single letter.
 *
 * Letters only, on purpose. Numbered lists are how agents summarise what they
 * did ("1. Ran the tests 2. Fixed the import"), and offering buttons for a
 * summary would turn every finish card into a fake question.
 */

export interface ChoiceOption {
  letter: string;
  /** The option's name, short enough for one line of a card. */
  title: string;
  /** What a tap sends, when it is not the letter: a choice read from prose ("Number two"). */
  reply?: string;
}

export interface ParseOptions {
  /**
   * Also read a choice the agent put in prose ("number one or number two?"). Only the phone asks for this:
   * its buttons send `reply`, while Telegram and Cliq send the letter and would answer the wrong thing.
   */
  prose?: boolean;
}

export interface ParsedChoices {
  /** The question being asked, or null when the message never states one. */
  question: string | null;
  options: ChoiceOption[];
  /** The letter the agent recommended, if it said so and it is one of the options. */
  recommended: string | null;
}

const OPTION_TITLE_MAX = 70;
const QUESTION_MAX = 120;

/**
 * An option line: `A) ...`, `A. ...`, `A: ...`, `(A) ...`, optionally inside a
 * list marker and bold. The letter must be followed by punctuation and a
 * space, so a sentence that merely starts with "A " is not an option.
 */
const OPTION_LINE = /^(?:[-*+]\s+)?(?:\*\*|__)?\(?([A-H])[).:](?:\*\*|__)?\s+(.+)$/;

export function parseChoices(text: string | null, parseOptions: ParseOptions = {}): ParsedChoices | null {
  if (!text) {
    return null;
  }
  const lettered = parseLettered(text);
  if (lettered || !parseOptions.prose) {
    return lettered;
  }
  return parseProseChoices(text);
}

function parseLettered(text: string): ParsedChoices | null {
  // Code blocks can contain anything, including lines that look like options.
  const lines = text.replace(/```[\s\S]*?```/g, "").split("\n");

  const found: Array<{ letter: string; line: string; index: number }> = [];
  for (const [index, raw] of lines.entries()) {
    const match = OPTION_LINE.exec(raw.trim());
    if (match) {
      found.push({ letter: match[1]!, line: raw.trim(), index });
    }
  }

  // The options must run A, B, C… from the top. Anything else is prose that
  // happens to start with a capital and a full stop.
  const options: Array<{ letter: string; line: string; index: number }> = [];
  for (const candidate of found) {
    const expected = String.fromCharCode("A".charCodeAt(0) + options.length);
    if (candidate.letter === expected) {
      options.push(candidate);
    } else if (candidate.letter === "A") {
      // A second lettered block (D1 and D2 in one message) makes a bare letter
      // ambiguous. Better to offer a free-text reply than a wrong button.
      return null;
    }
  }
  if (options.length < 2) {
    return null;
  }

  const parsed = options.map((option) => ({ letter: option.letter, title: optionTitle(option.line) }));
  const recommended = findRecommendation(text, parsed);

  return {
    question: findQuestion(lines.slice(0, options[0]!.index)),
    // The recommendation is carried by `recommended`; left in the title too,
    // every surface would say it twice ("Arm it now (recommended) ★").
    options: parsed.map((option) => ({
      ...option,
      title: option.title.replace(/\s*\((?:recommended|suggested)\)\s*/i, " ").trim(),
    })),
    recommended,
  };
}

/**
 * The option's name. Agents usually bold it (`**A) Arm it now.** Details…`),
 * which marks exactly where the name ends; otherwise the first sentence is the
 * name and the rest is explanation.
 */
function optionTitle(line: string): string {
  const withoutMarker = line.replace(/^(?:[-*+]\s+)/, "");
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(withoutMarker);
  const source = bold ? bold[1]! : withoutMarker;
  let title = stripMarkdown(source).replace(/^\(?[A-H][).:]\s*/, "");
  if (!bold) {
    title = title.split(/(?<=[.!?])\s|\s[—–]\s/)[0] ?? title;
  }
  title = title.replace(/[.:]\s*$/, "").trim();
  return title.length <= OPTION_TITLE_MAX ? title : `${title.slice(0, OPTION_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * The question is the nearest line above the options that asks something. A
 * "(reply with a letter)" hint is noise once there are buttons, so it goes.
 */
function findQuestion(before: string[]): string | null {
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const flat = stripMarkdown(before[index]!)
      .replace(/\((?:reply|answer|respond) with [^)]*\)/gi, "")
      .trim();
    if (flat.includes("?")) {
      return flat.length <= QUESTION_MAX ? flat : `${flat.slice(0, QUESTION_MAX - 1).trimEnd()}…`;
    }
  }
  return null;
}

function findRecommendation(text: string, options: ChoiceOption[]): string | null {
  const letters = new Set(options.map((option) => option.letter));
  const stated = /recommend(?:ation|ed)?\s*[:：]\s*(?:\*\*)?(?:option\s+)?\(?([A-H])\b/i.exec(text);
  if (stated && letters.has(stated[1]!)) {
    return stated[1]!;
  }
  const marked = options.find((option) => /\brecommended\b/i.test(option.title));
  return marked?.letter ?? null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const WORD_FOR = ["", "one", "two", "three", "four", "five", "six"];
/** "number one", "option 2", "#3", "the first one": how an agent points at something it listed. */
const REFERENCE = /\b(number|option|choice|approach|path|plan|#)\s*(one|two|three|four|five|six|[1-6])\b/gi;
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };
const ORDINAL_REFERENCE = /\bthe\s+(first|second|third|fourth)(?:\s+(?:one|option|approach|path|plan))?\b/gi;
/** A numbered list line: `1. …`, `1) …`, `**1.** …`, optionally in a bullet. */
const NUMBERED_LINE = /^(?:[-*+]\s+)?(?:\*\*|__)?([1-6])[).:](?:\*\*|__)?\s+(.+)$/;
/** A closing question that really asks which one, not "shall I carry on?". */
const ASKS_WHICH =
  /\bwhich\b|\b(?:pick|choose|prefer|go with)\b|\b(?:number|option|choice|approach)\s*(?:one|two|three|[1-6])\b/i;

/**
 * A decision the agent put in words: "Want to do number one or number two?", or a numbered list closed by
 * "Which do you prefer?". Only the message's closing question counts, so a numbered summary of what was done is
 * never turned into buttons. A tap sends the agent's own words for the option, not a letter.
 */
function parseProseChoices(text: string): ParsedChoices | null {
  const lines = text.replace(/```[\s\S]*?```/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  const last = lines[lines.length - 1];
  if (!last || !stripMarkdown(last).trim().endsWith("?")) {
    return null;
  }
  const closing = stripMarkdown(last).trim();
  const sentences = closing.split(/(?<=[.!?])\s+/);
  const question = sentences[sentences.length - 1]!;

  // The items the message listed, by number.
  const listed = new Map<number, string>();
  for (const raw of lines.slice(0, -1)) {
    const match = NUMBERED_LINE.exec(raw.trim());
    if (match) {
      const number = Number(match[1]);
      if (!listed.has(number)) {
        listed.set(number, optionTitle(raw.trim().replace(/^((?:[-*+]\s+)?(?:\*\*|__)?)[1-6][).:]/, "$1A.")));
      }
    }
  }

  // Which of them the question points at: "number one or number two".
  const named: number[] = [];
  const phrases = new Map<number, string>();
  for (const match of question.matchAll(REFERENCE)) {
    const raw = match[2]!.toLowerCase();
    const number = NUMBER_WORDS[raw] ?? Number(raw);
    if (!named.includes(number)) {
      named.push(number);
      phrases.set(
        number,
        `${match[1] === "#" ? "Number" : match[1]![0]!.toUpperCase() + match[1]!.slice(1).toLowerCase()} ${raw}`,
      );
    }
  }
  for (const match of question.matchAll(ORDINAL_REFERENCE)) {
    const number = ORDINALS[match[1]!.toLowerCase()]!;
    if (!named.includes(number)) {
      named.push(number);
      phrases.set(number, `The ${match[1]!.toLowerCase()} one`);
    }
  }
  if (named.length >= 2 && /\bor\b/i.test(question)) {
    const options = named.slice(0, 8).map((number, index) => {
      const phrase = phrases.get(number) ?? `Number ${WORD_FOR[number] ?? number}`;
      return { letter: String.fromCharCode(65 + index), title: listed.get(number) ?? phrase, reply: phrase };
    });
    return { question: clip(question), options, recommended: null };
  }

  // No pointing words: a list of 2+ consecutive items from 1, closed by a question that asks which.
  if (ASKS_WHICH.test(question)) {
    const numbers = [...listed.keys()].sort((a, b) => a - b);
    if (numbers.length >= 2 && numbers.every((value, index) => value === index + 1)) {
      const options = numbers.map((number, index) => ({
        letter: String.fromCharCode(65 + index),
        title: listed.get(number)!,
        reply: String(number),
      }));
      return { question: clip(question), options, recommended: null };
    }
  }
  return null;
}

function clip(question: string): string {
  return question.length <= QUESTION_MAX ? question : `${question.slice(0, QUESTION_MAX - 1).trimEnd()}…`;
}
