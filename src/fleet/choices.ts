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

export function parseChoices(text: string | null): ParsedChoices | null {
  if (!text) {
    return null;
  }

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
