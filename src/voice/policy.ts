import { inQuietHours, type QuietHours } from "../fleet/notify-settings.js";

/** Keeps calls rare: a phone that rings for every card gets silenced. */
export interface CallPolicyOptions {
  /** Fewest ms between two calls (a card each would still arrive on Telegram). */
  minGapMs: number;
  quiet: QuietHours | null;
}

export const DEFAULT_MIN_GAP_MIN_MS = 5 * 60_000;

/**
 * Whether a call may be placed now, and remembering the ones that were. An episode (a session's key
 * and the time it began waiting) is called at most once; quiet hours hold every call, because unlike a
 * push a call is not silent.
 */
export class CallPolicy {
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private readonly called = new Set<string>();
  private readonly retried = new Set<string>();
  private lastEpisode: string | null = null;

  constructor(private readonly options: CallPolicyOptions) {}

  /**
   * Why not, or null when a call may go. Does not record anything. `retry` is the one second try at an episode whose
   * call went unanswered: it needs the first call to have been made, happens once, and is not held by the gap
   * after that episode's own call (but is after any other episode's call, and by quiet hours like any call).
   */
  refusal(episode: string, now: number, retry = false): string | null {
    if (retry) {
      if (!this.called.has(episode)) return "not called yet";
      if (this.retried.has(episode)) return "already retried";
    } else if (this.called.has(episode)) return "already called for this";
    if (inQuietHours(this.options.quiet, new Date(now))) return "quiet hours";
    const ownCall = retry && this.lastEpisode === episode;
    if (!ownCall && now - this.lastCallAt < this.options.minGapMs) return "called a moment ago";
    return null;
  }

  record(episode: string, now: number, retry = false): void {
    (retry ? this.retried : this.called).add(episode);
    this.lastCallAt = now;
    this.lastEpisode = episode;
    if (this.retried.size > 500) {
      const oldest = this.retried.values().next().value;
      if (oldest !== undefined) this.retried.delete(oldest);
    }
    // Episodes are tiny, but a daemon runs for weeks.
    if (this.called.size > 500) {
      const oldest = this.called.values().next().value;
      if (oldest !== undefined) this.called.delete(oldest);
    }
  }
}
