import { logger } from "../utils/logger.js";
import { selectActiveSessions } from "./active.js";
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
import type { CodexUsage, CodexUsageReader } from "./codex-usage.js";
import type { ClaudeCostReader } from "./claude-cost.js";
import type { GitState, GitStateReader } from "./git-state.js";
import type { ProcessLivenessObserver } from "./observers/process-liveness.js";
import type { AttentionItem, FleetSession, HookEvent, ObservedSession } from "./types.js";

export interface FleetSnapshot {
  /** Everything the observers found, including the long tail of dead work. */
  sessions: FleetSession[];
  /** The handful running, stuck, or just finished. This is what gets shown. */
  active: FleetSession[];
  attention: AttentionItem[];
  generatedAt: string;
  /** OpenAI's account-wide rate-limit state, or null if never observed. */
  codexUsage: CodexUsage | null;
}

export interface FleetMonitorDependencies {
  store: FleetStore;
  conductor: ConductorObserver;
  claude: ClaudeTranscriptObserver;
  codex: CodexRolloutObserver;
  liveness: ProcessLivenessObserver;
  /** Optional: without it the radar simply shows no working-tree detail. */
  git?: GitStateReader | null;
  /** Optional: without it a session's cost only ever shows what Claude Code itself reported. */
  claudeCost?: ClaudeCostReader | null;
  /** Optional: without it Codex quota is simply never shown or pushed. */
  codexUsage?: CodexUsageReader | null;
}

export interface FleetMonitorOptions {
  pollIntervalMs?: number;
  /** How long a hook burst is allowed to coalesce before we re-read state. */
  hookDebounceMs?: number;
  /** Snapshots unseen for this long are forgotten. */
  snapshotTtlMs?: number;
  /** Context share past which a session is flagged as close to compacting. */
  contextPressurePercent?: number;
  /** Codex quota usage past which a one-time warning is pushed. */
  codexQuotaWarnPercent?: number;
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 20_000;
const DEFAULT_HOOK_DEBOUNCE_MS = 400;
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CODEX_QUOTA_WARN_PERCENT = 85;

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
  private readonly codexQuotaWarnPercent: number;
  private readonly now: () => number;

  /** Latest hook report per agent session id. */
  private readonly hookEvents = new Map<string, HookEvent>();
  private readonly listeners = new Set<(snapshot: FleetSnapshot) => void>();
  private readonly pushListeners = new Set<(items: AttentionItem[]) => void>();

  private latest: FleetSnapshot = {
    sessions: [],
    active: [],
    attention: [],
    generatedAt: new Date(0).toISOString(),
    codexUsage: null,
  };
  /** A plain event for something that has no FleetSession to attach to. */
  private readonly quotaListeners = new Set<(usage: CodexUsage, window: "primary" | "secondary") => void>();
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
    this.codexQuotaWarnPercent = options.codexQuotaWarnPercent ?? DEFAULT_CODEX_QUOTA_WARN_PERCENT;
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

  onQuotaAlert(listener: (usage: CodexUsage, window: "primary" | "secondary") => void): () => void {
    this.quotaListeners.add(listener);
    return () => this.quotaListeners.delete(listener);
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
    // Everything is still tracked, so a session waking up is noticed — but
    // only the active few can ask for attention or reach a screen.
    const activeKeys = new Set(selectActiveSessions(sessions, this.now()).map((session) => session.key));

    for (const session of sessions) {
      seenKeys.add(session.key);
      const recorded = this.deps.store.recordState({
        sessionKey: session.key,
        state: session.state,
        lastActivityAt: session.lastActivityAt,
        observedAt,
      });

      if (!activeKeys.has(session.key)) {
        continue;
      }

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

    // Read git last and only for the sessions that will be rendered, then
    // restate everything against the enriched copies — push cards are worth
    // more with a diffstat on them, so this has to happen before they go out.
    const gitEnriched = await this.attachGitState(sessions, attention);
    const enriched = this.attachClaudeCost(
      gitEnriched.sessions,
      attention.map((item) => gitEnriched.remap(item)),
    );

    if (pushes.length > 0) {
      this.emitPush(sortAttention(pushes.map((item) => enriched.remap(gitEnriched.remap(item)))));
    }

    const codexUsage = this.readCodexUsage();
    if (codexUsage) {
      this.checkQuotaAlerts(codexUsage, observedAt);
    }

    return {
      sessions: enriched.sessions,
      active: enriched.sessions.filter((session) => activeKeys.has(session.key)),
      attention: sortAttention(attention.map((item) => enriched.remap(gitEnriched.remap(item)))),
      generatedAt: observedAt,
      codexUsage,
    };
  }

  private readCodexUsage(): CodexUsage | null {
    if (!this.deps.codexUsage) {
      return null;
    }
    try {
      return this.deps.codexUsage.read();
    } catch (error) {
      logger.warn("fleet codex usage read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Account-wide, so this has no FleetSession to attach an AttentionItem to —
   * it gets its own small push path rather than being forced into the
   * per-session model. Keyed on resetsAt so it fires once per reset cycle
   * rather than once per point of usage climbed.
   */
  private checkQuotaAlerts(usage: CodexUsage, observedAt: string): void {
    const windows: Array<["primary" | "secondary", typeof usage.primary]> = [
      ["primary", usage.primary],
      ["secondary", usage.secondary],
    ];
    for (const [name, window] of windows) {
      if (!window || window.usedPercent < this.codexQuotaWarnPercent) {
        continue;
      }
      const claimed = this.deps.store.claimQuotaAlert(name, window.resetsAt, observedAt);
      if (!claimed) {
        continue;
      }
      for (const listener of this.quotaListeners) {
        try {
          listener(usage, name);
        } catch (error) {
          logger.warn("fleet quota listener threw", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Attach working-tree state to the sessions a human is about to look at.
   *
   * Deliberately not every session: git is the most expensive thing here, and
   * the twenty idle sessions that never reach the radar would pay for nothing.
   */
  private async attachGitState(
    sessions: FleetSession[],
    attention: AttentionItem[],
  ): Promise<{ sessions: FleetSession[]; remap: (item: AttentionItem) => AttentionItem }> {
    const identity = {
      sessions,
      remap: (item: AttentionItem): AttentionItem => item,
    };
    if (!this.deps.git) {
      return identity;
    }

    const wanted = new Set(attention.map((item) => item.session.key));
    for (const session of selectActiveSessions(sessions, this.now())) {
      wanted.add(session.key);
    }
    if (wanted.size === 0) {
      return identity;
    }

    const targets = new Map<string, string | null>();
    for (const session of sessions) {
      if (wanted.has(session.key) && session.cwd) {
        // Two sessions in one workspace share a working tree; read it once.
        targets.set(session.cwd, targets.get(session.cwd) ?? session.baseRef);
      }
    }
    if (targets.size === 0) {
      return identity;
    }

    let states: Map<string, GitState>;
    try {
      states = await this.deps.git.read(
        Array.from(targets, ([dir, baseRef]) => ({ dir, ...(baseRef ? { baseRef } : {}) })),
      );
    } catch (error) {
      logger.warn("fleet git read failed", { error: error instanceof Error ? error.message : String(error) });
      return identity;
    }

    const byKey = new Map<string, FleetSession>();
    const next = sessions.map((session) => {
      const state = wanted.has(session.key) && session.cwd ? (states.get(session.cwd) ?? null) : null;
      const updated = state ? { ...session, git: state } : session;
      byKey.set(session.key, updated);
      return updated;
    });

    return {
      sessions: next,
      remap: (item) => {
        const session = byKey.get(item.session.key);
        return session ? { ...item, session } : item;
      },
    };
  }

  /**
   * Fills in a session's cost when Claude Code never reported one itself —
   * the common case for anything Conductor drives. Reading a whole transcript
   * to sum it is real work, so this runs only for the sessions about to be
   * rendered, the same discipline attachGitState uses.
   */
  private attachClaudeCost(
    sessions: FleetSession[],
    attention: AttentionItem[],
  ): { sessions: FleetSession[]; remap: (item: AttentionItem) => AttentionItem } {
    const identity = { sessions, remap: (item: AttentionItem): AttentionItem => item };
    if (!this.deps.claudeCost) {
      return identity;
    }

    const wanted = new Set(attention.map((item) => item.session.key));
    for (const session of selectActiveSessions(sessions, this.now())) {
      wanted.add(session.key);
    }
    if (wanted.size === 0) {
      return identity;
    }

    const byKey = new Map<string, FleetSession>();
    const next = sessions.map((session) => {
      if (!wanted.has(session.key) || session.agent !== "claude" || !session.transcriptPath) {
        byKey.set(session.key, session);
        return session;
      }
      let costUsd: number | null;
      try {
        costUsd = this.deps.claudeCost!.read(session.transcriptPath, session.costUsd);
      } catch (error) {
        logger.warn("fleet claude cost read failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        costUsd = session.costUsd;
      }
      const updated = costUsd === session.costUsd ? session : { ...session, costUsd };
      byKey.set(session.key, updated);
      return updated;
    });

    return {
      sessions: next,
      remap: (item) => {
        const session = byKey.get(item.session.key);
        return session ? { ...item, session } : item;
      },
    };
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
