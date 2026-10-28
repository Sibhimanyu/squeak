import { summarizeOutcome, stripMarkdown } from "../fleet/card-text.js";
import { parseChoices } from "../fleet/choices.js";
import { cardLabel } from "../fleet/radar.js";
import { shouldPush } from "../fleet/attention.js";
import type { AttentionItem, AttentionKind } from "../fleet/types.js";
import type { CallScript } from "./dialog.js";

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
