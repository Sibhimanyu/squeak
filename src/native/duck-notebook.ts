import { type TitleModelCall } from "./auto-title.js";
import { firstSentence, oneLine } from "./room-turns.js";

/**
 * A duck's notebook: what it has done, one compact line a job, newest last, capped so it stays cheap in the agent's
 * note (the oldest lines go first). Plain by default; a model may write the outcome sentence when one is injected.
 */

export const NOTEBOOK_MAX = 3000;
const NOTEBOOK_SUMMARY_TIMEOUT_MS = 8000;

export function notebookDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface NotebookEntryInput {
  at: number;
  /** The job as asked (one line). */
  job: string;
  /** What came of it, one sentence. */
  outcome: string;
  /** "failed" / "stopped" are said; a finished job is not. */
  ended?: "finished" | "stopped" | "error";
  branch?: string | null;
}

export function notebookLine(e: NotebookEntryInput): string {
  const tag = e.ended === "error" ? " (failed)" : e.ended === "stopped" ? " (stopped)" : "";
  const where = e.branch ? ` [${oneLine(e.branch, 60)}]` : "";
  const outcome = e.outcome ? ` -> ${oneLine(e.outcome, 200)}` : "";
  return `- ${notebookDate(e.at)} ${oneLine(e.job, 120)}${tag}${outcome}${where}`;
}

/** The notebook with `line` added, oldest whole lines dropped until it fits `max` (the newest line is always kept). */
export function appendNotebook(existing: string, line: string, max = NOTEBOOK_MAX): string {
  const lines = existing.split("\n").filter((l) => l.trim());
  lines.push(line.slice(0, max));
  while (lines.length > 1 && lines.join("\n").length > max) lines.shift();
  return lines.join("\n");
}

/** One Haiku sentence for what the job did; null on a timeout, an error or an empty answer (the plain line is used). */
export async function summariseOutcome(
  call: TitleModelCall,
  job: string,
  reply: string,
  timeoutMs = NOTEBOOK_SUMMARY_TIMEOUT_MS,
): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const timedOut = new Promise<never>((_, reject) =>
      abort.signal.addEventListener("abort", () => reject(new Error("notebook summary timed out")), { once: true }),
    );
    const raw = await Promise.race([
      call({
        prompt: `Job:\n${job.slice(0, 400)}\n\nThe agent's closing reply:\n${reply.slice(0, 1500)}\n\nOne sentence:`,
        system:
          "You write one line in a coding agent's notebook. Reply with a single plain sentence (under 25 words) saying what was done and the outcome. No markdown, no quotes.",
        signal: abort.signal,
      }),
      timedOut,
    ]);
    const one = firstSentence(raw.trim());
    return one || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
