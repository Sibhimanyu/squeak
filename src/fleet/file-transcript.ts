import fs from "node:fs";

import { asArray, asRecord, asString } from "./observers/tail.js";
import { queuedPromptText, stripSystemInstruction } from "./activity.js";
import type { TranscriptMessage, TranscriptResult } from "./transcript.js";
import type { AgentKind } from "./types.js";

/**
 * Readable history for a session Squeak only watches (a `claude` or `codex` in Terminal), read from its
 * transcript file. Conductor and native chats have their own stores; this is the same shape
 * (`TranscriptResult`) so the Mac pages it the same way.
 *
 * The cursor is the byte offset of the message's line, plus one (a cursor is a positive integer). A page
 * reads a window of the file that ends at `before`, doubling it until it holds enough messages, so a
 * 40 MB transcript is never read whole for its newest page.
 */

const FIRST_WINDOW = 1024 * 1024;
/** A request never reads more than this far back; the page then says there is more. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** One message is capped; the Mac's "Full message" has its own route. */
const MAX_TEXT_CHARS = 40_000;
const SAME_MESSAGE_MS = 2000;
const CONTINUATION_PREFIX = "This session is being continued from a previous conversation";

interface Line {
  offset: number;
  entry: Record<string, unknown>;
}

function parseWindow(buffer: Buffer, base: number, dropFirst: boolean): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let first = true;
  while (start <= buffer.length) {
    let end = buffer.indexOf(0x0a, start);
    if (end === -1) {
      end = buffer.length;
    }
    if (!(first && dropFirst) && end > start) {
      try {
        const entry = asRecord(JSON.parse(buffer.toString("utf8", start, end)) as unknown);
        if (entry) {
          lines.push({ offset: base + start, entry });
        }
      } catch {
        // A partial write at the tail, or a damaged line: not a message.
      }
    }
    first = false;
    start = end + 1;
  }
  return lines;
}

function clipText(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

interface Draft {
  key: string;
  role: "user" | "assistant";
  text: string;
  at: string | null;
  offset: number;
  id: string;
  /** Tool calls seen since the previous message. */
  work: number;
}

/** Messages, oldest first, from a window of Claude entries. */
function claudeMessages(lines: Line[]): Draft[] {
  const drafts = new Map<string, Draft>();
  const order: string[] = [];
  const sources = new Set<string>();
  const sentAt: { text: string; ms: number | null }[] = [];
  const seenTools = new Set<string>();
  let work = 0;

  const push = (draft: Omit<Draft, "work">): void => {
    const existing = drafts.get(draft.key);
    if (existing) {
      existing.text = draft.text;
      return;
    }
    drafts.set(draft.key, { ...draft, work });
    order.push(draft.key);
    work = 0;
  };
  const pushYou = (text: string, line: Line, at: string | null): void => {
    const parsed = at ? Date.parse(at) : Number.NaN;
    const ms = Number.isNaN(parsed) ? null : parsed;
    if (sentAt.some((p) => p.text === text && ms !== null && p.ms !== null && Math.abs(p.ms - ms) <= SAME_MESSAGE_MS)) {
      return;
    }
    sentAt.push({ text, ms });
    const id = asString(line.entry.uuid) ?? `line-${line.offset}`;
    push({ key: `you:${id}`, role: "user", text: clipText(text), at, offset: line.offset, id });
  };

  for (const line of lines) {
    const entry = line.entry;
    if (entry.isSidechain === true) {
      continue;
    }
    const type = asString(entry.type);
    const at = asString(entry.timestamp);
    const message = asRecord(entry.message);
    if (type === "attachment") {
      const said = queuedPromptText(entry);
      if (said) {
        const source = asString(asRecord(entry.attachment)?.source_uuid);
        if (source) {
          sources.add(source);
        }
        pushYou(said, line, at);
      }
      continue;
    }
    if (type === "user" && message) {
      if (entry.isMeta === true) {
        continue;
      }
      const blocks = asArray(message.content).map(asRecord);
      if (blocks.some((block) => asString(block?.type) === "tool_result")) {
        continue;
      }
      const raw =
        typeof message.content === "string"
          ? message.content
          : blocks
              .filter((block) => asString(block?.type) === "text")
              .map((block) => asString(block?.text) ?? "")
              .join("\n");
      if (typeof entry.uuid === "string" && sources.has(entry.uuid)) {
        continue;
      }
      const text = (raw.trimStart().startsWith("<system_instruction>") ? stripSystemInstruction(raw) : raw).trim();
      // Task notifications, command caveats and other tags are Claude Code's own notes; a compaction recap and
      // an interrupt marker are not anything the person said.
      if (
        !text ||
        text.startsWith("<") ||
        text.startsWith(CONTINUATION_PREFIX) ||
        text.startsWith("[Request interrupted")
      ) {
        continue;
      }
      pushYou(text, line, at);
      continue;
    }
    if (type !== "assistant" || !message) {
      continue;
    }
    const messageId = asString(message.id) ?? `line-${line.offset}`;
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      const kind = asString(block?.type);
      if (kind === "tool_use") {
        const toolId = asString(block!.id) ?? `${messageId}:${line.offset}`;
        if (!seenTools.has(toolId)) {
          seenTools.add(toolId);
          work += 1;
        }
      } else if (kind === "text") {
        const text = asString(block!.text)?.trim();
        if (text) {
          // Claude Code writes a message's blocks as separate entries and may rewrite one as it streams.
          push({
            key: `a:${messageId}:${text.slice(0, 80)}`,
            role: "assistant",
            text: clipText(text),
            at,
            offset: line.offset,
            id: `${messageId}:${line.offset}`,
          });
        }
      }
    }
  }
  return order.map((key) => drafts.get(key)!);
}

function codexMessages(lines: Line[]): Draft[] {
  const out: Draft[] = [];
  let work = 0;
  for (const line of lines) {
    const entry = line.entry;
    if (asString(entry.type) !== "response_item") {
      continue;
    }
    const payload = asRecord(entry.payload);
    const kind = asString(payload?.type);
    if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      work += 1;
      continue;
    }
    const role = asString(payload?.role);
    if (kind !== "message" || (role !== "user" && role !== "assistant")) {
      continue;
    }
    const text = asArray(payload!.content)
      .map((part) => asString(asRecord(part)?.text) ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    // Codex writes its own context (environment, AGENTS.md) as user messages.
    if (!text || (role === "user" && (text.startsWith("<") || text.startsWith("# AGENTS.md")))) {
      continue;
    }
    out.push({
      key: `${line.offset}`,
      role,
      text: clipText(text),
      at: asString(entry.timestamp),
      offset: line.offset,
      id: `line-${line.offset}`,
      work,
    });
    work = 0;
  }
  return out;
}

/** The newest `limit` messages strictly before `before` (a cursor from an earlier page), oldest first. */
export function readFileTranscript(
  agent: AgentKind,
  filePath: string,
  options: { limit: number; before?: number | null },
): TranscriptResult {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, "r");
    const size = fs.fstatSync(handle).size;
    // A cursor is offset + 1, so lines strictly before it start below `before - 1`.
    const end = options.before ? Math.min(size, options.before - 1) : size;
    let windowSize = FIRST_WINDOW;
    for (;;) {
      const scan = Math.min(windowSize, MAX_SCAN_BYTES, end);
      const start = end - scan;
      const buffer = Buffer.alloc(scan);
      fs.readSync(handle, buffer, 0, scan, start);
      const lines = parseWindow(buffer, start, start > 0);
      const drafts = agent === "claude" ? claudeMessages(lines) : codexMessages(lines);
      const reachedStart = start === 0;
      const capped = !reachedStart && scan >= MAX_SCAN_BYTES;
      if (drafts.length > options.limit || reachedStart || capped) {
        const kept = drafts.slice(-options.limit);
        const hasMore = drafts.length > options.limit;
        const messages: TranscriptMessage[] = kept.map((d, index) => ({
          id: d.id,
          role: d.role,
          text: d.text,
          at: d.at,
          turnId: null,
          cursor: String(d.offset + 1),
          // The first message of a window cut mid-file has an unknown amount of work before it.
          ...(d.work > 0 && !(index === 0 && !hasMore && !reachedStart) ? { workBefore: d.work } : {}),
        }));
        let nextBefore: string | null = null;
        if (hasMore) {
          nextBefore = messages[0]?.cursor ?? null;
        } else if (!reachedStart && start > 0) {
          nextBefore = String(start + 1);
        }
        return { messages, complete: nextBefore === null, nextBefore };
      }
      windowSize *= 2;
    }
  } catch {
    return { messages: [], complete: false, nextBefore: null };
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Already gone.
      }
    }
  }
}
