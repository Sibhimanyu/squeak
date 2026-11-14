import { condenseHistory, liveHandle, type HistoryEntry } from "./live-turn.js";
import type { TranscriptResult } from "../fleet/transcript.js";

/**
 * "History cache", the Mac side (docs/remote-channel.md): a phone that keeps a chat's messages on the device asks
 * only for what came after the newest one it holds. The cursor is the one every history entry already carries as
 * its `id` (a Conductor row's rowid, a transcript file's byte offset + 1): it only grows within a chat.
 */

/** A phone names this in its presence `caps` when it reads `HistoryDelta` pages and keeps history on the device. */
export const HISTORY_DELTA_CAP = "histdelta";
/** The action the Mac adds to a chat, for a phone that named the cap, to say a Mac this new can answer `after`. */
export const HISTORY_DELTA_ACTION = "delta";
/** Entries in one delta page at most. */
export const HISTORY_DELTA_PAGE_MAX = 50;
/** Entries read back looking for the cursor; a chat that moved on further than this is answered with `reset`. */
export const HISTORY_DELTA_SCAN_MAX = 400;
/** Raw messages read per step while looking for the cursor. */
const STEP = 60;

/** The `live` document of a delta page: the chat's handle, `-ha`, the cursor. Never collides with `-h<before>`. */
export function historyDeltaDoc(sessionKey: string, after: string): string {
  return `${liveHandle(sessionKey)}-ha${after}`;
}

export interface HistoryDelta {
  /** Oldest first, all strictly newer than the cursor, contiguous with it. With `reset`, the chat's newest page instead. */
  entries: HistoryEntry[];
  /** The cursor to ask from next when more than a page came after; null when this page reaches the newest message. */
  nextAfter: string | null;
  /** The cursor was not found within reach: `entries` is the newest page and does not join the cursor. */
  reset: boolean;
}

export type TranscriptReader = (
  limit: number,
  before: number | null,
) => Pick<TranscriptResult, "messages" | "nextBefore">;

/**
 * The messages after `after`, oldest first, at most `wanted`. Reads backward from the newest with the chat's
 * ordinary reader until a message at or below the cursor shows up, so it works for every reader that pages by
 * `before` and needs none of its own.
 */
export function readHistoryAfter(read: TranscriptReader, after: number, wanted: number): HistoryDelta {
  const page = Math.min(HISTORY_DELTA_PAGE_MAX, Math.max(1, Math.floor(wanted)));
  const newer = new Map<number, TranscriptResult["messages"][number]>();
  let before: number | null = null;
  let reached = false;
  while (newer.size <= HISTORY_DELTA_SCAN_MAX) {
    const result = read(STEP, before);
    for (const message of result.messages) {
      const cursor = Number(message.cursor);
      if (!message.cursor || !Number.isFinite(cursor)) {
        continue;
      }
      if (cursor > after) {
        newer.set(cursor, message);
      } else {
        reached = true;
      }
    }
    const next: number | null = result.nextBefore ? Number(result.nextBefore) : null;
    if (reached || next === null || result.messages.length === 0 || (before !== null && next >= before)) {
      // The start of the chat counts as reached: everything there is, is after the cursor.
      reached = reached || next === null;
      break;
    }
    before = next;
  }
  const ordered = [...newer.entries()].sort((a, b) => a[0] - b[0]).map(([, message]) => message);
  if (!reached) {
    return { entries: condenseHistory(ordered, page), nextAfter: null, reset: true };
  }
  const entries = condenseHistory(ordered, ordered.length);
  const slice = entries.slice(0, page);
  const last = slice[slice.length - 1];
  return { entries: slice, nextAfter: entries.length > page && last?.id ? last.id : null, reset: false };
}
