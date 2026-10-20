import type { ClaudeLimits, ClaudeLimitsStore } from "./claude-limits.js";
import type { ClaudeUsageOutcome } from "./claude-usage-api.js";

/** One press of Refresh at most this often; a second press gets the cached reading. */
export const CLAUDE_REFRESH_MIN_INTERVAL_MS = 60_000;

export interface ClaudeRefreshResult {
  claudeLimits: ClaudeLimits | null;
  /** True when a press inside the minimum interval (or a rate-limit wait) was answered from the cache. A repeat of a failed run keeps that run's `error`. */
  throttled: boolean;
  /** True when the usage request succeeded and its reading was stored. */
  refreshed: boolean;
  /** Plain words, only when the request failed or Claude asked Squeak to wait. */
  error?: string;
}

/**
 * Reads Claude's plan limits on demand, for the one person who asked.
 *
 * It asks Claude's usage endpoint with the sign-in Claude Code already holds
 * (`claude-usage-api.ts`): a plain GET, no model call, nothing spent. It still
 * runs only when the owner presses Refresh, never on a timer, so a Keychain
 * prompt can only follow a press. At most once a minute, one press at a time;
 * a 429 stretches that wait to what Claude's Retry-After says. A failure keeps
 * the last reading, and its age, as it was.
 */
export class ClaudeLimitsRefresher {
  private lastRunAt = 0;
  private blockedUntil = 0;
  private blockedMessage = "";
  private lastError = "";
  private inFlight: Promise<ClaudeRefreshResult> | null = null;

  constructor(
    private readonly store: Pick<ClaudeLimitsStore, "latest" | "record">,
    private readonly fetchUsage: () => Promise<ClaudeUsageOutcome>,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): Promise<ClaudeRefreshResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const at = this.now();
    if (at < this.blockedUntil) {
      return Promise.resolve({
        claudeLimits: this.store.latest(),
        throttled: true,
        refreshed: false,
        error: this.blockedMessage,
      });
    }
    if (this.lastRunAt > 0 && at - this.lastRunAt < CLAUDE_REFRESH_MIN_INTERVAL_MS) {
      // Still inside the guard: a repeat is answered from the cache, but a
      // failed last run is never passed off as a fresh reading.
      return Promise.resolve({
        claudeLimits: this.store.latest(),
        throttled: true,
        refreshed: false,
        ...(this.lastError ? { error: this.lastError } : {}),
      });
    }
    this.lastRunAt = at;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<ClaudeRefreshResult> {
    let outcome: ClaudeUsageOutcome;
    try {
      outcome = await this.fetchUsage();
    } catch {
      outcome = { ok: false, error: "Squeak could not read Claude's usage this time." };
    }
    if (!outcome.ok) {
      this.lastError = outcome.error;
      if (outcome.retryAfterMs !== undefined) {
        this.blockedUntil = this.now() + Math.max(outcome.retryAfterMs, CLAUDE_REFRESH_MIN_INTERVAL_MS);
        this.blockedMessage = outcome.error;
      }
      return { claudeLimits: this.store.latest(), throttled: false, refreshed: false, error: outcome.error };
    }
    this.lastError = "";
    this.store.record({
      fiveHour: outcome.fiveHour,
      sevenDay: outcome.sevenDay,
      observedAt: new Date(this.now()).toISOString(),
    });
    return { claudeLimits: this.store.latest(), throttled: false, refreshed: true };
  }
}
