import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { asRecord, asString, parseJsonLines, readTailLines } from "./observers/tail.js";

export interface CodexUsageWindow {
  usedPercent: number;
  windowMinutes: number;
  /** ISO instant; Codex reports this as a unix seconds timestamp. */
  resetsAt: string;
}

/**
 * OpenAI's account-wide rate limit state, as Codex itself last reported it.
 * Not per-session — the 5-hour and weekly windows are shared across every
 * Codex thread on the account, so this is one global answer, not one per
 * session the way git state or context pressure are.
 */
export interface CodexUsage {
  planType: string | null;
  /** The 5-hour rolling window. */
  primary: CodexUsageWindow | null;
  /** The 7-day rolling window. */
  secondary: CodexUsageWindow | null;
  hasCredits: boolean;
  creditBalance: number | null;
  observedAt: string;
}

export interface CodexUsageReaderOptions {
  codexHome?: string;
  ttlMs?: number;
  /** How many of the most recently modified rollouts to check before giving up. */
  maxFilesToScan?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_FILES = 5;

/**
 * Reads OpenAI's own rate-limit report back out of Codex's rollout files.
 *
 * Codex logs `rate_limits` on every `token_count` event, and it is a full
 * account snapshot each time — reading the single most recent one is exactly
 * as current as asking the API, at the cost of one file read instead of a
 * network call and without needing any credential of our own. Claude Code
 * never writes the equivalent to disk, only to the live stream of whichever
 * process spawned it; Claude's limits come from a manual Refresh that reads
 * its usage endpoint with Claude Code's own sign-in (`claude-usage-api.ts`).
 */
export class CodexUsageReader {
  private readonly codexHome: string;
  private readonly ttlMs: number;
  private readonly maxFilesToScan: number;
  private readonly now: () => number;
  private cached: { expiresAt: number; usage: CodexUsage | null } | null = null;

  constructor(options: CodexUsageReaderOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxFilesToScan = options.maxFilesToScan ?? DEFAULT_MAX_FILES;
    this.now = options.now ?? Date.now;
  }

  read(): CodexUsage | null {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return this.cached.usage;
    }

    const usage = this.readFresh();
    this.cached = { expiresAt: this.now() + this.ttlMs, usage };
    return usage;
  }

  private readFresh(): CodexUsage | null {
    for (const file of this.recentRollouts()) {
      const usage = this.readFromFile(file);
      if (usage) {
        return usage;
      }
    }
    return null;
  }

  private readFromFile(filePath: string): CodexUsage | null {
    const entries = parseJsonLines(readTailLines(filePath));

    // Walk backwards: the most recent populated rate_limits in the file is
    // the one that matters, and most lines in a rollout are not this event.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry || asString(entry.type) !== "event_msg") {
        continue;
      }
      const payload = asRecord(entry.payload);
      if (!payload || asString(payload.type) !== "token_count") {
        continue;
      }
      // Sibling of `info` on the payload, not nested inside it.
      const rateLimits = asRecord(payload.rate_limits);
      if (!rateLimits) {
        continue;
      }
      return {
        planType: asString(rateLimits.plan_type),
        primary: parseWindow(rateLimits.primary),
        secondary: parseWindow(rateLimits.secondary),
        hasCredits: asRecord(rateLimits.credits)?.has_credits === true,
        creditBalance:
          typeof asRecord(rateLimits.credits)?.balance === "number"
            ? (asRecord(rateLimits.credits)?.balance as number)
            : null,
        observedAt: asString(entry.timestamp) ?? new Date(this.now()).toISOString(),
      };
    }
    return null;
  }

  private recentRollouts(): string[] {
    const root = path.join(this.codexHome, "sessions");
    const found: { file: string; mtimeMs: number }[] = [];

    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) {
            walk(entryPath, depth + 1);
          }
          continue;
        }
        if (!entry.name.endsWith(".jsonl")) {
          continue;
        }
        try {
          found.push({ file: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
        } catch {
          // Can vanish between readdir and stat; skip it.
        }
      }
    };
    walk(root, 0);

    return found
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, this.maxFilesToScan)
      .map((entry) => entry.file);
  }
}

function parseWindow(value: unknown): CodexUsageWindow | null {
  const record = asRecord(value);
  if (!record || typeof record.used_percent !== "number" || typeof record.window_minutes !== "number") {
    return null;
  }
  const resetsAtSeconds = record.resets_at;
  if (typeof resetsAtSeconds !== "number") {
    return null;
  }
  return {
    usedPercent: record.used_percent,
    windowMinutes: record.window_minutes,
    resetsAt: new Date(resetsAtSeconds * 1000).toISOString(),
  };
}

/** e.g. "5h" for the primary window, "7d" for the secondary. */
export function describeWindowSpan(windowMinutes: number): string {
  if (windowMinutes % (24 * 60) === 0) {
    return `${windowMinutes / (24 * 60)}d`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}
