import type { SubagentActivity } from "../fleet/subagent-activity.js";
import { logger } from "../utils/logger.js";
import { LIVE_INTERVAL_MS, LIVE_STEP_CHARS, LIVE_STEPS, liveHandle } from "./live-turn.js";

/**
 * The phone's subagent feed: the steps of ONE Claude subagent of the chat the phone has open, the one it
 * picked. Same rules as the live turn (live-turn.ts), narrower still:
 *
 * - only while verbose is on, a phone is open on that chat, and a signed `subagent` command named the task;
 * - one document per watched chat (`live/<handle>-s`), overwritten in place, never a history, holding one
 *   subagent at a time (picking another replaces it);
 * - deleted when the phone picks none, leaves the chat, or goes quiet;
 * - at most one write a second, none when nothing changed; sealed with the channel key like the rest.
 *
 * What it carries is the subagent's own output, untrusted, as labels and summaries the main feed uses.
 */

export interface SubagentFeed {
  v: 1;
  key: string;
  taskId: string;
  agentId: string | null;
  label: string;
  status: string;
  /** False while the subagent's transcript is not readable; `steps` is then empty. */
  available: boolean;
  total: number;
  steps: Array<{ kind: string; text: string; at: string | null }>;
  seq?: number;
}

/** The `live` document id of a chat's subagent feed: the chat's handle, then `-s`. */
export function subagentFeedDoc(sessionKey: string): string {
  return `${liveHandle(sessionKey)}-s`;
}

export interface SubagentFeedDependencies {
  /** The subagent's steps with whole text; null when the task is gone. */
  read: (sessionKey: string, taskId: string) => SubagentActivity | null;
  write: (doc: string, feed: SubagentFeed) => Promise<void>;
  clear: (doc: string) => Promise<void>;
  seq?: (() => number) | null;
}

export class SubagentFeedPublisher {
  private target: { key: string; taskId: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = "";
  private running = false;

  constructor(private readonly deps: SubagentFeedDependencies) {}

  current(): { key: string; taskId: string } | null {
    return this.target;
  }

  /** Which subagent a phone watches, or null for none. Idempotent. */
  watch(target: { key: string; taskId: string } | null): void {
    if (target?.key === this.target?.key && target?.taskId === this.target?.taskId) {
      return;
    }
    const previous = this.target;
    this.target = target;
    this.last = "";
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Another subagent of the same chat overwrites the document in place; only leaving deletes it.
    if (previous && previous.key !== target?.key) {
      void this.deps.clear(subagentFeedDoc(previous.key)).catch((error: unknown) => {
        logger.warn("subagent feed clear failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    if (target) {
      void this.publish();
      this.timer = setInterval(() => void this.publish(), LIVE_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.watch(null);
  }

  /** One look at the watched subagent; writes only what changed. Never throws. */
  async publish(): Promise<void> {
    const target = this.target;
    if (!target || this.running) {
      return;
    }
    this.running = true;
    try {
      const read = this.deps.read(target.key, target.taskId);
      if (!read) {
        return;
      }
      const feed: SubagentFeed = {
        v: 1,
        key: target.key,
        taskId: target.taskId,
        agentId: read.agentId,
        label: read.label,
        status: read.status,
        available: read.available,
        total: read.total,
        steps: read.steps.slice(-LIVE_STEPS).map((step) => ({
          kind: step.kind,
          text:
            step.text.length > LIVE_STEP_CHARS ? `${step.text.slice(0, LIVE_STEP_CHARS - 1).trimEnd()}…` : step.text,
          at: step.at,
        })),
      };
      const serialized = JSON.stringify(feed);
      if (serialized === this.last) {
        return;
      }
      const seq = this.deps.seq?.();
      await this.deps.write(subagentFeedDoc(target.key), seq === undefined ? feed : { ...feed, seq });
      if (this.target === target) {
        this.last = serialized;
      } else if (!this.target || this.target.key !== target.key) {
        await this.deps.clear(subagentFeedDoc(target.key));
      }
    } catch (error) {
      logger.warn("subagent feed publish failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
