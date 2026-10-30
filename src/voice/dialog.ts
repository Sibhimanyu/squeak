import type { ChoiceOption } from "../fleet/choices.js";

/**
 * The keypad half of a call, with no dependency on the fleet: the Home Assistant gateway bundles
 * this file and `baresip-line.ts`, and nothing else of Squeak.
 */

/** What a call says and listens for (composed on the Mac by `script.ts`). */
export interface CallScript {
  /** Said first, before anything can be answered. */
  greeting: string;
  /** Said once the PIN (if any) is right: the question and what each key does. */
  question: string;
  /** The options on the keypad; empty when there is nothing to press. */
  options: ChoiceOption[];
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
 * nothing can be answered by key, only heard; with the PIN turned off on purpose, keys answer straight away.
 */
export class CallDialog {
  private stage: "greeting" | "pin" | "question" | "done" = "greeting";
  private entered = "";
  private tries = 0;

  constructor(
    private readonly script: CallScript,
    private readonly pin: string | null,
    /** False when the person turned the pin off: keys answer at once, with nothing to enter first. */
    private readonly pinRequired = true,
  ) {}

  private get canAnswer(): boolean {
    return this.script.options.length > 0 && (this.pin !== null || !this.pinRequired);
  }

  /** A pin is asked for before the question. */
  private get asksPin(): boolean {
    return this.canAnswer && this.pin !== null && this.pinRequired;
  }

  /**
   * Everything this dialog may say, so the voice can be made while the phone is still ringing: a prompt made
   * after pick-up is silence on the line.
   */
  prompts(): string[] {
    const out = this.asksPin
      ? [
          `${this.script.greeting} Please enter your PIN, then press hash.`,
          this.script.question,
          "That PIN is not right. Try again, then press hash.",
          "That PIN is not right. Goodbye.",
        ]
      : [`${this.script.greeting} ${this.script.question}`];
    for (const option of this.script.options) out.push(`Sent ${option.letter}. Goodbye.`);
    return out;
  }

  start(): DialogAction[] {
    if (this.asksPin) {
      this.stage = "pin";
      return [{ type: "play", text: `${this.script.greeting} Please enter your PIN, then press hash.` }];
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
    return [{ type: "play", text: "That PIN is not right. Try again, then press hash." }];
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
