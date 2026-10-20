import { parseAnswerInput, type AnswerInput, type AnswerResult } from "./answer.js";

/**
 * The phone's `answer` command, after RemoteBridge has run every envelope check
 * (paired unrevoked device, signature, expiry, nonce). This is what is left:
 * the exact shape (unknown fields refused), a per-device rate limit, and the
 * hand-off to the same `AnswerService` the Mac's control route uses, which
 * validates against the question as it is pending now.
 *
 *   { v: 1, kind: "answer", sessionId, toolUseId,
 *     answers?: [{ question, picked, other? }], plan?: { approve: true } | { approve: false, note },
 *     nonce, expiresAt }
 */
export interface AnswerCommand {
  v: 1;
  kind: "answer";
  sessionId: string;
  toolUseId: string;
  answers?: AnswerInput["answers"];
  plan?: AnswerInput["plan"];
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** One answer per device in this window, like starting a chat. */
export const ANSWER_MIN_GAP_MS = 15_000;

export interface Answerer {
  answer(conductorSessionId: string, input: AnswerInput): Promise<AnswerResult>;
}

const COMMAND_KEYS = new Set(["v", "kind", "sessionId", "toolUseId", "answers", "plan", "nonce", "expiresAt"]);
const SESSION_ID = /^[A-Za-z0-9_-]{1,120}$/;

export class AnswerRateLimit {
  private readonly last = new Map<string, number>();

  /** True (and the window starts) when this device may answer now. */
  take(deviceId: string, now: number): boolean {
    const previous = this.last.get(deviceId);
    if (previous !== undefined && now - previous < ANSWER_MIN_GAP_MS) {
      return false;
    }
    this.last.set(deviceId, now);
    return true;
  }
}

export async function runAnswerCommand(
  command: unknown,
  context: { answerer: Answerer | null; limit: AnswerRateLimit; deviceId: string; now: number },
): Promise<AnswerResult> {
  const refuse = (reason: string): AnswerResult => ({ status: "refused", reason });
  if (!context.answerer) {
    return refuse("This Mac can't answer questions from a phone.");
  }
  const record = command as Record<string, unknown> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.v !== 1 ||
    Object.keys(record).some((key) => !COMMAND_KEYS.has(key)) ||
    typeof record.sessionId !== "string" ||
    !SESSION_ID.test(record.sessionId)
  ) {
    return refuse("Not an answer this Mac understands.");
  }
  const parsed = parseAnswerInput({
    toolUseId: record.toolUseId,
    ...(record.answers !== undefined ? { answers: record.answers } : {}),
    ...(record.plan !== undefined ? { plan: record.plan } : {}),
  });
  if (!parsed.ok) {
    return refuse(parsed.reason);
  }
  if (!context.limit.take(context.deviceId, context.now)) {
    return refuse("You just answered a question. Wait a few seconds and try again.");
  }
  try {
    return await context.answerer.answer(record.sessionId, parsed.input);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "The answer could not be delivered.");
  }
}
