import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import type { AttentionKind, FleetState } from "./types.js";

export interface FleetSnapshotRow {
  sessionKey: string;
  state: FleetState;
  /** When the session first entered its current state, not when we last saw it. */
  stateEnteredAt: string;
  lastSeenAt: string;
  lastActivityAt: string;
}

export interface FleetReviewRow {
  sessionKey: string;
  reviewedAt: string | null;
  /** ISO instant before which this session stays out of the attention list. */
  snoozedUntil: string | null;
}

export interface RadarAnchor {
  chatId: number;
  messageThreadId: number;
  messageId: number;
}

/**
 * Fleet state lives in the same bridge.db as the rest of the bridge, on its
 * own connection. It is deliberately separate from BridgeStateStore: none of
 * this is conversation state, and keeping it apart means the fleet layer can
 * be tested against a throwaway database without standing up the bridge.
 */
export class FleetStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_snapshot (
        session_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        state_entered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_review (
        session_key TEXT PRIMARY KEY,
        reviewed_at TEXT,
        snoozed_until TEXT
      );

      CREATE TABLE IF NOT EXISTS fleet_notification (
        session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        state_entered_at TEXT NOT NULL,
        notified_at TEXT NOT NULL,
        PRIMARY KEY (session_key, kind)
      );

      CREATE TABLE IF NOT EXISTS fleet_radar (
        location_key TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        message_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS fleet_handle (
        handle INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS fleet_mute (
        scope TEXT PRIMARY KEY,
        muted_until TEXT
      );
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing twice during shutdown is harmless.
    }
  }

  getSnapshot(sessionKey: string): FleetSnapshotRow | null {
    const row = this.db
      .prepare(
        `SELECT session_key as sessionKey, state, state_entered_at as stateEnteredAt,
                last_seen_at as lastSeenAt, last_activity_at as lastActivityAt
         FROM fleet_snapshot WHERE session_key = ?`,
      )
      .get(sessionKey) as FleetSnapshotRow | undefined;
    return row ?? null;
  }

  /**
   * Record where a session is now and return when it got there. A state that
   * has not changed keeps its original entry time, which is what makes "has
   * been blocked for 12 minutes" possible.
   */
  recordState(params: { sessionKey: string; state: FleetState; lastActivityAt: string; observedAt: string }): {
    stateEnteredAt: string;
    changed: boolean;
  } {
    const existing = this.getSnapshot(params.sessionKey);
    const changed = !existing || existing.state !== params.state;
    const stateEnteredAt = changed ? params.observedAt : existing.stateEnteredAt;

    this.db
      .prepare(
        `INSERT INTO fleet_snapshot (session_key, state, state_entered_at, last_seen_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           state = excluded.state,
           state_entered_at = excluded.state_entered_at,
           last_seen_at = excluded.last_seen_at,
           last_activity_at = excluded.last_activity_at`,
      )
      .run(params.sessionKey, params.state, stateEnteredAt, params.observedAt, params.lastActivityAt);

    // Leaving a state means whatever the human did about it no longer applies:
    // a session they reviewed and then poked again is unreviewed once more.
    if (changed) {
      this.db.prepare(`DELETE FROM fleet_review WHERE session_key = ?`).run(params.sessionKey);
    }

    return { stateEnteredAt, changed };
  }

  /** Drop snapshots for sessions that have aged out of every observer. */
  pruneSnapshots(keepKeys: ReadonlySet<string>, notSeenSince: string): number {
    const stale = this.db
      .prepare(`SELECT session_key as sessionKey FROM fleet_snapshot WHERE last_seen_at < ?`)
      .all(notSeenSince) as { sessionKey: string }[];

    let removed = 0;
    for (const row of stale) {
      if (keepKeys.has(row.sessionKey)) {
        continue;
      }
      this.db.prepare(`DELETE FROM fleet_snapshot WHERE session_key = ?`).run(row.sessionKey);
      this.db.prepare(`DELETE FROM fleet_notification WHERE session_key = ?`).run(row.sessionKey);
      this.db.prepare(`DELETE FROM fleet_review WHERE session_key = ?`).run(row.sessionKey);
      removed += 1;
    }
    return removed;
  }

  /**
   * A short integer alias for a session key.
   *
   * Telegram caps callback_data at 64 bytes and a session key is a source name
   * plus a UUID, which does not fit once a verb is prefixed. Handles are
   * allocated once and never reused, so a button stays valid across restarts.
   */
  handleFor(sessionKey: string): number {
    const existing = this.db.prepare(`SELECT handle FROM fleet_handle WHERE session_key = ?`).get(sessionKey) as
      | { handle: number }
      | undefined;
    if (existing) {
      return existing.handle;
    }
    const result = this.db.prepare(`INSERT INTO fleet_handle (session_key) VALUES (?)`).run(sessionKey);
    return Number(result.lastInsertRowid);
  }

  keyForHandle(handle: number): string | null {
    const row = this.db.prepare(`SELECT session_key as sessionKey FROM fleet_handle WHERE handle = ?`).get(handle) as
      | { sessionKey: string }
      | undefined;
    return row?.sessionKey ?? null;
  }

  getReview(sessionKey: string): FleetReviewRow | null {
    const row = this.db
      .prepare(
        `SELECT session_key as sessionKey, reviewed_at as reviewedAt, snoozed_until as snoozedUntil
         FROM fleet_review WHERE session_key = ?`,
      )
      .get(sessionKey) as FleetReviewRow | undefined;
    return row ?? null;
  }

  markReviewed(sessionKey: string, reviewedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO fleet_review (session_key, reviewed_at, snoozed_until)
         VALUES (?, ?, NULL)
         ON CONFLICT(session_key) DO UPDATE SET reviewed_at = excluded.reviewed_at`,
      )
      .run(sessionKey, reviewedAt);
  }

  snooze(sessionKey: string, snoozedUntil: string): void {
    this.db
      .prepare(
        `INSERT INTO fleet_review (session_key, reviewed_at, snoozed_until)
         VALUES (?, NULL, ?)
         ON CONFLICT(session_key) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
      )
      .run(sessionKey, snoozedUntil);
  }

  /**
   * True the first time a session enters a state worth pushing. Keyed on the
   * state entry time so re-entering the same state notifies again, but a
   * session sitting blocked across twenty poll ticks does not.
   */
  claimNotification(params: {
    sessionKey: string;
    kind: AttentionKind;
    stateEnteredAt: string;
    notifiedAt: string;
  }): boolean {
    const existing = this.db
      .prepare(`SELECT state_entered_at as stateEnteredAt FROM fleet_notification WHERE session_key = ? AND kind = ?`)
      .get(params.sessionKey, params.kind) as { stateEnteredAt: string } | undefined;

    if (existing && existing.stateEnteredAt === params.stateEnteredAt) {
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO fleet_notification (session_key, kind, state_entered_at, notified_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key, kind) DO UPDATE SET
           state_entered_at = excluded.state_entered_at,
           notified_at = excluded.notified_at`,
      )
      .run(params.sessionKey, params.kind, params.stateEnteredAt, params.notifiedAt);

    return true;
  }

  listRadarAnchors(): RadarAnchor[] {
    return this.db
      .prepare(
        `SELECT chat_id as chatId, message_thread_id as messageThreadId, message_id as messageId FROM fleet_radar`,
      )
      .all() as RadarAnchor[];
  }

  getRadarAnchor(chatId: number, messageThreadId: number | null): RadarAnchor | null {
    const row = this.db
      .prepare(
        `SELECT chat_id as chatId, message_thread_id as messageThreadId, message_id as messageId
         FROM fleet_radar WHERE location_key = ?`,
      )
      .get(radarLocationKey(chatId, messageThreadId)) as RadarAnchor | undefined;
    return row ?? null;
  }

  setRadarAnchor(chatId: number, messageThreadId: number | null, messageId: number): void {
    this.db
      .prepare(
        `INSERT INTO fleet_radar (location_key, chat_id, message_thread_id, message_id, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(location_key) DO UPDATE SET
           message_id = excluded.message_id,
           updated_at = excluded.updated_at`,
      )
      .run(radarLocationKey(chatId, messageThreadId), chatId, messageThreadId ?? 0, messageId);
  }

  clearRadarAnchor(chatId: number, messageThreadId: number | null): void {
    this.db.prepare(`DELETE FROM fleet_radar WHERE location_key = ?`).run(radarLocationKey(chatId, messageThreadId));
  }

  /** `scope` is a repo name, or `*` for everything. */
  isMuted(scope: string, atIso: string): boolean {
    const row = this.db.prepare(`SELECT muted_until as mutedUntil FROM fleet_mute WHERE scope = ?`).get(scope) as
      | { mutedUntil: string | null }
      | undefined;
    if (!row) {
      return false;
    }
    return row.mutedUntil === null || row.mutedUntil > atIso;
  }

  setMute(scope: string, mutedUntil: string | null): void {
    this.db
      .prepare(
        `INSERT INTO fleet_mute (scope, muted_until) VALUES (?, ?)
         ON CONFLICT(scope) DO UPDATE SET muted_until = excluded.muted_until`,
      )
      .run(scope, mutedUntil);
  }

  clearMute(scope: string): void {
    this.db.prepare(`DELETE FROM fleet_mute WHERE scope = ?`).run(scope);
  }
}

export function radarLocationKey(chatId: number, messageThreadId: number | null): string {
  return `${chatId}:${messageThreadId ?? 0}`;
}
