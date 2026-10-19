import fs from "node:fs";

import { logger } from "../utils/logger.js";

/**
 * An awake session: the user asked for the Mac to stay awake, for a while or
 * until they say stop (todo.md, "Stay awake plan"). Started from the menu bar,
 * the Squeak window or the phone; one at a time, and a new start replaces the
 * running one.
 *
 * It owns the timing and nothing else: `hold` is told when the Mac must be
 * kept awake (Caffeinator.setKeepAwake), and the session ends itself at
 * `until`. It is saved to `path`, so a restart resumes it — and a session
 * whose end passed while Squeak was down is not resumed.
 */

/** A week: longer than any real need, short enough that a typo cannot mean forever. */
export const MAX_AWAKE_MINUTES = 7 * 24 * 60;

export interface AwakeState {
  /** ISO time it started. */
  startedAt: string;
  /** ISO time it ends by itself; null: until the user ends it. */
  until: string | null;
}

export type AwakeEndReason = "ended" | "expired" | "replaced";

interface Saved {
  startedAt: number;
  until: number | null;
}

export interface AwakeSessionOptions {
  path: string | null;
  hold: (on: boolean) => void;
  now?: () => number;
  /** Told whenever the session starts, changes or ends, so surfaces can republish. */
  onChange?: () => void;
}

/** Whole minutes in 1..MAX_AWAKE_MINUTES, or null for anything else. */
export function validMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AWAKE_MINUTES
    ? value
    : null;
}

export class AwakeSession {
  private saved: Saved | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: AwakeSessionOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): AwakeState | null {
    if (!this.saved) {
      return null;
    }
    return {
      startedAt: new Date(this.saved.startedAt).toISOString(),
      until: this.saved.until === null ? null : new Date(this.saved.until).toISOString(),
    };
  }

  get active(): boolean {
    return this.saved !== null;
  }

  /** Resumes the session saved when Squeak last ran, unless its end has passed. */
  restore(): void {
    if (!this.options.path) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.options.path, "utf8"));
    } catch {
      return; // No file yet, or unreadable: no session.
    }
    const saved = parseSaved(raw, this.now());
    if (!saved) {
      this.write(null);
      return;
    }
    if (saved.until !== null && saved.until <= this.now()) {
      logger.info("awake session ended while Squeak was down");
      this.write(null);
      return;
    }
    this.begin(saved);
  }

  /** Starts a session for `minutes`, or until ended when null. Replaces a running one. */
  start(minutes: number | null): AwakeState {
    const now = this.now();
    this.begin({ startedAt: now, until: minutes === null ? null : now + minutes * 60_000 });
    logger.info("awake session started", { minutes });
    return this.state!;
  }

  /** Adds `minutes` to a timed session (from now if somehow already due). Null if none runs. */
  extend(minutes: number): AwakeState | null {
    if (!this.saved) {
      return null;
    }
    if (this.saved.until !== null) {
      const capped = Math.min(
        Math.max(this.saved.until, this.now()) + minutes * 60_000,
        this.now() + MAX_AWAKE_MINUTES * 60_000,
      );
      this.begin({ startedAt: this.saved.startedAt, until: capped });
    }
    return this.state;
  }

  end(reason: AwakeEndReason = "ended"): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.saved) {
      return;
    }
    this.saved = null;
    this.options.hold(false);
    this.write(null);
    logger.info("awake session over", { reason });
    this.options.onChange?.();
  }

  /** Stops the timer without ending the saved session: Squeak is shutting down, and will resume it. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private begin(saved: Saved): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saved = saved;
    this.options.hold(true);
    this.write(saved);
    if (saved.until !== null) {
      // setTimeout caps at ~24.8 days; a week fits.
      this.timer = setTimeout(() => this.end("expired"), Math.max(0, saved.until - this.now()));
      this.timer.unref?.();
    }
    this.options.onChange?.();
  }

  private write(saved: Saved | null): void {
    if (!this.options.path) {
      return;
    }
    try {
      fs.writeFileSync(this.options.path, JSON.stringify(saved ? { session: saved } : { session: null }) + "\n");
    } catch (error) {
      logger.warn("could not save the awake session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function parseSaved(raw: unknown, now: number): Saved | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  // The first switch saved `{ keepAwake: true }`: an untimed session.
  if ((raw as { keepAwake?: unknown }).keepAwake === true) {
    return { startedAt: now, until: null };
  }
  const session = (raw as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) {
    return null;
  }
  const { startedAt, until } = session as { startedAt?: unknown; until?: unknown };
  if (typeof startedAt !== "number" || !(until === null || typeof until === "number")) {
    return null;
  }
  return { startedAt, until };
}

export type AwakeAction =
  | { kind: "start"; minutes: number | null }
  | { kind: "extend"; minutes: number }
  | { kind: "end" };

/**
 * Reads a request to change the session, from the control route or a phone's
 * signed `awake` command. Either `{ action: "start", minutes|null }`,
 * `{ action: "extend", minutes }`, `{ action: "end" }`, or the first switch's
 * shape that phones still send: `{ on, minutes?, extend? }`. Null when it is
 * none of these, so the caller refuses it.
 */
export function readAwakeAction(raw: unknown): AwakeAction | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const { action, on, minutes, extend } = raw as Record<string, unknown>;
  if (action === "end") {
    return { kind: "end" };
  }
  if (action === "start") {
    if (minutes === null || minutes === undefined) return { kind: "start", minutes: null };
    const valid = validMinutes(minutes);
    return valid === null ? null : { kind: "start", minutes: valid };
  }
  if (action === "extend") {
    const valid = validMinutes(minutes);
    return valid === null ? null : { kind: "extend", minutes: valid };
  }
  if (action !== undefined || typeof on !== "boolean") {
    return null;
  }
  if (!on) {
    return { kind: "end" };
  }
  if (extend !== undefined) {
    const valid = validMinutes(extend);
    return valid === null ? null : { kind: "extend", minutes: valid };
  }
  if (minutes === undefined || minutes === null) {
    return { kind: "start", minutes: null };
  }
  const valid = validMinutes(minutes);
  return valid === null ? null : { kind: "start", minutes: valid };
}

/** Applies an action; extending when nothing runs is refused rather than starting one. */
export function applyAwakeAction(
  session: AwakeSession,
  action: AwakeAction,
): { ok: true; state: AwakeState | null } | { ok: false; reason: string } {
  if (action.kind === "end") {
    session.end();
    return { ok: true, state: null };
  }
  if (action.kind === "start") {
    return { ok: true, state: session.start(action.minutes) };
  }
  if (!session.active) {
    return { ok: false, reason: "No awake session is running to add time to." };
  }
  return { ok: true, state: session.extend(action.minutes) };
}
