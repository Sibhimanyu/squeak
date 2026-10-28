import type { RtdbRest } from "../remote/rtdb-rest.js";
import { logger } from "../utils/logger.js";
import { dirPath, readDirectory, type DirectoryDoc } from "./memo-protocol.js";

export type DirectoryStore = Pick<RtdbRest, "get" | "watch">;

/**
 * The Mac's list of who can take a message, kept in memory so an incoming call is answered at once: reading it
 * from the database first made the phone ring on while a network request finished. A stream event or the
 * minute-by-minute refresh keeps it current.
 */
export class DirectoryCache {
  private latest: DirectoryDoc | null = null;
  /** The version `onChange` last heard about, so two reads that race report one change. */
  private told: string | undefined;
  private unwatch: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: DirectoryStore,
    private readonly channel: string,
    private readonly key: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** What was last read, instantly; null until the first read lands. */
  current(): DirectoryDoc | null {
    return this.latest;
  }

  /** Reads it now and remembers it. */
  async refresh(): Promise<DirectoryDoc | null> {
    try {
      const doc = await this.store.get(dirPath(this.channel));
      this.latest = doc ? readDirectory(this.key, doc, this.now()) : null;
    } catch (error) {
      // Keep what we have: a blip must not make the next call refuse everyone.
      logger.warn("voice directory could not be read", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.latest;
  }

  /** `onChange` runs after each read that changed the list. */
  start(onChange: (directory: DirectoryDoc | null) => void): void {
    this.told = this.latest?.version;
    const read = async (): Promise<void> => {
      const after = (await this.refresh())?.version;
      if (after !== this.told) {
        this.told = after;
        onChange(this.latest);
      }
    };
    this.unwatch = this.store.watch(`channels/${this.channel}/voicedir`, () => void read());
    this.timer = setInterval(() => void read(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
