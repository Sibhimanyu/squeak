import path from "node:path";

import { defaultHookInstallPaths } from "../fleet/hook-install.js";
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
import { AgentTools } from "./agent-tools.js";
import { runCompaction } from "./compact.js";
import { WorkspaceSources } from "./workspace-sources.js";

/** `squeak host`: Squeak's own session host. `native.db` (not `squeak.db`, which the daemon's bridge already owns). */
export async function runHost(supportDir: string): Promise<void> {
  // Before anything starts an agent or a script: they inherit this PATH.
  logger.info("squeak host PATH", { from: adoptLoginShellPath() });
  startSystemProxy();
  void new ProjectPrefs(supportDir).migrateIcons().catch(() => undefined);
  const store = new NativeStore(path.join(supportDir, "native.db"));
  // Late-bound: the server (and so the tools' address) exists only after the host.
  let server: NativeServer | null = null;
  // Late-bound like the server: ponds exist only after the host.
  let flotilla: Flotilla | null = null;
  const host = new SessionHost({
    store,
    mcpFor: (id) => server?.mcpEndpoint(id) ?? null,
    ownerName: () => flotilla?.service?.identity.name ?? null,
  });
  const workspaces = new WorkspaceManager({ store });
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
        .then((j) => j.skipped && logger.warn("native.db compaction skipped", { reason: j.skipped }))
        .catch((error) => logger.warn("native.db compaction failed", { error: String(error) }));
    }, 60_000).unref();
  }
  // The Agent SDK is fetched from npm on this Mac, not shipped: start it now so the first chat rarely waits.
  if (process.env.SQUEAK_AGENT_SDK_PREFETCH !== "off" && !agentSdkPresent()) {
    setTimeout(() => void prefetchAgentSdk(), 5_000).unref();
  }
  const port = Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT;
  // Ponds: on for everyone (local ponds need no cloud); SQUEAK_FLOTILLA=off constructs nothing from src/flotilla.
  let shared: { sources: WorkspaceSources; tools: AgentTools } | null = null;
  if (flotillaEnabled()) {
    shared = {
      sources: new WorkspaceSources({ store, workspaces }),
      tools: new AgentTools({
        store,
        workspaces,
        send: (id, text) => host.send(id, text),
        create: (spec) => host.create(spec),
        post: (id, kind, payload) => host.post(id, kind, payload),
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
      }),
    };
    flotilla = createFlotilla({ host, store, workspaces, ...shared, supportDir });
  }
  server = new NativeServer({
    host,
    store,
    workspaces,
    ...(flotilla && shared ? { flotilla, ...shared } : {}),
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
