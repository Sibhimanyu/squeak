import type { SessionMessageRecord } from "../types.js";
import { conductorTimestampToIso } from "../adapters/conductor-registry.js";
import { countToolCalls, extractAssistantEnvelopeText } from "../utils/conductor-envelope.js";

/** Rows read to build a transcript; tool calls and results are most of them. */
export const TRANSCRIPT_SCAN_ROWS = 600;

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string | null;
  turnId: string | null;
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
  options: { limit: number; scanRows: number },
): TranscriptResult {
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
    complete: rows.length < options.scanRows && kept.length <= options.limit,
  };
}
