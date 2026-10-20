/**
 * Turning an agent's last message into one notification line.
 *
 * What an agent says when it finishes is written for a chat window: headings,
 * bullet lists, bold, backticks, often a leading "Done!" that carries nothing.
 * On a lock screen none of that survives — it arrives as literal `##` and `**`
 * eating the few characters that were worth reading. So the card keeps the
 * sentences and throws the formatting away.
 */

/** Openers that spend a line saying only that the thing that happened happened. */
const FILLER_OPENERS =
  /^(?:done|ok(?:ay)?|sure|got it|all set|all done|finished|complete(?:d)?|here(?:'| i)s(?: the)?(?: summary| what i did)?)\b[\s—:,.!-]*/i;

/**
 * Strip markdown to the words underneath.
 *
 * Deliberately lossy: this is not a renderer, and anything it cannot reduce to
 * prose — a fenced code block, a table — is better dropped than shown as
 * punctuation soup two words wide.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "· ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The sentences a person would read first, within a budget.
 *
 * Clipping mid-sentence reads as truncation and tells the reader they are
 * missing something; stopping at a sentence boundary reads as a summary. So
 * whole sentences are taken while they fit, and only a first sentence that is
 * longer than the whole budget gets cut.
 */
export function summarizeOutcome(text: string | null, maxChars = 170): string | null {
  if (!text) {
    return null;
  }
  const flat = stripMarkdown(text).replace(FILLER_OPENERS, "");
  if (flat.length === 0) {
    return null;
  }
  if (flat.length <= maxChars) {
    return flat;
  }

  const sentences = flat.match(/[^.!?]+[.!?]*\s*/g) ?? [flat];
  let taken = "";
  for (const sentence of sentences) {
    if (taken.length > 0 && (taken + sentence).trim().length > maxChars) {
      break;
    }
    taken += sentence;
    if (taken.length >= maxChars) {
      break;
    }
  }

  const trimmed = taken.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return trimmed;
}
