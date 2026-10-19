import { findPendingQuestion } from "./observers/claude-transcript.js";
import { asRecord, asString, parseJsonLines, readTailLines } from "./observers/tail.js";
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

/** What an agent is waiting on you for, whole: a set of questions, or a plan to approve. */
export interface PendingAsk {
  toolUseId: string;
  kind: "question" | "plan";
  /** Empty for a plan. */
  questions: QuestionPrompt[];
  /** The plan's text (ExitPlanMode's `plan` input), for kind "plan". */
  plan: string | null;
}

const PLAN_MAX_CHARS = 20_000;

/**
 * The pending question *or plan* of a session, read from its transcript. The
 * answer route validates against this, so it is read fresh for every answer.
 */
export function readPendingAsk(transcriptPath: string): PendingAsk | null {
  const call = findPendingQuestion(parseJsonLines(readTailLines(transcriptPath)));
  if (!call) {
    return null;
  }
  if (call.name === "ExitPlanMode") {
    const plan = asString(asRecord(call.input)?.plan);
    return {
      toolUseId: call.id,
      kind: "plan",
      questions: [],
      plan: plan ? (plan.length > PLAN_MAX_CHARS ? `${plan.slice(0, PLAN_MAX_CHARS - 1)}…` : plan) : null,
    };
  }
  const questions = parseQuestions(call.name, call.input);
  return questions ? { toolUseId: call.id, kind: "question", questions, plan: null } : null;
}
