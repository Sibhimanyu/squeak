import { initFlags } from "../squeak/flags.js";
import path from "node:path";

import { reapOrphanedAgents, setAgentLedger } from "./agent-procs.js";

import { defaultHookInstallPaths } from "../fleet/hook-install.js";
import { AgentSettings } from "./agent-settings.js";
import { Artifacts } from "./artifacts.js";
import { ProjectPrefs } from "./project-prefs.js";
import { DutyKeeper } from "./duty-keeper.js";
import { logger } from "../utils/logger.js";
import { SessionHost } from "./host.js";
import { startSystemProxy } from "../squeak/system-proxy.js";
import { adoptLoginShellPath } from "./shell-env.js";
import { DEFAULT_HOST_PORT, mcpEndpointAt, NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { createFlotilla, flotillaEnabled, type Flotilla } from "../flotilla/index.js";
import { agentSdkPresent, prefetchAgentSdk } from "./agent-sdk.js";
import type { AgentTools } from "./agent-tools.js";
import { runCompaction } from "./compact.js";
import { attachSqueakPosts, Room } from "./room.js";
import { PondNotebook } from "./pond-notebook.js";
import { ShowRelay } from "./show-relay.js";
import { RoomTasks } from "./room-tasks.js";
import { defaultTitleCall, type TitleModelCall } from "./auto-title.js";
import { haikuDecider } from "./decider.js";
import {
  createDecider,
  createFinishWriters,
  createSummaryWriters,
  deciderHelperDirs,
  onDeviceTitleCall,
  resolveDeciderHelper,
} from "./on-device.js";
import { haikuFinishWriter } from "./room-finish.js";
import { backfillSummaries, haikuSummaryWriter } from "./room-handoff-summary.js";
import { RoomSummariser } from "./room-summary.js";
import { Placement } from "./placement.js";
import { ChatStarter } from "./chat-starter.js";
import { createSharedTools } from "./shared-tools.js";
import { WorkspaceSources } from "./workspace-sources.js";

/** `squeak host`: Squeak's own session host. `native.db` (not `squeak.db`, which the daemon's bridge already owns). */
/** The host is its own process: it must read `<supportDir>/flags.json` itself, as the daemon's config load does, or a
 * flag set in the file (not the environment) is on in the daemon and off in the host. */
export function initHostFlags(supportDir: string): void {
  initFlags(supportDir);
}

export async function runHost(supportDir: string): Promise<void> {
  initHostFlags(supportDir);
  // Before anything starts an agent or a script: they inherit this PATH.
  logger.info("squeak host PATH", { from: adoptLoginShellPath() });
  startSystemProxy();
  // A host that died hard leaves its `claude`/`codex` children running: end them before starting our own.
  const agentLedger = path.join(supportDir, "host-agents.json");
  try {
    const reaped = await reapOrphanedAgents(agentLedger);
    if (reaped.length) logger.warn("squeak host reaped orphaned agent processes", { pids: reaped });
  } catch (error) {
    logger.warn("squeak host could not reap orphaned agents", { error: String(error) });
  }
  setAgentLedger(agentLedger);
  void new ProjectPrefs(supportDir).migrateIcons().catch(() => undefined);
  const store = new NativeStore(path.join(supportDir, "native.db"));
  // Late-bound: the server (and so the tools' address) exists only after the host.
  let server: NativeServer | null = null;
  const port = Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT;
  const hostTokenPath = defaultHookInstallPaths(supportDir).tokenPath;
  // Late-bound like the server: ponds exist only after the host.
  let flotilla: Flotilla | null = null;
  const host = new SessionHost({
    store,
    // Before the server exists (host.start() restarts queued turns) the address is still known: never run without tools.
    mcpFor: (id) => server?.mcpEndpoint(id) ?? mcpEndpointAt(hostTokenPath, port, id),
    claudeAiConnectors: () => new AgentSettings(supportDir).get().claudeAiConnectors,
    ownerName: () => flotilla?.service?.identity.name ?? null,
    titleCall: onDeviceTitleCall({
      setting: () => new AgentSettings(supportDir).get().deciderModel,
      helper: () => resolveDeciderHelper({ dirs: deciderHelperDirs(supportDir) }),
      fallback: defaultTitleCall(),
    }),
  });
  let titleCall: TitleModelCall | null = null;
  const agentSettings = new AgentSettings(supportDir);
  // A Duck-to-Duck message its sender gave no summary for gets one written: on-device, else Haiku.
  const summaryWriters = createSummaryWriters({
    setting: () => agentSettings.get().deciderModel,
    helper: () => resolveDeciderHelper({ dirs: deciderHelperDirs(supportDir) }),
    haiku: haikuSummaryWriter(() => (titleCall ??= defaultTitleCall())),
  });
  const room = new Room({
    store,
    summaryWriters,
    ownerName: () => flotilla?.service?.identity.name ?? null,
    attachmentsDir: path.join(supportDir, "room-attachments"),
    members: (id) => server?.pondMembers(id) ?? 0,
    helpers: (id) => host.helpersOf(id),
    deliver: (id, text, o) =>
      host.send(id, text, { room: true, mode: "steer", ...(o?.onSteered ? { onSteered: o.onSteered } : {}) }),
  });
  attachSqueakPosts(host, store, room);
  try {
    store.dropSqueakTurnPosts();
  } catch {
    /* only tidying old noise */
  }
  try {
    const off = room.retireStaleDucksOnce();
    if (off) logger.info("ducks quiet for over a day put off duty (once)", { off });
  } catch (error) {
    logger.warn("stale duck cleanup skipped", { error: String(error) });
  }
  new RoomSummariser({ host, store, room }).start();
  const workspaces = new WorkspaceManager({ store });
  // One place starts every chat: the jobs, the agent tools, the Planner and the routes all go through the starter.
  const sources = new WorkspaceSources({ store, workspaces });
  const placement = new Placement({ store, workspaces, sources });
  const starter = new ChatStarter({ store, host, workspaces, placement, room });
  // Routing a new Task: this Mac's own models by default (the bundled squeak-decider helper), Haiku by the setting or
  // whenever the helper cannot answer. The setting is read on every Task, so a change needs no restart.
  const decider = createDecider({
    setting: () => agentSettings.get().deciderModel,
    helper: () => resolveDeciderHelper({ dirs: deciderHelperDirs(supportDir) }),
    haiku: haikuDecider(() => (titleCall ??= defaultTitleCall())),
    onModelError: (error) => logger.warn("decider model failed", { error: String(error) }),
  });
  const notebook = new PondNotebook(store);
  // One artifact list and one open-in-app relay: the server routes and the agent tools (`show`) share them.
  const artifacts = new Artifacts({ store });
  const showRelay = new ShowRelay();
  const jobs = new RoomTasks({
    store,
    room,
    send: (id, text) => host.send(id, text, { room: true }),
    newThread: (projectId, text, title, attach) => starter.jobThread(projectId, text, title, attach),
    notebook: (projectId) => notebook.forBriefing(projectId),
    start: (spec) => starter.startDuck(spec),
    newBranch: (projectId, text) => starter.newBranch(projectId, text),
    checkBranch: (projectId, branch) => starter.checkBranch(projectId, branch),
    decider,
    onTaskDone: (id) => host.titleTaskDone(id),
    // A Duck that finishes a Task without posting gets its Room message written: on-device, else Haiku.
    finishWriters: createFinishWriters({
      setting: () => agentSettings.get().deciderModel,
      helper: () => resolveDeciderHelper({ dirs: deciderHelperDirs(supportDir) }),
      haiku: haikuFinishWriter(() => (titleCall ??= defaultTitleCall())),
    }),
    contextPercent: (s) => host.contextOf(s)?.percent ?? null,
  });
  jobs.attach(host);
  new DutyKeeper({ room, busy: () => jobs.busyDuckIds() }).start();
  workspaces.recover();
  for (const project of store.listProjects()) workspaces.reconcileGone(project.id);
  host.start();
  // One-time, capped, in the background: old Duck-to-Duck posts get a summary line (resumes at the next start if capped).
  setTimeout(() => {
    void backfillSummaries({
      store,
      writers: summaryWriters,
      onWritten: (row) => room.emit("post-updated", row),
      onError: (error) => logger.warn("hand-off summary backfill model failed", { error: String(error) }),
    }).catch((error) => logger.warn("hand-off summary backfill failed", { error: String(error) }));
  }, 30_000).unref();
  // One-time, resumable: old screenshots and huge tool outputs leave the rows (a backup first, 40 ms slices).
  if (process.env.SQUEAK_NATIVE_COMPACT !== "off") {
    setTimeout(() => {
      void runCompaction({
        db: store.db,
        dbPath: path.join(supportDir, "native.db"),
        supportDir,
        busy: () => store.listSessions().some((s) => s.status === "working"),
      })
        .then((j) => j.skipped && logger.info("native.db compaction not run", { reason: j.skipped }))
        .catch((error) => logger.warn("native.db compaction failed", { error: String(error) }));
    }, 60_000).unref();
  }
  // The Agent SDK is fetched from npm on this Mac, not shipped: start it now so the first chat rarely waits.
  if (process.env.SQUEAK_AGENT_SDK_PREFETCH !== "off" && !agentSdkPresent()) {
    setTimeout(() => void prefetchAgentSdk(), 5_000).unref();
  }
  // Ponds: on for everyone (local ponds need no cloud); SQUEAK_FLOTILLA=off constructs nothing from src/flotilla.
  let shared: { sources: WorkspaceSources; placement: Placement; tools: AgentTools } | null = null;
  if (flotillaEnabled()) {
    shared = createSharedTools({
      store,
      workspaces,
      send: (id, text) => host.send(id, text),
      create: (spec) => starter.create(spec),
      sources,
      placement,
      post: (id, kind, payload) => host.post(id, kind, payload),
      room,
      jobs,
      notebook,
      artifactShown: (projectId) => artifacts.changed(projectId),
      openShown: (req) => showRelay.request(req),
      pond: {
        prefs: new ProjectPrefs(supportDir),
        // A Ripple needs the cloud: a local pond has none, so only a published pond gets one.
        ripple: async (projectId, projectName, text, by) => {
          const service = flotilla?.service;
          if (!service) return;
          const pond = service.ensureLocalPond({ name: projectName, projectId });
          if (pond.local) {
            logger.info("pond upkeep: local pond, no Ripple", { pond: pond.id });
            return;
          }
          await service.ripple(pond.id, text, by ? { id: `agent:${by.toLowerCase()}`, name: by } : undefined);
        },
      },
    });
    flotilla = createFlotilla({ host, starter, store, workspaces, ...shared, supportDir, room, jobs });
  }
  server = new NativeServer({
    host,
    store,
    workspaces,
    ...(flotilla && shared ? { flotilla, ...shared } : {}),
    sources,
    placement,
    starter,
    room,
    jobs,
    notebook,
    artifacts,
    showRelay,
    supportDir,
    tokenPath: defaultHookInstallPaths(supportDir).tokenPath,
    port,
  });
  await server.start();
  logger.info("squeak host listening", { port });
  const shutdown = (): void => {
    void (async () => {
      flotilla?.stop();
      await server.stop();
      await workspaces.shutdown();
      await host.stop();
      store.close();
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
