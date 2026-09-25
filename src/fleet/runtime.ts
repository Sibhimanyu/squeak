import { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import { CodexUsageReader } from "./codex-usage.js";
import { DiffReader } from "./diff-view.js";
import { deriveDuckState } from "./duck-mood.js";
import { distinctTitles } from "./radar.js";
import { FleetMonitor } from "./fleet-monitor.js";
import { FleetStore } from "./fleet-store.js";
import { ClaudeCostReader } from "./claude-cost.js";
import { GitStateReader } from "./git-state.js";
import { HookIngressServer } from "./hook-ingress.js";
import { defaultHookInstallPaths } from "./hook-install.js";
import { ClaudeTranscriptObserver } from "./observers/claude-transcript.js";
import { CodexRolloutObserver } from "./observers/codex-rollout.js";
import { ConductorObserver } from "./observers/conductor.js";
import { ProcessLivenessObserver } from "./observers/process-liveness.js";

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
    readState: () => serializeState(monitor),
  });

  return { registry, store, monitor, ingress, diff: new DiffReader(), codexUsage: new CodexUsageReader() };
}

/**
 * The payload the desktop duck renders. Everything it needs is computed here,
 * so the renderer stays presentational and cannot disagree with Telegram.
 */
export function serializeState(monitor: FleetMonitor): unknown {
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
