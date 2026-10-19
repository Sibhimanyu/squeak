import { findPendingQuestion } from "./observers/claude-transcript.js";
import { parseJsonLines, readTailLines } from "./observers/tail.js";
import { parseQuestions, type QuestionPrompt } from "./pending-question.js";

/**
 * The question a Claude session is waiting on, whole, read from its
 * transcript: the same pending `AskUserQuestion` the observer turns into
 * "needs an answer", with every option rather than a 180-character summary.
 * Null when nothing is pending, or for anything that is not a set of options.
 */
export function readPendingQuestion(transcriptPath: string): { toolUseId: string; questions: QuestionPrompt[] } | null {
  const call = findPendingQuestion(parseJsonLines(readTailLines(transcriptPath)));
  if (!call) {
    return null;
  }
  const questions = parseQuestions(call.name, call.input);
  return questions ? { toolUseId: call.id, questions } : null;
}
