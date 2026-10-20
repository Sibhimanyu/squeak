import fs from "node:fs";

/**
 * Transcripts grow without bound — some are tens of megabytes — and we only
 * ever care about how one ends. Read the last slice instead of the whole file.
 */
export function readTailLines(filePath: string, maxBytes = 256 * 1024): string[] {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // The first line is a fragment unless we happened to start at byte zero.
    if (start > 0) {
      lines.shift();
    }
    return lines.filter((line) => line.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Nothing useful to do if the descriptor is already gone.
      }
    }
  }
}

export function parseJsonLines(lines: string[]): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // Partial writes are normal while an agent is mid-turn; skip the line.
    }
  }
  return parsed;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collapse whitespace and clip, so a card preview stays one readable line. */
export function summarize(text: string, maxChars = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

/**
 * Codex writes its session metadata on the first line, so some reads have to
 * start at the top rather than the end.
 */
export function readHeadLines(filePath: string, maxBytes = 512 * 1024): string[] {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, 0);
    const lines = buffer.toString("utf8").split("\n");
    // Drop a trailing fragment unless we read the file whole.
    if (length < size) {
      lines.pop();
    }
    return lines.filter((line) => line.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Already closed.
      }
    }
  }
}
