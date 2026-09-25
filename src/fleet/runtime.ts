import { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
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
      contextPressurePercent: options.contextPressurePercent,
      codexQuotaWarnPercent: options.codexQuotaWarnPercent,
    },
  );

  const ingress = new HookIngressServer({
    port: options.hookPort,
    tokenPath: defaultHookInstallPaths(options.supportDir).tokenPath,
    onEvent: (event) => monitor.ingestHookEvent(event),
    readState: () => serializeState(monitor, canReply),
  });

  let canReply: ((session: FleetSession) => boolean) | null = null;
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
  };
}

/**
 * The payload the desktop duck renders. Everything it needs is computed here,
 * so the renderer stays presentational and cannot disagree with Telegram.
 */
export function serializeState(
  monitor: FleetMonitor,
  canReply: ((session: FleetSession) => boolean) | null = null,
): unknown {
  const snapshot = monitor.snapshot;
  const titles = distinctTitles(snapshot.active);
  return {
    generatedAt: snapshot.generatedAt,
    trackedCount: snapshot.sessions.length,
    duck: deriveDuckState(snapshot.active, snapshot.attention, Date.now()),
    codexUsage: snapshot.codexUsage,
    active: snapshot.active.map((session) => ({
      key: session.key,
      agent: session.agent,
      origin: session.origin,
      /** How the surfaces name the origin; null for Conductor, which is the default. */
      originLabel: originLabel(session),
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
       * chat, or the fleet key of a terminal agent it can type into; null
       * when neither applies.
       */
      replyTarget: session.conductorSessionId
        ? session.conductorSessionId
        : canReply?.(session)
          ? replyTargetFor(session)
          : null,
      /** Set only when another active row would read the same. */
      distinctTitle: titles.get(session.key) ?? null,
      git: session.git,
      costUsd: session.costUsd,
    })),
    attention: snapshot.attention.map((item) => ({
      key: item.session.key,
      kind: item.kind,
      since: item.since,
    })),
  };
}
