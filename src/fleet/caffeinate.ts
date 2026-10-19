import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

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
 *
 * With `onPower` it also holds `caffeinate -s` for Squeak's whole life: the
 * Mac never idle-sleeps while plugged in, so the phone can start or answer
 * work after the agents have gone quiet (an idle Mac on AC slept fifteen
 * minutes after the last turn and stayed unreachable). macOS honours `-s`
 * only on AC, so on battery this asks for nothing and the Mac sleeps as usual.
 *
 * And the user can say so themselves: "Keep Mac awake" (the menu bar, the
 * phone) holds `caffeinate -i` on battery too, until they turn it off. It is
 * written to `switchPath`, so a restart keeps it on.
 */

export const CAFFEINATE_GRACE_MS = 2 * 60_000;

type Spawn = (command: string, args: string[]) => Pick<ChildProcess, "kill" | "on" | "pid">;

export class Caffeinator {
  private child: Pick<ChildProcess, "kill" | "on" | "pid"> | null = null;
  private powerChild: Pick<ChildProcess, "kill" | "on" | "pid"> | null = null;
  private switchChild: Pick<ChildProcess, "kill" | "on" | "pid"> | null = null;
  private switchedOn = false;
  private releaseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spawnImpl: Spawn = (command, args) => spawn(command, args, { stdio: "ignore" }),
    private readonly pid: number = process.pid,
    private readonly switchPath: string | null = null,
  ) {}

  /** Whether the user has asked for the Mac to stay awake. */
  get keepAwake(): boolean {
    return this.switchedOn;
  }

  /** Turns the switch back on if it was on when Squeak last ran. */
  restoreSwitch(): void {
    if (!this.switchPath) {
      return;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(this.switchPath, "utf8")) as { keepAwake?: unknown };
      if (saved.keepAwake === true) {
        this.setKeepAwake(true, { save: false });
      }
    } catch {
      // No file yet, or unreadable: the switch is off.
    }
  }

  /** The user's "Keep Mac awake": on battery too, until turned off. */
  setKeepAwake(on: boolean, options: { save?: boolean } = {}): void {
    this.switchedOn = on;
    if (on && !this.switchChild) {
      const child = this.start(["-i", "-w", String(this.pid)], () => {
        if (this.switchChild === child) {
          this.switchChild = null;
        }
      });
      this.switchChild = child;
      logger.info("keeping the Mac awake until the switch is turned off");
    } else if (!on && this.switchChild) {
      const child = this.switchChild;
      this.switchChild = null;
      child.kill();
      logger.info("keep-awake switch off");
    }
    if (this.switchPath && options.save !== false) {
      try {
        fs.writeFileSync(this.switchPath, JSON.stringify({ keepAwake: on }) + "\n");
      } catch (error) {
        logger.warn("could not save the keep-awake switch", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Keep the Mac from sleeping while it is plugged in, until `stop`. */
  holdOnPower(): void {
    if (this.powerChild) {
      return;
    }
    const child = this.start(["-s", "-w", String(this.pid)], () => {
      if (this.powerChild === child) {
        this.powerChild = null;
      }
    });
    this.powerChild = child;
    if (child) {
      logger.info("keeping the Mac awake while it is plugged in");
    }
  }

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
    for (const held of [this.powerChild, this.switchChild]) {
      held?.kill();
    }
    this.powerChild = null;
    this.switchChild = null;
  }

  private hold(): void {
    if (this.child) {
      return;
    }
    const child = this.start(["-i", "-w", String(this.pid)], () => {
      if (this.child === child) {
        this.child = null;
      }
    });
    this.child = child;
    if (child) {
      logger.info("keeping the Mac awake while agents work");
    }
  }

  /** Spawns caffeinate; `gone` runs when it exits or fails. Null if it could not start. */
  private start(args: string[], gone: () => void): Pick<ChildProcess, "kill" | "on" | "pid"> | null {
    try {
      const child = this.spawnImpl("/usr/bin/caffeinate", args);
      child.on("exit", gone);
      child.on("error", (error: Error) => {
        logger.warn("caffeinate failed", { error: error.message });
        gone();
      });
      return child;
    } catch (error) {
      logger.warn("caffeinate failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
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
