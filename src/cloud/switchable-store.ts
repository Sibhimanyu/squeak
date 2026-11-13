/**
 * The store everything in the daemon (or the add-on) holds, so a move to another provider
 * (docs/cloud-layer.md, "Moving") is one `switchTo` and not a rebuild of the bridge, the voice relay and
 * the rest. After a switch it keeps reading the old store for `keepOldMs` (10 minutes) for devices that
 * have not yet seen the move: reads fall back to it, a list merges both, a delete goes to both, and a
 * watch listens to both. Writes go to the current store only.
 */

import type { ChannelDoc } from "../remote/firestore-rest.js";
import type { CloudLocation } from "./location.js";
import type { CloudStore, CloudWatchOptions, WatchSource } from "./store.js";

export const OLD_STORE_MS = 10 * 60_000;

interface Entry {
  path: string;
  onChange: (source?: WatchSource) => void;
  options: CloudWatchOptions;
  unwatchCurrent: () => void;
  unwatchPrevious: (() => void) | null;
}

type Closable = CloudStore & { close?: () => void };

export class SwitchableStore implements CloudStore {
  private currentStore: Closable;
  private currentLocation: CloudLocation | null;
  private previous: Closable | null = null;
  private previousTimer: NodeJS.Timeout | null = null;
  private readonly entries = new Set<Entry>();

  constructor(
    initial: CloudStore,
    location: CloudLocation | null = null,
    private readonly keepOldMs: number = OLD_STORE_MS,
  ) {
    this.currentStore = initial;
    this.currentLocation = location;
  }

  get location(): CloudLocation | null {
    return this.currentLocation;
  }

  /** True while the old store is still being read after a switch. */
  get readingOld(): boolean {
    return this.previous !== null;
  }

  switchTo(store: CloudStore, location: CloudLocation | null): void {
    this.endPrevious();
    const old = this.currentStore;
    this.previous = old;
    this.currentStore = store;
    this.currentLocation = location;
    this.previousTimer = setTimeout(() => this.endPrevious(), this.keepOldMs);
    this.previousTimer.unref?.();
    for (const entry of this.entries) {
      entry.unwatchCurrent();
      entry.unwatchPrevious?.();
      this.attach(entry);
      // Whatever is on the new store is new to every watcher.
      entry.onChange();
    }
  }

  async get(path: string): Promise<ChannelDoc | null> {
    const doc = await this.currentStore.get(path);
    if (doc || !this.previous) return doc;
    return this.previous.get(path).catch(() => null);
  }

  set(path: string, doc: ChannelDoc, options?: { timeoutMs?: number }): Promise<void> {
    return this.currentStore.set(path, doc, options);
  }

  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    const current = await this.currentStore.list(collection);
    const previous = this.previous;
    if (!previous) return current;
    const old = await previous.list(collection).catch(() => []);
    const seen = new Set(current.map((item) => item.id));
    return [...current, ...old.filter((item) => !seen.has(item.id))];
  }

  async delete(path: string): Promise<void> {
    const previous = this.previous;
    // A command taken from the old store must be removed from it, or it is read again.
    if (previous) await previous.delete(path).catch(() => undefined);
    await this.currentStore.delete(path);
  }

  watch(path: string, onChange: (source?: WatchSource) => void, options: CloudWatchOptions = {}): () => void {
    const entry: Entry = { path, onChange, options, unwatchCurrent: () => undefined, unwatchPrevious: null };
    this.attach(entry);
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
      entry.unwatchCurrent();
      entry.unwatchPrevious?.();
    };
  }

  /** Stops reading the old store now (and any subscriber it holds). */
  endPrevious(): void {
    if (this.previousTimer) clearTimeout(this.previousTimer);
    this.previousTimer = null;
    const previous = this.previous;
    this.previous = null;
    for (const entry of this.entries) {
      entry.unwatchPrevious?.();
      entry.unwatchPrevious = null;
    }
    previous?.close?.();
  }

  private attach(entry: Entry): void {
    entry.unwatchCurrent = this.currentStore.watch(entry.path, entry.onChange, entry.options);
    entry.unwatchPrevious = this.previous
      ? this.previous.watch(entry.path, entry.onChange, entry.options.onError ? { onError: entry.options.onError } : {})
      : null;
  }
}
