import type { SessionMessageRecord } from "../types.js";
import { conductorTimestampToIso } from "../adapters/conductor-registry.js";
import { countToolCalls, extractAssistantEnvelopeText } from "../utils/conductor-envelope.js";

/** Rows read to build a transcript in one go; tool calls and results are most of them. */
export const TRANSCRIPT_SCAN_ROWS = 600;
/** Rows per read when paging by rowid until enough messages are found. */
export const TRANSCRIPT_CHUNK_ROWS = 2_000;
/** Rows in the first read of a page. */
export const TRANSCRIPT_FIRST_CHUNK_ROWS = 200;
/** A chat is never scanned further than this in one request; the page then says it is not complete. */
export const TRANSCRIPT_MAX_SCAN_ROWS = 40_000;

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string | null;
  turnId: string | null;
  /** The row's rowid as a string: pass the oldest message's as `before` to read what precedes it. Absent on hand-built rows. */
  cursor?: string;
  /**
   * Tool calls the agent made since the message before this one: the work between two messages, which
   * has no text of its own. Absent when there was none.
   */
  workBefore?: number;
}

export interface TranscriptResult {
  messages: TranscriptMessage[];
  /** True only when the whole chat was read and every message is returned. */
  complete: boolean;
  /**
   * Where to resume for the messages before these (`before`), or null when there are none. Absent from
   * readers that cannot page (terminal agents).
   */
  nextBefore?: string | null;
}

/** What reads a chat's rows by rowid, newest first, strictly below `before` (null: from the newest). */
export interface TranscriptRowSource {
  listSessionMessagesPage(sessionId: string, before: number | null, limit: number): SessionMessageRecord[];
}

/** A cursor is a positive integer in digits and nothing else. */
export function parseCursor(raw: string | null | undefined): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    return "invalid";
  }
  return Number(raw);
}

function rowText(row: SessionMessageRecord): string | null {
  return row.role === "user" ? extractUserText(row.content) : extractAssistantEnvelopeText(row.content);
}

/**
 * The newest `limit` messages strictly before `before`, found by scanning rows newest first in chunks until
 * `limit + 1` messages turned up (the extra one makes the oldest returned message's `workBefore` whole) or
 * the chat runs out. A turn of hundreds of tool rows cannot hide its own prompt, and the cursor lets the
 * caller page further back without ever re-reading what it has.
 */
export function readTranscript(
  source: TranscriptRowSource,
  sessionId: string,
  options: { limit: number; before?: number | null },
): TranscriptResult {
  const rows: SessionMessageRecord[] = [];
  let cursor = options.before ?? null;
  let texts = 0;
  let exhausted = false;
  while (rows.length < TRANSCRIPT_MAX_SCAN_ROWS) {
    // The first look is small: most chats have their last messages within a couple of hundred rows.
    const size = rows.length === 0 ? TRANSCRIPT_FIRST_CHUNK_ROWS : TRANSCRIPT_CHUNK_ROWS;
    const chunk = source.listSessionMessagesPage(sessionId, cursor, size);
    for (const row of chunk) {
      if (rowText(row)) {
        texts += 1;
      }
    }
    rows.push(...chunk);
    const last = chunk[chunk.length - 1];
    if (chunk.length < size || !last?.cursor) {
      exhausted = true;
      break;
    }
    cursor = Number(last.cursor);
    if (texts > options.limit) {
      break;
    }
  }
  const built = buildTranscript(rows, { limit: options.limit, exhausted });
  const oldest = built.messages[0];
  const scannedTo = rows[rows.length - 1]?.cursor ?? null;
  let nextBefore: string | null = null;
  if (built.hasOlder && oldest?.cursor) {
    nextBefore = oldest.cursor;
  } else if (!exhausted) {
    // Scan cap hit without enough messages: resume below everything read.
    nextBefore = scannedTo;
  }
  return { messages: built.messages, complete: nextBefore === null, nextBefore };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * What the human typed. Mirrored rows are plain text; rows Conductor wrote
 * itself may be an envelope whose content is a string or a block list, where
 * a list of only tool results is the agent's plumbing, not the user's words.
 */
function extractUserText(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.trim() || null;
  }
  const message = asRecord(asRecord(parsed)?.message);
  if (!message) {
    // JSON that is not an envelope (e.g. the user typed "42" or a snippet).
    return asRecord(parsed) ? null : content.trim() || null;
  }
  const body = message.content;
  if (typeof body === "string") {
    return body.trim() || null;
  }
  if (!Array.isArray(body)) {
    return null;
  }
  const text = body
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((part) => part.trim())
    .join("\n\n")
    .trim();
  return text || null;
}

/**
 * Readable history from Conductor's rows (newest first, as the registry
 * returns them). Only user text and assistant prose survive: tool calls and
 * results, thinking, and `result` / `system` events never leave this function.
 * Every text-bearing assistant row is its own message, in order.
 */
export function buildTranscript(
  rows: SessionMessageRecord[],
  options: { limit: number; scanRows?: number; exhausted?: boolean },
): TranscriptResult & { hasOlder: boolean } {
  // Oldest first, so the tool calls between two messages can be counted onto the later one.
  const kept: TranscriptMessage[] = [];
  let work = 0;
  for (const row of [...rows].reverse()) {
    const text = row.role === "user" ? extractUserText(row.content) : extractAssistantEnvelopeText(row.content);
    if (text) {
      kept.push({
        id: row.id ?? `${row.turnId ?? "row"}:${kept.length}`,
        role: row.role,
        text,
        at: conductorTimestampToIso(row.sentAt),
        turnId: row.turnId,
        ...(row.cursor ? { cursor: row.cursor } : {}),
        ...(work > 0 ? { workBefore: work } : {}),
      });
      work = 0;
    }
    if (row.role === "assistant") {
      work += countToolCalls(row.content);
    }
  }
  return {
    messages: kept.slice(-options.limit),
    complete:
      (options.exhausted ?? rows.length < (options.scanRows ?? TRANSCRIPT_SCAN_ROWS)) && kept.length <= options.limit,
    hasOlder: kept.length > options.limit,
  };
}
