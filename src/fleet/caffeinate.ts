import { spawn, type ChildProcess } from "node:child_process";

import { logger } from "../utils/logger.js";
import type { FleetSnapshot } from "./fleet-monitor.js";

/**
 * Keeps the Mac awake while an agent is working, so a long turn is not cut
 * off by idle sleep and the phone and Cliq can still reach Squeak.
 *
 * It runs macOS's own `caffeinate -i` (no idle sleep; the display may still
 * sleep) with `-w <squeak's pid>`, so if Squeak dies the assertion goes
 * with it and the Mac is never left awake by accident. It lets go a grace
 * period after the last working session ends: a chat between turns, or a
 * fan-out of workers reporting in one by one, must not toggle it.
 *
 * Only "working" counts. A session waiting on you is not using the Mac, and
 * keeping it awake for hours for an unanswered question would surprise.
 * Closing the lid on battery still sleeps; caffeinate cannot prevent that.
 */

export const CAFFEINATE_GRACE_MS = 2 * 60_000;

type Spawn = (command: string, args: string[]) => Pick<ChildProcess, "kill" | "on" | "pid">;

export class Caffeinator {
  private child: Pick<ChildProcess, "kill" | "on" | "pid"> | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spawnImpl: Spawn = (command, args) => spawn(command, args, { stdio: "ignore" }),
    private readonly pid: number = process.pid,
  ) {}

  /** Whether the Mac is being kept awake right now. */
  get active(): boolean {
    return this.child !== null;
  }

  update(snapshot: Pick<FleetSnapshot, "active">): void {
    const working = snapshot.active.some((session) => session.state === "working");
    if (working) {
      if (this.releaseTimer) {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      this.hold();
    } else if (this.child && !this.releaseTimer) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        this.release();
      }, CAFFEINATE_GRACE_MS);
      this.releaseTimer.unref?.();
    }
  }

  stop(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.release();
  }

  private hold(): void {
    if (this.child) {
      return;
    }
    try {
      const child = this.spawnImpl("/usr/bin/caffeinate", ["-i", "-w", String(this.pid)]);
      this.child = child;
      child.on("exit", () => {
        if (this.child === child) {
          this.child = null;
        }
      });
      child.on("error", (error: Error) => {
        logger.warn("caffeinate failed", { error: error.message });
        if (this.child === child) {
          this.child = null;
        }
      });
      logger.info("keeping the Mac awake while agents work");
    } catch (error) {
      logger.warn("caffeinate failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private release(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    child.kill();
    logger.info("no agent working; the Mac may sleep again");
  }
}
