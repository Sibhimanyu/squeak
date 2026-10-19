import { asArray, asRecord, asString, summarize } from "./observers/tail.js";

/**
 * Tools whose call is the agent asking the human something and then stopping
 * until they answer. This is a *question*, not a permission approval: the
 * tool_use is written to the transcript before the prompt appears, so a
 * pending one is readable from a file. (A permission prompt is never written;
 * that stays hook-only — see CLAUDE.md, "Transcripts cannot record an
 * approval prompt".)
 */
export const QUESTION_TOOLS: ReadonlySet<string> = new Set([
  "mcp__conductor__AskUserQuestion",
  "AskUserQuestion",
  "ExitPlanMode",
]);

export const PLAN_REVIEW_DETAIL = "has a plan for you to review";

export function isQuestionTool(name: string | null | undefined): boolean {
  return typeof name === "string" && QUESTION_TOOLS.has(name);
}

/** What a card says for a pending question: the first question plus its option labels. */
export function describeQuestionCall(name: string, input: unknown): string {
  if (name === "ExitPlanMode") {
    return PLAN_REVIEW_DETAIL;
  }
  const first = asRecord(asArray(asRecord(input)?.questions)[0]);
  const question = first ? asString(first.question) : null;
  if (!question) {
    return "has a question for you";
  }
  const labels = asArray(first?.options)
    .map((option) => asString(option) ?? asString(asRecord(option)?.label))
    .filter((label): label is string => label !== null);
  const text = labels.length > 0 ? `${question} [${labels.join(" / ")}]` : question;
  return summarize(text);
}

/**
 * The newest question-tool call in an assistant entry's content blocks, or
 * null. `id` is the tool_use id the answer's tool_result will carry.
 */
export function questionCallIn(content: unknown): { id: string; detail: string } | null {
  const blocks = asArray(content);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = asRecord(blocks[index]);
    if (!block || asString(block.type) !== "tool_use") {
      continue;
    }
    const name = asString(block.name);
    const id = asString(block.id);
    if (name && id && isQuestionTool(name)) {
      return { id, detail: describeQuestionCall(name, block.input) };
    }
  }
  return null;
}

/** Whether a user entry's content answers the tool_use with this id. */
export function answersToolUse(content: unknown, id: string): boolean {
  return asArray(content).some((raw) => {
    const block = asRecord(raw);
    return block !== null && asString(block.type) === "tool_result" && asString(block.tool_use_id) === id;
  });
}
