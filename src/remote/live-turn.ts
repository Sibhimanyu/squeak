import crypto from "node:crypto";

import type { Activity } from "../fleet/activity.js";
import type { TranscriptMessage } from "../fleet/transcript.js";
import type { QueueItem } from "../fleet/session-reply.js";
import { logger } from "../utils/logger.js";

/**
 * The phone's verbose view: the whole current turn of the one session a
 * phone has open, thinking included, as it happens.
 *
 * The snapshot gives every session's newest six steps clipped to 200
 * characters (docs/remote-channel.md: what leaves the Mac is only what the
 * phone renders). Verbose is the exception the owner asks for on the phone,
 * and it is kept as narrow as it can be:
 *
 * - only while a phone is open, says it wants it, and is looking at that
 *   session (its sealed presence names it);
 * - one document per watched session, overwritten in place, never a history;
 * - deleted the moment nobody is watching, so a turn's thinking does not sit
 *   in the database afterwards;
 * - at most one write a second, and none when nothing changed.
 *
 * Like everything on the channel it is sealed with the channel key.
 *
 * It also carries the chat's Conductor queue (messages sent while the agent
 * works, waiting for the turn to end), so the phone can show them above its
 * composer with Steer now and Delete. Read over the loopback relay each tick.
 */

export const LIVE_STEPS = 50;
export const LIVE_STEP_CHARS = 4_000;
/** How much of the chat before this turn the phone is shown: about four exchanges. */
export const HISTORY_MESSAGES = 8;
export const HISTORY_CHARS = 2_000;
/** The transcript is read this often while watched; a write needs a change too. */
export const LIVE_INTERVAL_MS = 1_000;
export const LIVE_QUEUE_TEXT_CHARS = 2_000;
/** The relay is loopback; a read slower than this is treated as unreadable so the turn still publishes. */
const QUEUE_READ_TIMEOUT_MS = 2_000;

export interface LiveTurn {
  v: 1;
  key: string;
  working: boolean;
  /**
   * The session's state and current turn as the Mac saw them when this was
   * written, and `seq` from the same counter as the snapshot's: the phone
   * lets whichever of the two is newer say what the open chat is doing.
   * Optional: older phones ignore them.
   */
  state?: string;
  turnId?: string | null;
  seq?: number;
  /** History is in its own document (`<handle>-h`), written only when it changes. */
  split?: boolean;
  /** How many steps the turn has had; `steps` is the newest LIVE_STEPS of them. */
  total: number;
  steps: Array<{ kind: string; text: string; at: string | null }>;
  /**
   * The chat so far, oldest first: what you typed and the agent's last words
   * of each turn (its notes between tool calls left out), the newest
   * HISTORY_MESSAGES of them, each clipped. Absent for a chat the Mac cannot
   * read (not Conductor's). Only the chat on screen has one, like the rest of
   * this document.
   */
  history?: HistoryEntry[];
  /**
   * Conductor's queue for this chat, in order. Absent when the Mac cannot
   * read it (relay down, not a Conductor chat): the phone then keeps its own
   * list. `[]` means the queue is empty.
   */
  queue?: QueueItem[];
}

/** The live turn's history on its own, for a phone that reads it apart (`split`). */
export interface LiveHistory {
  v: 1;
  key: string;
  seq?: number;
  history: HistoryEntry[];
}

export interface HistoryEntry {
  /** The chat row's rowid as a string: a stable id for the entry (the last message of a run). Absent when unknown. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  at: string | null;
  /** Tool calls the agent made since the entry before this one (the work between two messages). Absent when none. */
  workBefore?: number;
}

/**
 * A chat's readable transcript cut down to what a phone shows above the turn:
 * every user message, and of each run of agent messages only the last (the
 * answer; the rest are its running commentary), newest `max` kept, each clipped.
 */
export function condenseHistory(
  messages: TranscriptMessage[],
  max = HISTORY_MESSAGES,
  chars = HISTORY_CHARS,
): HistoryEntry[] {
  return condenseRuns(messages, chars).entries.slice(-max);
}

/**
 * The same condensing, for one page of an earlier history: the newest `max` entries, and the cursor of the
 * first message behind the oldest of them, so the next page starts exactly before it. `hasMore` is true when
 * entries were cut here.
 */
export function condenseHistoryPage(
  messages: TranscriptMessage[],
  max: number,
  chars = HISTORY_CHARS,
): { entries: HistoryEntry[]; oldestCursor: string | null; hasMore: boolean } {
  const { entries, firsts } = condenseRuns(messages, chars);
  const start = Math.max(0, entries.length - max);
  return { entries: entries.slice(start), oldestCursor: firsts[start] ?? null, hasMore: start > 0 };
}

function condenseRuns(
  messages: TranscriptMessage[],
  chars: number,
): { entries: HistoryEntry[]; firsts: Array<string | null> } {
  const kept: HistoryEntry[] = [];
  // The cursor of the first message of each entry's run, parallel to `kept`.
  const firsts: Array<string | null> = [];
  for (const message of messages) {
    const entry: HistoryEntry = {
      ...(message.cursor ? { id: message.cursor } : {}),
      role: message.role,
      text: message.text.length > chars ? `${message.text.slice(0, chars - 1).trimEnd()}…` : message.text,
      at: message.at,
    };
    const work = message.workBefore ?? 0;
    if (work > 0) {
      entry.workBefore = work;
    }
    const previous = kept[kept.length - 1];
    if (entry.role === "assistant" && previous?.role === "assistant") {
      // A run of agent messages is one answer; the work behind every message of it is the answer's work.
      const total = (previous.workBefore ?? 0) + work;
      if (total > 0) {
        entry.workBefore = total;
      }
      kept[kept.length - 1] = entry;
    } else {
      kept.push(entry);
      firsts.push(message.cursor ?? null);
    }
  }
  return { entries: kept, firsts };
}

export interface LiveTurnDependencies {
  /** The session's current turn, read with whole steps; null when it is gone. */
  read: (
    sessionKey: string,
  ) => { activity: Activity | null; working: boolean; state?: string; turnId?: string | null } | null;
  /** The chat's condensed history; null when it cannot be read. */
  history?: ((sessionKey: string) => HistoryEntry[] | null) | null;
  write: (handle: string, turn: LiveTurn) => Promise<void>;
  /** Writes the history document (`liveHistoryHandle`); needed for `split`. */
  writeHistory?: ((handle: string, history: LiveHistory) => Promise<void>) | null;
  /** Clears whatever was written for this handle: the turn and, if any, its history. */
  clear: (handle: string) => Promise<void>;
  /** Whether the phone reads history apart (split). Absent: inline, as before. */
  split?: (() => boolean) | null;
  /** The next number from the counter the snapshot uses. */
  seq?: (() => number) | null;
  /** The chat's Conductor queue; null when it cannot be read. */
  queue?: ((sessionKey: string) => Promise<QueueItem[] | null>) | null;
}

/** The history document's id beside the turn's. */
export function liveHistoryHandle(handle: string): string {
  return `${handle}-h`;
}

/** The `live` document id of one page of earlier history: the chat's handle, `-h`, then the page's cursor or `latest`. */
export function historyPageDoc(sessionKey: string, before: string | null): string {
  return `${liveHandle(sessionKey)}-h${before ?? "latest"}`;
}

/** A session key as a document id: fixed length, no `:` or `/`, and not the key itself. */
export function liveHandle(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("base64url").slice(0, 22);
}

export class LiveTurnPublisher {
  private readonly deps: LiveTurnDependencies;
  private watched: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = "";
  private lastHistory = "";
  private running = false;

  constructor(deps: LiveTurnDependencies) {
    this.deps = deps;
  }

  /** Which session a phone is watching in verbose mode, or null for none. Idempotent. */
  watch(sessionKey: string | null): void {
    if (sessionKey === this.watched) {
      return;
    }
    const previous = this.watched;
    this.watched = sessionKey;
    this.invalidate();
    if (previous) {
      void this.deps.clear(liveHandle(previous)).catch((error: unknown) => {
        logger.warn("live turn clear failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (sessionKey) {
      void this.publish();
      this.timer = setInterval(() => void this.publish(), LIVE_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.watch(null);
  }

  /** Write the next look in full: the phone's format changed. */
  invalidate(): void {
    this.last = "";
    this.lastHistory = "";
  }

  /** One look at the watched session; writes only what changed. Never throws. */
  /** Never throws: a chat whose history cannot be read just goes without it. */
  private readHistory(key: string): HistoryEntry[] | null {
    try {
      return this.deps.history?.(key) ?? null;
    } catch {
      return null;
    }
  }

  async publish(): Promise<void> {
    const key = this.watched;
    if (!key || this.running) {
      return;
    }
    this.running = true;
    try {
      const read = this.deps.read(key);
      const activity = read?.activity;
      const turn: LiveTurn = {
        v: 1,
        key,
        working: read?.working ?? false,
        ...(read?.state ? { state: read.state } : {}),
        ...(read?.turnId !== undefined ? { turnId: read.turnId } : {}),
        total: activity?.total ?? 0,
        steps: (activity?.steps ?? []).slice(-LIVE_STEPS).map((step) => ({
          kind: step.kind,
          text: clipText(step.text, LIVE_STEP_CHARS),
          at: step.at,
        })),
      };
      const history = this.readHistory(key);
      const split = Boolean(this.deps.split?.() && this.deps.writeHistory);
      if (history && !split) {
        turn.history = history;
      }
      if (split) {
        turn.split = true;
        // History changes once a turn; the turn every second. Apart, a step does not resend it.
        const serializedHistory = JSON.stringify(history ?? []);
        if (history && serializedHistory !== this.lastHistory) {
          const doc: LiveHistory = { v: 1, key, history };
          const seq = this.deps.seq?.();
          if (seq !== undefined) doc.seq = seq;
          await this.deps.writeHistory!(liveHandle(key), doc);
          this.lastHistory = serializedHistory;
        }
      }
      const queue = await this.readQueue(key);
      if (queue) {
        turn.queue = queue.map((item) => ({
          id: item.id,
          text: clipText(item.text, LIVE_QUEUE_TEXT_CHARS),
          mode: item.mode,
          position: item.position,
        }));
      }
      const serialized = JSON.stringify(turn);
      if (serialized === this.last) {
        return;
      }
      const seq = this.deps.seq?.();
      await this.deps.write(liveHandle(key), seq === undefined ? turn : { ...turn, seq });
      // A watch that moved on while this was writing must not leave this behind.
      if (this.watched === key) {
        this.last = serialized;
      } else {
        await this.deps.clear(liveHandle(key));
      }
    } catch (error) {
      logger.warn("live turn publish failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Never throws and never hangs the tick: a failed or slow read is "can't read". */
  private async readQueue(key: string): Promise<QueueItem[] | null> {
    const read = this.deps.queue;
    if (!read) {
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        read(key),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), QUEUE_READ_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      logger.debug("live turn queue read failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
