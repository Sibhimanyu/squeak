import type { SessionMessageRecord } from "../types.js";
import { conductorTimestampToIso } from "../adapters/conductor-registry.js";
import { extractAssistantEnvelopeText } from "../utils/conductor-envelope.js";

/** Rows read to build a transcript; tool calls and results are most of them. */
export const TRANSCRIPT_SCAN_ROWS = 600;

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string | null;
  turnId: string | null;
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
  const kept: TranscriptMessage[] = [];
  for (const row of rows) {
    const text = row.role === "user" ? extractUserText(row.content) : extractAssistantEnvelopeText(row.content);
    if (!text) {
      continue;
    }
    kept.push({
      id: row.id ?? `${row.turnId ?? "row"}:${kept.length}`,
      role: row.role,
      text,
      at: conductorTimestampToIso(row.sentAt),
      turnId: row.turnId,
    });
  }
  const newest = kept.slice(0, options.limit);
  return {
    messages: newest.reverse(),
    complete: rows.length < options.scanRows && kept.length <= options.limit,
  };
}
