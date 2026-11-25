import type { TitleModelCall } from "./auto-title.js";
import type { NativeStore, RoomPostRow } from "./store.js";

/**
 * The Room line of a Duck-to-Duck message. The sending Duck gives a short `summary` with its tool call; when it does
 * not (or for a post made before summaries existed), the on-device model writes one, Haiku when the device cannot, and
 * a plain first-sentences clip when no model answers. The whole original message is stored beside it (`full_body`).
 */

/** Most characters of a summary line. */
export const SUMMARY_MAX = 240;
/** The most old posts one startup backfill writes a summary for. */
export const BACKFILL_CAP = 200;
export const BACKFILL_MIGRATION = "duck-handoff-summaries";

export const SUMMARY_SYSTEM = [
  "You write one line of a team chat: what a coding agent told another agent to do or to know, from the message it sent.",
  "Write one plain sentence, two at most, addressed to nobody and starting with the substance: no greeting, no markdown, no code.",
  "Never copy tool output or logs, and never start with 'I'. Reply with the line only.",
].join(" ");

export function summaryPrompt(message: string): string {
  const flat = message.trim();
  return `The message:\n${flat.length > 3000 ? `${flat.slice(0, 3000)}…` : flat}\n\nChat line:`;
}

/** At most `max` characters, cut at a word end (never mid-word), with an ellipsis when cut. */
export function clipAtWord(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const at = cut.lastIndexOf(" ");
  const head = at > max * 0.5 ? cut.slice(0, at) : cut;
  return `${head.trimEnd().replace(/[,;:\-–—]+$/, "")}…`;
}

function flatten(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>]+/g, "")
    .replace(/^\s*(?:chat )?(?:line|summary)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A summary as the Room keeps it: at most two sentences and 240 characters, no markdown or preamble; else null. */
export function cleanSummary(raw: string): string | null {
  const flat = flatten(raw);
  if (!flat) return null;
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((x) => x.trim()) ?? [flat];
  const text = clipAtWord(sentences.filter(Boolean).slice(0, 2).join(" "), SUMMARY_MAX);
  return text || null;
}

/** The no-model fallback: the message's first sentences, cut at a word end. */
export function localSummary(message: string): string | null {
  return cleanSummary(message.replace(/^@\S+(?: \d+)?\s+/, ""));
}

/** A model that turns a Duck-to-Duck message into one Room line. null = no answer (the next one is tried). */
export interface SummaryWriterPort {
  write(message: string, signal: AbortSignal): Promise<string | null>;
}

/** The Haiku port: the same small-model call the titles and the finish message use. */
export function haikuSummaryWriter(call: () => TitleModelCall): SummaryWriterPort {
  return {
    async write(message, signal) {
      return call()({ prompt: summaryPrompt(message), system: SUMMARY_SYSTEM, signal });
    },
  };
}

/** Tries each writer in turn (on-device first, Haiku after); the first clean line wins. null when none answers. Never throws. */
export async function writeSummary(
  writers: SummaryWriterPort[],
  message: string,
  timeoutMs: number,
  onError?: (error: unknown) => void,
): Promise<string | null> {
  for (const w of writers) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const timedOut = new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("summary timed out")), { once: true }),
      );
      const text = cleanSummary((await Promise.race([w.write(message, abort.signal), timedOut])) ?? "");
      if (text) return text;
    } catch (error) {
      onError?.(error);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** The message a post's summary is about: its whole body, else its text. */
export function bodyOf(row: Pick<RoomPostRow, "fullBody" | "text">): string {
  return (row.fullBody ?? row.text).trim();
}

/**
 * Once, in the background, capped: gives each old Duck-to-Duck post (newest first) a summary. Idempotent: a post with a
 * summary is never touched, and the migration is recorded only when none is left, so a capped run continues at the next
 * start. Yields between posts so it never blocks the host. Returns how many posts it wrote a summary for.
 */
export async function backfillSummaries(o: {
  store: NativeStore;
  writers: SummaryWriterPort[];
  cap?: number;
  timeoutMs?: number;
  onWritten?: (row: RoomPostRow) => void;
  onError?: (error: unknown) => void;
}): Promise<number> {
  const { store } = o;
  if (store.migrationDone(BACKFILL_MIGRATION)) return 0;
  let n = 0;
  for (const row of store.roomPostsNeedingSummary(o.cap ?? BACKFILL_CAP)) {
    const body = bodyOf(row);
    const line = (await writeSummary(o.writers, body, o.timeoutMs ?? 12_000, o.onError)) ?? localSummary(body);
    if (line && store.setRoomPostSummary(row.id, line)) {
      n += 1;
      const fresh = store.roomPostById(row.id);
      if (fresh) o.onWritten?.(fresh);
    }
    await new Promise((r) => setImmediate(r));
  }
  if (store.roomPostsNeedingSummary(1).length === 0) store.recordMigration(BACKFILL_MIGRATION);
  return n;
}
