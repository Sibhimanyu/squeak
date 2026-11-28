import type { TitleModelCall } from "./auto-title.js";
import { check, RULE } from "./room-voice.js";

/**
 * The Room message a Duck did not write. A Duck posts its own message at the end of a Task; when it finishes the Task's
 * turn without one, the host writes one from the turn's final result: two or three plain sentences saying what it did,
 * what it found and what it needs. The on-device model writes it, Haiku when the device cannot. The post is marked as
 * written on the Duck's behalf (`onBehalf` on the wire), never passed off as the Duck's own words.
 */

/** A fallback post's id starts with this, so a replayed finish is a no-op and the feed can mark it. */
export const FINISH_ID_PREFIX = "fb:";
/** Most characters of a Room message (the same cap as `ROOM_MAX_TEXT`). */
const MAX_CHARS = 500;

export const FINISH_SYSTEM = [
  "You write one message in a team room for a coding agent that has just finished a task, from the agent's last reply.",
  "Write two or three plain sentences in the first person: what you did, what you found, and what you need from the reader (leave that out if nothing).",
  "No greeting or preamble, no markdown, no code blocks, and never copy tool output or logs. Reply with the message only.",
  RULE,
].join(" ");

export interface FinishInput {
  /** What the person asked for (the Task's text). */
  task: string;
  /** The turn's final reply, the agent's own words. */
  reply: string;
}

/** A model that turns a finished turn into a Room message. null = no answer (the next one is tried). */
export interface FinishWriterPort {
  write(input: FinishInput, signal: AbortSignal): Promise<string | null>;
}

export function finishPrompt(input: FinishInput): string {
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);
  return [
    `The task:\n${clip(input.task.trim(), 600)}`,
    `Your final reply:\n${clip(input.reply.trim(), 3000)}`,
    "Room message:",
  ].join("\n\n");
}

/** The model's answer as a Room message: at most three sentences and 500 characters, no markdown or preamble; else null. */
export function cleanFinish(raw: string): string | null {
  const flat = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]+/g, "")
    .replace(/^\s*(?:room )?message\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((x) => x.trim()) ?? [flat];
  let text = sentences.filter(Boolean).slice(0, 3).join(" ");
  const chars = [...text];
  if (chars.length > MAX_CHARS)
    text = `${chars
      .slice(0, MAX_CHARS - 1)
      .join("")
      .trimEnd()}…`;
  return text || null;
}

/** The Haiku port: the same small-model call the titles and the job check use. */
export function haikuFinishWriter(call: () => TitleModelCall): FinishWriterPort {
  return {
    async write(input, signal) {
      return call()({ prompt: finishPrompt(input), system: FINISH_SYSTEM, signal });
    },
  };
}

/** Tries each writer in turn (on-device first, Haiku after) and returns the first clean message, else null. Never throws. */
export async function writeFinish(
  writers: FinishWriterPort[],
  input: FinishInput,
  timeoutMs: number,
  onError?: (error: unknown) => void,
): Promise<string | null> {
  for (const w of writers) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const timedOut = new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("finish message timed out")), { once: true }),
      );
      const text = cleanFinish((await Promise.race([w.write(input, abort.signal), timedOut])) ?? "");
      // A line that reads like a commit log is not posted: the next writer is tried, and none left drops it.
      if (text && check(text).ok) return text;
    } catch (error) {
      onError?.(error);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
