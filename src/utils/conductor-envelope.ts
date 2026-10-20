function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Pull the prose out of a Conductor assistant row.
 *
 * `content` holds the agent envelope, whose `message.content` is a block list
 * mixing text with tool_use and thinking blocks. Only the text blocks are worth
 * sending to Telegram; a row that is purely tool calls yields nothing, which is
 * how a tool-only step ends up skipped rather than posted as an empty message.
 */
export function extractAssistantEnvelopeText(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not an envelope. Older rows stored bare text.
    const bare = content.trim();
    return bare || null;
  }

  const blocks = asRecord(asRecord(parsed)?.message)?.content;
  if (!Array.isArray(blocks)) {
    return null;
  }

  const text = blocks
    .map((block) => {
      const record = asRecord(block);
      return record && asString(record.type) === "text" ? (asString(record.text) ?? "") : "";
    })
    .filter((part) => part.trim())
    .join("\n\n")
    .trim();

  return text || null;
}

/**
 * What went wrong, from a row that ended a turn badly: an agent's
 * `{"type":"error","content":…}` or a `result` row with `is_error`. Null for
 * anything else, for "aborted by user" (that is you pressing stop, not a
 * failure) and for an error the agent is about to retry ("Reconnecting… 2/5").
 */
export function extractTurnError(content: string): string | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(content));
  } catch {
    return null;
  }
  if (!parsed) {
    return null;
  }
  let text: string | null = null;
  if (parsed.type === "error") {
    if (parsed.willRetry === true) {
      return null;
    }
    text = asString(parsed.content);
  } else if (parsed.type === "result" && (parsed.is_error === true || parsed.is_error === 1)) {
    text = asString(parsed.result);
  }
  const trimmed = text?.trim() ?? "";
  return trimmed && trimmed.toLowerCase() !== "aborted by user" ? trimmed : null;
}
