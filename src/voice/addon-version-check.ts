/**
 * The daemon looking up the newest add-on version itself, from the same fixed address the add-on reads, so the Mac
 * app can offer an update (or say "up to date") without waiting for the add-on's own 6-hourly look. Nothing in any
 * message chooses the URL; no secret is sent, kept or logged.
 */
import { LATEST_CONFIG_URL, parseConfigVersion, type FetchLike } from "./addon-update.js";

const FETCH_TIMEOUT_MS = 10_000;
const MIN_GAP_MS = 60_000;
const MAX_CONFIG_BYTES = 64 * 1024;

export interface AddonVersionCheckOptions {
  fetch?: FetchLike;
  now?: () => number;
}

export class AddonVersionCheck {
  private version: string | null = null;
  private at: number | undefined;
  private lastTry = Number.NEGATIVE_INFINITY;
  private ok = false;
  private inflight: Promise<string | null> | null = null;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(options: AddonVersionCheckOptions = {}) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  /** The last good answer without looking, or null. */
  peek(): string | null {
    return this.version;
  }

  /** When (ms) the last successful fetch finished. */
  checkedAt(): number | undefined {
    return this.at;
  }

  /**
   * The newest version: fetched unless a try was made within 60 s (then the last good answer), or always when
   * `force`. A failed fetch keeps the last good answer; null while there never was one.
   */
  async latest(force = false): Promise<string | null> {
    if (this.inflight) return this.inflight;
    if (!force && this.now() - this.lastTry < MIN_GAP_MS) return this.version;
    this.lastTry = this.now();
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Whether the most recent fetch succeeded (false before any, and after a failure). */
  lastOk(): boolean {
    return this.ok;
  }

  private async fetchOnce(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    this.ok = false;
    try {
      const response = await this.fetchFn(LATEST_CONFIG_URL, { signal: controller.signal });
      if (response.ok) {
        const text = await response.text();
        const version = text.length <= MAX_CONFIG_BYTES ? parseConfigVersion(text) : null;
        if (version) {
          this.version = version;
          this.at = this.now();
          this.ok = true;
        }
      }
    } catch {
      // Offline or slow: the last good answer stays.
    } finally {
      clearTimeout(timer);
    }
    return this.version;
  }
}
