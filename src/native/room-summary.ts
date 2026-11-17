import { flag } from "../squeak/flags.js";
import { logger } from "../utils/logger.js";
import { defaultTitleCall, TITLE_TIMEOUT_MS, type TitleModelCall } from "./auto-title.js";
import type { HostEvent } from "./host.js";
import { projectOfSession, type HostEvents, type Room } from "./room.js";
import type { NativeStore } from "./store.js";

/**
 * Fallback for agents that do not post: while a chat works and someone is looking at its pond's room, one small
 * Haiku call turns the turn's prompt and its latest step labels (never raw tool input) into a `working` line posted
 * on the chat's behalf. A failure posts nothing.
 */

export const SUMMARY_QUIET_MS = 90_000;
export const SUMMARY_MIN_STEPS = 3;
export const SUMMARY_EVERY_MS = 3 * 60_000;
const MAX_WORDS = 12;
const KEEP_LABELS = 8;

export const SUMMARY_SYSTEM = [
  "You write one status line for a team room saying what a coding agent is working on right now.",
  "Reply with the line only: present tense, at most 12 words, no quotes, no markdown, no trailing punctuation.",
  'Say the intent, not the commands. Example: "Wiring retry into the uploader".',
].join(" ");

export function summaryPrompt(prompt: string, labels: string[]): string {
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);
  return [
    `What the person asked:\n${clip(prompt.trim(), 800)}`,
    `The agent's latest steps:\n${labels.map((l) => `- ${clip(l, 120)}`).join("\n")}`,
    "Status line:",
  ].join("\n\n");
}

/** The model's answer as a status line, or null: one line, at most 12 words. */
export function cleanSummary(raw: string): string | null {
  const first = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = first
    .replace(/[`*_#>"“”]+/g, "")
    .replace(/^\s*(?:status(?: line)?)\s*:\s*/i, "")
    .replace(/[\s.,;:!?…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  const words = t.split(" ");
  return (words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(" ") : t) || null;
}

export interface RoomSummariserOptions {
  host: HostEvents;
  store: NativeStore;
  room: Room;
  call?: TitleModelCall;
  /** Defaults to the SQUEAK_ROOM_SUMMARY switch. */
  enabled?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
}

interface Track {
  prompt: string;
  labels: string[];
  steps: number;
  lastSummaryAt: number;
}

export class RoomSummariser {
  private readonly tracks = new Map<string, Track>();
  private readonly running = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly call: TitleModelCall;
  private readonly now: () => number;
  private detach: (() => void) | null = null;

  constructor(private readonly o: RoomSummariserOptions) {
    this.call = o.call ?? defaultTitleCall();
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const onEvent = (e: HostEvent): void => {
      if (e.type !== "timeline" || !("type" in e.event)) return;
      const ev = e.event;
      const t = this.track(e.sessionId);
      if (ev.type === "turn.started") {
        t.prompt = ev.text;
        t.labels = [];
        t.steps = 0;
      } else if (ev.type === "step.added") {
        t.steps += 1;
        t.labels.push(ev.label);
        if (t.labels.length > KEEP_LABELS) t.labels.shift();
        this.consider(e.sessionId);
      }
    };
    this.o.host.on("event", onEvent);
    // Any `working` post about a chat (its own, or ours) restarts the count.
    const onPost = (p: { kind: string; sessionId: string | null }): void => {
      if (p.kind === "working" && p.sessionId) this.track(p.sessionId).steps = 0;
    };
    this.o.room.on("post", onPost);
    this.detach = () => {
      this.o.host.off("event", onEvent);
      this.o.room.off("post", onPost);
    };
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
  }

  /** Resolves when every call started so far is done (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { prompt: "", labels: [], steps: 0, lastSummaryAt: 0 };
      this.tracks.set(id, t);
    }
    return t;
  }

  private consider(sessionId: string): void {
    try {
      if (!(this.o.enabled ?? (() => flag("roomSummary")))()) return;
      const t = this.track(sessionId);
      if (t.steps < SUMMARY_MIN_STEPS) return;
      const now = this.now();
      if (now - t.lastSummaryAt < SUMMARY_EVERY_MS) return;
      const s = this.o.store.getSession(sessionId);
      if (!s || s.status !== "working") return;
      const pond = projectOfSession(this.o.store, s);
      if (!pond || !this.o.room.recentlyViewed(pond.id) || this.running.has(pond.id)) return;
      const last = this.o.store.latestRoomMarks(pond.id).get(sessionId)?.working;
      if (last && now - last.at < SUMMARY_QUIET_MS) return;
      t.lastSummaryAt = now;
      this.running.add(pond.id);
      const done = this.summarise(sessionId, pond.id, t.prompt, [...t.labels]).finally(() => {
        this.running.delete(pond.id);
        this.inflight.delete(done);
      });
      this.inflight.add(done);
    } catch (error) {
      logger.warn("room summary skipped", { error: String(error) });
    }
  }

  private async summarise(sessionId: string, projectId: string, prompt: string, labels: string[]): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.o.timeoutMs ?? TITLE_TIMEOUT_MS);
    try {
      const timedOut = new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("summary timed out")), { once: true }),
      );
      const text = cleanSummary(
        await Promise.race([
          this.call({ prompt: summaryPrompt(prompt, labels), system: SUMMARY_SYSTEM, signal: abort.signal }),
          timedOut,
        ]),
      );
      if (!text) return;
      const s = this.o.store.getSession(sessionId);
      // The turn may have ended, or the agent posted its own line, while the call ran.
      if (!s || s.status !== "working") return;
      const last = this.o.store.latestRoomMarks(projectId).get(sessionId)?.working;
      if (last && this.now() - last.at < SUMMARY_QUIET_MS) return;
      this.o.room.post({
        projectId,
        author: { kind: "squeak", name: s.title?.trim() || "Claude" },
        sessionId,
        kind: "working",
        text,
      });
    } catch (error) {
      logger.warn("room summary failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}
