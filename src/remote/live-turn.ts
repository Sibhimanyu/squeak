import crypto from "node:crypto";

import type { Activity } from "../fleet/activity.js";
import type { QueueItem } from "../fleet/session-reply.js";
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
 *
 * It also carries the chat's Conductor queue (messages sent while the agent
 * works, waiting for the turn to end), so the phone can show them above its
 * composer with Steer now and Delete. Read over the loopback relay each tick.
 */

export const LIVE_STEPS = 50;
export const LIVE_STEP_CHARS = 4_000;
/** The transcript is read this often while watched; a write needs a change too. */
export const LIVE_INTERVAL_MS = 1_000;
export const LIVE_QUEUE_TEXT_CHARS = 2_000;
/** The relay is loopback; a read slower than this is treated as unreadable so the turn still publishes. */
const QUEUE_READ_TIMEOUT_MS = 2_000;

export interface LiveTurn {
  v: 1;
  key: string;
  working: boolean;
  /** How many steps the turn has had; `steps` is the newest LIVE_STEPS of them. */
  total: number;
  steps: Array<{ kind: string; text: string; at: string | null }>;
  /**
   * Conductor's queue for this chat, in order. Absent when the Mac cannot
   * read it (relay down, not a Conductor chat): the phone then keeps its own
   * list. `[]` means the queue is empty.
   */
  queue?: QueueItem[];
}

export interface LiveTurnDependencies {
  /** The session's current turn, read with whole steps; null when it is gone. */
  read: (sessionKey: string) => { activity: Activity | null; working: boolean } | null;
  write: (handle: string, turn: LiveTurn) => Promise<void>;
  clear: (handle: string) => Promise<void>;
  /** The chat's Conductor queue; null when it cannot be read. */
  queue?: ((sessionKey: string) => Promise<QueueItem[] | null>) | null;
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
          text: clipText(step.text, LIVE_STEP_CHARS),
          at: step.at,
        })),
      };
      const queue = await this.readQueue(key);
      if (queue) {
        turn.queue = queue.map((item) => ({
          id: item.id,
          text: clipText(item.text, LIVE_QUEUE_TEXT_CHARS),
          mode: item.mode,
          position: item.position,
        }));
      }
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

  /** Never throws and never hangs the tick: a failed or slow read is "can't read". */
  private async readQueue(key: string): Promise<QueueItem[] | null> {
    const read = this.deps.queue;
    if (!read) {
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        read(key),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), QUEUE_READ_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      logger.debug("live turn queue read failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
