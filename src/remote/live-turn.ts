import crypto from "node:crypto";

import type { Activity } from "../fleet/activity.js";
import { logger } from "../utils/logger.js";

/**
 * The phone's verbose view: the whole current turn of the one session a
 * phone has open, thinking included, as it happens.
 *
 * The snapshot gives every session's newest six steps clipped to 200
 * characters (docs/remote-channel.md: what leaves the Mac is only what the
 * phone renders). Verbose is the exception the owner asks for on the phone,
 * and it is kept as narrow as it can be:
 *
 * - only while a phone is open, says it wants it, and is looking at that
 *   session (its sealed presence names it);
 * - one document per watched session, overwritten in place, never a history;
 * - deleted the moment nobody is watching, so a turn's thinking does not sit
 *   in the database afterwards;
 * - at most one write a second, and none when nothing changed.
 *
 * Like everything on the channel it is sealed with the channel key.
 */

export const LIVE_STEPS = 50;
export const LIVE_STEP_CHARS = 4_000;
/** The transcript is read this often while watched; a write needs a change too. */
export const LIVE_INTERVAL_MS = 1_000;

export interface LiveTurn {
  v: 1;
  key: string;
  working: boolean;
  /** How many steps the turn has had; `steps` is the newest LIVE_STEPS of them. */
  total: number;
  steps: Array<{ kind: string; text: string; at: string | null }>;
}

export interface LiveTurnDependencies {
  /** The session's current turn, read with whole steps; null when it is gone. */
  read: (sessionKey: string) => { activity: Activity | null; working: boolean } | null;
  write: (handle: string, turn: LiveTurn) => Promise<void>;
  clear: (handle: string) => Promise<void>;
}

/** A session key as a document id: fixed length, no `:` or `/`, and not the key itself. */
export function liveHandle(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("base64url").slice(0, 22);
}

export class LiveTurnPublisher {
  private readonly deps: LiveTurnDependencies;
  private watched: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = "";
  private running = false;

  constructor(deps: LiveTurnDependencies) {
    this.deps = deps;
  }

  /** Which session a phone is watching in verbose mode, or null for none. Idempotent. */
  watch(sessionKey: string | null): void {
    if (sessionKey === this.watched) {
      return;
    }
    const previous = this.watched;
    this.watched = sessionKey;
    this.last = "";
    if (previous) {
      void this.deps.clear(liveHandle(previous)).catch((error: unknown) => {
        logger.warn("live turn clear failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (sessionKey) {
      void this.publish();
      this.timer = setInterval(() => void this.publish(), LIVE_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.watch(null);
  }

  /** One look at the watched session; writes only what changed. Never throws. */
  async publish(): Promise<void> {
    const key = this.watched;
    if (!key || this.running) {
      return;
    }
    this.running = true;
    try {
      const read = this.deps.read(key);
      const activity = read?.activity;
      const turn: LiveTurn = {
        v: 1,
        key,
        working: read?.working ?? false,
        total: activity?.total ?? 0,
        steps: (activity?.steps ?? []).slice(-LIVE_STEPS).map((step) => ({
          kind: step.kind,
          text:
            step.text.length > LIVE_STEP_CHARS ? `${step.text.slice(0, LIVE_STEP_CHARS - 1).trimEnd()}…` : step.text,
          at: step.at,
        })),
      };
      const serialized = JSON.stringify(turn);
      if (serialized === this.last) {
        return;
      }
      await this.deps.write(liveHandle(key), turn);
      // A watch that moved on while this was writing must not leave this behind.
      if (this.watched === key) {
        this.last = serialized;
      } else {
        await this.deps.clear(liveHandle(key));
      }
    } catch (error) {
      logger.warn("live turn publish failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
