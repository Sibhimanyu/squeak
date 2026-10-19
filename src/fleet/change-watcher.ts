import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";

/**
 * Event-driven refresh: instead of waiting for the next poll tick, watch the
 * files the observers read and say "something changed" the moment they do.
 *
 * Two pieces, both with their clock and filesystem injected so tests need no
 * real files or real time:
 *  - `Coalescer` turns a burst of events into one callback, at most
 *    `delayMs` after the first, and never more often than `minGapMs`. A
 *    working agent writes its transcript many times a second; a plain
 *    "wait for quiet" debounce would starve, and a bare "fire on every event"
 *    would re-run ps and git constantly.
 *  - `watchFiles` feeds it from `fs.watch`, and falls back to stat-polling
 *    if the watcher errors or the platform refuses to start one.
 */

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: Date.now,
};

export interface CoalescerOptions {
  /** How long after the first event of a burst to fire. */
  delayMs: number;
  /** Minimum time between two firings. */
  minGapMs: number;
  timers?: Timers;
}

export class Coalescer {
  private handle: unknown = null;
  private lastFiredAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  private readonly timers: Timers;

  constructor(
    private readonly fire: () => void,
    private readonly options: CoalescerOptions,
  ) {
    this.timers = options.timers ?? realTimers;
  }

  /** Note that something changed. Events during a pending wait join it. */
  poke(): void {
    if (this.closed || this.handle !== null) {
      return;
    }
    const now = this.timers.now();
    const wait = Math.max(this.options.delayMs, this.lastFiredAt + this.options.minGapMs - now);
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      if (this.closed) {
        return;
      }
      this.lastFiredAt = this.timers.now();
      this.fire();
    }, wait);
  }

  close(): void {
    this.closed = true;
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}

export interface WatchSpec {
  /** A directory (watched recursively when `recursive`) holding the files. */
  dir: string;
  /** Only these base names count; omit for any change under `dir`. */
  names?: string[];
  recursive?: boolean;
}

export interface WatchHandle {
  close(): void;
}

export interface WatchDeps {
  watch(
    dir: string,
    options: { recursive: boolean },
    listener: (event: string, filename: string | null) => void,
  ): { close(): void; on(event: "error", listener: () => void): unknown };
  stat(file: string): { mtimeMs: number; size: number } | null;
  timers?: Timers;
  /** Fallback poll cadence, and how often the poller re-stats. */
  pollMs?: number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export const realWatchDeps: WatchDeps = {
  watch: (dir, options, listener) => fs.watch(dir, { recursive: options.recursive, persistent: false }, listener),
  stat: (file) => {
    try {
      const stat = fs.statSync(file);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  },
};

const DEFAULT_POLL_MS = 2_000;

/**
 * Call `onChange` when any watched file changes. `fs.watch` is the fast path;
 * if it cannot start or later errors, a stat poll over the named files takes
 * over (it only knows named files — a directory-wide watch without `names`
 * has no useful fallback and relies on the monitor's periodic safety poll).
 */
export function watchFiles(specs: WatchSpec[], onChange: () => void, deps: WatchDeps = realWatchDeps): WatchHandle {
  const handles: Array<{ close(): void }> = [];
  const pollers: unknown[] = [];
  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIv = deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let closed = false;

  const startPolling = (spec: WatchSpec): void => {
    if (!spec.names || spec.names.length === 0) {
      return;
    }
    const files = spec.names.map((name) => path.join(spec.dir, name));
    const seen = new Map<string, string>();
    const signature = (file: string): string => {
      const stat = deps.stat(file);
      return stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
    };
    for (const file of files) {
      seen.set(file, signature(file));
    }
    const handle = setIv(() => {
      if (closed) {
        return;
      }
      let changed = false;
      for (const file of files) {
        const next = signature(file);
        if (next !== seen.get(file)) {
          seen.set(file, next);
          changed = true;
        }
      }
      if (changed) {
        onChange();
      }
    }, deps.pollMs ?? DEFAULT_POLL_MS);
    (handle as { unref?: () => void } | null)?.unref?.();
    pollers.push(handle);
  };

  for (const spec of specs) {
    const names = spec.names ? new Set(spec.names) : null;
    try {
      const watcher = deps.watch(spec.dir, { recursive: spec.recursive ?? false }, (_event, filename) => {
        if (closed) {
          return;
        }
        // A null filename means the platform could not say which; assume it matters.
        if (names && filename && !names.has(path.basename(filename))) {
          return;
        }
        onChange();
      });
      let fellBack = false;
      watcher.on("error", () => {
        if (fellBack) {
          return;
        }
        fellBack = true;
        logger.warn("fleet watcher failed; polling instead", { dir: spec.dir });
        try {
          watcher.close();
        } catch {
          // Already gone.
        }
        startPolling(spec);
      });
      handles.push(watcher);
    } catch (error) {
      logger.warn("fleet watcher could not start; polling instead", {
        dir: spec.dir,
        error: error instanceof Error ? error.message : String(error),
      });
      startPolling(spec);
    }
  }

  return {
    close() {
      closed = true;
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // Already closed.
        }
      }
      for (const poller of pollers) {
        clearIv(poller);
      }
    },
  };
}
