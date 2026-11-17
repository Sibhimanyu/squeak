import { stripMarkdown } from "../fleet/card-text.js";
import { parseChoices } from "../fleet/choices.js";

import type { TimelineLog } from "./timeline-log.js";
import type { TimelineEvent } from "./timeline.js";

/**
 * The room's turns, derived from each chat's timeline (no source of truth of their own): a turn is one
 * `turn.started` (not an agent-run one) to its `turn.ended`, with the reply the agent closed it with.
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
  answer?: { letter: string; question: string };
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
}

/** What a chat's cache keeps of one turn. */
export interface TurnBase {
  turnId: string;
  startedAt: number;
  startSeq: number;
  endedAt?: number;
  outcome?: "finished" | "stopped" | "error";
  prompt: string;
  authorName?: string;
  /** The turn's closing reply (full text, capped), the agent's own words. */
  reply?: string;
  answer?: { letter: string; question: string };
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
        ...(e.author ? { authorName: e.author.name } : {}),
      };
      const letter = answerLetter(e.text);
      if (letter) {
        const before = [...c.turns].reverse().find((t) => t.endedAt !== undefined || t.reply !== undefined);
        const ask = before ? askOf(before.reply) : null;
        if (ask?.options.some((o) => o.letter === letter)) base.answer = { letter, question: oneLine(ask.question) };
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
      c.replies.delete(e.turnId);
    }
  }

  drop(sessionId: string): void {
    this.chats.delete(sessionId);
  }
}
