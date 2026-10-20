import type { AwakeEnd, AwakeState } from "./awake-session.js";
import type { LidActionSettings } from "./lid-actions.js";

/** The awake session as /state shows it (src/squeak/app.ts assembles it). */
export interface AwakeView {
  state: AwakeState | null;
  lidReady: boolean;
  lastEnd: AwakeEnd | null;
  lidActions: LidActionSettings;
  lidClosedNow: boolean;
  /** Sleep left disabled outside any session (a restore owed, or not Squeak's); null when none. */
  sleepProblem?: string | null;
}
import os from "node:os";
import path from "node:path";
import { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import type { ClaudeLimits } from "./claude-limits.js";
import { CodexUsageReader } from "./codex-usage.js";
import { DiffReader } from "./diff-view.js";
import { deriveDuckState } from "./duck-mood.js";
import { distinctTitles, originLabel } from "./radar.js";
import { replyTargetFor } from "./reply-router.js";
import { FleetMonitor } from "./fleet-monitor.js";
import { FleetStore } from "./fleet-store.js";
import { ClaudeCostReader } from "./claude-cost.js";
import { GitStateReader } from "./git-state.js";
import { HookIngressServer } from "./hook-ingress.js";
import { defaultHookInstallPaths } from "./hook-install.js";
import { ClaudeCoworkObserver } from "./observers/claude-cowork.js";
import { ClaudeTranscriptObserver } from "./observers/claude-transcript.js";
import { CodexRolloutObserver } from "./observers/codex-rollout.js";
import { ConductorObserver } from "./observers/conductor.js";
import { ProcessLivenessObserver } from "./observers/process-liveness.js";
import type { WatchSpec } from "./change-watcher.js";
import type { FleetSession } from "./types.js";

export interface FleetRuntimeOptions {
  conductorDbPath: string;
  workspacesRoot: string;
  defaultFallbackModel: string;
  defaultPermissionMode: string;
  /** Where the fleet's own SQLite state lives. */
  stateDbPath: string;
  /** Directory holding the hook token and installed hook script. */
  supportDir: string;
  hookPort: number;
  pollIntervalMs: number;
  activeWindowMs: number;
  idleAfterMs: number;
  contextPressurePercent: number;
  codexQuotaWarnPercent: number;
}

export interface FleetRuntime {
  registry: ConductorRegistryAdapter;
  store: FleetStore;
  monitor: FleetMonitor;
  ingress: HookIngressServer;
  diff: DiffReader;
  codexUsage: CodexUsageReader;
  /**
   * Which sessions outside Conductor can be answered, so `/state` can say so.
   * Set by whoever owns the replier; until then only Conductor chats can.
   */
  setCanReply(canReply: ((session: FleetSession) => boolean) | null): void;
  /** Where /state reads Claude's last plan-limit reading from. */
  setClaudeLimits(read: (() => ClaudeLimits | null) | null): void;
  /** Where /state reads the awake session from (fleet/awake-session.ts). */
  setAwake(read: (() => AwakeView) | null): void;
}

/**
 * Assemble the whole fleet stack: observers, monitor, hook ingress, git.
 *
 * Extracted from the bridge so Squeak can own it instead. Only one
 * process may run this at a time — two would bind the same hook port and
 * double every notification.
 */
export function createFleetRuntime(options: FleetRuntimeOptions): FleetRuntime {
  const registry = new ConductorRegistryAdapter(options.conductorDbPath, {
    workspacesRoot: options.workspacesRoot,
    defaultFallbackModel: options.defaultFallbackModel,
    defaultPermissionMode: options.defaultPermissionMode,
  });

  const store = new FleetStore(options.stateDbPath);
  const observerWindow = { activeWithinMs: options.activeWindowMs, idleAfterMs: options.idleAfterMs };

  const monitor = new FleetMonitor(
    {
      store,
      conductor: new ConductorObserver(registry, { finishedWithinMs: options.activeWindowMs }),
      claude: new ClaudeTranscriptObserver(observerWindow),
      codex: new CodexRolloutObserver(observerWindow),
      cowork: new ClaudeCoworkObserver(observerWindow),
      liveness: new ProcessLivenessObserver(),
      git: new GitStateReader(),
      codexUsage: new CodexUsageReader(),
      claudeCost: new ClaudeCostReader(),
    },
    {
      pollIntervalMs: options.pollIntervalMs,
      watch: watchSpecsFor(options.conductorDbPath),
      contextPressurePercent: options.contextPressurePercent,
      codexQuotaWarnPercent: options.codexQuotaWarnPercent,
    },
  );

  const ingress = new HookIngressServer({
    port: options.hookPort,
    tokenPath: defaultHookInstallPaths(options.supportDir).tokenPath,
    onEvent: (event) => monitor.ingestHookEvent(event),
    readState: () => serializeState(monitor, canReply, claudeLimits?.() ?? null, awake?.() ?? null),
  });

  let canReply: ((session: FleetSession) => boolean) | null = null;
  let claudeLimits: (() => ClaudeLimits | null) | null = null;
  let awake: (() => AwakeView) | null = null;
  return {
    registry,
    store,
    monitor,
    ingress,
    diff: new DiffReader(),
    codexUsage: new CodexUsageReader(),
    setCanReply: (next) => {
      canReply = next;
    },
    setClaudeLimits: (next) => {
      claudeLimits = next;
    },
    setAwake: (next) => {
      awake = next;
    },
  };
}

/**
 * The payload the desktop duck renders. Everything it needs is computed here,
 * so the renderer stays presentational and cannot disagree with Telegram.
 */
/** Everything a surface needs to draw and address one session row. */
function serializeSession(
  session: FleetSession,
  canReply: ((session: FleetSession) => boolean) | null,
  distinctTitle: string | null,
): unknown {
  return {
    key: session.key,
    agent: session.agent,
    origin: session.origin,
    /** How the surfaces name the origin; null for Conductor, which is the default. */
    originLabel: originLabel(session),
    /** Which collapsible group a reopenable session belongs under. */
    source: sourceOf(session),
    state: session.state,
    title: session.title,
    repoName: session.repoName,
    branch: session.branch,
    cwd: session.cwd,
    detail: session.detail,
    lastActivityAt: session.lastActivityAt,
    contextPercent: session.contextPercent,
    alive: session.alive,
    conductorSessionId: session.conductorSessionId,
    conductorWorkspaceId: session.conductorWorkspaceId ?? null,
    /**
     * What the window addresses a reply or message read to: the Conductor
     * chat (works even when idle, now that replies go through the local
     * relay), or the fleet key of a terminal agent it can type into; null
     * when neither applies.
     */
    replyTarget: session.conductorSessionId
      ? session.conductorSessionId
      : canReply?.(session)
        ? replyTargetFor(session)
        : null,
    distinctTitle,
    git: session.git,
    costUsd: session.costUsd,
  };
}

/** The hub groups reopenable sessions by where they live. */
function sourceOf(session: FleetSession): string {
  if (session.origin === "conductor") return "Conductor";
  if (session.agent === "codex") return "Codex";
  if (session.agent === "claude") return "Claude";
  return "Other";
}

/** How many non-active sessions the hub offers to reopen, newest first. */
const MAX_OTHER_SESSIONS = 80;

export function serializeState(
  monitor: FleetMonitor,
  canReply: ((session: FleetSession) => boolean) | null = null,
  claudeLimits: ClaudeLimits | null = null,
  awake: AwakeView | null = null,
): unknown {
  const snapshot = monitor.snapshot;
  const titles = distinctTitles(snapshot.active);
  const activeKeys = new Set(snapshot.active.map((session) => session.key));
  // Everything still tracked but not on the active screen — the user's older
  // Conductor/Claude/Codex sessions, so the hub can reopen them. Dead
  // worktrees (retired) are dropped; the rest come newest-first.
  const others = snapshot.sessions
    .filter((session) => !activeKeys.has(session.key) && !session.retired)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, MAX_OTHER_SESSIONS);
  return {
    generatedAt: snapshot.generatedAt,
    trackedCount: snapshot.sessions.length,
    duck: deriveDuckState(snapshot.active, snapshot.attention, Date.now()),
    codexUsage: snapshot.codexUsage,
    // Claude Code's last plan-limit reading (utilization 0-1), with when it was
    // seen; null until one has been. Refreshed only by the owner's request.
    claudeLimits,
    // The awake session (start, end time), for the menu bar; keepAwake is its on/off.
    // Present only when the daemon runs awake sessions; older surfaces read keepAwake.
    ...(awake
      ? {
          keepAwake: awake.state !== null,
          awake: awake.state,
          awakeLidReady: awake.lidReady,
          // How the last session ended, so a surface can say "ended: battery at 9%".
          awakeLastEnd: awake.lastEnd,
          // What a closed lid does, and whether it is doing it now.
          awakeLidActions: awake.lidActions,
          awakeLidClosedNow: awake.lidClosedNow,
          // Sleep disabled with no session to show it, and what to do about it.
          awakeSleepProblem: awake.sleepProblem ?? null,
        }
      : {}),
    active: snapshot.active.map((session) => serializeSession(session, canReply, titles.get(session.key) ?? null)),
    others: others.map((session) => serializeSession(session, canReply, null)),
    attention: snapshot.attention.map((item) => ({
      key: item.session.key,
      kind: item.kind,
      since: item.since,
    })),
  };
}

/**
 * What to watch so a change is seen in a quarter second, not at the next poll:
 * Conductor's database (its WAL gets the writes first) and the folders agents
 * append transcripts to. The periodic poll remains the safety net.
 */
export function watchSpecsFor(conductorDbPath: string, home: string = os.homedir()): WatchSpec[] {
  const dbName = path.basename(conductorDbPath);
  return [
    { dir: path.dirname(conductorDbPath), names: [dbName, `${dbName}-wal`] },
    { dir: path.join(home, ".claude", "projects"), recursive: true },
    { dir: path.join(home, ".codex", "sessions"), recursive: true },
  ];
}
