import { logger } from "../utils/logger.js";
import {
  DEFAULT_CONTEXT_PRESSURE_PERCENT,
  PUSH_KINDS,
  classifyAttentions,
  scoreAttention,
  sortAttention,
} from "./attention.js";
import type { FleetStore } from "./fleet-store.js";
import { applyHookEvents, applyLiveness, mergeObservations } from "./merge.js";
import { isSessionEndEvent } from "./hook-protocol.js";
import type { ClaudeTranscriptObserver } from "./observers/claude-transcript.js";
import type { CodexRolloutObserver } from "./observers/codex-rollout.js";
import type { ConductorObserver } from "./observers/conductor.js";
import type { ProcessLivenessObserver } from "./observers/process-liveness.js";
import type { AttentionItem, FleetSession, HookEvent, ObservedSession } from "./types.js";

export interface FleetSnapshot {
  sessions: FleetSession[];
  attention: AttentionItem[];
  generatedAt: string;
}

export interface FleetMonitorDependencies {
  store: FleetStore;
  conductor: ConductorObserver;
  claude: ClaudeTranscriptObserver;
  codex: CodexRolloutObserver;
  liveness: ProcessLivenessObserver;
}

export interface FleetMonitorOptions {
  pollIntervalMs?: number;
  /** How long a hook burst is allowed to coalesce before we re-read state. */
  hookDebounceMs?: number;
  /** Snapshots unseen for this long are forgotten. */
  snapshotTtlMs?: number;
  /** Context share past which a session is flagged as close to compacting. */
  contextPressurePercent?: number;
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 20_000;
const DEFAULT_HOOK_DEBOUNCE_MS = 400;
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Turns "what is on this machine" into "what needs you".
 *
 * Polling alone would be both late and wrong — a transcript cannot record an
 * approval prompt. Hooks alone would miss every session that started before
 * they were installed. The monitor runs both: poll for coverage, hooks for
 * precision and immediacy, with a hook arrival kicking an out-of-band refresh
 * so a blocked agent reaches Telegram in about a second rather than twenty.
 */
export class FleetMonitor {
  private readonly deps: FleetMonitorDependencies;
  private readonly pollIntervalMs: number;
  private readonly hookDebounceMs: number;
  private readonly snapshotTtlMs: number;
  private readonly contextPressurePercent: number;
  private readonly now: () => number;

  /** Latest hook report per agent session id. */
  private readonly hookEvents = new Map<string, HookEvent>();
  private readonly listeners = new Set<(snapshot: FleetSnapshot) => void>();
  private readonly pushListeners = new Set<(items: AttentionItem[]) => void>();

  private latest: FleetSnapshot = { sessions: [], attention: [], generatedAt: new Date(0).toISOString() };
  private pollTimer: NodeJS.Timeout | null = null;
  private hookTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private refreshQueued = false;
  private stopped = false;

  constructor(deps: FleetMonitorDependencies, options: FleetMonitorOptions = {}) {
    this.deps = deps;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.hookDebounceMs = options.hookDebounceMs ?? DEFAULT_HOOK_DEBOUNCE_MS;
    this.snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.contextPressurePercent = options.contextPressurePercent ?? DEFAULT_CONTEXT_PRESSURE_PERCENT;
    this.now = options.now ?? Date.now;
  }

  get snapshot(): FleetSnapshot {
    return this.latest;
  }

  onSnapshot(listener: (snapshot: FleetSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPush(listener: (items: AttentionItem[]) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.hookTimer) {
      clearTimeout(this.hookTimer);
      this.hookTimer = null;
    }
  }

  ingestHookEvent(event: HookEvent): void {
    if (!event.sessionId) {
      return;
    }

    if (isSessionEndEvent(event)) {
      this.hookEvents.delete(event.sessionId);
    } else {
      const existing = this.hookEvents.get(event.sessionId);
      // Out-of-order delivery is possible; never let an older report win.
      if (!existing || existing.receivedAt <= event.receivedAt) {
        this.hookEvents.set(event.sessionId, event);
      }
    }

    if (this.hookTimer || this.stopped) {
      return;
    }
    this.hookTimer = setTimeout(() => {
      this.hookTimer = null;
      void this.refresh();
    }, this.hookDebounceMs);
    this.hookTimer.unref?.();
  }

  async refresh(): Promise<FleetSnapshot> {
    // Refreshes touch the database and shell out; overlapping them would only
    // produce two answers to the same question.
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.latest;
    }

    this.refreshing = true;
    try {
      const snapshot = await this.buildSnapshot();
      this.latest = snapshot;
      this.emit(snapshot);
      return snapshot;
    } catch (error) {
      logger.warn("fleet refresh failed", { error: error instanceof Error ? error.message : String(error) });
      return this.latest;
    } finally {
      this.refreshing = false;
      if (this.refreshQueued && !this.stopped) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async buildSnapshot(): Promise<FleetSnapshot> {
    const observedAt = new Date(this.now()).toISOString();

    const observations: ObservedSession[] = [
      ...safeObserve(() => this.deps.conductor.observe(), "conductor"),
      ...safeObserve(() => this.deps.claude.observe(), "claude-transcript"),
      ...safeObserve(() => this.deps.codex.observe(), "codex-rollout"),
    ];

    const processes = await this.deps.liveness.observe();
    const sessions = applyLiveness(applyHookEvents(mergeObservations(observations), this.hookEvents), processes);

    const attention: AttentionItem[] = [];
    const pushes: AttentionItem[] = [];
    const seenKeys = new Set<string>();

    for (const session of sessions) {
      seenKeys.add(session.key);
      const recorded = this.deps.store.recordState({
        sessionKey: session.key,
        state: session.state,
        lastActivityAt: session.lastActivityAt,
        observedAt,
      });

      const kinds = classifyAttentions(session, this.contextPressurePercent);
      if (kinds.length === 0) {
        continue;
      }

      const review = this.deps.store.getReview(session.key);
      if (review?.reviewedAt || (review?.snoozedUntil && review.snoozedUntil > observedAt)) {
        continue;
      }

      for (const kind of kinds) {
        const item: AttentionItem = {
          session,
          kind,
          since: recorded.stateEnteredAt,
          score: scoreAttention({ kind, since: recorded.stateEnteredAt, session, now: this.now() }),
        };
        attention.push(item);

        // D2: only genuinely blocked sessions interrupt. Everything else waits
        // on the radar, where it costs the user nothing to not look.
        if (!PUSH_KINDS.has(kind) || this.isMuted(session, observedAt)) {
          continue;
        }
        const claimed = this.deps.store.claimNotification({
          sessionKey: session.key,
          kind,
          stateEnteredAt: recorded.stateEnteredAt,
          notifiedAt: observedAt,
        });
        if (claimed) {
          pushes.push(item);
        }
      }
    }

    this.deps.store.pruneSnapshots(seenKeys, new Date(this.now() - this.snapshotTtlMs).toISOString());

    if (pushes.length > 0) {
      this.emitPush(sortAttention(pushes));
    }

    return { sessions, attention: sortAttention(attention), generatedAt: observedAt };
  }

  private isMuted(session: FleetSession, atIso: string): boolean {
    if (this.deps.store.isMuted("*", atIso)) {
      return true;
    }
    return session.repoName ? this.deps.store.isMuted(session.repoName, atIso) : false;
  }

  private emit(snapshot: FleetSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        logger.warn("fleet snapshot listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emitPush(items: AttentionItem[]): void {
    for (const listener of this.pushListeners) {
      try {
        listener(items);
      } catch (error) {
        logger.warn("fleet push listener threw", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/** One broken observer must not blind the other three. */
function safeObserve(read: () => ObservedSession[], name: string): ObservedSession[] {
  try {
    return read();
  } catch (error) {
    logger.warn("fleet observer failed", {
      observer: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
