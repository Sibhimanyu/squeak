import type { ClaudeLimits, ClaudeLimitsStore } from "./claude-limits.js";

/** One press of Refresh at most this often; a second press gets the cached reading. */
export const CLAUDE_REFRESH_MIN_INTERVAL_MS = 60_000;

export interface ClaudeRefreshResult {
  claudeLimits: ClaudeLimits | null;
  /** True when a press inside the minimum interval was answered from the cache. */
  throttled: boolean;
  /** True when the call ran and produced a newer reading than before. */
  refreshed: boolean;
  /** Plain words, only when the call ran and failed. */
  error?: string;
}

/**
 * Reads Claude's plan limits on demand, for the one person who asked.
 *
 * Claude Code writes its rate-limit event nowhere but the live output of the
 * process that spawned it (CLAUDE.md), so the only way to get a fresh reading
 * is to spawn one tiny call. That spends a sliver of real quota, so nothing
 * calls this on a timer: it runs only when the owner presses Refresh, never
 * more than once a minute, and one press at a time.
 */
export class ClaudeLimitsRefresher {
  private lastRunAt = 0;
  private inFlight: Promise<ClaudeRefreshResult> | null = null;

  constructor(
    private readonly store: Pick<ClaudeLimitsStore, "latest">,
    /** One cheap call that makes the runner record the rate-limit event. */
    private readonly probe: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): Promise<ClaudeRefreshResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.lastRunAt > 0 && this.now() - this.lastRunAt < CLAUDE_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve({ claudeLimits: this.store.latest(), throttled: true, refreshed: false });
    }
    this.lastRunAt = this.now();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<ClaudeRefreshResult> {
    const before = this.store.latest()?.observedAt ?? null;
    let error: string | undefined;
    try {
      await this.probe();
    } catch (e) {
      // The event arrives before the answer, so a failed answer can still have a reading.
      error = e instanceof Error ? e.message : String(e);
    }
    const after = this.store.latest();
    const refreshed = after !== null && after.observedAt !== before;
    return {
      claudeLimits: after,
      throttled: false,
      refreshed,
      ...(!refreshed ? { error: error ?? "Claude did not report its limits this time." } : {}),
    };
  }
}

/** The probe's prompt: as short as a call can be. */
export const CLAUDE_PROBE_SYSTEM = "Reply with: ok";
export const CLAUDE_PROBE_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
};
