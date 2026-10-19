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
 *
 * A lid-closed session (`lid`) also disables sleep through `LidControl`
 * (lid-sleep.ts), so closing the lid does not sleep the Mac. It must have an
 * end, and needs the sudoers rule. Sleep is restored when the session ends,
 * is replaced by one without the lid, or Squeak stops (and disabled again if
 * it resumes) — a Mac left with sleep disabled never sleeps, even in a bag.
 */

/** A week: longer than any real need, short enough that a typo cannot mean forever. */
export const MAX_AWAKE_MINUTES = 7 * 24 * 60;

export interface AwakeState {
  /** ISO time it started. */
  startedAt: string;
  /** ISO time it ends by itself; null: until the user ends it. */
  until: string | null;
  /** Asked to stay awake with the lid closed too. */
  lid: boolean;
  /** Whether that is in force: sleep disabled, being disabled, or it could not be. */
  lidStatus: "off" | "starting" | "on" | "failed";
  /** Why it could not be, when it failed. */
  lidProblem?: string;
}

/** What lid-sleep.ts's LidSleepGuard does for a session. */
export interface LidControl {
  ruleInstalled(): Promise<boolean>;
  disableSleep(): Promise<void>;
  restoreSleep(): Promise<boolean>;
  recover(sessionOwnsIt: boolean): Promise<void>;
}

export type AwakeEndReason = "ended" | "expired" | "replaced";

interface Saved {
  startedAt: number;
  until: number | null;
  lid?: boolean;
}

export interface AwakeSessionOptions {
  path: string | null;
  hold: (on: boolean) => void;
  /** Absent: lid-closed sessions are refused. */
  lid?: LidControl | null;
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
  /** Whether sleep is disabled by this session right now. */
  private lidActual = false;
  private lidStatus: AwakeState["lidStatus"] = "off";
  private lidProblem: string | undefined;
  /** Lid changes run one at a time, each reconciling to what the session wants then. */
  private lidChain: Promise<void> = Promise.resolve();
  /** Whether the sudoers rule is installed, as last checked. */
  private lidRule = false;

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
      lid: Boolean(this.saved.lid),
      lidStatus: this.lidStatus,
      ...(this.lidProblem ? { lidProblem: this.lidProblem } : {}),
    };
  }

  /** Whether a lid-closed session can start here: the sudoers rule is installed. */
  get lidReady(): boolean {
    return Boolean(this.options.lid) && this.lidRule;
  }

  /** Re-checks the sudoers rule (at start, every few minutes, and after the Mac app installs it). */
  async refreshLidRule(): Promise<boolean> {
    const before = this.lidRule;
    this.lidRule = this.options.lid ? await this.options.lid.ruleInstalled().catch(() => false) : false;
    if (before !== this.lidRule) {
      this.options.onChange?.();
    }
    return this.lidRule;
  }

  /** Resolves once every lid change asked for so far has run. */
  lidSettled(): Promise<void> {
    return this.lidChain;
  }

  get active(): boolean {
    return this.saved !== null;
  }

  /**
   * Resumes the session saved when Squeak last ran, unless its end has
   * passed; then undoes a sleep disable that no resumed session owns.
   */
  async restore(): Promise<void> {
    const saved = this.readSaved();
    if (saved) {
      this.begin(saved);
    }
    await this.options.lid?.recover(Boolean(saved?.lid)).catch(() => undefined);
    await this.lidChain;
  }

  private readSaved(): Saved | null {
    if (!this.options.path) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.options.path, "utf8"));
    } catch {
      return null; // No file yet, or unreadable: no session.
    }
    const saved = parseSaved(raw, this.now());
    if (!saved) {
      this.write(null);
      return null;
    }
    if (saved.until !== null && saved.until <= this.now()) {
      logger.info("awake session ended while Squeak was down");
      this.write(null);
      return null;
    }
    return saved;
  }

  /** Starts a session for `minutes`, or until ended when null. Replaces a running one. */
  start(minutes: number | null, options: { lid?: boolean } = {}): AwakeState {
    const now = this.now();
    const lid = Boolean(options.lid);
    this.begin({ startedAt: now, until: minutes === null ? null : now + minutes * 60_000, ...(lid ? { lid } : {}) });
    logger.info("awake session started", { minutes, lid });
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
      this.begin({ ...this.saved, until: capped });
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
    void this.syncLid();
    logger.info("awake session over", { reason });
    this.options.onChange?.();
  }

  /**
   * Squeak is shutting down: stop the timer and restore sleep, but keep the
   * saved session, so the next start resumes it (and disables sleep again).
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopping = true;
    await this.syncLid();
  }

  private stopping = false;

  private syncLid(): Promise<void> {
    this.lidChain = this.lidChain.then(() => this.reconcileLid());
    return this.lidChain;
  }

  /** Brings sleep in line with what the session wants now. */
  private async reconcileLid(): Promise<void> {
    const lid = this.options.lid;
    const want = Boolean(this.saved?.lid) && !this.stopping;
    if (!lid || want === this.lidActual) {
      return;
    }
    if (want) {
      this.lidStatus = "starting";
      this.lidProblem = undefined;
      this.options.onChange?.();
      try {
        await lid.disableSleep();
        this.lidActual = true;
        this.lidStatus = "on";
      } catch (error) {
        this.lidStatus = "failed";
        this.lidProblem = error instanceof Error ? error.message : String(error);
        logger.warn("lid-closed could not start", { error: this.lidProblem });
        await lid.restoreSleep().catch(() => false);
      }
    } else {
      await lid.restoreSleep().catch(() => false);
      this.lidActual = false;
      this.lidStatus = "off";
      this.lidProblem = undefined;
    }
    this.options.onChange?.();
  }

  private begin(saved: Saved): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saved = saved;
    if (!saved.lid) {
      this.lidStatus = "off";
      this.lidProblem = undefined;
    }
    this.options.hold(true);
    this.write(saved);
    void this.syncLid();
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
  const { startedAt, until, lid } = session as { startedAt?: unknown; until?: unknown; lid?: unknown };
  if (typeof startedAt !== "number" || !(until === null || typeof until === "number")) {
    return null;
  }
  // A lid session always has an end; a file saying otherwise is not trusted with the lid.
  return { startedAt, until, ...(lid === true && until !== null ? { lid: true } : {}) };
}

export type AwakeAction =
  | { kind: "start"; minutes: number | null; lid: boolean }
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
  const { action, on, minutes, extend, lid: rawLid } = raw as Record<string, unknown>;
  if (rawLid !== undefined && typeof rawLid !== "boolean") {
    return null;
  }
  const lid = rawLid === true;
  if (action === "end") {
    return { kind: "end" };
  }
  if (action === "start") {
    if (minutes === null || minutes === undefined) return { kind: "start", minutes: null, lid };
    const valid = validMinutes(minutes);
    return valid === null ? null : { kind: "start", minutes: valid, lid };
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
    return { kind: "start", minutes: null, lid };
  }
  const valid = validMinutes(minutes);
  return valid === null ? null : { kind: "start", minutes: valid, lid };
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
    if (action.lid && action.minutes === null) {
      return { ok: false, reason: "A lid-closed session needs an end time." };
    }
    if (action.lid && !session.lidReady) {
      return { ok: false, reason: "Lid-closed needs setting up on the Mac first (Stay awake, in the Squeak window)." };
    }
    return { ok: true, state: session.start(action.minutes, { lid: action.lid }) };
  }
  if (!session.active) {
    return { ok: false, reason: "No awake session is running to add time to." };
  }
  return { ok: true, state: session.extend(action.minutes) };
}
