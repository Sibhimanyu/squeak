import { describe, expect, it, vi } from "vitest";

import { Coalescer, watchFiles, type Timers, type WatchDeps } from "./change-watcher.js";

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { timers, advance };
}

describe("Coalescer", () => {
  it("turns a burst into one firing, delayMs after the first event", () => {
    const { timers, advance } = fakeTimers();
    const fire = vi.fn();
    const c = new Coalescer(fire, { delayMs: 250, minGapMs: 1000, timers });
    c.poke();
    advance(100);
    c.poke();
    c.poke();
    advance(149);
    expect(fire).not.toHaveBeenCalled();
    advance(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("does not starve under constant events, and honours the minimum gap", () => {
    const { timers, advance } = fakeTimers();
    const fire = vi.fn();
    const c = new Coalescer(fire, { delayMs: 250, minGapMs: 1000, timers });
    for (let t = 0; t < 3000; t += 50) {
      c.poke();
      advance(50);
    }
    // 250 ms, then at most once a second thereafter.
    expect(fire.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fire.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("fires quickly again after a quiet spell", () => {
    const { timers, advance } = fakeTimers();
    const fire = vi.fn();
    const c = new Coalescer(fire, { delayMs: 250, minGapMs: 1000, timers });
    c.poke();
    advance(250);
    advance(5000);
    c.poke();
    advance(250);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("does nothing once closed", () => {
    const { timers, advance } = fakeTimers();
    const fire = vi.fn();
    const c = new Coalescer(fire, { delayMs: 250, minGapMs: 0, timers });
    c.poke();
    c.close();
    advance(1000);
    c.poke();
    advance(1000);
    expect(fire).not.toHaveBeenCalled();
  });
});

function fakeWatchDeps() {
  let listener: ((event: string, filename: string | null) => void) | null = null;
  let onError: (() => void) | null = null;
  const files = new Map<string, { mtimeMs: number; size: number }>();
  const intervals: Array<() => void> = [];
  const closed = vi.fn();
  const deps: WatchDeps = {
    watch: (_dir, _options, l) => {
      listener = l;
      return {
        close: closed,
        on: (_event, handler) => {
          onError = handler;
        },
      };
    },
    stat: (file) => files.get(file) ?? null,
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {
      intervals.length = 0;
    },
  };
  return {
    deps,
    files,
    intervals,
    closed,
    emit: (name: string | null) => listener?.("change", name),
    fail: () => onError?.(),
  };
}

describe("watchFiles", () => {
  it("reports only the named files in the directory", () => {
    const w = fakeWatchDeps();
    const onChange = vi.fn();
    watchFiles([{ dir: "/c", names: ["conductor.db", "conductor.db-wal"] }], onChange, w.deps);
    w.emit("conductor.db-shm");
    expect(onChange).not.toHaveBeenCalled();
    w.emit("conductor.db-wal");
    w.emit(null);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("reports any change when no names are given", () => {
    const w = fakeWatchDeps();
    const onChange = vi.fn();
    watchFiles([{ dir: "/p", recursive: true }], onChange, w.deps);
    w.emit("proj/abc.jsonl");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("falls back to polling stat when the watcher errors", () => {
    const w = fakeWatchDeps();
    const onChange = vi.fn();
    watchFiles([{ dir: "/c", names: ["conductor.db-wal"] }], onChange, w.deps);
    w.files.set("/c/conductor.db-wal", { mtimeMs: 1, size: 10 });
    w.fail();
    expect(w.closed).toHaveBeenCalled();
    expect(w.intervals).toHaveLength(1);
    w.intervals[0]!(); // wal appeared: missing -> present... baseline was taken after set
    expect(onChange).not.toHaveBeenCalled();
    w.files.set("/c/conductor.db-wal", { mtimeMs: 2, size: 20 });
    w.intervals[0]!();
    expect(onChange).toHaveBeenCalledTimes(1);
    w.intervals[0]!();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("polls from the start when fs.watch throws", () => {
    const w = fakeWatchDeps();
    const deps: WatchDeps = {
      ...w.deps,
      watch: () => {
        throw new Error("EMFILE");
      },
    };
    const onChange = vi.fn();
    const handle = watchFiles([{ dir: "/c", names: ["conductor.db"] }], onChange, deps);
    w.files.set("/c/conductor.db", { mtimeMs: 5, size: 1 });
    w.intervals[0]!();
    expect(onChange).toHaveBeenCalledTimes(1);
    handle.close();
    expect(w.intervals).toHaveLength(0);
  });
});
