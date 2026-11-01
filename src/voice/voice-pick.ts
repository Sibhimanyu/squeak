/**
 * Answering a menu by voice (add-on 0.20.0). The add-on says "Which workspace? squeak, or motion graphics skill?", records a
 * few seconds and sends it up as a `pick`; the Mac transcribes it and matches it here, deterministically (no model), against
 * exactly the options that menu offered. A pick only ever SELECTS (a workspace, a chat, the new-chat entry): it never sends,
 * starts or confirms anything. No match, or two equally good ones, is no choice, and the add-on asks again.
 */

export type PickAction = "new" | "back" | "repeat" | "hangup" | "other";

export interface PickOption {
  /** The digit that picks it on the keypad (a workspace's or a chat's `n`). */
  n: number;
  label: string;
}

export interface PickMenu {
  options: PickOption[];
  /** The spoken extras this menu offers beside its options. "repeat" and "hangup" are always allowed. */
  extras: PickAction[];
}

export interface PickResult {
  choice?: number;
  action?: PickAction;
}

/** Which menu a `pick` answers: the workspaces, the chats outside them, or one workspace's chats (`workspace:<n>`). */
export const PICK_MENU = /^(?:workspaces|chats|workspace:[1-9])$/;

/** The plain counting words: "one" among them is not an ordinal. */
const CARDINAL = new Set(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]);

/** Words that mean the next one is a number, not a filler. */
const NUMBER_CUE = new Set(["number", "option", "press", "choice", "digit", "pick", "choose"]);

const NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
};

/** Words that carry no name: asking for something, not naming it. */
const FILLER = new Set(
  (
    "a an the and or of in on at to for with from please um uh er hmm okay ok yeah yes i id ill im ive me my we lets let " +
    "like want wanna go goto open pick choose select take say its it that this those these one ones number option " +
    "chat chats workspace workspaces thanks thank you would could can just be is are called named about"
  ).split(" "),
);

/** The words as a person said them: lower case, no punctuation, digits kept, `'` dropped. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** The number a word names ("two", "second", "2"), or null. */
function numberOf(word: string): number | null {
  if (/^\d$/.test(word)) return Number(word);
  return NUMBERS[word] ?? null;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** Whether a heard word is a label's word: the same, a misheard near miss of a longer one, or the start of a long one. */
function sameWord(heard: string, label: string): boolean {
  if (heard === label) return true;
  if (heard.length >= 4 && label.length >= 5 && label.startsWith(heard)) return true;
  const allowed = label.length >= 8 ? 2 : label.length >= 5 ? 1 : 0;
  return allowed > 0 && heard.length >= 4 && editDistance(heard, label) <= allowed;
}

/** A label's own words: names, with the fillers and numbers (said as ordinals) left out. */
const nameWords = (label: string): string[] =>
  words(label).filter((word) => !FILLER.has(word) && numberOf(word) === null);

const EXTRAS: Array<{ action: PickAction; pattern: RegExp }> = [
  {
    action: "new",
    pattern: /\b(?:new chat|a new one|new one|something new|start (?:a )?(?:new )?(?:chat|one)|a new chat)\b/,
  },
  { action: "back", pattern: /\b(?:go back|back|previous|one back)\b/ },
  { action: "repeat", pattern: /\b(?:repeat|say (?:that |it )?again|again|once more|come again|pardon|what)\b/ },
  {
    action: "hangup",
    pattern: /\b(?:hang up|hangup|goodbye|good bye|bye|nothing|nevermind|never mind|cancel|thats all|stop|end call)\b/,
  },
  { action: "other", pattern: /\b(?:other|others|another|something else|someone else|different)\b/ },
];

/** The longest an answer can be and still be a pick: more is someone talking about something else. */
const MAX_WORDS = 14;

/**
 * What a spoken answer picks from `menu`: a number or ordinal ("two", "the second one", "number three"), a name (any
 * words of the label, so "telegram" or "the cliq one" work when exactly one label has them), or one of the menu's
 * extras ("new chat", "go back", "say that again", "hang up"). Nothing, or a tie, or two different signals, is `{}`.
 */
export function matchPick(heard: string, menu: PickMenu): PickResult {
  const spoken = words(heard);
  if (spoken.length === 0 || spoken.length > MAX_WORDS) return {};
  const text = spoken.join(" ");
  const signals: PickResult[] = [];

  // The menu's extras that were said, among the ones it offers.
  const offered = new Set<PickAction>([...menu.extras, "repeat", "hangup"]);
  for (const { action, pattern } of EXTRAS) {
    if (offered.has(action) && pattern.test(text)) signals.push({ action });
  }

  // Numbers: one distinct number that is an option is a pick; a number that is not on offer picks nothing. "The second
  // one" has a plain "one" after the ordinal, which is not a second number.
  const ordinal = spoken.some((word) => numberOf(word) !== null && !/^\d$/.test(word) && !CARDINAL.has(word));
  const named = spoken.some((word) => !FILLER.has(word) && numberOf(word) === null);
  const said = new Set(
    spoken
      .filter((word, index) => {
        if (word !== "one" && word !== "ones") return true;
        // A trailing "one" ("the squeak one", "a new one", "the second one") is not the number; "number one" is.
        if (NUMBER_CUE.has(spoken[index - 1] ?? "")) return true;
        return !ordinal && !named;
      })
      .map(numberOf)
      .filter((n): n is number => n !== null),
  );
  const numbered = [...said].filter((n) => menu.options.some((option) => option.n === n));
  if (said.size > 0 && numbered.length === 1) signals.push({ choice: numbered[0]! });
  const numberConflict = said.size > 1 || (said.size === 1 && numbered.length === 0);

  // Names: how many of the heard words each label has; exactly one best label is a pick, unless another label has heard
  // words the best one lacks (they named two things: "squeak or motion graphics").
  const heardNames = spoken.filter((word) => !FILLER.has(word) && numberOf(word) === null);
  if (heardNames.length > 0) {
    const scored = menu.options.map((option) => {
      const label = nameWords(option.label);
      const hits = new Set(
        heardNames.flatMap((word, index) => (label.some((own) => sameWord(word, own)) ? [index] : [])),
      );
      return { n: option.n, hits };
    });
    const best = Math.max(...scored.map((entry) => entry.hits.size));
    const top = scored.filter((entry) => entry.hits.size === best);
    if (best > 0) {
      if (top.length > 1) return {};
      const winner = top[0]!;
      const rival = scored.some(
        (entry) => entry !== winner && entry.hits.size > 0 && [...entry.hits].some((index) => !winner.hits.has(index)),
      );
      if (rival) return {};
      // Words that name nothing on this menu may be noise ("um", a misheard word), but not most of the answer.
      if (best >= heardNames.length - best) signals.push({ choice: winner.n });
    }
  }

  if (numberConflict && signals.length === 0) return {};
  if (signals.length === 0) return {};
  const unique = new Map(signals.map((signal) => [JSON.stringify(signal), signal]));
  if (unique.size === 1) return [...unique.values()][0]!;
  // A number and a name that point the same way are one answer; anything else disagrees.
  const choices = new Set(signals.filter((signal) => signal.choice !== undefined).map((signal) => signal.choice));
  const actions = signals.filter((signal) => signal.action !== undefined);
  if (choices.size === 1 && actions.length === 0) return { choice: [...choices][0]! };
  return {};
}

/** "a", "a or b", "a, b, or c": how a menu names what it offers. */
export function joinOptions(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

/** The hint said once, on the first menu of a call. */
export const PICK_HINT = "You can also press a number.";

/** A menu spoken as a question; `names` are what it offers, in order, the extras ("a new chat") last. */
export const pickQuestion = (question: string, names: readonly string[]): string =>
  `${question} ${joinOptions(names)}?`;

/** Said when an answer was not understood: the options again, shorter. */
export const pickMiss = (names: readonly string[]): string => `Sorry, which one? ${joinOptions(names)}?`;

/** What a menu of a published list offers, in the order it is spoken. */
export interface PickMenuSpec extends PickMenu {
  /** "Which workspace?", "Which chat in squeak?": the question the menu opens with. */
  question: string;
  /** What it lists, in order: the options' labels, then the extras it names ("other chats", "a new chat"). */
  names: string[];
}

/** The lists a menu is made from: a published directory, or just the parts a menu needs. */
export interface PickDirectory {
  items: Array<{ n: number; label: string }>;
  workspaces?: Array<{ n: number; label: string; chats: Array<{ n: number; label: string }>; newChat?: number }>;
}

/** The menu `name` ("workspaces", "chats" or "workspace:<n>") of `directory`, or null when it has no such menu. */
export function pickMenuSpec(directory: PickDirectory, name: string): PickMenuSpec | null {
  const workspaces = directory.workspaces ?? [];
  if (name === "workspaces") {
    if (workspaces.length === 0) return null;
    const other = directory.items.length > 0;
    const options = workspaces.map(({ n, label }) => ({ n, label }));
    return {
      question: "Which workspace?",
      options,
      extras: other ? ["other"] : [],
      names: [...options.map((option) => option.label), ...(other ? ["other chats"] : [])],
    };
  }
  if (name === "chats") {
    const options = directory.items.map(({ n, label }) => ({ n, label }));
    return {
      question: "Which chat?",
      options,
      extras: workspaces.length > 0 ? ["back"] : [],
      names: options.map((option) => option.label),
    };
  }
  const workspace = /^workspace:([1-9])$/.exec(name);
  if (!workspace) return null;
  const found = workspaces.find((candidate) => candidate.n === Number(workspace[1]));
  if (!found) return null;
  const options = found.chats.map(({ n, label }) => ({ n, label }));
  return {
    question: `Which chat in ${found.label}?`,
    options,
    extras: [...(found.newChat ? (["new"] as const) : []), "back"],
    names: [...options.map((option) => option.label), ...(found.newChat ? ["a new chat"] : [])],
  };
}
