import { isUnclaimedHeadless } from "./active.js";
import type { ProjectGuess, ProjectInference } from "./project-inference.js";
import type { PowerState } from "./power-mode.js";
import type { AwakeEnd, AwakeState } from "./awake-session.js";
import type { HeatState } from "./heat.js";
import type { HotspotState } from "./hotspot.js";
import type { LidActionSettings, OpenActionSettings } from "./lid-actions.js";
import type { AwakeRules } from "./power-monitor.js";

/** The awake session as /state shows it (src/squeak/app.ts assembles it). */
export interface AwakeView {
  state: AwakeState | null;
  lidReady: boolean;
  lastEnd: AwakeEnd | null;
  lidActions: LidActionSettings;
  /** What a session does while the lid is open; absent from a daemon without the open mode. */
  openActions?: OpenActionSettings;
  lidClosedNow: boolean;
  /** Sleep left disabled outside any session (a restore owed, or not Squeak's); null when none. */
  sleepProblem?: string | null;
  /** The effective safety floors (config, normalized); surfaces draw these, never their own numbers. */
  rules?: AwakeRules;
  /** Hotspot failover's name and status; never the password. */
  hotspot?: HotspotState;
  /** Temperatures, fans and what heat.ts is doing about them. */
  heat?: HeatState;
  /** Energy mode (fleet/power-mode.ts); absent on a Mac with none. */
  power?: PowerState | null;
  /** What a message to a working chat does when it names no mode (fleet/send-default.ts). */
  sendDefault?: "queue" | "steer";
}
import os from "node:os";
import path from "node:path";
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
import { isLooping, isStalled } from "./attention.js";
import { SpawnParents } from "./spawn-parents.js";
import { defaultHookInstallPaths } from "./hook-install.js";
import { ClaudeCoworkObserver } from "./observers/claude-cowork.js";
import { ClaudeTranscriptObserver } from "./observers/claude-transcript.js";
import { CodexRolloutObserver } from "./observers/codex-rollout.js";
import { SqueakNativeObserver } from "./observers/squeak-native.js";
import { ProcessLivenessObserver } from "./observers/process-liveness.js";
import type { WatchSpec } from "./change-watcher.js";
import { ducklingsRunning } from "./ducklings.js";
import type { FleetDucklings, FleetSession } from "./types.js";
import type { AgentSession } from "../core/types.js";
import { startCoreSync, type CoreReplyPorts, type ExtraAdapters } from "../core/runtime-hook.js";
import type { FleetObserver } from "../addons.js";
import { logger } from "../utils/logger.js";
import { ArchivedSessions } from "./archived-sessions.js";
import { readClaudeSessionFiles } from "./terminal-process.js";

export interface FleetRuntimeOptions {
  /** Observers add-ons supply (a host app's chats), read at every refresh; each is inert while its add-on is off. */
  observers?: () => FleetObserver[];
  /** More files whose change should refresh the fleet at once (an add-on host's database). */
  watch?: WatchSpec[];
  /** Fields add-ons add to `/state` (which add-ons are enabled, and what each reports about itself). */
  stateFields?: () => Record<string, unknown>;
  /** Core adapters add-ons supply for their hosts' sessions. */
  coreAdapters?: ExtraAdapters;
  /** The hosted cloud's state for `/state` `.cloud.hosted` (cloud/hosted.ts `HostedView`); absent: no `cloud` key. */
  cloudHosted?: () => unknown;
  /** Squeak's own session host's database (`<support dir>/native.db`); absent: no native chats are seen. */
  nativeDbPath?: string;
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
  /** Marks sessions with what enabled add-ons know about them, e.g. a workflow waiting on the human (src/addon-host.ts). */
  annotator?: { annotate(sessions: FleetSession[]): FleetSession[] } | null;
  /** Infers which project a session belongs to for `/state` (project-inference.ts); absent: no project fields. */
  projects?: ProjectInference | null;
  /** The daemon's repliers for core's adapters; built after this runtime, so looked up at call time (null until then). */
  corePorts?: () => CoreReplyPorts | null;
}

export interface FleetRuntime {
  store: FleetStore;
  /** Squeak-side archive of threads Squeak does not run (`archived-sessions.json`). */
  archived: ArchivedSessions;
  monitor: FleetMonitor;
  ingress: HookIngressServer;
  diff: DiffReader;
  codexUsage: CodexUsageReader;
  /**
   * Which sessions outside Conductor can be answered, so `/state` can say so.
   * Set by whoever owns the replier; until then only Conductor chats can.
   */
  setCanReply(canReply: ((session: FleetSession) => boolean) | null): void;
  /**
   * Where a finished session's last message is read from, so a turn that ends on a question reads as
   * waiting on you. Set by whoever owns the replier; until then nothing reads as asking.
   */
  setLastMessage(read: ((session: FleetSession) => string | null) | null): void;
  /** Where a Squeak chat's background helpers are read from: the session host, by native session id. */
  setNativeDucklings(read: (() => Promise<Map<string, FleetDucklings>>) | null): void;
  /** Where /state reads Claude's last plan-limit reading from. */
  setClaudeLimits(read: (() => ClaudeLimits | null) | null): void;
  /** Where /state reads the awake session from (fleet/awake-session.ts). */
  setAwake(read: (() => AwakeView) | null): void;
  /** Core's sessions (`GET /control/core/sessions`); null when core is off (`SQUEAK_CORE=off`) or did not open. */
  coreSessions(): AgentSession[] | null;
}

/**
 * Assemble the whole fleet stack: observers, monitor, hook ingress, git.
 *
 * Extracted from the bridge so Squeak can own it instead. Only one
 * process may run this at a time — two would bind the same hook port and
 * double every notification.
 */
export function createFleetRuntime(options: FleetRuntimeOptions): FleetRuntime {
  const store = new FleetStore(options.stateDbPath);
  const observerWindow = { activeWithinMs: options.activeWindowMs, idleAfterMs: options.idleAfterMs };

  const spawnParents = new SpawnParents({ file: path.join(options.supportDir, "spawn-parents.json") });
  const archived = new ArchivedSessions({ file: path.join(options.supportDir, "archived-sessions.json") });
  const monitor = new FleetMonitor(
    {
      spawnParents,
      archived,
      store,
      ...(options.observers ? { observers: options.observers } : {}),
      claude: new ClaudeTranscriptObserver(observerWindow),
      codex: new CodexRolloutObserver(observerWindow),
      cowork: new ClaudeCoworkObserver(observerWindow),
      native: options.nativeDbPath ? new SqueakNativeObserver({ dbPath: options.nativeDbPath }) : null,
      liveness: new ProcessLivenessObserver({ claudeSessions: () => readClaudeSessionFiles() }),
      git: new GitStateReader(),
      codexUsage: new CodexUsageReader(),
      claudeCost: new ClaudeCostReader(),
      annotator: options.annotator ?? null,
    },
    {
      pollIntervalMs: options.pollIntervalMs,
      watch: [...watchSpecsFor(os.homedir(), options.nativeDbPath), ...(options.watch ?? [])],
      contextPressurePercent: options.contextPressurePercent,
      codexQuotaWarnPercent: options.codexQuotaWarnPercent,
    },
  );

  // Write-only mirror into core.db (SQUEAK_CORE=off disables it); never affects the fleet.
  const core = startCoreSync({
    monitor,
    supportDir: options.supportDir,
    warn: (message, detail) => logger.warn(message, detail),
    ...(options.corePorts ? { ports: options.corePorts } : {}),
    ...(options.coreAdapters ? { extraAdapters: options.coreAdapters } : {}),
  });
  if (core) {
    const stopMonitor = monitor.stop.bind(monitor);
    monitor.stop = () => {
      core.stop();
      stopMonitor();
    };
  }

  const ingress = new HookIngressServer({
    port: options.hookPort,
    tokenPath: defaultHookInstallPaths(options.supportDir).tokenPath,
    onEvent: (event) => monitor.ingestHookEvent(event),
    onSpawn: async (sessionId, hookPid) => {
      if (await spawnParents.observeHook(sessionId, hookPid)) void monitor.refresh();
    },
    readState: () =>
      serializeState(
        monitor,
        canReply,
        claudeLimits?.() ?? null,
        awake?.() ?? null,
        options.stateFields?.(),
        options.cloudHosted ? { hosted: options.cloudHosted() } : undefined,
        options.projects,
      ),
    onStateRead: () => {
      // Git remotes are read for what renders, off this request; the next read has them.
      if (options.projects) {
        void options.projects.warm([...monitor.snapshot.active, ...monitor.snapshot.sessions.slice(0, 80)]);
      }
    },
  });

  let canReply: ((session: FleetSession) => boolean) | null = null;
  let claudeLimits: (() => ClaudeLimits | null) | null = null;
  let awake: (() => AwakeView) | null = null;
  return {
    store,
    archived,
    monitor,
    ingress,
    diff: new DiffReader(),
    codexUsage: new CodexUsageReader(),
    setCanReply: (next) => {
      canReply = next;
    },
    setLastMessage: (next) => {
      monitor.setLastMessageSource(next);
    },
    setNativeDucklings: (next) => {
      monitor.setNativeDucklingsSource(next);
    },
    setClaudeLimits: (next) => {
      claudeLimits = next;
    },
    setAwake: (next) => {
      awake = next;
    },
    coreSessions: () => core?.sessions() ?? null,
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
  project: ProjectGuess | null = null,
): unknown {
  return {
    key: session.key,
    // Which project (pond) it belongs to and why (project-inference.ts); absent when none.
    ...(project ? { projectId: project.projectId, projectSource: project.projectSource } : {}),
    agent: session.agent,
    origin: session.origin,
    /** How the surfaces name the origin; null for a host app's chat (the host's label is `source`). */
    originLabel: originLabel(session),
    /** Which collapsible group a reopenable session belongs under. */
    source: sourceOf(session),
    state: session.state,
    title: session.title,
    repoName: session.repoName,
    branch: session.branch,
    cwd: session.cwd,
    detail: session.detail,
    /**
     * The question a finished session's last message closes on ("Want me to open a PR?"), else null.
     * Present means the agent is waiting on an answer: surfaces count it as needing you. State stays
     * `finished`, so a reply is allowed (a blocked Conductor chat refuses one).
     */
    asks: session.asks ?? null,
    lastActivityAt: session.lastActivityAt,
    contextPercent: session.contextPercent,
    // What the chat runs, named here so no surface formats it; absent when Conductor does not say.
    ...(session.model ? { model: session.model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(session.fast ? { fast: true } : {}),
    // The same as Conductor stores them, for the Mac app's model picker.
    ...(session.modelId ? { modelId: session.modelId } : {}),
    ...(session.effortId ? { effortId: session.effortId } : {}),
    // Working with no word from the model for long enough that it seems stuck (attention.ts decides).
    ...(isStalled(session, Date.now()) && session.waitingSince
      ? { stalled: { on: session.waitingOn === "api" ? "api" : "model", since: session.waitingSince } }
      : {}),
    // Repeating the same failing step (looping.ts): the step's label and how many times, for the Mac's row and button.
    ...(isLooping(session) && session.looping ? { looping: session.looping } : {}),
    // Conductor says `waiting`: the turn ended and background work it started is alive (still `working`); the Mac's quiet loader.
    ...(session.conductorWaiting && session.state === "working" ? { conductorWaiting: true } : {}),
    // A Squeak chat's background helpers (the chat itself is ready, not working); absent when none.
    ...(session.ducklings && session.ducklings.items.length > 0 ? { ducklings: session.ducklings } : {}),
    alive: session.alive,
    // Archived in Squeak (archived-sessions.ts): when; absent for a thread in the lists.
    ...(session.archivedAt ? { archived: true, archivedAt: session.archivedAt } : {}),
    /** A Squeak-native chat's open request (id, kind, summary), for the Mac app's approval cards; absent otherwise. */
    ...(session.nativeRequest ? { nativeRequest: session.nativeRequest } : {}),
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
  if (session.hostId) return session.rules?.label ?? session.hostId;
  if (session.origin === "squeak") return "Squeak";
  if (session.agent === "codex") return "Codex";
  if (session.agent === "claude") return "Claude";
  return "Other";
}

/** How many non-active sessions the hub offers to reopen, newest first. */
const MAX_OTHER_SESSIONS = 80;
/** How many archived threads `/state` lists, newest archived first. */
const MAX_ARCHIVED_SESSIONS = 500;

export function serializeState(
  monitor: FleetMonitor,
  canReply: ((session: FleetSession) => boolean) | null = null,
  claudeLimits: ClaudeLimits | null = null,
  awake: AwakeView | null = null,
  hostFields?: Record<string, unknown>,
  cloud?: { hosted: unknown },
  projects?: ProjectInference | null,
): unknown {
  const snapshot = monitor.snapshot;
  const titles = distinctTitles(snapshot.active);
  const activeKeys = new Set(snapshot.active.map((session) => session.key));
  // Everything still tracked but not on the active screen — the user's older
  // Conductor/Claude/Codex sessions, so the hub can reopen them. Dead
  // worktrees (retired) are dropped; the rest come newest-first.
  const others = snapshot.sessions
    .filter((session) => !activeKeys.has(session.key) && !session.retired && !isUnclaimedHeadless(session))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, MAX_OTHER_SESSIONS);
  const archivedSessions = snapshot.sessions
    .filter((session) => session.archivedAt !== undefined)
    .sort((a, b) => Date.parse(b.archivedAt ?? "") - Date.parse(a.archivedAt ?? ""))
    .slice(0, MAX_ARCHIVED_SESSIONS);
  return {
    generatedAt: snapshot.generatedAt,
    ...(hostFields ?? {}),
    ...(cloud ? { cloud } : {}),
    trackedCount: snapshot.sessions.length,
    // Background helpers running across the chats on screen, for the dashboard's figure.
    ducklingsRunning: ducklingsRunning(snapshot.active),
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
          ...(awake.openActions ? { awakeOpenActions: awake.openActions } : {}),
          awakeLidClosedNow: awake.lidClosedNow,
          // Sleep disabled with no session to show it, and what to do about it.
          awakeSleepProblem: awake.sleepProblem ?? null,
          ...(awake.rules ? { awakeRules: awake.rules } : {}),
          ...(awake.hotspot ? { hotspot: awake.hotspot } : {}),
          ...(awake.heat ? { heat: awake.heat } : {}),
          ...(awake.power ? { power: awake.power } : {}),
          ...(awake.sendDefault ? { sendDefault: awake.sendDefault } : {}),
        }
      : {}),
    active: snapshot.active.map((session) =>
      serializeSession(session, canReply, titles.get(session.key) ?? null, projects?.infer(session) ?? null),
    ),
    others: others.map((session) => serializeSession(session, canReply, null, projects?.infer(session) ?? null)),
    // Threads archived in Squeak (hidden in Squeak only), newest archived first: off `active`, `others`, attention and
    // pushes; the Mac's Archived page lists them. A Squeak chat's archive is the session host's, so none here.
    archived: archivedSessions.map((session) =>
      serializeSession(session, canReply, null, projects?.infer(session) ?? null),
    ),
    attention: snapshot.attention.map((item) => ({
      key: item.session.key,
      kind: item.kind,
      since: item.since,
    })),
  };
}

/**
 * What to watch so a change is seen in a quarter second, not at the next poll:
 * Squeak's own session host's database and the folders agents append transcripts to (an add-on adds its host's). The periodic poll remains the safety net.
 */
export function watchSpecsFor(home: string = os.homedir(), nativeDbPath?: string): WatchSpec[] {
  const native = nativeDbPath
    ? [{ dir: path.dirname(nativeDbPath), names: [path.basename(nativeDbPath), `${path.basename(nativeDbPath)}-wal`] }]
    : [];
  return [
    ...native,
    { dir: path.join(home, ".claude", "projects"), recursive: true },
    { dir: path.join(home, ".codex", "sessions"), recursive: true },
  ];
}
