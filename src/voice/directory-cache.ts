import type { RtdbRest } from "../remote/rtdb-rest.js";
import { logger } from "../utils/logger.js";
import type { Clip } from "./clips.js";
import { audioPath, dirPath, readAudio, readDirectory, type DirectoryDoc } from "./memo-protocol.js";

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
  private clipList: Clip[] = [];
  /** The audio ids `clipList` was read from, so an unchanged list is not fetched again. */
  private clipIds = "";

  constructor(
    private readonly store: DirectoryStore,
    private readonly channel: string,
    private readonly key: string,
    private readonly now: () => number = Date.now,
    /** Told the Mac's recordings of the call-in prompts whenever they are (re)read. */
    private readonly onClips?: (clips: Clip[]) => void,
  ) {}

  /** The Mac's recordings of the call-in prompts, from the last read that worked. */
  clips(): Clip[] {
    return this.clipList;
  }

  private async fetchClips(doc: DirectoryDoc | null): Promise<void> {
    const ids = doc?.audio ?? [];
    const signature = `${doc?.version ?? ""}|${ids.join(",")}`;
    if (ids.length === 0 || signature === this.clipIds) return;
    const clips: Clip[] = [];
    for (const id of ids) {
      try {
        const raw = await this.store.get(audioPath(this.channel, id));
        const read = raw ? readAudio(this.key, id, raw) : null;
        // A document that is missing or unreadable keeps what we had: partial speech is still better than none.
        if (!read) throw new Error("audio document unreadable");
        clips.push(...read.clips);
      } catch (error) {
        logger.warn("voice prompt audio could not be read", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    this.clipList = clips;
    this.clipIds = signature;
    this.onClips?.(clips);
  }

  /** What was last read, instantly; null until the first read lands. */
  current(): DirectoryDoc | null {
    return this.latest;
  }

  /** Reads it now and remembers it. */
  async refresh(): Promise<DirectoryDoc | null> {
    try {
      const doc = await this.store.get(dirPath(this.channel));
      this.latest = doc ? readDirectory(this.key, doc, this.now()) : null;
      await this.fetchClips(this.latest);
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
