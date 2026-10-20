import { execFileSync } from "node:child_process";

import type { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import { logger } from "../utils/logger.js";
import type { PendingAsk } from "./question.js";

/**
 * Answering an agent's question (docs/answering-questions.md). A pending
 * `AskUserQuestion` or `ExitPlanMode` is answered through Conductor's own API
 * when it can (route 1: `answer-question` / `respond-to-plan`, still 501 in
 * 0.91.1), and otherwise by stopping the waiting turn and sending the answer
 * as the next message (route 3), worded so the agent cannot misread it.
 *
 * Every answer is validated against the question as it is pending *now*, read
 * from the transcript, never against a client's copy; delivery is confirmed
 * from Conductor's own record; and nothing is ever sent twice.
 */

export const ANSWER_MAX_OTHER = 2_000;
export const ANSWER_MAX_NOTE = 2_000;
export const NOT_CONFIRMED = "Not confirmed — check Conductor";
export const NO_RELAY = "Conductor's relay isn't connected";
/** Conductor versions measured to answer 501; anything else is probed once. */
const KNOWN_UNSUPPORTED = ["0.91.1"];
const STOP_SETTLE_MS = 5_000;
const CONFIRM_MS = 8_000;
const POLL_MS = 250;

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
  | { status: "answered"; via: "conductor" | "stopped-and-sent"; note?: string }
  | { status: "refused"; reason: string };

/** What a client may know before sending: the question, and how it would be delivered. */
export interface PendingAskView {
  toolUseId: string;
  kind: "question" | "plan";
  questions: PendingAsk["questions"];
  plan: string | null;
  /** `stop-and-send` shows the "Squeak will stop the question…" note; `unavailable` means no relay. */
  delivery: "direct" | "stop-and-send" | "unknown" | "unavailable";
}

export interface AnswerRelay {
  isReady(): boolean;
  send(args: {
    workspaceId: string;
    sessionId: string;
    text: string;
    mode?: "queue" | "steer";
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  control(args: {
    workspaceId: string;
    sessionId: string;
    route: "answer-question" | "respond-to-plan" | "stop";
    body?: unknown;
  }): Promise<{ ok: true; status: number } | { ok: false; reason: string }>;
}

export interface AnswerServiceDependencies {
  registry: Pick<ConductorRegistryAdapter, "getSessionById" | "listSessionMessages">;
  relay: AnswerRelay | null;
  /** The chat's pending question or plan, read fresh from its transcript. */
  readAsk: (conductorSessionId: string) => PendingAsk | null;
  /** Conductor's CFBundleShortVersionString; null when unreadable. */
  conductorVersion?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  stopSettleMs?: number;
  confirmMs?: number;
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

/** One resolved answer per question, in question order. */
interface Resolved {
  picked: string[];
  other: string | null;
}

/** Check an answer against the pending question. Returns the resolved answers (or plan) or a plain reason. */
export function validateAnswer(
  ask: PendingAsk,
  input: AnswerInput,
): { ok: true; answers: Resolved[]; plan: PlanAnswer | null } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (input.toolUseId !== ask.toolUseId) {
    return bad("That question has moved on. Look at the chat again.");
  }
  if (ask.kind === "plan") {
    if (input.answers !== undefined || !input.plan) {
      return bad("That is a plan to approve, not a question.");
    }
    if (!input.plan.approve) {
      const note = input.plan.note.trim();
      if (!note) {
        return bad("Say what to change before sending it back.");
      }
      if (note.length > ANSWER_MAX_NOTE) {
        return bad(`That note is too long (limit ${ANSWER_MAX_NOTE} characters).`);
      }
      return { ok: true, answers: [], plan: { approve: false, note } };
    }
    return { ok: true, answers: [], plan: { approve: true } };
  }
  if (input.plan !== undefined || !input.answers) {
    return bad("That is a question, not a plan.");
  }
  if (input.answers.length !== ask.questions.length) {
    return bad("Answer every question.");
  }
  const resolved: Resolved[] = [];
  for (let index = 0; index < ask.questions.length; index += 1) {
    const matches = input.answers.filter((entry) => entry.question === index);
    if (matches.length !== 1) {
      return bad("Answer every question, once each.");
    }
    const entry = matches[0]!;
    const question = ask.questions[index]!;
    const labels = new Set(question.options.map((option) => option.label));
    if (new Set(entry.picked).size !== entry.picked.length) {
      return bad("The same option was picked twice.");
    }
    if (entry.picked.some((label) => !labels.has(label))) {
      return bad("One of the options you picked is not in the question.");
    }
    const other = entry.other === undefined ? null : entry.other.trim();
    if (other !== null && !other) {
      return bad("The answer in your own words is empty.");
    }
    if (other !== null && other.length > ANSWER_MAX_OTHER) {
      return bad(`That answer is too long (limit ${ANSWER_MAX_OTHER} characters).`);
    }
    if (question.multiSelect) {
      if (entry.picked.length === 0 && other === null) {
        return bad("Pick at least one option, or say something else.");
      }
    } else if (!((entry.picked.length === 1 && other === null) || (entry.picked.length === 0 && other !== null))) {
      return bad("Pick exactly one option, or say something else.");
    }
    resolved.push({ picked: entry.picked, other });
  }
  return { ok: true, answers: resolved, plan: null };
}

/** Conductor's own body (the desktop UI's `{answers}`): a string per single pick, a list for multi. */
export function conductorAnswersBody(ask: PendingAsk, answers: Resolved[]): { answers: Array<string | string[]> } {
  return {
    answers: answers.map((answer, index) => {
      if (ask.questions[index]!.multiSelect) {
        return [...answer.picked, ...(answer.other !== null ? [answer.other] : [])];
      }
      return answer.other ?? answer.picked[0]!;
    }),
  };
}

/** Route 3's message. Written so a real agent takes it as the answer and does not ask again. */
export function answerMessage(ask: PendingAsk, answers: Resolved[], plan: PlanAnswer | null): string {
  if (ask.kind === "plan") {
    return plan && !plan.approve ? `Keep planning. ${plan.note}` : "I approve your plan. Go ahead.";
  }
  const lines = ask.questions.map((question, index) => {
    const answer = answers[index]!;
    const parts = [...answer.picked, ...(answer.other !== null ? [answer.other] : [])];
    return `"${question.question}": ${parts.join(", ")}`;
  });
  return [
    "This is my answer to the question you just asked (the question was interrupted so I could reply):",
    "",
    ...lines,
    "",
    "Please continue with these answers; don't ask again.",
  ].join("\n");
}

const BLOCKED_STATUSES = new Set(["needs_user_input", "needs_plan_response", "working", "cancelling"]);

export function readConductorVersion(): string | null {
  try {
    const out = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "/Applications/Conductor.app/Contents/Info.plist"],
      { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

export class AnswerService {
  private readonly deps: AnswerServiceDependencies;
  /** `<version>|<route>` pairs that answered 501. Never retried on the same version. */
  private readonly unsupported = new Set<string>();
  private readonly inFlight = new Set<string>();
  private cachedVersion: { value: string | null; at: number } | null = null;

  constructor(deps: AnswerServiceDependencies) {
    this.deps = deps;
    for (const version of KNOWN_UNSUPPORTED) {
      this.unsupported.add(`${version}|answer-question`);
      this.unsupported.add(`${version}|respond-to-plan`);
    }
  }

  private version(): string {
    const now = Date.now();
    if (!this.cachedVersion || now - this.cachedVersion.at > 60_000) {
      let value: string | null;
      try {
        value = (this.deps.conductorVersion ?? readConductorVersion)();
      } catch {
        value = null;
      }
      this.cachedVersion = { value, at: now };
    }
    return this.cachedVersion.value ?? "unknown";
  }

  private routeFor(kind: "question" | "plan"): "answer-question" | "respond-to-plan" {
    return kind === "plan" ? "respond-to-plan" : "answer-question";
  }

  /** The chat's pending question or plan, with how an answer would travel. Null when nothing is pending. */
  pending(conductorSessionId: string): PendingAskView | null {
    const ask = this.deps.readAsk(conductorSessionId);
    if (!ask) {
      return null;
    }
    const delivery = !this.deps.relay?.isReady()
      ? "unavailable"
      : this.unsupported.has(`${this.version()}|${this.routeFor(ask.kind)}`)
        ? "stop-and-send"
        : "unknown";
    return { toolUseId: ask.toolUseId, kind: ask.kind, questions: ask.questions, plan: ask.plan, delivery };
  }

  async answer(conductorSessionId: string, input: AnswerInput): Promise<AnswerResult> {
    const relay = this.deps.relay;
    if (!relay?.isReady()) {
      return { status: "refused", reason: NO_RELAY };
    }
    const session = this.deps.registry.getSessionById(conductorSessionId);
    if (!session) {
      return { status: "refused", reason: "That chat no longer exists in Conductor." };
    }
    if (this.inFlight.has(conductorSessionId)) {
      return { status: "refused", reason: "An answer to this chat is already being delivered." };
    }
    this.inFlight.add(conductorSessionId);
    try {
      return await this.deliver(relay, conductorSessionId, session.workspaceId, input);
    } finally {
      this.inFlight.delete(conductorSessionId);
    }
  }

  private async deliver(
    relay: AnswerRelay,
    sessionId: string,
    workspaceId: string,
    input: AnswerInput,
  ): Promise<AnswerResult> {
    let ask: PendingAsk | null;
    try {
      ask = this.deps.readAsk(sessionId);
    } catch {
      ask = null;
    }
    if (!ask) {
      return { status: "refused", reason: "That question is not waiting for an answer any more." };
    }
    const checked = validateAnswer(ask, input);
    if (!checked.ok) {
      return { status: "refused", reason: checked.reason };
    }

    const route = this.routeFor(ask.kind);
    const key = `${this.version()}|${route}`;

    // Route 1: Conductor's own API, unless this version already said 501.
    if (!this.unsupported.has(key)) {
      const body =
        ask.kind === "plan"
          ? checked.plan!.approve
            ? { approved: true }
            : { approved: false, feedback: checked.plan!.note, feedbackMessageId: crypto.randomUUID() }
          : conductorAnswersBody(ask, checked.answers);
      const res = await relay.control({ workspaceId, sessionId, route, body });
      if (res.ok && res.status === 501) {
        this.unsupported.add(key);
        logger.info("conductor cannot answer through its API on this version; stopping and sending instead", {
          version: this.version(),
          route,
        });
      } else if (!res.ok) {
        // Nothing came back, so it may have been applied.
        const done = await this.confirmAnswered(sessionId, ask.toolUseId);
        return done
          ? { status: "answered", via: "conductor" }
          : { status: "refused", reason: `${NOT_CONFIRMED} (${res.reason})` };
      } else if (res.status < 200 || res.status >= 300) {
        return { status: "refused", reason: `Conductor refused the answer (relay HTTP ${res.status}).` };
      } else {
        const done = await this.confirmAnswered(sessionId, ask.toolUseId);
        return done
          ? { status: "answered", via: "conductor" }
          : { status: "answered", via: "conductor", note: NOT_CONFIRMED };
      }
    }

    // Route 3: stop the waiting turn, then send the answer as a message.
    const text = answerMessage(ask, checked.answers, checked.plan);
    const stop = await relay.control({ workspaceId, sessionId, route: "stop" });
    if (!stop.ok) {
      return { status: "refused", reason: `${NOT_CONFIRMED} (${stop.reason})` };
    }
    if (stop.status < 200 || stop.status >= 300) {
      return {
        status: "refused",
        reason: `Conductor would not stop the question (relay HTTP ${stop.status}). Nothing was sent.`,
      };
    }
    if (!(await this.waitForSettled(sessionId))) {
      return {
        status: "refused",
        reason: "Conductor did not stop the question in time. Nothing was sent; check the chat.",
      };
    }
    const sentAt = new Date().toISOString().slice(0, 19);
    const sent = await relay.send({ workspaceId, sessionId, text, mode: "queue" });
    if (!sent.ok) {
      return {
        status: "refused",
        reason: `The question was stopped but your answer could not be sent (${sent.reason}). Reply in Conductor.`,
      };
    }
    const seen = await this.confirmUserMessage(sessionId, text, sentAt);
    return seen
      ? {
          status: "answered",
          via: "stopped-and-sent",
          note: "Sent as a message after stopping the question.",
        }
      : { status: "answered", via: "stopped-and-sent", note: NOT_CONFIRMED };
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((wait: number) => new Promise((resolve) => setTimeout(resolve, wait))))(ms);
  }

  /** Poll until `check` is true or the budget (counted in polls, so fake sleeps stay finite) runs out. */
  private async until(check: () => boolean, budgetMs: number): Promise<boolean> {
    for (let spent = 0; ; spent += POLL_MS) {
      if (check()) {
        return true;
      }
      if (spent >= budgetMs) {
        return false;
      }
      await this.sleep(POLL_MS);
    }
  }

  private waitForSettled(sessionId: string): Promise<boolean> {
    return this.until(() => {
      const status = this.deps.registry.getSessionById(sessionId)?.status;
      return status !== undefined && !BLOCKED_STATUSES.has(status);
    }, this.deps.stopSettleMs ?? STOP_SETTLE_MS);
  }

  /** The question's tool_result is in Conductor's record, or the transcript no longer waits on it. */
  private confirmAnswered(sessionId: string, toolUseId: string): Promise<boolean> {
    return this.until(() => {
      const rows = this.deps.registry.listSessionMessages(sessionId, 40);
      if (rows.some((row) => row.content.includes("tool_result") && row.content.includes(toolUseId))) {
        return true;
      }
      try {
        return this.deps.readAsk(sessionId)?.toolUseId !== toolUseId;
      } catch {
        return false;
      }
    }, this.deps.confirmMs ?? CONFIRM_MS);
  }

  private confirmUserMessage(sessionId: string, text: string, sinceIso19: string): Promise<boolean> {
    const wanted = text.trim();
    return this.until(
      () =>
        this.deps.registry
          .listSessionMessages(sessionId, 20)
          .some((row) => row.role === "user" && row.content.includes(wanted) && (row.sentAt ?? "") >= sinceIso19),
      this.deps.confirmMs ?? CONFIRM_MS,
    );
  }
}

/** The two control routes, ready to spread into `ingress.setControl({ ...answerControl(service), ... })`. */
export function answerControl(service: AnswerService): {
  question(conductorSessionId: string): PendingAskView | null;
  answer(conductorSessionId: string, body: unknown): Promise<AnswerResult>;
} {
  return {
    question: (id) => service.pending(id),
    async answer(id, body) {
      const parsed = parseAnswerInput(body);
      return parsed.ok ? service.answer(id, parsed.input) : { status: "refused", reason: parsed.reason };
    },
  };
}
