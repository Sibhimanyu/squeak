import { registerDefaultAdapters } from "./adapters/index.js";
import { AgentRegistry } from "./registry.js";
import { SqueakSessionStore, type SessionSource } from "./session-store.js";
import { CoreDb, defaultCoreDbPath } from "./store/core-db.js";
import { inferProject } from "./store/project-inference.js";
import { syncSessions } from "./store/sync.js";
import type { FleetSession } from "../fleet/types.js";

/** At most one sync this often; a burst of snapshots writes once, with the newest. */
export const CORE_SYNC_MIN_GAP_MS = 5000;

export interface CoreSyncOptions {
  /** The monitor; it satisfies the narrow source structurally. */
  monitor: SessionSource;
  supportDir: string;
  env?: NodeJS.ProcessEnv;
  warn: (message: string, detail?: Record<string, unknown>) => void;
  /** Tests inject a fake database. */
  openDb?: (dbPath: string) => CoreDb;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CoreSync {
  stop(): void;
}

const notWired = async (): Promise<never> => {
  throw new Error("core adapters are not wired to a replier yet");
};

/**
 * Write-only mirror of the fleet into `core.db`. Nothing reads it yet, so every failure is
 * swallowed (logged once per distinct message) and can never touch the fleet, hooks or cards.
 * Returns null when `SQUEAK_CORE=off` or the database cannot be opened.
 */
export function startCoreSync(options: CoreSyncOptions): CoreSync | null {
  const env = options.env ?? process.env;
  if (env.SQUEAK_CORE === "off") return null;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const warned = new Set<string>();
  const report = (stage: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (warned.has(message)) return;
    warned.add(message);
    try {
      options.warn(`core sync ${stage} failed`, { error: message });
    } catch {
      // logging must not throw either
    }
  };

  let db: CoreDb;
  let store: SqueakSessionStore;
  try {
    db = (options.openDb ?? ((p) => new CoreDb(p)))(defaultCoreDbPath(options.supportDir));
    const registry = new AgentRegistry();
    const observe = async (): Promise<FleetSession[]> => [...options.monitor.snapshot.active];
    registerDefaultAdapters(registry, {
      conductor: { observe, replier: { send: notWired } },
      terminal: { observe, terminal: { send: notWired } },
    });
    store = new SqueakSessionStore({ registry, source: options.monitor, now });
  } catch (error) {
    report("open", error);
    return null;
  }

  let closed = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const run = (): void => {
    timer = null;
    if (closed) return;
    lastRunAt = now();
    try {
      const fleet = new Map(options.monitor.snapshot.active.map((s) => [s.key, s]));
      syncSessions(db, store.sessions(), (session) => {
        const source = fleet.get(session.id);
        const localPath = source?.workspaceRoot || source?.cwd;
        return { project: inferProject(localPath ? { path: localPath } : {}) };
      });
    } catch (error) {
      report("write", error);
    }
  };

  const onSnapshot = (): void => {
    if (closed || timer !== null) return;
    const wait = lastRunAt + CORE_SYNC_MIN_GAP_MS - now();
    if (wait <= 0) run();
    else timer = setTimer(run, wait);
  };

  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = options.monitor.onSnapshot(() => {
      try {
        onSnapshot();
      } catch (error) {
        report("snapshot", error);
      }
    });
  } catch (error) {
    report("subscribe", error);
  }

  return {
    stop() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      if (timer !== null) clearTimer(timer);
      timer = null;
      try {
        db.close();
      } catch (error) {
        report("close", error);
      }
    },
  };
}
