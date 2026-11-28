import { stripMarkdown } from "../fleet/card-text.js";
import { parseChoices } from "../fleet/choices.js";

import type { TimelineLog } from "./timeline-log.js";
import type { TimelineEvent } from "./timeline.js";

/**
 * The room's turns, derived from each chat's timeline (no source of truth of their own): a turn is one
 * `turn.started` (sent from the room, not an agent-run one) to its `turn.ended`, with the reply the agent closed it with.
 */

export const TURN_TEXT_MAX = 200;
/** How far back a chat's turns are read (the page window is 24 h; the extra day finds the options a first turn answers). */
export const TURN_READ_MS = 48 * 3_600_000;
const KEEP_REPLY_CHARS = 8000;
const KEEP_TURNS = 300;

export interface RoomTurn {
  id: string;
  sessionId: string;
  /** The duck that worked it (its older sessions' turns are still its own). */
  duckId?: string;
  threadTitle: string;
  agent: string;
  startedAt: number;
  endedAt?: number;
  outcome?: "finished" | "stopped" | "error";
  prompt: string;
  author: { kind: "person"; name: string; me: boolean };
  /** The prompt picks one of the previous turn's options: `letter` is its letter (or number), `option` its text. */
  answer?: { letter: string; question: string; option?: string };
  outcomeText?: string;
  durationMs?: number;
  filesChanged?: number;
  intent?: string;
  progress?: { current: number; total: number };
  /** Subagents this turn started (Agent/Task tool calls); absent when none. */
  ducklings?: RoomDucklings;
}

export interface RoomDucklings {
  count: number;
  done: number;
  items?: Array<{ label: string; state: "running" | "done" | "failed" }>;
}

export interface RoomProgress {
  current: number;
  total: number;
  label?: string;
}

export interface RoomAsk {
  question: string;
  options: Array<{ letter: string; text: string; recommended: boolean }>;
  /**
   * Set when the Duck asked with its question tool and is waiting on that very request: answering it (here or in the
   * chat) is `POST /native/requests/:id` with `answers` of `{ [question]: option text }`, and either settles it. Unset
   * for a question asked in a reply's words: its answer is a new message to the chat.
   */
  requestId?: string;
}

/** What a chat's cache keeps of one turn. */
export interface TurnBase {
  turnId: string;
  startedAt: number;
  startSeq: number;
  endedAt?: number;
  outcome?: "finished" | "stopped" | "error";
  prompt: string;
  /** Started from the pond's room; only these turns are served to it. */
  room?: true;
  authorName?: string;
  /** The turn's closing reply (full text, capped), the agent's own words. */
  reply?: string;
  /** The turn's earlier assistant texts (newest last, the final one included): where a pick looks when the closing reply has no options. */
  texts?: string[];
  answer?: { letter: string; question: string; option?: string };
}

interface ChatTurns {
  seq: number;
  /** Non-agent-run turns, oldest first. */
  turns: TurnBase[];
  byId: Map<string, TurnBase>;
  /** Replies seen per turn until it ends: the last one, or the one `turn.ended` names. */
  replies: Map<string, Array<{ id: string; text: string }>>;
  /** Turns the agent ran by itself: their replies and ends are not ours. */
  auto: Set<string>;
}

export const oneLine = (text: string, max = TURN_TEXT_MAX): string => {
  const first =
    text
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
      .replace(/\s+/g, " ") ?? "";
  const chars = [...first];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : first;
};

/** The first sentence of the first paragraph, markdown stripped, at most 200 characters. */
export function firstSentence(markdown: string): string {
  const paragraph = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((p) => stripMarkdown(p))
    .find((p) => p);
  if (!paragraph) return "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
  const chars = [...sentence];
  return chars.length > TURN_TEXT_MAX ? `${chars.slice(0, TURN_TEXT_MAX - 1).join("")}…` : sentence;
}

/** A prompt that is just one option's letter ("B", "b)", "(C)"). */
export function answerLetter(prompt: string): string | null {
  const m = /^\(?([A-Ha-h])[).:]?$/.exec(prompt.trim());
  return m ? m[1]!.toUpperCase() : null;
}

const PICK_VERB =
  "(?:option|choice|go with|let'?s go with|i'?ll go with|i'?ll take|i'?d go with|take|pick|choose|i choose|i pick)";
const PICK_TAIL = "(?:\\s*,?\\s*(?:please|pls|thanks|thank you))?";

/**
 * A prompt that is only a pick of one option: "A", "a.", "A)", "(b)", "option A", "go with A", "B please", or a number for
 * a numbered list ("1", "2.", "option 2"). Anything with more words is a message, not a pick.
 */
export function answerChoice(prompt: string): { key: string; kind: "letter" | "number" } | null {
  const bare = prompt.trim().toLowerCase();
  const forms = [
    new RegExp(`^\\(?([a-h])[).:]?${PICK_TAIL}[.!]?$`),
    new RegExp(`^${PICK_VERB}\\s+(?:option\\s+)?\\(?([a-h])\\)?${PICK_TAIL}[.!]?$`),
  ];
  for (const f of forms) {
    const m = f.exec(bare);
    if (m) return { key: m[1]!.toUpperCase(), kind: "letter" };
  }
  const nums = [
    new RegExp(`^\\(?(\\d{1,2})[).:]?${PICK_TAIL}[.!]?$`),
    new RegExp(`^${PICK_VERB}\\s+(?:option\\s+|number\\s+)?\\(?(\\d{1,2})\\)?${PICK_TAIL}[.!]?$`),
  ];
  for (const f of nums) {
    const m = f.exec(bare);
    if (m) return { key: String(Number(m[1])), kind: "number" };
  }
  return null;
}

const NUMBERED_LINE = /^(?:[-*+]\s+)?(?:\*\*|__)?\(?(\d{1,2})[).:](?:\*\*|__)?\s+(.+)$/;

/**
 * The numbered options of a reply that asks something: consecutive `1) ...` / `2. ...` lines counting up from 1, in a
 * message with a question mark in it. A numbered list of what was done ("1. Ran the tests") has no question and is not read.
 */
export function numberedAskOf(text: string | undefined): RoomAsk | null {
  if (!text) return null;
  const lines = text.replace(/```[\s\S]*?```/g, "").split("\n");
  const question = [...lines].reverse().find((l) => /\?\s*(?:\*\*|__)?$/.test(l.trim()) && l.trim().length > 1);
  if (!question) return null;
  let best: RoomAsk["options"] = [];
  let run: RoomAsk["options"] = [];
  for (const raw of lines) {
    const m = NUMBERED_LINE.exec(raw.trim());
    if (m && Number(m[1]) === run.length + 1) {
      run.push({ letter: String(Number(m[1])), text: oneLine(stripMarkdown(m[2]!), 70), recommended: false });
    } else if (m && Number(m[1]) === 1) {
      run = [{ letter: "1", text: oneLine(stripMarkdown(m[2]!), 70), recommended: false }];
    } else if (raw.trim() && !/^\s{2,}\S/.test(raw) && !m) {
      if (run.length >= 2 && run.length >= best.length) best = run;
      run = [];
    }
  }
  if (run.length >= 2 && run.length >= best.length) best = run;
  if (best.length < 2) return null;
  return { question: stripMarkdown(question.trim()) || "Needs your answer", options: best };
}

/** The option a pick names in one text: lettered options, or a numbered list that asks. Never a guess. */
function optionIn(
  text: string | undefined,
  choice: { key: string; kind: "letter" | "number" },
): { ask: RoomAsk; text: string } | null {
  const ask = choice.kind === "letter" ? askOf(text) : numberedAskOf(text);
  const hit = ask?.options.find((o) => o.letter === choice.key);
  return ask && hit ? { ask, text: hit.text } : null;
}

/** What a prompt answers: the closing reply of the previous turn first, then its earlier assistant texts, newest first. */
export function answerFor(
  prompt: string,
  before: Pick<TurnBase, "reply" | "texts"> | undefined,
): TurnBase["answer"] | undefined {
  const choice = answerChoice(prompt);
  if (!choice || !before) return undefined;
  const sources = [before.reply, ...[...(before.texts ?? [])].reverse()];
  for (const src of sources) {
    const hit = optionIn(src, choice);
    if (hit) {
      return { letter: choice.key, question: oneLine(hit.ask.question), ...(hit.text ? { option: hit.text } : {}) };
    }
  }
  return undefined;
}

/** The options a reply offers, as the room carries them. */
export function askOf(text: string | undefined): RoomAsk | null {
  const parsed = parseChoices(text ?? null);
  if (!parsed) return null;
  return {
    question: parsed.question ?? "Needs your answer",
    options: parsed.options.map((o) => ({
      letter: o.letter,
      text: o.title,
      recommended: o.letter === parsed.recommended,
    })),
  };
}

/** Per-chat turn state, kept current from the timeline log by seq (only new events are read). */
export class TurnReader {
  private readonly chats = new Map<string, ChatTurns>();

  constructor(
    private readonly log: TimelineLog,
    private readonly now: () => number,
  ) {}

  /** The chat's non-agent-run turns, oldest first, current as of the log. */
  turns(sessionId: string): TurnBase[] {
    let c = this.chats.get(sessionId);
    const head = this.log.peekSeq(sessionId);
    if (c && c.seq === head) return c.turns;
    const fresh = !c;
    if (!c) {
      c = { seq: 0, turns: [], byId: new Map(), replies: new Map(), auto: new Set() };
      this.chats.set(sessionId, c);
    }
    const events = fresh
      ? this.log.roomEvents(sessionId, { sinceIso: new Date(this.now() - TURN_READ_MS).toISOString() })
      : this.log.roomEvents(sessionId, { afterSeq: c.seq });
    for (const e of events) this.apply(c, e);
    c.seq = head;
    if (c.turns.length > KEEP_TURNS) {
      for (const t of c.turns.splice(0, c.turns.length - KEEP_TURNS)) c.byId.delete(t.turnId);
    }
    return c.turns;
  }

  private apply(c: ChatTurns, e: TimelineEvent): void {
    if (e.type === "turn.started") {
      if (e.auto) {
        c.auto.add(e.turnId);
        return;
      }
      if (c.byId.has(e.turnId)) return;
      const at = Date.parse(e.at);
      const base: TurnBase = {
        turnId: e.turnId,
        startedAt: Number.isFinite(at) ? at : this.now(),
        startSeq: e.seq,
        prompt: oneLine(e.text) || "Message",
        ...(e.room ? { room: true as const } : {}),
        ...(e.author ? { authorName: e.author.name } : {}),
      };
      if (answerChoice(e.text)) {
        const before = [...c.turns].reverse().find((t) => t.endedAt !== undefined || t.reply !== undefined);
        const answer = answerFor(e.text, before);
        if (answer) base.answer = answer;
      }
      c.turns.push(base);
      c.byId.set(e.turnId, base);
    } else if (e.type === "reply.done") {
      const t = c.byId.get(e.turnId);
      if (!t || t.endedAt !== undefined) return;
      const list = c.replies.get(e.turnId) ?? [];
      list.push({ id: e.messageId, text: e.text.slice(0, KEEP_REPLY_CHARS) });
      if (list.length > 4) list.shift();
      c.replies.set(e.turnId, list);
      t.reply = list[list.length - 1]!.text;
    } else if (e.type === "turn.ended") {
      const t = c.byId.get(e.turnId);
      if (!t) return;
      const at = Date.parse(e.at);
      t.endedAt = Number.isFinite(at) ? at : this.now();
      t.outcome = e.outcome === "done" ? "finished" : e.outcome === "stopped" ? "stopped" : "error";
      const list = c.replies.get(e.turnId);
      const named = e.replyMessageId ? list?.find((r) => r.id === e.replyMessageId) : undefined;
      const final = named ?? list?.[list.length - 1];
      if (final) t.reply = final.text;
      if (list?.length) t.texts = list.map((r) => r.text);
      c.replies.delete(e.turnId);
    }
  }

  drop(sessionId: string): void {
    this.chats.delete(sessionId);
  }
}

/**
 * The question a Duck is waiting on through its question tool (AskUserQuestion), as the Room carries it. One question
 * with options is answerable from the Room; several questions, or one that takes several answers, show the first
 * question and send the person to the chat. null when the request holds no question.
 */
export function askOfRequest(requestId: string, payload: unknown): RoomAsk | null {
  const input = (payload as { input?: { questions?: unknown } } | null)?.input;
  const qs = Array.isArray(input?.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  const first = qs.find((q) => typeof q?.question === "string" && q.question.trim());
  if (!first) return null;
  const question = (first.question as string).trim();
  const raw = Array.isArray(first.options) ? (first.options as Array<Record<string, unknown>>) : [];
  const options = raw
    .filter((o) => typeof o?.label === "string" && (o.label as string).trim())
    .map((o, i) => {
      const label = (o.label as string).trim();
      const recommended = /\(recommended\)$/i.test(label);
      return {
        letter: String.fromCharCode(65 + i),
        text: recommended ? label.replace(/\s*\(recommended\)$/i, "") : label,
        recommended,
      };
    })
    .slice(0, 8);
  const single = qs.length === 1 && first.multiSelect !== true && options.length >= 2;
  return single ? { question, options, requestId } : { question, options: [] };
}
