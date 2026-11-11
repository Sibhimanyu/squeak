import path from "node:path";

import { defaultHookInstallPaths } from "../fleet/hook-install.js";
import { logger } from "../utils/logger.js";
import { SessionHost } from "./host.js";
import { adoptLoginShellPath } from "./shell-env.js";
import { DEFAULT_HOST_PORT, NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { createFlotilla, flotillaEnabled, type Flotilla } from "../flotilla/index.js";
import { AgentTools } from "./agent-tools.js";
import { WorkspaceSources } from "./workspace-sources.js";

/** `squeak host`: Squeak's own session host. `native.db` (not `squeak.db`, which the daemon's bridge already owns). */
export async function runHost(supportDir: string): Promise<void> {
  // Before anything starts an agent or a script: they inherit this PATH.
  logger.info("squeak host PATH", { from: adoptLoginShellPath() });
  const store = new NativeStore(path.join(supportDir, "native.db"));
  // Late-bound: the server (and so the tools' address) exists only after the host.
  let server: NativeServer | null = null;
  const host = new SessionHost({ store, mcpFor: (id) => server?.mcpEndpoint(id) ?? null });
  const workspaces = new WorkspaceManager({ store });
  workspaces.recover();
  host.start();
  const port = Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT;
  // Ponds: on for everyone (local ponds need no cloud); SQUEAK_FLOTILLA=off constructs nothing from src/flotilla.
  let flotilla: Flotilla | null = null;
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
