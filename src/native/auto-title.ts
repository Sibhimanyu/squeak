import os from "node:os";

import { flag } from "../squeak/flags.js";
import { logger } from "../utils/logger.js";
import type { SessionRow } from "./types.js";

/** One tiny model call: returns the reply text, or throws. Tests inject one. */
export type TitleModelCall = (input: { prompt: string; system: string; signal: AbortSignal }) => Promise<string>;

export const TITLE_TIMEOUT_MS = 20_000;
export const BACKFILL_LIMIT = 15;
const MAX_CHARS = 48;
const MAX_WORDS = 8;

export const TITLE_SYSTEM = [
  "You name chats. Reply with the title only: 2 to 5 words, no quotes, no markdown, no trailing punctuation.",
  "Name the task, not the instruction: leave out filler such as please, can you, I want you to, and model names.",
  "Keep proper nouns as written. Use Title Case unless the person's own words are clearly written otherwise.",
  'Examples: "Merge branches and clean repo", "Greenroom x Recorditor", "Fix login redirect".',
].join(" ");

/** The CLI's own "haiku" alias: always the newest Haiku, the cheapest Claude, without tracking version ids here. */
export function titleModel(): string | null {
  return "haiku";
}

export function titlePrompt(first: string, reply?: string | null): string {
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);
  const parts = [`First message:\n${clip(first.trim(), 1500)}`];
  if (reply?.trim()) parts.push(`The agent's first reply:\n${clip(reply.trim(), 500)}`);
  parts.push("Title:");
  return parts.join("\n\n");
}

/** Turns a model's answer into a title, or null when it is not one. */
export function cleanTitle(raw: string): string | null {
  let t = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  t = t
    .replace(/[`*_#>]+/g, "")
    .replace(/^\s*(?:title|name)\s*:\s*/i, "")
    .replace(/^[\s"'“”‘’«»([]+|[\s"'“”‘’«»)\]]+$/g, "")
    .replace(/[\s.,;:!?…\-–—]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (t.split(" ").length > MAX_WORDS) return null;
  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS + 1);
    t = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim();
    t = t.replace(/[\s.,;:!?…\-–—]+$/g, "");
  }
  return t || null;
}

const FILLER =
  /^(?:hey|hi|hello|ok|okay|so|well|please|pls|just|can you|could you|would you|will you|i want you to|i want to|i need you to|i need to|i would like to|i'd like to|we need to|we want to|we should|let's|lets|help me|go ahead and|and)\b[\s,:-]*/i;
const USE_X_TO = /^use\s+\S+(?:\s+\S+)?\s+to\b[\s,:-]*/i;
const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** A title from the first message alone: no filler, the first clause, six words, Title Case. */
export function heuristicTitle(message: string): string | null {
  let t = message.trim().replace(/```[\s\S]*?```/g, " ");
  t = (t.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
  for (let i = 0; i < 8; i++) {
    const next = t.replace(FILLER, "").replace(USE_X_TO, "");
    if (next === t) break;
    t = next.trim();
  }
  t = t.split(/[.,;:!?]\s|\s[-–—]\s|\s\(/)[0] ?? "";
  const words = t
    .replace(/[`*_#>"“”]+/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  while (words.length > 1 && SMALL.has(words[words.length - 1]!.toLowerCase())) words.pop();
  if (words.length === 0) return null;
  const cased = words.map((w, i) => {
    if (/[A-Z]/.test(w.slice(1)) || /\d/.test(w) || /[/.@]/.test(w)) return w;
    const lower = w.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  return cleanTitle(cased.join(" "));
}

/** The real call: the Agent SDK, Haiku, no tools, one turn, nothing written to the person's projects. */
export function defaultTitleCall(): TitleModelCall {
  return async ({ prompt, system, signal }) => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    const model = titleModel();
    const query = sdk.query({
      prompt,
      options: {
        // Outside any project, and not saved: a title call must never show up as a chat.
        cwd: os.tmpdir(),
        persistSession: false,
        ...(model ? { model } : {}),
        tools: [],
        allowedTools: [],
        maxTurns: 1,
        settingSources: [],
        systemPrompt: system,
        abortController: abort,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "squeak" },
      },
    } as never) as unknown as AsyncIterable<Record<string, unknown>>;
    let text = "";
    for await (const msg of query) {
      if (msg.type === "result") {
        if (msg.subtype === "success" && typeof msg.result === "string") return msg.result;
        throw new Error(`title call ended: ${String(msg.subtype)}`);
      }
      if (msg.type === "assistant") {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const b of content as Array<{ type?: string; text?: string }>) {
            if (b.type === "text" && typeof b.text === "string") text += b.text;
          }
        }
      }
    }
    if (text) return text;
    throw new Error("title call returned nothing");
  };
}

export interface AutoTitleStore {
  getSession(id: string): SessionRow | null;
  listSessions(): SessionRow[];
  firstUserText(id: string): string | null;
  setAutoTitle(id: string, title: string): boolean;
  markTitleTried(id: string): void;
  titleTried(id: string): boolean;
}

export interface AutoTitleOptions {
  store: AutoTitleStore;
  /** Told when a title was stored, so surfaces refresh. */
  onTitle: (sessionId: string, title: string) => void;
  call?: TitleModelCall;
  /** Defaults to the SQUEAK_AUTO_TITLE switch. */
  modelEnabled?: () => boolean;
  timeoutMs?: number;
  /** Pause between backfilled chats. */
  gapMs?: number;
}

/** Names chats that have no title, in the background, one at a time. Never throws, never delays a send. */
export class AutoTitler {
  private readonly call: TitleModelCall;
  private readonly queue: string[] = [];
  private running: Promise<void> | null = null;
  private readonly queued = new Set<string>();

  constructor(private readonly options: AutoTitleOptions) {
    this.call = options.call ?? defaultTitleCall();
  }

  /** Queue one chat (its first message was just accepted). */
  request(sessionId: string): void {
    if (this.queued.has(sessionId)) return;
    this.queued.add(sessionId);
    this.queue.push(sessionId);
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  /** At start: the newest chats with no title and a user message, each attempted once ever. */
  backfill(): string[] {
    const picked = this.options.store
      .listSessions()
      .filter((s) => !s.title && !s.archivedAt && !this.options.store.titleTried(s.id))
      .filter((s) => this.options.store.firstUserText(s.id) !== null)
      .slice(0, BACKFILL_LIMIT)
      .map((s) => s.id);
    for (const id of picked) this.request(id);
    return picked;
  }

  /** Resolves when everything queued so far is done (tests). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      try {
        await this.name(id);
      } catch (error) {
        logger.warn("auto title failed", { error: error instanceof Error ? error.message : String(error) });
      }
      this.queued.delete(id);
      if (this.queue.length > 0 && (this.options.gapMs ?? 1500) > 0) {
        await new Promise((r) => setTimeout(r, this.options.gapMs ?? 1500));
      }
    }
  }

  private async name(id: string): Promise<void> {
    const { store } = this.options;
    const s = store.getSession(id);
    if (!s || s.title) return;
    const first = store.firstUserText(id);
    if (!first) return;
    store.markTitleTried(id);
    let title: string | null = null;
    if ((this.options.modelEnabled ?? (() => flag("autoTitle")))()) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? TITLE_TIMEOUT_MS);
      try {
        const timedOut = new Promise<never>((_, reject) =>
          abort.signal.addEventListener("abort", () => reject(new Error("title call timed out")), { once: true }),
        );
        title = cleanTitle(
          await Promise.race([
            this.call({ prompt: titlePrompt(first), system: TITLE_SYSTEM, signal: abort.signal }),
            timedOut,
          ]),
        );
      } catch {
        title = null;
      } finally {
        clearTimeout(timer);
      }
    }
    title ??= heuristicTitle(first);
    if (!title) return;
    // The person may have renamed while the call ran: setAutoTitle only fills an empty title.
    if (store.setAutoTitle(id, title)) this.options.onTitle(id, title);
  }
}
