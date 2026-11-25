import os from "node:os";

import { withSystemProxyEnv } from "../squeak/system-proxy.js";
import { flag } from "../squeak/flags.js";
import { loadAgentSdkIfPresent } from "./agent-sdk.js";
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
    // Never triggers the download: without the SDK the caller falls back to the heuristic title.
    const sdk = await loadAgentSdkIfPresent();
    if (!sdk) throw new Error("Claude's agent kit is not installed yet");
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
        env: withSystemProxyEnv({ ...process.env, CLAUDE_CODE_ENTRYPOINT: "squeak" }),
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

export const RETITLE_SYSTEM = [
  "You name chats for the person who owns them. Reply with the title only: 3 to 6 plain words, no quotes, no markdown, no trailing punctuation.",
  "Say what the chat is for, the work and its subject, the way a colleague would name it: not the first instruction, not a sentence, no filler.",
  "Keep proper nouns as written. Use Title Case unless the person's own words are clearly written otherwise.",
  'Examples: "Zoom Marketplace review fixes", "Login redirect bug", "Tab strip and rail polish".',
  "If the current title already describes the work well, reply with it unchanged.",
].join(" ");

/** Real tool work: a chat's agent made at least this many tool calls, so what the chat is for is clear. */
export const REAL_WORK_TOOL_CALLS = 3;
/** The one-time pass at start: at most this many weak titles are rewritten. */
export const RETITLE_BACKFILL_LIMIT = 12;
const WEAK_LENGTH = 48;

export function retitlePrompt(current: string | null, first: string, reply: string | null): string {
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);
  const parts: string[] = [];
  if (current) parts.push(`Current title: ${current}`);
  parts.push(`First message:\n${clip(first.trim(), 1200)}`);
  if (reply?.trim()) parts.push(`The agent's latest reply:\n${clip(reply.trim(), 800)}`);
  parts.push("Title:");
  return parts.join("\n\n");
}

/** A title that is a placeholder or a copy of the prompt: "New chat", empty, long, cut with "…", or the first line itself. */
export function looksWeak(title: string | null, first: string | null): boolean {
  const t = (title ?? "").trim();
  if (!t || /^(?:new (?:chat|task|thread)|untitled(?: chat)?|chat)$/i.test(t)) return true;
  if (t.length > WEAK_LENGTH || t.endsWith("…") || t.endsWith("...")) return true;
  const line = (first ?? "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  return line.length > 0 && line.toLowerCase().startsWith(t.toLowerCase()) && t.split(/\s+/).length >= 4;
}

export interface AutoTitleStore {
  getSession(id: string): SessionRow | null;
  listSessions(): SessionRow[];
  firstUserText(id: string): string | null;
  setAutoTitle(id: string, title: string): boolean;
  markTitleTried(id: string): void;
  titleTried(id: string): boolean;
  replaceAutoTitle(id: string, expected: string | null, title: string): boolean;
  titleIsMine(id: string): boolean;
  titleStage(id: string): number;
  setTitleStage(id: string, stage: number): void;
  toolUseCount(id: string): number;
  lastAgentText(id: string): string | null;
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

  /**
   * A turn finished well. The first one with real tool work retitles the chat from what it did (stage 1); a title the
   * person set is never touched. Fire and forget, never throws.
   */
  turnFinished(sessionId: string): void {
    const { store } = this.options;
    if (!store.getSession(sessionId) || store.titleStage(sessionId) >= 1) return;
    if (store.toolUseCount(sessionId) < REAL_WORK_TOOL_CALLS) return;
    this.requestRetitle(sessionId, 1);
  }

  /** A Task finished in this chat: look again, and retitle only if the scope shifted (stage 2, once). */
  taskDone(sessionId: string): void {
    const { store } = this.options;
    if (!store.getSession(sessionId) || store.titleStage(sessionId) >= 2) return;
    this.requestRetitle(sessionId, 2);
  }

  /** At start: the newest chats still titled "New chat" or with a copy of their prompt, once each, capped. */
  backfillWeak(): string[] {
    const { store } = this.options;
    const picked = store
      .listSessions()
      .filter((s) => s.title && !store.titleIsMine(s.id) && store.titleStage(s.id) === 0)
      .filter((s) => {
        const first = store.firstUserText(s.id);
        return first !== null && looksWeak(s.title, first);
      })
      .slice(0, RETITLE_BACKFILL_LIMIT)
      .map((s) => s.id);
    for (const id of picked) this.requestRetitle(id, 1);
    return picked;
  }

  private requestRetitle(sessionId: string, stage: number): void {
    const key = `r${stage}:${sessionId}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when everything queued so far is done (tests). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      try {
        const m = /^r(\d):(.+)$/.exec(id);
        if (m) await this.rename(m[2]!, Number(m[1]));
        else await this.name(id);
      } catch (error) {
        logger.warn("auto title failed", { error: error instanceof Error ? error.message : String(error) });
      }
      this.queued.delete(id);
      if (this.queue.length > 0 && (this.options.gapMs ?? 1500) > 0) {
        await new Promise((r) => setTimeout(r, this.options.gapMs ?? 1500));
      }
    }
  }

  /** Rewrites an automatic or weak title from the work done. A title the person set, or a failing model, changes nothing. */
  private async rename(id: string, stage: number): Promise<void> {
    const { store } = this.options;
    const s = store.getSession(id);
    const first = store.firstUserText(id);
    if (!s || !first || store.titleStage(id) >= stage || store.titleIsMine(id)) return;
    // An older chat that never recorded who named it counts as the person's unless it is still a placeholder or a copy.
    if (!s.titleAuto && s.title && !looksWeak(s.title, first)) return;
    store.setTitleStage(id, stage);
    if (!(this.options.modelEnabled ?? (() => flag("autoTitle")))()) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? TITLE_TIMEOUT_MS);
    let title: string | null = null;
    try {
      const timedOut = new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("title call timed out")), { once: true }),
      );
      title = cleanTitle(
        await Promise.race([
          this.call({
            prompt: retitlePrompt(s.title, first, store.lastAgentText(id)),
            system: RETITLE_SYSTEM,
            signal: abort.signal,
          }),
          timedOut,
        ]),
      );
    } catch {
      title = null;
    } finally {
      clearTimeout(timer);
    }
    if (!title || title === s.title) return;
    // The person may have renamed while the call ran: replaceAutoTitle only swaps the title it read.
    if (store.replaceAutoTitle(id, s.title, title)) this.options.onTitle(id, title);
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
