import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";
import type { FleetSession } from "./types.js";

/** One archived thread: when the person archived it. The key is the fleet key (`claude:<id>`, `conductor:<id>`...). */
export interface ArchivedRecord {
  archivedAt: string;
}

/** A fleet key as the routes carry it: at most 120 characters of letters, digits and `_:-` (the control routes' own set). */
const KEY_RE = /^[A-Za-z0-9_:-]{1,120}$/;
/** The file never grows without bound: the newest records stay. */
const MAX_RECORDS = 5000;

export interface ArchivedSessionsOptions {
  /** `<support dir>/archived-sessions.json`. */
  file: string;
  now?: () => number;
}

/**
 * Squeak-side archive for every thread Squeak does not run itself (Conductor, terminal, Codex, desktop, headless):
 * hidden in Squeak only, kept in a small file keyed by fleet key. It never touches Conductor's database or an agent's
 * files. A Squeak chat's archive is the session host's own (`archived_at`), not this.
 */
export class ArchivedSessions {
  private readonly file: string;
  private readonly now: () => number;
  private records: Record<string, ArchivedRecord> = {};

  constructor(options: ArchivedSessionsOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.load();
  }

  static validKey(key: unknown): key is string {
    return typeof key === "string" && KEY_RE.test(key);
  }

  get(key: string): ArchivedRecord | undefined {
    return this.records[key];
  }

  list(): Array<{ key: string; archivedAt: string }> {
    return Object.entries(this.records).map(([key, record]) => ({ key, archivedAt: record.archivedAt }));
  }

  /** Archives a thread (a repeat keeps the first time). Returns false for a malformed key. */
  archive(key: string): boolean {
    if (!ArchivedSessions.validKey(key)) return false;
    if (!this.records[key]) {
      this.records[key] = { archivedAt: new Date(this.now()).toISOString() };
      this.prune();
      this.save();
    }
    return true;
  }

  unarchive(key: string): boolean {
    if (!ArchivedSessions.validKey(key)) return false;
    if (this.records[key]) {
      delete this.records[key];
      this.save();
    }
    return true;
  }

  /** Marks a snapshot's sessions: archived ones are `retired` (off every active list, no attention, no push). */
  apply(sessions: FleetSession[]): FleetSession[] {
    if (Object.keys(this.records).length === 0) return sessions;
    return sessions.map((session) => {
      // A Squeak chat is archived by the host; this store never overrides it.
      if (session.origin === "squeak") return session;
      const record = this.records[session.key];
      return record ? { ...session, retired: true, archivedAt: record.archivedAt } : session;
    });
  }

  private prune(): void {
    const entries = Object.entries(this.records);
    if (entries.length <= MAX_RECORDS) return;
    entries.sort((a, b) => Date.parse(b[1].archivedAt) - Date.parse(a[1].archivedAt));
    this.records = Object.fromEntries(entries.slice(0, MAX_RECORDS));
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as { archived?: unknown };
      const archived = parsed.archived;
      if (!archived || typeof archived !== "object" || Array.isArray(archived)) return;
      for (const [key, value] of Object.entries(archived)) {
        const at = (value as { archivedAt?: unknown } | null)?.archivedAt;
        if (ArchivedSessions.validKey(key) && typeof at === "string" && !Number.isNaN(Date.parse(at))) {
          this.records[key] = { archivedAt: at };
        }
      }
    } catch {
      // No file yet, or a bad one: start empty (archiving is a view preference, never worth failing for).
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, archived: this.records }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.warn("could not save archived sessions", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
