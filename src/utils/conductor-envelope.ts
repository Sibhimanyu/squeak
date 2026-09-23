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
