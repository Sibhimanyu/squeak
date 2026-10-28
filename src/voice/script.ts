import { summarizeOutcome, stripMarkdown } from "../fleet/card-text.js";
import { parseChoices, type ChoiceOption } from "../fleet/choices.js";
import { cardLabel } from "../fleet/radar.js";
import { shouldPush } from "../fleet/attention.js";
import type { AttentionItem, AttentionKind } from "../fleet/types.js";

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

export interface CallScript {
  /** Said first, before anything can be answered. */
  greeting: string;
  /** Said once the PIN (if any) is right: the question and what each key does. */
  question: string;
  /** The options on the keypad; empty when there is nothing to press. */
  options: ChoiceOption[];
}

function say(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, " ").trim();
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
export function composeScript(item: AttentionItem, lastText: string | null, canAnswer: boolean): CallScript {
  const label = say(cardLabel(item.session));
  const choices = item.kind === "asked_question" || item.kind === "blocked_question" ? parseChoices(lastText) : null;
  const options = (choices?.options ?? []).slice(0, MAX_KEYPAD_OPTIONS);
  const asked = choices?.question ? say(choices.question) : summarizeOutcome(lastText, 240);
  const greeting = `Squeak. ${label} ${describe(item.kind)}.`;

  const parts: string[] = [];
  if (asked) parts.push(asked);
  if (canAnswer && options.length > 0) {
    options.forEach((option, index) => {
      const recommended = choices?.recommended === option.letter ? ", recommended" : "";
      parts.push(`Press ${index + 1} for ${say(option.title)}${recommended}.`);
    });
  } else if (item.kind === "blocked_approval") {
    parts.push("Approve it from the Mac or the phone app.");
  } else {
    parts.push("Open Squeak to answer.");
  }
  parts.push("Press star to hear this again, or hash to hang up.");
  return { greeting, question: parts.join(" "), options: canAnswer ? options : [] };
}

export type DialogAction =
  | { type: "play"; text: string }
  | { type: "answer"; letter: string }
  | { type: "hangup"; text?: string };

/** Wrong PINs allowed in one call. */
export const MAX_PIN_TRIES = 2;
const MAX_PIN_LENGTH = 12;

/**
 * The keypad, as a small state machine. Answering needs the PIN: a call goes to whoever picks the
 * phone up, and an answer can start an agent that may run with permissions off. With no PIN set
 * nothing can be answered by key, only heard.
 */
export class CallDialog {
  private stage: "greeting" | "pin" | "question" | "done" = "greeting";
  private entered = "";
  private tries = 0;

  constructor(
    private readonly script: CallScript,
    private readonly pin: string | null,
  ) {}

  private get canAnswer(): boolean {
    return this.script.options.length > 0 && this.pin !== null;
  }

  start(): DialogAction[] {
    if (this.canAnswer) {
      this.stage = "pin";
      return [{ type: "play", text: `${this.script.greeting} To answer, enter your PIN, then hash.` }];
    }
    this.stage = "question";
    return [{ type: "play", text: `${this.script.greeting} ${this.script.question}` }];
  }

  key(digit: string): DialogAction[] {
    switch (this.stage) {
      case "pin":
        return this.pinKey(digit);
      case "question":
        return this.questionKey(digit);
      default:
        return [];
    }
  }

  private pinKey(digit: string): DialogAction[] {
    if (digit === "*") {
      this.entered = "";
      return [];
    }
    if (digit !== "#") {
      if (/^\d$/.test(digit) && this.entered.length < MAX_PIN_LENGTH) this.entered += digit;
      return [];
    }
    const ok = this.pin !== null && this.entered === this.pin;
    this.entered = "";
    if (ok) {
      this.stage = "question";
      return [{ type: "play", text: this.script.question }];
    }
    this.tries += 1;
    if (this.tries >= MAX_PIN_TRIES) {
      this.stage = "done";
      return [{ type: "hangup", text: "That PIN is not right. Goodbye." }];
    }
    return [{ type: "play", text: "That PIN is not right. Try again, then hash." }];
  }

  private questionKey(digit: string): DialogAction[] {
    if (digit === "#") {
      this.stage = "done";
      return [{ type: "hangup" }];
    }
    if (digit === "*") {
      return [{ type: "play", text: this.script.question }];
    }
    const index = /^[1-8]$/.test(digit) ? Number(digit) - 1 : -1;
    const option = this.canAnswer ? this.script.options[index] : undefined;
    if (!option) {
      return [];
    }
    this.stage = "done";
    return [
      { type: "answer", letter: option.letter },
      { type: "hangup", text: `Sent ${option.letter}. Goodbye.` },
    ];
  }
}
