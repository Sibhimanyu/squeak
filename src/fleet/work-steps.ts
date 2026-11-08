import type { SessionMessageRecord } from "../types.js";
import { clip, describeClaudeTool } from "./activity.js";
import { rowText, TRANSCRIPT_CHUNK_ROWS, TRANSCRIPT_FIRST_CHUNK_ROWS, TRANSCRIPT_MAX_SCAN_ROWS } from "./transcript.js";
import type { TranscriptRowSource } from "./transcript.js";

/**
 * The work between two messages of a chat, for the phone's "Worked · N steps" row: the tool calls (and the
 * thinking summaries) Conductor's rows hold between the text message before and the one named, oldest first.
 * Each is a plain label as `activity.ts` words them, never a tool's raw input.
 */

export const WORK_STEP_CHARS = 200;
export const WORK_STEPS_MAX = 200;

export interface WorkStep {
  kind: "tool" | "thinking";
  text: string;
}

export interface WorkSteps {
  steps: WorkStep[];
  /** Steps past the first `WORK_STEPS_MAX`, left out. */
  more: number;
}

function blocksOf(content: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(content) as { message?: { content?: unknown } } | null;
    const blocks = parsed?.message?.content;
    return Array.isArray(blocks)
      ? blocks.filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b))
      : [];
  } catch {
    return [];
  }
}

function stepsOf(row: SessionMessageRecord, options: { thinking: boolean }): WorkStep[] {
  if (row.role !== "assistant") return [];
  const out: WorkStep[] = [];
  for (const block of blocksOf(row.content)) {
    if (block.type === "tool_use") {
      const input = block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input : {};
      out.push({
        kind: "tool",
        text: clip(
          describeClaudeTool(typeof block.name === "string" ? block.name : "tool", input as Record<string, unknown>),
          WORK_STEP_CHARS,
        ),
      });
    } else if (options.thinking && block.type === "thinking" && typeof block.thinking === "string") {
      const text = block.thinking.trim();
      if (text) out.push({ kind: "thinking", text: clip(text, WORK_STEP_CHARS) });
    }
  }
  return out;
}

/** `messageId` is the message's rowid as a string (a history entry's `id`). Null when no message of this chat has it. */
export function readWorkBetween(source: TranscriptRowSource, sessionId: string, messageId: string): WorkSteps | null {
  const rows: SessionMessageRecord[] = []; // newest first
  let cursor: number | null = null;
  let target = -1;
  let boundary = -1;
  while (rows.length < TRANSCRIPT_MAX_SCAN_ROWS) {
    const size = rows.length === 0 ? TRANSCRIPT_FIRST_CHUNK_ROWS : TRANSCRIPT_CHUNK_ROWS;
    const chunk = source.listSessionMessagesPage(sessionId, cursor, size);
    rows.push(...chunk);
    if (target < 0) target = rows.findIndex((row) => row.cursor === messageId && rowText(row) !== null);
    if (target >= 0 && boundary < 0) {
      boundary = rows.findIndex((row, i) => i > target && rowText(row) !== null);
    }
    const last = chunk[chunk.length - 1];
    if (chunk.length < size || !last?.cursor || (target >= 0 && boundary >= 0)) break;
    cursor = Number(last.cursor);
  }
  if (target < 0) return null;
  // Rows after the previous message (its own tool calls included, as the count does) up to the target, oldest first.
  const from = boundary >= 0 ? boundary : rows.length;
  const steps: WorkStep[] = [];
  if (boundary >= 0) steps.push(...stepsOf(rows[boundary]!, { thinking: false }));
  for (let i = from - 1; i > target; i -= 1) steps.push(...stepsOf(rows[i]!, { thinking: true }));
  // The row's own text row holds the target; the tool calls it makes belong to the next gap.
  return { steps: steps.slice(0, WORK_STEPS_MAX), more: Math.max(0, steps.length - WORK_STEPS_MAX) };
}
