import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * Every phone call Squeak made, for the apps' Calls page (docs: .context/calls-page-contract.md). Kept on this Mac
 * only, `voice-calls.json` (0600, atomic write), newest 200. It never holds a question's text, a PIN or any key
 * but the answer letter.
 */

export const MAX_CALLS = 200;
export const DEFAULT_LIST = 100;

export type CallKind = "agent" | "test" | "incoming";
export type CallReason = "blocked_approval" | "blocked_question" | "asked_question";
export type CallOutcome = "answered" | "unanswered" | "failed" | "moved_on";

export interface CallEntry {
  id: string;
  /** When the call was placed, ms. */
  at: number;
  kind: CallKind;
  reason?: CallReason;
  label?: string;
  outcome: CallOutcome;
  letter?: string;
  sent?: boolean;
  durationMs: number;
  failure?: string;
}

export type CallRecord = Omit<CallEntry, "id">;

const REASONS: ReadonlySet<string> = new Set(["blocked_approval", "blocked_question", "asked_question"]);
const OUTCOMES: ReadonlySet<string> = new Set(["answered", "unanswered", "failed", "moved_on"]);

/** Builds a clean entry from anything: only known fields, clipped, the letter only if it is a letter. */
function clean(raw: unknown, id: string): CallEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) return null;
  const entry: CallEntry = {
    id,
    at: r.at,
    kind: r.kind === "test" ? "test" : r.kind === "incoming" ? "incoming" : "agent",
    outcome: r.outcome as CallOutcome,
    durationMs: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0,
  };
  if (typeof r.reason === "string" && REASONS.has(r.reason)) entry.reason = r.reason as CallReason;
  if (entry.kind !== "test" && typeof r.label === "string" && r.label) entry.label = r.label.slice(0, 80);
  if (typeof r.letter === "string" && /^[A-Za-z]$/.test(r.letter)) entry.letter = r.letter;
  if (typeof r.sent === "boolean") entry.sent = r.sent;
  if (typeof r.failure === "string" && r.failure) entry.failure = r.failure.slice(0, 200);
  return entry;
}

export class CallHistory {
  private entries: CallEntry[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const list = Array.isArray((raw as { calls?: unknown } | null)?.calls)
        ? ((raw as { calls: unknown[] }).calls as unknown[])
        : [];
      for (const item of list) {
        const id = typeof (item as { id?: unknown } | null)?.id === "string" ? (item as { id: string }).id : null;
        const entry = id ? clean(item, id.slice(0, 32)) : null;
        if (entry) this.entries.push(entry);
      }
      this.entries.sort((a, b) => b.at - a.at);
      this.entries = this.entries.slice(0, MAX_CALLS);
    } catch {
      // None yet, or unreadable: start empty.
    }
  }

  /** Adds a call; returns it, or null when it is not a valid record or its given id is already recorded. */
  record(call: CallRecord, id?: string): CallEntry | null {
    if (id !== undefined && this.has(id)) return null;
    const entry = clean(call, id ? id.slice(0, 32) : crypto.randomBytes(8).toString("base64url"));
    if (!entry) return null;
    this.entries.push(entry);
    this.entries.sort((a, b) => b.at - a.at);
    this.entries = this.entries.slice(0, MAX_CALLS);
    this.save();
    return entry;
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id.slice(0, 32));
  }

  /** Newest first. */
  list(limit = DEFAULT_LIST): CallEntry[] {
    return this.entries.slice(0, Math.max(0, limit)).map((entry) => ({ ...entry }));
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ v: 1, calls: this.entries })}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("call history could not be saved", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
