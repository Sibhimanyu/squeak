import type { PendingAsk } from "./question.js";

/**
 * Answering an agent's question (docs/answering-questions.md): the shapes every surface shares, and the strict
 * parse of an answer. The host that runs the chat validates it against the question as it is pending *now*
 * and delivers it; nothing here talks to a host.
 */

export const ANSWER_MAX_OTHER = 2_000;
export const ANSWER_MAX_NOTE = 2_000;

export interface AnswerEntry {
  question: number;
  picked: string[];
  other?: string;
}
export type PlanAnswer = { approve: true } | { approve: false; note: string };
export interface AnswerInput {
  toolUseId: string;
  answers?: AnswerEntry[];
  plan?: PlanAnswer;
}
export type AnswerResult =
  | { status: "answered"; via: "host" | "conductor" | "stopped-and-sent"; note?: string }
  | { status: "refused"; reason: string };

/** What a client may know before sending: the question, and how it would be delivered. */
export interface PendingAskView {
  toolUseId: string;
  kind: "question" | "plan";
  questions: PendingAsk["questions"];
  plan: string | null;
  /** `stop-and-send` shows the "Squeak will stop the question…" note; `unavailable` means no route. */
  delivery: "direct" | "stop-and-send" | "unknown" | "unavailable";
}

const ANSWER_KEYS = new Set(["toolUseId", "answers", "plan"]);

/** Strict parse of the shape both the control route and the phone command use. Unknown fields are refused. */
export function parseAnswerInput(raw: unknown): { ok: true; input: AnswerInput } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad("Not an answer this Mac understands.");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ANSWER_KEYS.has(key))) {
    return bad("Not an answer this Mac understands.");
  }
  if (typeof record.toolUseId !== "string" || !record.toolUseId || record.toolUseId.length > 200) {
    return bad("Not an answer this Mac understands.");
  }
  const input: AnswerInput = { toolUseId: record.toolUseId };
  if (record.answers !== undefined) {
    if (!Array.isArray(record.answers) || record.answers.length > 8) {
      return bad("Not an answer this Mac understands.");
    }
    const answers: AnswerEntry[] = [];
    for (const item of record.answers) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return bad("Not an answer this Mac understands.");
      }
      const entry = item as Record<string, unknown>;
      if (Object.keys(entry).some((key) => key !== "question" && key !== "picked" && key !== "other")) {
        return bad("Not an answer this Mac understands.");
      }
      if (
        typeof entry.question !== "number" ||
        !Number.isInteger(entry.question) ||
        !Array.isArray(entry.picked) ||
        entry.picked.length > 20 ||
        entry.picked.some((label) => typeof label !== "string") ||
        (entry.other !== undefined && typeof entry.other !== "string")
      ) {
        return bad("Not an answer this Mac understands.");
      }
      answers.push({
        question: entry.question,
        picked: entry.picked as string[],
        ...(entry.other !== undefined ? { other: entry.other } : {}),
      });
    }
    input.answers = answers;
  }
  if (record.plan !== undefined) {
    const plan = record.plan as Record<string, unknown> | null;
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      return bad("Not an answer this Mac understands.");
    }
    const keys = Object.keys(plan);
    if (plan.approve === true && keys.length === 1) {
      input.plan = { approve: true };
    } else if (plan.approve === false && keys.length === 2 && typeof plan.note === "string") {
      input.plan = { approve: false, note: plan.note };
    } else {
      return bad("Not an answer this Mac understands.");
    }
  }
  return { ok: true, input };
}

/** What a host that can answer a chat's questions offers. */
export interface AnswerHost {
  /** The chat's pending question or plan, whole, with how an answer would be delivered; null when nothing waits. */
  pending(sessionId: string): PendingAskView | null;
  answer(sessionId: string, input: AnswerInput): Promise<AnswerResult>;
}

/** The two control routes, ready to spread into `ingress.setControl({ ...answerControl(host), ... })`. */
export function answerControl(service: AnswerHost): {
  question(sessionId: string): PendingAskView | null;
  answer(sessionId: string, body: unknown): Promise<AnswerResult>;
} {
  return {
    question: (id) => service.pending(id),
    async answer(id, body) {
      const parsed = parseAnswerInput(body);
      return parsed.ok ? service.answer(id, parsed.input) : { status: "refused", reason: parsed.reason };
    },
  };
}
