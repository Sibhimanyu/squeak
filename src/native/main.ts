import { flag, initFlags } from "../squeak/flags.js";
import path from "node:path";

import { reapOrphanedAgents, setAgentLedger } from "./agent-procs.js";

import { defaultHookInstallPaths } from "../fleet/hook-install.js";
import { AgentSettings } from "./agent-settings.js";
import { ProjectPrefs } from "./project-prefs.js";
import { logger } from "../utils/logger.js";
import { SessionHost } from "./host.js";
import { startSystemProxy } from "../squeak/system-proxy.js";
import { adoptLoginShellPath } from "./shell-env.js";
import { DEFAULT_HOST_PORT, NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { createFlotilla, flotillaEnabled, type Flotilla } from "../flotilla/index.js";
import { agentSdkPresent, prefetchAgentSdk } from "./agent-sdk.js";
import type { AgentTools } from "./agent-tools.js";
import { runCompaction } from "./compact.js";
import { attachSqueakPosts, Room } from "./room.js";
import { RoomTasks } from "./room-tasks.js";
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
  // Late-bound like the server: ponds exist only after the host.
  let flotilla: Flotilla | null = null;
  const host = new SessionHost({
    store,
    mcpFor: (id) => server?.mcpEndpoint(id) ?? null,
    claudeAiConnectors: () => new AgentSettings(supportDir).get().claudeAiConnectors,
    ownerName: () => flotilla?.service?.identity.name ?? null,
  });
  const room = new Room({
    store,
    ownerName: () => flotilla?.service?.identity.name ?? null,
    attachmentsDir: path.join(supportDir, "room-attachments"),
    ...(flag("roomSummary") ? { notebookSummary: "default" as const } : {}),
    members: (id) => server?.pondMembers(id) ?? 0,
    deliver: (id, text) => host.send(id, text, { room: true }),
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
  const jobs = new RoomTasks({
    store,
    room,
    send: (id, text) => host.send(id, text, { room: true }),
    newThread: (projectId, text, title, attach) => starter.jobThread(projectId, text, title, attach),
    start: (spec) => starter.startDuck(spec),
    newBranch: (projectId, text) => starter.newBranch(projectId, text),
    checkBranch: (projectId, branch) => starter.checkBranch(projectId, branch),
    deciderModel: "haiku",
    contextPercent: (s) => host.contextOf(s)?.percent ?? null,
  });
  jobs.attach(host);
  workspaces.recover();
  for (const project of store.listProjects()) workspaces.reconcileGone(project.id);
  host.start();
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
  const port = Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT;
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
