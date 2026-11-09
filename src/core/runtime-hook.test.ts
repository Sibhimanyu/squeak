import { describe, expect, it, vi } from "vitest";
import { fleetSession } from "./adapters/fixtures.js";
import { CORE_SYNC_MIN_GAP_MS, startCoreSync } from "./runtime-hook.js";
import type { CoreDb } from "./store/core-db.js";
import type { SessionSnapshot } from "./session-store.js";
import type { FleetSession } from "../fleet/types.js";

function fakeMonitor(sessions: FleetSession[]) {
  const listeners = new Set<(s: SessionSnapshot) => void>();
  const monitor = {
    snapshot: { active: sessions, sessions, attention: [] as never[] },
    onSnapshot(cb: (s: SessionSnapshot) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh: async () => {},
  };
  return { monitor, emit: () => listeners.forEach((l) => l(monitor.snapshot)), listeners };
}

function fakeDb(overrides: Record<string, unknown> = {}) {
  const calls = { upsertSession: 0, close: 0 };
  const db = {
    ensureLocalRuntime: vi.fn(),
    getProject: vi.fn(() => undefined),
    upsertProject: vi.fn(),
    upsertWorkspace: vi.fn(),
    upsertSession: vi.fn(() => {
      calls.upsertSession++;
      return "added";
    }),
    close: vi.fn(() => {
      calls.close++;
    }),
    ...overrides,
  };
  return { db: db as unknown as CoreDb, calls };
}

function clock() {
  let t = 1_000_000;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      for (const x of timers.filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
    },
    setTimer: (fn: () => void, ms: number) => {
      const id = timers.length + 1;
      timers.push({ fn, at: t + ms, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    pending: () => timers.length,
  };
}

describe("startCoreSync", () => {
  it("SQUEAK_CORE=off opens nothing and subscribes to nothing", () => {
    const openDb = vi.fn();
    const { monitor, listeners } = fakeMonitor([]);
    const sync = startCoreSync({ monitor, supportDir: "/x", env: { SQUEAK_CORE: "off" }, warn: vi.fn(), openDb });
    expect(sync).toBeNull();
    expect(openDb).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("a database that cannot open is logged once and the fleet carries on", () => {
    const warn = vi.fn();
    const { monitor } = fakeMonitor([]);
    const sync = startCoreSync({
      monitor,
      supportDir: "/x",
      env: {},
      warn,
      openDb: () => {
        throw new Error("disk full");
      },
    });
    expect(sync).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a throwing database never reaches the monitor and each message is logged once", () => {
    const warn = vi.fn();
    const c = clock();
    const { db } = fakeDb({
      upsertSession: () => {
        throw new Error("SQLITE_FULL");
      },
    });
    const { monitor, emit } = fakeMonitor([fleetSession()]);
    startCoreSync({ monitor, supportDir: "/x", env: {}, warn, openDb: () => db, ...c });
    expect(() => {
      emit();
      c.advance(CORE_SYNC_MIN_GAP_MS);
      emit();
      c.advance(CORE_SYNC_MIN_GAP_MS);
      emit();
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("debounces to one sync per 5 s with a trailing run, and closes the db on stop", () => {
    const c = clock();
    const { db, calls } = fakeDb();
    const { monitor, emit, listeners } = fakeMonitor([fleetSession()]);
    const sync = startCoreSync({ monitor, supportDir: "/x", env: {}, warn: vi.fn(), openDb: () => db, ...c })!;
    emit();
    expect(calls.upsertSession).toBe(1);
    for (let i = 0; i < 10; i++) emit();
    expect(calls.upsertSession).toBe(1);
    expect(c.pending()).toBe(1);
    c.advance(CORE_SYNC_MIN_GAP_MS - 1);
    expect(calls.upsertSession).toBe(1);
    c.advance(1);
    expect(calls.upsertSession).toBe(2);
    sync.stop();
    expect(calls.close).toBe(1);
    expect(listeners.size).toBe(0);
    emit();
    expect(calls.upsertSession).toBe(2);
  });
});
