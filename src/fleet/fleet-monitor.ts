import { logger } from "../utils/logger.js";
import { newestFirst, selectActiveSessions } from "./active.js";
import {
  DEFAULT_CONTEXT_PRESSURE_PERCENT,
  PUSH_FINISH_WITHIN_MS,
  shouldPush,
  classifyAttentions,
  scoreAttention,
  sortAttention,
} from "./attention.js";
import type { FleetStore } from "./fleet-store.js";
import { BackgroundWorkReader } from "./background-work.js";
import { applySpawnNesting, retireTempRuns, type SpawnParents } from "./spawn-parents.js";
import { attachDucklings, holdForBackgroundTasks } from "./ducklings.js";
import { applyHookEvents, applyLiveness, mergeObservations } from "./merge.js";
import { isSessionEndEvent, stateFromHookEvent } from "./hook-protocol.js";
import { Coalescer, realTimers, realWatchDeps, watchFiles } from "./change-watcher.js";
import type { Timers, WatchDeps, WatchHandle, WatchSpec } from "./change-watcher.js";
import type { ClaudeCoworkObserver } from "./observers/claude-cowork.js";
import type { ClaudeTranscriptObserver } from "./observers/claude-transcript.js";
import type { CodexRolloutObserver } from "./observers/codex-rollout.js";
import type { SqueakNativeObserver } from "./observers/squeak-native.js";
import type { FleetObserver } from "../addons.js";
import type { CodexUsage, CodexUsageReader } from "./codex-usage.js";
import { closingQuestion } from "./choices.js";
import type { ClaudeCostReader } from "./claude-cost.js";
import type { GitState, GitStateReader } from "./git-state.js";
import type { ArchivedSessions } from "./archived-sessions.js";
import type { LiveAgentProcess } from "./observers/process-liveness.js";
import type { AttentionItem, FleetDucklings, FleetSession, HookEvent, ObservedSession } from "./types.js";
import { workFolder } from "./session-folder.js";

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
  /**
   * Observers an add-on supplies (a host app's chats), read at every refresh; each checks for itself whether its
   * add-on is enabled. Absent: only the built-in sources are read.
   */
  observers?: (() => FleetObserver[]) | null;
  /**
   * Core reads these in claimed mode only: the transcripts and rollouts that Squeak's own chats and a host's chats
   * name by session id, for their path, stall and loop signals. Everything else on the Mac is an external agent,
   * seen only through an enabled add-on's observers (addons/claude-external, addons/codex-external).
   */
  claude: ClaudeTranscriptObserver;
  codex: CodexRolloutObserver;
  /** Optional: without it Claude Desktop's Cowork sessions are simply not seen. */
  cowork?: ClaudeCoworkObserver | null;
  /** Optional: without it Squeak's own session host's chats are simply not seen. */
  native?: SqueakNativeObserver | null;
  /** Optional: which agent processes are alive, from the external add-ons; without it none is known to be. */
  liveness?: { observe(): Promise<LiveAgentProcess[]> } | null | undefined;
  /** Optional: Squeak-side archive for threads Squeak does not run (archived-sessions.ts); without it none is hidden. */
  archived?: ArchivedSessions | null;
  /** Optional: who started which agent (spawn-parents.ts); without it nothing is nested or hidden. */
  spawnParents?: SpawnParents | null;
  /** Optional: without it the radar simply shows no working-tree detail. */
  git?: GitStateReader | null;
  /** Optional: without it a session's cost only ever shows what Claude Code itself reported. */
  claudeCost?: ClaudeCostReader | null;
  /** Optional: without it Codex quota is simply never shown or pushed. */
  codexUsage?: CodexUsageReader | null;
  /**
   * Optional: marks sessions directing a workflow that waits on the human
   * (an add-on's annotators, src/addon-host.ts). Without one they read as plain Claude sessions.
   */
  annotator?: { annotate(sessions: FleetSession[]): FleetSession[] } | null;
  /**
   * Optional: the agent's last message in full, for a finished session. Without it nothing is ever read as
   * asking a question. Set later with `setLastMessageSource`, since the replier that reads a host's
   * rows is built after the fleet.
   */
  lastMessage?: ((session: FleetSession) => string | null) | null;
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
  /**
   * Files whose changes should trigger a refresh right away (Conductor's
   * database, transcript folders). The periodic poll stays as the safety net.
   */
  /** Folders to watch; a function is read again by `rewatch()` (an add-on turned on or off changes what to watch). */
  watch?: WatchSpec[] | (() => WatchSpec[]);
  /** Burst window before a watched change refreshes. */
  watchDelayMs?: number;
  /** Never refresh from watch events more often than this. */
  watchMinGapMs?: number;
  /** Re-reads after a Stop hook for a chat Conductor still calls working. */
  stopFollowUpsMs?: number[];
  timers?: Timers;
  watchDeps?: WatchDeps;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_DELAY_MS = 250;
// A working agent writes all the time and a refresh costs ~440 ms (mostly the
// Conductor query), so file-change refreshes are at least 2 s apart: ~20% of a
// core at worst instead of ~40% at 600 ms. A finish still lands within ~2 s,
// and Stop-hook follow-ups catch Conductor's status flip.
const DEFAULT_WATCH_MIN_GAP_MS = 2_000;
/** Conductor flips status a moment after the turn-end row; look again soon, then less eagerly. */
const DEFAULT_STOP_FOLLOW_UPS_MS = [500, 1_500, 4_000];
const DEFAULT_HOOK_DEBOUNCE_MS = 400;
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CODEX_QUOTA_WARN_PERCENT = 85;
/** A finished session is read for a closing question only this long: older ones are not waiting on you. */
const ASKS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A message not readable yet (a transcript still flushing) is looked at again after this. */
const ASKS_RETRY_MS = 5_000;

/**
 * Turns "what is on this machine" into "what needs you".
 *
 * Polling alone would be both late and wrong — a transcript cannot record an
 * approval prompt. Hooks alone would miss every session that started before
 * they were installed. The monitor runs both: poll for coverage, hooks for
 * precision and immediacy, with a hook arrival kicking an out-of-band refresh
 * so a blocked agent reaches Telegram in about a second rather than twenty.
 */
/** What a session whose checkout is on a detached HEAD shows in place of a branch. */
export const DETACHED_BRANCH = "detached";

export class FleetMonitor {
  private readonly deps: FleetMonitorDependencies;
  private readonly pollIntervalMs: number;
  private readonly hookDebounceMs: number;
  private readonly snapshotTtlMs: number;
  private readonly contextPressurePercent: number;
  private readonly codexQuotaWarnPercent: number;
  private readonly now: () => number;
  private readonly watchSpecs: () => WatchSpec[];
  private readonly watchDelayMs: number;
  private readonly watchMinGapMs: number;
  private readonly stopFollowUpsMs: number[];
  private readonly timers: Timers;
  private readonly watchDeps: WatchDeps;
  private watcher: WatchHandle | null = null;
  private watchCoalescer: Coalescer | null = null;
  private readonly followUpTimers = new Set<unknown>();
  /** What a finished session's last message asked, read once per `key|lastActivityAt`. */
  private readonly asksCache = new Map<string, { asks: string | null; at: number }>();

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
  private started = false;

  private readonly backgroundWork = new BackgroundWorkReader();

  constructor(deps: FleetMonitorDependencies, options: FleetMonitorOptions = {}) {
    this.deps = deps;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.hookDebounceMs = options.hookDebounceMs ?? DEFAULT_HOOK_DEBOUNCE_MS;
    this.snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.contextPressurePercent = options.contextPressurePercent ?? DEFAULT_CONTEXT_PRESSURE_PERCENT;
    this.codexQuotaWarnPercent = options.codexQuotaWarnPercent ?? DEFAULT_CODEX_QUOTA_WARN_PERCENT;
    this.now = options.now ?? Date.now;
    const watch = options.watch ?? [];
    this.watchSpecs = typeof watch === "function" ? watch : () => watch;
    this.watchDelayMs = options.watchDelayMs ?? DEFAULT_WATCH_DELAY_MS;
    this.watchMinGapMs = options.watchMinGapMs ?? DEFAULT_WATCH_MIN_GAP_MS;
    this.stopFollowUpsMs = options.stopFollowUpsMs ?? DEFAULT_STOP_FOLLOW_UPS_MS;
    this.timers = options.timers ?? realTimers;
    this.watchDeps = options.watchDeps ?? realWatchDeps;
  }

  /** Whether any channel wants finishes from every agent, not only Conductor's. Absent: none does. */
  setWidenFinishes(widen: (() => boolean) | null): void {
    this.widenFinishes = widen;
  }

  private widenFinishes: (() => boolean) | null = null;

  /** Where a finished session's last message is read from, to tell whether it ends on a question. */
  setLastMessageSource(read: ((session: FleetSession) => string | null) | null): void {
    this.deps.lastMessage = read;
    this.asksCache.clear();
  }

  /** Where a Squeak chat's background helpers are read from (the session host); absent: none are shown. */
  setNativeDucklingsSource(read: (() => Promise<Map<string, FleetDucklings>>) | null): void {
    this.ducklingsSource = read;
  }

  private ducklingsSource: (() => Promise<Map<string, FleetDucklings>>) | null = null;

  private async nativeDucklings(): Promise<Map<string, FleetDucklings>> {
    try {
      return (await this.ducklingsSource?.()) ?? new Map();
    } catch {
      return new Map();
    }
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
    this.started = true;
    void this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.startWatching();
  }

  /** A watched file changed: refresh soon, coalescing bursts. Safe to call any time. */
  requestRefresh(): void {
    this.watchCoalescer?.poke();
  }

  /** Reads the watch list again and watches that (after an add-on is turned on or off). No-op unless running. */
  rewatch(): void {
    if (this.stopped || !this.started) return;
    this.watcher?.close();
    this.watcher = null;
    this.watchCoalescer?.close();
    this.watchCoalescer = null;
    this.startWatching();
  }

  private startWatching(): void {
    const specs = this.watchSpecs();
    if (this.watcher || specs.length === 0) {
      return;
    }
    this.watchCoalescer = new Coalescer(() => void this.refresh(), {
      delayMs: this.watchDelayMs,
      minGapMs: this.watchMinGapMs,
      timers: this.timers,
    });
    this.watcher = watchFiles(specs, () => this.requestRefresh(), this.watchDeps);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    this.watchCoalescer?.close();
    this.watchCoalescer = null;
    for (const handle of this.followUpTimers) {
      this.timers.clearTimeout(handle);
    }
    this.followUpTimers.clear();
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

    if (this.stopped) {
      return;
    }
    this.scheduleStopFollowUps(event);
    if (this.hookTimer) {
      return;
    }
    this.hookTimer = setTimeout(() => {
      this.hookTimer = null;
      void this.refresh();
    }, this.hookDebounceMs);
    this.hookTimer.unref?.();
  }

  /**
   * A Stop hook is instant, but Conductor writes the turn-end row and flips
   * its status a moment later — and while it still says working the hook is
   * rightly held (merge.ts). So look again shortly after, rather than waiting
   * for the next poll, so the finish lands as soon as Conductor lets it.
   */
  private scheduleStopFollowUps(event: HookEvent): void {
    if (stateFromHookEvent(event) !== "finished") {
      return;
    }
    const held = this.latest.sessions.some(
      (session) => session.agentSessionId === event.sessionId && session.hostState === "working",
    );
    if (!held) {
      return;
    }
    for (const delay of this.stopFollowUpsMs) {
      const handle = this.timers.setTimeout(() => {
        this.followUpTimers.delete(handle);
        if (!this.stopped) {
          void this.refresh();
        }
      }, delay);
      this.followUpTimers.add(handle);
    }
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

  /**
   * A host settles its own sessions after the merge (its observer's `resolve`): a chat the host calls `waiting`
   * whose only background work is an old shell is finished. Background work is read only when asked for.
   * A Squeak chat gets its helpers from the session host.
   */
  private resolveHostSessions(
    sessions: FleetSession[],
    observers: FleetObserver[],
    ducklings: Map<string, FleetDucklings>,
  ): FleetSession[] {
    const resolvers = observers.filter((observer) => observer.resolve && observer.hostId);
    const nowMs = this.now();
    const context = {
      nowMs,
      backgroundTasks: (session: FleetSession) =>
        session.transcriptPath ? this.backgroundWork.read(session.transcriptPath, nowMs) : [],
    };
    return sessions.map((session) => {
      const resolver = session.hostId ? resolvers.find((observer) => observer.hostId === session.hostId) : undefined;
      const settled = resolver?.resolve ? resolver.resolve(session, context) : session;
      // A Squeak-run chat's helpers ride along; its turn ended, so it stays what the host says (ready).
      return settled.origin === "squeak" ? attachDucklings(settled, ducklings.get(settled.sourceId), nowMs) : settled;
    });
  }

  /** A terminal Claude chat with a live process and background workers still running is working, not finished. */
  private holdTerminalHelpers(sessions: FleetSession[]): FleetSession[] {
    const nowMs = this.now();
    return sessions.map((session) =>
      session.agent === "claude" &&
      !session.hostId &&
      session.origin !== "squeak" &&
      session.alive &&
      session.transcriptPath &&
      (session.state === "finished" || session.state === "idle")
        ? holdForBackgroundTasks(session, this.backgroundWork.read(session.transcriptPath, nowMs), nowMs)
        : session,
    );
  }

  private nestSpawned(sessions: FleetSession[]): FleetSession[] {
    const parents = this.deps.spawnParents;
    return parents
      ? applySpawnNesting(sessions, {
          parentCwdOf: (id) => parents.parentCwdOf(id),
          hideStray: Boolean(this.deps.native),
        })
      : sessions;
  }

  /** After liveness (`alive` is set there): a throwaway run in a temp folder, with or without spawn parents or the native observer. */
  private retireTemp(sessions: FleetSession[]): FleetSession[] {
    const parents = this.deps.spawnParents;
    return retireTempRuns(sessions, parents ? (id) => parents.parentCwdOf(id) : undefined);
  }

  private applyArchived(sessions: FleetSession[]): FleetSession[] {
    return this.deps.archived ? this.deps.archived.apply(sessions) : sessions;
  }

  private async buildSnapshot(): Promise<FleetSnapshot> {
    const observedAt = new Date(this.now()).toISOString();

    const hostObservers = this.deps.observers?.() ?? [];
    const owned: ObservedSession[] = [
      ...hostObservers.flatMap((observer) => safeObserve(() => observer.observe(), observer.source)),
      ...safeObserve(() => this.deps.native?.observe() ?? [], "squeak-native"),
    ];
    // Claimed mode: the transcript of a chat something else already names, unless an enabled external add-on's
    // full scan has read it (those rows carry the same sources).
    const claimed = (agent: "claude" | "codex", source: string): Set<string> => {
      const scanned = new Set(owned.filter((row) => row.source === source).map((row) => row.agentSessionId));
      return new Set(
        owned
          .filter((row) => row.agent === agent && row.agentSessionId && !scanned.has(row.agentSessionId))
          .map((row) => row.agentSessionId as string),
      );
    };
    const observations: ObservedSession[] = [
      ...owned,
      ...safeObserve(
        () => this.deps.claude.observe({ ids: claimed("claude", "claude-transcript") }),
        "claude-transcript",
      ),
      ...safeObserve(() => this.deps.codex.observe({ ids: claimed("codex", "codex-rollout") }), "codex-rollout"),
      ...safeObserve(() => this.deps.cowork?.observe() ?? [], "claude-cowork"),
    ];

    const processes = (await this.deps.liveness?.observe()) ?? [];
    const ducklings = await this.nativeDucklings();
    const sessions = this.annotateAsks(
      this.annotateSessions(
        this.applyArchived(
          this.retireTemp(
            this.holdTerminalHelpers(
              applyLiveness(
                this.nestSpawned(
                  applyHookEvents(
                    this.resolveHostSessions(mergeObservations(observations), hostObservers, ducklings),
                    this.hookEvents,
                  ),
                ),
                processes,
              ),
            ),
          ),
        ),
      ),
    );

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

      const kinds = classifyAttentions(session, this.contextPressurePercent, this.now());
      if (kinds.length === 0) {
        continue;
      }

      const review = this.deps.store.getReview(session.key);
      if (review?.snoozedUntil && review.snoozedUntil > observedAt) {
        continue;
      }

      for (const kind of kinds) {
        // A stall is timed from the last thing the agent wrote, so each stall
        // is its own episode (one card each), not the whole working stretch.
        // A workflow's call is its own episode too: picking a story and then
        // being asked for a look is two pages, even if no refresh saw the
        // director working in between.
        const since =
          kind === "stalled"
            ? (session.waitingSince ?? recorded.stateEnteredAt)
            : kind === "looping" && session.looping
              ? session.looping.since || recorded.stateEnteredAt
              : kind === "blocked_question" && session.workflow
                ? session.workflow.since
                : recorded.stateEnteredAt;
        const item: AttentionItem = {
          session,
          kind,
          since,
          score: scoreAttention({ kind, since, session, now: this.now() }),
        };
        attention.push(item);

        // D2: only genuinely blocked sessions interrupt. Everything else waits
        // on the radar, where it costs the user nothing to not look.
        // A channel set to "every finish" widens it; each channel then applies its own settings (notify-settings.ts).
        const wide = (kind === "finished_unreviewed" || kind === "asked_question") && this.widenFinishes?.() === true;
        if (!(wide || shouldPush(kind, session)) || this.isMuted(session, observedAt)) {
          continue;
        }
        // Active for a day, but a finish is news only for a few minutes.
        if (
          (kind === "finished_unreviewed" || kind === "asked_question") &&
          this.now() - Date.parse(session.lastActivityAt) >= PUSH_FINISH_WITHIN_MS
        ) {
          continue;
        }
        const claimed = this.deps.store.claimNotification({
          sessionKey: session.key,
          kind,
          stateEnteredAt: since,
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
      active: newestFirst(enriched.sessions.filter((session) => activeKeys.has(session.key))),
      attention: sortAttention(attention.map((item) => enriched.remap(gitEnriched.remap(item)))),
      generatedAt: observedAt,
      codexUsage,
    };
  }

  /**
   * Marks a finished session whose last message closes on a question for the person. Only finished, open
   * sessions touched in the last day are read, once per change, so a long list of old chats costs nothing.
   */
  private annotateAsks(sessions: FleetSession[]): FleetSession[] {
    const read = this.deps.lastMessage;
    if (!read) {
      return sessions;
    }
    const nowMs = this.now();
    const live = new Set<string>();
    const result = sessions.map((session) => {
      if (
        session.state !== "finished" ||
        session.retired ||
        nowMs - Date.parse(session.lastActivityAt) > ASKS_WINDOW_MS
      ) {
        return session;
      }
      const cacheKey = `${session.key}|${session.lastActivityAt}`;
      live.add(cacheKey);
      let entry = this.asksCache.get(cacheKey);
      // A just-ended turn may not be readable yet (a transcript still flushing): look again for a minute.
      if (
        entry?.asks === null &&
        nowMs - entry.at >= ASKS_RETRY_MS &&
        nowMs - Date.parse(session.lastActivityAt) < 60_000
      ) {
        entry = undefined;
      }
      if (!entry) {
        let asks: string | null = null;
        try {
          asks = closingQuestion(read(session));
        } catch (error) {
          logger.debug("fleet last message read failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        entry = { asks, at: nowMs };
        this.asksCache.set(cacheKey, entry);
      }
      return entry.asks ? { ...session, asks: entry.asks } : session;
    });
    for (const key of [...this.asksCache.keys()]) {
      if (!live.has(key)) {
        this.asksCache.delete(key);
      }
    }
    return result;
  }

  private annotateSessions(sessions: FleetSession[]): FleetSession[] {
    if (!this.deps.annotator) {
      return sessions;
    }
    try {
      return this.deps.annotator.annotate(sessions);
    } catch (error) {
      logger.warn("fleet session annotation failed", { error: error instanceof Error ? error.message : String(error) });
      return sessions;
    }
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
      const folder = workFolder(session);
      if (wanted.has(session.key) && folder) {
        // Two sessions in one workspace share a working tree; read it once.
        targets.set(folder, targets.get(folder) ?? session.baseRef);
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
      const folder = workFolder(session);
      const state = wanted.has(session.key) && folder ? (states.get(folder) ?? null) : null;
      // A transcript's "HEAD" is not a branch: the repo's own answer is, and when it has none the checkout is detached.
      const branch = state && session.branch === "HEAD" ? (state.branch ?? DETACHED_BRANCH) : session.branch;
      const updated = state ? { ...session, git: state, branch } : session;
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
