import { logger } from "../utils/logger.js";

import type { Room } from "./room.js";

export interface IdleCloserOptions {
  room: Pick<Room, "retireIdleDucks">;
  /** Ducks holding an open Task right now. */
  busy: () => ReadonlySet<string>;
  /** How often to look (default 5 min). */
  everyMs?: number;
  /** Replaceable so tests never use a real timer. */
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
}

/** Puts Ducks that had no new work for an hour Closed: on a timer, never at start (the hour is watched while the host runs). */
export class IdleCloser {
  private timer: { stop: () => void } | null = null;

  constructor(private readonly o: IdleCloserOptions) {}

  /** One look; returns how many Ducks closed. */
  tick(): number {
    try {
      const off = this.o.room.retireIdleDucks(this.o.busy());
      if (off) logger.info("ducks idle for an hour closed", { off });
      return off;
    } catch (error) {
      logger.warn("closed check failed", { error: String(error) });
      return 0;
    }
  }

  start(): void {
    if (this.timer) return;
    const every = this.o.everyMs ?? 5 * 60_000;
    this.timer =
      this.o.schedule?.(() => this.tick(), every) ??
      (() => {
        const t = setInterval(() => this.tick(), every);
        t.unref();
        return { stop: () => clearInterval(t) };
      })();
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }
}
