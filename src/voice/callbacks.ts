import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FleetSession } from "../fleet/types.js";
import { logger } from "../utils/logger.js";

/**
 * "Call me back when you're done": a request made on a call, kept in `voice-callbacks.json` (0600, atomic write) so a
 * restart keeps it. One per chat. It holds a reply target, the chat's spoken name and a short note in the person's
 * words, never a PIN or a transcript. `VoiceChannel` watches the fleet and rings once the chat's work has ended.
 */

export const CALLBACK_TTL_MS = 12 * 60 * 60_000;
/** A request made together with a message waits this long for the chat to start working before it is dropped. */
export const CALLBACK_START_MS = 10 * 60_000;
export const MAX_CALLBACKS = 20;
const MAX_NOTE = 120;

export interface CallbackRequest {
  id: string;
  target: string;
  label: string;
  /** What the person is waiting for, in their words (clipped); empty when they did not say. */
  note: string;
  at: number;
  /** The chat has been seen working since the request: its next stop is the end of the work. */
  seenWorking: boolean;
}

export type CallbackVerdict = "wait" | "fire" | "drop";

/** What to do with a request given the chat as it is now (null: the chat is gone). Pure. */
export function judgeCallback(request: CallbackRequest, session: FleetSession | null, now: number): CallbackVerdict {
  if (now - request.at > CALLBACK_TTL_MS) return "drop";
  if (!session) return "drop";
  if (session.state === "working") return "wait";
  if (request.seenWorking) return "fire";
  // Not seen working yet: a message was just sent and the chat has not picked it up, or it never will.
  return now - request.at > CALLBACK_START_MS ? "drop" : "wait";
}

const clipNote = (note: string): string =>
  note
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE);

export class CallbackRequests {
  private requests: CallbackRequest[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  /** Adds the chat's request, replacing an earlier one for the same chat. Null when there are too many. */
  add(target: string, label: string, note: string, working: boolean): CallbackRequest | null {
    if (!target || target.length > 300) return null;
    this.requests = this.requests.filter((request) => request.target !== target);
    if (this.requests.length >= MAX_CALLBACKS) return null;
    const request: CallbackRequest = {
      id: crypto.randomBytes(9).toString("base64url"),
      target,
      label: label.slice(0, 80),
      note: clipNote(note),
      at: this.now(),
      seenWorking: working,
    };
    this.requests.push(request);
    this.save();
    return { ...request };
  }

  list(): CallbackRequest[] {
    return this.requests.map((request) => ({ ...request }));
  }

  has(target: string): boolean {
    return this.requests.some((request) => request.target === target);
  }

  markWorking(id: string): void {
    const request = this.requests.find((candidate) => candidate.id === id);
    if (!request || request.seenWorking) return;
    request.seenWorking = true;
    this.save();
  }

  remove(id: string): void {
    const before = this.requests.length;
    this.requests = this.requests.filter((request) => request.id !== id);
    if (this.requests.length !== before) this.save();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { requests?: unknown };
      if (!Array.isArray(raw.requests)) return;
      for (const item of raw.requests as unknown[]) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        if (
          typeof r.id === "string" &&
          typeof r.target === "string" &&
          typeof r.label === "string" &&
          typeof r.at === "number" &&
          Number.isFinite(r.at)
        ) {
          this.requests.push({
            id: r.id.slice(0, 32),
            target: r.target.slice(0, 300),
            label: r.label.slice(0, 80),
            note: typeof r.note === "string" ? clipNote(r.note) : "",
            at: r.at,
            seenWorking: r.seenWorking === true,
          });
        }
      }
      this.requests = this.requests.slice(0, MAX_CALLBACKS);
    } catch {
      // None yet, or unreadable: start empty.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ v: 1, requests: this.requests })}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice callbacks could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
