import { registerDefaultAdapters } from "./adapters/index.js";
import { AgentRegistry } from "./registry.js";
import { SqueakSessionStore, type SessionSource } from "./session-store.js";
import { CoreDb, defaultCoreDbPath } from "./store/core-db.js";
import { inferProject } from "./store/project-inference.js";
import { syncSessions } from "./store/sync.js";
import type { ConductorSendPort } from "./adapters/conductor-adapter.js";
import type { NativeHostPort } from "./adapters/native-adapter.js";
import type { TerminalSendPort } from "./adapters/terminal-adapters.js";
import type { AgentSession } from "./types.js";
import type { FleetSession } from "../fleet/types.js";

/** At most one sync this often; a burst of snapshots writes once, with the newest. */
export const CORE_SYNC_MIN_GAP_MS = 5000;

/** The daemon's real repliers, which core's adapters send through. */
export interface CoreReplyPorts {
  /** FleetReplyRouter: a Conductor id or fleet key in, the right side answers. */
  conductor: ConductorSendPort;
  terminal: TerminalSendPort;
  /** NativeHostClient. */
  native: NativeHostPort;
}

/** The repliers are built after the fleet runtime; until they are, a send says so rather than pretending. */
export class CoreNotReadyError extends Error {
  constructor() {
    super("core replier is not ready yet");
    this.name = "CoreNotReadyError";
  }
}

/** Ports that look the real ones up at call time and throw `CoreNotReadyError` while there are none. */
export function lateBoundPorts(get: (() => CoreReplyPorts | null) | undefined): CoreReplyPorts {
  const ports = (): CoreReplyPorts => {
    const found = get?.();
    if (!found) throw new CoreNotReadyError();
    return found;
  };
  return {
    conductor: { send: async (...args) => ports().conductor.send(...args) },
    terminal: { send: async (...args) => ports().terminal.send(...args) },
    native: {
      send: async (...args) => ports().native.send(...args),
      interrupt: async (...args) => ports().native.interrupt(...args),
    },
  };
}

export interface CoreSyncOptions {
  /** The monitor; it satisfies the narrow source structurally. */
  monitor: SessionSource;
  supportDir: string;
  env?: NodeJS.ProcessEnv;
  warn: (message: string, detail?: Record<string, unknown>) => void;
  /** Late-bound real repliers; absent or null until built, sends then fail with `CoreNotReadyError`. */
  ports?: () => CoreReplyPorts | null;
  /** Tests inject a fake database. */
  openDb?: (dbPath: string) => CoreDb;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CoreSync {
  stop(): void;
  /** The store's sessions, newest first, with attention. */
  sessions(): AgentSession[];
}

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
    const ports = lateBoundPorts(options.ports);
    registerDefaultAdapters(registry, {
      conductor: { observe, replier: ports.conductor },
      terminal: { observe, terminal: ports.terminal },
      native: { observe, client: ports.native },
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
    sessions: () => store.sessions(),
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
