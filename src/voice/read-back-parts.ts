import { newChatReadBackParts as newChatPieces, readBackParts } from "./inbound-flow.js";
import { groupLaterSentences, splitSentences } from "./natural-cache.js";

/**
 * A read-back cut for streaming (`audioFollows` on a `transcript`): a fixed head that is made ahead and cached, the
 * person's words in parts of at least ~80 characters, and a fixed tail that is made ahead too. Joined with spaces (and
 * with whitespace folded) the parts say exactly what the add-on's own read-back says (`readBackSentence`,
 * `newChatReadBack`), which is how it knows they are the same words. Empty when the words have no sentence to speak.
 */
function cut(head: string, words: string, tail: string): string[] {
  const middle = groupLaterSentences(splitSentences(`${words.replace(/[.!?\s]+$/, "")}.`)).map((group) =>
    group.join(" "),
  );
  return middle.length === 0 ? [] : [head, ...middle, tail];
}

/** The memo read-back ("I heard: <words>. Press 1 to send it to ...") as clips to make. */
export function memoReadBackSpeech(text: string, label: string, ask = false): string[] {
  return cut("I heard:", text, readBackParts("", label, ask).tail);
}

/** The new chat's read-back ("I'll start a new chat in X with Y: <words>. Say yes to start it, or no."). */
export function newChatReadBackSpeech(text: string, label: string, model: string | undefined): string[] {
  const { head, tail } = newChatPieces(label, model);
  return cut(head, text, tail);
}

/** The fixed parts of the memo read-back for these chats: made ahead so a call finds them in the cache. */
export function fixedMemoReadBackSpeech(labels: readonly string[], ask = false): string[] {
  return ["I heard:", ...new Set(labels.map((label) => readBackParts("", label, ask).tail))];
}

/** The fixed parts of the new chat read-back for these workspaces, with the model's spoken name. */
export function fixedNewChatReadBackSpeech(labels: readonly string[], model: string | undefined): string[] {
  const out = new Set<string>();
  for (const label of labels) {
    const { head, tail } = newChatPieces(label, model);
    out.add(head);
    out.add(tail);
  }
  return [...out];
}
